-- Resignation releases the leaver's CRM identity so the replacement hire can inherit it.
--
-- Owner rule, 2026-08-05. employees_crm_id_unique_idx and employees_crm_username_unique_idx are
-- UNIQUE across ALL employees regardless of employment_status, and the employee-import validator
-- builds its crm_id -> hr_id map with no active-only filter (unlike the org-seat map 15 lines
-- below it in the same file). So a resigned employee who kept their CRM identity permanently
-- blocked their own successor's master import with:
--
--   Row 78: CRM ID 1399 is already assigned to HR_ID B-97.
--
-- 30 leavers were holding a CRM identity when this was found; their values were backed up to
-- public.backup_employee_crm_identity_20260805 and cleared by hand to unblock a live hire. This
-- migration makes the release automatic so it cannot recur.
--
-- Only step 3 changes; the rest of the function is reproduced verbatim from the deployed
-- definition so this stays a reviewable diff of one concern.

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
set search_path to ''
as $function$
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
  --    crm_id / crm_username are cleared here so the seat's CRM identity returns to the pool
  --    for the replacement hire (see header). The TypeScript fallback path clears the same two
  --    columns, so both routes into a terminal state behave identically.
  update public.employees set
    employment_status = p_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    crm_id = null,
    crm_username = null,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- 4. Deactivate app access (DB-side only; Telegram deactivation is external).
  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

  -- 5. Fix-3 (now covers EVERY seat, not just the first): vacate every au seat the resigning
  --    employee currently occupies. Was `limit 1` with no ORDER BY, which on the model's one
  --    dual-seat occupant (B-1) would close only ONE and leave the other stale. A resigned
  --    employee cannot occupy any seat, so all open person-spans must close.
  for v_seat_id in
    select seat_id
    from au.occupancy_history
    where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
      and effective_to is null
      and node_type = 'person'
    order by seat_id
  loop
    perform au.resign_occupant(v_seat_id, p_effective_date, coalesce(p_reason, 'resignation'), p_actor);
  end loop;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'resignation_id', v_resignation_id,
    'vacancy_code', p_vacancy_code
  );
end;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so these two statements are a no-op
-- re-assertion of what is already live ({postgres=X/postgres,service_role=X/postgres}).
-- They are stated explicitly anyway so this migration is self-contained and satisfies the
-- secdef revoke guard: a SECURITY DEFINER function must never be executable by PUBLIC,
-- because anon and authenticated inherit EXECUTE through PUBLIC membership.
--
-- The GRANT is not optional. Revoking from PUBLIC on a default ACL also removes the
-- implicit EXECUTE that service_role was relying on, which would break every server-side
-- caller of this RPC — the app reaches it exclusively through the service-role client.
revoke execute on function public.phx_resign_employee_and_open_vacancy(
  text, date, text, text, text, text, date, text, text
) from public;

grant execute on function public.phx_resign_employee_and_open_vacancy(
  text, date, text, text, text, text, date, text, text
) to service_role;
