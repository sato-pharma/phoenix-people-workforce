-- Employee Master fixed fields for Phoenix Workforce.
-- Adds nullable master-data columns only; lifecycle flags and terminal visibility are intentionally untouched.
-- Compensation/location/contract values are copied into public.employees so the Employee Master workbook
-- can be populated without mixing in Users & Access fields or deleting legacy operational tables.

alter table public.employees
  add column if not exists national_id text,
  add column if not exists gender text,
  add column if not exists bank_account text,
  add column if not exists social_insurance_number text,
  add column if not exists medical_insurance_number text,
  add column if not exists basic_salary numeric,
  add column if not exists base_salary numeric,
  add column if not exists gross_salary numeric,
  add column if not exists net_salary numeric,
  add column if not exists fuel_allowance numeric,
  add column if not exists extra_cost_of_living numeric,
  add column if not exists medical_insurance numeric,
  add column if not exists social_insurance numeric,
  add column if not exists taxes numeric,
  add column if not exists payment_mode text,
  add column if not exists residence_address text,
  add column if not exists residence_city text,
  add column if not exists residence_area text,
  add column if not exists contract_type text;

comment on column public.employees.national_id is 'Government national identity number captured as fixed employee master data.';
comment on column public.employees.gender is 'Employee gender value for HR master data reporting.';
comment on column public.employees.bank_account is 'Employee bank account reference used by HR/payroll operations.';
comment on column public.employees.social_insurance_number is 'Employee social insurance identifier.';
comment on column public.employees.medical_insurance_number is 'Employee medical insurance identifier.';
comment on column public.employees.basic_salary is 'Fixed employee master basic salary reference. Initialized from base_salary only when no more explicit source exists.';
comment on column public.employees.base_salary is 'Fixed employee master base salary reference. Backfilled from employee_compensation/salary_records where available.';
comment on column public.employees.gross_salary is 'Fixed employee master gross salary reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.net_salary is 'Fixed employee master net salary reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.fuel_allowance is 'Fixed employee master fuel allowance reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.extra_cost_of_living is 'Fixed employee master extra cost of living reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.medical_insurance is 'Fixed employee master medical insurance amount/reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.social_insurance is 'Fixed employee master social insurance amount/reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.taxes is 'Fixed employee master tax amount/reference copied from employee_compensation first, salary_records fallback second.';
comment on column public.employees.payment_mode is 'Fixed employee master salary payment mode copied from employee_compensation when available.';
comment on column public.employees.residence_address is 'Employee residence address copied from employee_locations when available.';
comment on column public.employees.residence_city is 'Employee residence city copied from employee_locations when available.';
comment on column public.employees.residence_area is 'Employee residence area copied from employee_locations when available.';
comment on column public.employees.contract_type is 'Employee fixed contract type copied from employee_contracts when available.';

do $$
declare
  source_column text;
  salary_hr_column text;
  salary_order_clause text;
begin
  -- Primary fixed compensation source: employee_compensation.
  if to_regclass('public.employee_compensation') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'gross_salary') then
      execute 'update public.employees e set gross_salary = ec.gross_salary from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.gross_salary is null and ec.gross_salary is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'net_salary') then
      execute 'update public.employees e set net_salary = ec.net_salary from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.net_salary is null and ec.net_salary is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'fuel_allowance') then
      execute 'update public.employees e set fuel_allowance = ec.fuel_allowance from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.fuel_allowance is null and ec.fuel_allowance is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'extra_cost_of_living') then
      execute 'update public.employees e set extra_cost_of_living = ec.extra_cost_of_living from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.extra_cost_of_living is null and ec.extra_cost_of_living is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'medical_insurance') then
      execute 'update public.employees e set medical_insurance = ec.medical_insurance from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.medical_insurance is null and ec.medical_insurance is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'social_insurance') then
      execute 'update public.employees e set social_insurance = ec.social_insurance from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.social_insurance is null and ec.social_insurance is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'taxes') then
      execute 'update public.employees e set taxes = ec.taxes from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.taxes is null and ec.taxes is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_compensation' and column_name = 'payment_mode') then
      execute 'update public.employees e set payment_mode = ec.payment_mode from public.employee_compensation ec where ec.employee_hr_id = e.hr_id and e.payment_mode is null and ec.payment_mode is not null';
    end if;
  end if;

  -- Residence source: employee_locations.
  if to_regclass('public.employee_locations') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_locations' and column_name = 'residence_address') then
      execute 'update public.employees e set residence_address = el.residence_address from public.employee_locations el where el.employee_hr_id = e.hr_id and e.residence_address is null and el.residence_address is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_locations' and column_name = 'residence_city') then
      execute 'update public.employees e set residence_city = el.residence_city from public.employee_locations el where el.employee_hr_id = e.hr_id and e.residence_city is null and el.residence_city is not null';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_locations' and column_name = 'residence_area') then
      execute 'update public.employees e set residence_area = el.residence_area from public.employee_locations el where el.employee_hr_id = e.hr_id and e.residence_area is null and el.residence_area is not null';
    end if;
  end if;

  -- Contract source: employee_contracts. Supports both historical hr_id and newer employee_hr_id columns.
  if to_regclass('public.employee_contracts') is not null
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_contracts' and column_name = 'contract_type')
  then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_contracts' and column_name = 'employee_hr_id') then
      source_column := 'employee_hr_id';
    elsif exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_contracts' and column_name = 'hr_id') then
      source_column := 'hr_id';
    else
      source_column := null;
    end if;

    if source_column is not null then
      execute format(
        'with ranked_contracts as (
           select %1$I as hr_id, contract_type,
             row_number() over (
               partition by %1$I
               order by updated_at desc nulls last, created_at desc nulls last
             ) as row_number
           from public.employee_contracts
           where %1$I is not null and contract_type is not null
         )
         update public.employees e
         set contract_type = rc.contract_type
         from ranked_contracts rc
         where rc.row_number = 1
           and rc.hr_id = e.hr_id
           and e.contract_type is null',
        source_column
      );
    end if;
  end if;

  -- Fallback payroll snapshot source: latest salary_records per HR_ID.
  if to_regclass('public.salary_records') is not null then
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_records' and column_name = 'hr_id') then
      salary_hr_column := 'hr_id';
    elsif exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_records' and column_name = 'employee_code') then
      salary_hr_column := 'employee_code';
    else
      salary_hr_column := null;
    end if;

    if salary_hr_column is not null then
      if to_regclass('public.salary_batches') is not null
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_records' and column_name = 'batch_id')
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_batches' and column_name = 'year')
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_batches' and column_name = 'month')
      then
        salary_order_clause := 'sb.year desc nulls last, sb.month desc nulls last, sr.created_at desc nulls last, sr.id desc';
      else
        salary_order_clause := 'sr.created_at desc nulls last, sr.id desc';
      end if;

      if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_records' and column_name = 'base_salary') then
        execute format(
          'with latest_salary as (
             select sr.%1$I as hr_id, nullif(sr.base_salary, 0) as value,
               row_number() over (partition by sr.%1$I order by %2$s) as row_number
             from public.salary_records sr
             %3$s
             where sr.%1$I is not null
           )
           update public.employees e
           set base_salary = ls.value
           from latest_salary ls
           where ls.row_number = 1 and ls.hr_id = e.hr_id and e.base_salary is null and ls.value is not null',
          salary_hr_column,
          salary_order_clause,
          case when salary_order_clause like 'sb.%' then 'left join public.salary_batches sb on sb.id = sr.batch_id' else '' end
        );
      end if;

      foreach source_column in array array['gross_salary','net_salary','fuel_allowance','extra_cost_of_living','medical_insurance','social_insurance','taxes','employment_income_tax']
      loop
        if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'salary_records' and column_name = source_column) then
          execute format(
            'with latest_salary as (
               select sr.%1$I as hr_id, nullif(sr.%2$I, 0) as value,
                 row_number() over (partition by sr.%1$I order by %3$s) as row_number
               from public.salary_records sr
               %4$s
               where sr.%1$I is not null
             )
             update public.employees e
             set %5$I = ls.value
             from latest_salary ls
             where ls.row_number = 1 and ls.hr_id = e.hr_id and e.%5$I is null and ls.value is not null',
            salary_hr_column,
            source_column,
            salary_order_clause,
            case when salary_order_clause like 'sb.%' then 'left join public.salary_batches sb on sb.id = sr.batch_id' else '' end,
            case when source_column = 'employment_income_tax' then 'taxes' else source_column end
          );
        end if;
      end loop;
    end if;
  end if;

  -- Basic salary is not always explicit. Initialize from base salary only when no explicit basic salary exists.
  update public.employees
  set basic_salary = base_salary
  where basic_salary is null
    and base_salary is not null;
end $$;
