-- Supabase performance advisor remediation
-- Scope:
-- 1. Cache auth.uid()/auth.role() in RLS policies via SELECT wrappers.
-- 2. Scope service-role policies to service_role instead of public.
-- 3. Scope authenticated-only policies away from public where appropriate.
-- 4. Drop genuinely duplicate indexes and redundant unique constraints.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- RLS auth function init plan fixes
-- ---------------------------------------------------------------------------

alter policy users_select_own
on public.users
using (id = (select auth.uid()));

alter policy users_update_own
on public.users
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

alter policy uap_select_own
on public.user_access_profiles
using (auth_user_id = (select auth.uid()));

alter policy uap_update_own
on public.user_access_profiles
using (auth_user_id = (select auth.uid()))
with check (auth_user_id = (select auth.uid()));

alter policy user_access_profiles_read_self_or_admin
on public.user_access_profiles
using ((auth_user_id = (select auth.uid())) or current_access_is_admin());

alter policy employees_select_own_hr
on public.employees
using (hr_id = (
  select u.hr_id
  from public.users u
  where u.id = (select auth.uid())
));

alter policy employees_insert_own_hr
on public.employees
with check (hr_id = (
  select u.hr_id
  from public.users u
  where u.id = (select auth.uid())
));

alter policy employees_update_own_hr
on public.employees
using (hr_id = (
  select u.hr_id
  from public.users u
  where u.id = (select auth.uid())
))
with check (hr_id = (
  select u.hr_id
  from public.users u
  where u.id = (select auth.uid())
));

alter policy employees_delete_own_hr
on public.employees
using (hr_id = (
  select u.hr_id
  from public.users u
  where u.id = (select auth.uid())
));

do $$ begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_documents'
      and policyname = 'emp_docs_select_own'
  ) then
    execute $policy$
      alter policy emp_docs_select_own
      on public.employee_documents
      using (
        (uploaded_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_documents'
      and policyname = 'emp_docs_insert_own'
  ) then
    execute $policy$
      alter policy emp_docs_insert_own
      on public.employee_documents
      with check (
        (uploaded_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_documents'
      and policyname = 'emp_docs_update_own'
  ) then
    execute $policy$
      alter policy emp_docs_update_own
      on public.employee_documents
      using (
        (uploaded_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
      with check (
        (uploaded_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_documents'
      and policyname = 'emp_docs_delete_own'
  ) then
    execute $policy$
      alter policy emp_docs_delete_own
      on public.employee_documents
      using (
        (uploaded_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_history'
      and column_name = 'changed_by_user_id'
  ) and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_history'
      and policyname = 'emp_hist_select_own'
  ) then
    execute $policy$
      alter policy emp_hist_select_own
      on public.employee_history
      using (
        (changed_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_history'
      and column_name = 'changed_by_user_id'
  ) and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_history'
      and policyname = 'emp_hist_insert_own'
  ) then
    execute $policy$
      alter policy emp_hist_insert_own
      on public.employee_history
      with check (
        (changed_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_history'
      and column_name = 'changed_by_user_id'
  ) and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_history'
      and policyname = 'emp_hist_update_own'
  ) then
    execute $policy$
      alter policy emp_hist_update_own
      on public.employee_history
      using (
        (changed_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
      with check (
        (changed_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

do $$ begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_history'
      and column_name = 'changed_by_user_id'
  ) and exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_history'
      and policyname = 'emp_hist_delete_own'
  ) then
    execute $policy$
      alter policy emp_hist_delete_own
      on public.employee_history
      using (
        (changed_by_user_id = (select auth.uid()))
        or (employee_hr_id = (
          select u.hr_id
          from public.users u
          where u.id = (select auth.uid())
        ))
      )
    $policy$;
  end if;
end $$;

alter policy app_auth_users_select_own
on public.app_auth_users
using (auth_user_id = (select auth.uid()));

alter policy app_auth_users_update_own
on public.app_auth_users
using (auth_user_id = (select auth.uid()))
with check (auth_user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Service-role policy scoping
-- ---------------------------------------------------------------------------

do $$ begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'employee_documents'
      and policyname = 'phx_employee_documents_service_role'
  ) then
    execute 'alter policy phx_employee_documents_service_role on public.employee_documents to service_role';
    execute $policy$
      alter policy phx_employee_documents_service_role on public.employee_documents
      using ((select auth.role()) = 'service_role'::text)
      with check ((select auth.role()) = 'service_role'::text)
    $policy$;
  end if;
end $$;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select *
    from (
      values
        ('access_scopes', 'phx_access_scopes_service_role'),
        ('app_auth_users', 'phx_app_auth_users_service_role'),
        ('areas', 'phx_areas_service_role'),
        ('audit_logs', 'phx_audit_logs_service_role'),
        ('departments', 'phx_departments_service_role'),
        ('employee_history', 'phx_employee_history_service_role'),
        ('employee_resignations', 'phx_employee_resignations_service_role'),
        ('job_offer_audit_logs', 'phx_job_offer_audit_logs_service_role'),
        ('job_offers', 'phx_job_offers_service_role'),
        ('lines', 'phx_lines_service_role'),
        ('notification_delivery_logs', 'phx_notification_delivery_logs_service_role'),
        ('notification_events', 'phx_notification_events_service_role'),
        ('notification_outbox', 'phx_notification_outbox_service_role'),
        ('permissions', 'phx_permissions_service_role'),
        ('platform_settings', 'phx_platform_settings_service_role'),
        ('position_vacancies', 'phx_position_vacancies_service_role'),
        ('positions', 'phx_positions_service_role'),
        ('role_permission_overrides', 'phx_role_permission_overrides_service_role'),
        ('roles', 'phx_roles_service_role'),
        ('sales_audit_logs', 'phx_sales_audit_logs_service_role'),
        ('sales_import_batches', 'phx_sales_import_batches_service_role'),
        ('sales_records', 'phx_sales_records_service_role'),
        ('sales_role_overrides', 'phx_sales_role_overrides_service_role'),
        ('sales_target_batches', 'phx_sales_target_batches_service_role'),
        ('sales_targets', 'phx_sales_targets_service_role'),
        ('system_audit_logs', 'phx_system_audit_logs_service_role'),
        ('teams', 'phx_teams_service_role'),
        ('user_roles', 'phx_user_roles_service_role'),
        ('users', 'phx_users_service_role')
    ) as t(table_name, policy_name)
  loop
    if exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = policy_row.table_name
        and policyname = policy_row.policy_name
    ) then
      execute format(
        'alter policy %I on public.%I to service_role',
        policy_row.policy_name,
        policy_row.table_name
      );
      execute format(
        'alter policy %I on public.%I using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)',
        policy_row.policy_name,
        policy_row.table_name
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Tighten obviously authenticated-only policies
-- ---------------------------------------------------------------------------

do $$
declare
  policy_row record;
begin
  for policy_row in
    select *
    from (
      values
        ('payroll_expenses', 'employee can see own expenses'),
        ('salary_records', 'employee can see own salary'),
        ('salary_batches', 'salary_batches_hr_admin_read'),
        ('sales_records', 'employee can see own sales'),
        ('sales_records', 'sales_records_dynamic_read'),
        ('sales_records', 'sales_records_hr_admin_write')
    ) as t(table_name, policy_name)
  loop
    if exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = policy_row.table_name
        and policyname = policy_row.policy_name
    ) then
      execute format(
        'alter policy %I on public.%I to authenticated',
        policy_row.policy_name,
        policy_row.table_name
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Duplicate index and redundant constraint cleanup
-- ---------------------------------------------------------------------------

alter table public.access_scopes
drop constraint if exists access_scopes_name_unique;

drop index if exists public.app_auth_users_login_id_idx;
drop index if exists public.employee_compensation_employee_hr_id_idx;
drop index if exists public.idx_employee_compensation_employee_hr_id;
drop index if exists public.idx_employees_manager_hr_id;
alter table public.employees drop constraint if exists employees_hr_id_unique;
drop index if exists public.idx_payroll_expenses_hr_id;
drop index if exists public.idx_position_vacancies_status;
drop index if exists public.idx_salary_batches_status;
drop index if exists public.idx_salary_flags_batch_id;
drop index if exists public.idx_salary_flags_hr_id;
drop index if exists public.idx_salary_records_batch_id;
drop index if exists public.idx_salary_records_employee_code;
drop index if exists public.idx_salary_records_hr_id;
drop index if exists public.idx_sales_records_employee_hr_id_safe;
drop index if exists public.idx_sales_records_manager_hr_id_safe;;
