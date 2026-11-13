-- automated_payroll_carry_late_expenses_setting — the payroll switch for trips approved after their month
-- was paid, and the one-run-per-trip reservation that stops two runs paying the same carried trip.
--
-- WHAT THIS CHANGES:
--   1. adds public.automated_payroll_settings, a single-row table (id = 1, enforced by `check (id = 1)`)
--      holding one switch, carry_late_expenses, and who last moved it. The row is seeded OFF.
--   2. adds public.automated_payroll_carried_expenses: one row per carried outstation trip, keyed by the
--      trip's row id, naming the payroll run whose Part 2 confirm recorded it. The primary key is the
--      guard: a second run's confirm cannot reserve the same trip. Rows are released (deleted) when that
--      run's Part 1 or Part 2 is reopened or it is cancelled; a published run's rows stay.
--   Nothing existing changes.
-- WHY: REC-029 / F-PAY-012. The Expenses step reads outstation trips by the trip's OWN payout month, so a
--   trip approved after that month's run was published is never read again and pays nobody, silently.
--   The owner's decision: "Switch, starts OFF". While OFF those trips are only LISTED on the Expenses
--   step ("Approved, not yet in a run"); when ON they are added to the next open run's Expenses step.
--   Starting OFF means applying this migration moves no money.
-- ACCESS: written and read only by the server (service role). RLS is enabled with NO policy on both
--   tables, and anon and authenticated hold no privilege, so the browser key can neither read nor write.
-- ROLLBACK: drop table if exists public.automated_payroll_carried_expenses;
--           drop table if exists public.automated_payroll_settings;
--   (and ship the matching code revert — the app reads the switch on the Expenses step, at Part 2 confirm
--   and at publish, and a missing table refuses those reads rather than reading OFF.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is neither destructive nor bulk: two new tables and one seeded row.

begin;

create table if not exists public.automated_payroll_settings (
  id                   smallint primary key check (id = 1),
  -- OFF: a late-approved trip is listed only. ON: it is added to the next open run's Expenses step.
  carry_late_expenses  boolean not null default false,
  updated_at           timestamptz not null default now(),
  updated_by_hr_id     text
);

insert into public.automated_payroll_settings (id, carry_late_expenses)
values (1, false)
on conflict (id) do nothing;

alter table public.automated_payroll_settings enable row level security;

revoke all on table public.automated_payroll_settings from public;
revoke all on table public.automated_payroll_settings from anon;
revoke all on table public.automated_payroll_settings from authenticated;
grant select, insert, update on table public.automated_payroll_settings to service_role;

comment on table public.automated_payroll_settings is
  'Automated Payroll switches, one row (id = 1). carry_late_expenses: whether outstation trips approved after their payout month was published are added to the next open run''s Expenses step (true) or only listed (false, the default). Server-only.';
comment on column public.automated_payroll_settings.carry_late_expenses is
  'OFF lists late-approved trips only; ON adds them to the next open run''s Expenses step. Changed only while no run is in Part 2 or ready.';

create table if not exists public.automated_payroll_carried_expenses (
  -- The outstation_expenses row id of the carried trip. One run per trip, ever at a time.
  expense_id   uuid primary key,
  run_id       uuid not null references public.automated_payroll_runs(id) on delete cascade,
  reserved_at  timestamptz not null default now()
);

create index if not exists automated_payroll_carried_expenses_run_id_idx
  on public.automated_payroll_carried_expenses (run_id);

alter table public.automated_payroll_carried_expenses enable row level security;

revoke all on table public.automated_payroll_carried_expenses from public;
revoke all on table public.automated_payroll_carried_expenses from anon;
revoke all on table public.automated_payroll_carried_expenses from authenticated;
grant select, insert, delete on table public.automated_payroll_carried_expenses to service_role;

comment on table public.automated_payroll_carried_expenses is
  'Late-approved outstation trips a payroll run''s Part 2 confirm recorded as carried, one row per trip (expense_id is the primary key, so two runs can never record the same trip). Released when that run reopens Part 1 or Part 2 or is cancelled; kept once it is published. Server-only.';

commit;
