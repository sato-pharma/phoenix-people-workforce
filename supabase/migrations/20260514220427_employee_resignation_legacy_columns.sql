-- Compatibility columns for legacy resignation report migrations.
-- Some branch databases only have the first employee_resignations shape.

begin;

alter table public.employee_resignations
  add column if not exists employee_name text,
  add column if not exists job_title text,
  add column if not exists line_name text,
  add column if not exists submitted_date date,
  add column if not exists effective_date date,
  add column if not exists workflow_notes text,
  add column if not exists status text not null default 'submitted',
  add column if not exists created_by text;

notify pgrst, 'reload schema';

commit;
