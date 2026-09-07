-- Market Awareness — a decision and its audit row become ONE statement.
--
-- THE DEFECT. `decideActivity`, `closeActivity` and `withdrawActivity` each did two writes: update
-- the activity's status, then insert the decision row that records who did it. Two round trips, no
-- transaction. Anything failing between them leaves a request that MOVED with no record of who moved
-- it — and on a spending approval that is the whole audit trail.
--
-- It is not hypothetical. Reproduced on staging 2026-09-07: a CEO account with no hr_id passed the
-- role-based gate, the status update succeeded (updated_by_hr_id accepts null), the decision insert
-- failed on actor_hr_id NOT NULL, and the activity was left `approved` with `approved_at` set and no
-- approver. The route returned 500, which the approver reads as "it did not go through". A guard now
-- refuses that specific caller before the mutation, but the shape survives it: a Supabase client
-- request that times out at 15s STILL COMMITS, so a timeout between the two writes produces exactly
-- the same orphan with nobody at fault.
--
-- THE FIX. One SECURITY DEFINER function does both writes in its own transaction. A function body is
-- atomic by construction: the insert failing rolls the status back with it.
--
-- IT ALSO CLOSES A RACE THE TWO-WRITE VERSION COULD NOT SEE. The old code read the status, decided
-- the transition was legal in TypeScript, then wrote unconditionally — so two approvals arriving
-- together both passed the read and both wrote, producing two decision rows on one step. This takes
-- the row lock and re-checks the status it was told to expect, returning `applied: false` instead of
-- writing a second time. The caller reports that as "somebody else has already decided this", which
-- is true and is what the person needs to know.
--
-- THE BUSINESS RULES STAY IN TYPESCRIPT. Which transition is legal, who may decide it and whether an
-- amended amount is allowed are decided by src/lib/market-awareness/workflow.ts and scope.ts — this
-- function refuses an impossible WRITE, it does not re-implement the workflow. Restating the rules
-- here would make them two rules that disagree within a year.

create or replace function public.phx_market_awareness_apply_decision(
  p_activity_id uuid,
  p_expected_status text,
  p_next_status text,
  p_step_code text,
  p_action text,
  p_actor_hr_id text,
  p_comment text default null,
  p_amended_cost numeric default null,
  p_approved_at timestamptz default null,
  p_rejected_at timestamptz default null,
  p_returned_at timestamptz default null,
  p_withdrawn_at timestamptz default null,
  p_closed_at timestamptz default null,
  p_executed_at date default null,
  p_rep_hr_id_at_approval text default null,
  p_dm_hr_id_at_approval text default null,
  -- Optional-field flags. An optional column written unconditionally is a silent erase, so the
  -- caller says whether it SUPPLIED a value rather than the function guessing from null.
  p_set_actual_cost boolean default false,
  p_actual_cost numeric default null,
  p_set_outcome_note boolean default false,
  p_outcome_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  -- A blank actor is refused HERE as well as in the service, because this function is the last thing
  -- standing between a decision and an unattributable spending approval.
  if coalesce(btrim(p_actor_hr_id), '') = '' then
    raise exception 'market awareness: a decision cannot be recorded without an actor'
      using errcode = 'check_violation';
  end if;

  -- FOR UPDATE, so a second decision arriving at the same moment waits here and then reads the
  -- status this one wrote, rather than the status both of them read a moment ago.
  select status into v_status
    from public.market_awareness_activities
   where id = p_activity_id
   for update;

  if not found then
    raise exception 'market awareness: activity % does not exist', p_activity_id
      using errcode = 'no_data_found';
  end if;

  if v_status is distinct from p_expected_status then
    -- Not an error: somebody else decided it first. The caller turns this into a message, and
    -- NOTHING has been written.
    return jsonb_build_object('applied', false, 'currentStatus', v_status);
  end if;

  update public.market_awareness_activities
     set status                 = p_next_status,
         updated_by_hr_id       = p_actor_hr_id,
         approved_at            = coalesce(p_approved_at, approved_at),
         rejected_at            = coalesce(p_rejected_at, rejected_at),
         returned_at            = case when p_next_status = 'returned' then p_returned_at else returned_at end,
         withdrawn_at           = coalesce(p_withdrawn_at, withdrawn_at),
         closed_at              = coalesce(p_closed_at, closed_at),
         executed_at            = coalesce(p_executed_at, executed_at),
         amended_cost           = coalesce(p_amended_cost, amended_cost),
         rep_hr_id_at_approval  = case when p_next_status = 'approved' then p_rep_hr_id_at_approval else rep_hr_id_at_approval end,
         dm_hr_id_at_approval   = case when p_next_status = 'approved' then p_dm_hr_id_at_approval else dm_hr_id_at_approval end,
         actual_cost            = case when p_set_actual_cost then p_actual_cost else actual_cost end,
         outcome_note           = case when p_set_outcome_note then p_outcome_note else outcome_note end
   where id = p_activity_id;

  -- ONE decision row, under the identity of whoever actually acted. If this raises, the update above
  -- goes with it — which is the entire point of this function.
  insert into public.market_awareness_decisions (
    activity_id, step_code, actor_hr_id, action, comment, amended_cost
  ) values (
    p_activity_id, p_step_code, p_actor_hr_id, p_action, nullif(btrim(coalesce(p_comment, '')), ''), p_amended_cost
  );

  return jsonb_build_object('applied', true, 'currentStatus', p_next_status);
end;
$$;

comment on function public.phx_market_awareness_apply_decision is
  'Applies one Market Awareness decision and its audit row in a single transaction, refusing to '
  'write at all when the activity has moved since the caller read it. The workflow rules stay in '
  'src/lib/market-awareness/ — this guarantees atomicity and the precondition, nothing else.';

revoke execute on function public.phx_market_awareness_apply_decision(
  uuid, text, text, text, text, text, text, numeric, timestamptz, timestamptz, timestamptz,
  timestamptz, timestamptz, date, text, text, boolean, numeric, boolean, text
) from public, anon, authenticated;

grant execute on function public.phx_market_awareness_apply_decision(
  uuid, text, text, text, text, text, text, numeric, timestamptz, timestamptz, timestamptz,
  timestamptz, timestamptz, date, text, text, boolean, numeric, boolean, text
) to service_role;

do $verify$
declare
  v_exists boolean;
  v_anon boolean;
begin
  -- pg_proc, not the ledger: a migration file written is not a migration applied.
  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'phx_market_awareness_apply_decision'
  ) into v_exists;

  if not v_exists then
    raise exception 'market awareness: phx_market_awareness_apply_decision was not created';
  end if;

  -- A SECURITY DEFINER function reachable by anon would hand the browser key the ability to approve
  -- spending. Proven absent rather than assumed.
  select has_function_privilege('anon', p.oid, 'EXECUTE') into v_anon
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'phx_market_awareness_apply_decision';

  if v_anon then
    raise exception 'market awareness: anon can execute the decision function';
  end if;

  raise notice 'market awareness: atomic decision function created, anon cannot execute it';
end;
$verify$;
