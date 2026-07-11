create schema if not exists private;

create or replace function private.phx_assert_executive_dashboard_viewer(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_role text := nullif(trim(coalesce(p_viewer_role, '')), '');
  v_scope text := lower(nullif(trim(coalesce(p_viewer_scope, '')), ''));
  v_source text := lower(nullif(trim(coalesce(p_viewer_source, '')), ''));
  v_login_id text := lower(nullif(trim(coalesce(p_viewer_login_id, '')), ''));
  v_hr_id text := lower(nullif(trim(coalesce(p_viewer_hr_id, '')), ''));
  v_found boolean := false;
begin
  if v_source = 'system' or v_scope = 'system' then
    return jsonb_build_object(
      'role', coalesce(v_role, 'system'),
      'scope', 'system',
      'source', coalesce(v_source, 'system')
    );
  end if;

  if v_role not in ('CEO', 'Super Admin') or v_scope <> 'company' then
    raise exception 'Executive dashboard snapshot is restricted to CEO, Super Admin, or system scope.';
  end if;

  if v_login_id is not null and to_regclass('public.app_auth_users') is not null then
    select exists (
      select 1
      from public.app_auth_users a
      where lower(trim(a.login_id)) = v_login_id
        and coalesce(a.is_active, true) = true
        and a.role = v_role
    ) into v_found;
  end if;

  if not v_found and v_hr_id is not null and to_regclass('public.app_auth_users') is not null then
    select exists (
      select 1
      from public.app_auth_users a
      where lower(trim(a.hr_id)) = v_hr_id
        and coalesce(a.is_active, true) = true
        and a.role = v_role
    ) into v_found;
  end if;

  if not v_found and v_login_id is not null and to_regclass('public.user_access_profiles') is not null then
    select exists (
      select 1
      from public.user_access_profiles u
      where lower(trim(u.login_id)) = v_login_id
        and coalesce(u.is_active, true) = true
        and coalesce(u.phoenix_role, u.role) = v_role
    ) into v_found;
  end if;

  if not v_found and v_hr_id is not null and to_regclass('public.user_access_profiles') is not null then
    select exists (
      select 1
      from public.user_access_profiles u
      where lower(trim(u.hr_id)) = v_hr_id
        and coalesce(u.is_active, true) = true
        and coalesce(u.phoenix_role, u.role) = v_role
    ) into v_found;
  end if;

  if not v_found then
    raise exception 'Executive dashboard viewer could not be validated.';
  end if;

  return jsonb_build_object(
    'role', v_role,
    'scope', v_scope,
    'source', coalesce(v_source, 'session')
  );
end;
$$;

create or replace function private.phx_exec_source(source_name text, auth_scope text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'sourceName', source_name,
    'status', 'available',
    'asOf', now(),
    'authorizationScope', auth_scope,
    'unavailableReason', null
  );
$$;

create or replace function public.phx_exec_workforce_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  with filtered as (
    select *
    from public.employees e
    where not (coalesce(e.hr_id, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
      and not (coalesce(e.full_name, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
  ),
  active as (
    select *
    from filtered
    where lower(coalesce(employment_status, 'active')) in ('active', 'on_leave')
  )
  select jsonb_build_object(
    'activeEmployees', (select count(*) from active),
    'totalEmployees', (select count(*) from filtered),
    'healthyEmployees', (
      select count(*)
      from active
      where nullif(trim(coalesce(manager_hr_id, '')), '') is not null
        and nullif(trim(coalesce(job_title, '')), '') is not null
    ),
    'employeesWithoutManagers', (select count(*) from active where nullif(trim(coalesce(manager_hr_id, '')), '') is null),
    'missingJobTitle', (select count(*) from active where nullif(trim(coalesce(job_title, '')), '') is null),
    'uniqueAreas', (select count(distinct area_id) from active where area_id is not null),
    'uniqueLines', (select count(distinct line_id) from active where line_id is not null),
    'totalStructure', (select count(*) from active) + (
      select count(*)
      from public.position_vacancies v
      where lower(coalesce(v.status, 'open')) = 'open'
        and not (coalesce(v.vacancy_code, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
    )
  ) into v_metrics;

  return jsonb_build_object(
    'source', private.phx_exec_source('Employees', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_vacancies_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_open integer;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);
  select count(*) into v_open
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and not (coalesce(v.vacancy_code, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])');

  return jsonb_build_object(
    'source', private.phx_exec_source('Vacancies', v_auth->>'scope'),
    'metrics', jsonb_build_object('openVacancies', coalesce(v_open, 0))
  );
end;
$$;

create or replace function public.phx_exec_payroll_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_batch record;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  select id, month, year
  into v_batch
  from public.salary_batches b
  where coalesce(b.year, 0) < 2090
    and not (coalesce(b.file_name, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
    and not (coalesce(b.uploaded_by, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
  order by b.year desc, b.month desc, b.created_at desc
  limit 1;

  if v_batch.id is null then
    v_metrics := jsonb_build_object(
      'batchLabel', 'No batch',
      'employees', 0,
      'gross', 0,
      'net', 0,
      'flags', 0,
      'payrollEligibleCount', (
        select count(*)
        from public.employees e
        where coalesce(e.payroll_eligible, true) = true
          and lower(coalesce(e.employment_status, 'active')) in ('active', 'on_leave')
      )
    );
  else
    select jsonb_build_object(
      'batchLabel', concat(v_batch.month, '/', v_batch.year),
      'employees', count(r.id),
      'gross', coalesce(sum(r.gross_salary), 0),
      'net', coalesce(sum(r.net_salary), 0),
      'flags', (select count(*) from public.salary_flags f where f.batch_id = v_batch.id),
      'payrollEligibleCount', (
        select count(*)
        from public.employees e
        where coalesce(e.payroll_eligible, true) = true
          and lower(coalesce(e.employment_status, 'active')) in ('active', 'on_leave')
      )
    )
    into v_metrics
    from public.salary_records r
    where r.batch_id = v_batch.id;
  end if;

  return jsonb_build_object(
    'source', private.phx_exec_source('Payroll', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_sales_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  with filtered as (
    select *
    from public.sales_records r
    where coalesce(r.year, 0) < 2090
      and not (coalesce(r.employee_hr_id, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
      and not (coalesce(r.employee_name, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
      and not (coalesce(r.product, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
  )
  select jsonb_build_object(
    'salesValue', coalesce(sum(sales_value), 0),
    'targetValue', coalesce(sum(target_value), 0),
    'achievementRate', case when coalesce(sum(target_value), 0) > 0 then coalesce(sum(sales_value), 0) / sum(target_value) else 0 end,
    'activeProducts', count(distinct nullif(product, '')),
    'dataQualityRate', case when count(*) > 0 then count(*) filter (where link_status = 'linked')::numeric / count(*) else 1 end
  )
  into v_metrics
  from filtered;

  return jsonb_build_object(
    'source', private.phx_exec_source('Sales', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_expenses_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  with filtered as (
    select *
    from public.payroll_expenses e
    where not (coalesce(e.hr_id, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
      and not (coalesce(e.trip_id, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
      and not (coalesce(e.specialist, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
      and not (coalesce(e.description, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
  )
  select jsonb_build_object(
    'approvedAmount', coalesce(sum(total) filter (where lower(coalesce(hr_status, status, '')) in ('approved', 'hr_approved', 'added_to_payroll')), 0),
    'totalAmount', coalesce(sum(total), 0),
    'totalRows', count(*),
    'reportCount', (
      select count(*)
      from public.payroll_expense_reports r
      where not (coalesce(r.file_name, '') ~* '^phase[\s._-]*(1[3-9]|[2-9][0-9])')
    )
  )
  into v_metrics
  from filtered;

  return jsonb_build_object(
    'source', private.phx_exec_source('Expenses', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_contracts_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  select jsonb_build_object(
    'expiringContracts', count(*) filter (
      where contract_renewal_date between current_date and current_date + interval '30 days'
        and lower(coalesce(status, 'active')) in ('active', 'draft')
    ),
    'contractsDueSoon', count(*) filter (
      where contract_renewal_date between current_date and current_date + interval '7 days'
        and lower(coalesce(status, 'active')) in ('active', 'draft')
    )
  )
  into v_metrics
  from public.employee_contracts;

  return jsonb_build_object(
    'source', private.phx_exec_source('Contracts', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_probation_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  select jsonb_build_object(
    'probationEndings', count(*) filter (
      where probation_end_date between current_date and current_date + interval '15 days'
        and lower(coalesce(status, 'active')) not in ('passed', 'terminated', 'completed')
    ),
    'criticalProbation', count(*) filter (
      where probation_end_date between current_date and current_date + interval '30 days'
        and lower(coalesce(status, 'active')) not in ('passed', 'terminated', 'completed')
    )
  )
  into v_metrics
  from public.employee_probation;

  return jsonb_build_object(
    'source', private.phx_exec_source('Probation', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_recruitment_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  select jsonb_build_object(
    'totalOffers', count(*),
    'pendingOffers', count(*) filter (where lower(coalesce(status, '')) in ('sent', 'accepted') and lower(coalesce(onboarding_status, 'not_started')) <> 'approved_hired'),
    'acceptedOffers', count(*) filter (where lower(coalesce(status, '')) in ('accepted', 'hired')),
    'rejectedOffers', count(*) filter (where lower(coalesce(status, '')) = 'rejected'),
    'acceptanceRate', case when count(*) > 0 then count(*) filter (where lower(coalesce(status, '')) in ('accepted', 'hired'))::numeric / count(*) else 0 end
  )
  into v_metrics
  from public.job_offers;

  return jsonb_build_object(
    'source', private.phx_exec_source('Recruitment', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_leave_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_metrics jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  select jsonb_build_object(
    'approvedRequests', count(*) filter (where lower(coalesce(status, '')) = 'approved'),
    'pendingRequests', count(*) filter (where lower(coalesce(status, '')) in ('pending_manager', 'pending_hr')),
    'rejectedRequests', count(*) filter (where lower(coalesce(status, '')) = 'rejected'),
    'totalRequests', count(*),
    'paidDays', coalesce(sum(paid_duration_days), 0),
    'unpaidDays', coalesce(sum(unpaid_duration_days), 0),
    'managerDecisionActions', count(*) filter (where manager_decision_at is not null),
    'overdueSla', 0
  )
  into v_metrics
  from public.v2_vacation_requests;

  return jsonb_build_object(
    'source', private.phx_exec_source('Leave', v_auth->>'scope'),
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.phx_exec_attendance_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);
  return jsonb_build_object(
    'source', private.phx_exec_source('Attendance', v_auth->>'scope'),
    'metrics', jsonb_build_object(
      'activeMappings', 0,
      'activePolicies', 0,
      'currentMonthWorkingDays', 0,
      'mappingReadinessRate', 1,
      'missingDeviceMappings', 0,
      'policyCoverageRate', 1,
      'totalDeviceMappings', 0,
      'totalPolicies', 0
    )
  );
end;
$$;

create or replace function public.phx_exec_operations_snapshot(
  p_viewer_hr_id text,
  p_viewer_login_id text,
  p_viewer_role text,
  p_viewer_scope text,
  p_viewer_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, private
as $$
declare
  v_auth jsonb;
  v_total integer := 0;
  v_failures integer := 0;
  v_last timestamptz := null;
begin
  v_auth := private.phx_assert_executive_dashboard_viewer(p_viewer_hr_id, p_viewer_login_id, p_viewer_role, p_viewer_scope, p_viewer_source);

  if to_regclass('public.audit_logs') is not null then
    execute 'select count(*), count(*) filter (where lower(coalesce(summary, '''')) like ''%fail%''), max(created_at) from public.audit_logs where created_at >= now() - interval ''24 hours'''
      into v_total, v_failures, v_last;
  end if;

  return jsonb_build_object(
    'source', private.phx_exec_source('Operational Health', v_auth->>'scope'),
    'metrics', jsonb_build_object(
      'totalEvents24h', coalesce(v_total, 0),
      'failureCount24h', coalesce(v_failures, 0),
      'lastEventAt', v_last,
      'staleSources', jsonb_build_array()
    )
  );
end;
$$;

revoke all on function private.phx_assert_executive_dashboard_viewer(text, text, text, text, text) from public, anon, authenticated;
grant execute on function private.phx_assert_executive_dashboard_viewer(text, text, text, text, text) to service_role;

revoke all on function public.phx_exec_workforce_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_vacancies_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_payroll_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_sales_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_expenses_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_contracts_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_probation_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_recruitment_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_leave_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_attendance_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.phx_exec_operations_snapshot(text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.phx_exec_workforce_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_vacancies_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_payroll_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_sales_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_expenses_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_contracts_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_probation_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_recruitment_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_leave_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_attendance_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.phx_exec_operations_snapshot(text, text, text, text, text) to service_role;

notify pgrst, 'reload schema';
