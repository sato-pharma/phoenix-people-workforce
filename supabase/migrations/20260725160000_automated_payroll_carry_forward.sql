-- Automated Payroll — overpaid carry-forward ledger (owner decision 2026-07-25).
--
-- Closes a real accounting hole found in the 2026-07-25 audit: when Part-2
-- deductions push an employee's total payable BELOW the First Part already
-- disbursed in Part 1, `assembleParts` clamps Second Part to 0 and strands the
-- difference in `overpaidResidual`. Nothing consumed that value — the company
-- overpaid and wrote it off by accident, every month, silently.
--
-- Owner decision: CARRY FORWARD. Each residual is recorded here when Part 2 is
-- confirmed, then applied as a visible deduction on a LATER run and marked
-- consumed. Deliberately a ledger rather than a column so the money has an
-- auditable trail (which run created it, which run recovered it) instead of a
-- mutable running balance nobody can reconstruct.
--
-- `amount` is always POSITIVE and means "the company is owed this back".
-- A row is outstanding while `applied_run_id is null`.
--
-- RLS mirrors the rest of this module exactly (see 20260720100000_automated_payroll.sql):
-- service_role bypasses RLS; authenticated is gated by
-- public.current_access_can_manage_employees(); no anon grant.

create table if not exists public.automated_payroll_carry_forward (
  id                      uuid primary key default gen_random_uuid(),
  source_run_id           uuid not null references public.automated_payroll_runs(id) on delete cascade,
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  amount                  numeric(14, 2) not null,
  applied_run_id          uuid references public.automated_payroll_runs(id) on delete set null,
  applied_at              timestamptz,
  created_by              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint automated_payroll_carry_forward_amount_check check (amount > 0),
  -- One balance per employee per originating run. Makes re-confirming Part 2
  -- idempotent (upsert) instead of silently stacking duplicate debts.
  constraint automated_payroll_carry_forward_source_employee_key
    unique (source_run_id, employee_hr_id_compact)
);

-- The hot read: "what does this employee still owe from previous runs?"
create index if not exists automated_payroll_carry_forward_outstanding_idx
  on public.automated_payroll_carry_forward (employee_hr_id_compact)
  where applied_run_id is null;
create index if not exists automated_payroll_carry_forward_source_idx
  on public.automated_payroll_carry_forward (source_run_id);
create index if not exists automated_payroll_carry_forward_applied_idx
  on public.automated_payroll_carry_forward (applied_run_id);

alter table public.automated_payroll_carry_forward enable row level security;

drop policy if exists automated_payroll_carry_forward_admin_select on public.automated_payroll_carry_forward;
drop policy if exists automated_payroll_carry_forward_admin_insert on public.automated_payroll_carry_forward;
drop policy if exists automated_payroll_carry_forward_admin_update on public.automated_payroll_carry_forward;
drop policy if exists automated_payroll_carry_forward_admin_delete on public.automated_payroll_carry_forward;

create policy automated_payroll_carry_forward_admin_select on public.automated_payroll_carry_forward
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_carry_forward_admin_insert on public.automated_payroll_carry_forward
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_carry_forward_admin_update on public.automated_payroll_carry_forward
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_carry_forward_admin_delete on public.automated_payroll_carry_forward
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_carry_forward from anon;
revoke all on table public.automated_payroll_carry_forward from public;
grant select, insert, update, delete on table public.automated_payroll_carry_forward to authenticated;
grant all on table public.automated_payroll_carry_forward to service_role;
