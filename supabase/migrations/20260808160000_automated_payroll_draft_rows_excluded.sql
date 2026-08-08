-- Run-scoped employee exclusion for Automated Payroll.
--
-- `on_hold` already exists (20260720100000_automated_payroll.sql) but only excludes a row
-- from PUBLISH — it still runs through recommendation, assembly, and the Part 2 pre-flight
-- gate. That gate is a hard, non-acknowledgeable block: a row whose derived Gross Salary
-- comes out <= 0 refuses the whole run's Part 2 confirmation (validateSalaryRows in
-- src/lib/payroll/salary-import.ts), even for a single edge-case employee.
--
-- Real case (owner-reported 2026-08-08): a same-day hire/termination whose master record
-- carries only allowance figures (net = cost-of-living + fuel, no base) — a genuine data
-- gap, not a code bug — blocking the entire month's Part 2 for everyone else too.
--
-- `excluded` removes one employee from THIS run's population entirely (every step, the
-- data-quality audit, and assembly/pre-flight) without touching their master employee
-- record or any other run. `excluded_reason` is required by the service layer so the
-- decision is on the record, mirroring the `manual_reason`/`hold_reason` convention.
alter table public.automated_payroll_draft_rows
  add column if not exists excluded boolean not null default false,
  add column if not exists excluded_reason text;
