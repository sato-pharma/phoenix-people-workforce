-- Outstation -> payroll import: make the expense write ADDITIVE and hr_id-SCOPED.
--
-- WHAT WAS WRONG. The previous body drove its salary update off a LEFT JOIN across *every* salary
-- record in the batch and then did `set expenses = coalesce(at.approved_expense, 0)`. Two
-- consequences, both silent:
--
--   1. Every employee in the batch with no approved outstation claim had `expenses` set to ZERO,
--      and `total_additions`, `second_part` and `month_salary` reduced by whatever had been there.
--   2. Even a matched employee had their existing figure REPLACED rather than added to.
--
-- That matters because `salary_records.expenses` is not an outstation column. It is populated by the
-- monthly payroll upload: src/lib/payroll/salary-import.ts maps the uploaded sheet column
-- "Expenses" / "Expenses Prev Month" / "Expenses (Prev Month)" straight into it. Verified on
-- production 2026-08-23 -- 211 of 796 salary records hold EGP 258,748.50 of such sheet-sourced
-- expenses, and January 2026 carries EGP 21,000 of them in a month where no outstation row exists
-- at all, which is what proves the two sources are independent.
--
-- Simulated against the live July 2026 batch before this change: running the import would have
-- changed 10 of 105 records, wiping EGP 19,354 from 9 employees to add EGP 505 to 1 -- a net
-- -EGP 18,849 off that month's salaries. No import has ever actually run (0 of 361 outstation rows
-- carry an import stamp), so nothing in production has been damaged. The batch-status gate is what
-- has been preventing it, by accident rather than by design.
--
-- WHAT CHANGES HERE.
--   * `approved_totals` sums only rows that have NEVER been imported. Re-running is therefore a
--     no-op instead of paying the same expense twice -- which is what makes "additive" safe.
--   * The salary update joins `matched_totals` directly. There is NO LEFT JOIN left anywhere in
--     this function, so a record with no approved claim is never touched at all.
--   * `expenses`, `total_additions`, `second_part` and `month_salary` are INCREMENTED by the
--     approved amount instead of being overwritten.
--   * `marked_expenses` stamps only the rows that were actually summed into this run.
--
-- WHAT DELIBERATELY DOES NOT CHANGE. The batch-status gate. Production batches are only ever
-- `approved` (2) or `locked` (5) -- both *past* the import window, not before it -- so this
-- function still cannot write to any batch that exists today. Opening that gate would rewrite
-- payroll that has already been approved and locked; that is a business decision for the owner, not
-- something a bug fix should smuggle in. The message is reworded only because "before Part 1 is
-- paid" describes the wrong end of the lifecycle for a closed batch. It keeps the substring
-- "cannot import expenses" verbatim, because src/lib/outstation/expenses.ts matches on exactly that
-- text to raise PayrollConflictError instead of a 500.
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
  v_imported_employees integer := 0;
  v_imported_total numeric := 0;
  v_locked_expenses integer := 0;
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
      'locked_expenses', 0,
      'matched_employees', '[]'::jsonb,
      'target_batch_id', null,
      'target_batch_month', null,
      'target_batch_year', null
    );
  end if;

  if v_batch.status not in ('part1_paid', 'adjustments_open', 'part2_ready', 'under_review', 'rejected') then
    raise exception 'Payroll batch cannot import expenses while its status is %. Expenses import between Part 1 paid and review; a batch that is already approved or locked is closed.', v_batch.status using errcode = 'P0001';
  end if;

  with approved_totals as (
    select
      lower(hr_id) as normalized_hr_id,
      min(hr_id) as hr_id,
      -- Pay the HR-approved figure when HR adjusted the claim; otherwise the claim stands.
      -- approved_amount is NULL on every pre-existing row, so this is a no-op for them.
      sum(coalesce(outstation_expenses.approved_amount, outstation_expenses.total))::numeric(20,2) as approved_expense
    from public.outstation_expenses
    where hr_approved = true
      and approved_at is not null
      and approved_by is not null
      and payout_month = p_month
      and payout_year = p_year
      and hr_id is not null
      and trim(hr_id) <> ''
      -- IDEMPOTENCE, and the reason the additive write below is safe: a row already stamped as
      -- imported is excluded, so a second run of this function adds nothing at all.
      and imported_to_payroll_at is null
      and imported_payroll_batch_id is null
    group by lower(hr_id)
  ),
  matched_totals as (
    -- INNER join, and the only thing that reaches the update below. An employee in this batch with
    -- no approved unimported claim produces no row here and is therefore never written to.
    select
      sr.id as salary_record_id,
      sr.hr_id,
      at.approved_expense
    from public.salary_records sr
    join approved_totals at
      on lower(sr.hr_id) = at.normalized_hr_id
    where sr.batch_id = v_batch.id
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
    update public.outstation_expenses pe
    set
      imported_payroll_batch_id = v_batch.id,
      imported_to_payroll_at = now(),
      imported_to_payroll_by = v_imported_by
    where pe.hr_approved = true
      and pe.approved_at is not null
      and pe.approved_by is not null
      and pe.payout_month = p_month
      and pe.payout_year = p_year
      and pe.hr_id is not null
      and trim(pe.hr_id) <> ''
      -- Stamp exactly the rows `approved_totals` summed -- never re-stamp an earlier import, which
      -- would overwrite its timestamp and batch id and lose that lineage.
      and pe.imported_to_payroll_at is null
      and pe.imported_payroll_batch_id is null
      and exists (
        select 1
        from matched_totals mt
        where lower(mt.hr_id) = lower(pe.hr_id)
      )
    returning pe.id
  )
  select
    count(*)::integer,
    coalesce(sum(approved_expense), 0)::numeric,
    (select count(*)::integer from marked_expenses),
    coalesce(array_agg(hr_id order by hr_id), '{}'::text[])
  into
    v_imported_employees,
    v_imported_total,
    v_locked_expenses,
    v_matched_employees
  from matched_totals;

  return jsonb_build_object(
    'imported_employees', v_imported_employees,
    'imported_total', v_imported_total,
    'locked_expenses', v_locked_expenses,
    'matched_employees', to_jsonb(v_matched_employees),
    'target_batch_id', v_batch.id,
    'target_batch_month', v_batch.month,
    'target_batch_year', v_batch.year
  );
end;
$$;
