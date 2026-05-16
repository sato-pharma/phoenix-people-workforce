-- HR_ID Governance Safe Enforcement
-- Goal: employees.hr_id is the source of truth.
-- This migration:
-- 1) Creates an audit view for orphan HR_ID values.
-- 2) Inserts known system placeholders needed by existing imported sales data.
-- 3) Adds foreign keys safely only when no orphan data remains.
-- 4) Adds supporting indexes.

do $migration$
begin
  if to_regclass('public.employees') is null then
    raise notice 'Skipping hr_id governance bootstrap because public.employees does not exist yet.';
    return;
  end if;

  -- =====================================================
  -- 0. Make sure placeholder employees exist for imported non-person buckets
  -- =====================================================
  insert into public.employees (hr_id, full_name, employment_status, created_at, updated_at)
  values
    ('O-3', 'Others / Unassigned', 'system_placeholder', now(), now()),
    ('c-o1', 'Unknown Manager / System Placeholder', 'system_placeholder', now(), now())
  on conflict (hr_id) do update
  set
    full_name = excluded.full_name,
    employment_status = coalesce(public.employees.employment_status, excluded.employment_status),
    updated_at = now();

  -- =====================================================
  -- 1. HR_ID orphan audit view
  -- =====================================================
  execute $view$
    create or replace view public.v_hr_id_orphan_audit as
    select 'salary_records.hr_id' as source, sr.hr_id as hr_id, count(*) as rows_count, max(sr.full_name) as sample_name
    from public.salary_records sr
    left join public.employees e on e.hr_id = sr.hr_id
    where sr.hr_id is not null and e.hr_id is null
    group by sr.hr_id
    union all
    select 'salary_flags.hr_id' as source, sf.hr_id as hr_id, count(*) as rows_count, null::text as sample_name
    from public.salary_flags sf
    left join public.employees e on e.hr_id = sf.hr_id
    where sf.hr_id is not null and e.hr_id is null
    group by sf.hr_id
    union all
    select 'payroll_expenses.hr_id' as source, pe.hr_id as hr_id, count(*) as rows_count, max(pe.specialist) as sample_name
    from public.payroll_expenses pe
    left join public.employees e on e.hr_id = pe.hr_id
    where pe.hr_id is not null and e.hr_id is null
    group by pe.hr_id
    union all
    select 'sales_records.employee_hr_id' as source, sr.employee_hr_id as hr_id, count(*) as rows_count, max(sr.employee_name) as sample_name
    from public.sales_records sr
    left join public.employees e on e.hr_id = sr.employee_hr_id
    where sr.employee_hr_id is not null and e.hr_id is null
    group by sr.employee_hr_id
    union all
    select 'sales_records.manager_hr_id' as source, sr.manager_hr_id as hr_id, count(*) as rows_count, null::text as sample_name
    from public.sales_records sr
    left join public.employees e on e.hr_id = sr.manager_hr_id
    where sr.manager_hr_id is not null and e.hr_id is null
    group by sr.manager_hr_id
    union all
    select 'sales_targets.employee_hr_id' as source, st.employee_hr_id as hr_id, count(*) as rows_count, max(st.employee_name) as sample_name
    from public.sales_targets st
    left join public.employees e on e.hr_id = st.employee_hr_id
    where st.employee_hr_id is not null and e.hr_id is null
    group by st.employee_hr_id
    union all
    select 'sales_targets.manager_hr_id' as source, st.manager_hr_id as hr_id, count(*) as rows_count, null::text as sample_name
    from public.sales_targets st
    left join public.employees e on e.hr_id = st.manager_hr_id
    where st.manager_hr_id is not null and e.hr_id is null
    group by st.manager_hr_id
  $view$;

  -- =====================================================
  -- 2. Supporting indexes
  -- =====================================================
  create index if not exists idx_salary_records_hr_id on public.salary_records(hr_id);
  create index if not exists idx_salary_flags_hr_id on public.salary_flags(hr_id);
  create index if not exists idx_payroll_expenses_hr_id on public.payroll_expenses(hr_id);
  create index if not exists idx_sales_records_employee_hr_id_safe on public.sales_records(employee_hr_id);
  create index if not exists idx_sales_records_manager_hr_id_safe on public.sales_records(manager_hr_id);
  create index if not exists idx_sales_targets_employee_hr_id on public.sales_targets(employee_hr_id);
  create index if not exists idx_sales_targets_manager_hr_id on public.sales_targets(manager_hr_id);

  -- =====================================================
  -- 3. Add FK constraints safely only if data is clean and FK does not exist
  -- =====================================================
  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'salary_records.hr_id')
     and not exists (select 1 from pg_constraint where conname = 'salary_records_hr_id_fkey') then
    alter table public.salary_records
      add constraint salary_records_hr_id_fkey
      foreign key (hr_id) references public.employees(hr_id);
  end if;

  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'salary_flags.hr_id')
     and not exists (select 1 from pg_constraint where conname = 'salary_flags_hr_id_fkey') then
    alter table public.salary_flags
      add constraint salary_flags_hr_id_fkey
      foreign key (hr_id) references public.employees(hr_id);
  end if;

  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'payroll_expenses.hr_id')
     and not exists (select 1 from pg_constraint where conname = 'payroll_expenses_hr_id_fkey') then
    alter table public.payroll_expenses
      add constraint payroll_expenses_hr_id_fkey
      foreign key (hr_id) references public.employees(hr_id);
  end if;

  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_records.employee_hr_id')
     and not exists (select 1 from pg_constraint where conname = 'sales_records_employee_hr_id_fkey') then
    alter table public.sales_records
      add constraint sales_records_employee_hr_id_fkey
      foreign key (employee_hr_id) references public.employees(hr_id);
  end if;

  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_records.manager_hr_id')
     and not exists (select 1 from pg_constraint where conname = 'sales_records_manager_hr_id_fkey') then
    alter table public.sales_records
      add constraint sales_records_manager_hr_id_fkey
      foreign key (manager_hr_id) references public.employees(hr_id);
  end if;

  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_targets.employee_hr_id')
     and not exists (select 1 from pg_constraint where conname = 'sales_targets_employee_hr_id_fkey') then
    alter table public.sales_targets
      add constraint sales_targets_employee_hr_id_fkey
      foreign key (employee_hr_id) references public.employees(hr_id);
  end if;

  if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_targets.manager_hr_id')
     and not exists (select 1 from pg_constraint where conname = 'sales_targets_manager_hr_id_fkey') then
    alter table public.sales_targets
      add constraint sales_targets_manager_hr_id_fkey
      foreign key (manager_hr_id) references public.employees(hr_id);
  end if;
end
$migration$;
