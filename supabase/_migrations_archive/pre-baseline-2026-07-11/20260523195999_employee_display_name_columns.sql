-- Compatibility display columns used by manager hierarchy and reporting views.

begin;

alter table public.employees
  add column if not exists department_name text,
  add column if not exists line_name text,
  add column if not exists area_name text,
  add column if not exists team_name text;

notify pgrst, 'reload schema';

commit;
