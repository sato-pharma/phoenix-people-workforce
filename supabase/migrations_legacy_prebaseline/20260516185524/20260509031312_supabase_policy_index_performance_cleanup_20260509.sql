-- Supabase performance advisor remediation
-- Bootstrap-safe version:
-- Apply policy/index hardening only when the target table/policy/constraint exists.

set check_function_bodies = off;

do $$
begin
  -- -------------------------------------------------------------------------
  -- RLS auth function init plan fixes
  -- -------------------------------------------------------------------------
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_select_own') then
    execute 'alter policy users_select_own on public.users using (id = (select auth.uid()))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'users_update_own') then
    execute 'alter policy users_update_own on public.users using (id = (select auth.uid())) with check (id = (select auth.uid()))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_access_profiles' and policyname = 'uap_select_own') then
    execute 'alter policy uap_select_own on public.user_access_profiles using (auth_user_id = (select auth.uid()))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_access_profiles' and policyname = 'uap_update_own') then
    execute 'alter policy uap_update_own on public.user_access_profiles using (auth_user_id = (select auth.uid())) with check (auth_user_id = (select auth.uid()))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_access_profiles' and policyname = 'user_access_profiles_read_self_or_admin') then
    execute 'alter policy user_access_profiles_read_self_or_admin on public.user_access_profiles using ((auth_user_id = (select auth.uid())) or current_access_is_admin())';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_select_own_hr') then
    execute 'alter policy employees_select_own_hr on public.employees using (hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_insert_own_hr') then
    execute 'alter policy employees_insert_own_hr on public.employees with check (hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_update_own_hr') then
    execute 'alter policy employees_update_own_hr on public.employees using (hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))) with check (hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_delete_own_hr') then
    execute 'alter policy employees_delete_own_hr on public.employees using (hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_documents' and policyname = 'emp_docs_select_own') then
    execute 'alter policy emp_docs_select_own on public.employee_documents using ((uploaded_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_documents' and policyname = 'emp_docs_insert_own') then
    execute 'alter policy emp_docs_insert_own on public.employee_documents with check ((uploaded_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_documents' and policyname = 'emp_docs_update_own') then
    execute 'alter policy emp_docs_update_own on public.employee_documents using ((uploaded_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))) with check ((uploaded_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_documents' and policyname = 'emp_docs_delete_own') then
    execute 'alter policy emp_docs_delete_own on public.employee_documents using ((uploaded_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_history' and policyname = 'emp_hist_select_own') then
    execute 'alter policy emp_hist_select_own on public.employee_history using ((changed_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_history' and policyname = 'emp_hist_insert_own') then
    execute 'alter policy emp_hist_insert_own on public.employee_history with check ((changed_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_history' and policyname = 'emp_hist_update_own') then
    execute 'alter policy emp_hist_update_own on public.employee_history using ((changed_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))) with check ((changed_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_history' and policyname = 'emp_hist_delete_own') then
    execute 'alter policy emp_hist_delete_own on public.employee_history using ((changed_by_user_id = (select auth.uid())) or (employee_hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_auth_users' and policyname = 'app_auth_users_select_own') then
    execute 'alter policy app_auth_users_select_own on public.app_auth_users using (auth_user_id = (select auth.uid()))';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_auth_users' and policyname = 'app_auth_users_update_own') then
    execute 'alter policy app_auth_users_update_own on public.app_auth_users using (auth_user_id = (select auth.uid())) with check (auth_user_id = (select auth.uid()))';
  end if;

  -- -------------------------------------------------------------------------
  -- Service-role policy scoping
  -- -------------------------------------------------------------------------
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'access_scopes' and policyname = 'phx_access_scopes_service_role') then
    execute 'alter policy phx_access_scopes_service_role on public.access_scopes to service_role';
    execute 'alter policy phx_access_scopes_service_role on public.access_scopes using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_auth_users' and policyname = 'phx_app_auth_users_service_role') then
    execute 'alter policy phx_app_auth_users_service_role on public.app_auth_users to service_role';
    execute 'alter policy phx_app_auth_users_service_role on public.app_auth_users using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'areas' and policyname = 'phx_areas_service_role') then
    execute 'alter policy phx_areas_service_role on public.areas to service_role';
    execute 'alter policy phx_areas_service_role on public.areas using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'phx_audit_logs_service_role') then
    execute 'alter policy phx_audit_logs_service_role on public.audit_logs to service_role';
    execute 'alter policy phx_audit_logs_service_role on public.audit_logs using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'departments' and policyname = 'phx_departments_service_role') then
    execute 'alter policy phx_departments_service_role on public.departments to service_role';
    execute 'alter policy phx_departments_service_role on public.departments using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_documents' and policyname = 'phx_employee_documents_service_role') then
    execute 'alter policy phx_employee_documents_service_role on public.employee_documents to service_role';
    execute 'alter policy phx_employee_documents_service_role on public.employee_documents using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_history' and policyname = 'phx_employee_history_service_role') then
    execute 'alter policy phx_employee_history_service_role on public.employee_history to service_role';
    execute 'alter policy phx_employee_history_service_role on public.employee_history using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_resignations' and policyname = 'phx_employee_resignations_service_role') then
    execute 'alter policy phx_employee_resignations_service_role on public.employee_resignations to service_role';
    execute 'alter policy phx_employee_resignations_service_role on public.employee_resignations using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'job_offer_audit_logs' and policyname = 'phx_job_offer_audit_logs_service_role') then
    execute 'alter policy phx_job_offer_audit_logs_service_role on public.job_offer_audit_logs to service_role';
    execute 'alter policy phx_job_offer_audit_logs_service_role on public.job_offer_audit_logs using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'job_offers' and policyname = 'phx_job_offers_service_role') then
    execute 'alter policy phx_job_offers_service_role on public.job_offers to service_role';
    execute 'alter policy phx_job_offers_service_role on public.job_offers using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lines' and policyname = 'phx_lines_service_role') then
    execute 'alter policy phx_lines_service_role on public.lines to service_role';
    execute 'alter policy phx_lines_service_role on public.lines using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_delivery_logs' and policyname = 'phx_notification_delivery_logs_service_role') then
    execute 'alter policy phx_notification_delivery_logs_service_role on public.notification_delivery_logs to service_role';
    execute 'alter policy phx_notification_delivery_logs_service_role on public.notification_delivery_logs using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_events' and policyname = 'phx_notification_events_service_role') then
    execute 'alter policy phx_notification_events_service_role on public.notification_events to service_role';
    execute 'alter policy phx_notification_events_service_role on public.notification_events using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_outbox' and policyname = 'phx_notification_outbox_service_role') then
    execute 'alter policy phx_notification_outbox_service_role on public.notification_outbox to service_role';
    execute 'alter policy phx_notification_outbox_service_role on public.notification_outbox using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'permissions' and policyname = 'phx_permissions_service_role') then
    execute 'alter policy phx_permissions_service_role on public.permissions to service_role';
    execute 'alter policy phx_permissions_service_role on public.permissions using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'platform_settings' and policyname = 'phx_platform_settings_service_role') then
    execute 'alter policy phx_platform_settings_service_role on public.platform_settings to service_role';
    execute 'alter policy phx_platform_settings_service_role on public.platform_settings using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'position_vacancies' and policyname = 'phx_position_vacancies_service_role') then
    execute 'alter policy phx_position_vacancies_service_role on public.position_vacancies to service_role';
    execute 'alter policy phx_position_vacancies_service_role on public.position_vacancies using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'positions' and policyname = 'phx_positions_service_role') then
    execute 'alter policy phx_positions_service_role on public.positions to service_role';
    execute 'alter policy phx_positions_service_role on public.positions using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'role_permission_overrides' and policyname = 'phx_role_permission_overrides_service_role') then
    execute 'alter policy phx_role_permission_overrides_service_role on public.role_permission_overrides to service_role';
    execute 'alter policy phx_role_permission_overrides_service_role on public.role_permission_overrides using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'roles' and policyname = 'phx_roles_service_role') then
    execute 'alter policy phx_roles_service_role on public.roles to service_role';
    execute 'alter policy phx_roles_service_role on public.roles using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_audit_logs' and policyname = 'phx_sales_audit_logs_service_role') then
    execute 'alter policy phx_sales_audit_logs_service_role on public.sales_audit_logs to service_role';
    execute 'alter policy phx_sales_audit_logs_service_role on public.sales_audit_logs using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_import_batches' and policyname = 'phx_sales_import_batches_service_role') then
    execute 'alter policy phx_sales_import_batches_service_role on public.sales_import_batches to service_role';
    execute 'alter policy phx_sales_import_batches_service_role on public.sales_import_batches using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'phx_sales_records_service_role') then
    execute 'alter policy phx_sales_records_service_role on public.sales_records to service_role';
    execute 'alter policy phx_sales_records_service_role on public.sales_records using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_role_overrides' and policyname = 'phx_sales_role_overrides_service_role') then
    execute 'alter policy phx_sales_role_overrides_service_role on public.sales_role_overrides to service_role';
    execute 'alter policy phx_sales_role_overrides_service_role on public.sales_role_overrides using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_target_batches' and policyname = 'phx_sales_target_batches_service_role') then
    execute 'alter policy phx_sales_target_batches_service_role on public.sales_target_batches to service_role';
    execute 'alter policy phx_sales_target_batches_service_role on public.sales_target_batches using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_targets' and policyname = 'phx_sales_targets_service_role') then
    execute 'alter policy phx_sales_targets_service_role on public.sales_targets to service_role';
    execute 'alter policy phx_sales_targets_service_role on public.sales_targets using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'system_audit_logs' and policyname = 'phx_system_audit_logs_service_role') then
    execute 'alter policy phx_system_audit_logs_service_role on public.system_audit_logs to service_role';
    execute 'alter policy phx_system_audit_logs_service_role on public.system_audit_logs using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'teams' and policyname = 'phx_teams_service_role') then
    execute 'alter policy phx_teams_service_role on public.teams to service_role';
    execute 'alter policy phx_teams_service_role on public.teams using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles' and policyname = 'phx_user_roles_service_role') then
    execute 'alter policy phx_user_roles_service_role on public.user_roles to service_role';
    execute 'alter policy phx_user_roles_service_role on public.user_roles using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users' and policyname = 'phx_users_service_role') then
    execute 'alter policy phx_users_service_role on public.users to service_role';
    execute 'alter policy phx_users_service_role on public.users using ((select auth.role()) = ''service_role''::text) with check ((select auth.role()) = ''service_role''::text)';
  end if;

  -- -------------------------------------------------------------------------
  -- Tighten obviously authenticated-only policies
  -- -------------------------------------------------------------------------
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expenses' and policyname = 'employee can see own expenses') then
    execute 'alter policy "employee can see own expenses" on public.payroll_expenses to authenticated';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_records' and policyname = 'employee can see own salary') then
    execute 'alter policy "employee can see own salary" on public.salary_records to authenticated';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_batches' and policyname = 'salary_batches_hr_admin_read') then
    execute 'alter policy salary_batches_hr_admin_read on public.salary_batches to authenticated';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'employee can see own sales') then
    execute 'alter policy "employee can see own sales" on public.sales_records to authenticated';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'sales_records_dynamic_read') then
    execute 'alter policy sales_records_dynamic_read on public.sales_records to authenticated';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'sales_records_hr_admin_write') then
    execute 'alter policy sales_records_hr_admin_write on public.sales_records to authenticated';
  end if;

  -- -------------------------------------------------------------------------
  -- Duplicate index and redundant constraint cleanup
  -- -------------------------------------------------------------------------
  if to_regclass('public.access_scopes') is not null then
    execute 'alter table public.access_scopes drop constraint if exists access_scopes_name_unique';
  end if;
  if to_regclass('public.employees') is not null then
    execute 'alter table public.employees drop constraint if exists employees_hr_id_unique';
  end if;

  execute 'drop index if exists public.app_auth_users_login_id_idx';
  execute 'drop index if exists public.employee_compensation_employee_hr_id_idx';
  execute 'drop index if exists public.idx_employee_compensation_employee_hr_id';
  execute 'drop index if exists public.idx_employees_manager_hr_id';
  execute 'drop index if exists public.idx_payroll_expenses_hr_id';
  execute 'drop index if exists public.idx_position_vacancies_status';
  execute 'drop index if exists public.idx_salary_batches_status';
  execute 'drop index if exists public.idx_salary_flags_batch_id';
  execute 'drop index if exists public.idx_salary_flags_hr_id';
  execute 'drop index if exists public.idx_salary_records_batch_id';
  execute 'drop index if exists public.idx_salary_records_employee_code';
  execute 'drop index if exists public.idx_salary_records_hr_id';
  execute 'drop index if exists public.idx_sales_records_employee_hr_id_safe';
  execute 'drop index if exists public.idx_sales_records_manager_hr_id_safe';
end $$;
