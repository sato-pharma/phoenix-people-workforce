-- Backfill legacy terminal employee lifecycle rows into employee_resignations.
-- This keeps /employees active-only while making historical resigned staff visible
-- in /resignations even when no workflow record was created at resignation time.

alter table public.employee_resignations
  add column if not exists create_vacancy boolean not null default true,
  add column if not exists vacancy_id bigint references public.position_vacancies(id),
  add column if not exists submitted_by_hr_id text references public.employees(hr_id),
  add column if not exists employee_name text,
  add column if not exists job_title text,
  add column if not exists line_name text,
  add column if not exists submitted_date date,
  add column if not exists effective_date date,
  add column if not exists workflow_notes text,
  add column if not exists status text,
  add column if not exists created_by text;

insert into public.employee_resignations (
  employee_hr_id,
  employee_name,
  job_title,
  line_name,
  resignation_date,
  last_working_date,
  submitted_date,
  effective_date,
  reason,
  workflow_notes,
  status,
  created_by,
  create_vacancy,
  submitted_by_hr_id,
  created_at,
  updated_at
)
select
  e.hr_id,
  e.full_name,
  e.job_title,
  l.name,
  coalesce(e.resignation_date, e.last_working_date, e.updated_at::date, current_date),
  coalesce(e.last_working_date, e.resignation_date, e.updated_at::date, current_date),
  coalesce(e.resignation_date, e.last_working_date, e.updated_at::date, current_date),
  coalesce(e.last_working_date, e.resignation_date, e.updated_at::date, current_date),
  coalesce(e.exit_reason, 'Historical lifecycle status: ' || coalesce(e.employment_status, 'resigned') || '.'),
  'Backfilled from employee lifecycle data because no resignation workflow record existed.',
  'completed',
  'system_backfill',
  false,
  null,
  coalesce(e.updated_at, now()),
  now()
from public.employees e
left join public.lines l on l.id = e.line_id
where lower(coalesce(e.employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  and not exists (
    select 1
    from public.employee_resignations r
    where r.employee_hr_id = e.hr_id
  );

notify pgrst, 'reload schema';
