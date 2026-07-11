-- 20260629110000_weekly_plans_visit_details.sql
--
-- Weekly Plans — "Request Visit Details" flow.
--
-- Managers reviewing a submitted plan that contains Field (single-visit) days
-- can now request structured visit information from the submitter before deciding.
-- The transition is:
--
--   submitted → [manager: request_visit_details] → details_requested
--   details_requested → [employee: submit_visit_details] → submitted
--
-- Changes in this migration:
--   1. Add 'details_requested' to the status check constraint.
--   2. Add visit_details_requested_at / visit_details_requested_by_hr_id columns.
--   3. New child table employee_plan_visit_details (per-visit doctor card).
--   4. Extend phx_weekly_plan_next_status to handle the two new actions and
--      allow cancel from 'details_requested'.
--   5. New SECURITY DEFINER RPC phx_weekly_plan_request_details.
--   6. New SECURITY DEFINER RPC phx_weekly_plan_submit_details.

begin;

-- ---------------------------------------------------------------------------
-- 1. Status check constraint: add 'details_requested'
-- ---------------------------------------------------------------------------
alter table public.employee_plan_headers
  drop constraint if exists employee_plan_headers_status_check;

alter table public.employee_plan_headers
  add constraint employee_plan_headers_status_check check (
    status in (
      'draft',
      'submitted',
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
    )
  );

-- ---------------------------------------------------------------------------
-- 2. New metadata columns on the header
-- ---------------------------------------------------------------------------
alter table public.employee_plan_headers
  add column if not exists visit_details_requested_at       timestamptz,
  add column if not exists visit_details_requested_by_hr_id text;

-- ---------------------------------------------------------------------------
-- 3. New child table: employee_plan_visit_details
--    One row per doctor visit entry. A single Field day can have 1-N rows
--    (the employee uses the "+" button to add more visits per day).
-- ---------------------------------------------------------------------------
create table if not exists public.employee_plan_visit_details (
  id          uuid        not null default gen_random_uuid() primary key,
  plan_id     uuid        not null references public.employee_plan_headers(id) on delete cascade,
  item_id     uuid        not null references public.employee_plan_items(id)   on delete cascade,
  doctor_name text        not null,
  speciality  text        not null,
  address     text        not null,
  objective   text        not null,
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists employee_plan_visit_details_plan_id_idx
  on public.employee_plan_visit_details(plan_id);

create index if not exists employee_plan_visit_details_item_id_idx
  on public.employee_plan_visit_details(item_id);

-- RLS: same service_role-bypass pattern as every other plan child table.
alter table public.employee_plan_visit_details enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Extend phx_weekly_plan_next_status
--    (Replace so the new actions + updated cancel are covered in one step.)
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_next_status(
  current_status text,
  action         text,
  has_comment    boolean
)
returns text
language plpgsql
immutable
as $$
declare
  to_status       text;
  requires_comment boolean := false;
begin
  case action
    when 'submit' then
      if current_status not in ('draft', 'manager_returned', 'ceo_returned') then
        raise exception 'weekly_plan_invalid_transition: action ''%'' not allowed from status ''%''', action, current_status using errcode = 'P0001';
      end if;
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
      if current_status not in ('draft', 'submitted', 'details_requested', 'manager_returned', 'ceo_returned') then
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
grant  execute on function public.phx_weekly_plan_next_status(text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. phx_weekly_plan_request_details
--    Manager-side: moves submitted → details_requested.
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_request_details(
  p_plan_id          uuid,
  p_expected_revision integer,
  p_actor_hr_id      text,
  p_actor_login_id   text,
  p_actor_role       text
)
returns table (new_status text, new_revision integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status   text;
  current_revision integer;
  now_ts           timestamptz := now();
begin
  select status, revision
    into current_status, current_revision
    from public.employee_plan_headers
    where id = p_plan_id
    for update;

  if current_status is null then
    raise exception 'weekly_plan_not_found: plan % does not exist', p_plan_id using errcode = 'P0001';
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'weekly_plan_revision_conflict: expected revision % but found %', p_expected_revision, current_revision using errcode = 'P0001';
  end if;

  -- Delegate transition validation to the central helper.
  perform public.phx_weekly_plan_next_status(current_status, 'request_visit_details', false);

  update public.employee_plan_headers
    set status                           = 'details_requested',
        visit_details_requested_at       = now_ts,
        visit_details_requested_by_hr_id = p_actor_hr_id,
        revision                         = revision + 1,
        updated_at                       = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role,
     'request_visit_details', current_status, 'details_requested', null);

  return query select 'details_requested'::text, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_request_details(uuid, integer, text, text, text) from public, authenticated, anon;
grant  execute on function public.phx_weekly_plan_request_details(uuid, integer, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. phx_weekly_plan_submit_details
--    Employee-side: upserts visit details then moves details_requested → submitted.
--    p_visit_details is a JSONB array of objects with keys:
--      itemId (uuid text), doctorName, speciality, address, objective, sortOrder (int)
-- ---------------------------------------------------------------------------
create or replace function public.phx_weekly_plan_submit_details(
  p_plan_id           uuid,
  p_expected_revision integer,
  p_actor_hr_id       text,
  p_actor_login_id    text,
  p_actor_role        text,
  p_visit_details     jsonb
)
returns table (new_status text, new_revision integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_status   text;
  current_revision integer;
  now_ts           timestamptz := now();
  detail           jsonb;
  item_id_val      uuid;
begin
  select status, revision
    into current_status, current_revision
    from public.employee_plan_headers
    where id = p_plan_id
    for update;

  if current_status is null then
    raise exception 'weekly_plan_not_found: plan % does not exist', p_plan_id using errcode = 'P0001';
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'weekly_plan_revision_conflict: expected revision % but found %', p_expected_revision, current_revision using errcode = 'P0001';
  end if;

  -- Validate transition.
  perform public.phx_weekly_plan_next_status(current_status, 'submit_visit_details', false);

  -- Wipe existing visit details for this plan (clean slate on every submission).
  delete from public.employee_plan_visit_details
    where plan_id = p_plan_id;

  -- Insert the new set, validating each item belongs to this plan and is a Field row.
  for detail in select * from jsonb_array_elements(p_visit_details)
  loop
    item_id_val := (detail->>'itemId')::uuid;

    if not exists (
      select 1 from public.employee_plan_items
        where id = item_id_val
          and plan_id = p_plan_id
          and activity_type = 'Field'
    ) then
      raise exception 'weekly_plan_invalid_transition: item % is not a Field item belonging to plan %',
        detail->>'itemId', p_plan_id using errcode = 'P0001';
    end if;

    insert into public.employee_plan_visit_details
      (plan_id, item_id, doctor_name, speciality, address, objective, sort_order)
      values (
        p_plan_id,
        item_id_val,
        detail->>'doctorName',
        detail->>'speciality',
        detail->>'address',
        detail->>'objective',
        coalesce((detail->>'sortOrder')::integer, 0)
      );
  end loop;

  -- Advance the plan back to submitted.
  update public.employee_plan_headers
    set status     = 'submitted',
        revision   = revision + 1,
        updated_at = now_ts
    where id = p_plan_id;

  insert into public.employee_plan_decisions
    (plan_id, actor_hr_id, actor_login_id, actor_role, action, from_status, to_status, comment)
    values
    (p_plan_id, p_actor_hr_id, p_actor_login_id, p_actor_role,
     'submit_visit_details', current_status, 'submitted', null);

  return query select 'submitted'::text, current_revision + 1;
end;
$$;

revoke execute on function public.phx_weekly_plan_submit_details(uuid, integer, text, text, text, jsonb) from public, authenticated, anon;
grant  execute on function public.phx_weekly_plan_submit_details(uuid, integer, text, text, text, jsonb) to service_role;

commit;
