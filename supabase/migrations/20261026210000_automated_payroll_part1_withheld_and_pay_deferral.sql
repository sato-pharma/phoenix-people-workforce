-- Part 1 withheld, Defer Pay, and the "Part 1 not paid" correction (owner, 2026-10-26).
--
-- 1. draft_rows.part1_withheld — frozen at Part 1 confirm: was this person ON HOLD when Part 1 was
--    confirmed? The Part 1 bank files leave a held person out, so their first instalment was never
--    paid; until now publish recorded every held person's Part 1 as "already paid", and someone held
--    at Part 1 but released at Part 2 lost their Part 1 for good. NULL = Part 1 not confirmed yet, or a
--    run confirmed before this column (readers then fall back to the live hold, as before).
--
-- 2. draft_rows.pay_deferral_value / pay_deferral_month — the Defer Pay step: an amount taken off this
--    month's Part 2 and owed again next month or the month after ('next' | 'after_next'). Publish
--    records it, and the Held Salary Release step offers it once it is due.
--
-- 3. automated_payroll_held_part1_unpaid — HR's record that an EARLIER published month's Part 1 was
--    not paid (the runs published before (1) existed recorded it as paid). One row per (held run,
--    person), never above that person's frozen Part 1 on that run. It adds to what is still held.
--
-- RLS mirrors 20261026190000_automated_payroll_held_release_ledger.sql exactly.
-- Additive. Rollback: drop table if exists public.automated_payroll_held_part1_unpaid;
--   alter table public.automated_payroll_draft_rows drop column if exists part1_withheld,
--     drop column if exists pay_deferral_value, drop column if exists pay_deferral_month;

alter table public.automated_payroll_draft_rows
  add column if not exists part1_withheld boolean,
  add column if not exists pay_deferral_value numeric(14, 2),
  add column if not exists pay_deferral_month text;

alter table public.automated_payroll_draft_rows
  drop constraint if exists automated_payroll_draft_rows_pay_deferral_check;
alter table public.automated_payroll_draft_rows
  add constraint automated_payroll_draft_rows_pay_deferral_check check (
    (pay_deferral_value is null or pay_deferral_value >= 0)
    and (pay_deferral_month is null or pay_deferral_month in ('next', 'after_next'))
  );

create table if not exists public.automated_payroll_held_part1_unpaid (
  id                      uuid primary key default gen_random_uuid(),
  -- The earlier published run whose Part 1 was not paid.
  held_run_id             uuid not null references public.automated_payroll_runs(id) on delete cascade,
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  employee_name           text,
  amount                  numeric(14, 2) not null,
  -- The run on whose Held Salary Release step it was recorded.
  recorded_in_run_id      uuid references public.automated_payroll_runs(id) on delete set null,
  recorded_by             text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint automated_payroll_held_part1_unpaid_amount_check check (amount >= 0)
);

create unique index if not exists automated_payroll_held_part1_unpaid_run_employee_idx
  on public.automated_payroll_held_part1_unpaid (held_run_id, employee_hr_id_compact);

alter table public.automated_payroll_held_part1_unpaid enable row level security;

drop policy if exists automated_payroll_held_part1_unpaid_admin_select on public.automated_payroll_held_part1_unpaid;
drop policy if exists automated_payroll_held_part1_unpaid_admin_insert on public.automated_payroll_held_part1_unpaid;
drop policy if exists automated_payroll_held_part1_unpaid_admin_update on public.automated_payroll_held_part1_unpaid;
drop policy if exists automated_payroll_held_part1_unpaid_admin_delete on public.automated_payroll_held_part1_unpaid;

create policy automated_payroll_held_part1_unpaid_admin_select on public.automated_payroll_held_part1_unpaid
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_held_part1_unpaid_admin_insert on public.automated_payroll_held_part1_unpaid
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_part1_unpaid_admin_update on public.automated_payroll_held_part1_unpaid
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_held_part1_unpaid_admin_delete on public.automated_payroll_held_part1_unpaid
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_held_part1_unpaid from anon;
revoke all on table public.automated_payroll_held_part1_unpaid from public;
grant select, insert, update, delete on table public.automated_payroll_held_part1_unpaid to authenticated;
grant all on table public.automated_payroll_held_part1_unpaid to service_role;

comment on table public.automated_payroll_held_part1_unpaid is
  'HR record that an earlier published run''s Part 1 was not paid to this person (held at Part 1). Adds to the outstanding held balance; never above the frozen Part 1 of that run.';
comment on column public.automated_payroll_draft_rows.part1_withheld is
  'Frozen at Part 1 confirm: on hold at that moment, so the Part 1 bank files did not pay the first instalment. NULL before Part 1 confirm or on runs confirmed before this column.';
comment on column public.automated_payroll_draft_rows.pay_deferral_value is
  'Defer Pay step -> amount taken off this month''s Part 2 and owed again later. Never above the row''s Part 2; zero effect on a held row.';
comment on column public.automated_payroll_draft_rows.pay_deferral_month is
  'Defer Pay step -> when the deferred amount falls due: next (the month after this run) or after_next (two months after).';
