-- dispute_decision_claim_and_undo
--
-- WHAT THIS CHANGES:
--   * public.dispute_case_decision_claims — one row while a dispute is being decided: who holds it,
--     a claim token, when the claim lapses, and the BEFORE-STATE of everything the decision may touch.
--   * public.phx_claim_dispute_case_decision(kind, ref, claimed_by) — takes the claim in ONE
--     statement before the decision writes anything. A second decide of the same case meets the
--     live claim and is refused. A claim left by a request that died lapses after 5 minutes
--     (src/lib/dispute-center/decision-claim.ts carries the same figure; a test holds the two together).
--   * public.phx_capture_deduction_dispute_state(candidate) — the before-state of a deduction dispute:
--     the candidate's lock, its decision row, every publication line of it, the month's publications
--     and the case's refunds, read in one statement.
--   * public.phx_restore_deduction_dispute_state(snapshot, actor) — puts all of that back in ONE
--     transaction, in reverse order, when a decision fails after its first write. Rows the failed
--     attempt created (a pushed line, a recommended refund) are removed; rows it changed are set back.
--     Every decision write it makes still goes through deductions_decisions, so the history trigger
--     phx_deductions_decisions_history keeps recording it; nothing here disables a trigger. The undo
--     itself is written to the append-only deductions_audit as 'dispute_decision_undone'.
--   * dispute_case_events may now hold 'decision_interrupted' — the visible "needs attention" marker
--     for a decision that stopped half-way and could not be put back.
--
-- WHY (enterprise audit 2026-11-13, finding F-PAY-005):
--   A dispute decision was five or six separate writes — withdraw the line, record the decision,
--   push the smaller figure, recommend or cancel a refund — with the 'decided' event LAST and the
--   "already decided" gate a plain read before all of them. Two decides at once both passed the gate,
--   and a failure after the money moved but before the event left the case reading open while
--   payroll already charged the new figure.
--
-- WHAT CANNOT BE PUT BACK, EXACTLY:
--   * deductions_decisions.updated_at — its touch trigger stamps now() on the restoring write (the
--     row is only rewritten when a deciding field actually differs from the before-state).
--   * a publication the failed attempt's push created for a month that had none — deductions_audit
--     (append-only) references it, so it stays, with zero lines and zero totals; the next push reuses it.
--   * the audit trails (deductions_audit, audit logs) — append-only by design; they record the attempt
--     and its undo.
--
-- ROLLBACK:
--   drop function if exists public.phx_restore_deduction_dispute_state(jsonb, text);
--   drop function if exists public.phx_capture_deduction_dispute_state(uuid);
--   drop function if exists public.phx_claim_dispute_case_decision(text, text, text);
--   drop table if exists public.dispute_case_decision_claims;  -- SAFE: holds only in-flight claims
--   and re-add dispute_case_events_type_check without 'decision_interrupted' (only once no row uses it).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive: one new table, three functions, one widened check constraint.

begin;

-- ---------------------------------------------------------------------------------- the claim

create table if not exists public.dispute_case_decision_claims (
  case_kind    text        not null,
  case_ref     text        not null,
  claim_token  uuid        not null,
  claimed_by   text,
  claimed_at   timestamptz not null default now(),
  lapse_at     timestamptz not null,
  snapshot     jsonb,
  primary key (case_kind, case_ref),
  constraint dispute_case_decision_claims_kind_check
    check (case_kind = any (array['calendar'::text, 'deduction'::text, 'digest'::text]))
);

comment on table public.dispute_case_decision_claims is
  'One row while a dispute is being decided (F-PAY-005). Taken before the first write, released after '
  'the decided event. snapshot is the before-state the decision restores if it fails half-way. A row '
  'past lapse_at was left by a request that died and may be taken over.';

alter table public.dispute_case_decision_claims enable row level security;
revoke all on table public.dispute_case_decision_claims from public, anon, authenticated;
grant all on table public.dispute_case_decision_claims to service_role;

create or replace function public.phx_claim_dispute_case_decision(
  p_case_kind  text,
  p_case_ref   text,
  p_claimed_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
  v_prev  public.dispute_case_decision_claims%rowtype;
begin
  -- The common case, in one statement: nobody holds the case.
  insert into public.dispute_case_decision_claims (case_kind, case_ref, claim_token, claimed_by, claimed_at, lapse_at)
  values (p_case_kind, p_case_ref, v_token, p_claimed_by, now(), now() + interval '5 minutes')
  on conflict (case_kind, case_ref) do nothing;
  if found then
    return jsonb_build_object('token', v_token, 'interrupted', null);
  end if;

  -- Somebody holds it, or held it and died. The row lock serializes two takeovers of one lapsed claim.
  select * into v_prev
  from public.dispute_case_decision_claims
  where case_kind = p_case_kind and case_ref = p_case_ref
  for update;

  if v_prev.case_ref is not null and v_prev.lapse_at > now() then
    return jsonb_build_object('token', null, 'claimedAt', v_prev.claimed_at);
  end if;

  update public.dispute_case_decision_claims
     set claim_token = v_token,
         claimed_by  = p_claimed_by,
         claimed_at  = now(),
         lapse_at    = now() + interval '5 minutes',
         snapshot    = null
   where case_kind = p_case_kind and case_ref = p_case_ref;
  if not found then
    -- Released between the insert and the read: take it fresh.
    insert into public.dispute_case_decision_claims (case_kind, case_ref, claim_token, claimed_by, claimed_at, lapse_at)
    values (p_case_kind, p_case_ref, v_token, p_claimed_by, now(), now() + interval '5 minutes')
    on conflict (case_kind, case_ref) do nothing;
    if not found then
      return jsonb_build_object('token', null, 'claimedAt', now());
    end if;
    return jsonb_build_object('token', v_token, 'interrupted', null);
  end if;

  -- A lapsed claim that still carries a before-state was a decision that died after capturing it,
  -- maybe after moving money. Say so; the caller decides what the case shows.
  return jsonb_build_object(
    'token', v_token,
    'interrupted', case when v_prev.snapshot is null then null else jsonb_build_object(
      'claimedAt', v_prev.claimed_at,
      'claimedBy', v_prev.claimed_by,
      'snapshot', v_prev.snapshot
    ) end
  );
end;
$$;

comment on function public.phx_claim_dispute_case_decision(text, text, text) is
  'Claims a dispute for one decision (F-PAY-005). Returns {token} or {token: null} when a live claim '
  'holds it. interrupted carries the before-state of a lapsed claim that never released.';

revoke execute on function public.phx_claim_dispute_case_decision(text, text, text) from public, anon, authenticated;
grant execute on function public.phx_claim_dispute_case_decision(text, text, text) to service_role;

-- ------------------------------------------------------------------------ the before-state

create or replace function public.phx_capture_deduction_dispute_state(p_candidate_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'candidateId', c.id,
    'monthKey', c.month_key,
    'lockedAt', c.locked_at,
    'decision', (select to_jsonb(d) from public.deductions_decisions d where d.candidate_id = c.id),
    'lines', coalesce(
      (select jsonb_agg(to_jsonb(l) order by l.id) from public.deductions_publication_lines l where l.candidate_id = c.id),
      '[]'::jsonb),
    'publicationIds', coalesce(
      (select jsonb_agg(p.id order by p.id) from public.deductions_publications p where p.month_key = c.month_key),
      '[]'::jsonb),
    'refunds', coalesce(
      (select jsonb_agg(to_jsonb(r) order by r.id) from public.dispute_refunds r
        where r.case_kind = 'deduction' and r.case_ref = c.id::text),
      '[]'::jsonb)
  )
  from public.deductions_candidates c
  where c.id = p_candidate_id;
$$;

comment on function public.phx_capture_deduction_dispute_state(uuid) is
  'The before-state of a deduction dispute decision (F-PAY-005): lock, decision row, publication lines, '
  'the month''s publications and the case''s refunds. Read by phx_restore_deduction_dispute_state.';

revoke execute on function public.phx_capture_deduction_dispute_state(uuid) from public, anon, authenticated;
grant execute on function public.phx_capture_deduction_dispute_state(uuid) to service_role;

-- --------------------------------------------------------------------------------- the undo

create or replace function public.phx_restore_deduction_dispute_state(p_snapshot jsonb, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_candidate    uuid := nullif(p_snapshot->>'candidateId', '')::uuid;
  v_ref          text := p_snapshot->>'candidateId';
  v_lines        jsonb := coalesce(p_snapshot->'lines', '[]'::jsonb);
  v_refunds      jsonb := coalesce(p_snapshot->'refunds', '[]'::jsonb);
  v_pub_ids      uuid[];
  v_known_pubs   uuid[];
  v_left_pubs    uuid[];
  v_month_key    text;
  v_locked_now   timestamptz;
  v_item         jsonb;
  v_now          public.deductions_decisions%rowtype;
  v_want         public.deductions_decisions%rowtype;
  v_decision_due boolean := false;
  v_has_decision boolean := coalesce(jsonb_typeof(p_snapshot->'decision') = 'object', false);
begin
  if v_candidate is null then
    raise exception 'phx_restore_deduction_dispute_state: the snapshot names no candidate';
  end if;

  -- 1. Hold the candidate for the whole undo.
  select locked_at, month_key into v_locked_now, v_month_key
  from public.deductions_candidates
  where id = v_candidate
  for update;
  if not found then
    raise exception 'phx_restore_deduction_dispute_state: candidate % no longer exists', v_candidate;
  end if;

  select coalesce(array_agg((value #>> '{}')::uuid), '{}') into v_known_pubs
  from jsonb_array_elements(coalesce(p_snapshot->'publicationIds', '[]'::jsonb));

  -- Every publication whose totals this undo may move: those holding the candidate's lines now, those
  -- that held them before, and any the failed attempt created for the month.
  select coalesce(array_agg(distinct x), '{}') into v_pub_ids
  from (
    select l.publication_id as x from public.deductions_publication_lines l where l.candidate_id = v_candidate
    union
    select nullif(s->>'publication_id', '')::uuid from jsonb_array_elements(v_lines) s
    union
    select p.id from public.deductions_publications p
     where p.month_key = v_month_key and not (p.id = any (v_known_pubs))
  ) q
  where x is not null;

  -- 2. Lines the failed attempt pushed are removed; lines it withdrew or superseded are set back,
  --    withdrawn ones first so the one-active-line index never sees two.
  delete from public.deductions_publication_lines l
   where l.candidate_id = v_candidate
     and not exists (select 1 from jsonb_array_elements(v_lines) s where nullif(s->>'id', '')::uuid = l.id);

  for v_item in
    select value from jsonb_array_elements(v_lines) order by (value->>'line_status' = 'active')
  loop
    update public.deductions_publication_lines l
       set line_status           = r.line_status,
           superseded_by_line_id = r.superseded_by_line_id,
           notified_at           = r.notified_at,
           notification_status   = r.notification_status
      from jsonb_populate_record(null::public.deductions_publication_lines, v_item) r
     where l.id = r.id
       and (l.line_status, l.superseded_by_line_id, l.notified_at, l.notification_status)
           is distinct from (r.line_status, r.superseded_by_line_id, r.notified_at, r.notification_status);
  end loop;

  -- 3. The decision. Written back through the table, so phx_deductions_decisions_history records it,
  --    and only when a deciding field differs. A decision on a LOCKED candidate is refused by
  --    phx_deductions_decisions_refuse_locked, so the lock comes off first and goes back in step 5.
  select * into v_now from public.deductions_decisions where candidate_id = v_candidate for update;
  if v_has_decision then
    v_want := jsonb_populate_record(null::public.deductions_decisions, p_snapshot->'decision');
    v_decision_due := v_now.id is null
      or (v_now.decision_status, v_now.decision_reason, v_now.hr_note, v_now.applied_value, v_now.applied_amount,
          v_now.applied_dates, v_now.decided_by, v_now.decided_at, v_now.actor_role_at_decision)
         is distinct from
         (v_want.decision_status, v_want.decision_reason, v_want.hr_note, v_want.applied_value, v_want.applied_amount,
          v_want.applied_dates, v_want.decided_by, v_want.decided_at, v_want.actor_role_at_decision);
  else
    v_decision_due := v_now.id is not null;
  end if;

  if v_decision_due then
    if v_locked_now is not null then
      update public.deductions_candidates set locked_at = null where id = v_candidate;
    end if;
    if not v_has_decision then
      delete from public.deductions_decisions where candidate_id = v_candidate;
    elsif v_now.id is null then
      insert into public.deductions_decisions select v_want.*;
    else
      update public.deductions_decisions
         set decision_status        = v_want.decision_status,
             decision_reason        = v_want.decision_reason,
             hr_note                = v_want.hr_note,
             applied_value          = v_want.applied_value,
             applied_amount         = v_want.applied_amount,
             applied_dates          = v_want.applied_dates,
             decided_by             = v_want.decided_by,
             decided_at             = v_want.decided_at,
             actor_role_at_decision = v_want.actor_role_at_decision
       where candidate_id = v_candidate;
    end if;
  end if;

  -- 4. The case's refunds: one the failed attempt recommended is removed; one it cancelled is live
  --    again. Cancelled first, so the one-live-refund-per-case index never sees two.
  delete from public.dispute_refunds r
   where r.case_kind = 'deduction' and r.case_ref = v_ref
     and not exists (select 1 from jsonb_array_elements(v_refunds) s where nullif(s->>'id', '')::uuid = r.id);

  for v_item in
    select value from jsonb_array_elements(v_refunds) order by (value->>'status' = 'recommended')
  loop
    update public.dispute_refunds d
       set status             = r.status,
           cancelled_at       = r.cancelled_at,
           cancelled_by_hr_id = r.cancelled_by_hr_id,
           cancel_reason      = r.cancel_reason
      from jsonb_populate_record(null::public.dispute_refunds, v_item) r
     where d.id = r.id
       and (d.status, d.cancelled_at, d.cancelled_by_hr_id, d.cancel_reason)
           is distinct from (r.status, r.cancelled_at, r.cancelled_by_hr_id, r.cancel_reason);
  end loop;

  -- 5. The lock, exactly as it was.
  update public.deductions_candidates
     set locked_at = nullif(p_snapshot->>'lockedAt', '')::timestamptz
   where id = v_candidate
     and locked_at is distinct from nullif(p_snapshot->>'lockedAt', '')::timestamptz;

  -- 6. The publications' counts and totals follow their active lines, as push and withdraw keep them.
  update public.deductions_publications p
     set candidate_count = t.candidate_count,
         employee_count  = t.employee_count,
         category_totals = t.category_totals
    from (
      select pub.id,
             (select count(*) from public.deductions_publication_lines a
               where a.publication_id = pub.id and a.line_status = 'active')::integer as candidate_count,
             (select count(distinct a.employee_hr_id_compact) from public.deductions_publication_lines a
               where a.publication_id = pub.id and a.line_status = 'active')::integer as employee_count,
             coalesce((select jsonb_object_agg(c.category, c.amt) from (
                select a.category, round(sum(a.applied_amount), 2) as amt
                from public.deductions_publication_lines a
                where a.publication_id = pub.id and a.line_status = 'active'
                group by a.category) c), '{}'::jsonb) as category_totals
      from public.deductions_publications pub
      where pub.id = any (v_pub_ids)
    ) t
   where p.id = t.id
     and (p.candidate_count, p.employee_count, p.category_totals)
         is distinct from (t.candidate_count, t.employee_count, t.category_totals);

  select coalesce(array_agg(p.id), '{}') into v_left_pubs
  from public.deductions_publications p
  where p.month_key = v_month_key and not (p.id = any (v_known_pubs));

  insert into public.deductions_audit (candidate_id, actor_hr_id, action, detail)
  values (
    v_candidate, p_actor, 'dispute_decision_undone',
    jsonb_build_object('restored_to', p_snapshot, 'publications_left_empty', to_jsonb(v_left_pubs))
  );

  return jsonb_build_object('restored', true, 'publicationsLeftEmpty', to_jsonb(v_left_pubs));
end;
$$;

comment on function public.phx_restore_deduction_dispute_state(jsonb, text) is
  'Undo of a deduction dispute decision that failed after its first write (F-PAY-005): puts back the '
  'lines, the decision, the refunds and the lock captured by phx_capture_deduction_dispute_state, in '
  'one transaction. Writes the decision through the table so its history trigger still fires.';

revoke execute on function public.phx_restore_deduction_dispute_state(jsonb, text) from public, anon, authenticated;
grant execute on function public.phx_restore_deduction_dispute_state(jsonb, text) to service_role;

-- ------------------------------------------------------------- the "needs attention" marker

alter table public.dispute_case_events drop constraint if exists dispute_case_events_type_check;
alter table public.dispute_case_events add constraint dispute_case_events_type_check
  check (event_type = any (array[
    'reopen_requested'::text, 'reopen_declined'::text, 'reopened'::text, 'decided'::text,
    'refund_recommended'::text, 'refund_cancelled'::text, 'decision_interrupted'::text
  ]));

commit;
