alter table if exists public.employee_compensation
  add column if not exists salary_details jsonb not null default '[]'::jsonb;
comment on column public.employee_compensation.salary_details is
  'Flexible salary detail rows for employee lifecycle forms. Stores label/value/type/category metadata as JSON.';
