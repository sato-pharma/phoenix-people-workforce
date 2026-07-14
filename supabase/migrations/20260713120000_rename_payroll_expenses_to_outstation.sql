-- APPLIED to production (confirmed 2026-07-14 via list_migrations + table
-- inspection: public.outstation_expenses / public.outstation_expense_reports
-- exist with the renamed constraint/index/policy names below; payroll_expenses /
-- payroll_expense_reports no longer exist). The application code was NOT updated
-- in lockstep when this ran, which broke every payroll_expenses/payroll_expense_reports
-- query app-wide (Employee 360, the Outstation Expenses admin module, action
-- center, system cleanup, admin overview counts, geocode warmup) until that was
-- fixed in a follow-up commit — see PR #1061.
--
-- Renames the expense storage tables from payroll ownership to outstation
-- ownership, matching the code-level module move (expenses.ts, expense-metrics.ts,
-- expense-import.ts relocated from src/lib/payroll/ to src/lib/outstation/, and the
-- admin UI/API moved from /payroll/expenses* to /admin/outstation/expenses*).
--
-- Business behavior is UNCHANGED: approved expenses still lag one calendar month
-- and land in payroll Part 2 via phx_import_approved_expenses_to_payroll (owner
-- rule, see src/lib/payroll/copilot/expense-review.ts). Only identifiers move;
-- no RLS predicate, column, or trigger logic changes.

-- ── Tables ───────────────────────────────────────────────────────────────────
ALTER TABLE public.payroll_expense_reports RENAME TO outstation_expense_reports;
ALTER TABLE public.payroll_expenses RENAME TO outstation_expenses;

-- ── Constraints (cosmetic rename for consistency; behavior unchanged) ──────────
ALTER TABLE public.outstation_expense_reports
  RENAME CONSTRAINT payroll_expense_reports_pkey TO outstation_expense_reports_pkey;

ALTER TABLE public.outstation_expenses
  RENAME CONSTRAINT payroll_expenses_pkey TO outstation_expenses_pkey;
ALTER TABLE public.outstation_expenses
  RENAME CONSTRAINT payroll_expenses_trip_id_key TO outstation_expenses_trip_id_key;
ALTER TABLE public.outstation_expenses
  RENAME CONSTRAINT payroll_expenses_hr_id_fkey TO outstation_expenses_hr_id_fkey;
ALTER TABLE public.outstation_expenses
  RENAME CONSTRAINT payroll_expenses_imported_payroll_batch_id_fkey TO outstation_expenses_imported_payroll_batch_id_fkey;
ALTER TABLE public.outstation_expenses
  RENAME CONSTRAINT payroll_expenses_report_id_fkey TO outstation_expenses_report_id_fkey;

-- ── Indexes ──────────────────────────────────────────────────────────────────
ALTER INDEX public.idx_payroll_expenses_hr_id RENAME TO idx_outstation_expenses_hr_id;
ALTER INDEX public.idx_payroll_expenses_imported_batch RENAME TO idx_outstation_expenses_imported_batch;
ALTER INDEX public.idx_payroll_expenses_report_import_lock RENAME TO idx_outstation_expenses_report_import_lock;
ALTER INDEX public.payroll_expenses_payout_idx RENAME TO outstation_expenses_payout_idx;
ALTER INDEX public.payroll_expenses_report_idx RENAME TO outstation_expenses_report_idx;

-- ── RLS policies (renamed for consistency; predicates unchanged) ───────────────
ALTER POLICY payroll_expense_reports_delete_payroll ON public.outstation_expense_reports RENAME TO outstation_expense_reports_delete_payroll;
ALTER POLICY payroll_expense_reports_insert_payroll ON public.outstation_expense_reports RENAME TO outstation_expense_reports_insert_payroll;
ALTER POLICY payroll_expense_reports_select_access ON public.outstation_expense_reports RENAME TO outstation_expense_reports_select_access;
ALTER POLICY payroll_expense_reports_service_role_all ON public.outstation_expense_reports RENAME TO outstation_expense_reports_service_role_all;
ALTER POLICY payroll_expense_reports_update_payroll ON public.outstation_expense_reports RENAME TO outstation_expense_reports_update_payroll;

ALTER POLICY payroll_expenses_delete_access ON public.outstation_expenses RENAME TO outstation_expenses_delete_access;
ALTER POLICY payroll_expenses_insert_access ON public.outstation_expenses RENAME TO outstation_expenses_insert_access;
ALTER POLICY payroll_expenses_select_access ON public.outstation_expenses RENAME TO outstation_expenses_select_access;
ALTER POLICY payroll_expenses_service_role_all ON public.outstation_expenses RENAME TO outstation_expenses_service_role_all;
ALTER POLICY payroll_expenses_update_access ON public.outstation_expenses RENAME TO outstation_expenses_update_access;

-- The select policy on outstation_expense_reports references the sibling table by
-- name in its predicate body (not just via FK) — Postgres already re-resolved this
-- automatically at rename time since policy predicates are stored as parsed
-- expression trees (like views), not raw text like PL/pgSQL function bodies. No
-- separate fix needed here; documented for reviewer clarity.

-- ── Functions with hard-coded table names in their PL/pgSQL body ───────────────
-- Unlike views/policies, PL/pgSQL function bodies are stored as text and are NOT
-- automatically rewritten by ALTER TABLE RENAME. Both call sites below must be
-- redefined to reference the new table names or they will fail at runtime with
-- "relation does not exist".

CREATE OR REPLACE FUNCTION public.phx_import_approved_expenses_to_payroll(p_month integer, p_year integer) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  v_batch public.salary_batches%rowtype;
  v_imported_by text := coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), 'service_role');
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
  v_locked_expenses integer := 0;
  v_matched_employees text[] := '{}'::text[];
begin
  select *
  into v_batch
  from public.salary_batches
  where month = p_month
    and year = p_year
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'imported_employees', 0,
      'imported_total', 0,
      'locked_expenses', 0,
      'matched_employees', '[]'::jsonb,
      'target_batch_id', null,
      'target_batch_month', null,
      'target_batch_year', null
    );
  end if;

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import expenses before Part 1 is paid or while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  with approved_totals as (
    select
      lower(hr_id) as normalized_hr_id,
      min(hr_id) as hr_id,
      sum(total)::numeric(20,2) as approved_expense
    from public.outstation_expenses
    where hr_approved = true
      and approved_at is not null
      and approved_by is not null
      and payout_month = p_month
      and payout_year = p_year
      and hr_id is not null
      and trim(hr_id) <> ''
    group by lower(hr_id)
  ),
  matched_totals as (
    select
      sr.hr_id,
      at.approved_expense
    from public.salary_records sr
    join approved_totals at
      on lower(sr.hr_id) = at.normalized_hr_id
    where sr.batch_id = v_batch.id
  ),
  updated_rows as (
    update public.salary_records sr
    set expenses = coalesce(at.approved_expense, 0),
        total_additions = coalesce(sr.total_additions, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0),
        second_part = coalesce(sr.second_part, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0),
        month_salary = coalesce(sr.month_salary, coalesce(sr.first_part, 0) + coalesce(sr.second_part, 0)) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0)
    from (
      select
        sr2.id,
        at2.approved_expense
      from public.salary_records sr2
      left join approved_totals at2
        on lower(sr2.hr_id) = at2.normalized_hr_id
      where sr2.batch_id = v_batch.id
    ) at
    where sr.id = at.id
      and (
        coalesce(sr.expenses, 0) is distinct from coalesce(at.approved_expense, 0)
        or coalesce(sr.second_part, 0) is distinct from coalesce(sr.second_part, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0)
      )
    returning sr.id
  ),
  marked_expenses as (
    update public.outstation_expenses pe
    set
      imported_payroll_batch_id = v_batch.id,
      imported_to_payroll_at = now(),
      imported_to_payroll_by = v_imported_by
    where pe.hr_approved = true
      and pe.approved_at is not null
      and pe.approved_by is not null
      and pe.payout_month = p_month
      and pe.payout_year = p_year
      and pe.hr_id is not null
      and trim(pe.hr_id) <> ''
      and exists (
        select 1
        from matched_totals mt
        where lower(mt.hr_id) = lower(pe.hr_id)
      )
    returning pe.id
  )
  select
    count(*)::integer,
    coalesce(sum(approved_expense), 0)::numeric,
    (select count(*)::integer from marked_expenses),
    coalesce(array_agg(hr_id order by hr_id), '{}'::text[])
  into
    v_imported_employees,
    v_imported_total,
    v_locked_expenses,
    v_matched_employees
  from matched_totals;

  return jsonb_build_object(
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'locked_expenses', v_locked_expenses,
    'matched_employees', to_jsonb(v_matched_employees),
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;

-- fn_get_admin_command_center_data also aggregates expense totals inline (admin
-- command center dashboard). Reproduced in full below, unchanged except the two
-- FROM-clause table references in the expense-aggregation subquery.

CREATE OR REPLACE FUNCTION public.fn_get_admin_command_center_data(p_access_scope text DEFAULT 'company'::text, p_access_role text DEFAULT 'Manager'::text, p_access_hr_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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
    (select count(*)::int from public.outstation_expense_reports) as report_count
  into v_expenses
  from public.outstation_expenses
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
