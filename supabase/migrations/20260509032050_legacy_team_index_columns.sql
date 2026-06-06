-- Compatibility baseline for team_id index targets used by the
-- security-first performance migration.

begin;

alter table public.employee_history
  add column if not exists team_id bigint;

alter table public.position_vacancies
  add column if not exists team_id bigint;

alter table public.positions
  add column if not exists team_id bigint;

alter table public.employees
  add column if not exists team_id bigint;

notify pgrst, 'reload schema';

commit;
