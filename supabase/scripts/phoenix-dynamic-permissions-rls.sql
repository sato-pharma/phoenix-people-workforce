-- Phoenix Workforce dynamic permissions + RLS foundation.
-- Idempotent: safe to run more than once in Supabase SQL editor.
-- Requires Supabase Auth for auth.uid(). The application can keep using service role
-- for admin jobs, but client/user data access should use authenticated Supabase users.

create extension if not exists pgcrypto;

create table if not exists public.user_access_profiles (
  auth_user_id uuid primary key references auth.users(id) on update cascade on delete cascade,
  hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  role text not null default 'employee' check (role in ('employee', 'manager', 'hr', 'admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hr_id)
);

create index if not exists user_access_profiles_hr_id_idx
  on public.user_access_profiles (hr_id);

create index if not exists user_access_profiles_role_idx
  on public.user_access_profiles (role)
  where is_active = true;

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

alter table public.user_access_profiles enable row level security;

drop policy if exists user_access_profiles_read_self_or_admin on public.user_access_profiles;
create policy user_access_profiles_read_self_or_admin
on public.user_access_profiles
for select
using (
  auth_user_id = auth.uid()
  or public.current_access_is_admin()
);

drop policy if exists user_access_profiles_admin_write on public.user_access_profiles;
create policy user_access_profiles_admin_write
on public.user_access_profiles
for all
using (public.current_access_role() = 'admin')
with check (public.current_access_role() = 'admin');

do $$
begin
  if to_regclass('public.employees') is not null then
    alter table public.employees enable row level security;

    drop policy if exists employees_dynamic_read on public.employees;
    create policy employees_dynamic_read
    on public.employees
    for select
    using (public.current_access_can_see_employee(hr_id, manager_hr_id));

    drop policy if exists employees_hr_admin_write on public.employees;
    create policy employees_hr_admin_write
    on public.employees
    for all
    using (public.current_access_can_manage_employees())
    with check (public.current_access_can_manage_employees());
  end if;

  if to_regclass('public.employee_compensation') is not null then
    alter table public.employee_compensation enable row level security;

    drop policy if exists employee_compensation_dynamic_read on public.employee_compensation;
    create policy employee_compensation_dynamic_read
    on public.employee_compensation
    for select
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
    using (public.current_access_can_manage_employees())
    with check (public.current_access_can_manage_employees());
  end if;

  if to_regclass('public.salary_records') is not null then
    alter table public.salary_records enable row level security;

    drop policy if exists salary_records_dynamic_read on public.salary_records;
    create policy salary_records_dynamic_read
    on public.salary_records
    for select
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
    using (public.current_access_can_manage_employees())
    with check (public.current_access_can_manage_employees());
  end if;

  if to_regclass('public.salary_batches') is not null then
    alter table public.salary_batches enable row level security;

    drop policy if exists salary_batches_hr_admin_read on public.salary_batches;
    create policy salary_batches_hr_admin_read
    on public.salary_batches
    for select
    using (public.current_access_role() in ('admin', 'hr'));

    drop policy if exists salary_batches_hr_admin_write on public.salary_batches;
    create policy salary_batches_hr_admin_write
    on public.salary_batches
    for all
    using (public.current_access_can_manage_employees())
    with check (public.current_access_can_manage_employees());
  end if;

  if to_regclass('public.payroll_expenses') is not null then
    alter table public.payroll_expenses enable row level security;

    drop policy if exists payroll_expenses_dynamic_read on public.payroll_expenses;
    create policy payroll_expenses_dynamic_read
    on public.payroll_expenses
    for select
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
    using (public.current_access_role() in ('admin', 'hr', 'manager'))
    with check (public.current_access_role() in ('admin', 'hr', 'manager'));
  end if;

  if to_regclass('public.sales_records') is not null then
    alter table public.sales_records enable row level security;

    drop policy if exists sales_records_dynamic_read on public.sales_records;
    create policy sales_records_dynamic_read
    on public.sales_records
    for select
    using (
      public.current_access_is_admin()
      or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
      or lower(coalesce(manager_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
    );

    drop policy if exists sales_records_hr_admin_write on public.sales_records;
    create policy sales_records_hr_admin_write
    on public.sales_records
    for all
    using (public.current_access_role() in ('admin', 'hr'))
    with check (public.current_access_role() in ('admin', 'hr'));
  end if;
end $$;

notify pgrst, 'reload schema';
