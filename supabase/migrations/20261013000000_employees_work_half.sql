-- Which half of the day an employee is CONTRACTED to work.
--
-- Owner, 2026-10-12, after the half-day trace report for October listed five of Ahmed Farag's
-- afternoons as mornings he had failed to record: "ahmed farag is part time he works pm only".
--
-- Before this column the platform had no way to hold that fact. `employees.contract_type` reads
-- "full time" for all 178 people who carry a value at all (36 are null) — not one part-timer in the
-- company — and the `am_only`/`pm_only` already in the half-day code is one day's approved half-day
-- VACATION, not a working pattern. So `judgeHalfDay` read a PM-only rep's missing morning as an
-- unrecorded half on every working day, and its own reason line said "Worked the afternoon only —
-- nothing recorded for the morning".
--
-- 🔴 A half outside the contract is LEFT ALONE, never "cleared": there is no trace to ask for,
-- because the half was never owed. The rule reads this column before it looks for any evidence.
--
-- Default 'full_day' is deliberate: every existing row keeps exactly today's behaviour, and a
-- part-half contract exists only where somebody records one.

alter table public.employees
  add column if not exists work_half text not null default 'full_day';

alter table public.employees
  drop constraint if exists employees_work_half_check;

alter table public.employees
  add constraint employees_work_half_check
  check (work_half in ('full_day', 'am_only', 'pm_only'));

comment on column public.employees.work_half is
  'The half of the day this contract covers: full_day (default), am_only or pm_only. Read by the '
  'deductions half-day rule, which leaves the OTHER half alone rather than asking for a trace of '
  'it. This is a contracted working pattern, NOT an approved half-day vacation (vacation_requests'
  '.day_part carries that).';
