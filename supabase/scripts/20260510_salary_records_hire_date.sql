alter table if exists public.salary_records
  add column if not exists hire_date date null,
  add column if not exists name_ar text null,
  add column if not exists comment text null;
