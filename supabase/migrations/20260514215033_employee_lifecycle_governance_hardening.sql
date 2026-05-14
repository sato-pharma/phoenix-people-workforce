-- Employee lifecycle governance hardening.
-- Adds DB-level lifecycle defaults, immutable HR_ID guardrails, and a
-- transactional resignation RPC used by the Employees module.

create extension if not exists pgcrypto;

alter table public.employees
  add column if not exists resignation_date date,
  add column if not exists last_working_date date,
  add column if not exists exit_reason text,
  add column if not exists exit_status text,
  add column if not exists payroll_eligible boolean default true,
  add column if not exists organogram_visible boolean default true;

update public.employees
set
  payroll_eligible = coalesce(payroll_eligible, true),
  organogram_visible = coalesce(organogram_visible, true)
where payroll_eligible is null
   or organogram_visible is null;

update public.employees
set
  payroll_eligible = false,
  organogram_visible = false
where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive');

alter table public.employee_resignations
  add column if not exists create_vacancy boolean not null default true,
  add column if not exists vacancy_id bigint references public.position_vacancies(id),
  add column if not exists submitted_by_hr_id text references public.employees(hr_id);

create or replace function public.phx_prevent_employee_hr_id_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.hr_id is distinct from old.hr_id then
    raise exception 'HR_ID is immutable after employee creation. Use the governed HR_ID rename workflow.';
  end if;

  return new;
end;
$$;

drop trigger if exists phx_employees_prevent_hr_id_update on public.employees;
create trigger phx_employees_prevent_hr_id_update
before update of hr_id on public.employees
for each row
execute function public.phx_prevent_employee_hr_id_update();

create or replace function public.phx_resign_employee_and_open_vacancy(
  p_employee_hr_id text,
  p_submitted_date date,
  p_effective_date date,
  p_employee_status text default 'resigned',
  p_reason text default null,
  p_workflow_notes text default null,
  p_actor text default null,
  p_submitted_by_hr_id text default null,
  p_vacancy_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
  v_employee_status text := lower(coalesce(nullif(trim(p_employee_status), ''), 'resigned'));
  v_line_name text;
  v_manager_name text;
  v_resignation_id uuid;
  v_vacancy_code text;
  v_vacancy_id bigint;
begin
  if nullif(trim(coalesce(p_employee_hr_id, '')), '') is null then
    raise exception 'Employee HR ID is required.';
  end if;

  if p_submitted_date is null then
    raise exception 'Submitted date is required.';
  end if;

  if p_effective_date is null then
    raise exception 'Effective resignation date is required.';
  end if;

  if p_effective_date < p_submitted_date then
    raise exception 'Effective resignation date cannot be before the submitted date.';
  end if;

  if v_employee_status not in ('resigned', 'terminated', 'inactive') then
    raise exception 'Resignation employee status must be resigned, terminated, or inactive.';
  end if;

  select *
  into v_employee
  from public.employees
  where hr_id = upper(trim(p_employee_hr_id))
  for update;

  if not found then
    raise exception 'Employee was not found in the directory.';
  end if;

  if lower(coalesce(v_employee.employment_status, 'active')) in ('resigned', 'terminated') then
    raise exception 'Employee is already in a terminal lifecycle status.';
  end if;

  select name into v_line_name
  from public.lines
  where id = v_employee.line_id;

  select full_name into v_manager_name
  from public.employees
  where hr_id = v_employee.manager_hr_id;

  v_vacancy_code := coalesce(
    nullif(trim(p_vacancy_code), ''),
    'resignation_' || v_employee.hr_id || '_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
  );

  insert into public.position_vacancies (
    area_id,
    created_at,
    department_id,
    job_title,
    line_id,
    manager_hr_id,
    manager_name,
    note,
    position_id,
    region_name,
    status,
    updated_at,
    vacancy_code
  )
  values (
    v_employee.area_id,
    now(),
    v_employee.department_id,
    v_employee.job_title,
    v_employee.line_id,
    v_employee.manager_hr_id,
    v_manager_name,
    'Auto-opened from resignation of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective ' || p_effective_date::text || '.',
    v_employee.position_id,
    v_employee.region_name,
    'open',
    now(),
    v_vacancy_code
  )
  returning id into v_vacancy_id;

  insert into public.employee_resignations (
    employee_hr_id,
    employee_name,
    job_title,
    line_name,
    submitted_date,
    effective_date,
    reason,
    workflow_notes,
    status,
    created_by,
    create_vacancy,
    vacancy_id,
    submitted_by_hr_id,
    created_at,
    updated_at
  )
  values (
    v_employee.hr_id,
    v_employee.full_name,
    v_employee.job_title,
    v_line_name,
    p_submitted_date,
    p_effective_date,
    p_reason,
    case
      when nullif(trim(coalesce(p_workflow_notes, '')), '') is null then
        '[' || now()::text || '] ' || coalesce(p_actor, 'system') || ': submitted resignation'
      else
        '[' || now()::text || '] ' || coalesce(p_actor, 'system') || ': submitted resignation - ' || p_workflow_notes
    end,
    'submitted',
    p_actor,
    true,
    v_vacancy_id,
    p_submitted_by_hr_id,
    now(),
    now()
  )
  returning id into v_resignation_id;

  update public.employees
  set
    employment_status = v_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    resignation_date = p_submitted_date,
    payroll_eligible = false,
    organogram_visible = false,
    updated_at = now()
  where hr_id = v_employee.hr_id;

  if to_regclass('public.app_auth_users') is not null then
    execute
      'update public.app_auth_users set is_active = false, updated_at = now() where hr_id = $1'
      using v_employee.hr_id;
  end if;

  return jsonb_build_object(
    'employee_hr_id', v_employee.hr_id,
    'employee_status', v_employee_status,
    'resignation_id', v_resignation_id,
    'vacancy_id', v_vacancy_id,
    'vacancy_code', v_vacancy_code
  );
end;
$$;

revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,date,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text,date,date,text,text,text,text,text,text)
  to service_role;

revoke execute on function public.phx_prevent_employee_hr_id_update()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
