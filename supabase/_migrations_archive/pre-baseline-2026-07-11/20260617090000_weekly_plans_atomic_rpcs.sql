-- 20260617090000_weekly_plans_atomic_rpcs.sql
--
-- Weekly Plans state-transition atomicity (10/10 launch-readiness, PR 1 of 4).
--
-- Before this migration, every state transition in src/lib/weekly-planning/
-- service.ts was a sequence of supabase calls with no transaction:
--   decideEmployeePlan: UPDATE header  → INSERT decision  → INSERT return_notes
--                       → notifications fan-out.
--   acknowledgeEmployeePlan: UPSERT ack  → UPDATE header  → INSERT decision.
--   createEmployeePlan (submit=true): INSERT header(submitted)  → INSERT items
--                                     → INSERT decision  → notifications.
--
-- Race risks: two managers (or manager + CEO) could decide the same plan in
-- the same second and both succeed, leaving the header drifted from the
-- decisions log. Mid-flight failure between calls left half-baked rows.
--
-- This migration adds four SECURITY DEFINER functions that bundle each
-- transition into a single atomic write inside one Postgres transaction:
--   phx_weekly_plan_submit       (draft|manager_returned|ceo_returned → submitted)
--   phx_weekly_plan_decide       (submitted | manager_approved → next state)
--   phx_weekly_plan_acknowledge  (final_approved | hr_acknowledged → hr_acknowledged)
--   phx_weekly_plan_cancel       (draft|submitted|*_returned → cancelled)
--
-- Each function uses the employee_plan_headers.revision column as an
-- optimistic-lock token. Callers pass expected_revision; the function
-- SELECTs the header FOR UPDATE, asserts revision matches, then writes.
-- A mismatch raises a P0001 exception whose MESSAGE begins with
-- "weekly_plan_revision_conflict:" so the TypeScript layer can map it to
-- HTTP 409. Invalid state transitions raise a similar
-- "weekly_plan_invalid_transition:" exception that maps to HTTP 409 as well.
--
-- Items are intentionally NOT moved into these RPCs. They are written by the
-- service before the RPC call, while the plan is still in an editable state
-- (draft / manager_returned / ceo_returned) — no decision can be taken on
-- those states, so the brief delete-then-insert window is safe.
--
-- All four are SECURITY DEFINER + GRANTed to service_role only, mirroring
-- the phx_resign_employee_and_open_vacancy pattern (PR #184).

begin;

-- ---------------------------------------------------------------------------
-- helper: validate an action against the EMPLOYEE_PLAN_TRANSITIONS rules
-- defined in src/lib/weekly-planning/plan-v1.ts. Source of truth lives in
-- TypeScript; this function mirrors it in SQL so the RPCs can enforce the
-- same guard server-side. Returns the to_status string. Raises a typed
-- exception on a forbidden transition.
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
      if current_status not in ('draft', 'submitted', 'manager_returned', 'ceo_returned') then
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

-- REVOKE FROM PUBLIC alone is not enough: Supabase's default privileges in
-- the public schema grant EXECUTE to authenticated + anon at create time.
-- We strip all three so only service_role (and postgres, the owner) can call.
revoke execute on function public.phx_weekly_plan_next_status(text, text, boolean) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_next_status(text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- phx_weekly_plan_submit
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_submit(
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
  -- Optimistic lock: SELECT FOR UPDATE blocks concurrent transitions on this
  -- header row. expected_revision must match the current revision or we
  -- raise a typed conflict exception that the TS layer maps to HTTP 409.
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

  next_status := public.phx_weekly_plan_next_status(current_status, 'submit', true);

  update public.employee_plan_headers
    set status = next_status,
        submitted_at = coalesce(submitted_at, now_ts),
        submitted_by_login_id = coalesce(submitted_by_login_id, p_actor_login_id),
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, 'submit', current_status, next_status, null);

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_submit(uuid, integer, text, text, text) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_submit(uuid, integer, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- phx_weekly_plan_decide
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_decide(
  p_plan_id uuid,
  p_expected_revision integer,
  p_actor_hr_id text,
  p_actor_login_id text,
  p_actor_role text,
  p_action text,
  p_comment text,
  p_return_notes jsonb
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
  note jsonb;
  matched_item record;
begin
  if p_action not in (
    'manager_approve', 'manager_reject', 'manager_return',
    'ceo_approve',     'ceo_reject',     'ceo_return'
  ) then
    raise exception 'weekly_plan_invalid_transition: phx_weekly_plan_decide does not accept action ''%''', p_action using errcode = 'P0001';
  end if;

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

  next_status := public.phx_weekly_plan_next_status(
    current_status,
    p_action,
    nullif(btrim(coalesce(p_comment, '')), '') is not null
  );

  update public.employee_plan_headers
    set status = next_status,
        manager_decision_at      = case when p_action like 'manager%' then now_ts             else manager_decision_at end,
        manager_decision_by_hr_id = case when p_action like 'manager%' then p_actor_hr_id     else manager_decision_by_hr_id end,
        manager_decision_comment = case when p_action like 'manager%' then p_comment          else manager_decision_comment end,
        ceo_decision_at          = case when p_action like 'ceo%'     then now_ts             else ceo_decision_at end,
        ceo_decision_by_hr_id    = case when p_action like 'ceo%'     then p_actor_hr_id     else ceo_decision_by_hr_id end,
        ceo_decision_comment     = case when p_action like 'ceo%'     then p_comment          else ceo_decision_comment end,
        final_approved_at        = case when next_status = 'final_approved' then now_ts        else final_approved_at end,
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, p_action, current_status, next_status, p_comment);

  -- Item-level return notes only fire on the two return actions.
  if p_action in ('manager_return', 'ceo_return') and p_return_notes is not null then
    for note in select * from jsonb_array_elements(p_return_notes)
    loop
      select id, activity_date, activity_title, sort_order into matched_item
        from public.employee_plan_items
        where id = (note->>'itemId')::uuid
          and plan_id = p_plan_id;

      if matched_item.id is null then
        raise exception 'weekly_plan_invalid_transition: return-note item % does not belong to plan %', note->>'itemId', p_plan_id using errcode = 'P0001';
      end if;

      insert into public.employee_plan_item_return_notes
        (plan_id, item_id, actor_hr_id, actor_login_id, actor_role, action,
         activity_date, activity_title, sort_order, note)
        values
        (p_plan_id, matched_item.id, p_actor_hr_id, p_actor_login_id, p_actor_role, p_action,
         matched_item.activity_date, matched_item.activity_title, matched_item.sort_order, note->>'note');
    end loop;
  end if;

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_decide(uuid, integer, text, text, text, text, text, jsonb) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_decide(uuid, integer, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- phx_weekly_plan_acknowledge
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_acknowledge(
  p_plan_id uuid,
  p_expected_revision integer,
  p_hr_id text,
  p_login_id text,
  p_role_label text,
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

  next_status := public.phx_weekly_plan_next_status(current_status, 'hr_acknowledge', true);

  insert into public.employee_plan_hr_acknowledgements
    (plan_id, hr_id, login_id, role_label, comment)
    values
    (p_plan_id, p_hr_id, p_login_id, p_role_label, nullif(btrim(coalesce(p_comment, '')), ''))
    on conflict (plan_id, hr_id) do update
      set login_id = excluded.login_id,
          role_label = excluded.role_label,
          comment = excluded.comment,
          acknowledged_at = now();

  update public.employee_plan_headers
    set status = next_status,
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_hr_id, p_login_id, p_role_label, 'hr_acknowledge', current_status, next_status, p_comment);

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_acknowledge(uuid, integer, text, text, text, text) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_acknowledge(uuid, integer, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- phx_weekly_plan_cancel
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_cancel(
  p_plan_id uuid,
  p_expected_revision integer,
  p_actor_hr_id text,
  p_actor_login_id text,
  p_actor_role text,
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

  next_status := public.phx_weekly_plan_next_status(current_status, 'cancel', true);

  update public.employee_plan_headers
    set status = next_status,
        revision = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role, 'cancel', current_status, next_status, p_comment);

  return query select next_status, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_cancel(uuid, integer, text, text, text, text) from public, authenticated, anon;
grant execute on function public.phx_weekly_plan_cancel(uuid, integer, text, text, text, text) to service_role;

commit;
