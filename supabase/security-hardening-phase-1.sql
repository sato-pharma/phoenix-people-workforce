-- Phoenix Workforce Security Hardening Phase 1 (RLS + function lockdown)
-- Target: lock down public access and reduce DB-side exposure.

create extension if not exists pgcrypto;

do $$
declare
  v_fn regprocedure;
begin
  select to_regprocedure('public.current_access_can_manage_employees()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_can_manage_employees() from anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_can_see_employee(text, text)') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_can_see_employee(text, text) from anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_hr_id()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_hr_id() from anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_is_admin()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_is_admin() from anon, authenticated;
  end if;

  select to_regprocedure('public.current_access_role()') into v_fn;
  if v_fn is not null then
    revoke execute on function public.current_access_role() from anon, authenticated;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.views
    where table_schema = 'public'
      and table_name = 'v_probation_tracker'
  ) then
    alter view public.v_probation_tracker set (security_barrier = true);
  end if;
end $$;

do $$
declare
  t text;
  p_name text;
  hardened_tables text[] := array[
    'departments',
    'lines',
    'areas',
    'teams',
    'positions',
    'employees',
    'employee_history',
    'employee_documents',
    'employee_compensation',
    'salary_batches',
    'salary_records',
    'salary_flags',
    'payroll_expense_reports',
    'payroll_expenses',
    'sales_import_batches',
    'sales_records',
    'sales_target_batches',
    'sales_targets',
    'sales_audit_logs',
    'job_offers',
    'job_offer_audit_logs',
    'roles',
    'permissions',
    'access_scopes',
    'user_roles',
    'app_auth_users',
    'users',
    'audit_logs',
    'user_access_profiles',
    'platform_settings',
    'notification_event_types',
    'notification_delivery_logs',
    'system_audit_logs',
    'payroll_expense_report'
  ];
begin
  foreach t in array hardened_tables
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I force row level security', t);

      p_name := 'phx_' || t || '_service_role';
      execute format('drop policy if exists %I on public.%I', p_name, t);
      execute format(
        'create policy %I on public.%I for all to public using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
        p_name,
        t
      );

      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- Legacy policies from the dynamic-permissions draft are intentionally replaced
-- by service-role only access during Phase 1 hardening.
do $$
begin
  drop policy if exists user_access_profiles_read_self_or_admin on public.user_access_profiles;
  drop policy if exists user_access_profiles_admin_write on public.user_access_profiles;
  drop policy if exists employees_dynamic_read on public.employees;
  drop policy if exists employees_hr_admin_write on public.employees;
  drop policy if exists employee_compensation_dynamic_read on public.employee_compensation;
  drop policy if exists employee_compensation_hr_admin_write on public.employee_compensation;
  drop policy if exists salary_records_dynamic_read on public.salary_records;
  drop policy if exists salary_records_hr_admin_write on public.salary_records;
  drop policy if exists salary_batches_hr_admin_read on public.salary_batches;
  drop policy if exists salary_batches_hr_admin_write on public.salary_batches;
  drop policy if exists payroll_expenses_dynamic_read on public.payroll_expenses;
  drop policy if exists payroll_expenses_hr_admin_write on public.payroll_expenses;
  drop policy if exists sales_records_dynamic_read on public.sales_records;
  drop policy if exists sales_records_hr_admin_write on public.sales_records;
end $$;

notify pgrst, 'reload schema';
