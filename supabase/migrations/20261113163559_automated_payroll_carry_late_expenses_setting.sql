-- automated_payroll_carry_late_expenses_setting — the payroll switch for trips approved after their month was paid.
--
-- WHAT THIS CHANGES: adds public.automated_payroll_settings, a single-row table (id = 1, enforced by
--   `check (id = 1)`) holding one switch, carry_late_expenses, and who last moved it. The row is seeded
--   OFF. Nothing existing changes.
-- WHY: REC-029 / F-PAY-012. The Expenses step reads outstation trips by the trip's OWN payout month, so a
--   trip approved after that month's run was published is never read again and pays nobody, silently.
--   The owner's decision: "Switch, starts OFF". While OFF those trips are only LISTED on the Expenses
--   step ("Approved, not yet in a run"); when ON they are added to the next open run's Expenses step.
--   Starting OFF means applying this migration moves no money.
-- ACCESS: written and read only by the server (service role). RLS is enabled with NO policy, and anon and
--   authenticated hold no privilege, so the browser key can neither read nor flip the switch.
-- ROLLBACK: drop table if exists public.automated_payroll_settings;
--   (and ship the matching code revert — the app reads the switch on the Expenses step, at Part 2 confirm
--   and at publish, and a missing table refuses those reads rather than reading OFF.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is neither destructive nor bulk: one new table and one seeded row.

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

commit;
