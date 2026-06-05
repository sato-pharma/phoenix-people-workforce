alter table public.salary_batches
  add column if not exists part1_paid_at timestamptz,
  add column if not exists part1_paid_by text,
  add column if not exists part2_ready_at timestamptz,
  add column if not exists part2_ready_by text;
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
create or replace function public.phx_prevent_closed_salary_batch_delete()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status in ('approved', 'locked') or old.part1_paid_at is not null then
    raise exception 'Payroll batch cannot be deleted after Part 1 is paid or while status is %.', old.status using errcode = 'P0001';
  end if;

  return old;
end;
$$;
drop trigger if exists phx_prevent_closed_salary_batch_delete on public.salary_batches;
create trigger phx_prevent_closed_salary_batch_delete
before delete on public.salary_batches
for each row
execute function public.phx_prevent_closed_salary_batch_delete();
create or replace function public.phx_prevent_closed_salary_batch_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status in ('approved', 'locked') then
    if old.status = 'approved'
      and new.status = 'locked'
      and new.id is not distinct from old.id
      and new.month is not distinct from old.month
      and new.year is not distinct from old.year
      and new.file_name is not distinct from old.file_name
      and new.uploaded_by is not distinct from old.uploaded_by
      and new.approved_at is not distinct from old.approved_at
      and new.approved_by is not distinct from old.approved_by
      and new.part1_paid_at is not distinct from old.part1_paid_at
      and new.part1_paid_by is not distinct from old.part1_paid_by
      and new.part2_ready_at is not distinct from old.part2_ready_at
      and new.part2_ready_by is not distinct from old.part2_ready_by
      and new.rejected_reason is not distinct from old.rejected_reason
      and new.created_at is not distinct from old.created_at then
      return new;
    end if;

    raise exception 'Payroll batch cannot be updated while status is %.', old.status using errcode = 'P0001';
  end if;

  return new;
end;
$$;
drop trigger if exists phx_prevent_closed_salary_batch_update on public.salary_batches;
create trigger phx_prevent_closed_salary_batch_update
before update on public.salary_batches
for each row
execute function public.phx_prevent_closed_salary_batch_update();
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
      or new.net_salary is distinct from old.net_salary
      or new.first_part is distinct from old.first_part
      or new.extra_cost_of_living is distinct from old.extra_cost_of_living
      or new.fuel_allowance is distinct from old.fuel_allowance then
      raise exception 'Part 1 salary fields cannot be changed after Part 1 is paid.' using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;
drop trigger if exists phx_prevent_closed_salary_records_mutation on public.salary_records;
create trigger phx_prevent_closed_salary_records_mutation
before insert or update or delete on public.salary_records
for each row
execute function public.phx_prevent_closed_salary_detail_mutation();
drop trigger if exists phx_prevent_closed_salary_flags_mutation on public.salary_flags;
create trigger phx_prevent_closed_salary_flags_mutation
before insert or update or delete on public.salary_flags
for each row
execute function public.phx_prevent_closed_salary_detail_mutation();
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
        second_part = coalesce(sr.second_part, 0) - coalesce(sr.expenses, 0) + coalesce(at.approved_expense, 0)
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
revoke all on function public.phx_prevent_closed_salary_batch_delete() from public, anon, authenticated;
revoke all on function public.phx_prevent_closed_salary_batch_update() from public, anon, authenticated;
revoke all on function public.phx_prevent_closed_salary_detail_mutation() from public, anon, authenticated;
revoke all on function public.phx_import_approved_expenses_to_payroll(integer, integer) from public, anon, authenticated;
grant execute on function public.phx_import_approved_expenses_to_payroll(integer, integer) to service_role;
