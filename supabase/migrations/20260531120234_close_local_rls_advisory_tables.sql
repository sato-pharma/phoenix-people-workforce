-- Close the local Supabase rls_disabled advisory for core Phoenix tables.
-- This is intentionally policy-based: RLS is enabled with explicit service-role
-- access everywhere, and authenticated access is scoped to the existing Phoenix
-- employee, payroll, and outstation access model.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter table if exists public.user_access_profiles
  add column if not exists phoenix_role text,
  add column if not exists scope_type text;

alter table if exists public.app_auth_users
  add column if not exists auth_user_id uuid references auth.users(id) on update cascade on delete set null;

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
      'DEPARTMENT',
      'COMPANY_READ',
      'FINANCE',
      'HR',
      'SUPER_ADMIN'
    )
  );

create or replace function private.phx_current_hr_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select uap.hr_id
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.hr_id
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    )
  );
$$;

create or replace function private.phx_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select coalesce(
        uap.phoenix_role,
        case uap.role
          when 'super_admin' then 'Super Admin'
          when 'admin' then 'Super Admin'
          when 'company_reader' then 'CEO'
          when 'finance' then 'Finance Manager'
          when 'hr' then 'HR Specialist'
          when 'manager' then 'Manager'
          else 'Employee'
        end
      )
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

create or replace function private.phx_current_scope()
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
    case private.phx_current_role()
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

create or replace function private.phx_has_company_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in ('Super Admin', 'CEO', 'SFE Manager', 'HR Specialist')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'COMPANY_READ', 'HR');
$$;

create or replace function private.phx_can_manage_workforce()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in ('Super Admin', 'HR Specialist')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'HR');
$$;

create or replace function private.phx_can_manage_payroll()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in ('Super Admin', 'HR Specialist', 'Finance Manager')
    or private.phx_current_scope() in ('SUPER_ADMIN', 'HR', 'FINANCE');
$$;

create or replace function private.phx_can_manage_outstation()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.phx_current_role() in (
    'Super Admin',
    'HR Specialist',
    'Finance Manager',
    'District Manager',
    'Regional Manager',
    'National Sales Manager',
    'Manager'
  );
$$;

create or replace function private.phx_can_access_employee(target_hr_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with actor as (
    select e.hr_id, e.line_id, e.department_id
    from public.employees e
    where lower(e.hr_id) = lower(coalesce(private.phx_current_hr_id(), ''))
    limit 1
  ),
  target as (
    select e.hr_id, e.manager_hr_id, e.line_id, e.department_id, e.employment_status
    from public.employees e
    where lower(e.hr_id) = lower(coalesce(target_hr_id, ''))
    limit 1
  ),
  access_base as (
    select
      private.phx_has_company_access()
      or lower(coalesce(target_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      or exists (
        select 1
        from target
        where private.phx_current_scope() in ('TEAM', 'HIERARCHY')
          and lower(coalesce(target.manager_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      )
      or exists (
        select 1
        from actor
        join target on true
        where private.phx_current_scope() in ('LINE', 'HIERARCHY')
          and actor.line_id is not null
          and actor.line_id = target.line_id
      )
      or exists (
        select 1
        from actor
        join target on true
        where private.phx_current_scope() in ('DEPARTMENT', 'HR', 'SUPER_ADMIN')
          and actor.department_id is not null
          and actor.department_id = target.department_id
      ) as can_access
  )
  select coalesce(can_access, false)
    and (
      not exists (
        select 1
        from target
        where lower(coalesce(target.employment_status, 'active')) in ('resigned', 'terminated', 'inactive', 'left')
      )
      or private.phx_current_role() in ('Super Admin', 'HR Specialist', 'Finance Manager')
      or lower(coalesce(target_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
    )
  from access_base;
$$;

grant execute on function private.phx_current_hr_id() to authenticated, service_role;
grant execute on function private.phx_current_role() to authenticated, service_role;
grant execute on function private.phx_current_scope() to authenticated, service_role;
grant execute on function private.phx_has_company_access() to authenticated, service_role;
grant execute on function private.phx_can_manage_workforce() to authenticated, service_role;
grant execute on function private.phx_can_manage_payroll() to authenticated, service_role;
grant execute on function private.phx_can_manage_outstation() to authenticated, service_role;
grant execute on function private.phx_can_access_employee(text) to authenticated, service_role;

do $$
declare
  v_table text;
  v_policy record;
  v_tables text[] := array[
    'auth_login_attempts',
    'employee_compensation',
    'employee_locations',
    'employees',
    'messages',
    'outstation_expense_requests',
    'outstation_location_audit_logs',
    'outstation_policy_rules',
    'payroll_expense_reports',
    'payroll_expenses',
    'payroll_workflow_transitions',
    'salary_batches',
    'salary_flags',
    'salary_records',
    'user_access_profiles'
  ];
begin
  foreach v_table in array v_tables
  loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format('alter table public.%I enable row level security', v_table);
      execute format('revoke all on table public.%I from anon', v_table);
      execute format('grant all on table public.%I to service_role', v_table);

      for v_policy in
        select policyname
        from pg_policies
        where schemaname = 'public'
          and tablename = v_table
      loop
        execute format('drop policy if exists %I on public.%I', v_policy.policyname, v_table);
      end loop;

      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        v_table || '_service_role_all',
        v_table
      );
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.auth_login_attempts') is not null then
    revoke all on table public.auth_login_attempts from authenticated;
  end if;

  if to_regclass('public.messages') is not null then
    revoke all on table public.messages from authenticated;
  end if;
end $$;

grant select, insert, update, delete on table public.user_access_profiles to authenticated;
grant select, insert, update, delete on table public.employees to authenticated;
grant select, insert, update, delete on table public.employee_compensation to authenticated;
grant select, insert, update, delete on table public.salary_records to authenticated;
grant select, insert, update, delete on table public.salary_batches to authenticated;
grant select, insert, update, delete on table public.salary_flags to authenticated;
grant select, insert, update, delete on table public.payroll_expenses to authenticated;
grant select, insert, update, delete on table public.payroll_expense_reports to authenticated;
grant select, insert, update, delete on table public.employee_locations to authenticated;
grant select, insert, update, delete on table public.outstation_expense_requests to authenticated;
grant select, insert, update, delete on table public.outstation_location_audit_logs to authenticated;
grant select on table public.outstation_policy_rules to authenticated;
grant select on table public.payroll_workflow_transitions to authenticated;

drop policy if exists user_access_profiles_select_self_or_super_admin on public.user_access_profiles;
create policy user_access_profiles_select_self_or_super_admin
  on public.user_access_profiles
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()) or private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists user_access_profiles_insert_super_admin on public.user_access_profiles;
create policy user_access_profiles_insert_super_admin
  on public.user_access_profiles
  for insert
  to authenticated
  with check (private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists user_access_profiles_update_super_admin on public.user_access_profiles;
create policy user_access_profiles_update_super_admin
  on public.user_access_profiles
  for update
  to authenticated
  using (private.phx_current_scope() = 'SUPER_ADMIN')
  with check (private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists user_access_profiles_delete_super_admin on public.user_access_profiles;
create policy user_access_profiles_delete_super_admin
  on public.user_access_profiles
  for delete
  to authenticated
  using (private.phx_current_scope() = 'SUPER_ADMIN');

drop policy if exists employees_select_access on public.employees;
create policy employees_select_access
  on public.employees
  for select
  to authenticated
  using (private.phx_can_access_employee(hr_id));

drop policy if exists employees_insert_hr on public.employees;
create policy employees_insert_hr
  on public.employees
  for insert
  to authenticated
  with check (private.phx_can_manage_workforce());

drop policy if exists employees_update_hr on public.employees;
create policy employees_update_hr
  on public.employees
  for update
  to authenticated
  using (private.phx_can_manage_workforce())
  with check (private.phx_can_manage_workforce());

drop policy if exists employees_delete_hr on public.employees;
create policy employees_delete_hr
  on public.employees
  for delete
  to authenticated
  using (private.phx_can_manage_workforce());

drop policy if exists employee_compensation_select_access on public.employee_compensation;
create policy employee_compensation_select_access
  on public.employee_compensation
  for select
  to authenticated
  using (
    private.phx_can_manage_payroll()
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists employee_compensation_insert_payroll on public.employee_compensation;
create policy employee_compensation_insert_payroll
  on public.employee_compensation
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists employee_compensation_update_payroll on public.employee_compensation;
create policy employee_compensation_update_payroll
  on public.employee_compensation
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists employee_compensation_delete_payroll on public.employee_compensation;
create policy employee_compensation_delete_payroll
  on public.employee_compensation
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists salary_records_select_access on public.salary_records;
create policy salary_records_select_access
  on public.salary_records
  for select
  to authenticated
  using (
    private.phx_can_manage_payroll()
    or private.phx_can_access_employee(hr_id)
  );

drop policy if exists salary_records_insert_payroll on public.salary_records;
create policy salary_records_insert_payroll
  on public.salary_records
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_records_update_payroll on public.salary_records;
create policy salary_records_update_payroll
  on public.salary_records
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_records_delete_payroll on public.salary_records;
create policy salary_records_delete_payroll
  on public.salary_records
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists salary_batches_select_access on public.salary_batches;
create policy salary_batches_select_access
  on public.salary_batches
  for select
  to authenticated
  using (
    private.phx_can_manage_payroll()
    or exists (
      select 1
      from public.salary_records sr
      where sr.batch_id = salary_batches.id
        and private.phx_can_access_employee(sr.hr_id)
    )
  );

drop policy if exists salary_batches_insert_payroll on public.salary_batches;
create policy salary_batches_insert_payroll
  on public.salary_batches
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_batches_update_payroll on public.salary_batches;
create policy salary_batches_update_payroll
  on public.salary_batches
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_batches_delete_payroll on public.salary_batches;
create policy salary_batches_delete_payroll
  on public.salary_batches
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists salary_flags_select_access on public.salary_flags;
create policy salary_flags_select_access
  on public.salary_flags
  for select
  to authenticated
  using (
    private.phx_can_manage_payroll()
    or private.phx_can_access_employee(hr_id)
  );

drop policy if exists salary_flags_insert_payroll on public.salary_flags;
create policy salary_flags_insert_payroll
  on public.salary_flags
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_flags_update_payroll on public.salary_flags;
create policy salary_flags_update_payroll
  on public.salary_flags
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists salary_flags_delete_payroll on public.salary_flags;
create policy salary_flags_delete_payroll
  on public.salary_flags
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists payroll_expenses_select_access on public.payroll_expenses;
create policy payroll_expenses_select_access
  on public.payroll_expenses
  for select
  to authenticated
  using (
    private.phx_can_manage_payroll()
    or private.phx_can_access_employee(hr_id)
  );

drop policy if exists payroll_expenses_insert_access on public.payroll_expenses;
create policy payroll_expenses_insert_access
  on public.payroll_expenses
  for insert
  to authenticated
  with check (
    private.phx_can_manage_payroll()
    or lower(coalesce(hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists payroll_expenses_update_access on public.payroll_expenses;
create policy payroll_expenses_update_access
  on public.payroll_expenses
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists payroll_expenses_delete_access on public.payroll_expenses;
create policy payroll_expenses_delete_access
  on public.payroll_expenses
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists payroll_expense_reports_select_access on public.payroll_expense_reports;
create policy payroll_expense_reports_select_access
  on public.payroll_expense_reports
  for select
  to authenticated
  using (
    private.phx_can_manage_payroll()
    or exists (
      select 1
      from public.payroll_expenses pe
      where pe.report_id = payroll_expense_reports.id
        and private.phx_can_access_employee(pe.hr_id)
    )
  );

drop policy if exists payroll_expense_reports_insert_payroll on public.payroll_expense_reports;
create policy payroll_expense_reports_insert_payroll
  on public.payroll_expense_reports
  for insert
  to authenticated
  with check (private.phx_can_manage_payroll());

drop policy if exists payroll_expense_reports_update_payroll on public.payroll_expense_reports;
create policy payroll_expense_reports_update_payroll
  on public.payroll_expense_reports
  for update
  to authenticated
  using (private.phx_can_manage_payroll())
  with check (private.phx_can_manage_payroll());

drop policy if exists payroll_expense_reports_delete_payroll on public.payroll_expense_reports;
create policy payroll_expense_reports_delete_payroll
  on public.payroll_expense_reports
  for delete
  to authenticated
  using (private.phx_can_manage_payroll());

drop policy if exists employee_locations_select_access on public.employee_locations;
create policy employee_locations_select_access
  on public.employee_locations
  for select
  to authenticated
  using (private.phx_can_access_employee(employee_hr_id));

drop policy if exists employee_locations_insert_access on public.employee_locations;
create policy employee_locations_insert_access
  on public.employee_locations
  for insert
  to authenticated
  with check (
    private.phx_can_manage_workforce()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists employee_locations_update_access on public.employee_locations;
create policy employee_locations_update_access
  on public.employee_locations
  for update
  to authenticated
  using (
    private.phx_can_manage_workforce()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  )
  with check (
    private.phx_can_manage_workforce()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists employee_locations_delete_access on public.employee_locations;
create policy employee_locations_delete_access
  on public.employee_locations
  for delete
  to authenticated
  using (private.phx_can_manage_workforce());

drop policy if exists outstation_policy_rules_select_access on public.outstation_policy_rules;
create policy outstation_policy_rules_select_access
  on public.outstation_policy_rules
  for select
  to authenticated
  using (true);

drop policy if exists outstation_expense_requests_select_access on public.outstation_expense_requests;
create policy outstation_expense_requests_select_access
  on public.outstation_expense_requests
  for select
  to authenticated
  using (
    private.phx_can_manage_outstation()
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists outstation_expense_requests_insert_access on public.outstation_expense_requests;
create policy outstation_expense_requests_insert_access
  on public.outstation_expense_requests
  for insert
  to authenticated
  with check (
    private.phx_can_manage_outstation()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists outstation_expense_requests_update_access on public.outstation_expense_requests;
create policy outstation_expense_requests_update_access
  on public.outstation_expense_requests
  for update
  to authenticated
  using (
    private.phx_can_manage_outstation()
    or (
      lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
      and status in ('draft', 'submitted')
    )
  )
  with check (
    private.phx_can_manage_outstation()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists outstation_expense_requests_delete_access on public.outstation_expense_requests;
create policy outstation_expense_requests_delete_access
  on public.outstation_expense_requests
  for delete
  to authenticated
  using (private.phx_can_manage_outstation());

drop policy if exists outstation_location_audit_logs_select_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_select_access
  on public.outstation_location_audit_logs
  for select
  to authenticated
  using (
    private.phx_can_manage_outstation()
    or private.phx_can_access_employee(employee_hr_id)
  );

drop policy if exists outstation_location_audit_logs_insert_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_insert_access
  on public.outstation_location_audit_logs
  for insert
  to authenticated
  with check (
    private.phx_can_manage_outstation()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(private.phx_current_hr_id(), ''))
  );

drop policy if exists outstation_location_audit_logs_write_access on public.outstation_location_audit_logs;
create policy outstation_location_audit_logs_write_access
  on public.outstation_location_audit_logs
  for update
  to authenticated
  using (private.phx_can_manage_outstation())
  with check (private.phx_can_manage_outstation());

drop policy if exists payroll_workflow_transitions_select_access on public.payroll_workflow_transitions;
create policy payroll_workflow_transitions_select_access
  on public.payroll_workflow_transitions
  for select
  to authenticated
  using (true);

notify pgrst, 'reload schema';
