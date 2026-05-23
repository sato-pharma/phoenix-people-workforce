-- Data integrity: orphan guard for salary and expense records.
--
-- Salary records, flags, and payroll expenses reference employees via hr_id
-- (text FK, no hard constraint because hr_id values arrive from external
-- payroll imports before the employee record may be created). This migration
-- adds a helper view that surfaces any orphaned rows so they can be caught by
-- the pre-production preflight, and raises a WARNING (not an error) so the
-- migration itself never blocks deployment.

do $$
declare
  orphaned_salary_records   int;
  orphaned_salary_flags     int;
  orphaned_payroll_expenses int;
begin
  -- Salary records whose hr_id does not match any employee
  select count(*)
  into orphaned_salary_records
  from public.salary_records sr
  where sr.hr_id is not null
    and not exists (
      select 1 from public.employees e
      where lower(e.hr_id) = lower(sr.hr_id)
    );

  -- Salary flags whose hr_id does not match any employee
  select count(*)
  into orphaned_salary_flags
  from public.salary_flags sf
  where sf.hr_id is not null
    and not exists (
      select 1 from public.employees e
      where lower(e.hr_id) = lower(sf.hr_id)
    );

  -- Payroll expenses whose hr_id does not match any employee
  select count(*)
  into orphaned_payroll_expenses
  from public.payroll_expenses pe
  where pe.hr_id is not null
    and not exists (
      select 1 from public.employees e
      where lower(e.hr_id) = lower(pe.hr_id)
    );

  if orphaned_salary_records > 0 then
    raise warning 'DATA INTEGRITY: % salary_records row(s) reference an hr_id not present in employees.',
      orphaned_salary_records;
  end if;

  if orphaned_salary_flags > 0 then
    raise warning 'DATA INTEGRITY: % salary_flags row(s) reference an hr_id not present in employees.',
      orphaned_salary_flags;
  end if;

  if orphaned_payroll_expenses > 0 then
    raise warning 'DATA INTEGRITY: % payroll_expenses row(s) reference an hr_id not present in employees.',
      orphaned_payroll_expenses;
  end if;

  if orphaned_salary_records = 0
    and orphaned_salary_flags = 0
    and orphaned_payroll_expenses = 0 then
    raise notice 'DATA INTEGRITY: All salary and expense hr_id references are clean.';
  end if;
end $$;

-- Materialised orphan view for the data-health dashboard.
-- Recreate idempotently so subsequent runs are safe.
drop view if exists public.v_orphaned_payroll_hr_ids;
create or replace view public.v_orphaned_payroll_hr_ids as
  select 'salary_records'  as source_table, hr_id, null::text as batch_id
  from public.salary_records
  where hr_id is not null
    and not exists (select 1 from public.employees e where lower(e.hr_id) = lower(salary_records.hr_id))
  union all
  select 'salary_flags', hr_id, null
  from public.salary_flags
  where hr_id is not null
    and not exists (select 1 from public.employees e where lower(e.hr_id) = lower(salary_flags.hr_id))
  union all
  select 'payroll_expenses', hr_id, null
  from public.payroll_expenses
  where hr_id is not null
    and not exists (select 1 from public.employees e where lower(e.hr_id) = lower(payroll_expenses.hr_id));

-- Grant read access to service_role only (used by the data-health API).
revoke all on public.v_orphaned_payroll_hr_ids from anon, authenticated;
grant select on public.v_orphaned_payroll_hr_ids to service_role;

notify pgrst, 'reload schema';
