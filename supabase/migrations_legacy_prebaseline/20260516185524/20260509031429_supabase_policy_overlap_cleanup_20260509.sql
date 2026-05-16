do $$
begin
  if to_regclass('public.departments') is not null then
    execute 'drop policy if exists departments_admin_read on public.departments';
  end if;

  if to_regclass('public.employees') is not null then
    execute 'drop policy if exists employees_select_own_hr on public.employees';
  end if;

  if to_regclass('public.payroll_expenses') is not null then
    execute 'drop policy if exists "employee can see own expenses" on public.payroll_expenses';
  end if;

  if to_regclass('public.salary_batches') is not null then
    execute 'drop policy if exists salary_batches_hr_admin_read on public.salary_batches';
  end if;

  if to_regclass('public.salary_records') is not null then
    execute 'drop policy if exists "employee can see own salary" on public.salary_records';
  end if;

  if to_regclass('public.sales_records') is not null then
    execute 'drop policy if exists "employee can see own sales" on public.sales_records';
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    execute 'drop policy if exists uap_select_own on public.user_access_profiles';
  end if;
end $$;
