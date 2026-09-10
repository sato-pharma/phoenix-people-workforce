-- Automated Payroll — "this held salary was already transferred outside payroll" (owner rule
-- 2026-09-10).
--
-- THE GAP THIS FILLS, in the owner's own words: "some employees' salaries are held for the month
-- ... they are transferred during the month. So the next payroll they should not be added. But I
-- have nothing to say that this is already transferred outside the payroll."
--
-- Publishing drops every held row, so no salary_record is written and no payslip exists. The
-- person is then paid by hand, by bank transfer, some time during the month. Nothing anywhere
-- records that this happened — so a month later the only honest answer to "was this settled?" is
-- "the system cannot tell you", and the same held amount can be worked up and paid a second time.
-- Production carried 20 such people in August 2026 holding EGP 260,904 of already-paid first
-- instalment, 18 of them with a hold reason of a single dash.
--
-- WHAT A ROW HERE IS, AND IS NOT. It is an ATTESTATION by a human that money left the company
-- outside this system, on a date, for an amount, with a reference. It is NOT an observation, and
-- nothing in this codebase can verify it against a bank. That is exactly the same standing as
-- `public.mailbox_offboarding_tasks`, and it is recorded here in the same spirit: a claim with a
-- name and a timestamp on it beats no record at all, and it is the only thing that can stop the
-- next month paying the same money twice.
--
-- ONE ROW PER PERSON PER RUN. A settlement paid in two transfers updates the one row's amount and
-- says so in the note, rather than stacking partial rows that then have to be summed correctly by
-- every reader. The unique index is what makes the "record it again" path an update.
--
-- `amount` is what was ACTUALLY transferred, not what was owed. The two are deliberately separate:
-- the owed figure lives in the run's assembled rows and is reproduced on the exported Held tab
-- beside this one, so a short payment is visible as a difference rather than hidden by overwriting
-- the amount that was due.
--
-- RLS mirrors the rest of this module exactly (see 20260720100000_automated_payroll.sql):
-- service_role bypasses RLS; authenticated is gated by
-- public.current_access_can_manage_employees() (Super Admin only, enforced again in the service
-- layer); no anon grant.

create table if not exists public.automated_payroll_held_settlements (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null references public.automated_payroll_runs(id) on delete cascade,
  -- Stored in the employee's own casing AND in the compact lower-case key, the same pair every
  -- other table in this module carries. HR ids here are mixed case, so a raw match silently
  -- under-returns; the compact column is what every join uses.
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  -- What actually left the company, in EGP. Zero is allowed and meaningful: it records a
  -- deliberate decision that nothing was owed after all, which is different from no record.
  amount                  numeric(14, 2) not null default 0,
  paid_on                 date not null,
  -- Free text on purpose. The company pays these by bank transfer, Instapay and cash, and pinning
  -- an enum here would force the next real-world method to be recorded as a lie.
  method                  text,
  -- The bank/Instapay reference, so the claim can be checked against a statement later.
  reference               text,
  note                    text,
  recorded_by             text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint automated_payroll_held_settlements_amount_check check (amount >= 0)
);

create index if not exists automated_payroll_held_settlements_run_idx
  on public.automated_payroll_held_settlements (run_id);

-- The compact key is what the Held tab and the next month's Holds step join on.
create index if not exists automated_payroll_held_settlements_employee_idx
  on public.automated_payroll_held_settlements (employee_hr_id_compact);

-- One settlement per person per run — see the header. Recording again updates.
create unique index if not exists automated_payroll_held_settlements_run_employee_idx
  on public.automated_payroll_held_settlements (run_id, employee_hr_id_compact);

alter table public.automated_payroll_held_settlements enable row level security;

drop policy if exists automated_payroll_held_settlements_admin_select on public.automated_payroll_held_settlements;
drop policy if exists automated_payroll_held_settlements_admin_insert on public.automated_payroll_held_settlements;
drop policy if exists automated_payroll_held_settlements_admin_update on public.automated_payroll_held_settlements;
drop policy if exists automated_payroll_held_settlements_admin_delete on public.automated_payroll_held_settlements;

create policy automated_payroll_held_settlements_admin_select on public.automated_payroll_held_settlements
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_held_settlements_admin_insert on public.automated_payroll_held_settlements
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_settlements_admin_update on public.automated_payroll_held_settlements
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_settlements_admin_delete on public.automated_payroll_held_settlements
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_held_settlements from anon;
revoke all on table public.automated_payroll_held_settlements from public;
grant select, insert, update, delete on table public.automated_payroll_held_settlements to authenticated;
grant all on table public.automated_payroll_held_settlements to service_role;

comment on table public.automated_payroll_held_settlements is
  'Attestation that a HELD payroll row was transferred outside the payroll system. Publishing drops held rows and writes no salary_record, so without this there is no record that the money was ever paid and the next month can pay it again. A row is a human claim, not an observation — nothing here is verified against a bank.';
comment on column public.automated_payroll_held_settlements.amount is
  'What was actually transferred. Deliberately separate from what was owed (which lives in the run''s assembled rows) so a short payment shows as a difference instead of overwriting the amount due.';
