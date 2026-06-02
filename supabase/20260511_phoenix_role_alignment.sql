-- Phoenix Workforce role alignment.
-- Keeps phoenix_role as the enterprise role source of truth and replaces
-- legacy admin/hr role checks with explicit helper functions where policies
-- expose sensitive employee, payroll, sales, or access-profile data.

begin;

alter table if exists public.user_access_profiles
  add column if not exists phoenix_role text;

alter table if exists public.user_access_profiles
  add column if not exists scope_type text;

alter table if exists public.user_access_profiles
  drop constraint if exists user_access_profiles_role_check;

alter table if exists public.user_access_profiles
  add constraint user_access_profiles_role_check
  check (
    role in (
      'employee',
      'manager',
      'hr',
      'finance',
      'company_reader',
      'super_admin',
      'admin'
    )
  );

alter table if exists public.user_access_profiles
  drop constraint if exists user_access_profiles_phoenix_role_check;

alter table if exists public.user_access_profiles
  add constraint user_access_profiles_phoenix_role_check
  check (
    phoenix_role is null
    or phoenix_role in (
      'Employee',
      'Medical Rep',
      'District Manager',
      'Regional Manager',
      'National Sales Manager',
      'Product Manager',
      'Group Product Manager',
      'SFE Manager',
      'Training Manager',
      'Marketing Manager',
      'Finance Manager',
      'HR Specialist',
      'Manager',
      'CEO',
      'Super Admin'
    )
  );

alter table if exists public.user_access_profiles
  drop constraint if exists user_access_profiles_scope_type_check;

alter table if exists public.user_access_profiles
  add constraint user_access_profiles_scope_type_check
  check (
    scope_type is null
    or scope_type in (
      'SELF',
      'TEAM',
      'HIERARCHY',
      'LINE',
      'COMPANY_READ',
      'FINANCE',
      'HR',
      'SUPER_ADMIN'
    )
  );

do $$
begin
  if to_regclass('public.user_access_profiles') is not null
    and to_regclass('public.app_auth_users') is not null then
    update public.user_access_profiles uap
    set phoenix_role = coalesce(uap.phoenix_role, aau.role)
    from public.app_auth_users aau
    where aau.login_id = uap.login_id
      and uap.phoenix_role is null;
  end if;
end $$;

update public.user_access_profiles
set phoenix_role = case role
  when 'admin' then 'Super Admin'
  when 'super_admin' then 'Super Admin'
  when 'company_reader' then 'CEO'
  when 'finance' then 'Finance Manager'
  when 'hr' then 'HR Specialist'
  when 'manager' then 'Manager'
  else 'Employee'
end
where phoenix_role is null;

update public.user_access_profiles
set
  role = case phoenix_role
    when 'Super Admin' then 'super_admin'
    when 'CEO' then 'company_reader'
    when 'Finance Manager' then 'finance'
    when 'HR Specialist' then 'hr'
    when 'SFE Manager' then 'company_reader'
    when 'District Manager' then 'manager'
    when 'Regional Manager' then 'manager'
    when 'National Sales Manager' then 'manager'
    when 'Product Manager' then 'manager'
    when 'Group Product Manager' then 'manager'
    when 'Training Manager' then 'manager'
    when 'Marketing Manager' then 'manager'
    when 'Manager' then 'manager'
    else 'employee'
  end,
  scope_type = case phoenix_role
    when 'Super Admin' then 'SUPER_ADMIN'
    when 'CEO' then 'COMPANY_READ'
    when 'SFE Manager' then 'COMPANY_READ'
    when 'Finance Manager' then 'FINANCE'
    when 'HR Specialist' then 'HR'
    when 'District Manager' then 'TEAM'
    when 'Manager' then 'TEAM'
    when 'Regional Manager' then 'HIERARCHY'
    when 'National Sales Manager' then 'LINE'
    when 'Product Manager' then 'LINE'
    when 'Group Product Manager' then 'LINE'
    when 'Training Manager' then 'LINE'
    when 'Marketing Manager' then 'LINE'
    else 'SELF'
  end
where phoenix_role is not null;

create or replace function public.current_phoenix_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uap.phoenix_role
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.role
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    ),
    'Employee'
  );
$$;

create or replace function public.current_access_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uap.role
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    case public.current_phoenix_role()
      when 'Super Admin' then 'super_admin'
      when 'CEO' then 'company_reader'
      when 'SFE Manager' then 'company_reader'
      when 'Finance Manager' then 'finance'
      when 'HR Specialist' then 'hr'
      when 'District Manager' then 'manager'
      when 'Regional Manager' then 'manager'
      when 'National Sales Manager' then 'manager'
      when 'Product Manager' then 'manager'
      when 'Group Product Manager' then 'manager'
      when 'Training Manager' then 'manager'
      when 'Marketing Manager' then 'manager'
      when 'Manager' then 'manager'
      else 'employee'
    end
  );
$$;

create or replace function public.current_access_scope()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uap.scope_type
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    case public.current_phoenix_role()
      when 'Super Admin' then 'SUPER_ADMIN'
      when 'CEO' then 'COMPANY_READ'
      when 'SFE Manager' then 'COMPANY_READ'
      when 'Finance Manager' then 'FINANCE'
      when 'HR Specialist' then 'HR'
      when 'District Manager' then 'TEAM'
      when 'Manager' then 'TEAM'
      when 'Regional Manager' then 'HIERARCHY'
      when 'National Sales Manager' then 'LINE'
      when 'Product Manager' then 'LINE'
      when 'Group Product Manager' then 'LINE'
      when 'Training Manager' then 'LINE'
      when 'Marketing Manager' then 'LINE'
      else 'SELF'
    end
  );
$$;

create or replace function public.current_access_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_phoenix_role() = 'Super Admin';
$$;

create or replace function public.current_access_is_hr()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_phoenix_role() = 'HR Specialist';
$$;

create or replace function public.current_access_is_finance()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_phoenix_role() = 'Finance Manager';
$$;

create or replace function public.current_access_is_company_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_phoenix_role() in ('CEO', 'SFE Manager', 'Super Admin');
$$;

create or replace function public.current_access_can_manage_employees()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_phoenix_role() in ('HR Specialist', 'Super Admin');
$$;

create or replace function public.current_access_can_manage_payroll()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_phoenix_role() in ('Finance Manager', 'HR Specialist', 'Super Admin');
$$;

create or replace function public.current_access_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_access_is_super_admin();
$$;

create or replace function public.current_access_can_see_employee(employee_hr_id text, employee_manager_hr_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.current_access_can_manage_employees()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    or (
      public.current_access_scope() in ('TEAM', 'HIERARCHY')
      and lower(coalesce(employee_manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    );
$$;

revoke all on function public.current_phoenix_role() from public, anon;
revoke all on function public.current_access_role() from public, anon;
revoke all on function public.current_access_scope() from public, anon;
revoke all on function public.current_access_is_super_admin() from public, anon;
revoke all on function public.current_access_is_hr() from public, anon;
revoke all on function public.current_access_is_finance() from public, anon;
revoke all on function public.current_access_is_company_reader() from public, anon;
revoke all on function public.current_access_can_manage_employees() from public, anon;
revoke all on function public.current_access_can_manage_payroll() from public, anon;
revoke all on function public.current_access_is_admin() from public, anon;
revoke all on function public.current_access_can_see_employee(text, text) from public, anon;

grant execute on function public.current_phoenix_role() to authenticated, service_role;
grant execute on function public.current_access_role() to authenticated, service_role;
grant execute on function public.current_access_scope() to authenticated, service_role;
grant execute on function public.current_access_is_super_admin() to authenticated, service_role;
grant execute on function public.current_access_is_hr() to authenticated, service_role;
grant execute on function public.current_access_is_finance() to authenticated, service_role;
grant execute on function public.current_access_is_company_reader() to authenticated, service_role;
grant execute on function public.current_access_can_manage_employees() to authenticated, service_role;
grant execute on function public.current_access_can_manage_payroll() to authenticated, service_role;
grant execute on function public.current_access_is_admin() to authenticated, service_role;
grant execute on function public.current_access_can_see_employee(text, text) to authenticated, service_role;

do $$
declare
  v_fn regprocedure;
begin
  select to_regprocedure('public.current_access_hr_id()') into v_fn;
  if v_fn is not null then
    revoke all on function public.current_access_hr_id() from public, anon;
    grant execute on function public.current_access_hr_id() to authenticated, service_role;
  end if;

  select to_regprocedure('public.current_access_manager_hr_id()') into v_fn;
  if v_fn is not null then
    revoke all on function public.current_access_manager_hr_id() from public, anon;
    grant execute on function public.current_access_manager_hr_id() to authenticated, service_role;
  end if;

  select to_regprocedure('public.current_access_line()') into v_fn;
  if v_fn is not null then
    revoke all on function public.current_access_line() from public, anon;
    grant execute on function public.current_access_line() to authenticated, service_role;
  end if;
end $$;

do $$
begin
  if to_regclass('public.user_access_profiles') is not null then
    execute 'alter table public.user_access_profiles enable row level security';
    execute 'revoke all on table public.user_access_profiles from anon';
    execute 'grant insert, update, delete on table public.user_access_profiles to authenticated';

    execute 'drop policy if exists user_access_profiles_admin_write on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_admin_insert on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_update_self_or_admin on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_admin_delete on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_read_self_or_admin on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_read_self_or_super_admin on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_super_admin_insert on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_update_self_or_super_admin on public.user_access_profiles';
    execute 'drop policy if exists user_access_profiles_super_admin_delete on public.user_access_profiles';

    execute $policy$
      create policy user_access_profiles_read_self_or_super_admin
      on public.user_access_profiles
      for select
      to authenticated
      using (
        auth_user_id = (select auth.uid())
        or public.current_access_is_super_admin()
      )
    $policy$;

    execute $policy$
      create policy user_access_profiles_super_admin_insert
      on public.user_access_profiles
      for insert
      to authenticated
      with check (public.current_access_is_super_admin())
    $policy$;

    execute $policy$
      create policy user_access_profiles_update_self_or_super_admin
      on public.user_access_profiles
      for update
      to authenticated
      using (public.current_access_is_super_admin())
      with check (public.current_access_is_super_admin())
    $policy$;

    execute $policy$
      create policy user_access_profiles_super_admin_delete
      on public.user_access_profiles
      for delete
      to authenticated
      using (public.current_access_is_super_admin())
    $policy$;
  end if;

  if to_regclass('public.employees') is not null then
    execute 'alter table public.employees enable row level security';
    execute 'revoke all on table public.employees from anon';
    execute 'grant insert, update, delete on table public.employees to authenticated';

    execute 'drop policy if exists employees_hr_admin_write on public.employees';
    execute 'drop policy if exists employees_insert_self_or_admin on public.employees';
    execute 'drop policy if exists employees_update_self_or_admin on public.employees';
    execute 'drop policy if exists employees_delete_self_or_admin on public.employees';

    execute 'drop policy if exists employees_insert_self_or_hr on public.employees';
    execute 'drop policy if exists employees_update_self_or_hr on public.employees';
    execute 'drop policy if exists employees_delete_hr on public.employees';
    execute 'drop policy if exists employees_insert_hr on public.employees';
    execute 'drop policy if exists employees_update_hr on public.employees';

    execute $policy$
      create policy employees_insert_hr
      on public.employees
      for insert
      to authenticated
      with check (public.current_access_can_manage_employees())
    $policy$;

    execute $policy$
      create policy employees_update_hr
      on public.employees
      for update
      to authenticated
      using (public.current_access_can_manage_employees())
      with check (public.current_access_can_manage_employees())
    $policy$;

    execute $policy$
      create policy employees_delete_hr
      on public.employees
      for delete
      to authenticated
      using (public.current_access_can_manage_employees())
    $policy$;
  end if;

  if to_regclass('public.employee_compensation') is not null then
    execute 'drop policy if exists employee_compensation_select_access on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_dynamic_read on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_hr_admin_write on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_admin_insert on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_admin_update on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_admin_delete on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_payroll_insert on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_payroll_update on public.employee_compensation';
    execute 'drop policy if exists employee_compensation_payroll_delete on public.employee_compensation';

    execute $policy$
      create policy employee_compensation_select_access
      on public.employee_compensation
      for select
      to authenticated
      using (
        public.current_access_can_manage_payroll()
        or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      )
    $policy$;

    execute $policy$
      create policy employee_compensation_payroll_insert
      on public.employee_compensation
      for insert
      to authenticated
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy employee_compensation_payroll_update
      on public.employee_compensation
      for update
      to authenticated
      using (public.current_access_can_manage_payroll())
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy employee_compensation_payroll_delete
      on public.employee_compensation
      for delete
      to authenticated
      using (public.current_access_can_manage_payroll())
    $policy$;
  end if;

  if to_regclass('public.salary_records') is not null then
    execute 'drop policy if exists salary_records_select_access on public.salary_records';
    execute 'drop policy if exists salary_records_dynamic_read on public.salary_records';
    execute 'drop policy if exists salary_records_hr_admin_write on public.salary_records';
    execute 'drop policy if exists salary_records_admin_insert on public.salary_records';
    execute 'drop policy if exists salary_records_admin_update on public.salary_records';
    execute 'drop policy if exists salary_records_admin_delete on public.salary_records';
    execute 'drop policy if exists salary_records_payroll_insert on public.salary_records';
    execute 'drop policy if exists salary_records_payroll_update on public.salary_records';
    execute 'drop policy if exists salary_records_payroll_delete on public.salary_records';

    execute $policy$
      create policy salary_records_select_access
      on public.salary_records
      for select
      to authenticated
      using (
        public.current_access_can_manage_payroll()
        or lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      )
    $policy$;

    execute $policy$
      create policy salary_records_payroll_insert
      on public.salary_records
      for insert
      to authenticated
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy salary_records_payroll_update
      on public.salary_records
      for update
      to authenticated
      using (public.current_access_can_manage_payroll())
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy salary_records_payroll_delete
      on public.salary_records
      for delete
      to authenticated
      using (public.current_access_can_manage_payroll())
    $policy$;
  end if;

  if to_regclass('public.salary_batches') is not null then
    execute 'drop policy if exists salary_batches_select_access on public.salary_batches';
    execute 'drop policy if exists salary_batches_dynamic_read on public.salary_batches';
    execute 'drop policy if exists salary_batches_hr_admin_write on public.salary_batches';
    execute 'drop policy if exists salary_batches_admin_insert on public.salary_batches';
    execute 'drop policy if exists salary_batches_admin_update on public.salary_batches';
    execute 'drop policy if exists salary_batches_admin_delete on public.salary_batches';
    execute 'drop policy if exists salary_batches_payroll_insert on public.salary_batches';
    execute 'drop policy if exists salary_batches_payroll_update on public.salary_batches';
    execute 'drop policy if exists salary_batches_payroll_delete on public.salary_batches';

    execute $policy$
      create policy salary_batches_select_access
      on public.salary_batches
      for select
      to authenticated
      using (
        public.current_access_can_manage_payroll()
        or exists (
          select 1
          from public.salary_records sr
          where sr.batch_id = salary_batches.id
            and (
              lower(coalesce(sr.hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
              or exists (
                select 1
                from public.employees e
                where lower(coalesce(e.hr_id, '')) = lower(coalesce(sr.hr_id, ''))
                  and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
              )
            )
        )
      )
    $policy$;

    execute $policy$
      create policy salary_batches_payroll_insert
      on public.salary_batches
      for insert
      to authenticated
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy salary_batches_payroll_update
      on public.salary_batches
      for update
      to authenticated
      using (public.current_access_can_manage_payroll())
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy salary_batches_payroll_delete
      on public.salary_batches
      for delete
      to authenticated
      using (public.current_access_can_manage_payroll())
    $policy$;
  end if;

  if to_regclass('public.salary_flags') is not null then
    execute 'drop policy if exists salary_flags_select_access on public.salary_flags';
    execute 'drop policy if exists salary_flags_dynamic_read on public.salary_flags';
    execute 'drop policy if exists salary_flags_hr_admin_write on public.salary_flags';
    execute 'drop policy if exists salary_flags_admin_insert on public.salary_flags';
    execute 'drop policy if exists salary_flags_admin_update on public.salary_flags';
    execute 'drop policy if exists salary_flags_admin_delete on public.salary_flags';
    execute 'drop policy if exists salary_flags_payroll_insert on public.salary_flags';
    execute 'drop policy if exists salary_flags_payroll_update on public.salary_flags';
    execute 'drop policy if exists salary_flags_payroll_delete on public.salary_flags';

    execute $policy$
      create policy salary_flags_select_access
      on public.salary_flags
      for select
      to authenticated
      using (
        public.current_access_can_manage_payroll()
        or lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      )
    $policy$;

    execute $policy$
      create policy salary_flags_payroll_insert
      on public.salary_flags
      for insert
      to authenticated
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy salary_flags_payroll_update
      on public.salary_flags
      for update
      to authenticated
      using (public.current_access_can_manage_payroll())
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy salary_flags_payroll_delete
      on public.salary_flags
      for delete
      to authenticated
      using (public.current_access_can_manage_payroll())
    $policy$;
  end if;

  if to_regclass('public.payroll_expenses') is not null then
    execute 'alter table public.payroll_expenses enable row level security';
    execute 'revoke all on table public.payroll_expenses from anon';
    execute 'grant insert, update, delete on table public.payroll_expenses to authenticated';

    execute 'drop policy if exists payroll_expenses_select_access on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_dynamic_read on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_hr_admin_write on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_admin_insert on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_admin_update on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_admin_delete on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_scoped_insert on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_scoped_update on public.payroll_expenses';
    execute 'drop policy if exists payroll_expenses_scoped_delete on public.payroll_expenses';

    execute $policy$
      create policy payroll_expenses_select_access
      on public.payroll_expenses
      for select
      to authenticated
      using (
        public.current_access_can_manage_payroll()
        or lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        or exists (
          select 1
          from public.employees e
          where lower(e.hr_id) = lower(payroll_expenses.hr_id)
            and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
        )
      )
    $policy$;

    execute $policy$
      create policy payroll_expenses_scoped_insert
      on public.payroll_expenses
      for insert
      to authenticated
      with check (
        public.current_access_can_manage_payroll()
        or (
          public.current_phoenix_role() in ('Employee', 'Medical Rep')
          and lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        )
      )
    $policy$;

    execute $policy$
      create policy payroll_expenses_scoped_update
      on public.payroll_expenses
      for update
      to authenticated
      using (public.current_access_can_manage_payroll())
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy payroll_expenses_scoped_delete
      on public.payroll_expenses
      for delete
      to authenticated
      using (public.current_access_can_manage_payroll())
    $policy$;
  end if;

  if to_regclass('public.payroll_expense_reports') is not null then
    execute 'alter table public.payroll_expense_reports enable row level security';
    execute 'revoke all on table public.payroll_expense_reports from anon';
    execute 'grant insert, update, delete on table public.payroll_expense_reports to authenticated';

    execute 'drop policy if exists payroll_expense_reports_select_access on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_dynamic_read on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_hr_admin_write on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_admin_insert on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_admin_update on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_admin_delete on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_scoped_insert on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_scoped_update on public.payroll_expense_reports';
    execute 'drop policy if exists payroll_expense_reports_scoped_delete on public.payroll_expense_reports';

    execute $policy$
      create policy payroll_expense_reports_select_access
      on public.payroll_expense_reports
      for select
      to authenticated
      using (
        public.current_access_can_manage_payroll()
        or exists (
          select 1
          from public.payroll_expenses pe
          where pe.report_id = payroll_expense_reports.id
            and (
              lower(coalesce(pe.hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
              or exists (
                select 1
                from public.employees e
                where lower(coalesce(e.hr_id, '')) = lower(coalesce(pe.hr_id, ''))
                  and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
              )
            )
        )
      )
    $policy$;

    execute $policy$
      create policy payroll_expense_reports_scoped_insert
      on public.payroll_expense_reports
      for insert
      to authenticated
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy payroll_expense_reports_scoped_update
      on public.payroll_expense_reports
      for update
      to authenticated
      using (public.current_access_can_manage_payroll())
      with check (public.current_access_can_manage_payroll())
    $policy$;

    execute $policy$
      create policy payroll_expense_reports_scoped_delete
      on public.payroll_expense_reports
      for delete
      to authenticated
      using (public.current_access_can_manage_payroll())
    $policy$;
  end if;

  if to_regclass('public.sales_records') is not null then
    execute 'alter table public.sales_records enable row level security';
    execute 'revoke all on table public.sales_records from anon';
    execute 'grant select on table public.sales_records to authenticated';

    execute 'drop policy if exists sales_records_select_access on public.sales_records';
    execute 'drop policy if exists sales_records_dynamic_read on public.sales_records';
    execute 'drop policy if exists sales_records_hr_admin_write on public.sales_records';
    execute 'drop policy if exists sales_records_admin_insert on public.sales_records';
    execute 'drop policy if exists sales_records_admin_update on public.sales_records';
    execute 'drop policy if exists sales_records_admin_delete on public.sales_records';
    execute 'drop policy if exists sales_records_hr_admin_insert on public.sales_records';
    execute 'drop policy if exists sales_records_hr_admin_update on public.sales_records';
    execute 'drop policy if exists sales_records_hr_admin_delete on public.sales_records';
    execute 'drop policy if exists sales_records_hr_insert on public.sales_records';
    execute 'drop policy if exists sales_records_hr_update on public.sales_records';
    execute 'drop policy if exists sales_records_hr_delete on public.sales_records';

    execute $policy$
      create policy sales_records_select_access
      on public.sales_records
      for select
      to authenticated
      using (
        public.current_access_is_super_admin()
        or public.current_access_is_company_reader()
        or public.current_access_is_hr()
        or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
        or lower(coalesce(manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      )
    $policy$;

    execute $policy$
      create policy sales_records_hr_insert
      on public.sales_records
      for insert
      to authenticated
      with check (
        public.current_access_is_super_admin()
        or public.current_access_is_hr()
      )
    $policy$;

    execute $policy$
      create policy sales_records_hr_update
      on public.sales_records
      for update
      to authenticated
      using (
        public.current_access_is_super_admin()
        or public.current_access_is_hr()
      )
      with check (
        public.current_access_is_super_admin()
        or public.current_access_is_hr()
      )
    $policy$;

    execute $policy$
      create policy sales_records_hr_delete
      on public.sales_records
      for delete
      to authenticated
      using (
        public.current_access_is_super_admin()
        or public.current_access_is_hr()
      )
    $policy$;
  end if;
end $$;

commit;
