-- The payroll batch delete path used to switch off its own guards.
--
-- Three triggers exist to make "a published and announced month is never corrected" mechanical:
--   * phx_prevent_closed_salary_batch_delete   on salary_batches
--   * phx_prevent_closed_salary_records_mutation on salary_records
--   * phx_prevent_closed_salary_flags_mutation on salary_flags
-- All three begin by checking request.phx_allow_salary_batch_delete and returning early when it
-- is 'on'. phx_delete_salary_batch set that flag as its third statement, unconditionally, and
-- then never tested the status it had just read into v_batch — it returned it in the payload and
-- otherwise ignored it. So every delete through the application ran with all three guards
-- disarmed, including for a locked month whose Part 1 had already been paid.
--
-- At the time this was found, every batch in production was in the protected state (3 approved,
-- 5 locked, all but two with Part 1 paid; 896 salary_records between them). Not one was
-- legitimately deletable, and all eight were deletable through the admin screen, behind a single
-- browser confirm. Production has no PITR.
--
-- The sibling guard phx_prevent_closed_salary_batch_update — same table, same migration, same
-- purpose — has no bypass at all, which is what marks this as an oversight rather than a choice.
--
-- Owner ruling, 2026-09-12: refuse it outright.
--
-- The rule below is the REPLACE rule, not the (looser) trigger rule. Deleting a batch removes the
-- batch, its salary_records and its salary_flags outright, so it is strictly more destructive than
-- replacing one and can never be permitted where a replace is refused. Keeping one definition of
-- "closed" is the point: a second, laxer one is how this class of hole reappears.
--
-- The bypass flag is still set, because the cascade below genuinely needs it to remove the
-- salary_records of a batch that IS deletable. It is now unreachable for a closed month: the
-- refusal is raised before it.

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

  -- Refuse a closed month outright, BEFORE the guards are bypassed below.
  if v_batch.status not in ('uploaded', 'part1_ready', 'rejected')
     or v_batch.part1_paid_at is not null then
    raise exception 'Payroll %/% is % and cannot be deleted. A month that has reached this stage is never deleted; correct it in the next month instead.',
      v_batch.month, v_batch.year, replace(v_batch.status, '_', ' ')
      using errcode = 'P0001';
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
