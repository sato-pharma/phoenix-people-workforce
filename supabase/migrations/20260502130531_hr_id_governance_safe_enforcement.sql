-- HR_ID Governance Safe Enforcement
-- Goal: employees.hr_id is the source of truth.
-- This migration:
-- 1) Creates an audit view for orphan HR_ID values.
-- 2) Inserts known system placeholders needed by existing imported sales data.
-- 3) Adds foreign keys safely only when no orphan data remains.
-- 4) Adds supporting indexes.

-- =====================================================
-- 0. Make sure placeholder employees exist for imported non-person buckets
-- =====================================================
do $$
begin
  if to_regclass('public.employees') is not null then
    insert into public.employees (hr_id, full_name, employment_status, created_at, updated_at)
    values
      ('O-3', 'Others / Unassigned', 'system_placeholder', now(), now()),
      ('c-o1', 'Unknown Manager / System Placeholder', 'system_placeholder', now(), now())
    on conflict (hr_id) do update
    set
      full_name = excluded.full_name,
      employment_status = coalesce(public.employees.employment_status, excluded.employment_status),
      updated_at = now();
  else
    raise notice 'Skipping employee placeholder insert in hr_id governance migration: public.employees does not exist yet.';
  end if;
end $$;

-- =====================================================
-- 1. HR_ID orphan audit view
-- =====================================================
do $$
declare
  sql text := '';
begin
  if to_regclass('public.employees') is not null then
    if to_regclass('public.salary_records') is not null then
      sql := sql || format(
        'select %L as source, sr.hr_id as hr_id, count(*) as rows_count, max(sr.full_name) as sample_name
         from public.salary_records sr
         left join public.employees e on e.hr_id = sr.hr_id
         where sr.hr_id is not null and e.hr_id is null
         group by sr.hr_id',
        'salary_records.hr_id'
      );
    end if;

    if to_regclass('public.salary_flags') is not null then
      sql := sql || case when sql <> '' then ' union all ' else '' end || format(
        'select %L as source, sf.hr_id as hr_id, count(*) as rows_count, null::text as sample_name
         from public.salary_flags sf
         left join public.employees e on e.hr_id = sf.hr_id
         where sf.hr_id is not null and e.hr_id is null
         group by sf.hr_id',
        'salary_flags.hr_id'
      );
    end if;

    if to_regclass('public.payroll_expenses') is not null then
      sql := sql || case when sql <> '' then ' union all ' else '' end || format(
        'select %L as source, pe.hr_id as hr_id, count(*) as rows_count, max(pe.specialist) as sample_name
         from public.payroll_expenses pe
         left join public.employees e on e.hr_id = pe.hr_id
         where pe.hr_id is not null and e.hr_id is null
         group by pe.hr_id',
        'payroll_expenses.hr_id'
      );
    end if;

    if to_regclass('public.sales_records') is not null then
      sql := sql || case when sql <> '' then ' union all ' else '' end || format(
        'select %L as source, sr.employee_hr_id as hr_id, count(*) as rows_count, max(sr.employee_name) as sample_name
         from public.sales_records sr
         left join public.employees e on e.hr_id = sr.employee_hr_id
         where sr.employee_hr_id is not null and e.hr_id is null
         group by sr.employee_hr_id',
        'sales_records.employee_hr_id'
      );

      sql := sql || ' union all ' || format(
        'select %L as source, sr.manager_hr_id as hr_id, count(*) as rows_count, null::text as sample_name
         from public.sales_records sr
         left join public.employees e on e.hr_id = sr.manager_hr_id
         where sr.manager_hr_id is not null and e.hr_id is null
         group by sr.manager_hr_id',
        'sales_records.manager_hr_id'
      );
    end if;

    if to_regclass('public.sales_targets') is not null then
      sql := sql || case when sql <> '' then ' union all ' else '' end || format(
        'select %L as source, st.employee_hr_id as hr_id, count(*) as rows_count, max(st.employee_name) as sample_name
         from public.sales_targets st
         left join public.employees e on e.hr_id = st.employee_hr_id
         where st.employee_hr_id is not null and e.hr_id is null
         group by st.employee_hr_id',
        'sales_targets.employee_hr_id'
      );

      sql := sql || ' union all ' || format(
        'select %L as source, st.manager_hr_id as hr_id, count(*) as rows_count, null::text as sample_name
         from public.sales_targets st
         left join public.employees e on e.hr_id = st.manager_hr_id
         where st.manager_hr_id is not null and e.hr_id is null
         group by st.manager_hr_id',
        'sales_targets.manager_hr_id'
      );
    end if;

    if sql = '' then
      sql := 'select null::text as source, null::text as hr_id, 0::bigint as rows_count, null::text as sample_name where false';
    end if;

    execute 'create or replace view public.v_hr_id_orphan_audit as ' || sql;
  else
    raise notice 'Skipping v_hr_id_orphan_audit creation in hr_id governance migration: public.employees does not exist yet.';
  end if;
end $$;

-- =====================================================
-- 2. Supporting indexes
-- =====================================================
do $$
begin
  if to_regclass('public.salary_records') is not null then
    execute 'create index if not exists idx_salary_records_hr_id on public.salary_records(hr_id)';
  end if;
  if to_regclass('public.salary_flags') is not null then
    execute 'create index if not exists idx_salary_flags_hr_id on public.salary_flags(hr_id)';
  end if;
  if to_regclass('public.payroll_expenses') is not null then
    execute 'create index if not exists idx_payroll_expenses_hr_id on public.payroll_expenses(hr_id)';
  end if;
  if to_regclass('public.sales_records') is not null then
    execute 'create index if not exists idx_sales_records_employee_hr_id_safe on public.sales_records(employee_hr_id)';
    execute 'create index if not exists idx_sales_records_manager_hr_id_safe on public.sales_records(manager_hr_id)';
  end if;
  if to_regclass('public.sales_targets') is not null then
    execute 'create index if not exists idx_sales_targets_employee_hr_id on public.sales_targets(employee_hr_id)';
    execute 'create index if not exists idx_sales_targets_manager_hr_id on public.sales_targets(manager_hr_id)';
  end if;
end $$;

-- =====================================================
-- 3. Add FK constraints safely only if data is clean and FK does not exist
-- =====================================================
do $$
begin
  if to_regclass('public.employees') is null or to_regclass('public.v_hr_id_orphan_audit') is null then
    raise notice 'Skipping HR_ID FK enforcement in hr_id governance migration: required relation(s) missing (employees/view).';
  else
    if to_regclass('public.salary_records') is not null then
      if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'salary_records.hr_id')
         and not exists (select 1 from pg_constraint where conname = 'salary_records_hr_id_fkey') then
        alter table public.salary_records
          add constraint salary_records_hr_id_fkey
          foreign key (hr_id) references public.employees(hr_id);
      end if;
    end if;

    if to_regclass('public.salary_flags') is not null then
      if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'salary_flags.hr_id')
         and not exists (select 1 from pg_constraint where conname = 'salary_flags_hr_id_fkey') then
        alter table public.salary_flags
          add constraint salary_flags_hr_id_fkey
          foreign key (hr_id) references public.employees(hr_id);
      end if;
    end if;

    if to_regclass('public.payroll_expenses') is not null then
      if not exists (select 1 from public.v_hr_id_orphan_audit where source = 'payroll_expenses.hr_id')
         and not exists (select 1 from pg_constraint where conname = 'payroll_expenses_hr_id_fkey') then
        alter table public.payroll_expenses
          add constraint payroll_expenses_hr_id_fkey
          foreign key (hr_id) references public.employees(hr_id);
      end if;
    end if;

    if to_regclass('public.sales_records') is not null then
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
    end if;

    if to_regclass('public.sales_targets') is not null then
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
    end if;
  end if;
end $$;
