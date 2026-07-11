-- Public views in exposed schemas can bypass underlying table RLS unless they
-- run as the invoking role. Keep this migration defensive because some of these
-- views only exist in environments that previously received manual SQL scripts.
do $$
declare
  view_name text;
begin
  foreach view_name in array array[
    'public.v_active_organogram',
    'public.v_payroll_eligible_employees',
    'public.v_lifecycle_dashboard',
    'public.v_hr_id_orphan_audit',
    'public.v_employee_portal_salary_history',
    'public.v_employee_portal_sales',
    'public.v_employee_locations_masked',
    'public.employee_linkage_health',
    'public.employee_linkage_health_summary',
    'public.sales_employee_linkage_health',
    'public.sales_employee_linkage_health_summary',
    'public.coaching_reports_summary',
    'public.coaching_quarterly_summary'
  ] loop
    if to_regclass(view_name) is not null then
      execute format('alter view %s set (security_invoker = true)', view_name);
    end if;
  end loop;
end $$;
