-- marketing_decide_requires_pending_request
--
-- WHAT THIS CHANGES:
--   1. Re-creates public.phx_decide_marketing_request_step with its body copied VERBATIM from its
--      latest definition (20260829180000_marketing_finance_requirement_on_approval.sql) — same
--      signature, SECURITY DEFINER, search_path and grants — plus only these lines:
--        * at the start it locks the request row (SELECT ... FOR UPDATE) and raises
--          `marketing_request_not_pending` unless the request is still 'pending_approval';
--        * both UPDATEs of marketing_requests (reject/return, and final approval) carry
--          `AND status = 'pending_approval'` and raise the same exception if no row was updated.
--   2. Adds public.phx_cancel_marketing_request: the Case File cancel, in one transaction. It locks
--      the request, compare-and-sets its status against the status the caller read, flips it to
--      'cancelled', and closes every approval rung still 'current' or 'pending' (non-CC) as
--      'skipped' — the step table's existing "closed out without a decision" status, the one a
--      reject already uses for the rungs below it (20260813190000_marketing_reject_terminalises_chain).
--
-- WHY (enterprise audit F-MKT-006): the decide function compare-and-set only the STEP row. Its
-- writes to marketing_requests had no status condition and the request was never locked, while
-- cancel (src/lib/marketing-requests/cancel.ts) flipped the request to 'cancelled' and left its
-- 'current' rung open. An approver acting on that open rung — or one whose click raced the cancel —
-- wrote the cancelled request back to approved/active/rejected/returned, and a final approval also
-- created a finance obligation for it. Now the decision refuses unless the request is still
-- awaiting approval, under the request lock, and a cancel leaves no rung open to act on.
--
-- Lock order: both functions lock marketing_requests before touching marketing_request_approval_steps.
-- (phx_decide_marketing_request_step previously locked the step row first, by its UPDATE; it now
-- takes the request lock before that — the order cancel, phx_reopen_rejected_marketing_request and
-- phx_resubmit_marketing_request already use — so none of them can deadlock against another.)
--
-- ROLLBACK: re-run the CREATE OR REPLACE of phx_decide_marketing_request_step from
-- 20260829180000_marketing_finance_requirement_on_approval.sql (lines 59-264), and
--   drop function public.phx_cancel_marketing_request(uuid, text, text, timestamptz);
-- after reverting cancel.ts to its own compare-and-set update in the same pull request.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one function replaced, one added, no existing row changes.

begin;

CREATE OR REPLACE FUNCTION public.phx_decide_marketing_request_step(
  p_step_id       uuid,
  p_request_id    uuid,
  p_decision      text,
  p_decided_by    text,
  p_decision_note text,
  p_decided_at    timestamptz
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_step_status text;
  v_step                 marketing_request_approval_steps%ROWTYPE;
  v_request              marketing_requests%ROWTYPE;
  v_next_step            marketing_request_approval_steps%ROWTYPE;
  v_has_next             boolean := false;
  v_terminal_status      text;
  v_is_execution         boolean := false;
  v_requester_hr_id      text;
  v_terminalised         integer := 0;
  v_invoice_days         integer;
  v_request_status       text;
BEGIN
  -- Lock the request row FIRST, and refuse unless it is still awaiting approval. Without this a
  -- decision could land on a request that was cancelled (or otherwise moved on) a moment ago and
  -- write it back to approved/rejected/returned. The caller maps this to the same 409 its own
  -- pre-check throws.
  SELECT r.status INTO v_request_status
  FROM marketing_requests r
  WHERE r.id = p_request_id
  FOR UPDATE;

  IF v_request_status IS DISTINCT FROM 'pending_approval' THEN
    RAISE EXCEPTION 'marketing_request_not_pending: request % is %, not pending_approval', p_request_id, COALESCE(v_request_status, 'missing');
  END IF;

  -- Map decision -> step terminal status
  v_terminal_step_status := CASE p_decision
    WHEN 'approve' THEN 'approved'
    WHEN 'reject'  THEN 'rejected'
    WHEN 'return'  THEN 'returned'
  END;

  IF v_terminal_step_status IS NULL THEN
    RAISE EXCEPTION 'Invalid marketing request decision: %', p_decision;
  END IF;

  -- 0. Nobody decides their own request. Checked before anything is written.
  SELECT r.requester_hr_id INTO v_requester_hr_id
  FROM marketing_requests r
  WHERE r.id = p_request_id;

  IF v_requester_hr_id IS NOT NULL
     AND lower(btrim(v_requester_hr_id)) = lower(btrim(COALESCE(p_decided_by, ''))) THEN
    -- Caller maps this to a 403.
    RAISE EXCEPTION 'marketing_self_approval_refused: % raised this request and may not decide it', p_decided_by
      USING errcode = 'check_violation';
  END IF;

  -- 1. Stamp the current step with optimistic-lock (status must still be 'current').
  UPDATE marketing_request_approval_steps SET
    decision_at       = p_decided_at,
    decision_by_hr_id = p_decided_by,
    decision_note     = NULLIF(btrim(COALESCE(p_decision_note, '')), ''),
    status            = v_terminal_step_status,
    updated_at        = p_decided_at
  WHERE id     = p_step_id
    AND status = 'current'
  RETURNING * INTO v_step;

  IF NOT FOUND THEN
    -- Signals a concurrent decision; caller maps this to a 409 conflict.
    RAISE EXCEPTION 'marketing_step_already_decided: step % was no longer current', p_step_id;
  END IF;

  -- Branch A: reject or return
  IF p_decision IN ('reject', 'return') THEN

    -- A REJECT ends the chain. Every rung still waiting is closed out as `skipped`, so nothing
    -- downstream keeps reporting it as outstanding work. Only `pending` non-CC rungs are touched:
    -- a rung that was already approved/rejected/returned keeps its decision untouched, and CC rows
    -- are already `skipped`.
    --
    -- A RETURN is left alone on purpose - the request goes back to the requester and the later
    -- rungs are genuinely still ahead of it; resubmission depends on them staying `pending`.
    IF p_decision = 'reject' THEN
      UPDATE marketing_request_approval_steps SET
        status     = 'skipped',
        updated_at = p_decided_at
      WHERE request_id = p_request_id
        AND status     = 'pending'
        AND is_cc      = false;
      GET DIAGNOSTICS v_terminalised = ROW_COUNT;
    END IF;

    UPDATE marketing_requests SET
      -- `returned_at` and `returned_step_sequence` are NO LONGER cleared by a reject. A request
      -- that was returned, resubmitted, then refused keeps the evidence that the return happened.
      -- Only a `return` sets them; a `reject` leaves whatever is already there.
      rejected_at            = CASE WHEN p_decision = 'reject' THEN p_decided_at ELSE rejected_at END,
      returned_at            = CASE WHEN p_decision = 'return' THEN p_decided_at ELSE returned_at END,
      returned_step_sequence = CASE WHEN p_decision = 'return' THEN v_step.sequence ELSE returned_step_sequence END,
      status                 = CASE WHEN p_decision = 'reject' THEN 'rejected'::text ELSE 'returned'::text END,
      updated_at             = p_decided_at,
      updated_by_hr_id       = p_decided_by
    WHERE id = p_request_id
      AND status = 'pending_approval'
    RETURNING * INTO v_request;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'marketing_request_not_pending: request % left pending_approval before the decision was written', p_request_id;
    END IF;

    RETURN jsonb_build_object(
      'branch',        p_decision,
      'step',          to_jsonb(v_step),
      'request',       to_jsonb(v_request),
      'nextStep',      NULL,
      'isExecution',   false,
      -- How many rungs were closed out, so the caller can log it rather than infer it.
      'terminalised',  v_terminalised
    );
  END IF;

  -- Branch B or C: approve
  UPDATE marketing_request_approval_steps SET
    status     = 'current',
    updated_at = p_decided_at
  WHERE id = (
    SELECT id
    FROM   marketing_request_approval_steps
    WHERE  request_id = p_request_id
      AND  status     = 'pending'
      AND  is_cc      = false
      AND  sequence   > v_step.sequence
    ORDER  BY sequence
    LIMIT  1
  )
  AND status = 'pending'
  RETURNING * INTO v_next_step;

  v_has_next := FOUND;

  -- Branch B: next approver exists
  IF v_has_next THEN
    SELECT * INTO v_request FROM marketing_requests WHERE id = p_request_id;

    RETURN jsonb_build_object(
      'branch',      'approve_next',
      'step',        to_jsonb(v_step),
      'request',     to_jsonb(v_request),
      'nextStep',    to_jsonb(v_next_step),
      'isExecution', false
    );
  END IF;

  -- Branch C: final approval
  v_terminal_status := COALESCE(v_step.terminal_status, 'approved');
  v_is_execution    := (v_terminal_status = 'active');

  UPDATE marketing_requests SET
    approved_at      = p_decided_at,
    executed_at      = CASE WHEN v_is_execution THEN p_decided_at ELSE executed_at END,
    status           = v_terminal_status,
    updated_at       = p_decided_at,
    updated_by_hr_id = p_decided_by
  WHERE id = p_request_id
    AND status = 'pending_approval'
  RETURNING * INTO v_request;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'marketing_request_not_pending: request % left pending_approval before the decision was written', p_request_id;
  END IF;

  IF v_is_execution THEN
    UPDATE marketing_request_approval_steps SET
      executed_at = p_decided_at,
      updated_at  = p_decided_at
    WHERE id = p_step_id
    RETURNING * INTO v_step;
  END IF;

  -- Record the invoice obligation this approval creates.
  --
  -- Inside the same transaction as the approval on purpose: this function exists precisely so a
  -- decision cannot half-apply, and an approval that commits without its obligation is exactly the
  -- half-state it was written to prevent.
  --
  -- A missing settings row falls back to 7 rather than raising. The deadline is a reminder; a
  -- deleted setting must not be able to make an approval fail.
  SELECT (setting_value ->> 'days')::integer
    INTO v_invoice_days
  FROM marketing_control_settings
  WHERE setting_key = 'finance_invoice_deadline_days';

  INSERT INTO marketing_request_finance_requirements (
    request_id,
    invoice_required,
    invoice_status,
    invoice_deadline_date,
    created_at,
    updated_at
  )
  VALUES (
    p_request_id,
    true,
    'pending',
    ((p_decided_at AT TIME ZONE 'Africa/Cairo')::date + COALESCE(v_invoice_days, 7)),
    p_decided_at,
    p_decided_at
  )
  ON CONFLICT (request_id) DO NOTHING;

  RETURN jsonb_build_object(
    'branch',      'approve_final',
    'step',        to_jsonb(v_step),
    'request',     to_jsonb(v_request),
    'nextStep',    NULL,
    'isExecution', v_is_execution
  );
END;
$function$;

revoke execute on function public.phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.phx_decide_marketing_request_step(uuid, uuid, text, text, text, timestamptz)
  to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cancel a marketing request, and close the rungs still waiting on it, in one transaction.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.phx_cancel_marketing_request(
  p_request_id      uuid,
  p_expected_status text,
  p_actor_hr_id     text,
  p_cancelled_at    timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_status        text;
  v_closed_steps  integer := 0;
begin
  -- The request first, the same lock phx_decide_marketing_request_step takes first.
  select r.status into v_status
    from marketing_requests r
   where r.id = p_request_id
   for update;
  if not found then
    raise exception 'marketing_request_not_found: request % does not exist', p_request_id;
  end if;

  -- Compare-and-set against the status the caller read and judged cancellable.
  if v_status is distinct from p_expected_status then
    raise exception 'marketing_cancel_conflict: request % is %, not %', p_request_id, v_status, p_expected_status;
  end if;

  -- Stamping updated_by_hr_id / updated_at is what lets the AFTER UPDATE capture trigger record WHO
  -- cancelled it and from which state — exactly as the TypeScript update did.
  update marketing_requests
     set status           = 'cancelled',
         updated_at       = p_cancelled_at,
         updated_by_hr_id = p_actor_hr_id
   where id = p_request_id;

  -- Close every rung still open, exactly as a reject closes the rungs below it: 'skipped', no
  -- decision recorded (the Case File reads this as "Closed out without a decision"). Rungs already
  -- decided keep their decision; CC rows are already 'skipped'.
  update marketing_request_approval_steps
     set status     = 'skipped',
         updated_at = p_cancelled_at
   where request_id = p_request_id
     and status in ('current', 'pending')
     and is_cc = false;
  get diagnostics v_closed_steps = row_count;

  return jsonb_build_object(
    'requestId',      p_request_id,
    'previousStatus', v_status,
    'status',         'cancelled',
    'closedSteps',    v_closed_steps
  );
end;
$function$;

comment on function public.phx_cancel_marketing_request(uuid, text, text, timestamptz) is
  'Cancels a marketing request (compare-and-set on the status the caller read) and closes its open approval rungs as skipped, under the request row lock.';

revoke execute on function public.phx_cancel_marketing_request(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.phx_cancel_marketing_request(uuid, text, text, timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
