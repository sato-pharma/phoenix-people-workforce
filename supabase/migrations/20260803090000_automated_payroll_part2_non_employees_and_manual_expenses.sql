-- Automated Payroll — Part 2 Non-Employees Payroll + manually added outstation expenses.
-- Owner request 2026-08-03, two independent additions to the same module:
--
-- 1. automated_payroll_non_employees.part
--    Non-Employees Payroll (people paid a monthly salary with no employee/HR_ID
--    record) shipped as a Part-1-only list: the whole amount always paid with the
--    first installment. Some of these people are paid with the SECOND installment
--    instead, and there was no way to record that. `part` says which installment
--    an entry belongs to; every existing row keeps today's meaning ('first') via
--    the default, so nothing about an in-flight run changes.
--
--    The column drives three things, all of which read it and none of which
--    guess: which run phase the entry may still be edited in ('first' locks when
--    Part 1 does, 'second' when Part 2 does), which internal sheet lists it
--    (Part 1 sheet -> first only; Full sheet -> both, since a month's whole
--    payout is a month's whole payout), and which BANK FILE carries it (the FAB
--    and CIB part-2 files previously returned nothing at all for non-employees).
--
-- 2. automated_payroll_draft_rows.expenses_note
--    The Outstation expenses step now lets HR add an employee the payout-tagged
--    expense feeder never produced a trip for and type an amount by hand. That is
--    real money with no source document behind it, so it needs the same "why"
--    column every other manual money tab in this wizard already has (p1od_*_reason,
--    manual_reason). Optional, free text, display + xlsx only — it never affects
--    an amount.
--
-- Add-only and idempotent: no existing column is altered, no data is rewritten,
-- and both statements are `if not exists`. Nothing here needs a backfill.

alter table public.automated_payroll_non_employees
  add column if not exists part text not null default 'first';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.automated_payroll_non_employees'::regclass
      and conname = 'automated_payroll_non_employees_part_check'
  ) then
    alter table public.automated_payroll_non_employees
      add constraint automated_payroll_non_employees_part_check
      check (part in ('first', 'second'));
  end if;
end
$$;

comment on column public.automated_payroll_non_employees.part is
  'Which installment this non-employee is paid with: first (Part 1) or second (Part 2). Default first — the module''s original Part-1-only behaviour.';

-- The list is always read per run, and now usually per part within that run.
create index if not exists automated_payroll_non_employees_run_part_idx
  on public.automated_payroll_non_employees (run_id, part);

alter table public.automated_payroll_draft_rows
  add column if not exists expenses_note text;

comment on column public.automated_payroll_draft_rows.expenses_note is
  'Optional HR note explaining an outstation expense figure — required in practice for a manually added employee, whose amount has no trip behind it. Display/xlsx only; never affects money.';
