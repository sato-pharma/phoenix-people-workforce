-- Phoenix Workforce Phase 2 transactional workflow hardening.
-- Adds transactional RPC functions for offer approval and payroll expense import.

create extension if not exists pgcrypto;

create or replace function public.phx_approve_accepted_offer(
  p_offer_id uuid,
  p_approved_by_hr_id text default null,
  p_employee_hr_id text default null,
  p_gross_salary numeric default 0,
  p_fuel_allowance numeric default 0,
  p_extra_cost_of_living numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer public.job_offers%rowtype;
  v_employee_hr_id text;
  v_prefix text := 'PH';
  v_line_name text;
  v_line_code text;
  v_candidate integer;
  v_attempt integer := 0;
  v_matching_vacancy_id bigint;
  v_monthly_package numeric;
  v_base_salary numeric;
  v_gross_salary numeric;
begin
  select *
  into v_offer
  from public.job_offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  if v_offer.status <> 'accepted' then
    raise exception 'Only accepted offers can be approved.';
  end if;

  if coalesce(trim(v_offer.candidate_name), '') = '' then
    raise exception 'Cannot approve offer without candidate name.';
  end if;

  if coalesce(trim(v_offer.candidate_email), '') = '' then
    raise exception 'Cannot approve offer without candidate email.';
  end if;

  if v_offer.line_id is null then
    raise exception 'Cannot approve offer without line assignment.';
  end if;

  if v_offer.area_id is null then
    raise exception 'Cannot approve offer without area assignment.';
  end if;

  if coalesce(trim(v_offer.manager_hr_id), '') = '' then
    raise exception 'Cannot approve offer without manager HR ID.';
  end if;

  v_employee_hr_id := nullif(trim(coalesce(p_employee_hr_id, v_offer.employee_hr_id, '')), '');

  if v_employee_hr_id is null then
    select coalesce(name, ''), coalesce(code, '')
    into v_line_name, v_line_code
    from public.lines
    where id = v_offer.line_id;

    if position('anti' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'AI';
    elsif position('pedia' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'PD';
    elsif position('cns' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'CN';
    elsif position('office' in lower(v_line_name || ' ' || v_line_code)) > 0 then
      v_prefix := 'OF';
    end if;

    loop
      v_attempt := v_attempt + 1;
      if v_attempt > 5 then
        raise exception 'Failed to generate a unique HR_ID for prefix %.', v_prefix;
      end if;

      select coalesce(
        max(
          nullif(
            substring(hr_id from ('^' || v_prefix || '-([0-9]+)$')),
            ''
          )::integer
        ),
        0
      ) + 1
      into v_candidate
      from public.employees
      where hr_id like v_prefix || '-%';

      v_employee_hr_id := v_prefix || '-' || lpad(v_candidate::text, 4, '0');

      begin
        insert into public.employees (
          hr_id,
          full_name,
          work_email,
          mobile_number,
          job_title,
          hire_date,
          employment_status,
          manager_hr_id,
          department_id,
          line_id,
          area_id,
          position_id,
          created_at,
          updated_at
        ) values (
          v_employee_hr_id,
          v_offer.candidate_name,
          v_offer.candidate_email,
          v_offer.candidate_phone,
          v_offer.job_title,
          v_offer.start_date,
          'active',
          v_offer.manager_hr_id,
          v_offer.department_id,
          v_offer.line_id,
          v_offer.area_id,
          v_offer.position_id,
          now(),
          now()
        );
        exit;
      exception
        when unique_violation then
          v_employee_hr_id := null;
      end;
    end loop;
  else
    if exists (
      select 1
      from public.employees
      where hr_id = v_employee_hr_id
        and hr_id <> coalesce(v_offer.employee_hr_id, '')
    ) then
      raise exception 'HR_ID % is already in use.', v_employee_hr_id;
    end if;

    insert into public.employees (
      hr_id,
      full_name,
      work_email,
      mobile_number,
      job_title,
      hire_date,
      employment_status,
      manager_hr_id,
      department_id,
      line_id,
      area_id,
      position_id,
      created_at,
      updated_at
    ) values (
      v_employee_hr_id,
      v_offer.candidate_name,
      v_offer.candidate_email,
      v_offer.candidate_phone,
      v_offer.job_title,
      v_offer.start_date,
      'active',
      v_offer.manager_hr_id,
      v_offer.department_id,
      v_offer.line_id,
      v_offer.area_id,
      v_offer.position_id,
      now(),
      now()
    )
    on conflict (hr_id) do update
    set
      full_name = excluded.full_name,
      work_email = excluded.work_email,
      mobile_number = excluded.mobile_number,
      job_title = excluded.job_title,
      hire_date = excluded.hire_date,
      employment_status = excluded.employment_status,
      manager_hr_id = excluded.manager_hr_id,
      department_id = excluded.department_id,
      line_id = excluded.line_id,
      area_id = excluded.area_id,
      position_id = excluded.position_id,
      updated_at = now();
  end if;

  v_monthly_package := coalesce(p_gross_salary, 0);
  v_base_salary := greatest(
    0,
    v_monthly_package - coalesce(p_extra_cost_of_living, 0) - coalesce(p_fuel_allowance, 0)
  );
  v_gross_salary := v_base_salary;

  insert into public.employee_compensation (
    employee_hr_id,
    net_salary,
    comprehensive_wage,
    fuel_allowance,
    extra_cost_of_living,
    gross_salary,
    payment_mode,
    updated_at
  ) values (
    v_employee_hr_id,
    v_base_salary,
    v_base_salary,
    coalesce(p_fuel_allowance, 0),
    coalesce(p_extra_cost_of_living, 0),
    v_gross_salary,
    'two_parts',
    now()
  )
  on conflict (employee_hr_id) do update
  set
    net_salary = excluded.net_salary,
    comprehensive_wage = excluded.comprehensive_wage,
    fuel_allowance = excluded.fuel_allowance,
    extra_cost_of_living = excluded.extra_cost_of_living,
    gross_salary = excluded.gross_salary,
    payment_mode = excluded.payment_mode,
    updated_at = now();

  if v_offer.position_id is not null and v_offer.line_id is not null and v_offer.area_id is not null then
    select pv.id
    into v_matching_vacancy_id
    from public.position_vacancies pv
    where pv.position_id = v_offer.position_id
      and pv.line_id = v_offer.line_id
      and pv.area_id = v_offer.area_id
      and pv.status = 'open'
    order by
      case when pv.manager_hr_id = v_offer.manager_hr_id then 0 else 1 end,
      pv.created_at desc,
      pv.id desc
    limit 1
    for update;

    if v_matching_vacancy_id is not null then
      update public.position_vacancies
      set status = 'filled',
          updated_at = now()
      where id = v_matching_vacancy_id;
    end if;
  end if;

  update public.job_offers
  set employee_hr_id = v_employee_hr_id,
      onboarding_status = 'approved_hired',
      updated_at = now()
  where id = v_offer.id;

  insert into public.job_offer_audit_logs (
    offer_id,
    action,
    actor_type,
    actor_reference,
    details
  ) values (
    v_offer.id,
    'hire_approved',
    'hr',
    p_approved_by_hr_id,
    jsonb_build_object(
      'employeeHrId', v_employee_hr_id,
      'vacancyId', v_matching_vacancy_id
    )
  );

  return jsonb_build_object(
    'employee_hr_id', v_employee_hr_id,
    'offer_id', v_offer.id,
    'vacancy_id', v_matching_vacancy_id
  );
end;
$$;

create or replace function public.phx_import_approved_expenses_to_payroll(
  p_month integer,
  p_year integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch public.salary_batches%rowtype;
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
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
      'matched_employees', '[]'::jsonb,
      'target_batch_id', null,
      'target_batch_month', null,
      'target_batch_year', null
    );
  end if;

  if v_batch.status not in ('uploaded', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import expenses while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  with approved_totals as (
    select
      lower(hr_id) as normalized_hr_id,
      min(hr_id) as hr_id,
      sum(total)::numeric(20,2) as approved_expense
    from public.payroll_expenses
    where hr_approved = true
      and payout_month = p_month
      and payout_year = p_year
      and hr_id is not null
      and trim(hr_id) <> ''
    group by lower(hr_id)
  ),
  updated_rows as (
    update public.salary_records sr
    set expenses = at.approved_expense,
        total_additions = coalesce(sr.total_additions, 0) - coalesce(sr.expenses, 0) + at.approved_expense
    from approved_totals at
    where sr.batch_id = v_batch.id
      and lower(sr.hr_id) = at.normalized_hr_id
    returning sr.hr_id, at.approved_expense
  )
  select
    count(*)::integer,
    coalesce(sum(approved_expense), 0)::numeric,
    coalesce(array_agg(hr_id order by hr_id), '{}'::text[])
  into
    v_imported_employees,
    v_imported_total,
    v_matched_employees
  from updated_rows;

  return jsonb_build_object(
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'matched_employees', to_jsonb(v_matched_employees),
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;

revoke all on function public.phx_approve_accepted_offer(uuid, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.phx_import_approved_expenses_to_payroll(integer, integer) from public, anon, authenticated;

grant execute on function public.phx_approve_accepted_offer(uuid, text, text, numeric, numeric, numeric) to service_role;
grant execute on function public.phx_import_approved_expenses_to_payroll(integer, integer) to service_role;

notify pgrst, 'reload schema';
