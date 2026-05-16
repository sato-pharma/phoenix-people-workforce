create or replace function public.fn_get_admin_command_center_data(
  p_access_scope text default 'company',
  p_access_role text default 'Manager',
  p_access_hr_id text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
  v_payroll_batch_id uuid;
  v_payroll_batch_month int;
  v_payroll_batch_year int;
  v_payroll record;
  v_sales record;
  v_expenses record;
  v_recruitment record;
  v_risk record;
  v_hr record;
  v_health record;
  v_allowed_hr_ids text[];
begin
  if p_access_scope = 'system' or p_access_role in ('Super Admin', 'CEO', 'HR Specialist', 'Finance Manager') then
    v_allowed_hr_ids := null;
  elsif p_access_role in ('Regional Manager', 'Regional Sales Manager') then
    select array_agg(hr_id) into v_allowed_hr_ids from public.fn_get_employee_hierarchy(p_access_hr_id);
  else
    v_allowed_hr_ids := array[p_access_hr_id];
  end if;

  select
    count(*) filter (where employment_status in ('active', 'on_leave'))::int as active_employees,
    count(*)::int as total_employees,
    count(distinct line_id)::int as unique_lines,
    count(distinct area_id)::int as unique_areas,
    count(*) filter (where manager_hr_id is null and employment_status in ('active', 'on_leave'))::int as employees_without_managers
  into v_hr
  from public.employees
  where (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));

  select id, month, year
  into v_payroll_batch_id, v_payroll_batch_month, v_payroll_batch_year
  from public.salary_batches
  where status = 'approved'
  order by year desc, month desc
  limit 1;

  if v_payroll_batch_id is not null then
    select
      count(*)::int as employees,
      coalesce(sum(gross_salary), 0)::numeric as gross,
      coalesce(sum(net_salary), 0)::numeric as net,
      (select count(*)::int from public.salary_flags where batch_id = v_payroll_batch_id) as flags
    into v_payroll
    from public.salary_records
    where batch_id = v_payroll_batch_id
      and (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));
  else
    select 0::int as employees, 0::numeric as gross, 0::numeric as net, 0::int as flags
    into v_payroll;
  end if;

  with active_batches as (
    select id from public.sales_import_batches
    where status not in ('rejected', 'replaced')
      and replaced_by_batch_id is null
  )
  select
    coalesce(sum(sales_value), 0)::numeric as sales_value,
    coalesce(sum(target_value), 0)::numeric as target_value,
    case when sum(target_value) > 0 then (sum(sales_value) / sum(target_value) * 100)::numeric else 0 end as achievement_rate,
    count(distinct product)::int as active_products
  into v_sales
  from public.sales_records
  where batch_id in (select id from active_batches)
    and (v_allowed_hr_ids is null or employee_hr_id = any(v_allowed_hr_ids) or manager_hr_id = any(v_allowed_hr_ids));

  select
    coalesce(sum(total), 0)::numeric as total_amount,
    coalesce(sum(case when hr_approved = true then total else 0 end), 0)::numeric as approved_amount,
    count(*)::int as total_rows,
    (select count(*)::int from public.payroll_expense_reports) as report_count
  into v_expenses
  from public.payroll_expenses
  where (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));

  select
    count(*)::int as total_offers,
    count(*) filter (where status = 'sent')::int as pending_offers,
    count(*) filter (where status = 'accepted')::int as accepted_offers,
    count(*) filter (where status = 'rejected')::int as rejected_offers,
    case
      when count(*) filter (where status in ('accepted', 'rejected')) > 0
        then (count(*) filter (where status = 'accepted')::numeric / count(*) filter (where status in ('accepted', 'rejected')) * 100)::numeric
      else 0
    end as acceptance_rate
  into v_recruitment
  from public.job_offers;

  select
    (select count(*)::int from public.employee_contracts where status = 'active' and contract_renewal_date < now() + interval '30 days') as expiring_contracts,
    (select count(*)::int from public.employee_probation where status = 'active' and probation_end_date < now() + interval '14 days') as probation_endings
  into v_risk;

  select
    (case when v_hr.active_employees > 0 then (count(*) filter (where manager_hr_id is not null and (job_title is not null or position_id is not null))::numeric / v_hr.active_employees * 100) else 100 end)::numeric as employee_health_rate,
    (select count(*) from public.sales_records)::int as total_sales_rows,
    (select count(*) from public.sales_records where link_status = 'linked')::int as linked_sales_rows
  into v_health
  from public.employees
  where employment_status in ('active', 'on_leave')
    and (v_allowed_hr_ids is null or hr_id = any(v_allowed_hr_ids));

  v_result := jsonb_build_object(
    'overview', jsonb_build_object(
      'hr', jsonb_build_object(
        'activeEmployees', coalesce(v_hr.active_employees, 0),
        'totalEmployees', coalesce(v_hr.total_employees, 0),
        'uniqueLines', coalesce(v_hr.unique_lines, 0),
        'uniqueAreas', coalesce(v_hr.unique_areas, 0),
        'employeesWithoutManagers', coalesce(v_hr.employees_without_managers, 0)
      ),
      'payroll', jsonb_build_object(
        'batchLabel', coalesce(v_payroll_batch_month::text || '/' || v_payroll_batch_year::text, '—'),
        'employees', coalesce(v_payroll.employees, 0),
        'gross', coalesce(v_payroll.gross, 0),
        'net', coalesce(v_payroll.net, 0),
        'flags', coalesce(v_payroll.flags, 0)
      ),
      'sales', jsonb_build_object(
        'salesValue', coalesce(v_sales.sales_value, 0),
        'targetValue', coalesce(v_sales.target_value, 0),
        'achievementRate', coalesce(v_sales.achievement_rate, 0),
        'activeProducts', coalesce(v_sales.active_products, 0)
      ),
      'expenses', jsonb_build_object(
        'approvedAmount', coalesce(v_expenses.approved_amount, 0),
        'totalAmount', coalesce(v_expenses.total_amount, 0),
        'totalRows', coalesce(v_expenses.total_rows, 0),
        'reportCount', coalesce(v_expenses.report_count, 0)
      ),
      'recruitment', jsonb_build_object(
        'totalOffers', coalesce(v_recruitment.total_offers, 0),
        'pendingOffers', coalesce(v_recruitment.pending_offers, 0),
        'acceptedOffers', coalesce(v_recruitment.accepted_offers, 0),
        'rejectedOffers', coalesce(v_recruitment.rejected_offers, 0),
        'acceptanceRate', coalesce(v_recruitment.acceptance_rate, 0)
      ),
      'risk', jsonb_build_object(
        'expiringContracts', coalesce(v_risk.expiring_contracts, 0),
        'probationEndings', coalesce(v_risk.probation_endings, 0)
      )
    ),
    'health', jsonb_build_object(
      'employeeHealthRate', coalesce(v_health.employee_health_rate, 100),
      'healthyEmployees', greatest(coalesce(v_hr.active_employees, 0) - coalesce(v_hr.employees_without_managers, 0), 0),
      'totalEmployees', coalesce(v_hr.active_employees, 0),
      'missingManager', coalesce(v_hr.employees_without_managers, 0),
      'missingJobTitle', 0,
      'salesLinkageRate', case when coalesce(v_health.total_sales_rows, 0) > 0 then (v_health.linked_sales_rows::numeric / v_health.total_sales_rows * 100) else 100 end,
      'salesLinkageBatch', null
    ),
    'payrollEligibleCount', coalesce((select count(*) from public.employees where payroll_eligible = true), 0),
    'dataUnavailable', '[]'::jsonb
  );

  return v_result;
end;
$$;

notify pgrst, 'reload schema';
