do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'salary_records' and column_name = 'employee_code'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'salary_records' and column_name = 'hr_id'
  ) then
    alter table public.salary_records rename column employee_code to hr_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'salary_flags' and column_name = 'employee_code'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'salary_flags' and column_name = 'hr_id'
  ) then
    alter table public.salary_flags rename column employee_code to hr_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payroll_expenses' and column_name = 'employee_code'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payroll_expenses' and column_name = 'hr_id'
  ) then
    alter table public.payroll_expenses rename column employee_code to hr_id;
  end if;
end $$;

alter table if exists public.salary_records
  add column if not exists hr_id text null;

alter table if exists public.salary_flags
  add column if not exists hr_id text null;

alter table if exists public.payroll_expenses
  add column if not exists hr_id text null;

-- Drop old index and recreate with new column name
DROP INDEX IF EXISTS payroll_expenses_employee_idx;
CREATE INDEX IF NOT EXISTS payroll_expenses_hr_id_idx ON public.payroll_expenses (hr_id);
