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
--   * public.phx_renew_dispute_case_decision(kind, ref, token) — proves the claim is still this
--     decision's and renews it, immediately before the last write. A claim lost to a takeover stops
--     the decision, which then puts back what it changed.
--   * public.phx_restore_deduction_dispute_state(snapshot, left, actor) — puts back, in ONE
--     transaction, what a decision that failed after its first write had changed. It is given the
--     before-state AND the state this attempt left after its last successful write, and puts a row back
--     ONLY while it still equals what this attempt left: the claim stops other dispute decisions, not
--     the Deductions workspace or a month push, so a change somebody else made in between is never
--     reverted. Any such change makes the undo refuse whole, write nothing but an audit row
--     ('dispute_decision_undo_refused'), and name the rows; the case then reads "needs attention".
--     Every UPDATE and DELETE is scoped to this candidate's lines and this case's refunds. Decision
--     writes go through deductions_decisions, so phx_deductions_decisions_history keeps recording an
--     update or an insert; a decision row the undo DELETES (none existed before) is not seen by that
--     trigger, so the undo writes its history row itself ('decision_removed', the trigger's own detail
--     shape). Nothing here disables or changes a trigger. The undo itself is written to the append-only
--     deductions_audit as 'dispute_decision_undone'.
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
--     row is only rewritten when this attempt changed the decision).
--   * a row somebody else changed after this attempt wrote it — never overwritten: the undo refuses and
--     the case reads "needs attention" with those rows named, for a person to settle.
--   * the one window it cannot see: publication lines and refunds carry no revision column, so a
--     change by another writer in the milliseconds between this attempt's write and its re-capture is
--     taken as this attempt's own. The decision is pinned to the updated_at its own write returned,
--     so for the decision that window is closed.
--   * a publication the failed attempt's push created for a month that had none — deductions_audit
--     (append-only) references it, so it stays, with zero lines and zero totals; the next push reuses it.
--   * the audit trails (deductions_audit, audit logs) — append-only by design; they record the attempt
--     and its undo.
--
-- ROLLBACK:
--   drop function if exists public.phx_restore_deduction_dispute_state(jsonb, jsonb, text);
--   drop function if exists public.phx_renew_dispute_case_decision(text, text, uuid);
--   drop function if exists public.phx_capture_deduction_dispute_state(uuid);
--   drop function if exists public.phx_claim_dispute_case_decision(text, text, text);
--   drop table if exists public.dispute_case_decision_claims;  -- SAFE: holds only in-flight claims
--   and re-add dispute_case_events_type_check without 'decision_interrupted' (only once no row uses it).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive: one new table, four functions, one widened check constraint.

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

-- Proves the claim is still this decision's, and renews it, in one statement — called immediately
-- before the decision's last write. A claim taken over after its lapse answers false: the decision
-- stops and puts back what it changed instead of finishing on a case somebody else now holds.
create or replace function public.phx_renew_dispute_case_decision(
  p_case_kind   text,
  p_case_ref    text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $
begin
  update public.dispute_case_decision_claims
     set lapse_at = now() + interval '5 minutes'
   where case_kind = p_case_kind and case_ref = p_case_ref and claim_token = p_claim_token;
  return found;
end;
$;

comment on function public.phx_renew_dispute_case_decision(text, text, uuid) is
  'True and renewed when the claim is still held by this token (F-PAY-005); false when it was lost.';

revoke execute on function public.phx_renew_dispute_case_decision(text, text, uuid) from public, anon, authenticated;
grant execute on function public.phx_renew_dispute_case_decision(text, text, uuid) to service_role;

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

-- p_snapshot is the before-state (captured before the first write); p_left is the state THIS attempt
-- left after its last successful write (re-captured after each one, the decision pinned to the
-- updated_at its own write returned). A row this attempt changed is put back ONLY while it still
-- equals what this attempt left; any other writer's change since — a Deductions workspace save, a
-- month push, a refund screen — makes the whole undo refuse, touching nothing, and the conflicting rows
-- are named. All or nothing, because a half-undo is another half-state, and the one-active-line and
-- one-live-refund indexes would refuse most mixes anyway.
create or replace function public.phx_restore_deduction_dispute_state(p_snapshot jsonb, p_left jsonb, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  deciding constant text[] := array[
    'decision_status', 'decision_reason', 'hr_note',
    'applied_value', 'applied_amount', 'applied_dates', 'decided_by'
  ];
  v_candidate       uuid := nullif(p_snapshot->>'candidateId', '')::uuid;
  v_ref             text := p_snapshot->>'candidateId';
  v_before_lines    jsonb := coalesce(p_snapshot->'lines', '[]'::jsonb);
  v_left_lines      jsonb := coalesce(p_left->'lines', '[]'::jsonb);
  v_before_refunds  jsonb := coalesce(p_snapshot->'refunds', '[]'::jsonb);
  v_left_refunds    jsonb := coalesce(p_left->'refunds', '[]'::jsonb);
  v_before_decision jsonb := case when jsonb_typeof(p_snapshot->'decision') = 'object' then p_snapshot->'decision' end;
  v_left_decision   jsonb := case when jsonb_typeof(p_left->'decision') = 'object' then p_left->'decision' end;
  v_before_lock     timestamptz := nullif(p_snapshot->>'lockedAt', '')::timestamptz;
  v_left_lock       timestamptz := nullif(p_left->>'lockedAt', '')::timestamptz;
  v_lock_touched    boolean;
  v_final_lock      timestamptz;
  v_conflicts       text[] := '{}';
  v_more            text[];
  v_pub_ids         uuid[];
  v_known_pubs      uuid[];
  v_left_pubs       uuid[];
  v_month_key       text;
  v_locked_now      timestamptz;
  v_item            jsonb;
  v_now             public.deductions_decisions%rowtype;
  v_now_json        jsonb;
  v_want            public.deductions_decisions%rowtype;
begin
  if v_candidate is null then
    raise exception 'phx_restore_deduction_dispute_state: the snapshot names no candidate';
  end if;
  if nullif(p_left->>'candidateId', '')::uuid is distinct from v_candidate then
    raise exception 'phx_restore_deduction_dispute_state: the before-state and the left-state name different candidates';
  end if;

  -- 1. Hold the candidate, its lines, its decision and the case's refunds for the whole undo, so
  --    nothing changes between the comparison below and the writes after it.
  select locked_at, month_key into v_locked_now, v_month_key
  from public.deductions_candidates
  where id = v_candidate
  for update;
  if not found then
    raise exception 'phx_restore_deduction_dispute_state: candidate % no longer exists', v_candidate;
  end if;
  perform 1 from public.deductions_publication_lines where candidate_id = v_candidate for update;
  select * into v_now from public.deductions_decisions where candidate_id = v_candidate for update;
  v_now_json := case when v_now.id is null then null else to_jsonb(v_now) end;
  perform 1 from public.dispute_refunds where case_kind = 'deduction' and case_ref = v_ref for update;

  -- 2. WHAT SOMEBODY ELSE CHANGED SINCE THIS ATTEMPT'S LAST WRITE. A row this attempt changed (it
  --    differs between the before-state and the left-state) must still be exactly as it was left; a row
  --    that is here now but not in the left-state, or was in the before-state and vanished, is somebody
  --    else's. A row this attempt never touched is not compared and not written.
  select coalesce(array_agg(msg order by msg), '{}') into v_more
  from (
    select format('payslip line %s', id) as msg
    from (select l.id, to_jsonb(l) as now_row
            from public.deductions_publication_lines l where l.candidate_id = v_candidate) cur
    full join (select nullif(s->>'id', '')::uuid as id, s as left_row from jsonb_array_elements(v_left_lines) s) lft using (id)
    full join (select nullif(s->>'id', '')::uuid as id, s as before_row from jsonb_array_elements(v_before_lines) s) bef using (id)
    where case
            when lft.left_row is null then true
            when lft.left_row is distinct from bef.before_row then cur.now_row is distinct from lft.left_row
            else false
          end
  ) q;
  v_conflicts := v_conflicts || v_more;

  if v_left_decision is distinct from v_before_decision and v_now_json is distinct from v_left_decision then
    v_conflicts := v_conflicts || array['the decision'];
  end if;

  select coalesce(array_agg(msg order by msg), '{}') into v_more
  from (
    select format('refund %s', id) as msg
    from (select r.id, to_jsonb(r) as now_row
            from public.dispute_refunds r where r.case_kind = 'deduction' and r.case_ref = v_ref) cur
    full join (select nullif(s->>'id', '')::uuid as id, s as left_row from jsonb_array_elements(v_left_refunds) s) lft using (id)
    full join (select nullif(s->>'id', '')::uuid as id, s as before_row from jsonb_array_elements(v_before_refunds) s) bef using (id)
    where case
            when lft.left_row is null then true
            when lft.left_row is distinct from bef.before_row then cur.now_row is distinct from lft.left_row
            else false
          end
  ) q;
  v_conflicts := v_conflicts || v_more;

  v_lock_touched := v_left_lock is distinct from v_before_lock;
  if v_lock_touched and v_locked_now is distinct from v_left_lock then
    v_conflicts := v_conflicts || array['the publication lock'];
  end if;

  if array_length(v_conflicts, 1) is not null then
    insert into public.deductions_audit (candidate_id, actor_hr_id, action, detail)
    values (
      v_candidate, p_actor, 'dispute_decision_undo_refused',
      jsonb_build_object('conflicts', to_jsonb(v_conflicts), 'restore_to', p_snapshot, 'left', p_left)
    );
    return jsonb_build_object('restored', false, 'conflicts', to_jsonb(v_conflicts), 'publicationsLeftEmpty', '[]'::jsonb);
  end if;

  select coalesce(array_agg((value #>> '{}')::uuid), '{}') into v_known_pubs
  from jsonb_array_elements(coalesce(p_snapshot->'publicationIds', '[]'::jsonb));

  -- Every publication whose totals this undo may move.
  select coalesce(array_agg(distinct x), '{}') into v_pub_ids
  from (
    select l.publication_id as x from public.deductions_publication_lines l where l.candidate_id = v_candidate
    union
    select nullif(s->>'publication_id', '')::uuid from jsonb_array_elements(v_before_lines) s
    union
    select p.id from public.deductions_publications p
     where p.month_key = v_month_key and not (p.id = any (v_known_pubs))
  ) q
  where x is not null;

  -- 3. Lines this attempt pushed are removed; lines it withdrew or superseded are set back, withdrawn
  --    ones first so the one-active-line index never sees two. Only this candidate's lines.
  delete from public.deductions_publication_lines l
   where l.candidate_id = v_candidate
     and exists (select 1 from jsonb_array_elements(v_left_lines) s where nullif(s->>'id', '')::uuid = l.id)
     and not exists (select 1 from jsonb_array_elements(v_before_lines) s where nullif(s->>'id', '')::uuid = l.id);

  for v_item in
    select b.value
      from jsonb_array_elements(v_before_lines) b
      join jsonb_array_elements(v_left_lines) a on a.value->>'id' = b.value->>'id'
     where a.value is distinct from b.value
     order by (b.value->>'line_status' = 'active')
  loop
    update public.deductions_publication_lines l
       set line_status           = r.line_status,
           superseded_by_line_id = r.superseded_by_line_id,
           notified_at           = r.notified_at,
           notification_status   = r.notification_status
      from jsonb_populate_record(null::public.deductions_publication_lines, v_item) r
     where l.id = r.id
       and l.candidate_id = v_candidate;
  end loop;

  -- 4. The decision, only where this attempt changed it. Written through the table, so
  --    phx_deductions_decisions_history records an update or an insert; a decision on a LOCKED
  --    candidate is refused by phx_deductions_decisions_refuse_locked, so the lock comes off first and
  --    goes back in step 6.
  if v_left_decision is distinct from v_before_decision then
    if v_locked_now is not null then
      update public.deductions_candidates set locked_at = null where id = v_candidate;
    end if;
    if v_before_decision is null then
      delete from public.deductions_decisions where candidate_id = v_candidate and id = v_now.id;
      -- The history trigger records inserts and updates only, so the removal is written here, in the
      -- trigger's own row shape (20261113151739_deduction_decision_history.sql), in this transaction.
      insert into public.deductions_audit (candidate_id, actor_hr_id, action, detail)
      values (
        v_candidate,
        p_actor,
        'decision_removed',
        jsonb_build_object(
          'decision_id', v_now.id,
          'changed_fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from unnest(deciding) k
                              where jsonb_typeof(v_now_json -> k) <> 'null'),
          'before', (select jsonb_object_agg(k, v_now_json -> k) from unnest(deciding) k),
          'after', null,
          'decided_at', v_now.decided_at,
          'actor_role_at_decision', v_now.actor_role_at_decision,
          'removed_by', 'phx_restore_deduction_dispute_state'
        )
      );
    else
      v_want := jsonb_populate_record(null::public.deductions_decisions, v_before_decision);
      if v_now.id is null then
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
  end if;

  -- 5. The case's refunds: one this attempt recommended is removed; one it cancelled is live again.
  --    Cancelled first, so the one-live-refund-per-case index never sees two. Only this case's refunds.
  delete from public.dispute_refunds r
   where r.case_kind = 'deduction' and r.case_ref = v_ref
     and exists (select 1 from jsonb_array_elements(v_left_refunds) s where nullif(s->>'id', '')::uuid = r.id)
     and not exists (select 1 from jsonb_array_elements(v_before_refunds) s where nullif(s->>'id', '')::uuid = r.id);

  for v_item in
    select b.value
      from jsonb_array_elements(v_before_refunds) b
      join jsonb_array_elements(v_left_refunds) a on a.value->>'id' = b.value->>'id'
     where a.value is distinct from b.value
     order by (b.value->>'status' = 'recommended')
  loop
    update public.dispute_refunds d
       set status             = r.status,
           cancelled_at       = r.cancelled_at,
           cancelled_by_hr_id = r.cancelled_by_hr_id,
           cancel_reason      = r.cancel_reason
      from jsonb_populate_record(null::public.dispute_refunds, v_item) r
     where d.id = r.id
       and d.case_kind = 'deduction' and d.case_ref = v_ref;
  end loop;

  -- 6. The lock: back to the before-state where this attempt changed it, otherwise as it was found.
  v_final_lock := case when v_lock_touched then v_before_lock else v_locked_now end;
  update public.deductions_candidates
     set locked_at = v_final_lock
   where id = v_candidate
     and locked_at is distinct from v_final_lock;

  -- 7. The publications' counts and totals follow their active lines, as push and withdraw keep them.
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
    jsonb_build_object('restored_to', p_snapshot, 'left', p_left, 'publications_left_empty', to_jsonb(v_left_pubs))
  );

  return jsonb_build_object('restored', true, 'conflicts', '[]'::jsonb, 'publicationsLeftEmpty', to_jsonb(v_left_pubs));
end;
$$;

comment on function public.phx_restore_deduction_dispute_state(jsonb, jsonb, text) is
  'Undo of a deduction dispute decision that failed after its first write (F-PAY-005): puts back the '
  'lines, the decision, the refunds and the lock THIS attempt changed, only while each still equals '
  'what the attempt left; otherwise refuses whole and names the rows changed by somebody else. One '
  'transaction. Writes the decision through the table so its history trigger still fires, and writes '
  'the history row for a removed decision itself.';

revoke execute on function public.phx_restore_deduction_dispute_state(jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.phx_restore_deduction_dispute_state(jsonb, jsonb, text) to service_role;

-- ------------------------------------------------------------- the "needs attention" marker

alter table public.dispute_case_events drop constraint if exists dispute_case_events_type_check;
alter table public.dispute_case_events add constraint dispute_case_events_type_check
  check (event_type = any (array[
    'reopen_requested'::text, 'reopen_declined'::text, 'reopened'::text, 'decided'::text,
    'refund_recommended'::text, 'refund_cancelled'::text, 'decision_interrupted'::text
  ]));

commit;
