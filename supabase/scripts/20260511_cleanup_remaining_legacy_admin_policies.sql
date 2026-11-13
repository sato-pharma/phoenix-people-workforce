-- Phoenix Workforce role-alignment cleanup.
-- Removes legacy write policies that still reference current_access_role() admin/hr/manager groups.
-- Replacement explicit helper policies are created by 20260511_phoenix_role_alignment.sql.

begin;

drop policy if exists payroll_expenses_hr_admin_insert on public.payroll_expenses;
drop policy if exists payroll_expenses_hr_admin_update on public.payroll_expenses;
drop policy if exists payroll_expenses_hr_admin_delete on public.payroll_expenses;

drop policy if exists payroll_expense_reports_hr_admin_insert on public.payroll_expense_reports;
drop policy if exists payroll_expense_reports_hr_admin_update on public.payroll_expense_reports;
drop policy if exists payroll_expense_reports_hr_admin_delete on public.payroll_expense_reports;

drop policy if exists sales_records_hr_admin_insert on public.sales_records;
drop policy if exists sales_records_hr_admin_update on public.sales_records;
drop policy if exists sales_records_hr_admin_delete on public.sales_records;

notify pgrst, 'reload schema';

commit;
