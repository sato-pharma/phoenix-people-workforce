-- Security-first / performance follow-up for Phoenix HR.
-- Bootstrap-safe version: only touch relations/policies that actually exist.

set check_function_bodies = off;

do $$
begin
  -- -------------------------------------------------------------------------
  -- Missing foreign-key indexes observed in the live project
  -- -------------------------------------------------------------------------
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_documents' and column_name = 'employee_hr_id') then
    execute 'create index if not exists employee_documents_employee_hr_id_idx on public.employee_documents (employee_hr_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_documents' and column_name = 'uploaded_by_user_id') then
    execute 'create index if not exists employee_documents_uploaded_by_user_id_idx on public.employee_documents (uploaded_by_user_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_history' and column_name = 'area_id') then
    execute 'create index if not exists employee_history_area_id_idx on public.employee_history (area_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_history' and column_name = 'changed_by_user_id') then
    execute 'create index if not exists employee_history_changed_by_user_id_idx on public.employee_history (changed_by_user_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_history' and column_name = 'department_id') then
    execute 'create index if not exists employee_history_department_id_idx on public.employee_history (department_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_history' and column_name = 'line_id') then
    execute 'create index if not exists employee_history_line_id_idx on public.employee_history (line_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_history' and column_name = 'position_id') then
    execute 'create index if not exists employee_history_position_id_idx on public.employee_history (position_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_history' and column_name = 'team_id') then
    execute 'create index if not exists employee_history_team_id_idx on public.employee_history (team_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_resignations' and column_name = 'submitted_by_hr_id') then
    execute 'create index if not exists employee_resignations_submitted_by_hr_id_idx on public.employee_resignations (submitted_by_hr_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_resignations' and column_name = 'vacancy_id') then
    execute 'create index if not exists employee_resignations_vacancy_id_idx on public.employee_resignations (vacancy_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'position_id') then
    execute 'create index if not exists employees_position_id_idx on public.employees (position_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'team_id') then
    execute 'create index if not exists employees_team_id_idx on public.employees (team_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'area_id') then
    execute 'create index if not exists job_offers_area_id_idx on public.job_offers (area_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'created_by_hr_id') then
    execute 'create index if not exists job_offers_created_by_hr_id_idx on public.job_offers (created_by_hr_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'department_id') then
    execute 'create index if not exists job_offers_department_id_idx on public.job_offers (department_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'employee_hr_id') then
    execute 'create index if not exists job_offers_employee_hr_id_idx on public.job_offers (employee_hr_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'line_id') then
    execute 'create index if not exists job_offers_line_id_idx on public.job_offers (line_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'manager_hr_id') then
    execute 'create index if not exists job_offers_manager_hr_id_idx on public.job_offers (manager_hr_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_offers' and column_name = 'position_id') then
    execute 'create index if not exists job_offers_position_id_idx on public.job_offers (position_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'sender_id') then
    execute 'create index if not exists messages_sender_id_idx on public.messages (sender_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name = 'updated_by_user_id') then
    execute 'create index if not exists platform_settings_updated_by_user_id_idx on public.platform_settings (updated_by_user_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'position_vacancies' and column_name = 'area_id') then
    execute 'create index if not exists position_vacancies_area_id_idx on public.position_vacancies (area_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'position_vacancies' and column_name = 'position_id') then
    execute 'create index if not exists position_vacancies_position_id_idx on public.position_vacancies (position_id)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'position_vacancies' and column_name = 'team_id') then
    execute 'create index if not exists position_vacancies_team_id_idx on public.position_vacancies (team_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'positions' and column_name = 'team_id') then
    execute 'create index if not exists positions_team_id_idx on public.positions (team_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_audit_logs' and column_name = 'actor_user_id') then
    execute 'create index if not exists system_audit_logs_actor_user_id_idx on public.system_audit_logs (actor_user_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'teams' and column_name = 'area_id') then
    execute 'create index if not exists teams_area_id_idx on public.teams (area_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_roles' and column_name = 'assigned_by_user_id') then
    execute 'create index if not exists user_roles_assigned_by_user_id_idx on public.user_roles (assigned_by_user_id)';
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'employee_hr_id') then
    execute 'create index if not exists users_employee_hr_id_idx on public.users (employee_hr_id)';
  end if;

  -- -------------------------------------------------------------------------
  -- Consolidate overlapping permissive RLS policies
  -- -------------------------------------------------------------------------
  if to_regclass('public.employee_compensation') is not null then
    execute 'drop policy if exists employee_compensation_hr_admin_write on public.employee_compensation';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_compensation' and policyname = 'employee_compensation_hr_admin_insert') then
      execute 'create policy employee_compensation_hr_admin_insert on public.employee_compensation for insert to authenticated with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_compensation' and policyname = 'employee_compensation_hr_admin_update') then
      execute 'create policy employee_compensation_hr_admin_update on public.employee_compensation for update to authenticated using (current_access_can_manage_employees()) with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employee_compensation' and policyname = 'employee_compensation_hr_admin_delete') then
      execute 'create policy employee_compensation_hr_admin_delete on public.employee_compensation for delete to authenticated using (current_access_can_manage_employees())';
    end if;
  end if;

  if to_regclass('public.employees') is not null then
    execute 'drop policy if exists employees_insert_own_hr on public.employees';
    execute 'drop policy if exists employees_update_own_hr on public.employees';
    execute 'drop policy if exists employees_delete_own_hr on public.employees';
    execute 'drop policy if exists employees_hr_admin_write on public.employees';
    if to_regclass('public.users') is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_insert_self_or_admin') then
      execute 'create policy employees_insert_self_or_admin on public.employees for insert to authenticated with check (current_access_can_manage_employees() or hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
    end if;
    if to_regclass('public.users') is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_update_self_or_admin') then
      execute 'create policy employees_update_self_or_admin on public.employees for update to authenticated using (current_access_can_manage_employees() or hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid()))) with check (current_access_can_manage_employees() or hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
    end if;
    if to_regclass('public.users') is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'employees' and policyname = 'employees_delete_self_or_admin') then
      execute 'create policy employees_delete_self_or_admin on public.employees for delete to authenticated using (current_access_can_manage_employees() or hr_id = (select u.hr_id from public.users u where u.id = (select auth.uid())))';
    end if;
  end if;

  if to_regclass('public.payroll_expense_reports') is not null then
    execute 'drop policy if exists payroll_expense_reports_hr_admin_write on public.payroll_expense_reports';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expense_reports' and policyname = 'payroll_expense_reports_hr_admin_insert') then
      execute 'create policy payroll_expense_reports_hr_admin_insert on public.payroll_expense_reports for insert to authenticated with check (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text]))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expense_reports' and policyname = 'payroll_expense_reports_hr_admin_update') then
      execute 'create policy payroll_expense_reports_hr_admin_update on public.payroll_expense_reports for update to authenticated using (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text])) with check (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text]))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expense_reports' and policyname = 'payroll_expense_reports_hr_admin_delete') then
      execute 'create policy payroll_expense_reports_hr_admin_delete on public.payroll_expense_reports for delete to authenticated using (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text]))';
    end if;
  end if;

  if to_regclass('public.payroll_expenses') is not null then
    execute 'drop policy if exists payroll_expenses_hr_admin_write on public.payroll_expenses';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expenses' and policyname = 'payroll_expenses_hr_admin_insert') then
      execute 'create policy payroll_expenses_hr_admin_insert on public.payroll_expenses for insert to authenticated with check (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text]))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expenses' and policyname = 'payroll_expenses_hr_admin_update') then
      execute 'create policy payroll_expenses_hr_admin_update on public.payroll_expenses for update to authenticated using (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text])) with check (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text]))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payroll_expenses' and policyname = 'payroll_expenses_hr_admin_delete') then
      execute 'create policy payroll_expenses_hr_admin_delete on public.payroll_expenses for delete to authenticated using (current_access_role() = any (array[''admin''::text, ''hr''::text, ''manager''::text]))';
    end if;
  end if;

  if to_regclass('public.salary_batches') is not null then
    execute 'drop policy if exists salary_batches_hr_admin_write on public.salary_batches';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_batches' and policyname = 'salary_batches_hr_admin_insert') then
      execute 'create policy salary_batches_hr_admin_insert on public.salary_batches for insert to authenticated with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_batches' and policyname = 'salary_batches_hr_admin_update') then
      execute 'create policy salary_batches_hr_admin_update on public.salary_batches for update to authenticated using (current_access_can_manage_employees()) with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_batches' and policyname = 'salary_batches_hr_admin_delete') then
      execute 'create policy salary_batches_hr_admin_delete on public.salary_batches for delete to authenticated using (current_access_can_manage_employees())';
    end if;
  end if;

  if to_regclass('public.salary_flags') is not null then
    execute 'drop policy if exists salary_flags_hr_admin_write on public.salary_flags';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_flags' and policyname = 'salary_flags_hr_admin_insert') then
      execute 'create policy salary_flags_hr_admin_insert on public.salary_flags for insert to authenticated with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_flags' and policyname = 'salary_flags_hr_admin_update') then
      execute 'create policy salary_flags_hr_admin_update on public.salary_flags for update to authenticated using (current_access_can_manage_employees()) with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_flags' and policyname = 'salary_flags_hr_admin_delete') then
      execute 'create policy salary_flags_hr_admin_delete on public.salary_flags for delete to authenticated using (current_access_can_manage_employees())';
    end if;
  end if;

  if to_regclass('public.salary_records') is not null then
    execute 'drop policy if exists salary_records_hr_admin_write on public.salary_records';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_records' and policyname = 'salary_records_hr_admin_insert') then
      execute 'create policy salary_records_hr_admin_insert on public.salary_records for insert to authenticated with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_records' and policyname = 'salary_records_hr_admin_update') then
      execute 'create policy salary_records_hr_admin_update on public.salary_records for update to authenticated using (current_access_can_manage_employees()) with check (current_access_can_manage_employees())';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'salary_records' and policyname = 'salary_records_hr_admin_delete') then
      execute 'create policy salary_records_hr_admin_delete on public.salary_records for delete to authenticated using (current_access_can_manage_employees())';
    end if;
  end if;

  if to_regclass('public.sales_records') is not null then
    execute 'drop policy if exists sales_records_hr_admin_write on public.sales_records';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'sales_records_hr_admin_insert') then
      execute 'create policy sales_records_hr_admin_insert on public.sales_records for insert to authenticated with check (current_access_role() = any (array[''admin''::text, ''hr''::text]))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'sales_records_hr_admin_update') then
      execute 'create policy sales_records_hr_admin_update on public.sales_records for update to authenticated using (current_access_role() = any (array[''admin''::text, ''hr''::text])) with check (current_access_role() = any (array[''admin''::text, ''hr''::text]))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales_records' and policyname = 'sales_records_hr_admin_delete') then
      execute 'create policy sales_records_hr_admin_delete on public.sales_records for delete to authenticated using (current_access_role() = any (array[''admin''::text, ''hr''::text]))';
    end if;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    execute 'drop policy if exists user_access_profiles_admin_write on public.user_access_profiles';
    execute 'drop policy if exists uap_update_own on public.user_access_profiles';
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_access_profiles' and policyname = 'user_access_profiles_insert_admin') then
      execute 'create policy user_access_profiles_insert_admin on public.user_access_profiles for insert to authenticated with check (current_access_role() = ''admin''::text)';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_access_profiles' and policyname = 'user_access_profiles_update_self_or_admin') then
      execute 'create policy user_access_profiles_update_self_or_admin on public.user_access_profiles for update to authenticated using (current_access_role() = ''admin''::text or auth_user_id = (select auth.uid())) with check (current_access_role() = ''admin''::text or auth_user_id = (select auth.uid()))';
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_access_profiles' and policyname = 'user_access_profiles_delete_admin') then
      execute 'create policy user_access_profiles_delete_admin on public.user_access_profiles for delete to authenticated using (current_access_role() = ''admin''::text)';
    end if;
  end if;
end $$;
