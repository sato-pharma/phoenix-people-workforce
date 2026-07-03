-- Adds an optional display nickname to employees. When populated, this is the
-- name shown across live app UI and reports instead of the legal full name.
-- Legal/compliance documents (contracts, offer letters, payslips, payroll
-- exports) and persisted workflow audit-trail snapshots continue to use
-- full_name and are intentionally unaffected.
alter table public.employees
  add column if not exists nickname text null;

comment on column public.employees.nickname is
  'Optional short display name shown system-wide in the live app UI and reports in place of full_name. Falls back to full_name when blank. Does not affect legal/payroll documents or persisted workflow audit snapshots, which always use full_name.';
