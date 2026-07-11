-- Set the standard extra cost of living allowance for manager roles that were
-- previously falling back to the generic 1500 EGP rule.

do $$
begin
  if to_regclass('public.employees') is not null then
    with affected_employees as (
      select
        source.hr_id
      from (
        select
          e.hr_id,
          lower(concat_ws(' ', e.job_title, p.title)) as title,
          regexp_replace(lower(concat_ws(' ', e.job_title, p.title)), '[^a-z0-9]+', '', 'g') as compact_title
        from public.employees e
        left join public.positions p on p.id = e.position_id
      ) source
      where source.title like '%regional sales manager%'
        or source.title like '%regional manager%'
        or source.title like '%field manager%'
        or source.title like '%training manager%'
        or source.title ~ '(^|[^a-z0-9])rsms?([^a-z0-9]|$)'
        or source.compact_title ~ '^rsms?$'
    )
    update public.employees e
    set
      extra_cost_of_living = 3000,
      net_salary = case
        when e.base_salary is not null and e.base_salary > 0
          then round((e.base_salary + 3000 + coalesce(e.fuel_allowance, 0))::numeric, 2)
        else e.net_salary
      end
    from affected_employees a
    where a.hr_id = e.hr_id
      and (
        e.extra_cost_of_living is distinct from 3000
        or (
          e.base_salary is not null
          and e.base_salary > 0
          and e.net_salary is distinct from round((e.base_salary + 3000 + coalesce(e.fuel_allowance, 0))::numeric, 2)
        )
      );
  end if;

  if to_regclass('public.employee_compensation') is not null
    and to_regclass('public.employees') is not null
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
        and column_name = 'net_salary'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'employee_compensation'
        and column_name = 'fuel_allowance'
    )
  then
    with affected_employees as (
      select
        source.hr_id,
        source.base_salary,
        source.fuel_allowance
      from (
        select
          e.hr_id,
          e.base_salary,
          e.fuel_allowance,
          lower(concat_ws(' ', e.job_title, p.title)) as title,
          regexp_replace(lower(concat_ws(' ', e.job_title, p.title)), '[^a-z0-9]+', '', 'g') as compact_title
        from public.employees e
        left join public.positions p on p.id = e.position_id
      ) source
      where source.title like '%regional sales manager%'
        or source.title like '%regional manager%'
        or source.title like '%field manager%'
        or source.title like '%training manager%'
        or source.title ~ '(^|[^a-z0-9])rsms?([^a-z0-9]|$)'
        or source.compact_title ~ '^rsms?$'
    )
    update public.employee_compensation ec
    set
      extra_cost_of_living = 3000,
      net_salary = case
        when a.base_salary is not null and a.base_salary > 0
          then round((a.base_salary + 3000 + coalesce(nullif(ec.fuel_allowance, 0), a.fuel_allowance, 0))::numeric, 2)
        else ec.net_salary
      end
    from affected_employees a
    where ec.employee_hr_id = a.hr_id
      and (
        ec.extra_cost_of_living is distinct from 3000
        or (
          a.base_salary is not null
          and a.base_salary > 0
          and ec.net_salary is distinct from round((a.base_salary + 3000 + coalesce(nullif(ec.fuel_allowance, 0), a.fuel_allowance, 0))::numeric, 2)
        )
      );
  end if;
end $$;
