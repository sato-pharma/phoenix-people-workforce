-- Automated Payroll — recurring (standing) Non-Employees Payroll roster.
-- Owner request 2026-08-30: "add them to be fixed every month without me adding
-- them manual".
--
-- Background. Non-Employees Payroll (20260725150000) is a free-form list keyed to
-- ONE run: HR re-typed the same people, the same amounts and the same bank
-- details every month, by hand. The July 2026 run carried seven entries totalling
-- EGP 381,535.00 that were all added in two clicks-worth of typing on 2026-07-26
-- and 2026-08-04 — and the August run, open since 2026-08-01, had none of them.
-- Re-keying real money by hand every month is exactly how an amount goes in wrong
-- or a person is missed entirely, and nothing in the module would notice either.
--
-- This adds the standing roster those per-run entries are copied FROM. Two
-- tables, deliberately:
--
--   automated_payroll_non_employee_recurring  — the register. Edited once; it is
--     not scoped to any run and no payroll figure is ever read from it directly.
--   automated_payroll_non_employees           — unchanged in meaning. Still the
--     per-run list that every sheet, total and bank file reads.
--
-- A run's rows are COPIES, not references, and that is the point: changing an
-- amount on the register must never retroactively alter a month that has already
-- been executed. `recurring_id` records where a copy came from so the UI can say
-- so and so a re-sync can tell "already seeded" from "HR deleted this on
-- purpose" — it is provenance, never a lookup path for money.
--
-- RLS mirrors the rest of this module exactly (see 20260720100000_automated_payroll.sql):
-- service_role bypasses RLS; authenticated is gated by
-- public.current_access_can_manage_employees() (Super Admin only, enforced again
-- in the service layer); no anon grant.

create table if not exists public.automated_payroll_non_employee_recurring (
  id              uuid primary key default gen_random_uuid(),
  full_name_ar    text not null,
  full_name_en    text not null,
  total_salary    numeric(14, 2) not null default 0,
  bank_name       text,
  bank_account    text,
  part            text not null default 'first',
  active          boolean not null default true,
  note            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint automated_payroll_non_employee_recurring_total_salary_check
    check (total_salary >= 0),
  constraint automated_payroll_non_employee_recurring_part_check
    check (part in ('first', 'second'))
);

comment on table public.automated_payroll_non_employee_recurring is
  'Standing roster of people paid a fixed monthly salary with no employee/HR_ID record. Copied into each new run''s automated_payroll_non_employees list at run start. Never read directly by any sheet, total or bank file.';
comment on column public.automated_payroll_non_employee_recurring.active is
  'Inactive entries stay for history but are not copied into new runs. Deactivate rather than delete — a deleted register row cannot explain a past month''s sheet.';
comment on column public.automated_payroll_non_employee_recurring.part is
  'Which installment this person is normally paid with: first (Part 1) or second (Part 2). Copied onto the run entry, where it stays independently editable.';

-- One register row per person per installment. Someone paid in BOTH installments
-- (as the July run's largest entry was — 158,487.00 with Part 1 and a further
-- 90,000.00 with Part 2) is two rows, which is correct: they are two different
-- payments on two different dates, and the amounts differ.
create unique index if not exists automated_payroll_non_employee_recurring_person_idx
  on public.automated_payroll_non_employee_recurring (lower(btrim(full_name_en)), part);

create index if not exists automated_payroll_non_employee_recurring_active_idx
  on public.automated_payroll_non_employee_recurring (active, part);

alter table public.automated_payroll_non_employee_recurring enable row level security;

drop policy if exists automated_payroll_non_employee_recurring_admin_select on public.automated_payroll_non_employee_recurring;
drop policy if exists automated_payroll_non_employee_recurring_admin_insert on public.automated_payroll_non_employee_recurring;
drop policy if exists automated_payroll_non_employee_recurring_admin_update on public.automated_payroll_non_employee_recurring;
drop policy if exists automated_payroll_non_employee_recurring_admin_delete on public.automated_payroll_non_employee_recurring;

create policy automated_payroll_non_employee_recurring_admin_select on public.automated_payroll_non_employee_recurring
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_non_employee_recurring_admin_insert on public.automated_payroll_non_employee_recurring
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_non_employee_recurring_admin_update on public.automated_payroll_non_employee_recurring
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_non_employee_recurring_admin_delete on public.automated_payroll_non_employee_recurring
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_non_employee_recurring from anon;
revoke all on table public.automated_payroll_non_employee_recurring from public;
grant select, insert, update, delete on table public.automated_payroll_non_employee_recurring to authenticated;
grant all on table public.automated_payroll_non_employee_recurring to service_role;

-- Provenance on the per-run list. `on delete set null`: retiring someone from the
-- register must never delete or alter the row on a month that already paid them.
alter table public.automated_payroll_non_employees
  add column if not exists recurring_id uuid
  references public.automated_payroll_non_employee_recurring(id) on delete set null;

comment on column public.automated_payroll_non_employees.recurring_id is
  'The standing-roster entry this row was copied from, or null when HR added it by hand for this month only. Provenance only — the amount paid is always this row''s own total_salary.';

-- Makes the seed idempotent: re-syncing a run inserts only what is not already
-- there, so a row HR deliberately deleted does not silently reappear... it does
-- not come back on its own, but an explicit re-sync WILL restore it, which is the
-- documented behaviour of that button.
create unique index if not exists automated_payroll_non_employees_run_recurring_idx
  on public.automated_payroll_non_employees (run_id, recurring_id)
  where recurring_id is not null;
