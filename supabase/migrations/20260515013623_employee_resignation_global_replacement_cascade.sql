-- Global resignation/replacement governance.
-- Resigned employees must leave active runtime surfaces, and the vacancy
-- they create must retain the departed HR_ID so the replacement can inherit
-- live manager ownership safely when hired.

alter table public.position_vacancies
  add column if not exists replacement_for_hr_id text,
  add column if not exists filled_by_hr_id text,
  add column if not exists filled_at timestamptz;

comment on column public.position_vacancies.replacement_for_hr_id is
  'HR_ID of the resigned/terminated employee whose position opened this vacancy.';

comment on column public.position_vacancies.filled_by_hr_id is
  'HR_ID of the active employee hired into this vacancy.';

comment on column public.position_vacancies.filled_at is
  'Timestamp when the vacancy was filled by an employee creation/replacement flow.';

create index if not exists position_vacancies_replacement_for_hr_id_idx
on public.position_vacancies (replacement_for_hr_id);

create index if not exists position_vacancies_filled_by_hr_id_idx
on public.position_vacancies (filled_by_hr_id);

update public.position_vacancies v
set replacement_for_hr_id = r.employee_hr_id
from public.employee_resignations r
where r.vacancy_id = v.id
  and v.replacement_for_hr_id is null
  and r.employee_hr_id is not null;

update public.employees
set
  payroll_eligible = false,
  organogram_visible = false,
  updated_at = now()
where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  and (payroll_eligible is distinct from false or organogram_visible is distinct from false);

-- Conservative legacy repair: if a terminal manager has exactly one active
-- employee now occupying the same area/line/position under the same upstream
-- manager, move live reporting lines to that replacement. This fixes older
-- resignations created before vacancy filled_by metadata existed without
-- touching historical employee rows.
with terminal_employees as (
  select
    hr_id,
    area_id,
    line_id,
    position_id,
    manager_hr_id,
    coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
  from public.employees
  where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
),
replacement_candidates as (
  select
    t.hr_id as previous_hr_id,
    a.hr_id as replacement_hr_id,
    t.effective_date,
    count(*) over (partition by t.hr_id) as candidate_count
  from terminal_employees t
  join public.employees a
    on a.hr_id <> t.hr_id
   and a.area_id is not distinct from t.area_id
   and a.line_id is not distinct from t.line_id
   and a.position_id is not distinct from t.position_id
   and a.manager_hr_id is not distinct from t.manager_hr_id
   and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
   and coalesce(a.payroll_eligible, true) is true
   and coalesce(a.organogram_visible, true) is true
),
unique_replacements as (
  select previous_hr_id, replacement_hr_id, effective_date
  from replacement_candidates
  where candidate_count = 1
)
update public.employees child
set
  manager_hr_id = u.replacement_hr_id,
  updated_at = now()
from unique_replacements u
where child.manager_hr_id = u.previous_hr_id
  and lower(coalesce(child.employment_status, 'active')) in ('active', 'on_leave');

do $$
begin
  if to_regclass('public.app_auth_users') is not null then
    execute $sql$
      update public.app_auth_users u
      set is_active = false,
          updated_at = now()
      from public.employees e
      where e.hr_id = u.hr_id
        and lower(coalesce(e.employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
        and u.is_active is distinct from false
    $sql$;

    execute $sql$
      with terminal_employees as (
        select
          hr_id,
          area_id,
          line_id,
          position_id,
          manager_hr_id,
          coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
        from public.employees
        where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
      ),
      replacement_candidates as (
        select
          t.hr_id as previous_hr_id,
          a.hr_id as replacement_hr_id,
          count(*) over (partition by t.hr_id) as candidate_count
        from terminal_employees t
        join public.employees a
          on a.hr_id <> t.hr_id
         and a.area_id is not distinct from t.area_id
         and a.line_id is not distinct from t.line_id
         and a.position_id is not distinct from t.position_id
         and a.manager_hr_id is not distinct from t.manager_hr_id
         and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
         and coalesce(a.payroll_eligible, true) is true
         and coalesce(a.organogram_visible, true) is true
      ),
      unique_replacements as (
        select previous_hr_id, replacement_hr_id
        from replacement_candidates
        where candidate_count = 1
      )
      update public.app_auth_users u
      set manager_hr_id = r.replacement_hr_id,
          updated_at = now()
      from unique_replacements r
      where u.manager_hr_id = r.previous_hr_id
        and u.is_active is true
    $sql$;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    execute $sql$
      update public.user_access_profiles u
      set is_active = false,
          updated_at = now()
      from public.employees e
      where e.hr_id = u.hr_id
        and lower(coalesce(e.employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
        and u.is_active is distinct from false
    $sql$;

    execute $sql$
      with terminal_employees as (
        select
          hr_id,
          area_id,
          line_id,
          position_id,
          manager_hr_id,
          coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
        from public.employees
        where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
      ),
      replacement_candidates as (
        select
          t.hr_id as previous_hr_id,
          a.hr_id as replacement_hr_id,
          count(*) over (partition by t.hr_id) as candidate_count
        from terminal_employees t
        join public.employees a
          on a.hr_id <> t.hr_id
         and a.area_id is not distinct from t.area_id
         and a.line_id is not distinct from t.line_id
         and a.position_id is not distinct from t.position_id
         and a.manager_hr_id is not distinct from t.manager_hr_id
         and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
         and coalesce(a.payroll_eligible, true) is true
         and coalesce(a.organogram_visible, true) is true
      ),
      unique_replacements as (
        select previous_hr_id, replacement_hr_id
        from replacement_candidates
        where candidate_count = 1
      )
      update public.user_access_profiles u
      set manager_hr_id = r.replacement_hr_id,
          updated_at = now()
      from unique_replacements r
      where u.manager_hr_id = r.previous_hr_id
        and u.is_active is true
    $sql$;
  end if;
exception
  when undefined_column then
    raise notice 'Access profile inactive backfill skipped because expected columns are missing.';
end $$;

drop function if exists public.phx_resign_employee_and_open_vacancy(text,date,date,text,text,text,text,text,text);

create function public.phx_resign_employee_and_open_vacancy(
  p_employee_hr_id text,
  p_effective_date date,
  p_submitted_date date,
  p_employee_status text,
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
  v_employee_status text;
  v_line_name text;
  v_manager_name text;
  v_resignation_id uuid;
  v_vacancy_code text;
  v_vacancy_id bigint;
begin
  v_employee_status := lower(nullif(trim(coalesce(p_employee_status, 'resigned')), ''));

  if v_employee_status not in ('resigned', 'terminated', 'inactive') then
    raise exception 'Resignation employee status must be resigned, terminated, or inactive.';
  end if;

  if p_effective_date is null then
    raise exception 'Effective resignation date is required.';
  end if;

  if p_submitted_date is null then
    p_submitted_date := current_date;
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
    replacement_for_hr_id,
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
    v_employee.hr_id,
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
    resignation_date,
    last_working_date,
    reason,
    workflow_notes,
    status,
    exit_status,
    notes,
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
    'submitted',
    coalesce(p_workflow_notes, p_reason),
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
    begin
      execute
        'update public.app_auth_users set is_active = false, updated_at = now() where hr_id = $1'
        using v_employee.hr_id;
    exception when undefined_column then
      raise notice 'app_auth_users access deactivation skipped because expected columns are missing.';
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = $1'
        using v_employee.hr_id;
    exception when undefined_column then
      raise notice 'user_access_profiles access deactivation skipped because expected columns are missing.';
    end;
  end if;

  return jsonb_build_object(
    'employee_hr_id', v_employee.hr_id,
    'employee_status', v_employee_status,
    'resignation_id', v_resignation_id,
    'replacement_for_hr_id', v_employee.hr_id,
    'vacancy_id', v_vacancy_id,
    'vacancy_code', v_vacancy_code
  );
end;
$$;

revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,date,text,text,text,text,text,text)
from public, anon, authenticated;

grant execute on function public.phx_resign_employee_and_open_vacancy(text,date,date,text,text,text,text,text,text)
to service_role;

notify pgrst, 'reload schema';
