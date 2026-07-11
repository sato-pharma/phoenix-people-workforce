-- Align fixed salary formula fields across Employee Master storage.
-- Canonical formulas:
--   basic_salary = base_salary * 70%
--   net_salary = base_salary + extra_cost_of_living + fuel_allowance
--   gross_salary = base_salary + social_insurance + taxes

do $$
begin
  if to_regclass('public.employees') is not null then
    update public.employees
    set base_salary = round((basic_salary / 0.7)::numeric, 2)
    where base_salary is null
      and basic_salary is not null
      and basic_salary > 0;

    update public.employees
    set
      extra_cost_of_living = coalesce(
        extra_cost_of_living,
        case
          when lower(coalesce(job_title, '')) like '%national sales manager%'
            or lower(coalesce(job_title, '')) ~ '(^|[^a-z0-9])nsms?([^a-z0-9]|$)' then 5000
          when lower(coalesce(job_title, '')) like '%district sales manager%'
            or lower(coalesce(job_title, '')) ~ '(^|[^a-z0-9])dsms?([^a-z0-9]|$)' then 3000
          when lower(coalesce(job_title, '')) like '%marketing manager%'
            or lower(coalesce(job_title, '')) like '%product manager%'
            or lower(coalesce(job_title, '')) like '%group product manager%'
            or lower(coalesce(job_title, '')) like '%training%'
            or lower(coalesce(job_title, '')) like '%trainer%' then 3000
          when lower(coalesce(job_title, '')) like '%medical representative%'
            or lower(coalesce(job_title, '')) like '%medical rep%'
            or lower(coalesce(job_title, '')) ~ '(^|[^a-z0-9])mrs?([^a-z0-9]|$)' then 2000
          else 1500
        end
      ),
      fuel_allowance = coalesce(fuel_allowance, 500)
    where base_salary is not null
      and base_salary > 0;

    update public.employees
    set
      basic_salary = round((base_salary * 0.7)::numeric, 2),
      net_salary = round((base_salary + coalesce(extra_cost_of_living, 0) + coalesce(fuel_allowance, 0))::numeric, 2),
      gross_salary = round((base_salary + coalesce(social_insurance, 0) + coalesce(taxes, 0))::numeric, 2)
    where base_salary is not null
      and base_salary > 0;
  end if;

  if to_regclass('public.employee_compensation') is not null
    and to_regclass('public.employees') is not null
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'gross_salary'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'net_salary'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'extra_cost_of_living'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'fuel_allowance'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'social_insurance'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'taxes'
    )
  then
    update public.employee_compensation ec
    set
      net_salary = round((
        e.base_salary
        + coalesce(nullif(ec.extra_cost_of_living, 0), e.extra_cost_of_living, 0)
        + coalesce(nullif(ec.fuel_allowance, 0), e.fuel_allowance, 0)
      )::numeric, 2),
      gross_salary = round((
        e.base_salary
        + coalesce(ec.social_insurance, e.social_insurance, 0)
        + coalesce(ec.taxes, e.taxes, 0)
      )::numeric, 2)
    from public.employees e
    where ec.employee_hr_id = e.hr_id
      and e.base_salary is not null
      and e.base_salary > 0;
  end if;
end $$;
