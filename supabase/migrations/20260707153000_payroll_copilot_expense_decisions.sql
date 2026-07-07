-- Payroll Copilot — Expenses tab settlement decisions.
--
-- Records the CEO's per-request decision, made from the Payroll Copilot's
-- Expenses tab, on whether an HR-approved outstation expense request is
-- included in this payroll run or deferred to next month. Mirrors
-- payroll_copilot_vacation_settlements exactly: a NEW table (never mutates
-- outstation_expense_requests itself), reversible via superseded_at, one
-- live decision per underlying request.
--
-- request_trip_start_date is denormalized from the source request so
-- buildIncludedExpenseTotals() (src/lib/payroll/copilot/expense-review.ts)
-- can filter decisions to a payroll period without joining back to
-- outstation_expense_requests on every read.
--
-- RLS mirrors the existing payroll_copilot_* tables.

create table if not exists public.payroll_copilot_expense_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid null references public.payroll_copilot_runs (id) on delete set null,
  employee_hr_id text not null,
  employee_hr_id_compact text not null,
  outstation_expense_request_id bigint not null references public.outstation_expense_requests (id) on delete cascade,
  request_trip_start_date date not null,
  travel_cost numeric(14, 2) not null default 0,
  allowance numeric(14, 2) not null default 0,
  decision text not null check (decision in ('include', 'defer')),
  decided_by text not null,
  decided_at timestamptz not null default now(),
  superseded_at timestamptz null,
  superseded_by_decision_id uuid null references public.payroll_copilot_expense_decisions (id) on delete set null,
  created_at timestamptz not null default now()
);

-- One live decision per underlying expense request.
create unique index if not exists payroll_copilot_expense_decisions_live_idx
  on public.payroll_copilot_expense_decisions (outstation_expense_request_id)
  where superseded_at is null;

create index if not exists payroll_copilot_expense_decisions_run_idx
  on public.payroll_copilot_expense_decisions (run_id);
create index if not exists payroll_copilot_expense_decisions_employee_idx
  on public.payroll_copilot_expense_decisions (employee_hr_id_compact);
create index if not exists payroll_copilot_expense_decisions_period_idx
  on public.payroll_copilot_expense_decisions (employee_hr_id_compact, request_trip_start_date, decision)
  where superseded_at is null;

alter table public.payroll_copilot_expense_decisions enable row level security;

drop policy if exists payroll_copilot_expense_decisions_admin_select
  on public.payroll_copilot_expense_decisions;
create policy payroll_copilot_expense_decisions_admin_select
  on public.payroll_copilot_expense_decisions
  for select
  to authenticated
  using (public.current_access_can_manage_employees());

drop policy if exists payroll_copilot_expense_decisions_admin_insert
  on public.payroll_copilot_expense_decisions;
create policy payroll_copilot_expense_decisions_admin_insert
  on public.payroll_copilot_expense_decisions
  for insert
  to authenticated
  with check (public.current_access_can_manage_employees());

drop policy if exists payroll_copilot_expense_decisions_admin_update
  on public.payroll_copilot_expense_decisions;
create policy payroll_copilot_expense_decisions_admin_update
  on public.payroll_copilot_expense_decisions
  for update
  to authenticated
  using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());

drop policy if exists payroll_copilot_expense_decisions_admin_delete
  on public.payroll_copilot_expense_decisions;
create policy payroll_copilot_expense_decisions_admin_delete
  on public.payroll_copilot_expense_decisions
  for delete
  to authenticated
  using (public.current_access_can_manage_employees());

comment on table public.payroll_copilot_expense_decisions is
  'Payroll Copilot: CEO decision to include or defer an HR-approved outstation expense request in a given payroll run. Reversible via superseded_at; never mutates outstation_expense_requests.';
