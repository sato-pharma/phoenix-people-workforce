-- HR_ID Governance Safe Enforcement (post-bootstrap repair)
-- Re-runs ID governance enforcement for environments where step 0/1 were skipped
-- because public.employees was not yet available.

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
    raise notice 'Skipping repair insert for HR_ID placeholders: public.employees does not exist yet.';
  end if;
end $$;

-- Build the orphan audit view only from tables that exist in this environment.
do $$
declare
  v_sql text;
begin
  if to_regclass('public.employees') is not null then
    v_sql := '';

    if to_regclass('public.salary_records') is not null then
      v_sql := v_sql || E'select ''salary_records.hr_id'' as source, sr.hr_id as hr_id, count(*) as rows_count, max(sr.full_name) as sample_name\nfrom public.salary_records sr\nleft join public.employees e on e.hr_id = sr.hr_id\nwhere sr.hr_id is not null and e.hr_id is null\ngroup by sr.hr_id\nunion all\n';
    end if;

    if to_regclass('public.salary_flags') is not null then
      v_sql := v_sql || E'select ''salary_flags.hr_id'' as source, sf.hr_id as hr_id, count(*) as rows_count, null::text as sample_name\nfrom public.salary_flags sf\nleft join public.employees e on e.hr_id = sf.hr_id\nwhere sf.hr_id is not null and e.hr_id is null\ngroup by sf.hr_id\nunion all\n';
    end if;

    if to_regclass('public.payroll_expenses') is not null then
      v_sql := v_sql || E'select ''payroll_expenses.hr_id'' as source, pe.hr_id as hr_id, count(*) as rows_count, max(pe.specialist) as sample_name\nfrom public.payroll_expenses pe\nleft join public.employees e on e.hr_id = pe.hr_id\nwhere pe.hr_id is not null and e.hr_id is null\ngroup by pe.hr_id\nunion all\n';
    end if;

    if to_regclass('public.sales_records') is not null then
      v_sql := v_sql || E'select ''sales_records.employee_hr_id'' as source, sr.employee_hr_id as hr_id, count(*) as rows_count, max(sr.employee_name) as sample_name\nfrom public.sales_records sr\nleft join public.employees e on e.hr_id = sr.employee_hr_id\nwhere sr.employee_hr_id is not null and e.hr_id is null\ngroup by sr.employee_hr_id\nunion all\n';
      v_sql := v_sql || E'select ''sales_records.manager_hr_id'' as source, sr.manager_hr_id as hr_id, count(*) as rows_count, null::text as sample_name\nfrom public.sales_records sr\nleft join public.employees e on e.hr_id = sr.manager_hr_id\nwhere sr.manager_hr_id is not null and e.hr_id is null\ngroup by sr.manager_hr_id\nunion all\n';
    end if;

    if to_regclass('public.sales_targets') is not null then
      v_sql := v_sql || E'select ''sales_targets.employee_hr_id'' as source, st.employee_hr_id as hr_id, count(*) as rows_count, max(st.employee_name) as sample_name\nfrom public.sales_targets st\nleft join public.employees e on e.hr_id = st.employee_hr_id\nwhere st.employee_hr_id is not null and e.hr_id is null\ngroup by st.employee_hr_id\nunion all\n';
      v_sql := v_sql || E'select ''sales_targets.manager_hr_id'' as source, st.manager_hr_id as hr_id, count(*) as rows_count, null::text as sample_name\nfrom public.sales_targets st\nleft join public.employees e on e.hr_id = st.manager_hr_id\nwhere st.manager_hr_id is not null and e.hr_id is null\ngroup by st.manager_hr_id\nunion all\n';
    end if;

    if v_sql = '' then
      create or replace view public.v_hr_id_orphan_audit as
      select
        null::text as source,
        null::text as hr_id,
        0::bigint as rows_count,
        null::text as sample_name
      where false;
    else
      v_sql := left(v_sql, length(v_sql) - length('union all\n'));
      execute format('create or replace view public.v_hr_id_orphan_audit as %s', v_sql);
    end if;
  else
    raise notice 'Skipping orphan audit repair: public.employees does not exist yet.';
  end if;
end $$;

do $$
begin
  if to_regclass('public.salary_records') is not null then
    create index if not exists idx_salary_records_hr_id on public.salary_records(hr_id);
  end if;

  if to_regclass('public.salary_flags') is not null then
    create index if not exists idx_salary_flags_hr_id on public.salary_flags(hr_id);
  end if;

  if to_regclass('public.payroll_expenses') is not null then
    create index if not exists idx_payroll_expenses_hr_id on public.payroll_expenses(hr_id);
  end if;

  if to_regclass('public.sales_records') is not null then
    create index if not exists idx_sales_records_employee_hr_id_safe on public.sales_records(employee_hr_id);
    create index if not exists idx_sales_records_manager_hr_id_safe on public.sales_records(manager_hr_id);
  end if;

  if to_regclass('public.sales_targets') is not null then
    create index if not exists idx_sales_targets_employee_hr_id on public.sales_targets(employee_hr_id);
    create index if not exists idx_sales_targets_manager_hr_id on public.sales_targets(manager_hr_id);
  end if;
end $$;

-- Enforce FK constraints only for tables that exist and when orphan audit shows none.
do $$
begin
  if to_regclass('public.employees') is not null and to_regclass('public.v_hr_id_orphan_audit') is not null then
    if to_regclass('public.salary_records') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'salary_records.hr_id')
       and not exists (select 1 from pg_constraint where conname = 'salary_records_hr_id_fkey') then
      alter table public.salary_records
        add constraint salary_records_hr_id_fkey
        foreign key (hr_id) references public.employees(hr_id);
    end if;

    if to_regclass('public.salary_flags') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'salary_flags.hr_id')
       and not exists (select 1 from pg_constraint where conname = 'salary_flags_hr_id_fkey') then
      alter table public.salary_flags
        add constraint salary_flags_hr_id_fkey
        foreign key (hr_id) references public.employees(hr_id);
    end if;

    if to_regclass('public.payroll_expenses') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'payroll_expenses.hr_id')
       and not exists (select 1 from pg_constraint where conname = 'payroll_expenses_hr_id_fkey') then
      alter table public.payroll_expenses
        add constraint payroll_expenses_hr_id_fkey
        foreign key (hr_id) references public.employees(hr_id);
    end if;

    if to_regclass('public.sales_records') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_records.employee_hr_id')
       and not exists (select 1 from pg_constraint where conname = 'sales_records_employee_hr_id_fkey') then
      alter table public.sales_records
        add constraint sales_records_employee_hr_id_fkey
        foreign key (employee_hr_id) references public.employees(hr_id);
    end if;

    if to_regclass('public.sales_records') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_records.manager_hr_id')
       and not exists (select 1 from pg_constraint where conname = 'sales_records_manager_hr_id_fkey') then
      alter table public.sales_records
        add constraint sales_records_manager_hr_id_fkey
        foreign key (manager_hr_id) references public.employees(hr_id);
    end if;

    if to_regclass('public.sales_targets') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_targets.employee_hr_id')
       and not exists (select 1 from pg_constraint where conname = 'sales_targets_employee_hr_id_fkey') then
      alter table public.sales_targets
        add constraint sales_targets_employee_hr_id_fkey
        foreign key (employee_hr_id) references public.employees(hr_id);
    end if;

    if to_regclass('public.sales_targets') is not null
       and not exists (select 1 from public.v_hr_id_orphan_audit where source = 'sales_targets.manager_hr_id')
       and not exists (select 1 from pg_constraint where conname = 'sales_targets_manager_hr_id_fkey') then
      alter table public.sales_targets
        add constraint sales_targets_manager_hr_id_fkey
        foreign key (manager_hr_id) references public.employees(hr_id);
    end if;
  else
    raise notice 'Skipping HR_ID FK enforcement repair: required relation(s) missing (employees/view).';
  end if;
end $$;
