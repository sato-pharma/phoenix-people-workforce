-- 20260702160000_weekly_plans_edit_request.sql
--
-- Adds "request to edit" workflow step for submitted weekly/monthly plans.
--
-- Flow:
--   employee   → request_edit          → submitted → edit_requested
--   manager    → approve_edit_request  → edit_requested → draft  (employee can now edit)
--   manager    → reject_edit_request   → edit_requested → submitted
--
-- Direct managers must leave a comment when rejecting; that rule is enforced at
-- the TypeScript service layer (not here) because the SQL has no access to the
-- actor/plan-manager relationship. The RPC accepts an optional comment and
-- records it verbatim regardless.
--
-- "cancel" is also allowed from edit_requested so the employee can withdraw
-- the plan entirely while the edit request is pending.
--
-- Originally authored as 20260629120000, before the parallel "request visit
-- details" feature (20260629110000_weekly_plans_visit_details.sql) landed on
-- main. Both migrations `create or replace` the same
-- phx_weekly_plan_next_status function and widen the same status check
-- constraint, so this file is renamed to run after it and merges both
-- features' case branches / allowed statuses instead of one replace erasing
-- the other's.

begin;

-- ---------------------------------------------------------------------------
-- 1. Widen the status check constraint.
-- ---------------------------------------------------------------------------
alter table public.employee_plan_headers
  drop constraint employee_plan_headers_status_check,
  add  constraint employee_plan_headers_status_check check (status in (
    'draft',
    'submitted',
    'edit_requested',
    'details_requested',
    'manager_approved',
    'manager_rejected',
    'manager_returned',
    'ceo_approved',
    'ceo_rejected',
    'ceo_returned',
    'final_approved',
    'hr_acknowledged',
    'cancelled'
  ));

-- ---------------------------------------------------------------------------
-- 2. Keep edit_requested inside the "active period" unique index so no
--    duplicate plan can be submitted for the same employee+kind+period while
--    an edit request is outstanding.
-- ---------------------------------------------------------------------------
drop index if exists public.employee_plan_headers_active_period_uidx;
create unique index employee_plan_headers_active_period_uidx
  on public.employee_plan_headers (employee_hr_id, plan_kind, period_key)
  where status in ('submitted', 'edit_requested', 'manager_approved', 'manager_returned', 'ceo_returned');

-- ---------------------------------------------------------------------------
-- 3. Extend the transition validator to know about the three new edit-request
--    actions, keeping the request_visit_details/submit_visit_details branches
--    from 20260629110000_weekly_plans_visit_details.sql (this `create or
--    replace` fully redefines the function, so both features' branches must
--    be present or the other feature's actions become "unknown action").
--    Source of truth lives in TypeScript (EMPLOYEE_PLAN_TRANSITIONS in
--    plan-v1.ts); this mirrors it server-side inside the atomic RPCs.
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_next_status(
  current_status text,
  action text,
  has_comment boolean
)
returns text
language plpgsql
immutable
as $$
declare
  to_status text;
  requires_comment boolean := false;
begin
  case action
    when 'submit' then
      if current_status not in ('draft', 'manager_returned', 'ceo_returned') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'submitted';

    when 'request_edit' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'edit_requested';

    when 'approve_edit_request' then
      if current_status <> 'edit_requested' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'draft';

    when 'reject_edit_request' then
      if current_status <> 'edit_requested' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      -- Comment requirement for direct manager is enforced in the TypeScript
      -- service layer; no blanket requires_comment here.
      to_status := 'submitted';

    when 'request_visit_details' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'details_requested';

    when 'submit_visit_details' then
      if current_status <> 'details_requested' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'submitted';

    when 'manager_approve' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'manager_approved';

    when 'manager_reject' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'manager_rejected';

    when 'manager_return' then
      if current_status <> 'submitted' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'manager_returned';

    when 'ceo_approve' then
      if current_status <> 'manager_approved' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'final_approved';

    when 'ceo_reject' then
      if current_status <> 'manager_approved' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'ceo_rejected';

    when 'ceo_return' then
      if current_status <> 'manager_approved' then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      requires_comment := true;
      to_status := 'ceo_returned';

    when 'hr_acknowledge' then
      if current_status not in ('final_approved', 'hr_acknowledged') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'hr_acknowledged';

    when 'cancel' then
      -- edit_requested/details_requested added: employee can still cancel
      -- while a pending edit or visit-details request is outstanding.
      if current_status not in ('draft', 'submitted', 'edit_requested', 'details_requested', 'manager_returned', 'ceo_returned') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
      to_status := 'cancelled';

    else
      raise exception 'weekly_plan_invalid_transition: unknown action ''%''', action using errcode = 'P0001';
  end case;

  if requires_comment and not has_comment then
    raise exception 'weekly_plan_invalid_transition: action ''%'' requires a comment', action using errcode = 'P0001';
  end if;

  return to_status;
end;
$$;

revoke execute on function public.phx_weekly_plan_next_status(text, text, boolean) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_next_status(text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. phx_weekly_plan_request_edit
--    Employee requests permission to edit their submitted plan.
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_request_edit(
  p_plan_id uuid,
  p_expected_revision integer,
  p_actor_hr_id text,
  p_actor_login_id text,
  p_actor_role text
)
returns table (new_status text, new_revision integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status text;
  current_revision integer;
  next_status text;
  now_ts timestamptz := now();
begin
  select status, revision into current_status, current_revision
    from public.employee_plan_headers
    where id = p_plan_id
    for update;

  if current_status is null then
    raise exception 'weekly_plan_not_found: plan % does not exist', p_plan_id using errcode = 'P0001';
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'weekly_plan_revision_conflict: expected revision % but found %', p_expected_revision, current_revision using errcode = 'P0001';
  end if;

  next_status := public.phx_weekly_plan_next_status(current_status, 'request_edit', true);

  update public.employee_plan_headers
    set status = next_status,
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, 'request_edit', current_status, next_status, null);

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_request_edit(uuid, integer, text, text, text) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_request_edit(uuid, integer, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. phx_weekly_plan_decide_edit_request
--    Manager approves or rejects the employee's edit request.
--    p_decision must be 'approve' or 'reject'.
--    Comment-requirement for direct manager on reject is enforced in TypeScript.
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_decide_edit_request(
  p_plan_id uuid,
  p_expected_revision integer,
  p_actor_hr_id text,
  p_actor_login_id text,
  p_actor_role text,
  p_decision text,
  p_comment text
)
returns table (new_status text, new_revision integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status text;
  current_revision integer;
  next_status text;
  action_name text;
  now_ts timestamptz := now();
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'weekly_plan_invalid_transition: p_decision must be ''approve'' or ''reject'', got ''%''', p_decision using errcode = 'P0001';
  end if;

  action_name := case p_decision when 'approve' then 'approve_edit_request' else 'reject_edit_request' end;

  select status, revision into current_status, current_revision
    from public.employee_plan_headers
    where id = p_plan_id
    for update;

  if current_status is null then
    raise exception 'weekly_plan_not_found: plan % does not exist', p_plan_id using errcode = 'P0001';
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'weekly_plan_revision_conflict: expected revision % but found %', p_expected_revision, current_revision using errcode = 'P0001';
  end if;

  next_status := public.phx_weekly_plan_next_status(current_status, action_name, true);

  update public.employee_plan_headers
    set status = next_status,
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, action_name, current_status, next_status, p_comment);

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_decide_edit_request(uuid, integer, text, text, text, text, text) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_decide_edit_request(uuid, integer, text, text, text, text, text) to service_role;

commit;
