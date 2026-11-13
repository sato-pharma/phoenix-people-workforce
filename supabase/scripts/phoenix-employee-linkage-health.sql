-- Phoenix Workforce linkage health views.
-- Run after phoenix-core-employee-payroll-schema.sql and phoenix-sales-manager-hr-id.sql.

create table if not exists public.sales_role_overrides (
  hr_id text primary key,
  role text not null check (role in ('MR', 'DSM', 'NSM')),
  note text null,
  updated_at timestamptz not null default now()
);

insert into public.sales_role_overrides (hr_id, role, note)
values
  ('B-116', 'DSM', 'Seeded from application sales role mapping.'),
  ('B-117', 'DSM', 'Seeded from application sales role mapping.'),
  ('B-118', 'DSM', 'Seeded from application sales role mapping.'),
  ('B-119', 'DSM', 'Seeded from application sales role mapping.'),
  ('B-120', 'DSM', 'Seeded from application sales role mapping.'),
  ('B-187', 'DSM', 'Seeded from application sales role mapping.')
on conflict (hr_id) do update
set
  role = excluded.role,
  note = excluded.note,
  updated_at = now();

create or replace view public.employee_linkage_health as
select
  e.hr_id,
  e.full_name,
  e.job_title,
  e.employment_status,
  e.manager_hr_id,
  m.full_name as manager_name,
  l.name as line_name,
  a.name as area_name,
  case
    when e.manager_hr_id is null or trim(e.manager_hr_id) = '' then 'missing_manager'
    when m.hr_id is null then 'manager_not_found'
    when e.job_title is null or trim(e.job_title) = '' then 'missing_job_title'
    when e.line_id is null then 'missing_line'
    when e.area_id is null then 'missing_area'
    else 'ok'
  end as health_status
from public.employees e
left join public.employees m on lower(m.hr_id) = lower(e.manager_hr_id)
left join public.lines l on l.id = e.line_id
left join public.areas a on a.id = e.area_id;

create or replace view public.employee_linkage_health_summary as
select
  count(*)::integer as total_employees,
  count(*) filter (where health_status = 'ok')::integer as healthy_employees,
  count(*) filter (where health_status = 'missing_manager')::integer as missing_manager,
  count(*) filter (where health_status = 'manager_not_found')::integer as manager_not_found,
  count(*) filter (where health_status = 'missing_job_title')::integer as missing_job_title,
  count(*) filter (where health_status = 'missing_line')::integer as missing_line,
  count(*) filter (where health_status = 'missing_area')::integer as missing_area,
  case
    when count(*) = 0 then 1
    else round((count(*) filter (where health_status = 'ok'))::numeric / count(*)::numeric, 4)
  end as health_rate
from public.employee_linkage_health;

create or replace view public.sales_employee_linkage_health as
select
  r.batch_id,
  b.file_name,
  b.period,
  b.line,
  r.row_number,
  r.employee_hr_id,
  er.full_name as employee_name,
  er.job_title as employee_job_title,
  ero.role as employee_role_override,
  r.manager_hr_id,
  mr.full_name as manager_name,
  mr.job_title as manager_job_title,
  mro.role as manager_role_override,
  r.employee_lookup_key,
  r.territory,
  r.product,
  r.sales_value,
  r.target_value,
  r.validation_state,
  r.link_status,
  case
    when lower(coalesce(r.employee_hr_id, '')) = 'c-o1' or lower(coalesce(r.manager_hr_id, '')) = 'c-o1' then 'excluded_c_o1'
    when r.employee_hr_id is null and r.manager_hr_id is not null then 'area_without_mr'
    when r.employee_hr_id is not null and er.hr_id is null then 'mr_not_found'
    when r.manager_hr_id is not null and mr.hr_id is null then 'manager_not_found'
    when r.manager_hr_id is null or trim(r.manager_hr_id) = '' then 'missing_manager_hr_id'
    when er.hr_id is not null
      and coalesce(ero.role, '') <> 'MR'
      and coalesce(er.job_title, '') !~* '(medical|representative|mr)'
      then 'mr_role_check'
    when mr.hr_id is not null
      and coalesce(mro.role, '') <> 'DSM'
      and coalesce(mr.job_title, '') !~* '(district|dsm|manager)'
      then 'dsm_role_check'
    else 'ok'
  end as linkage_health_status
from public.sales_records r
join public.sales_import_batches b on b.id = r.batch_id
left join public.employees er on lower(er.hr_id) = lower(r.employee_hr_id)
left join public.employees mr on lower(mr.hr_id) = lower(r.manager_hr_id)
left join public.sales_role_overrides ero on lower(ero.hr_id) = lower(r.employee_hr_id)
left join public.sales_role_overrides mro on lower(mro.hr_id) = lower(r.manager_hr_id);

create or replace view public.sales_employee_linkage_health_summary as
select
  batch_id,
  file_name,
  period,
  line,
  count(*)::integer as total_rows,
  count(*) filter (where linkage_health_status = 'ok')::integer as healthy_rows,
  count(*) filter (where linkage_health_status = 'area_without_mr')::integer as area_without_mr_rows,
  count(*) filter (where linkage_health_status = 'mr_not_found')::integer as mr_not_found_rows,
  count(*) filter (where linkage_health_status = 'manager_not_found')::integer as manager_not_found_rows,
  count(*) filter (where linkage_health_status = 'missing_manager_hr_id')::integer as missing_manager_hr_id_rows,
  count(*) filter (where linkage_health_status = 'mr_role_check')::integer as mr_role_check_rows,
  count(*) filter (where linkage_health_status = 'dsm_role_check')::integer as dsm_role_check_rows,
  count(*) filter (where linkage_health_status = 'excluded_c_o1')::integer as excluded_c_o1_rows,
  case
    when count(*) filter (where linkage_health_status <> 'excluded_c_o1') = 0 then 1
    else round(
      (count(*) filter (where linkage_health_status in ('ok', 'area_without_mr')))::numeric /
      nullif((count(*) filter (where linkage_health_status <> 'excluded_c_o1'))::numeric, 0),
      4
    )
  end as linkage_health_rate
from public.sales_employee_linkage_health
group by batch_id, file_name, period, line;

notify pgrst, 'reload schema';
