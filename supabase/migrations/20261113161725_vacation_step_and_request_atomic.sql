-- vacation_step_and_request_atomic
--
-- WHAT THIS CHANGES: two functions, no table and no data.
--   * phx_apply_vacation_step_decision - in ONE transaction: locks the leave request row, checks its
--     status is still the one the approver saw, decides the approver's pending step (pending ->
--     approved/rejected), closes the sibling pending HR steps when the decided step is the HR one,
--     and applies the request patch the service built (only the twenty decision and balance columns
--     it writes today). With a NULL patch it does everything except touch the request.
--   * phx_apply_vacation_paid_approval_with_step - the same step writes, then the existing
--     phx_apply_vacation_paid_approval, in one transaction. phx_apply_vacation_paid_approval itself
--     is NOT changed - its balance logic is untouched.
-- WHY: src/lib/vacation/service.ts applyVacationDecisionSequential decided the step row (and closed
--   the sibling HR rows) with their own calls, BEFORE the request update. When the request's status
--   compare-and-set then missed - or anything between the two failed - the step stayed decided and
--   the request never moved: an approval recorded against a request still waiting on that approver.
--   Here the step and the request commit together or not at all.
-- ROLLBACK: drop function if exists public.phx_apply_vacation_paid_approval_with_step(uuid, text, uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text);
--           drop function if exists public.phx_apply_vacation_step_decision(uuid, text, uuid, text, text, text, text, timestamptz, jsonb);
--   (and revert the service to the separate calls - the service needs these functions once deployed.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive or bulk: it only creates functions.

begin;

-- ---------------------------------------------------------------------------
-- 1. Decide a step and move the request, together.
--
-- The step writes reproduce recordVacationApprovalStepDecision and closeSiblingPendingHrApprovalSteps
-- exactly - the same columns, the same "pending" compare-and-set, the same auto-complete comment.
-- p_overridden_by_hr_id arrives already passed through hrIdForStorage by the service.
--
-- Refusals, each its own message and code:
--   P0002  the request does not exist
--   40001  the request's status moved since the approver read it (same wording as the paid RPC)
--   55000  the step was already decided
--   22023  the step does not belong to this request, a bad decision value, or a patch column that
--          is not on the list
-- ---------------------------------------------------------------------------
create or replace function public.phx_apply_vacation_step_decision(
  p_request_id uuid,
  p_expected_status text,
  p_step_id uuid,
  p_step_status text,
  p_decision_comment text,
  p_overridden_by_hr_id text,
  p_actor_hr_id text,
  p_now timestamptz,
  p_request_patch jsonb
)
returns public.v2_vacation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  -- The columns applyVacationDecisionSequential writes on a decision, and nothing else.
  v_allowed constant text[] := array[
    'status',
    'updated_at',
    'hr_decision',
    'hr_decision_at',
    'hr_decision_by_hr_id',
    'hr_decision_comment',
    'manager_decision',
    'manager_decision_at',
    'manager_decision_by_hr_id',
    'manager_decision_comment',
    'balance_after_days',
    'balance_before_days',
    'entitlement_days',
    'payment_status',
    'paid_duration_days',
    'period_end',
    'period_start',
    'unpaid_reason',
    'unpaid_duration_days',
    'used_paid_days'
  ];
  v_unknown text;
  v_overridden_by text := nullif(p_overridden_by_hr_id, '');
  v_row public.v2_vacation_requests;
  v_new public.v2_vacation_requests;
  v_step_key text;
begin
  if p_step_status is null or p_step_status not in ('approved', 'rejected') then
    raise exception 'A vacation step decision is approved or rejected, not "%".', p_step_status
      using errcode = '22023';
  end if;
  if p_now is null then
    raise exception 'A vacation step decision needs its decision time.' using errcode = '22023';
  end if;
  if p_request_patch is not null then
    if jsonb_typeof(p_request_patch) <> 'object' then
      raise exception 'A vacation request patch must be an object.' using errcode = '22023';
    end if;
    select key into v_unknown
    from jsonb_object_keys(p_request_patch) as key
    where key <> all (v_allowed)
    limit 1;
    if v_unknown is not null then
      raise exception 'A vacation decision cannot change "%".', v_unknown using errcode = '22023';
    end if;
  end if;

  -- Request first, then steps: the same order the paid wrapper below takes, so two decisions on
  -- one request queue on this row lock instead of deadlocking.
  select * into v_row from public.v2_vacation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Vacation request was not found.' using errcode = 'P0002';
  end if;
  if v_row.status is distinct from p_expected_status then
    raise exception 'Vacation request was updated by another user. Refresh and try again.'
      using errcode = '40001';
  end if;

  -- recordVacationApprovalStepDecision: compare-and-set on status = 'pending'.
  update public.v2_vacation_approval_steps set
    decided_at = p_now,
    decision_comment = p_decision_comment,
    overridden_at = case when v_overridden_by is not null then p_now else null end,
    overridden_by_hr_id = v_overridden_by,
    status = p_step_status,
    updated_at = p_now
  where id = p_step_id
    and request_id = p_request_id
    and status = 'pending'
  returning step_key into v_step_key;
  if not found then
    if exists (
      select 1 from public.v2_vacation_approval_steps where id = p_step_id and request_id = p_request_id
    ) then
      raise exception 'This vacation approval step was already decided.' using errcode = '55000';
    end if;
    raise exception 'This vacation approval step does not belong to this request.' using errcode = '22023';
  end if;

  -- closeSiblingPendingHrApprovalSteps: HR is one authority - the first Super Admin to decide
  -- closes the HR step for every other account on this request.
  if v_step_key = 'hr' then
    update public.v2_vacation_approval_steps set
      decided_at = p_now,
      decision_comment = 'Auto-completed: HR step already decided by '
        || coalesce(p_actor_hr_id, 'another HR/Super Admin account') || '.',
      status = p_step_status,
      updated_at = p_now
    where request_id = p_request_id
      and step_key = 'hr'
      and status = 'pending'
      and id <> p_step_id;
  end if;

  if p_request_patch is null then
    return v_row;
  end if;

  -- Values not in the patch keep the row's own value (jsonb_populate_record with a non-null base).
  v_new := jsonb_populate_record(v_row, p_request_patch);

  update public.v2_vacation_requests set
    status = case when p_request_patch ? 'status' then v_new.status else status end,
    updated_at = case when p_request_patch ? 'updated_at' then v_new.updated_at else updated_at end,
    hr_decision = case when p_request_patch ? 'hr_decision' then v_new.hr_decision else hr_decision end,
    hr_decision_at = case when p_request_patch ? 'hr_decision_at' then v_new.hr_decision_at else hr_decision_at end,
    hr_decision_by_hr_id = case when p_request_patch ? 'hr_decision_by_hr_id' then v_new.hr_decision_by_hr_id else hr_decision_by_hr_id end,
    hr_decision_comment = case when p_request_patch ? 'hr_decision_comment' then v_new.hr_decision_comment else hr_decision_comment end,
    manager_decision = case when p_request_patch ? 'manager_decision' then v_new.manager_decision else manager_decision end,
    manager_decision_at = case when p_request_patch ? 'manager_decision_at' then v_new.manager_decision_at else manager_decision_at end,
    manager_decision_by_hr_id = case when p_request_patch ? 'manager_decision_by_hr_id' then v_new.manager_decision_by_hr_id else manager_decision_by_hr_id end,
    manager_decision_comment = case when p_request_patch ? 'manager_decision_comment' then v_new.manager_decision_comment else manager_decision_comment end,
    balance_after_days = case when p_request_patch ? 'balance_after_days' then v_new.balance_after_days else balance_after_days end,
    balance_before_days = case when p_request_patch ? 'balance_before_days' then v_new.balance_before_days else balance_before_days end,
    entitlement_days = case when p_request_patch ? 'entitlement_days' then v_new.entitlement_days else entitlement_days end,
    payment_status = case when p_request_patch ? 'payment_status' then v_new.payment_status else payment_status end,
    paid_duration_days = case when p_request_patch ? 'paid_duration_days' then v_new.paid_duration_days else paid_duration_days end,
    period_end = case when p_request_patch ? 'period_end' then v_new.period_end else period_end end,
    period_start = case when p_request_patch ? 'period_start' then v_new.period_start else period_start end,
    unpaid_reason = case when p_request_patch ? 'unpaid_reason' then v_new.unpaid_reason else unpaid_reason end,
    unpaid_duration_days = case when p_request_patch ? 'unpaid_duration_days' then v_new.unpaid_duration_days else unpaid_duration_days end,
    used_paid_days = case when p_request_patch ? 'used_paid_days' then v_new.used_paid_days else used_paid_days end
  where id = p_request_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.phx_apply_vacation_step_decision(uuid, text, uuid, text, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.phx_apply_vacation_step_decision(uuid, text, uuid, text, text, text, text, timestamptz, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The paid-balance approval, with its step written in the same transaction.
--
-- The step part is function 1 with a NULL patch (lock the request, check the status, decide the
-- step, close the HR siblings); the request part is the unchanged phx_apply_vacation_paid_approval,
-- which re-locks the same row (already held) and takes the per-employee advisory lock. An exception
-- in either rolls back both. The step is always 'approved' here: only a final approval reaches the
-- paid split.
-- ---------------------------------------------------------------------------
create or replace function public.phx_apply_vacation_paid_approval_with_step(
  p_request_id uuid,
  p_expected_status text,
  p_step_id uuid,
  p_overridden_by_hr_id text,
  p_next_status text,
  p_step text,
  p_decision_by_hr_id text,
  p_decision_comment text,
  p_now timestamptz,
  p_entitlement_days numeric,
  p_period_start date,
  p_period_end date,
  p_duration_days numeric,
  p_vacation_type text
)
returns public.v2_vacation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.v2_vacation_requests;
begin
  perform public.phx_apply_vacation_step_decision(
    p_request_id,
    p_expected_status,
    p_step_id,
    'approved',
    p_decision_comment,
    p_overridden_by_hr_id,
    p_decision_by_hr_id,
    p_now,
    null
  );

  select * into v_row
  from public.phx_apply_vacation_paid_approval(
    p_request_id,
    p_expected_status,
    p_next_status,
    p_step,
    p_decision_by_hr_id,
    p_decision_comment,
    p_now,
    p_entitlement_days,
    p_period_start,
    p_period_end,
    p_duration_days,
    p_vacation_type
  );
  if v_row.id is null then
    raise exception 'Vacation request was updated by another user. Refresh and try again.'
      using errcode = '40001';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.phx_apply_vacation_paid_approval_with_step(uuid, text, uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text) from public, anon, authenticated;
grant execute on function public.phx_apply_vacation_paid_approval_with_step(uuid, text, uuid, text, text, text, text, text, timestamptz, numeric, date, date, numeric, text) to service_role;

notify pgrst, 'reload schema';

commit;
