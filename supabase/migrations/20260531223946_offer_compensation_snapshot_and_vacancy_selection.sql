-- Offer lifecycle hardening: vacancy-specific selection and immutable
-- compensation snapshot for payroll handoff.

alter table public.job_offers
  add column if not exists vacancy_id bigint null references public.position_vacancies(id) on update cascade on delete set null,
  add column if not exists base_salary numeric null,
  add column if not exists basic_salary numeric null,
  add column if not exists gross_salary numeric null,
  add column if not exists net_salary numeric null,
  add column if not exists fuel_allowance numeric null,
  add column if not exists extra_cost_of_living numeric null,
  add column if not exists social_insurance numeric null,
  add column if not exists taxes numeric null,
  add column if not exists compensation_notes text null;

alter table public.job_offers
  drop constraint if exists job_offers_status_check;

alter table public.job_offers
  add constraint job_offers_status_check
  check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired', 'hired'));

create index if not exists job_offers_vacancy_id_idx on public.job_offers (vacancy_id);

drop function if exists public.phx_approve_accepted_offer(
  uuid, text, text, numeric, numeric, numeric
);

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
  p_taxes numeric default null
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
  v_base_salary numeric;
  v_basic_salary numeric;
  v_gross_salary numeric;
  v_net_salary numeric;
  v_fuel_allowance numeric;
  v_extra_cost_of_living numeric;
  v_social_insurance numeric;
  v_taxes numeric;
begin
  select *
  into v_offer
  from public.job_offers
  where id = p_offer_id
  for update;

  if not found then
    raise exception 'Offer not found.';
  end if;

  if v_offer.status = 'hired' and v_offer.employee_hr_id is not null then
    return jsonb_build_object(
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

  if v_offer.line_id is null then
    raise exception 'Cannot approve offer without line assignment.';
  end if;

  if v_offer.area_id is null then
    raise exception 'Cannot approve offer without area assignment.';
  end if;

  if coalesce(trim(v_offer.manager_hr_id), '') = '' then
    raise exception 'Cannot approve offer without manager HR ID.';
  end if;

  v_base_salary := coalesce(p_base_salary, v_offer.base_salary);
  v_basic_salary := coalesce(p_basic_salary, v_offer.basic_salary, round(coalesce(v_base_salary, 0) * 0.7, 2));
  v_fuel_allowance := coalesce(p_fuel_allowance, v_offer.fuel_allowance, 0);
  v_extra_cost_of_living := coalesce(p_extra_cost_of_living, v_offer.extra_cost_of_living, 0);
  v_social_insurance := coalesce(p_social_insurance, v_offer.social_insurance, 0);
  v_taxes := coalesce(p_taxes, v_offer.taxes, 0);
  v_gross_salary := coalesce(p_gross_salary, v_offer.gross_salary, coalesce(v_base_salary, 0) + v_social_insurance + v_taxes);
  v_net_salary := coalesce(p_net_salary, v_offer.net_salary, v_offer.salary_amount, coalesce(v_base_salary, 0) + v_extra_cost_of_living + v_fuel_allowance);

  if coalesce(v_base_salary, 0) <= 0 then
    raise exception 'Cannot approve offer without base salary.';
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

      select coalesce(max(nullif(substring(hr_id from ('^' || v_prefix || '-([0-9]+)$')), '')::integer), 0) + 1
      into v_candidate
      from public.employees
      where hr_id like v_prefix || '-%';

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
    payment_mode, updated_at
  ) values (
    v_employee_hr_id, v_net_salary, v_base_salary, v_fuel_allowance,
    v_extra_cost_of_living, v_gross_salary, v_social_insurance, v_taxes,
    'two_parts', now()
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
    payment_mode = excluded.payment_mode,
    updated_at = now();

  if v_offer.vacancy_id is not null then
    select pv.id
    into v_matching_vacancy_id
    from public.position_vacancies pv
    where pv.id = v_offer.vacancy_id
      and pv.status = 'open'
      and (v_offer.department_id is null or pv.department_id is null or pv.department_id = v_offer.department_id)
    limit 1
    for update;
  end if;

  update public.job_offers
  set employee_hr_id = v_employee_hr_id,
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
      'baseSalary', v_base_salary,
      'basicSalary', v_basic_salary,
      'netSalary', v_net_salary
    )
  );

  return jsonb_build_object(
    'employee_hr_id', v_employee_hr_id,
    'offer_id', v_offer.id,
    'vacancy_id', v_matching_vacancy_id
  );
end;
$$;

revoke all on function public.phx_approve_accepted_offer(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) from public, anon, authenticated;

grant execute on function public.phx_approve_accepted_offer(
  uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric
) to service_role;
