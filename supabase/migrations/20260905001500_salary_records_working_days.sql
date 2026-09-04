-- Payroll sheet: show the FULL contractual salary, explain it with Working Days.
--
-- Owner rule, 2026-09-04: "You will show the full salary, and we will add a new
-- column of the working days ... we will make the calculation but never show."
-- A joiner or leaver is still PAID for their working days only — that proration
-- is unchanged and continues to live in month_salary / first_part / second_part.
-- What changes is what the salary columns DISPLAY: base_salary, gross_salary,
-- net_salary, extra_cost_of_living and fuel_allowance now carry the contract
-- figure, and these two columns are what account for the difference.
--
-- Both are NULLABLE with no default, deliberately. Every historical row predates
-- the rule and we genuinely do not know its day count; NULL says exactly that,
-- where a default of 0 or 30 would invent one. Readers treat NULL as "not
-- recorded" and print nothing rather than a fabricated number.
--
-- Additive and non-destructive: no existing row is rewritten, no column is
-- dropped or retyped, and code deployed before this migration is unaffected
-- because it never references either column.

alter table public.salary_records
  add column if not exists working_days integer,
  add column if not exists calendar_days integer;

comment on column public.salary_records.working_days is
  'Days of the payroll period the employee was on payroll — the "Working Days" sheet column. Equals calendar_days for a regular employee. NULL for rows written before 2026-09-04, where the day count was never recorded.';

comment on column public.salary_records.calendar_days is
  'Calendar days in the payroll period (28-31) — the proration denominator behind working_days. NULL for rows written before 2026-09-04.';

-- A day count is only ever a count of days within the period, and cannot exceed
-- it. NOT VALID so the constraint applies to new and updated rows without
-- forcing a full-table rewrite on a live payroll table; the historical rows it
-- skips are all NULL, which the constraint would accept anyway.
alter table public.salary_records
  drop constraint if exists salary_records_working_days_range;

alter table public.salary_records
  add constraint salary_records_working_days_range
  check (
    working_days is null
    or (
      working_days >= 0
      and working_days <= coalesce(calendar_days, 31)
    )
  )
  not valid;

alter table public.salary_records
  drop constraint if exists salary_records_calendar_days_range;

alter table public.salary_records
  add constraint salary_records_calendar_days_range
  check (calendar_days is null or (calendar_days between 28 and 31))
  not valid;

-- ---------------------------------------------------------------------------
-- The two writers must learn the columns, or adding them changes nothing.
--
-- Both upload paths insert into salary_records through an EXPLICIT column list
-- inside a plpgsql function, and both read their values out of a
-- jsonb_to_recordset whose column types are declared just as explicitly. A key
-- the recordset does not declare is silently dropped: the upload would succeed,
-- every row would store NULL, and the sheet would show a blank Working Days
-- column with no error anywhere. `verifySalaryRecordPayloads` in
-- src/lib/payroll/service.ts reads the batch back and compares every payload
-- column, so in practice the upload would instead fail outright, after the batch
-- row had already been created.
--
-- Either way the application change cannot ship before this migration. Both
-- bodies below are the live definitions (pg_get_functiondef, production
-- ozucdzovmcqvepbozvqf, 2026-09-04) with the two columns appended to the three
-- lists that must agree — insert columns, select expressions, recordset types —
-- and NOTHING else altered.

create or replace function public.phx_create_salary_batch(p_month integer, p_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_created_at timestamp with time zone, p_file_content_hash text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
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
      updated_at,
      file_content_hash
    )
    values (
      p_file_name,
      p_month,
      p_year,
      'uploaded',
      p_uploaded_by,
      p_created_at,
      p_created_at,
      p_file_content_hash
    )
    returning *
    into v_batch;
  exception
    when unique_violation then
      if sqlerrm ilike '%salary_batches_period_hash_uniq%' then
        raise exception 'This exact file has already been uploaded for payroll period %/%.', p_month, p_year using errcode = '23505';
      else
        raise exception 'Payroll period %/% already has a batch.', p_month, p_year using errcode = '23505';
      end if;
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
    unpaid_vacations,
    working_days,
    calendar_days
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
    r.governmental_deductions,
    r.gross_salary,
    r.hire_date,
    r.hr_id,
    r.incentive,
    r.job_title,
    r.line,
    r.loans,
    r.medical_insurance,
    r.month_salary,
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
    r.unpaid_vacations,
    r.working_days,
    r.calendar_days
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
    unpaid_vacations numeric,
    working_days integer,
    calendar_days integer
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
$function$;

create or replace function public.phx_replace_salary_batch(p_batch_id uuid, p_expected_month integer, p_expected_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_updated_at timestamp with time zone)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
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
    unpaid_vacations,
    working_days,
    calendar_days
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
    r.unpaid_vacations,
    r.working_days,
    r.calendar_days
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
    unpaid_vacations numeric,
    working_days integer,
    calendar_days integer
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
$function$;

-- The grants pg_get_functiondef does not carry. CREATE OR REPLACE keeps the
-- existing ACL, so these are belt-and-braces: they restate exactly what the
-- baseline granted, and make the migration safe to run against a database where
-- the function had to be created from scratch.
revoke all on function public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamp with time zone, text) from public;
grant all on function public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamp with time zone, text) to service_role;

revoke all on function public.phx_replace_salary_batch(uuid, integer, integer, text, text, jsonb, jsonb, timestamp with time zone) from public;
grant all on function public.phx_replace_salary_batch(uuid, integer, integer, text, text, jsonb, jsonb, timestamp with time zone) to service_role;
