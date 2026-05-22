create or replace function public.fn_get_command_center_metrics()
returns jsonb
language plpgsql
as $function$
declare
  v_result jsonb;
  v_payroll_batch record;
  v_payroll record;
  v_sales record;
  v_expenses record;
  v_recruitment record;
  v_risk record;
begin
  select id, month, year into v_payroll_batch
  from public.salary_batches
  order by year desc, month desc
  limit 1;

  if v_payroll_batch.id is not null then
    select
      count(*)::int as employees,
      coalesce(sum(gross_salary), 0)::numeric as gross,
      coalesce(sum(net_salary), 0)::numeric as net,
      (select count(*)::int from public.salary_flags where batch_id = v_payroll_batch.id) as flags
    into v_payroll
    from public.salary_records
    where batch_id = v_payroll_batch.id;
  end if;

  select
    coalesce(sum(sales_value), 0)::numeric as sales_value,
    coalesce(sum(target_value), 0)::numeric as target_value,
    case
      when coalesce(sum(target_value), 0) > 0
        then (sum(sales_value) / sum(target_value) * 100)::numeric
      else 0
    end as achievement_rate
  into v_sales
  from public.sales_records;

  select
    coalesce(sum(claimed_total_amount), 0)::numeric as total_amount,
    coalesce(sum(case when status = 'approved' then claimed_total_amount else 0 end), 0)::numeric as approved_amount,
    count(*)::int as report_count
  into v_expenses
  from public.outstation_expense_requests;

  select
    count(*)::int as total_offers,
    count(*) filter (where status = 'sent')::int as pending_offers,
    count(*) filter (where status = 'accepted')::int as accepted_offers,
    count(*) filter (where status = 'rejected')::int as rejected_offers,
    case
      when count(*) > 0
        then (count(*) filter (where status = 'accepted')::numeric / count(*) * 100)::numeric
      else 0
    end as acceptance_rate
  into v_recruitment
  from public.job_offers;

  select
    (select count(*)::int from public.employees where employment_status = 'active' and hire_date is not null) as active_employees,
    (
      select count(*)::int
      from public.employee_contracts
      where status = 'active'
        and coalesce(contract_renewal_date, contract_end_date) < now() + interval '30 days'
    ) as expiring_contracts,
    (
      select count(*)::int
      from public.employee_probation
      where status = 'active'
        and probation_end_date < now() + interval '14 days'
    ) as probation_endings
  into v_risk;

  v_result = jsonb_build_object(
    'hr', jsonb_build_object(
      'activeEmployees', coalesce(v_risk.active_employees, 0),
      'totalEmployees', (select count(*)::int from public.employees)
    ),
    'payroll', jsonb_build_object(
      'batchLabel', coalesce(v_payroll_batch.month::text || '/' || v_payroll_batch.year::text, '-'),
      'employees', coalesce(v_payroll.employees, 0),
      'gross', coalesce(v_payroll.gross, 0),
      'net', coalesce(v_payroll.net, 0),
      'flags', coalesce(v_payroll.flags, 0)
    ),
    'sales', jsonb_build_object(
      'salesValue', coalesce(v_sales.sales_value, 0),
      'targetValue', coalesce(v_sales.target_value, 0),
      'achievementRate', coalesce(v_sales.achievement_rate, 0)
    ),
    'expenses', jsonb_build_object(
      'approvedAmount', coalesce(v_expenses.approved_amount, 0),
      'totalAmount', coalesce(v_expenses.total_amount, 0),
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
  );

  return v_result;
end;
$function$;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.phx_reassign_replacement_ownership(text,text,date)'::regprocedure)
  into v_definition;

  if v_definition is null then
    return;
  end if;

  v_definition := replace(
    v_definition,
    'when undefined_column then
        v_result := v_result || jsonb_build_object(''sales_targets_reassigned'', null);',
    'when undefined_table or undefined_column then
        v_result := v_result || jsonb_build_object(''sales_targets_reassigned'', null);'
  );

  execute v_definition;
end $$;

notify pgrst, 'reload schema';
