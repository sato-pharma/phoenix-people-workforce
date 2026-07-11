-- Deductions Governance payroll import: switch from REPLACE to ADD-on-top.
--
-- Change:
-- - The import now ADDS the governance deduction totals on top of the existing
--   salary_records CRM / Finger Print / Unpaid Vacations values (previously it
--   overwrote them). Total Deductions increases by the added amount; Second Part
--   and Month Salary decrease by the same amount (never below 0).
-- - ADD-on-top is NOT idempotent, so a finalized summary may be imported to
--   payroll only ONCE. A second import of the same summary is blocked.
--
-- Safety:
-- - Still service_role-only, security invoker, explicit-call-only (no triggers).
-- - Still guarded by payroll batch status, finalized-summary requirement, and an
--   unmatched-employee abort. Same signature as before (create or replace).

create or replace function public.phx_import_deductions_governance_to_payroll(
  p_summary_id uuid,
  p_import_job_id uuid default gen_random_uuid(),
  p_actor_login_id text default 'system'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_summary public.deduction_monthly_summaries%rowtype;
  v_batch public.salary_batches%rowtype;
  v_existing_job public.deduction_payroll_import_jobs%rowtype;
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
  v_matched_employees jsonb := '[]'::jsonb;
  v_unmatched_employees jsonb := '[]'::jsonb;
begin
  if p_summary_id is null then
    raise exception 'A finalized deductions summary is required.' using errcode = 'P0001';
  end if;

  select *
  into v_summary
  from public.deduction_monthly_summaries
  where id = p_summary_id
  for update;

  if not found then
    raise exception 'Deductions summary % was not found.', p_summary_id using errcode = 'P0001';
  end if;

  if v_summary.status <> 'finalized' then
    raise exception 'Deductions summary % is not finalized.', p_summary_id using errcode = 'P0001';
  end if;

  if p_import_job_id is not null then
    select *
    into v_existing_job
    from public.deduction_payroll_import_jobs
    where import_job_id = p_import_job_id
    for update;

    if found and v_existing_job.status = 'completed' then
      return jsonb_build_object(
        'import_job_id', p_import_job_id,
        'idempotent_replay', true,
        'imported_employees', coalesce(v_existing_job.imported_employees, 0),
        'imported_total', coalesce(v_existing_job.imported_total, 0),
        'matched_employees', v_existing_job.matched_employees,
        'unmatched_employees', v_existing_job.unmatched_employees,
        'target_batch_id', v_existing_job.batch_id,
        'target_batch_month', v_summary.month,
        'target_batch_year', v_summary.year
      );
    end if;
  end if;

  -- ADD-on-top is not idempotent: a finalized summary may be imported to payroll
  -- only once. Block a second import (any different job id) to prevent doubling.
  if exists (
    select 1
    from public.deduction_payroll_import_jobs
    where summary_id = p_summary_id
      and status = 'completed'
  ) then
    raise exception 'Deductions summary % was already imported to payroll; re-import is blocked to prevent double deductions.', p_summary_id using errcode = 'P0001';
  end if;

  select *
  into v_batch
  from public.salary_batches
  where month = v_summary.month
    and year = v_summary.year
  order by created_at desc, id desc
  limit 1
  for update;

  if not found then
    raise exception 'No payroll batch exists for deductions month %.', v_summary.month_key using errcode = 'P0001';
  end if;

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import deductions while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  with line_totals as (
    select
      lower(employee_code) as normalized_hr_id,
      min(employee_code) as employee_code,
      min(employee_name) as employee_name,
      sum(applied_amount) filter (where payroll_column = 'crm')::numeric(14, 2) as crm_total,
      sum(applied_amount) filter (where payroll_column = 'finger_print')::numeric(14, 2) as finger_print_total,
      sum(applied_amount) filter (where payroll_column = 'unpaid_vacations')::numeric(14, 2) as unpaid_vacations_total,
      sum(applied_amount)::numeric(14, 2) as total_amount
    from public.deduction_monthly_summary_lines
    where summary_id = p_summary_id
    group by lower(employee_code)
  ),
  unmatched as (
    select
      lt.employee_code,
      lt.employee_name,
      lt.total_amount
    from line_totals lt
    where not exists (
      select 1
      from public.salary_records sr
      where sr.batch_id = v_batch.id
        and (
          lower(sr.hr_id) = lt.normalized_hr_id
          or lower(coalesce(sr.employee_code, '')) = lt.normalized_hr_id
        )
    )
  )
  select coalesce(jsonb_agg(to_jsonb(unmatched) order by employee_code), '[]'::jsonb)
  into v_unmatched_employees
  from unmatched;

  if jsonb_array_length(v_unmatched_employees) > 0 then
    raise exception 'Deductions import has unmatched payroll employees for month %.', v_summary.month_key using errcode = 'P0001';
  end if;

  if p_import_job_id is not null then
    insert into public.deduction_payroll_import_jobs (
      import_job_id,
      summary_id,
      batch_id,
      month_key,
      actor_login_id,
      status,
      unmatched_employees,
      created_at
    ) values (
      p_import_job_id,
      p_summary_id,
      v_batch.id,
      v_summary.month_key,
      coalesce(nullif(p_actor_login_id, ''), 'system'),
      'pending',
      v_unmatched_employees,
      now()
    )
    on conflict (import_job_id) do update
      set status = 'pending',
          summary_id = excluded.summary_id,
          batch_id = excluded.batch_id,
          month_key = excluded.month_key,
          actor_login_id = excluded.actor_login_id,
          unmatched_employees = excluded.unmatched_employees,
          created_at = now(),
          error_message = null;
  end if;

  begin
    with line_totals as (
      select
        lower(employee_code) as normalized_hr_id,
        min(employee_code) as employee_code,
        sum(applied_amount) filter (where payroll_column = 'crm')::numeric(14, 2) as crm_total,
        sum(applied_amount) filter (where payroll_column = 'finger_print')::numeric(14, 2) as finger_print_total,
        sum(applied_amount) filter (where payroll_column = 'unpaid_vacations')::numeric(14, 2) as unpaid_vacations_total,
        sum(applied_amount)::numeric(14, 2) as total_amount
      from public.deduction_monthly_summary_lines
      where summary_id = p_summary_id
      group by lower(employee_code)
    ),
    target_rows as (
      select
        sr.id,
        sr.hr_id,
        coalesce(sr.crm, 0)::numeric as old_crm,
        coalesce(sr.finger_print, 0)::numeric as old_finger_print,
        coalesce(sr.unpaid_vacations, 0)::numeric as old_unpaid_vacations,
        coalesce(lt.crm_total, 0)::numeric as add_crm,
        coalesce(lt.finger_print_total, 0)::numeric as add_finger_print,
        coalesce(lt.unpaid_vacations_total, 0)::numeric as add_unpaid_vacations,
        coalesce(lt.total_amount, 0)::numeric as add_total_amount
      from public.salary_records sr
      left join line_totals lt
        on (
          lower(sr.hr_id) = lt.normalized_hr_id
          or lower(coalesce(sr.employee_code, '')) = lt.normalized_hr_id
        )
      where sr.batch_id = v_batch.id
    ),
    updated_rows as (
      update public.salary_records sr
      set
        crm = tr.old_crm + tr.add_crm,
        finger_print = tr.old_finger_print + tr.add_finger_print,
        unpaid_vacations = tr.old_unpaid_vacations + tr.add_unpaid_vacations,
        total_deductions = coalesce(sr.total_deductions, 0)
          + (tr.add_crm + tr.add_finger_print + tr.add_unpaid_vacations),
        second_part = greatest(
          0,
          coalesce(sr.second_part, 0)
            - (tr.add_crm + tr.add_finger_print + tr.add_unpaid_vacations)
        ),
        month_salary = greatest(
          0,
          coalesce(sr.month_salary, coalesce(sr.first_part, 0) + coalesce(sr.second_part, 0))
            - (tr.add_crm + tr.add_finger_print + tr.add_unpaid_vacations)
        )
      from target_rows tr
      where sr.id = tr.id
        and (tr.add_crm + tr.add_finger_print + tr.add_unpaid_vacations) > 0
      returning sr.id
    ),
    matched as (
      select
        sr.hr_id,
        tr.add_total_amount as imported_total
      from target_rows tr
      join public.salary_records sr on sr.id = tr.id
      where tr.add_total_amount > 0
    )
    select
      count(*)::integer,
      coalesce(sum(imported_total), 0)::numeric(14, 2),
      coalesce(jsonb_agg(to_jsonb(matched) order by hr_id), '[]'::jsonb)
    into
      v_imported_employees,
      v_imported_total,
      v_matched_employees
    from matched;

    update public.deduction_decisions dd
    set payroll_handoff_status = 'Imported to Payroll'
    where dd.id in (
      select decision_id
      from public.deduction_monthly_summary_lines
      where summary_id = p_summary_id
    );

    if p_import_job_id is not null then
      update public.deduction_payroll_import_jobs
      set
        status = 'completed',
        imported_employees = v_imported_employees,
        imported_total = v_imported_total,
        matched_employees = v_matched_employees,
        unmatched_employees = v_unmatched_employees,
        completed_at = now(),
        error_message = null
      where import_job_id = p_import_job_id;
    end if;
  exception when others then
    if p_import_job_id is not null then
      update public.deduction_payroll_import_jobs
      set
        status = 'failed',
        error_message = sqlerrm,
        completed_at = now()
      where import_job_id = p_import_job_id;
    end if;
    raise;
  end;

  return jsonb_build_object(
    'import_job_id', p_import_job_id,
    'idempotent_replay', false,
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'matched_employees', v_matched_employees,
    'unmatched_employees', v_unmatched_employees,
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;

revoke all on function public.phx_import_deductions_governance_to_payroll(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.phx_import_deductions_governance_to_payroll(uuid, uuid, text)
  to service_role;
