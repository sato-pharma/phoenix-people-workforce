-- Compatibility baseline for teams.area_id used by legacy index cleanup.

begin;

alter table public.teams
  add column if not exists area_id bigint;

notify pgrst, 'reload schema';

commit;
