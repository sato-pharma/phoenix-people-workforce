-- Low-risk Supabase performance-advisor cleanup.
-- These statements remove redundant standalone indexes and duplicate
-- service-role policies. They do not delete data, tables, or constraints.

drop index if exists public.idx_areas_line_id;
drop index if exists public.coaching_report_acknowledgments_report_id_idx;
drop index if exists public.email_template_rules_template_key_idx;
drop index if exists public.email_templates_template_key_idx;
drop index if exists public.employees_hr_id_idx;
drop index if exists public.payroll_expenses_hr_id_idx;
drop index if exists public.salary_batches_period_idx;
drop index if exists public.salary_flags_hr_id_idx;
drop index if exists public.salary_records_hr_id_idx;
drop index if exists public.idx_sales_audit_logs_batch_id;
drop index if exists public.idx_sales_records_employee_hr_id_safe;
drop index if exists public.sales_records_hr_period_idx;
drop index if exists public.idx_sales_records_manager_hr_id_safe;
drop index if exists public.user_access_profiles_hr_id_idx;
drop index if exists public.v2_vacation_weekly_off_policies_title_idx;
do $$
begin
  if to_regclass('public.email_templates') is not null then
    drop policy if exists email_templates_service_role on public.email_templates;
  end if;

  if to_regclass('public.employee_probation') is not null then
    drop policy if exists employee_probation_service_role on public.employee_probation;
  end if;

  if to_regclass('public.position_vacancies') is not null then
    drop policy if exists position_vacancies_service_role_all on public.position_vacancies;
  end if;

  if to_regclass('public.probation_evaluations') is not null then
    drop policy if exists probation_evaluations_service_role_all on public.probation_evaluations;
  end if;

  if to_regclass('public.role_permission_overrides') is not null then
    drop policy if exists role_permission_overrides_service_role_all on public.role_permission_overrides;
  end if;
end $$;
