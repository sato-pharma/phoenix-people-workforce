-- Phoenix Workforce user-scoped Supabase Auth + RLS reconciliation.
-- Restores authenticated access for selected tables while keeping RLS enforced.
-- Intended to run after phoenix-dynamic-permissions-rls.sql and security-hardening-phase-1.sql.

create extension if not exists pgcrypto;

alter table if exists public.app_auth_users
  add column if not exists auth_user_id uuid null references auth.users(id) on update cascade on delete set null;

alter table if exists public.app_auth_users
  add column if not exists auth_email text null;

create unique index if not exists app_auth_users_auth_user_id_idx
  on public.app_auth_users (auth_user_id)
  where auth_user_id is not null;

create unique index if not exists app_auth_users_auth_email_idx
  on public.app_auth_users (auth_email)
  where auth_email is not null;

alter table if exists public.user_access_profiles
  add column if not exists login_id text null;

alter table if exists public.user_access_profiles
  add column if not exists line text null;

alter table if exists public.user_access_profiles
  add column if not exists manager_hr_id text null;

alter table if exists public.user_access_profiles
  add column if not exists phoenix_role text null;

create index if not exists user_access_profiles_login_id_idx
  on public.user_access_profiles (login_id);

create index if not exists user_access_profiles_manager_hr_id_idx
  on public.user_access_profiles (manager_hr_id);

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
      where uap.auth_user_id = auth.uid()
        and uap.is_active = true
      limit 1
    ),
    'employee'
  );
$$;

create or replace function public.current_access_hr_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select (
    select uap.hr_id
    from public.user_access_profiles uap
    where uap.auth_user_id = auth.uid()
      and uap.is_active = true
    limit 1
  );
$$;

create or replace function public.current_access_manager_hr_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select (
    select uap.manager_hr_id
    from public.user_access_profiles uap
    where uap.auth_user_id = auth.uid()
      and uap.is_active = true
    limit 1
  );
$$;

create or replace function public.current_access_line()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select (
    select uap.line
    from public.user_access_profiles uap
    where uap.auth_user_id = auth.uid()
      and uap.is_active = true
    limit 1
  );
$$;

create or replace function public.current_access_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_access_role() in ('admin', 'hr');
$$;

create or replace function public.current_access_can_manage_employees()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_access_role() in ('admin', 'hr');
$$;

create or replace function public.current_access_can_see_employee(employee_hr_id text, employee_manager_hr_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.current_access_is_admin()
    or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    or (
      public.current_access_role() = 'manager'
      and lower(coalesce(employee_manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    );
$$;

grant usage on schema public to authenticated;
revoke execute on function public.current_access_role() from public, anon, authenticated;
revoke execute on function public.current_access_hr_id() from public, anon, authenticated;
revoke execute on function public.current_access_manager_hr_id() from public, anon, authenticated;
revoke execute on function public.current_access_line() from public, anon, authenticated;
revoke execute on function public.current_access_is_admin() from public, anon, authenticated;
revoke execute on function public.current_access_can_manage_employees() from public, anon, authenticated;
revoke execute on function public.current_access_can_see_employee(text, text) from public, anon, authenticated;
grant execute on function public.current_access_role() to service_role;
grant execute on function public.current_access_hr_id() to service_role;
grant execute on function public.current_access_manager_hr_id() to service_role;
grant execute on function public.current_access_line() to service_role;
grant execute on function public.current_access_is_admin() to service_role;
grant execute on function public.current_access_can_manage_employees() to service_role;
grant execute on function public.current_access_can_see_employee(text, text) to service_role;

do $$
declare
  t text;
  privileged_tables text[] := array[
    'employees',
    'employee_compensation',
    'salary_batches',
    'salary_records',
    'salary_flags',
    'payroll_expense_reports',
    'payroll_expenses',
    'user_access_profiles'
  ];
begin
  foreach t in array privileged_tables
  loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('alter table public.%I no force row level security', t);
      execute format('drop policy if exists %I on public.%I', 'phx_' || t || '_service_role', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;
  end loop;
end $$;

drop policy if exists user_access_profiles_read_self_or_admin on public.user_access_profiles;
create policy user_access_profiles_read_self_or_admin
on public.user_access_profiles
for select
to authenticated
using (
  auth_user_id = auth.uid()
  or public.current_access_is_admin()
);

drop policy if exists user_access_profiles_admin_write on public.user_access_profiles;
create policy user_access_profiles_admin_write
on public.user_access_profiles
for all
to authenticated
using (public.current_access_role() = 'admin')
with check (public.current_access_role() = 'admin');

drop policy if exists employees_dynamic_read on public.employees;
create policy employees_dynamic_read
on public.employees
for select
to authenticated
using (public.current_access_can_see_employee(hr_id, manager_hr_id));

drop policy if exists employees_hr_admin_write on public.employees;
create policy employees_hr_admin_write
on public.employees
for all
to authenticated
using (public.current_access_can_manage_employees())
with check (public.current_access_can_manage_employees());

drop policy if exists employee_compensation_dynamic_read on public.employee_compensation;
create policy employee_compensation_dynamic_read
on public.employee_compensation
for select
to authenticated
using (
  public.current_access_is_admin()
  or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(e.hr_id) = lower(public.employee_compensation.employee_hr_id)
      and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

drop policy if exists employee_compensation_hr_admin_write on public.employee_compensation;
create policy employee_compensation_hr_admin_write
on public.employee_compensation
for all
to authenticated
using (public.current_access_can_manage_employees())
with check (public.current_access_can_manage_employees());

drop policy if exists salary_records_dynamic_read on public.salary_records;
create policy salary_records_dynamic_read
on public.salary_records
for select
to authenticated
using (
  public.current_access_is_admin()
  or lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(e.hr_id) = lower(public.salary_records.hr_id)
      and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

drop policy if exists salary_records_hr_admin_write on public.salary_records;
create policy salary_records_hr_admin_write
on public.salary_records
for all
to authenticated
using (public.current_access_can_manage_employees())
with check (public.current_access_can_manage_employees());

drop policy if exists salary_batches_dynamic_read on public.salary_batches;
create policy salary_batches_dynamic_read
on public.salary_batches
for select
to authenticated
using (
  public.current_access_is_admin()
  or exists (
    select 1
    from public.salary_records sr
    where sr.batch_id = public.salary_batches.id
  )
);

drop policy if exists salary_batches_hr_admin_write on public.salary_batches;
create policy salary_batches_hr_admin_write
on public.salary_batches
for all
to authenticated
using (public.current_access_can_manage_employees())
with check (public.current_access_can_manage_employees());

drop policy if exists salary_flags_dynamic_read on public.salary_flags;
create policy salary_flags_dynamic_read
on public.salary_flags
for select
to authenticated
using (
  public.current_access_is_admin()
  or (
    hr_id is not null
    and lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
  )
  or exists (
    select 1
    from public.salary_records sr
    where sr.batch_id = public.salary_flags.batch_id
      and lower(coalesce(sr.hr_id, '')) = lower(coalesce(public.salary_flags.hr_id, ''))
  )
);

drop policy if exists salary_flags_hr_admin_write on public.salary_flags;
create policy salary_flags_hr_admin_write
on public.salary_flags
for all
to authenticated
using (public.current_access_can_manage_employees())
with check (public.current_access_can_manage_employees());

drop policy if exists payroll_expenses_dynamic_read on public.payroll_expenses;
create policy payroll_expenses_dynamic_read
on public.payroll_expenses
for select
to authenticated
using (
  public.current_access_is_admin()
  or lower(coalesce(hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(e.hr_id) = lower(public.payroll_expenses.hr_id)
      and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

drop policy if exists payroll_expenses_hr_admin_write on public.payroll_expenses;
create policy payroll_expenses_hr_admin_write
on public.payroll_expenses
for all
to authenticated
using (public.current_access_role() in ('admin', 'hr', 'manager'))
with check (public.current_access_role() in ('admin', 'hr', 'manager'));

drop policy if exists payroll_expense_reports_dynamic_read on public.payroll_expense_reports;
create policy payroll_expense_reports_dynamic_read
on public.payroll_expense_reports
for select
to authenticated
using (
  public.current_access_is_admin()
  or exists (
    select 1
    from public.payroll_expenses pe
    where pe.report_id = public.payroll_expense_reports.id
  )
);

drop policy if exists payroll_expense_reports_hr_admin_write on public.payroll_expense_reports;
create policy payroll_expense_reports_hr_admin_write
on public.payroll_expense_reports
for all
to authenticated
using (public.current_access_role() in ('admin', 'hr', 'manager'))
with check (public.current_access_role() in ('admin', 'hr', 'manager'));

notify pgrst, 'reload schema';
