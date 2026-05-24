do $$
declare
  policy_row record;
begin
  for policy_row in
    select *
    from (
      values
        ('departments', 'departments_admin_read'),
        ('employees', 'employees_select_own_hr'),
        ('payroll_expenses', 'employee can see own expenses'),
        ('salary_batches', 'salary_batches_hr_admin_read'),
        ('salary_records', 'employee can see own salary'),
        ('sales_records', 'employee can see own sales'),
        ('user_access_profiles', 'uap_select_own')
    ) as t(table_name, policy_name)
  loop
    if exists (
      select 1
      from pg_tables
      where schemaname = 'public'
        and tablename = policy_row.table_name
    ) then
      execute format(
        'drop policy if exists %I on public.%I',
        policy_row.policy_name,
        policy_row.table_name
      );
    end if;
  end loop;
end $$;
