-- Employee Lifecycle Engine Phase 1
-- Adds lifecycle data model + safe database functions for:
-- 1) accepted offer -> employee master + compensation + history + notifications
-- 2) manual hire finalization support
-- 3) resignation -> inactive employee + vacancy + history + notification cleanup

-- =====================================================
-- 1. Employees lifecycle columns
-- =====================================================
alter table public.employees
  add column if not exists onboarding_source text,
  add column if not exists onboarding_status text default 'active',
  add column if not exists resignation_date date,
  add column if not exists last_working_date date,
  add column if not exists exit_reason text,
  add column if not exists exit_status text,
  add column if not exists payroll_eligible boolean default true,
  add column if not exists organogram_visible boolean default true;

-- =====================================================
-- 2. Employee resignations table
-- =====================================================
create table if not exists public.employee_resignations (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null references public.employees(hr_id),
  resignation_date date not null default current_date,
  last_working_date date not null,
  reason text,
  exit_status text not null default 'submitted',
  notes text,
  create_vacancy boolean not null default true,
  vacancy_id bigint references public.position_vacancies(id),
  submitted_by_hr_id text references public.employees(hr_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_resignations_exit_status_check check (
    exit_status in ('submitted','approved','cancelled','completed')
  )
);

create index if not exists employee_resignations_employee_hr_id_idx
on public.employee_resignations(employee_hr_id);

create index if not exists employee_resignations_last_working_date_idx
on public.employee_resignations(last_working_date);

alter table public.employee_resignations enable row level security;

-- =====================================================
-- 3. Notification helper function
-- =====================================================
create or replace function public.create_lifecycle_notification_event(
  p_category text,
  p_employee_hr_id text,
  p_scheduled_for date,
  p_subject text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_event_key text;
begin
  if p_employee_hr_id is null or p_scheduled_for is null then
    return null;
  end if;

  v_event_key := p_category || ':' || p_employee_hr_id || ':' || p_scheduled_for::text;

  insert into public.notification_events (
    event_key,
    category,
    employee_hr_id,
    scheduled_for,
    recipients,
    subject,
    status,
    metadata,
    created_at,
    updated_at
  )
  values (
    v_event_key,
    p_category,
    p_employee_hr_id,
    p_scheduled_for,
    '{}'::text[],
    p_subject,
    'pending',
    coalesce(p_metadata, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (event_key) do update
  set
    subject = excluded.subject,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- =====================================================
-- 4. Generate lifecycle notifications
-- =====================================================
create or replace function public.generate_employee_lifecycle_notifications(p_employee_hr_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
  d integer;
begin
  select * into e
  from public.employees
  where hr_id = p_employee_hr_id;

  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  -- Probation: 30/14/7/0 days
  if e.probation_end_date is not null then
    foreach d in array array[30,14,7,0]
    loop
      perform public.create_lifecycle_notification_event(
        'probation',
        e.hr_id,
        e.probation_end_date - d,
        case when d = 0 then 'Probation ends today: ' else 'Probation reminder: ' end || e.full_name,
        jsonb_build_object('days_before', d, 'target_date', e.probation_end_date)
      );
    end loop;
  end if;

  -- Contract renewal: 60/30/7/0 days
  if e.contract_renewal_date is not null then
    foreach d in array array[60,30,7,0]
    loop
      perform public.create_lifecycle_notification_event(
        'contract_renewal',
        e.hr_id,
        e.contract_renewal_date - d,
        case when d = 0 then 'Contract renewal due today: ' else 'Contract renewal reminder: ' end || e.full_name,
        jsonb_build_object('days_before', d, 'target_date', e.contract_renewal_date)
      );
    end loop;
  end if;

  -- Birthday: current year occurrence only for now; yearly scheduler can regenerate annually
  if e.birth_date is not null then
    perform public.create_lifecycle_notification_event(
      'birthday',
      e.hr_id,
      make_date(extract(year from current_date)::int, extract(month from e.birth_date)::int, extract(day from e.birth_date)::int),
      'Birthday reminder: ' || e.full_name,
      jsonb_build_object('birth_date', e.birth_date)
    );
  end if;
end;
$$;

-- =====================================================
-- 5. Accept offer -> create employee lifecycle
-- =====================================================
create or replace function public.accept_offer_and_create_employee(
  p_offer_id uuid,
  p_hr_id text,
  p_hire_date date default null,
  p_birth_date date default null,
  p_contract_start_date date default null,
  p_contract_renewal_date date default null,
  p_probation_end_date date default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  v_hire_date date;
  v_hr_id text;
begin
  select * into o
  from public.job_offers
  where id = p_offer_id;

  if not found then
    raise exception 'Offer % not found', p_offer_id;
  end if;

  if o.status not in ('sent','accepted') then
    raise exception 'Offer % is not in a valid status for acceptance. Current status: %', p_offer_id, o.status;
  end if;

  v_hr_id := trim(p_hr_id);
  if v_hr_id is null or v_hr_id = '' then
    raise exception 'HR_ID is required';
  end if;

  if exists (select 1 from public.employees where hr_id = v_hr_id)
     and coalesce(o.employee_hr_id, '') <> v_hr_id then
    raise exception 'HR_ID % already exists in employees', v_hr_id;
  end if;

  v_hire_date := coalesce(p_hire_date, o.start_date, current_date);

  insert into public.employees (
    hr_id,
    full_name,
    work_email,
    mobile_number,
    job_title,
    hire_date,
    employment_status,
    manager_hr_id,
    department_id,
    line_id,
    area_id,
    position_id,
    birth_date,
    contract_start_date,
    contract_renewal_date,
    probation_end_date,
    onboarding_source,
    onboarding_status,
    payroll_eligible,
    organogram_visible,
    created_at,
    updated_at
  )
  values (
    v_hr_id,
    o.candidate_name,
    o.candidate_email,
    o.candidate_phone,
    o.job_title,
    v_hire_date,
    'active',
    o.manager_hr_id,
    o.department_id,
    o.line_id,
    o.area_id,
    o.position_id,
    p_birth_date,
    coalesce(p_contract_start_date, v_hire_date),
    p_contract_renewal_date,
    p_probation_end_date,
    'job_offer',
    'active',
    true,
    true,
    now(),
    now()
  )
  on conflict (hr_id) do update
  set
    full_name = excluded.full_name,
    work_email = excluded.work_email,
    mobile_number = excluded.mobile_number,
    job_title = excluded.job_title,
    hire_date = excluded.hire_date,
    employment_status = 'active',
    manager_hr_id = excluded.manager_hr_id,
    department_id = excluded.department_id,
    line_id = excluded.line_id,
    area_id = excluded.area_id,
    position_id = excluded.position_id,
    birth_date = coalesce(excluded.birth_date, public.employees.birth_date),
    contract_start_date = coalesce(excluded.contract_start_date, public.employees.contract_start_date),
    contract_renewal_date = coalesce(excluded.contract_renewal_date, public.employees.contract_renewal_date),
    probation_end_date = coalesce(excluded.probation_end_date, public.employees.probation_end_date),
    onboarding_source = 'job_offer',
    onboarding_status = 'active',
    payroll_eligible = true,
    organogram_visible = true,
    updated_at = now();

  insert into public.employee_compensation (
    employee_hr_id,
    gross_salary,
    net_salary,
    created_at,
    updated_at
  )
  values (
    v_hr_id,
    o.salary_amount,
    o.salary_amount,
    now(),
    now()
  )
  on conflict (employee_hr_id) do update
  set
    gross_salary = coalesce(excluded.gross_salary, public.employee_compensation.gross_salary),
    net_salary = coalesce(excluded.net_salary, public.employee_compensation.net_salary),
    updated_at = now();

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    department_id,
    line_id,
    area_id,
    position_id,
    note,
    created_at
  )
  values (
    v_hr_id,
    'hired_from_offer',
    v_hire_date,
    o.department_id,
    o.line_id,
    o.area_id,
    o.position_id,
    'Created from accepted job offer ' || coalesce(o.offer_code, o.id::text),
    now()
  );

  update public.job_offers
  set
    status = 'accepted',
    accepted_at = coalesce(accepted_at, now()),
    employee_hr_id = v_hr_id,
    onboarding_status = 'employee_created',
    updated_at = now()
  where id = p_offer_id;

  insert into public.job_offer_audit_logs (offer_id, action, actor_type, actor_reference, details, created_at)
  values (
    p_offer_id,
    'employee_created',
    'system',
    v_hr_id,
    jsonb_build_object('hr_id', v_hr_id, 'hire_date', v_hire_date),
    now()
  );

  perform public.generate_employee_lifecycle_notifications(v_hr_id);

  return v_hr_id;
end;
$$;

-- =====================================================
-- 6. Manual employee lifecycle finalization
-- =====================================================
create or replace function public.finalize_manual_employee_lifecycle(p_employee_hr_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
begin
  select * into e from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  update public.employees
  set
    employment_status = coalesce(employment_status, 'active'),
    onboarding_source = coalesce(onboarding_source, 'manual_add'),
    onboarding_status = coalesce(onboarding_status, 'active'),
    payroll_eligible = coalesce(payroll_eligible, true),
    organogram_visible = coalesce(organogram_visible, true),
    updated_at = now()
  where hr_id = p_employee_hr_id;

  insert into public.employee_compensation (employee_hr_id, created_at, updated_at)
  values (p_employee_hr_id, now(), now())
  on conflict (employee_hr_id) do nothing;

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    department_id,
    line_id,
    area_id,
    team_id,
    position_id,
    note,
    created_at
  )
  values (
    p_employee_hr_id,
    'manual_employee_finalized',
    coalesce(e.hire_date, current_date),
    e.department_id,
    e.line_id,
    e.area_id,
    e.team_id,
    e.position_id,
    'Manual employee lifecycle finalized',
    now()
  );

  perform public.generate_employee_lifecycle_notifications(p_employee_hr_id);
end;
$$;

-- =====================================================
-- 7. Resign employee -> open vacancy
-- =====================================================
create or replace function public.resign_employee_and_open_vacancy(
  p_employee_hr_id text,
  p_resignation_date date,
  p_last_working_date date,
  p_reason text default null,
  p_notes text default null,
  p_submitted_by_hr_id text default null,
  p_create_vacancy boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
  v_resignation_id uuid;
  v_vacancy_id bigint;
  v_vacancy_code text;
begin
  select * into e
  from public.employees
  where hr_id = p_employee_hr_id;

  if not found then
    raise exception 'Employee % not found', p_employee_hr_id;
  end if;

  if p_last_working_date is null then
    raise exception 'Last working date is required';
  end if;

  if p_resignation_date is null then
    raise exception 'Resignation date is required';
  end if;

  if p_last_working_date < p_resignation_date then
    raise exception 'Last working date cannot be before resignation date';
  end if;

  if p_create_vacancy then
    v_vacancy_code := 'VAC-' || p_employee_hr_id || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

    insert into public.position_vacancies (
      vacancy_code,
      department_id,
      line_id,
      area_id,
      team_id,
      position_id,
      job_title,
      status,
      note,
      manager_hr_id,
      region_name,
      created_at,
      updated_at
    )
    values (
      v_vacancy_code,
      e.department_id,
      e.line_id,
      e.area_id,
      e.team_id,
      e.position_id,
      e.job_title,
      'open',
      'Auto-created from resignation of ' || e.full_name || ' (' || e.hr_id || ')',
      e.manager_hr_id,
      e.region_name,
      now(),
      now()
    )
    returning id into v_vacancy_id;
  end if;

  insert into public.employee_resignations (
    employee_hr_id,
    resignation_date,
    last_working_date,
    reason,
    exit_status,
    notes,
    create_vacancy,
    vacancy_id,
    submitted_by_hr_id,
    created_at,
    updated_at
  )
  values (
    p_employee_hr_id,
    p_resignation_date,
    p_last_working_date,
    p_reason,
    'approved',
    p_notes,
    p_create_vacancy,
    v_vacancy_id,
    p_submitted_by_hr_id,
    now(),
    now()
  )
  returning id into v_resignation_id;

  update public.employees
  set
    employment_status = 'resigned',
    resignation_date = p_resignation_date,
    last_working_date = p_last_working_date,
    exit_reason = p_reason,
    exit_status = 'approved',
    payroll_eligible = false,
    organogram_visible = false,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  update public.app_auth_users
  set
    is_active = false,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  update public.notification_events
  set
    status = 'cancelled',
    updated_at = now(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('cancelled_reason', 'employee_resigned')
  where employee_hr_id = p_employee_hr_id
    and status in ('pending','scheduled');

  insert into public.employee_history (
    employee_hr_id,
    event_type,
    effective_from,
    effective_to,
    department_id,
    line_id,
    area_id,
    team_id,
    position_id,
    note,
    created_at
  )
  values (
    p_employee_hr_id,
    'resignation',
    p_resignation_date,
    p_last_working_date,
    e.department_id,
    e.line_id,
    e.area_id,
    e.team_id,
    e.position_id,
    'Resignation recorded. Vacancy ID: ' || coalesce(v_vacancy_id::text, 'none') || '. Reason: ' || coalesce(p_reason, 'not provided'),
    now()
  );

  insert into public.audit_logs (
    actor_login_id,
    entity_type,
    entity_id,
    summary,
    old_values,
    new_values,
    created_at
  )
  values (
    p_submitted_by_hr_id,
    'employee_resignation',
    p_employee_hr_id,
    'Employee resigned and lifecycle updated',
    jsonb_build_object('employment_status', e.employment_status, 'organogram_visible', e.organogram_visible, 'payroll_eligible', e.payroll_eligible),
    jsonb_build_object('employment_status', 'resigned', 'organogram_visible', false, 'payroll_eligible', false, 'vacancy_id', v_vacancy_id),
    now()
  );

  return v_resignation_id;
end;
$$;

-- =====================================================
-- 8. Operational views
-- =====================================================
create or replace view public.v_active_organogram as
select
  e.hr_id,
  e.full_name,
  e.name_ar,
  e.job_title,
  e.manager_hr_id,
  m.full_name as manager_name,
  e.department_id,
  d.name as department_name,
  e.line_id,
  l.name as line_name,
  e.area_id,
  a.name as area_name,
  e.team_id,
  t.name as team_name,
  e.position_id,
  p.title as position_title,
  e.hire_date,
  e.employment_status,
  e.payroll_eligible,
  e.organogram_visible
from public.employees e
left join public.employees m on m.hr_id = e.manager_hr_id
left join public.departments d on d.id = e.department_id
left join public.lines l on l.id = e.line_id
left join public.areas a on a.id = e.area_id
left join public.teams t on t.id = e.team_id
left join public.positions p on p.id = e.position_id
where coalesce(e.organogram_visible, true) = true
  and coalesce(e.employment_status, 'active') = 'active';

create or replace view public.v_payroll_eligible_employees as
select *
from public.employees
where coalesce(payroll_eligible, true) = true
  and coalesce(employment_status, 'active') = 'active';

create or replace view public.v_lifecycle_dashboard as
select
  e.hr_id,
  e.full_name,
  e.job_title,
  e.employment_status,
  e.hire_date,
  e.probation_end_date,
  e.contract_renewal_date,
  e.birth_date,
  e.resignation_date,
  e.last_working_date,
  e.payroll_eligible,
  e.organogram_visible,
  case
    when e.employment_status = 'resigned' then 'resigned'
    when e.probation_end_date is not null and e.probation_end_date >= current_date then 'on_probation'
    when e.contract_renewal_date is not null and e.contract_renewal_date between current_date and current_date + 60 then 'contract_due_soon'
    else 'active'
  end as lifecycle_state
from public.employees e;

-- =====================================================
-- 9. Function execute hardening: keep callable from server/service, not anon
-- =====================================================
revoke execute on function public.create_lifecycle_notification_event(text,text,date,text,jsonb) from anon;
revoke execute on function public.generate_employee_lifecycle_notifications(text) from anon;
revoke execute on function public.accept_offer_and_create_employee(uuid,text,date,date,date,date,date) from anon;
revoke execute on function public.finalize_manual_employee_lifecycle(text) from anon;
revoke execute on function public.resign_employee_and_open_vacancy(text,date,date,text,text,text,boolean) from anon;
;
