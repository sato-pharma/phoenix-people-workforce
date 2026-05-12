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

  select *
  into v_batch
  from public.salary_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Payroll upload not found.' using errcode = 'P0002';
  end if;

  if v_batch.status not in ('uploaded', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot be replaced while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  if v_batch.month is distinct from p_expected_month or v_batch.year is distinct from p_expected_year then
    raise exception 'Payroll batch period changed before replacement could be applied.' using errcode = 'P0001';
  end if;

  delete from public.salary_records
  where batch_id = p_batch_id;

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
