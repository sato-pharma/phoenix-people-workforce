-- Outstation expenses: give the HR-approved payable figure its own column.
--
-- Why: the Expense Approvals page lets HR edit an "approved amount" and demands a reason when it
-- differs from the claim, but that figure was never stored. The write path persisted `total`
-- unchanged, so payroll paid the FULL claim and the edit silently vanished on reload. Reducing a
-- 2,000 EGP claim to 500 still paid 2,000, with no error anywhere.
--
-- `approved_amount` holds what HR approved; `total` keeps holding what the employee claimed. The
-- claim must survive a reduction — overwriting `total` would destroy the evidence a dispute needs.
--
-- NULL means "HR did not adjust the claim", so `total` is payable. Every historical row is left
-- NULL and therefore keeps paying exactly what it pays today. This migration changes no money.

alter table public.outstation_expenses
  add column if not exists approved_amount numeric;

comment on column public.outstation_expenses.approved_amount is
  'HR-approved payable amount in EGP. NULL = HR did not adjust the claim, so `total` is payable. '
  'Never overwrite `total` with this value — the original claim must survive a reduction.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.outstation_expenses'::regclass
      and conname = 'outstation_expenses_approved_amount_non_negative'
  ) then
    alter table public.outstation_expenses
      add constraint outstation_expenses_approved_amount_non_negative
      check (approved_amount is null or approved_amount >= 0);
  end if;
end
$$;

-- The payroll importer is the function that actually writes salary_records.expenses, so the new
-- column is cosmetic until this reads it. Body reproduced verbatim from the live production
-- definition (pg_get_functiondef, verified 2026-08-01); the ONLY change is the approved_expense
-- sum below. CREATE OR REPLACE preserves the existing privileges, so no GRANT changes are needed.
CREATE OR REPLACE FUNCTION public.phx_import_approved_expenses_to_payroll(p_month integer, p_year integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Payroll batch cannot import expenses before Part 1 is paid or while status is %.', v_batch.status using errcode = 'P0001';
  end if;

  with approved_totals as (
    select
      lower(hr_id) as normalized_hr_id,
      min(hr_id) as hr_id,
      -- CHANGED: pay the HR-approved figure when HR adjusted the claim; otherwise the claim
      -- stands. approved_amount is NULL on every pre-existing row, so this is a no-op for them.
      sum(coalesce(outstation_expenses.approved_amount, outstation_expenses.total))::numeric(20,2) as approved_expense
    from public.outstation_expenses
    where hr_approved = true
      and approved_at is not null
      and approved_by is not null
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
$function$;
