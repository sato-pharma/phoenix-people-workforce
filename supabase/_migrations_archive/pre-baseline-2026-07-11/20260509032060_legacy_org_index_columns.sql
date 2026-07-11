-- Compatibility baseline for org-scope index targets used by legacy
-- performance migrations.

begin;

alter table public.employee_history
  add column if not exists department_id bigint,
  add column if not exists line_id bigint,
  add column if not exists area_id bigint,
  add column if not exists position_id bigint;

alter table public.position_vacancies
  add column if not exists department_id bigint,
  add column if not exists line_id bigint,
  add column if not exists area_id bigint,
  add column if not exists position_id bigint;

alter table public.positions
  add column if not exists department_id bigint,
  add column if not exists line_id bigint,
  add column if not exists area_id bigint;

alter table public.job_offers
  add column if not exists department_id bigint,
  add column if not exists line_id bigint,
  add column if not exists area_id bigint,
  add column if not exists position_id bigint,
  add column if not exists manager_hr_id text,
  add column if not exists employee_hr_id text;

notify pgrst, 'reload schema';

commit;
