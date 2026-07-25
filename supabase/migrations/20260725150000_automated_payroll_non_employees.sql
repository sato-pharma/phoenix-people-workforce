-- Automated Payroll — Non-Employees Payroll (owner rule 2026-07-25).
--
-- People who receive a monthly salary but have no employee/HR_ID record at all
-- (not in the employee master). A free-form, HR-authored list per run — added
-- and removed manually each month, never derived from the employee population.
-- Flat total only: no deductions/additions, no lifecycle, no payment-mode split
-- — the whole amount is paid with Part 1. Deliberately NOT wired into
-- automated_payroll_draft_rows / assembleRows / publishToPayslips: these people
-- must never generate a real employee salary_record. They are appended only to
-- the exported Part 1 xlsx sheet's own "Non-Employees" section and its grand
-- total, purely for finance's visibility.
--
-- RLS mirrors the rest of this module exactly (see 20260720100000_automated_payroll.sql):
-- service_role bypasses RLS; authenticated is gated by
-- public.current_access_can_manage_employees() (Super Admin only, enforced again
-- in the service layer); no anon grant.

create table if not exists public.automated_payroll_non_employees (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.automated_payroll_runs(id) on delete cascade,
  full_name_ar    text not null,
  full_name_en    text not null,
  total_salary    numeric(14, 2) not null default 0,
  bank_name       text,
  bank_account    text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint automated_payroll_non_employees_total_salary_check check (total_salary >= 0)
);
create index if not exists automated_payroll_non_employees_run_idx
  on public.automated_payroll_non_employees (run_id);

alter table public.automated_payroll_non_employees enable row level security;

drop policy if exists automated_payroll_non_employees_admin_select on public.automated_payroll_non_employees;
drop policy if exists automated_payroll_non_employees_admin_insert on public.automated_payroll_non_employees;
drop policy if exists automated_payroll_non_employees_admin_update on public.automated_payroll_non_employees;
drop policy if exists automated_payroll_non_employees_admin_delete on public.automated_payroll_non_employees;

create policy automated_payroll_non_employees_admin_select on public.automated_payroll_non_employees
  for select to authenticated using (public.current_access_can_manage_employees());
create policy automated_payroll_non_employees_admin_insert on public.automated_payroll_non_employees
  for insert to authenticated with check (public.current_access_can_manage_employees());
create policy automated_payroll_non_employees_admin_update on public.automated_payroll_non_employees
  for update to authenticated using (public.current_access_can_manage_employees())
  with check (public.current_access_can_manage_employees());
create policy automated_payroll_non_employees_admin_delete on public.automated_payroll_non_employees
  for delete to authenticated using (public.current_access_can_manage_employees());

revoke all on table public.automated_payroll_non_employees from anon;
revoke all on table public.automated_payroll_non_employees from public;
grant select, insert, update, delete on table public.automated_payroll_non_employees to authenticated;
grant all on table public.automated_payroll_non_employees to service_role;
