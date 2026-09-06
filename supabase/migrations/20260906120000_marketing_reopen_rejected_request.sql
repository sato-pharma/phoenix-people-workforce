-- ─────────────────────────────────────────────────────────────────────────────
-- phx_reopen_rejected_marketing_request — put a refused request back on the
-- desk of the approver who refused it.
--
-- WHY THIS EXISTS
--
-- `rejected` was terminal with no way back. `resubmitReturnedMarketingRequest` guards on
-- `status <> 'returned'`, so a reject could not be walked back the way a return can, and there was
-- no admin control anywhere. On 2026-09-06 the owner asked for two requests refused by the CEO
-- three days earlier — MKT-REQ-20260831-2E355071 and MKT-REQ-20260831-42B1E366 — to go back to him
-- for a second look. The only way to do it was a hand-written SQL block against production. This
-- function is that block, made repeatable, atomic and reviewable.
--
-- WHY AN RPC AND NOT THREE CLIENT CALLS
--
-- Same reason phx_decide_marketing_request_step is one: a half-applied reopen leaves a request in
-- `pending_approval` with NO rung in `current`, which is precisely the corrupt shape the SLA scan
-- calls out ("a pending_approval request with no current step is actively misleading"). A Supabase
-- client request that times out at 15s still commits, so three sequential writes can produce that
-- state with no error and no audit row. One transaction cannot.
--
-- ── THE ONE SUBTLE PART: WHICH `skipped` RUNGS TO RESTORE ────────────────────
--
-- `skipped` means THREE different things on this table and only one of them may be undone here:
--
--   1. a CC row              — `is_cc = true`, never a gate, must stay skipped;
--   2. a self-approval rung  — the assignee raised the request, skipped at SUBMIT time so the
--                              chain cannot strand (phx_decide_marketing_request_step refuses a
--                              self-decision). Restoring one to `pending` would deadlock the
--                              request forever: it would become the current rung and its only
--                              possible holder is the one person the RPC will not let decide it;
--   3. a rung this refusal closed out — the only kind that should come back.
--
-- Cases 2 and 3 are told apart by `decision_note`. A self-approval skip carries the sentence
-- "Skipped automatically: the assigned approver raised this request…" written at submit; a reject
-- terminalisation writes only `status` and `updated_at`, so its note is NULL. That is why the
-- restore below filters on `decision_note is null` and not merely on `sequence`.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.phx_reopen_rejected_marketing_request(
  p_request_id  uuid,
  p_reopened_by text,
  p_reason      text,
  p_reopened_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request  marketing_requests%rowtype;
  v_step     marketing_request_approval_steps%rowtype;
  v_restored integer := 0;
  v_reason   text;
begin
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    -- The reason is the only record of why a recorded refusal was undone. Refused here as well as
    -- in the UI so the rule survives a caller that forgets it.
    raise exception 'marketing_reopen_reason_required: a reason is required to reopen a request'
      using errcode = 'check_violation';
  end if;

  -- Serialise against a concurrent decision on the same request.
  select * into v_request from marketing_requests where id = p_request_id for update;
  if not found then
    raise exception 'marketing_request_not_found: %', p_request_id
      using errcode = 'no_data_found';
  end if;

  -- Optimistic lock. A request someone already reopened, or that never was rejected, is refused
  -- rather than quietly re-reopened — the caller maps this to a 409.
  if v_request.status <> 'rejected' then
    raise exception 'marketing_request_not_rejected: % is %', p_request_id, v_request.status
      using errcode = 'check_violation';
  end if;

  -- The rung that ended the chain. Ordered descending so a request refused, reopened and refused
  -- again at a LATER rung comes back to the latest refusal, never the first one.
  select * into v_step
  from marketing_request_approval_steps
  where request_id = p_request_id
    and status     = 'rejected'
    and is_cc      = false
  order by sequence desc
  limit 1;

  if not found then
    raise exception 'marketing_reopen_no_rejected_step: % carries no rejected rung', p_request_id
      using errcode = 'check_violation';
  end if;

  -- 1. Put the refusing rung back on its approver's desk, decision cleared. The refusal text is
  --    NOT lost: marketing_request_events holds it as an append-only `step_decided` row.
  update marketing_request_approval_steps set
    status            = 'current',
    decision_at       = null,
    decision_by_hr_id = null,
    decision_note     = null,
    updated_at        = p_reopened_at
  where id = v_step.id
  returning * into v_step;

  -- 2. Restore ONLY the rungs the refusal closed out — see the header note above.
  update marketing_request_approval_steps set
    status     = 'pending',
    updated_at = p_reopened_at
  where request_id    = p_request_id
    and status        = 'skipped'
    and is_cc         = false
    and decision_note is null
    and sequence      > v_step.sequence;
  get diagnostics v_restored = row_count;

  -- 3. Back in flight.
  update marketing_requests set
    status           = 'pending_approval',
    rejected_at      = null,
    updated_at       = p_reopened_at,
    updated_by_hr_id = p_reopened_by
  where id = p_request_id
  returning * into v_request;

  -- 4. The why, against the rung it concerns.
  --
  -- Deliberately `step_commented` and not a second `request_status_changed`: the status flip is
  -- already recorded by phx_capture_marketing_request_event on the update above, and two rows for
  -- one transition reads as a double reopen. What the trigger cannot capture is the reason, which
  -- belongs beside the rung being reopened.
  insert into public.marketing_request_events
    (request_id, request_code, kind, actor_hr_id, occurred_at,
     from_status, to_status, step_sequence, step_name, note, payload)
  values
    (p_request_id, v_request.request_code, 'step_commented', p_reopened_by, p_reopened_at,
     'rejected', 'current', v_step.sequence, v_step.step_name, v_reason,
     jsonb_build_object('action', 'reopen', 'restored_rungs', v_restored));

  return jsonb_build_object(
    'request',  to_jsonb(v_request),
    'step',     to_jsonb(v_step),
    'restored', v_restored
  );
end;
$function$;

revoke execute on function public.phx_reopen_rejected_marketing_request(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.phx_reopen_rejected_marketing_request(uuid, text, text, timestamptz)
  to service_role;

comment on function public.phx_reopen_rejected_marketing_request(uuid, text, text, timestamptz) is
  'Reopens a rejected marketing request onto the rung that refused it, restoring only the rungs that refusal closed out (decision_note is null), atomically. Super Admin only — the role gate lives in the service layer.';
