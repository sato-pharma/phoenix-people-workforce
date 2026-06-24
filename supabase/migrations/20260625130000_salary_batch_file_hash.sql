-- Phase 7: Payroll file-hash idempotency
-- Adds a SHA-256 content hash column to salary_batches and a partial unique index
-- so that uploading the same file to the same payroll period (even after deletion)
-- is detected and rejected with a friendly error rather than silently accepted.

alter table public.salary_batches
  add column if not exists file_content_hash text;

comment on column public.salary_batches.file_content_hash is
  'SHA-256 hex digest of the uploaded file bytes. Prevents re-upload of the same '
  'file to the same payroll period after a batch is deleted.';

-- NULLs do not trigger unique violations, so old/migrated batches without a hash
-- are unaffected. Only new uploads with a hash are checked.
create unique index if not exists salary_batches_period_hash_uniq
  on public.salary_batches (month, year, file_content_hash)
  where file_content_hash is not null;

-- ── Replace phx_create_salary_batch with an 8-parameter version ──────────────
-- DROP first because CREATE OR REPLACE cannot change the parameter list.
-- The new function can still be called with 7 args (8th defaults to NULL) so
-- existing call-sites continue to work without modification.
drop function if exists public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamptz);

create function public.phx_create_salary_batch(
  p_month integer,
  p_year integer,
  p_file_name text,
  p_uploaded_by text,
  p_records jsonb,
  p_flags jsonb,
  p_created_at timestamptz,
  p_file_content_hash text default null
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

revoke all on function public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamptz, text) from public, anon, authenticated;
grant execute on function public.phx_create_salary_batch(integer, integer, text, text, jsonb, jsonb, timestamptz, text) to service_role;
