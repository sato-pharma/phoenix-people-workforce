-- Offer lifecycle 10/10 completion:
-- - structured compensation lines that affect payroll net salary
-- - accepted-offer void status before hire approval
-- - approval RPC persists offer compensation lines into employee salary_details

create schema if not exists private;
alter table public.job_offers
  add column if not exists compensation_lines jsonb not null default '[]'::jsonb,
  add column if not exists voided_at timestamptz null,
  add column if not exists void_reason text null,
  add column if not exists voided_reserved_employee_hr_id text null;
alter table public.job_offers
  alter column compensation_lines set default '[]'::jsonb;
update public.job_offers
set compensation_lines = '[]'::jsonb
where compensation_lines is null;
alter table public.job_offers
  alter column compensation_lines set not null;
alter table public.job_offers
  drop constraint if exists job_offers_status_check;
alter table public.job_offers
  add constraint job_offers_status_check
  check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'hired', 'withdrawn', 'cancelled', 'voided'));
drop function if exists public.phx_approve_accepted_offer(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
);
drop function if exists private.phx_approve_accepted_offer_v2(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
);
create or replace function private.phx_approve_accepted_offer_v2(
  p_offer_id uuid,
  p_approved_by_hr_id text default null,
  p_employee_hr_id text default null,
  p_gross_salary numeric default null,
  p_fuel_allowance numeric default null,
  p_extra_cost_of_living numeric default null,
  p_base_salary numeric default null,
  p_basic_salary numeric default null,
  p_net_salary numeric default null,
  p_social_insurance numeric default null,
  p_taxes numeric default null,
  p_compensation_lines jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
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
  v_base_salary numeric;
  v_basic_salary numeric;
  v_gross_salary numeric;
  v_net_salary numeric;
  v_fuel_allowance numeric;
  v_extra_cost_of_living numeric;
  v_social_insurance numeric;
  v_taxes numeric;
  v_legacy_match_count integer := 0;
  v_compensation_lines jsonb := '[]'::jsonb;
  v_custom_earnings numeric := 0;
  v_custom_deductions numeric := 0;
begin
  perform pg_advisory_xact_lock(hashtext('phx_offer_hire_approval'));

  select *
    into v_offer
  from public.job_offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  if v_offer.status = 'hired' and nullif(trim(coalesce(v_offer.employee_hr_id, '')), '') is not null then
    return jsonb_build_object(
      'already_hired', true,
      'employee_hr_id', v_offer.employee_hr_id,
      'offer_id', v_offer.id,
      'vacancy_id', v_offer.vacancy_id
    );
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

  if v_offer.start_date is null then
    raise exception 'Cannot approve offer without hiring date.';
  end if;

  if v_offer.department_id is null then
    raise exception 'Cannot approve offer without department assignment.';
  end if;

  if v_offer.position_id is null then
    raise exception 'Cannot approve offer without position assignment.';
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

  with normalized as (
    select
      coalesce(nullif(trim(line ->> 'id'), ''), 'offer-line-' || row_number() over ()) as id,
      case when lower(coalesce(line ->> 'category', 'earning')) = 'deduction' then 'deduction' else 'earning' end as category,
      left(trim(coalesce(line ->> 'label', '')), 120) as label,
      nullif(trim(coalesce(line ->> 'notes', '')), '') as notes,
      case
        when coalesce(line ->> 'value', '') ~ '^[0-9]+(\.[0-9]+)?$'
          then round(((line ->> 'value')::numeric), 2)
        else null
      end as amount
    from jsonb_array_elements(coalesce(p_compensation_lines, v_offer.compensation_lines, '[]'::jsonb)) as source(line)
  ),
  valid as (
    select *
    from normalized
    where amount is not null
      and amount > 0
      and label <> ''
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'label', label,
      'category', category,
      'valueType', 'amount',
      'value', amount::text,
      'notes', notes
    ) order by id), '[]'::jsonb),
    coalesce(sum(case when category = 'earning' then amount else 0 end), 0),
    coalesce(sum(case when category = 'deduction' then amount else 0 end), 0)
  into v_compensation_lines, v_custom_earnings, v_custom_deductions
  from valid;

  v_base_salary := coalesce(p_base_salary, v_offer.base_salary);
  v_basic_salary := coalesce(p_basic_salary, v_offer.basic_salary, round(coalesce(v_base_salary, 0) * 0.7, 2));
  v_fuel_allowance := coalesce(p_fuel_allowance, v_offer.fuel_allowance, 0);
  v_extra_cost_of_living := coalesce(p_extra_cost_of_living, v_offer.extra_cost_of_living, 0);
  v_social_insurance := coalesce(p_social_insurance, v_offer.social_insurance, 0);
  v_taxes := coalesce(p_taxes, v_offer.taxes, 0);
  v_gross_salary := coalesce(p_gross_salary, v_offer.gross_salary, coalesce(v_base_salary, 0) + v_social_insurance + v_taxes);
  v_net_salary := greatest(0, coalesce(v_base_salary, 0) + v_extra_cost_of_living + v_fuel_allowance + v_custom_earnings - v_custom_deductions);

  if coalesce(v_base_salary, 0) <= 0 then
    raise exception 'Cannot approve offer without base salary.';
  end if;

  if v_offer.vacancy_id is not null then
    select pv.id
      into v_matching_vacancy_id
    from public.position_vacancies pv
    where pv.id = v_offer.vacancy_id
      and pv.status = 'open'
      and pv.department_id = v_offer.department_id
      and pv.position_id = v_offer.position_id
      and pv.line_id = v_offer.line_id
      and pv.area_id = v_offer.area_id
    limit 1
    for update;

    if v_matching_vacancy_id is null then
      raise exception 'Selected vacancy is no longer open or no longer matches this offer.';
    end if;
  else
    select count(*), max(pv.id)
      into v_legacy_match_count, v_matching_vacancy_id
    from public.position_vacancies pv
    where pv.status = 'open'
      and pv.department_id = v_offer.department_id
      and pv.position_id = v_offer.position_id
      and pv.line_id = v_offer.line_id
      and pv.area_id = v_offer.area_id
      and (
        pv.manager_hr_id = v_offer.manager_hr_id
        or pv.manager_hr_id is null
      );

    if v_legacy_match_count > 1 then
      raise exception 'Ambiguous vacancy match. Select an explicit vacancy before approving this offer.';
    end if;
  end if;

  v_employee_hr_id := nullif(trim(coalesce(p_employee_hr_id, v_offer.reserved_employee_hr_id, v_offer.employee_hr_id, '')), '');

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
      if v_attempt > 10 then
        raise exception 'Failed to generate a unique HR_ID for prefix %.', v_prefix;
      end if;

      select coalesce(max(candidate), 0) + 1
        into v_candidate
      from (
        select nullif(substring(upper(hr_id) from ('^' || v_prefix || '-([0-9]+)$')), '')::integer as candidate
        from public.employees
        where upper(hr_id) like v_prefix || '-%'
        union all
        select nullif(substring(upper(reserved_employee_hr_id) from ('^' || v_prefix || '-([0-9]+)$')), '')::integer as candidate
        from public.job_offers
        where reserved_employee_hr_id is not null
          and upper(reserved_employee_hr_id) like v_prefix || '-%'
      ) ids
      where candidate is not null;

      v_employee_hr_id := v_prefix || '-' || lpad(v_candidate::text, 4, '0');

      begin
        insert into public.employees (
          hr_id, full_name, work_email, mobile_number, job_title, hire_date,
          employment_status, manager_hr_id, department_id, line_id, area_id,
          position_id, base_salary, basic_salary, gross_salary, net_salary,
          fuel_allowance, extra_cost_of_living, social_insurance, taxes,
          payment_mode, created_at, updated_at
        ) values (
          v_employee_hr_id, v_offer.candidate_name, v_offer.candidate_email,
          v_offer.candidate_phone, v_offer.job_title, v_offer.start_date,
          'active', v_offer.manager_hr_id, v_offer.department_id, v_offer.line_id,
          v_offer.area_id, v_offer.position_id, v_base_salary, v_basic_salary,
          v_gross_salary, v_net_salary, v_fuel_allowance, v_extra_cost_of_living,
          v_social_insurance, v_taxes, 'two_parts', now(), now()
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
      hr_id, full_name, work_email, mobile_number, job_title, hire_date,
      employment_status, manager_hr_id, department_id, line_id, area_id,
      position_id, base_salary, basic_salary, gross_salary, net_salary,
      fuel_allowance, extra_cost_of_living, social_insurance, taxes,
      payment_mode, created_at, updated_at
    ) values (
      v_employee_hr_id, v_offer.candidate_name, v_offer.candidate_email,
      v_offer.candidate_phone, v_offer.job_title, v_offer.start_date,
      'active', v_offer.manager_hr_id, v_offer.department_id, v_offer.line_id,
      v_offer.area_id, v_offer.position_id, v_base_salary, v_basic_salary,
      v_gross_salary, v_net_salary, v_fuel_allowance, v_extra_cost_of_living,
      v_social_insurance, v_taxes, 'two_parts', now(), now()
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
      base_salary = excluded.base_salary,
      basic_salary = excluded.basic_salary,
      gross_salary = excluded.gross_salary,
      net_salary = excluded.net_salary,
      fuel_allowance = excluded.fuel_allowance,
      extra_cost_of_living = excluded.extra_cost_of_living,
      social_insurance = excluded.social_insurance,
      taxes = excluded.taxes,
      payment_mode = excluded.payment_mode,
      updated_at = now();
  end if;

  insert into public.employee_compensation (
    employee_hr_id, net_salary, comprehensive_wage, fuel_allowance,
    extra_cost_of_living, gross_salary, social_insurance, taxes,
    salary_details, payment_mode, updated_at
  ) values (
    v_employee_hr_id, v_net_salary, v_base_salary, v_fuel_allowance,
    v_extra_cost_of_living, v_gross_salary, v_social_insurance, v_taxes,
    v_compensation_lines, 'two_parts', now()
  )
  on conflict (employee_hr_id) do update
  set
    net_salary = excluded.net_salary,
    comprehensive_wage = excluded.comprehensive_wage,
    fuel_allowance = excluded.fuel_allowance,
    extra_cost_of_living = excluded.extra_cost_of_living,
    gross_salary = excluded.gross_salary,
    social_insurance = excluded.social_insurance,
    taxes = excluded.taxes,
    salary_details = excluded.salary_details,
    payment_mode = excluded.payment_mode,
    updated_at = now();

  if v_matching_vacancy_id is not null then
    update public.position_vacancies
    set status = 'filled',
        filled_by_hr_id = v_employee_hr_id,
        filled_at = now(),
        replacement_for_hr_id = null,
        note = 'Auto-closed by atomic offer approval for ' || v_employee_hr_id || '.',
        updated_at = now()
    where id = v_matching_vacancy_id;
  end if;

  update public.job_offers
  set employee_hr_id = v_employee_hr_id,
      reserved_employee_hr_id = v_employee_hr_id,
      onboarding_status = 'approved_hired',
      status = 'hired',
      base_salary = v_base_salary,
      basic_salary = v_basic_salary,
      gross_salary = v_gross_salary,
      net_salary = v_net_salary,
      salary_amount = v_net_salary,
      fuel_allowance = v_fuel_allowance,
      extra_cost_of_living = v_extra_cost_of_living,
      social_insurance = v_social_insurance,
      taxes = v_taxes,
      compensation_lines = v_compensation_lines,
      accepted_terms_snapshot = coalesce(
        accepted_terms_snapshot,
        jsonb_build_object(
          'candidateName', v_offer.candidate_name,
          'candidateEmail', v_offer.candidate_email,
          'jobTitle', v_offer.job_title,
          'startDate', v_offer.start_date,
          'departmentId', v_offer.department_id,
          'positionId', v_offer.position_id,
          'lineId', v_offer.line_id,
          'areaId', v_offer.area_id,
          'vacancyId', coalesce(v_offer.vacancy_id, v_matching_vacancy_id),
          'baseSalary', v_base_salary,
          'basicSalary', v_basic_salary,
          'grossSalary', v_gross_salary,
          'netSalary', v_net_salary,
          'fuelAllowance', v_fuel_allowance,
          'extraCostOfLiving', v_extra_cost_of_living,
          'socialInsurance', v_social_insurance,
          'taxes', v_taxes,
          'compensationLines', v_compensation_lines,
          'acceptedAt', v_offer.accepted_at,
          'approvedAt', now()
        )
      ),
      approval_repair_status = 'pending_post_approval',
      approval_repair_error = null,
      updated_at = now()
  where id = v_offer.id;

  insert into public.job_offer_audit_logs (
    offer_id, action, actor_type, actor_reference, details
  ) values (
    v_offer.id,
    'hire_approved',
    'hr',
    p_approved_by_hr_id,
    jsonb_build_object(
      'employeeHrId', v_employee_hr_id,
      'vacancyId', v_matching_vacancy_id,
      'status', 'hired',
      'customEarnings', v_custom_earnings,
      'customDeductions', v_custom_deductions,
      'atomic', true
    )
  );

  return jsonb_build_object(
    'already_hired', false,
    'employee_hr_id', v_employee_hr_id,
    'offer_id', v_offer.id,
    'vacancy_id', v_matching_vacancy_id
  );
end;
$$;
create or replace function public.phx_approve_accepted_offer(
  p_offer_id uuid,
  p_approved_by_hr_id text default null,
  p_employee_hr_id text default null,
  p_gross_salary numeric default null,
  p_fuel_allowance numeric default null,
  p_extra_cost_of_living numeric default null,
  p_base_salary numeric default null,
  p_basic_salary numeric default null,
  p_net_salary numeric default null,
  p_social_insurance numeric default null,
  p_taxes numeric default null,
  p_compensation_lines jsonb default null
)
returns jsonb
language sql
security invoker
set search_path = public, private
as $$
  select private.phx_approve_accepted_offer_v2(
    p_offer_id,
    p_approved_by_hr_id,
    p_employee_hr_id,
    p_gross_salary,
    p_fuel_allowance,
    p_extra_cost_of_living,
    p_base_salary,
    p_basic_salary,
    p_net_salary,
    p_social_insurance,
    p_taxes,
    p_compensation_lines
  );
$$;
revoke all on function private.phx_approve_accepted_offer_v2(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb
) from public, anon, authenticated;
grant execute on function private.phx_approve_accepted_offer_v2(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb
) to service_role;
revoke all on function public.phx_approve_accepted_offer(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.phx_approve_accepted_offer(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, jsonb
) to service_role;
