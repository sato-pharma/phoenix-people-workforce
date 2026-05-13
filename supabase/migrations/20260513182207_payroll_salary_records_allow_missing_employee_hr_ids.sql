-- Payroll uploads are the monthly finance source of truth. Historical salary
-- rows can include employees already removed from the active employee directory,
-- so payroll storage must preserve the uploaded HR ID even when employees(hr_id)
-- no longer has that row.
alter table if exists public.salary_records
  drop constraint if exists salary_records_hr_id_fkey;

alter table if exists public.salary_flags
  drop constraint if exists salary_flags_hr_id_fkey;
