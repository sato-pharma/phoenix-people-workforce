begin;

drop view if exists public.v_hr_id_orphan_audit;

drop index if exists public.idx_sales_targets_manager_hr_id;
drop index if exists public.idx_sales_targets_employee_hr_id;
drop index if exists public.idx_sales_targets_batch_id;
drop index if exists public.idx_sales_target_batches_period;

drop table if exists public.sales_targets;
drop table if exists public.sales_target_batches;

create or replace view public.v_hr_id_orphan_audit as
with employee_index as (
  select lower(trim(hr_id)) as normalized_hr_id
  from public.employees
  where hr_id is not null
    and trim(hr_id) <> ''
),
orphan_rows as (
  select
    'sales_records.employee_hr_id'::text as source,
    sr.employee_hr_id as hr_id,
    count(*)::bigint as rows_count,
    min(nullif(trim(sr.employee_name), '')) as sample_name
  from public.sales_records sr
  left join employee_index ei on ei.normalized_hr_id = lower(trim(sr.employee_hr_id))
  where sr.employee_hr_id is not null
    and trim(sr.employee_hr_id) <> ''
    and ei.normalized_hr_id is null
  group by sr.employee_hr_id

  union all

  select
    'sales_records.manager_hr_id'::text as source,
    sr.manager_hr_id as hr_id,
    count(*)::bigint as rows_count,
    min(nullif(trim(sr.employee_name), '')) as sample_name
  from public.sales_records sr
  left join employee_index ei on ei.normalized_hr_id = lower(trim(sr.manager_hr_id))
  where sr.manager_hr_id is not null
    and trim(sr.manager_hr_id) <> ''
    and ei.normalized_hr_id is null
  group by sr.manager_hr_id

  union all

  select
    'salary_flags.hr_id'::text as source,
    sf.hr_id as hr_id,
    count(*)::bigint as rows_count,
    null::text as sample_name
  from public.salary_flags sf
  left join employee_index ei on ei.normalized_hr_id = lower(trim(sf.hr_id))
  where sf.hr_id is not null
    and trim(sf.hr_id) <> ''
    and ei.normalized_hr_id is null
  group by sf.hr_id

  union all

  select
    'payroll_expenses.hr_id'::text as source,
    pe.hr_id as hr_id,
    count(*)::bigint as rows_count,
    min(nullif(trim(pe.specialist), '')) as sample_name
  from public.payroll_expenses pe
  left join employee_index ei on ei.normalized_hr_id = lower(trim(pe.hr_id))
  where pe.hr_id is not null
    and trim(pe.hr_id) <> ''
    and ei.normalized_hr_id is null
  group by pe.hr_id
)
select
  source,
  hr_id,
  rows_count,
  sample_name
from orphan_rows
order by source, hr_id;

commit;
