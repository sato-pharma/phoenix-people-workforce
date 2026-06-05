do $$
begin
  if exists (
    select 1
    from public.salary_batches
    group by year, month
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce unique payroll periods while duplicate salary_batches rows exist. Resolve duplicates manually before applying payroll hardening.' using errcode = '23505';
  end if;
end $$;
create unique index if not exists salary_batches_year_month_unique_idx
on public.salary_batches (year, month);
create or replace function public.phx_prevent_duplicate_salary_period()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.salary_batches existing
    where existing.month = new.month
      and existing.year = new.year
      and existing.id is distinct from new.id
  ) then
    raise exception 'Payroll period %/% already has a batch.', new.month, new.year using errcode = '23505';
  end if;

  return new;
end;
$$;
create or replace function public.phx_create_salary_batch(
  p_month integer,
  p_year integer,
  p_file_name text,
  p_uploaded_by text,
  p_records jsonb,
  p_flags jsonb,
  p_created_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch public.salary_batches%rowtype;
  v_records jsonb := coalesce(p_records, '[]'::jsonb);
  v_flags jsonb := coalesce(p_flags, '[]'::jsonb);
begin
  if p_month < 1 or p_month > 12 then
    raise exception 'Payroll month must be between 1 and 12.' using errcode = '22023';
  end if;

  if p_year < 2000 or p_year > 2100 then
    raise exception 'Payroll year must be between 2000 and 2100.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_records) <> 'array' then
    raise exception 'Payroll upload records must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_flags) <> 'array' then
    raise exception 'Payroll upload flags must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_array_length(v_records) = 0 then
    raise exception 'Payroll upload records must include at least one salary record.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_records) as record(value)
    where jsonb_typeof(record.value) <> 'object'
  ) then
    raise exception 'Payroll upload records must contain JSON objects.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_flags) as flag(value)
    where jsonb_typeof(flag.value) <> 'object'
  ) then
    raise exception 'Payroll upload flags must contain JSON objects.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_records) as r(hr_id text)
    where nullif(trim(coalesce(r.hr_id, '')), '') is null
  ) then
    raise exception 'Payroll upload records must include HR IDs.' using errcode = '22023';
  end if;

  begin
    insert into public.salary_batches (
      file_name,
      month,
      year,
      status,
      uploaded_by,
      created_at,
      updated_at
    )
    values (
      p_file_name,
      p_month,
      p_year,
      'uploaded',
      p_uploaded_by,
      p_created_at,
      p_created_at
    )
    returning *
    into v_batch;
  exception
    when unique_violation then
      raise exception 'Payroll period %/% already has a batch.', p_month, p_year using errcode = '23505';
  end;

  insert into public.salary_records (
    area,
    batch_id,
    bonus,
    crm,
    employment_income_tax,
    expenses,
    extra_cost_of_living,
    finger_print,
    first_part,
    fuel_allowance,
    full_name,
    gross_salary,
    hire_date,
    hr_id,
    incentive,
    job_title,
    line,
    loans,
    medical_insurance,
    name_ar,
    net_salary,
    other_additions,
    other_deductions,
    overtime,
    comment,
    second_part,
    social_insurance,
    total_additions,
    total_deductions,
    unpaid_vacations
  )
  select
    r.area,
    v_batch.id,
    r.bonus,
    r.crm,
    r.employment_income_tax,
    r.expenses,
    r.extra_cost_of_living,
    r.finger_print,
    r.first_part,
    r.fuel_allowance,
    r.full_name,
    r.gross_salary,
    r.hire_date,
    r.hr_id,
    r.incentive,
    r.job_title,
    r.line,
    r.loans,
    r.medical_insurance,
    r.name_ar,
    r.net_salary,
    r.other_additions,
    r.other_deductions,
    r.overtime,
    r.comment,
    r.second_part,
    r.social_insurance,
    r.total_additions,
    r.total_deductions,
    r.unpaid_vacations
  from jsonb_to_recordset(v_records) as r(
    area text,
    bonus numeric,
    crm numeric,
    employment_income_tax numeric,
    expenses numeric,
    extra_cost_of_living numeric,
    finger_print numeric,
    first_part numeric,
    fuel_allowance numeric,
    full_name text,
    gross_salary numeric,
    hire_date date,
    hr_id text,
    incentive numeric,
    job_title text,
    line text,
    loans numeric,
    medical_insurance numeric,
    name_ar text,
    net_salary numeric,
    other_additions numeric,
    other_deductions numeric,
    overtime numeric,
    comment text,
    second_part numeric,
    social_insurance numeric,
    total_additions numeric,
    total_deductions numeric,
    unpaid_vacations numeric
  );

  insert into public.salary_flags (
    batch_id,
    flag_type,
    hr_id,
    message,
    severity
  )
  select
    v_batch.id,
    f.flag_type,
    f.hr_id,
    f.message,
    coalesce(f.severity, 'warning')
  from jsonb_to_recordset(v_flags) as f(
    flag_type text,
    hr_id text,
    message text,
    severity text
  );

  return to_jsonb(v_batch);
end;
$$;
revoke all on function public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamptz) to service_role;
