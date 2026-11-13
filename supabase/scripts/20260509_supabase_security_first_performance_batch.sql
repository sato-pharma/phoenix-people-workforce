-- Security-first / performance follow-up for Phoenix HR.
-- 1. Security: leaked-password protection must be enabled in Supabase Auth settings.
--    That project setting is not controlled by SQL, so this migration covers the
--    database-side performance cleanup only.
-- 2. Performance: add genuinely missing FK indexes and remove overlapping
--    permissive RLS policies by splitting broad ALL policies into command-specific
--    write policies.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- Missing foreign-key indexes observed in the live project
-- ---------------------------------------------------------------------------

create index if not exists employee_documents_employee_hr_id_idx
on public.employee_documents (employee_hr_id);

create index if not exists employee_documents_uploaded_by_user_id_idx
on public.employee_documents (uploaded_by_user_id);

create index if not exists employee_history_area_id_idx
on public.employee_history (area_id);

create index if not exists employee_history_changed_by_user_id_idx
on public.employee_history (changed_by_user_id);

create index if not exists employee_history_department_id_idx
on public.employee_history (department_id);

create index if not exists employee_history_line_id_idx
on public.employee_history (line_id);

create index if not exists employee_history_position_id_idx
on public.employee_history (position_id);

create index if not exists employee_history_team_id_idx
on public.employee_history (team_id);

create index if not exists employee_resignations_submitted_by_hr_id_idx
on public.employee_resignations (submitted_by_hr_id);

create index if not exists employee_resignations_vacancy_id_idx
on public.employee_resignations (vacancy_id);

create index if not exists employees_position_id_idx
on public.employees (position_id);

create index if not exists employees_team_id_idx
on public.employees (team_id);

create index if not exists job_offers_area_id_idx
on public.job_offers (area_id);

create index if not exists job_offers_created_by_hr_id_idx
on public.job_offers (created_by_hr_id);

create index if not exists job_offers_department_id_idx
on public.job_offers (department_id);

create index if not exists job_offers_employee_hr_id_idx
on public.job_offers (employee_hr_id);

create index if not exists job_offers_line_id_idx
on public.job_offers (line_id);

create index if not exists job_offers_manager_hr_id_idx
on public.job_offers (manager_hr_id);

create index if not exists job_offers_position_id_idx
on public.job_offers (position_id);

create index if not exists messages_sender_id_idx
on public.messages (sender_id);

create index if not exists platform_settings_updated_by_user_id_idx
on public.platform_settings (updated_by_user_id);

create index if not exists position_vacancies_area_id_idx
on public.position_vacancies (area_id);

create index if not exists position_vacancies_position_id_idx
on public.position_vacancies (position_id);

create index if not exists position_vacancies_team_id_idx
on public.position_vacancies (team_id);

create index if not exists positions_team_id_idx
on public.positions (team_id);

create index if not exists system_audit_logs_actor_user_id_idx
on public.system_audit_logs (actor_user_id);

create index if not exists teams_area_id_idx
on public.teams (area_id);

create index if not exists user_roles_assigned_by_user_id_idx
on public.user_roles (assigned_by_user_id);

create index if not exists users_employee_hr_id_idx
on public.users (employee_hr_id);

-- ---------------------------------------------------------------------------
-- Consolidate overlapping permissive RLS policies
-- ---------------------------------------------------------------------------

drop policy if exists employee_compensation_hr_admin_write
on public.employee_compensation;

create policy employee_compensation_hr_admin_insert
on public.employee_compensation
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy employee_compensation_hr_admin_update
on public.employee_compensation
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy employee_compensation_hr_admin_delete
on public.employee_compensation
for delete
to authenticated
using (current_access_can_manage_employees());

drop policy if exists employees_insert_own_hr
on public.employees;

drop policy if exists employees_update_own_hr
on public.employees;

drop policy if exists employees_delete_own_hr
on public.employees;

drop policy if exists employees_hr_admin_write
on public.employees;

create policy employees_insert_self_or_admin
on public.employees
for insert
to authenticated
with check (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
);

create policy employees_update_self_or_admin
on public.employees
for update
to authenticated
using (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
)
with check (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
);

create policy employees_delete_self_or_admin
on public.employees
for delete
to authenticated
using (
  current_access_can_manage_employees()
  or hr_id = (
    select u.hr_id
    from public.users u
    where u.id = (select auth.uid())
  )
);

drop policy if exists payroll_expense_reports_hr_admin_write
on public.payroll_expense_reports;

create policy payroll_expense_reports_hr_admin_insert
on public.payroll_expense_reports
for insert
to authenticated
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expense_reports_hr_admin_update
on public.payroll_expense_reports
for update
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]))
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expense_reports_hr_admin_delete
on public.payroll_expense_reports
for delete
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

drop policy if exists payroll_expenses_hr_admin_write
on public.payroll_expenses;

create policy payroll_expenses_hr_admin_insert
on public.payroll_expenses
for insert
to authenticated
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expenses_hr_admin_update
on public.payroll_expenses
for update
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]))
with check (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

create policy payroll_expenses_hr_admin_delete
on public.payroll_expenses
for delete
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text, 'manager'::text]));

drop policy if exists salary_batches_hr_admin_write
on public.salary_batches;

create policy salary_batches_hr_admin_insert
on public.salary_batches
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy salary_batches_hr_admin_update
on public.salary_batches
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy salary_batches_hr_admin_delete
on public.salary_batches
for delete
to authenticated
using (current_access_can_manage_employees());

drop policy if exists salary_flags_hr_admin_write
on public.salary_flags;

create policy salary_flags_hr_admin_insert
on public.salary_flags
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy salary_flags_hr_admin_update
on public.salary_flags
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy salary_flags_hr_admin_delete
on public.salary_flags
for delete
to authenticated
using (current_access_can_manage_employees());

drop policy if exists salary_records_hr_admin_write
on public.salary_records;

create policy salary_records_hr_admin_insert
on public.salary_records
for insert
to authenticated
with check (current_access_can_manage_employees());

create policy salary_records_hr_admin_update
on public.salary_records
for update
to authenticated
using (current_access_can_manage_employees())
with check (current_access_can_manage_employees());

create policy salary_records_hr_admin_delete
on public.salary_records
for delete
to authenticated
using (current_access_can_manage_employees());

drop policy if exists sales_records_hr_admin_write
on public.sales_records;

create policy sales_records_hr_admin_insert
on public.sales_records
for insert
to authenticated
with check (current_access_role() = any (array['admin'::text, 'hr'::text]));

create policy sales_records_hr_admin_update
on public.sales_records
for update
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text]))
with check (current_access_role() = any (array['admin'::text, 'hr'::text]));

create policy sales_records_hr_admin_delete
on public.sales_records
for delete
to authenticated
using (current_access_role() = any (array['admin'::text, 'hr'::text]));

drop policy if exists user_access_profiles_admin_write
on public.user_access_profiles;

drop policy if exists uap_update_own
on public.user_access_profiles;

create policy user_access_profiles_insert_admin
on public.user_access_profiles
for insert
to authenticated
with check (current_access_role() = 'admin'::text);

create policy user_access_profiles_update_self_or_admin
on public.user_access_profiles
for update
to authenticated
using (
  current_access_role() = 'admin'::text
  or auth_user_id = (select auth.uid())
)
with check (
  current_access_role() = 'admin'::text
  or auth_user_id = (select auth.uid())
);

create policy user_access_profiles_delete_admin
on public.user_access_profiles
for delete
to authenticated
using (current_access_role() = 'admin'::text);
