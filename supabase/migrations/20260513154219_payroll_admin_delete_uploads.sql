create or replace function public.phx_prevent_closed_salary_batch_delete()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(current_setting('request.phx_allow_salary_batch_delete', true), '') = 'on' then
    return old;
  end if;

  if old.status in ('approved', 'locked') or old.part1_paid_at is not null then
    raise exception 'Payroll batch cannot be deleted after Part 1 is paid or while status is %.', old.status using errcode = 'P0001';
  end if;

  return old;
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
  if tg_op = 'DELETE'
    and coalesce(current_setting('request.phx_allow_salary_batch_delete', true), '') = 'on' then
    return old;
  end if;

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

create or replace function public.phx_delete_salary_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch public.salary_batches%rowtype;
  v_deleted_flags integer := 0;
  v_deleted_records integer := 0;
begin
  if p_batch_id is null then
    raise exception 'Payroll upload id is required.' using errcode = '22023';
  end if;

  select *
  into v_batch
  from public.salary_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Payroll upload not found.' using errcode = 'P0002';
  end if;

  perform set_config('request.phx_allow_salary_batch_delete', 'on', true);

  delete from public.salary_flags
  where batch_id = p_batch_id;
  get diagnostics v_deleted_flags = row_count;

  delete from public.salary_records
  where batch_id = p_batch_id;
  get diagnostics v_deleted_records = row_count;

  delete from public.salary_batches
  where id = p_batch_id;

  return jsonb_build_object(
    'id', v_batch.id,
    'month', v_batch.month,
    'year', v_batch.year,
    'status', v_batch.status,
    'file_name', v_batch.file_name,
    'records_deleted', v_deleted_records,
    'flags_deleted', v_deleted_flags
  );
end;
$$;

revoke all on function public.phx_delete_salary_batch(uuid) from public, anon, authenticated;
grant execute on function public.phx_delete_salary_batch(uuid) to service_role;

revoke all on function public.phx_prevent_closed_salary_batch_delete() from public, anon, authenticated;
revoke all on function public.phx_prevent_closed_salary_detail_mutation() from public, anon, authenticated;
