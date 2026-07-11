-- Employee Master bank name field.
-- Adds a nullable fixed employee master-data field; lifecycle visibility is intentionally untouched.

alter table public.employees
  add column if not exists bank_name text;
comment on column public.employees.bank_name is 'Employee bank name used as fixed payroll reference master data.';
