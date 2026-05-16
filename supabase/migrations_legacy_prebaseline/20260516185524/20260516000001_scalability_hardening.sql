-- Scalability Hardening and Enterprise Performance Refactor
-- Date: 2026-05-16

-- 1. UNIFIED AUDIT LOG VIEW
-- Solves the "memory-heavy cross-table audit fetch" problem.
-- Moves normalization, filtering, and sorting to the database layer.
drop view if exists public.v_unified_audit_logs;
create or replace view public.v_unified_audit_logs as
select
  'audit_logs' as source,
  id::text,
  actor_login_id as actor_id,
  'system' as actor_type,
  entity_type,
  entity_id,
  summary as action,
  summary,
  new_values as metadata,
  created_at,
  case
    when summary ilike '%reject%' then 'rejected'
    when summary ilike '%fail%' or summary ilike '%error%' then 'failed'
    when summary ilike '%approve%' then 'approved'
    when summary ilike '%success%' or summary ilike '%succeed%' or summary ilike '%sent%' or summary ilike '%accepted%' then 'succeeded'
    else 'changed'
  end as status,
  case
    when entity_type = 'auth_session' then 'auth'
    when entity_type in ('permission_override', 'salary_flag', 'user') then 'access'
    when entity_type = 'coaching_report' then 'coaching'
    else 'governance'
  end as module
from public.audit_logs

union all

select
  'sales_audit_logs' as source,
  id::text,
  coalesce(actor_username, 'system') as actor_id,
  'user' as actor_type,
  'sales_import' as entity_type,
  batch_id::text as entity_id,
  action,
  action as summary,
  metadata || jsonb_build_object('line', line, 'period', period) as metadata,
  created_at,
  case
    when action ilike '%reject%' then 'rejected'
    when action ilike '%fail%' or action ilike '%error%' then 'failed'
    when action ilike '%approve%' then 'approved'
    else 'succeeded'
  end as status,
  'sales' as module
from public.sales_audit_logs

union all

select
  'job_offer_audit_logs' as source,
  id::text,
  actor_reference as actor_id,
  actor_type,
  'job_offer' as entity_type,
  offer_id::text as entity_id,
  action,
  action as summary,
  details as metadata,
  created_at,
  case
    when action ilike '%reject%' then 'rejected'
    when action ilike '%fail%' or action ilike '%error%' then 'failed'
    when action ilike '%approve%' then 'approved'
    else 'succeeded'
  end as status,
  'recruitment' as module
from public.job_offer_audit_logs

union all

select
  'coaching_report_audit_logs' as source,
  id::text,
  actor_hr_id as actor_id,
  'employee' as actor_type,
  'coaching_report' as entity_type,
  report_id::text as entity_id,
  action,
  action as summary,
  metadata || jsonb_build_object('old_values', old_values, 'new_values', new_values) as metadata,
  created_at,
  case
    when action ilike '%reject%' then 'rejected'
    when action ilike '%fail%' or action ilike '%error%' then 'failed'
    when action ilike '%approve%' then 'approved'
    else 'succeeded'
  end as status,
  'coaching' as module
from public.coaching_report_audit_logs

union all

select
  'outstation_location_audit_logs' as source,
  id::text,
  employee_hr_id as actor_id,
  'employee' as actor_type,
  'outstation_location' as entity_type,
  expense_request_id::text as entity_id,
  validation_result as action,
  validation_reason as summary,
  fraud_flags_json as metadata,
  created_at,
  validation_result as status,
  'outstation' as module
from public.outstation_location_audit_logs;

-- 2. EMPLOYEE HIERARCHY RECURSIVE FUNCTION
-- Solves the "JS-side hierarchy building" problem for 10k+ employees.
create or replace function public.fn_get_employee_hierarchy(p_root_hr_id text)
returns table (hr_id text, depth int)
language plpgsql
as $$
begin
  return query
  with recursive employee_tree as (
    -- Anchor member
    select e.hr_id, 1 as depth
    from public.employees e
    where e.hr_id = p_root_hr_id

    union all

    -- Recursive member
    select e.hr_id, t.depth + 1
    from public.employees e
    inner join employee_tree t on e.manager_hr_id = t.hr_id
    where t.depth < 20 -- Safety limit
  )
  select et.hr_id, et.depth from employee_tree et;
end;
$$;

-- 3. ANALYTICS RPCs (COMMAND CENTER)
-- Solves "JS-side heavy aggregations" and "silent truncation" issues.

create or replace function public.fn_get_command_center_metrics()
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
  v_payroll_batch record;
  v_payroll record;
  v_sales record;
  v_expenses record;
  v_recruitment record;
  v_risk record;
begin
  -- Latest Payroll
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

  -- Sales Summary
  select
    coalesce(sum(sales_value), 0)::numeric as sales_value,
    coalesce(sum(target_value), 0)::numeric as target_value,
    case when sum(target_value) > 0 then (sum(sales_value) / sum(target_value) * 100)::numeric else 0 end as achievement_rate
  into v_sales
  from public.sales_records;

  -- Expenses Summary
  select
    coalesce(sum(claimed_total_amount), 0)::numeric as total_amount,
    coalesce(sum(case when status = 'approved' then claimed_total_amount else 0 end), 0)::numeric as approved_amount,
    count(*)::int as report_count
  into v_expenses
  from public.outstation_expense_requests;

  -- Recruitment Summary
  select
    count(*)::int as total_offers,
    count(*) filter (where status = 'sent')::int as pending_offers,
    count(*) filter (where status = 'accepted')::int as accepted_offers,
    count(*) filter (where status = 'rejected')::int as rejected_offers,
    case when count(*) > 0 then (count(*) filter (where status = 'accepted')::numeric / count(*) * 100)::numeric else 0 end as acceptance_rate
  into v_recruitment
  from public.job_offers;

  -- Risk Metrics
  select
    (select count(*)::int from public.employees where employment_status = 'active' and hire_date is not null) as active_employees,
    (select count(*)::int from public.employee_contracts where status = 'active' and end_date < now() + interval '30 days') as expiring_contracts,
    (select count(*)::int from public.employee_probation where status = 'active' and end_date < now() + interval '14 days') as probation_endings
  into v_risk;

  v_result = jsonb_build_object(
    'hr', jsonb_build_object(
      'activeEmployees', v_risk.active_employees,
      'totalEmployees', (select count(*)::int from public.employees)
    ),
    'payroll', jsonb_build_object(
      'batchLabel', coalesce(v_payroll_batch.month::text || '/' || v_payroll_batch.year::text, '—'),
      'employees', coalesce(v_payroll.employees, 0),
      'gross', coalesce(v_payroll.gross, 0),
      'net', coalesce(v_payroll.net, 0),
      'flags', coalesce(v_payroll.flags, 0)
    ),
    'sales', jsonb_build_object(
      'salesValue', v_sales.sales_value,
      'targetValue', v_sales.target_value,
      'achievementRate', v_sales.achievement_rate
    ),
    'expenses', jsonb_build_object(
      'approvedAmount', v_expenses.approved_amount,
      'totalAmount', v_expenses.total_amount,
      'reportCount', v_expenses.report_count
    ),
    'recruitment', jsonb_build_object(
      'totalOffers', v_recruitment.total_offers,
      'pendingOffers', v_recruitment.pending_offers,
      'acceptedOffers', v_recruitment.accepted_offers,
      'rejectedOffers', v_recruitment.rejected_offers,
      'acceptanceRate', v_recruitment.acceptance_rate
    ),
    'risk', jsonb_build_object(
      'expiringContracts', v_risk.expiring_contracts,
      'probationEndings', v_risk.probation_endings
    )
  );

  return v_result;
end;
$$;

-- 4. AUDIT MODULE COUNTS RPC
create or replace function public.fn_get_audit_module_counts()
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'total', count(*),
    'auth', count(*) filter (where module = 'auth'),
    'access', count(*) filter (where module = 'access'),
    'coaching', count(*) filter (where module = 'coaching'),
    'recruitment', count(*) filter (where module = 'recruitment'),
    'outstation', count(*) filter (where module = 'outstation'),
    'sales', count(*) filter (where module = 'sales'),
    'governance', count(*) filter (where module = 'governance')
  ) into v_result
  from public.v_unified_audit_logs;
  
  return v_result;
end;
$$;

-- 5. BROKEN AUTH ACCOUNTS RPC
create or replace function public.fn_get_broken_auth_accounts()
returns text[]
language plpgsql
as $$
begin
  return array(
    select a.login_id
    from public.app_auth_users a
    where a.auth_user_id is not null
    and not exists (
      select 1 
      from public.user_access_profiles p 
      where p.auth_user_id = a.auth_user_id
    )
  );
end;
$$;

-- 6. MISSING INDEXES FOR PERFORMANCE
-- High-volume query optimization.

-- Audit Logs
create index if not exists idx_audit_logs_actor_entity on public.audit_logs (actor_login_id, entity_type, entity_id);
create index if not exists idx_sales_audit_batch on public.sales_audit_logs (batch_id);
create index if not exists idx_coaching_audit_report on public.coaching_report_audit_logs (report_id);

-- Employees & Hierarchy
create index if not exists idx_employees_composite_search on public.employees (full_name, hr_id, employment_status);
create index if not exists idx_employees_manager_status on public.employees (manager_hr_id, employment_status);

-- Payroll & Financials
create index if not exists idx_salary_records_batch_gross_net on public.salary_records (batch_id, gross_salary, net_salary);
create index if not exists idx_salary_records_hr_created on public.salary_records (hr_id, created_at desc);

-- Sales
create index if not exists idx_sales_records_batch_values on public.sales_records (batch_id, sales_value, target_value);
create index if not exists idx_sales_records_employee_period on public.sales_records (employee_hr_id, year, month);

-- Requests & Workflows
create index if not exists idx_outstation_requests_status_hr on public.outstation_expense_requests (status, employee_hr_id);
create index if not exists idx_job_offers_status_expires on public.job_offers (status, expires_at);

notify pgrst, 'reload schema';
