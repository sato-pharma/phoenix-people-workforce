-- Authors the RPC the app has always called (src/lib/resignations/service.ts) but that
-- was never actually created in any migration — confirmed absent on both staging and
-- production via pg_proc. Every resignation today silently runs through a documented
-- non-transactional JS fallback (4 sequential writes, no rollback if one fails partway).
-- This restores real atomicity: any failure inside this function rolls back everything,
-- including the seat-continuity step (Fix-3) that the fallback never touched at all.
--
-- Column list verified directly against live staging schema (information_schema.columns)
-- before writing this, not inferred from the JS fallback's defensive/optional-column code.
--
-- NOTE: once this exists, disableTelegramForIdentity (external API call, cannot run inside
-- a SQL transaction) must be added to the unconditional post-call block in
-- resignEmployeeAndOpenVacancy — today it only runs on the fallback path. See the paired
-- application-code change in the same commit.

create or replace function public.phx_resign_employee_and_open_vacancy(
  p_actor text,
  p_effective_date date,
  p_employee_hr_id text,
  p_employee_status text,
  p_reason text,
  p_submitted_by_hr_id text,
  p_submitted_date date,
  p_vacancy_code text,
  p_workflow_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_line_name text;
  v_position_title text;
  v_manager_name text;
  v_vacancy_id bigint;
  v_resignation_id uuid;
  v_seat_id text;
begin
  select * into v_employee from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'phx_resign_employee_and_open_vacancy: employee % not found', p_employee_hr_id;
  end if;

  select name into v_line_name from public.lines where id = v_employee.line_id;
  select title into v_position_title from public.positions where id = v_employee.position_id;
  select full_name into v_manager_name from public.employees where hr_id = v_employee.manager_hr_id;

  -- 1. Open the replacement vacancy (mirrors insertFallbackVacancy's full payload).
  insert into public.position_vacancies (
    area_id, department_id, job_title, line_id, manager_hr_id, manager_name, note,
    position_id, region_name, replacement_for_hr_id, status, vacancy_code, created_at, updated_at
  ) values (
    v_employee.area_id, v_employee.department_id,
    coalesce(v_employee.job_title, v_position_title), v_employee.line_id,
    v_employee.manager_hr_id, v_manager_name,
    'Auto-opened from resignation of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective ' || p_effective_date,
    v_employee.position_id, v_employee.region_name, p_employee_hr_id, 'open', p_vacancy_code,
    now(), now()
  )
  returning id into v_vacancy_id;

  -- 2. Record the resignation (mirrors insertResignationRecord's full payload).
  insert into public.employee_resignations (
    employee_hr_id, employee_name, job_title, line_name,
    submitted_date, effective_date, resignation_date, last_working_date,
    reason, notes, workflow_notes, exit_status, status,
    create_vacancy, vacancy_id, submitted_by_hr_id, created_by, created_at, updated_at
  ) values (
    p_employee_hr_id, v_employee.full_name, coalesce(v_position_title, v_employee.job_title), v_line_name,
    p_submitted_date, p_effective_date, p_submitted_date, p_effective_date,
    p_reason, coalesce(p_workflow_notes, p_reason), p_workflow_notes, 'submitted', 'submitted',
    true, v_vacancy_id, p_submitted_by_hr_id, p_actor, now(), now()
  )
  returning id into v_resignation_id;

  -- 3. Update the employee's own lifecycle fields (mirrors updateEmployeeLifecycleFallback).
  --    This UPDATE fires the existing terminal-lifecycle triggers exactly as the JS
  --    fallback's equivalent UPDATE always has — no trigger logic is duplicated here.
  update public.employees set
    employment_status = p_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- 4. Deactivate app access (DB-side only; Telegram deactivation is an external API
  --    call and must stay in application code — see the note at the top of this file).
  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

  -- 5. Fix-3: vacate the resigning employee's current au seat, if any, in the SAME
  --    transaction — closes the gap that let stale occupants linger past a resignation
  --    (the exact bug FIX-D corrected once, as a one-time cutover repair, not an ongoing fix).
  select seat_id into v_seat_id
  from au.occupancy_history
  where occupant_hr_id = p_employee_hr_id and effective_to is null and node_type = 'person'
  limit 1;
  if v_seat_id is not null then
    perform au.resign_occupant(v_seat_id, p_effective_date, coalesce(p_reason, 'resignation'), p_actor);
  end if;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'resignation_id', v_resignation_id,
    'vacancy_code', p_vacancy_code
  );
end;
$$;

-- The `public` schema has a project-wide default ACL that auto-grants EXECUTE to
-- `authenticated` on every new function (confirmed via pg_default_acl on both
-- staging and production) — `revoke ... from public` alone does NOT remove that
-- direct grant. Both revokes are required or this RPC is callable by any
-- Supabase-authenticated session via PostgREST, bypassing every app-layer
-- permission/workflow check normally gating a resignation.
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from public;
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) to service_role;
