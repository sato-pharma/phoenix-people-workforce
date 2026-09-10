-- The legacy outstation -> payroll import must never touch a month Automated Payroll already paid.
--
-- THE PROBLEM, measured on production 2026-09-10. `phx_import_approved_expenses_to_payroll` pays an
-- approved outstation trip and then STAMPS it (`imported_payroll_batch_id`, `imported_to_payroll_at`,
-- `imported_to_payroll_by`). That stamp is the only thing standing between a trip and being paid a
-- second time, and the Automated Payroll wizard -- which is the live payroll path since July 2026 --
-- does not write it. It reads the stamp (recommend.ts skips a stamped row) but never sets one.
--
-- So of the 374 rows in `outstation_expenses`, not one carries an `imported_payroll_batch_id`, and
-- 340 satisfy this function's own payroll-grade predicate: EGP 138,453 across payout periods
-- 2026-02 .. 2026-10, including the trips behind the expense figures the wizard actually paid in the
-- July and August batches. Run this import against a batch it can reach and all of that money is
-- ADDED to `salary_records.expenses` again. (Exactly five rows are already excluded, carrying an
-- `imported_to_payroll_at` written by a third path, `final-settlement:B-175`, in August.)
--
-- WHY IT HAS NOT FIRED. Luck, not design, and the additive-import test already says so in as many
-- words. The status gate below admits `part1_paid`, `adjustments_open`, `part2_ready`,
-- `under_review` and `rejected`; the wizard finalises its batches to `approved`, which is outside
-- that set. Nothing keeps it there. The old Payroll Management workflow can still move an automated
-- batch to `under_review` or `rejected`, and the moment it does, one click on "Import to payroll"
-- pays those trips twice.
--
-- WHY THIS IS NOT THE STAMP ITSELF. The obvious repair -- have the wizard stamp the trips whose
-- money it paid -- cannot be written today, because that link does not exist in the data. The
-- wizard's expense figures are typed, not derived: all fifteen non-zero values in the August run
-- were written in a single save at 2026-09-08 14:09 Cairo, every `expenses_note` is empty, and the
-- figures do not reconcile to the trips. Saad Mohamed Saad Salama was paid EGP 4,203 of expenses in
-- August while holding zero trips in August's payout period and 55 unstamped trips spread across
-- 2026-03 .. 2026-09. There is no honest way to say which trips that 4,203 settled. Recording the
-- consumed trips at confirm time is the real fix and it needs an owner decision about what the
-- typed figure means; this migration closes the exposure in the meantime and is correct either way.
--
-- THE CHANGE. Two guards, both keyed on the same helper so the two readings cannot drift:
--
--   1. The import REFUSES OUTRIGHT when its target batch was produced by Automated Payroll. Loud,
--      not silent -- importing nothing would read as "there was nothing to import".
--   2. `importable` excludes every trip whose own payout period was paid by Automated Payroll.
--      This is the carry-forward half and it is the one that matters most: the import sweeps every
--      period AT OR BEFORE the target, so a legacy batch opened for a later month would otherwise
--      drag July's and August's wizard-paid trips in behind it.
--
-- REHEARSED ON STAGING (project cifwmndunmlxjhyjugxa) before this shipped, where July 2026 is a
-- wizard batch and February is a legacy one. The helper answered true for July, false for February,
-- and false for a month with no batch at all. `importable` for a 2026-09 target fell from 86 rows to
-- 21: guard 2 removed the 65 wizard-paid July trips, EGP 28,178. Calling the import for July raised
-- P0001 with the message below, and a control call for 2025-12 (no batch) still returned its empty
-- result, proving the function itself runs rather than failing for some unrelated reason. Nothing on
-- staging was stamped or written by either call.
--
-- The helper reads TWO independent signals and accepts either, because each covers the other's
-- weakness: `salary_batches.file_name` carries the `automated-payroll:<runId>` marker that
-- publishToPayslips writes, and `automated_payroll_runs.published_batch_id` carries the link from
-- the other side. Renaming a batch defeats the first; a deleted run row defeats the second; nothing
-- short of both defeats the pair.
--
-- Signature, language, volatility, SECURITY INVOKER and `search_path` are unchanged, and
-- `create or replace` preserves the existing EXECUTE grants (postgres, service_role). Every rule the
-- 2026-08-24 migrations established is carried forward untouched: the write is still additive, still
-- hr_id-scoped with no LEFT JOIN, still idempotent on the stamp, and still carries earlier periods
-- forward.

-- One definition of "Automated Payroll paid this month", used by both guards below.
create or replace function public.phx_period_paid_by_automated_payroll(
  p_year integer,
  p_month integer
)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.salary_batches b
    where b.year = p_year
      and b.month = p_month
      and (
        b.file_name like 'automated-payroll:%'
        or exists (
          select 1
          from public.automated_payroll_runs r
          where r.published_batch_id = b.id
        )
      )
  );
$$;

comment on function public.phx_period_paid_by_automated_payroll(integer, integer) is
  'True when the salary batch for this month was produced by the Automated Payroll wizard. Used by phx_import_approved_expenses_to_payroll to refuse a month whose outstation trips the wizard already settled but never stamped.';

create or replace function public.phx_import_approved_expenses_to_payroll(
  p_month integer,
  p_year integer
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_batch public.salary_batches%rowtype;
  v_imported_by text := coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), 'service_role');
  v_target_period integer := p_year * 12 + p_month;
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
  v_current_total numeric := 0;
  v_carried_total numeric := 0;
  v_carried_rows integer := 0;
  v_locked_expenses integer := 0;
  v_matched_employees text[] := '{}'::text[];
  v_stranded_rows integer := 0;
  v_stranded_total numeric := 0;
  v_stranded_employees integer := 0;
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
      'current_period_total', 0,
      'carried_forward_total', 0,
      'carried_forward_rows', 0,
      'locked_expenses', 0,
      'matched_employees', '[]'::jsonb,
      'stranded_rows', 0,
      'stranded_total', 0,
      'stranded_employees', 0,
      'target_batch_id', null,
      'target_batch_month', null,
      'target_batch_year', null
    );
  end if;

  -- GUARD 1. Automated Payroll already settled this month's outstation expenses inside the wizard,
  -- and it does not stamp the trips it consumed. Importing here would pay them a second time. This
  -- refuses rather than returning an empty result on purpose: a silent zero reads as "nothing was
  -- outstanding", which is the opposite of what is true.
  if public.phx_period_paid_by_automated_payroll(v_batch.year, v_batch.month) then
    raise exception 'Payroll batch %-% was produced by Automated Payroll, which pays outstation expenses inside the wizard. Importing them here would pay the same trips twice.', v_batch.year, v_batch.month
      using errcode = 'P0001';
  end if;

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import expenses while its status is %. Expenses import between Part 1 paid and review; a batch that is already approved or locked is closed.', v_batch.status using errcode = 'P0001';
  end if;

  with importable as (
    -- Every approved expense that has never been paid, from this period or any earlier one.
    select
      oe.id,
      oe.hr_id,
      -- Pay the HR-approved figure when HR adjusted the claim; otherwise the claim stands.
      -- approved_amount is NULL on every pre-existing row, so this is a no-op for them.
      coalesce(oe.approved_amount, oe.total) as amount,
      (oe.payout_year * 12 + oe.payout_month) as period_index
    from public.outstation_expenses oe
    where oe.hr_approved = true
      and oe.approved_at is not null
      and oe.approved_by is not null
      and oe.hr_id is not null
      and trim(oe.hr_id) <> ''
      and oe.payout_month is not null
      and oe.payout_year is not null
      -- IDEMPOTENCE, and the reason the additive write below is safe: a row already stamped as
      -- imported is excluded, so re-running adds nothing and no expense is ever paid twice.
      and oe.imported_to_payroll_at is null
      and oe.imported_payroll_batch_id is null
      -- CARRY FORWARD: at or before the target period, never after it.
      and (oe.payout_year * 12 + oe.payout_month) <= v_target_period
      -- GUARD 2, the carry-forward half. A trip whose own payout month was paid by Automated
      -- Payroll is settled, even though nothing stamped it. Without this, opening a legacy batch
      -- for any later month drags every wizard-paid trip in behind it, which is precisely the
      -- EGP 140,302 exposure this migration exists to close.
      and not public.phx_period_paid_by_automated_payroll(oe.payout_year, oe.payout_month)
  ),
  approved_totals as (
    select
      lower(hr_id) as normalized_hr_id,
      min(hr_id) as hr_id,
      sum(amount)::numeric(20,2) as approved_expense,
      coalesce(sum(amount) filter (where period_index = v_target_period), 0)::numeric(20,2) as current_expense,
      coalesce(sum(amount) filter (where period_index < v_target_period), 0)::numeric(20,2) as carried_expense,
      count(*) filter (where period_index < v_target_period)::integer as carried_rows
    from importable
    group by lower(hr_id)
  ),
  matched_totals as (
    -- INNER join, and the only thing that reaches the update below. An employee in this batch with
    -- no approved unimported claim produces no row here and is therefore never written to.
    select
      sr.id as salary_record_id,
      sr.hr_id,
      at.approved_expense,
      at.current_expense,
      at.carried_expense,
      at.carried_rows
    from public.salary_records sr
    join approved_totals at
      on lower(sr.hr_id) = at.normalized_hr_id
    where sr.batch_id = v_batch.id
  ),
  stranded as (
    -- Approved, unpaid, and its employee is not in this batch -- so it still cannot be paid here.
    -- Reported rather than silently skipped.
    select
      count(*)::integer as stranded_rows,
      coalesce(sum(i.amount), 0)::numeric(20,2) as stranded_total,
      count(distinct lower(i.hr_id))::integer as stranded_employees
    from importable i
    where not exists (
      select 1
      from public.salary_records sr
      where sr.batch_id = v_batch.id
        and lower(sr.hr_id) = lower(i.hr_id)
    )
  ),
  updated_rows as (
    update public.salary_records sr
    set expenses = coalesce(sr.expenses, 0) + mt.approved_expense,
        total_additions = coalesce(sr.total_additions, 0) + mt.approved_expense,
        second_part = coalesce(sr.second_part, 0) + mt.approved_expense,
        month_salary = coalesce(sr.month_salary, coalesce(sr.first_part, 0) + coalesce(sr.second_part, 0)) + mt.approved_expense
    from matched_totals mt
    where sr.id = mt.salary_record_id
      -- A claim HR adjusted down to zero still gets stamped below; it just has nothing to add.
      and mt.approved_expense <> 0
    returning sr.id
  ),
  marked_expenses as (
    -- Stamp exactly the rows that were summed. Selecting by id from `importable` rather than
    -- restating the predicate means the set paid and the set stamped cannot drift apart.
    update public.outstation_expenses pe
    set
      imported_payroll_batch_id = v_batch.id,
      imported_to_payroll_at = now(),
      imported_to_payroll_by = v_imported_by
    where pe.id in (
      select i.id
      from importable i
      join matched_totals mt
        on lower(mt.hr_id) = lower(i.hr_id)
    )
    returning pe.id
  )
  select
    count(*)::integer,
    coalesce(sum(approved_expense), 0)::numeric,
    coalesce(sum(current_expense), 0)::numeric,
    coalesce(sum(carried_expense), 0)::numeric,
    coalesce(sum(carried_rows), 0)::integer,
    (select count(*)::integer from marked_expenses),
    coalesce(array_agg(hr_id order by hr_id), '{}'::text[]),
    (select stranded_rows from stranded),
    (select stranded_total from stranded),
    (select stranded_employees from stranded)
  into
    v_imported_employees,
    v_imported_total,
    v_current_total,
    v_carried_total,
    v_carried_rows,
    v_locked_expenses,
    v_matched_employees,
    v_stranded_rows,
    v_stranded_total,
    v_stranded_employees
  from matched_totals;

  return jsonb_build_object(
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'current_period_total', v_current_total,
    'carried_forward_total', v_carried_total,
    'carried_forward_rows', v_carried_rows,
    'locked_expenses', v_locked_expenses,
    'matched_employees', to_jsonb(v_matched_employees),
    'stranded_rows', v_stranded_rows,
    'stranded_total', v_stranded_total,
    'stranded_employees', v_stranded_employees,
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;
