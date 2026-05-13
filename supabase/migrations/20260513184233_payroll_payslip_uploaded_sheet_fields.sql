alter table public.salary_records
  add column if not exists base_salary numeric not null default 0,
  add column if not exists governmental_deductions numeric not null default 0,
  add column if not exists month_salary numeric not null default 0,
  add column if not exists payment_mode text not null default 'two_parts';

alter table public.salary_records disable trigger phx_prevent_closed_salary_records_mutation;

update public.salary_records
set
  base_salary = case
    when coalesce(base_salary, 0) = 0 then greatest(
      coalesce(net_salary, 0) - coalesce(extra_cost_of_living, 0) - coalesce(fuel_allowance, 0),
      0
    )
    else base_salary
  end,
  governmental_deductions = case
    when coalesce(governmental_deductions, 0) = 0 then coalesce(social_insurance, 0) + coalesce(employment_income_tax, 0)
    else governmental_deductions
  end,
  month_salary = case
    when coalesce(month_salary, 0) = 0 then coalesce(first_part, 0) + coalesce(second_part, 0)
    else month_salary
  end,
  payment_mode = case
    when payment_mode in ('one_part', 'two_parts') then payment_mode
    when coalesce(first_part, 0) > 0 and coalesce(first_part, 0) >= coalesce(net_salary, 0) - 1 then 'one_part'
    else 'two_parts'
  end;

alter table public.salary_records enable trigger phx_prevent_closed_salary_records_mutation;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'salary_records_payment_mode_check'
      and conrelid = 'public.salary_records'::regclass
  ) then
    alter table public.salary_records
      add constraint salary_records_payment_mode_check
      check (payment_mode in ('one_part', 'two_parts'));
  end if;
end;
$$;

create or replace function public.phx_prevent_closed_salary_detail_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_batch_status text;
  v_part1_paid_at timestamptz;
begin
  if tg_op = 'DELETE' then
    v_batch_id := old.batch_id;
  else
    v_batch_id := new.batch_id;
  end if;

  select status, part1_paid_at
  into v_batch_status, v_part1_paid_at
  from public.salary_batches
  where id = v_batch_id;

  if v_batch_status in ('approved', 'locked') then
    raise exception 'Payroll batch cannot be changed while status is %.', v_batch_status using errcode = 'P0001';
  end if;

  if tg_table_name = 'salary_records' and v_part1_paid_at is not null then
    if tg_op <> 'UPDATE' then
      raise exception 'Salary records cannot be inserted or deleted after Part 1 is paid.' using errcode = 'P0001';
    end if;

    if new.batch_id is distinct from old.batch_id
      or new.hr_id is distinct from old.hr_id
      or new.full_name is distinct from old.full_name
      or new.name_ar is distinct from old.name_ar
      or new.job_title is distinct from old.job_title
      or new.line is distinct from old.line
      or new.area is distinct from old.area
      or new.hire_date is distinct from old.hire_date
      or new.base_salary is distinct from old.base_salary
      or new.gross_salary is distinct from old.gross_salary
      or new.net_salary is distinct from old.net_salary
      or new.first_part is distinct from old.first_part
      or new.extra_cost_of_living is distinct from old.extra_cost_of_living
      or new.fuel_allowance is distinct from old.fuel_allowance
      or new.social_insurance is distinct from old.social_insurance
      or new.employment_income_tax is distinct from old.employment_income_tax
      or new.governmental_deductions is distinct from old.governmental_deductions
      or new.payment_mode is distinct from old.payment_mode then
      raise exception 'Part 1 salary fields cannot be changed after Part 1 is paid.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
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

  if exists (
    select 1
    from jsonb_to_recordset(v_records) as r(payment_mode text)
    where coalesce(r.payment_mode, 'two_parts') not in ('one_part', 'two_parts')
  ) then
    raise exception 'Payroll upload payment_mode must be one_part or two_parts.' using errcode = '22023';
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
    base_salary,
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
    governmental_deductions,
    gross_salary,
    hire_date,
    hr_id,
    incentive,
    job_title,
    line,
    loans,
    medical_insurance,
    month_salary,
    name_ar,
    net_salary,
    other_additions,
    other_deductions,
    overtime,
    comment,
    payment_mode,
    second_part,
    social_insurance,
    total_additions,
    total_deductions,
    unpaid_vacations
  )
  select
    r.area,
    coalesce(r.base_salary, 0),
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
    coalesce(r.governmental_deductions, coalesce(r.social_insurance, 0) + coalesce(r.employment_income_tax, 0)),
    r.gross_salary,
    r.hire_date,
    r.hr_id,
    r.incentive,
    r.job_title,
    r.line,
    r.loans,
    r.medical_insurance,
    coalesce(r.month_salary, coalesce(r.first_part, 0) + coalesce(r.second_part, 0)),
    r.name_ar,
    r.net_salary,
    r.other_additions,
    r.other_deductions,
    r.overtime,
    r.comment,
    coalesce(r.payment_mode, 'two_parts'),
    r.second_part,
    r.social_insurance,
    r.total_additions,
    r.total_deductions,
    r.unpaid_vacations
  from jsonb_to_recordset(v_records) as r(
    area text,
    base_salary numeric,
    bonus numeric,
    crm numeric,
    employment_income_tax numeric,
    expenses numeric,
    extra_cost_of_living numeric,
    finger_print numeric,
    first_part numeric,
    fuel_allowance numeric,
    full_name text,
    governmental_deductions numeric,
    gross_salary numeric,
    hire_date date,
    hr_id text,
    incentive numeric,
    job_title text,
    line text,
    loans numeric,
    medical_insurance numeric,
    month_salary numeric,
    name_ar text,
    net_salary numeric,
    other_additions numeric,
    other_deductions numeric,
    overtime numeric,
    comment text,
    payment_mode text,
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

create or replace function public.phx_replace_salary_batch(
  p_batch_id uuid,
  p_expected_month integer,
  p_expected_year integer,
  p_file_name text,
  p_uploaded_by text,
  p_records jsonb,
  p_flags jsonb,
  p_updated_at timestamptz
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
  if jsonb_typeof(v_records) <> 'array' then
    raise exception 'Payroll replacement records must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_flags) <> 'array' then
    raise exception 'Payroll replacement flags must be a JSON array.' using errcode = '22023';
  end if;

  if jsonb_array_length(v_records) = 0 then
    raise exception 'Payroll replacement records must include at least one salary record.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_records) as r(payment_mode text)
    where coalesce(r.payment_mode, 'two_parts') not in ('one_part', 'two_parts')
  ) then
    raise exception 'Payroll replacement payment_mode must be one_part or two_parts.' using errcode = '22023';
  end if;

  select *
  into v_batch
  from public.salary_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Payroll upload not found.' using errcode = 'P0002';
  end if;

  if v_batch.part1_paid_at is not null or v_batch.status not in ('uploaded', 'part1_ready', 'rejected') then
    raise exception 'Payroll batch cannot be replaced after Part 1 is paid or while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  if v_batch.month is distinct from p_expected_month or v_batch.year is distinct from p_expected_year then
    raise exception 'Payroll batch period changed before replacement could be applied.' using errcode = 'P0001';
  end if;

  delete from public.salary_records
  where batch_id = p_batch_id;

  insert into public.salary_records (
    area,
    base_salary,
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
    governmental_deductions,
    gross_salary,
    hire_date,
    hr_id,
    incentive,
    job_title,
    line,
    loans,
    medical_insurance,
    month_salary,
    name_ar,
    net_salary,
    other_additions,
    other_deductions,
    overtime,
    comment,
    payment_mode,
    second_part,
    social_insurance,
    total_additions,
    total_deductions,
    unpaid_vacations
  )
  select
    r.area,
    coalesce(r.base_salary, 0),
    p_batch_id,
    r.bonus,
    r.crm,
    r.employment_income_tax,
    r.expenses,
    r.extra_cost_of_living,
    r.finger_print,
    r.first_part,
    r.fuel_allowance,
    r.full_name,
    coalesce(r.governmental_deductions, coalesce(r.social_insurance, 0) + coalesce(r.employment_income_tax, 0)),
    r.gross_salary,
    r.hire_date,
    r.hr_id,
    r.incentive,
    r.job_title,
    r.line,
    r.loans,
    r.medical_insurance,
    coalesce(r.month_salary, coalesce(r.first_part, 0) + coalesce(r.second_part, 0)),
    r.name_ar,
    r.net_salary,
    r.other_additions,
    r.other_deductions,
    r.overtime,
    r.comment,
    coalesce(r.payment_mode, 'two_parts'),
    r.second_part,
    r.social_insurance,
    r.total_additions,
    r.total_deductions,
    r.unpaid_vacations
  from jsonb_to_recordset(v_records) as r(
    area text,
    base_salary numeric,
    bonus numeric,
    crm numeric,
    employment_income_tax numeric,
    expenses numeric,
    extra_cost_of_living numeric,
    finger_print numeric,
    first_part numeric,
    fuel_allowance numeric,
    full_name text,
    governmental_deductions numeric,
    gross_salary numeric,
    hire_date date,
    hr_id text,
    incentive numeric,
    job_title text,
    line text,
    loans numeric,
    medical_insurance numeric,
    month_salary numeric,
    name_ar text,
    net_salary numeric,
    other_additions numeric,
    other_deductions numeric,
    overtime numeric,
    comment text,
    payment_mode text,
    second_part numeric,
    social_insurance numeric,
    total_additions numeric,
    total_deductions numeric,
    unpaid_vacations numeric
  );

  delete from public.salary_flags
  where batch_id = p_batch_id;

  insert into public.salary_flags (
    batch_id,
    flag_type,
    hr_id,
    message,
    severity
  )
  select
    p_batch_id,
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

  update public.salary_batches
  set
    approved_at = null,
    approved_by = null,
    file_name = p_file_name,
    locked_at = null,
    part1_paid_at = null,
    part1_paid_by = null,
    part2_ready_at = null,
    part2_ready_by = null,
    rejected_reason = null,
    status = 'uploaded',
    updated_at = p_updated_at,
    uploaded_by = p_uploaded_by
  where id = p_batch_id
  returning *
  into v_batch;

  return to_jsonb(v_batch);
end;
$$;

revoke all on function public.phx_replace_salary_batch(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.phx_replace_salary_batch(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz) to service_role;

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

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import expenses before Part 1 is paid or while status is %.', v_batch.status using errcode = 'P0001';
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
  )
  select
    count(*)::integer,
    coalesce(sum(approved_expense), 0)::numeric,
    coalesce(array_agg(hr_id order by hr_id), '{}'::text[])
  into
    v_imported_employees,
    v_imported_total,
    v_matched_employees
  from matched_totals;

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

revoke all on function public.phx_import_approved_expenses_to_payroll(integer, integer) from public, anon, authenticated;
grant execute on function public.phx_import_approved_expenses_to_payroll(integer, integer) to service_role;
