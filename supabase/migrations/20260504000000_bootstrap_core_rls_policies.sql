-- Bootstrap RLS policies that exist on production (created via non-migration
-- scripts) but are missing on fresh Supabase preview branches.
--
-- Migration 20260509031312 unconditionally ALTER POLICYs all of these.
-- On a fresh branch none exist, so the migration fails with "policy does not
-- exist".  This bootstrap creates them first using IF NOT EXISTS guards so
-- it is a complete no-op on production where they already exist.
--
-- Stubs use (true) expressions — the ALTER in 20260509031312 overwrites them.

-- ---------------------------------------------------------------------------
-- user_access_profiles
-- ---------------------------------------------------------------------------

alter table public.user_access_profiles enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_access_profiles'
      and policyname = 'uap_select_own'
  ) then
    execute 'create policy uap_select_own on public.user_access_profiles
      for select using (auth_user_id = (select auth.uid()))';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_access_profiles'
      and policyname = 'uap_update_own'
  ) then
    execute 'create policy uap_update_own on public.user_access_profiles
      for update
      using (auth_user_id = (select auth.uid()))
      with check (auth_user_id = (select auth.uid()))';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_access_profiles'
      and policyname = 'user_access_profiles_read_self_or_admin'
  ) then
    execute 'create policy user_access_profiles_read_self_or_admin
      on public.user_access_profiles
      for select using (auth_user_id = (select auth.uid()))';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------

alter table public.employees enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employees'
      and policyname = 'employees_select_own_hr'
  ) then
    execute 'create policy employees_select_own_hr on public.employees
      for select using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employees'
      and policyname = 'employees_insert_own_hr'
  ) then
    execute 'create policy employees_insert_own_hr on public.employees
      for insert with check (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employees'
      and policyname = 'employees_update_own_hr'
  ) then
    execute 'create policy employees_update_own_hr on public.employees
      for update using (true) with check (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employees'
      and policyname = 'employees_delete_own_hr'
  ) then
    execute 'create policy employees_delete_own_hr on public.employees
      for delete using (true)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- employee_documents
-- ---------------------------------------------------------------------------

alter table public.employee_documents enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_documents'
      and policyname = 'emp_docs_select_own'
  ) then
    execute 'create policy emp_docs_select_own on public.employee_documents
      for select using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_documents'
      and policyname = 'emp_docs_insert_own'
  ) then
    execute 'create policy emp_docs_insert_own on public.employee_documents
      for insert with check (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_documents'
      and policyname = 'emp_docs_update_own'
  ) then
    execute 'create policy emp_docs_update_own on public.employee_documents
      for update using (true) with check (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_documents'
      and policyname = 'emp_docs_delete_own'
  ) then
    execute 'create policy emp_docs_delete_own on public.employee_documents
      for delete using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_documents'
      and policyname = 'phx_employee_documents_service_role'
  ) then
    execute 'create policy phx_employee_documents_service_role
      on public.employee_documents
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- employee_history
-- ---------------------------------------------------------------------------

alter table public.employee_history enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_history'
      and policyname = 'emp_hist_select_own'
  ) then
    execute 'create policy emp_hist_select_own on public.employee_history
      for select using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_history'
      and policyname = 'emp_hist_insert_own'
  ) then
    execute 'create policy emp_hist_insert_own on public.employee_history
      for insert with check (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_history'
      and policyname = 'emp_hist_update_own'
  ) then
    execute 'create policy emp_hist_update_own on public.employee_history
      for update using (true) with check (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_history'
      and policyname = 'emp_hist_delete_own'
  ) then
    execute 'create policy emp_hist_delete_own on public.employee_history
      for delete using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_history'
      and policyname = 'phx_employee_history_service_role'
  ) then
    execute 'create policy phx_employee_history_service_role
      on public.employee_history
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- access_scopes
-- ---------------------------------------------------------------------------

alter table public.access_scopes enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'access_scopes'
      and policyname = 'phx_access_scopes_service_role'
  ) then
    execute 'create policy phx_access_scopes_service_role on public.access_scopes
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- areas
-- ---------------------------------------------------------------------------

alter table public.areas enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'areas'
      and policyname = 'phx_areas_service_role'
  ) then
    execute 'create policy phx_areas_service_role on public.areas
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------

alter table public.audit_logs enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'audit_logs'
      and policyname = 'phx_audit_logs_service_role'
  ) then
    execute 'create policy phx_audit_logs_service_role on public.audit_logs
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------

alter table public.departments enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'departments'
      and policyname = 'phx_departments_service_role'
  ) then
    execute 'create policy phx_departments_service_role on public.departments
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- employee_resignations
-- ---------------------------------------------------------------------------

alter table public.employee_resignations enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_resignations'
      and policyname = 'phx_employee_resignations_service_role'
  ) then
    execute 'create policy phx_employee_resignations_service_role
      on public.employee_resignations
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- job_offer_audit_logs
-- ---------------------------------------------------------------------------

alter table public.job_offer_audit_logs enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_offer_audit_logs'
      and policyname = 'phx_job_offer_audit_logs_service_role'
  ) then
    execute 'create policy phx_job_offer_audit_logs_service_role
      on public.job_offer_audit_logs
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- job_offers
-- ---------------------------------------------------------------------------

alter table public.job_offers enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'job_offers'
      and policyname = 'phx_job_offers_service_role'
  ) then
    execute 'create policy phx_job_offers_service_role on public.job_offers
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- lines
-- ---------------------------------------------------------------------------

alter table public.lines enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lines'
      and policyname = 'phx_lines_service_role'
  ) then
    execute 'create policy phx_lines_service_role on public.lines
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- notification_delivery_logs
-- ---------------------------------------------------------------------------

alter table public.notification_delivery_logs enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_delivery_logs'
      and policyname = 'phx_notification_delivery_logs_service_role'
  ) then
    execute 'create policy phx_notification_delivery_logs_service_role
      on public.notification_delivery_logs
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- notification_events
-- ---------------------------------------------------------------------------

alter table public.notification_events enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_events'
      and policyname = 'phx_notification_events_service_role'
  ) then
    execute 'create policy phx_notification_events_service_role
      on public.notification_events
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- notification_outbox
-- ---------------------------------------------------------------------------

alter table public.notification_outbox enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_outbox'
      and policyname = 'phx_notification_outbox_service_role'
  ) then
    execute 'create policy phx_notification_outbox_service_role
      on public.notification_outbox
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------

alter table public.permissions enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'permissions'
      and policyname = 'phx_permissions_service_role'
  ) then
    execute 'create policy phx_permissions_service_role on public.permissions
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- platform_settings
-- ---------------------------------------------------------------------------

alter table public.platform_settings enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'platform_settings'
      and policyname = 'phx_platform_settings_service_role'
  ) then
    execute 'create policy phx_platform_settings_service_role
      on public.platform_settings
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- position_vacancies
-- ---------------------------------------------------------------------------

alter table public.position_vacancies enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'position_vacancies'
      and policyname = 'phx_position_vacancies_service_role'
  ) then
    execute 'create policy phx_position_vacancies_service_role
      on public.position_vacancies
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- positions
-- ---------------------------------------------------------------------------

alter table public.positions enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'positions'
      and policyname = 'phx_positions_service_role'
  ) then
    execute 'create policy phx_positions_service_role on public.positions
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- role_permission_overrides
-- ---------------------------------------------------------------------------

alter table public.role_permission_overrides enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'role_permission_overrides'
      and policyname = 'phx_role_permission_overrides_service_role'
  ) then
    execute 'create policy phx_role_permission_overrides_service_role
      on public.role_permission_overrides
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sales_audit_logs
-- ---------------------------------------------------------------------------

alter table public.sales_audit_logs enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_audit_logs'
      and policyname = 'phx_sales_audit_logs_service_role'
  ) then
    execute 'create policy phx_sales_audit_logs_service_role
      on public.sales_audit_logs
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sales_import_batches
-- ---------------------------------------------------------------------------

alter table public.sales_import_batches enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_import_batches'
      and policyname = 'phx_sales_import_batches_service_role'
  ) then
    execute 'create policy phx_sales_import_batches_service_role
      on public.sales_import_batches
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sales_records
-- ---------------------------------------------------------------------------

alter table public.sales_records enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_records'
      and policyname = 'phx_sales_records_service_role'
  ) then
    execute 'create policy phx_sales_records_service_role on public.sales_records
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_records'
      and policyname = 'employee can see own sales'
  ) then
    execute 'create policy "employee can see own sales" on public.sales_records
      for select using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_records'
      and policyname = 'sales_records_dynamic_read'
  ) then
    execute 'create policy sales_records_dynamic_read on public.sales_records
      for select using (true)';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_records'
      and policyname = 'sales_records_hr_admin_write'
  ) then
    execute 'create policy sales_records_hr_admin_write on public.sales_records
      using (true) with check (true)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sales_role_overrides
-- ---------------------------------------------------------------------------

alter table public.sales_role_overrides enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_role_overrides'
      and policyname = 'phx_sales_role_overrides_service_role'
  ) then
    execute 'create policy phx_sales_role_overrides_service_role
      on public.sales_role_overrides
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sales_target_batches
-- ---------------------------------------------------------------------------

alter table public.sales_target_batches enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_target_batches'
      and policyname = 'phx_sales_target_batches_service_role'
  ) then
    execute 'create policy phx_sales_target_batches_service_role
      on public.sales_target_batches
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- sales_targets
-- ---------------------------------------------------------------------------

alter table public.sales_targets enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales_targets'
      and policyname = 'phx_sales_targets_service_role'
  ) then
    execute 'create policy phx_sales_targets_service_role on public.sales_targets
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- system_audit_logs
-- ---------------------------------------------------------------------------

alter table public.system_audit_logs enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'system_audit_logs'
      and policyname = 'phx_system_audit_logs_service_role'
  ) then
    execute 'create policy phx_system_audit_logs_service_role
      on public.system_audit_logs
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------

alter table public.teams enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'teams'
      and policyname = 'phx_teams_service_role'
  ) then
    execute 'create policy phx_teams_service_role on public.teams
      using ((select auth.role()) = ''service_role''::text)
      with check ((select auth.role()) = ''service_role''::text)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- payroll_expenses
-- ---------------------------------------------------------------------------

alter table public.payroll_expenses enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'payroll_expenses'
      and policyname = 'employee can see own expenses'
  ) then
    execute 'create policy "employee can see own expenses" on public.payroll_expenses
      for select using (true)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- salary_records
-- ---------------------------------------------------------------------------

alter table public.salary_records enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'salary_records'
      and policyname = 'employee can see own salary'
  ) then
    execute 'create policy "employee can see own salary" on public.salary_records
      for select using (true)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- salary_batches
-- ---------------------------------------------------------------------------

alter table public.salary_batches enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'salary_batches'
      and policyname = 'salary_batches_hr_admin_read'
  ) then
    execute 'create policy salary_batches_hr_admin_read on public.salary_batches
      for select using (true)';
  end if;
end $$;
