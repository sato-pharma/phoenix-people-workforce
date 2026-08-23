-- Outstation -> payroll import: CARRY FORWARD approved expenses from earlier months that were never
-- paid. Owner decision, 2026-08-24.
--
-- Supersedes 20260824014500_outstation_import_additive.sql, which made the write additive and
-- hr_id-scoped. That migration is already on main, so it is left untouched here rather than edited:
-- a merged migration that changes after the fact drifts from whatever has already applied it.
--
-- THE PROBLEM. That version still filtered on the EXACT payout period. An approved expense whose own
-- month had closed could therefore never be paid from anywhere -- a closed batch is not reopened, and
-- no later batch would look at it. Production held roughly EGP 34,299 of approved, never-imported
-- expenses across 2026-02..2026-07 with no route to anyone's salary. (The headline figure of
-- EGP 141,221 unimported is larger, but most of it never passed HR approval: the payroll-grade
-- predicate matched 0 rows in February and March, 1 in April, 3 in May, 5 in June, and 70 of July's
-- 79.)
--
-- THE CHANGE. `importable` now takes every approved, never-yet-imported expense whose payout period
-- is at or BEFORE the target batch. A future-dated claim is still excluded.
--
-- WHY THIS IS SAFE TO RE-RUN, AND WHY IT CANNOT DOUBLE-PAY. `importable` also excludes anything
-- already stamped with `imported_to_payroll_at` / `imported_payroll_batch_id`. An expense is
-- therefore payable exactly once no matter how often this runs or which batch reaches it first. If
-- an earlier month's batch is still open, running that one first pays its expenses there and the
-- stamp settles it. That is exactly what "the next open batch" means.
--
-- STRANDED MONEY IS REPORTED, NOT SWALLOWED. An expense can only be paid into a batch that contains
-- its employee, so a leaver who appears in no later batch still cannot be paid -- carrying forward
-- does not change that. Rather than let it disappear quietly a second time, the return value names
-- how many rows, how much money, and how many people are in that state.
--
-- THE RETURN VALUE NOW SPLITS THE TOTAL. `current_period_total` and `carried_forward_total` are
-- reported separately because folding them together is how an expense approved in April silently
-- reads as July spend to whoever is reconciling payroll.
--
-- `marked_expenses` stamps by id from `importable` instead of restating the predicate, so the set
-- that was paid and the set that was stamped cannot drift apart.
--
-- REHEARSED ON STAGING across four periods before this was written. An employee holding EGP 1,000
-- from the payroll sheet, EGP 300 approved for the target month and EGP 200 from the month before
-- ended on EGP 1,500; a claim dated after the target stayed unpaid; a claim belonging to an employee
-- absent from the batch stayed unpaid and was reported as stranded; a second run changed nothing.
-- No real staging row was stamped or written.
--
-- THE BATCH-STATUS GATE IS STILL UNCHANGED, so this does not itself release the money. Every
-- production batch is `approved` or `locked`, both past the import window. Opening that gate would
-- rewrite already-approved and locked payroll and remains a separate owner decision.
--
-- Signature, language, volatility, SECURITY INVOKER and `search_path` are unchanged, and
-- `create or replace` preserves the existing EXECUTE grants (postgres, service_role).

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
