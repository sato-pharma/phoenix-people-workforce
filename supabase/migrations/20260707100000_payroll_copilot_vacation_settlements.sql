-- Payroll Copilot — Unpaid Vacation settlement decisions.
--
-- Records the CEO's per-employee decision, made from the Payroll Copilot's
-- Unpaid Vacation tab, on how an unpaid-leave request's cost is settled this
-- payroll cycle: deducted from salary (the default), consumed from the
-- employee's vacation balance instead, or rejected (no action this period).
--
-- Deliberately a NEW table rather than new columns on v2_vacation_requests:
-- that table is the leave-taking record itself, decided by the employee's
-- manager/HR at approval time; this is a separate, later decision by a
-- different actor (CEO/Super Admin, at payroll close) about how to SETTLE an
-- already-approved unpaid request's cost. Keeping them separate avoids
-- conflating two different actors/times on the same row and keeps this
-- reversible (superseded_at, never hard-deleted) the same way
-- deduction_candidates already is.
--
-- Balance integration: src/lib/vacation/service.ts's approvedPaidDaysInPeriod
-- (the function that computes an employee's already-used paid days for any
-- future balance check) is extended to ALSO sum unpaid_days from any live
-- (non-superseded) 'balance' settlement here whose start_date falls in the
-- same balance period — so a later leave request correctly sees the reduced
-- balance. See that function for the exact query.
--
-- RLS mirrors the existing payroll_copilot_* tables.

create table if not exists public.payroll_copilot_vacation_settlements (
  id uuid primary key default gen_random_uuid(),
  run_id uuid null references public.payroll_copilot_runs (id) on delete set null,
  employee_hr_id text not null,
  employee_hr_id_compact text not null,
  -- The underlying v2_vacation_requests row(s) this settlement covers (traceable audit; not a hard FK since a request may be superseded/edited independently).
  vacation_request_ids jsonb not null default '[]'::jsonb,
  -- The unpaid request's own start date — used to match the same balance-period
  -- window approvedPaidDaysInPeriod filters by, regardless of anniversary boundaries.
  start_date date not null,
  unpaid_days numeric(8, 2) not null check (unpaid_days > 0),
  settlement_method text not null check (settlement_method in ('salary', 'balance')),
  salary_deduction_amount numeric(14, 2) null,
  balance_days_consumed numeric(8, 2) null,
  decided_by text not null,
  decided_at timestamptz not null default now(),
  superseded_at timestamptz null,
  superseded_by_settlement_id uuid null references public.payroll_copilot_vacation_settlements (id) on delete set null,
  email_sent_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint payroll_copilot_vacation_settlements_method_values_check check (
    (settlement_method = 'salary' and salary_deduction_amount is not null and balance_days_consumed is null)
    or
    (settlement_method = 'balance' and balance_days_consumed is not null and salary_deduction_amount is null)
  )
);

-- One live settlement per employee per underlying unpaid request start date.
create unique index if not exists payroll_copilot_vacation_settlements_live_idx
  on public.payroll_copilot_vacation_settlements (employee_hr_id_compact, start_date)
  where superseded_at is null;

create index if not exists payroll_copilot_vacation_settlements_run_idx
  on public.payroll_copilot_vacation_settlements (run_id);
create index if not exists payroll_copilot_vacation_settlements_employee_idx
  on public.payroll_copilot_vacation_settlements (employee_hr_id_compact);
create index if not exists payroll_copilot_vacation_settlements_balance_lookup_idx
  on public.payroll_copilot_vacation_settlements (employee_hr_id_compact, start_date, settlement_method)
  where superseded_at is null;

alter table public.payroll_copilot_vacation_settlements enable row level security;

drop policy if exists payroll_copilot_vacation_settlements_admin_select
  on public.payroll_copilot_vacation_settlements;
create policy payroll_copilot_vacation_settlements_admin_select
  on public.payroll_copilot_vacation_settlements
  for select
  to authenticated
  using (public.current_access_can_manage_employees());

drop policy if exists payroll_copilot_vacation_settlements_admin_insert
  on public.payroll_copilot_vacation_settlements;
create policy payroll_copilot_vacation_settlements_admin_insert
  on public.payroll_copilot_vacation_settlements
  for insert
  to authenticated
  with check (public.current_access_can_manage_employees());

drop policy if exists payroll_copilot_vacation_settlements_admin_update
  on public.payroll_copilot_vacation_settlements;
create policy payroll_copilot_vacation_settlements_admin_update
  on public.payroll_copilot_vacation_settlements
  for update
  to authenticated
  using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());

drop policy if exists payroll_copilot_vacation_settlements_admin_delete
  on public.payroll_copilot_vacation_settlements;
create policy payroll_copilot_vacation_settlements_admin_delete
  on public.payroll_copilot_vacation_settlements
  for delete
  to authenticated
  using (public.current_access_can_manage_employees());

comment on table public.payroll_copilot_vacation_settlements is
  'Payroll Copilot: CEO decision to settle an unpaid-leave request''s cost against salary or vacation balance. Reversible via superseded_at; never mutates v2_vacation_requests.';
