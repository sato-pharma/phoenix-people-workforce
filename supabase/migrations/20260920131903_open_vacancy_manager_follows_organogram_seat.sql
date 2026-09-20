-- open_vacancy_manager_follows_organogram_seat
--
-- WHAT THIS CHANGES: an OPEN position_vacancies row that sits on an organogram seat now takes its
--   manager_hr_id / manager_name / region_name from that seat's PARENT seat, by itself, and keeps
--   following it. Three pieces:
--     1. public.phx_vacancy_seat_manager(seat)       - who holds the seat above this one (read-only)
--     2. BEFORE INSERT OR UPDATE row trigger          - stamps an open, seated vacancy on every write
--     3. statement triggers on au.seats and
--        au.occupancy_history                         - re-sync every open vacancy when the org moves
--   A seat whose parent is VACANT changes nothing (the stored manager stays: Pedia Cairo's five
--   reps keep their stand-in until a manager is seated). Filled and cancelled vacancies are never
--   touched, and manager_replacement_for_hr_id is left exactly as it is.
--
-- WHY: the Employee Master takes a new hire's Direct Manager from the vacancy row, and that column was
--   a COPY written once. The 2026-09-01 territory splits moved seats but nobody re-stamped the copies:
--   the open Pedia Fayoum vacancy still named Taha (Giza) instead of Osama (Upper Egypt 1), and five
--   more (Pedia Qena 1, Sohag 1, Behira 1, Behira 2, Alex East; Anti Infective Qena 1) were wrong the
--   same way - all repaired by hand on 2026-09-20. This makes the organogram the single source.
--
-- ROLLBACK: drop trigger trg_position_vacancies_sync_manager_from_seat on public.position_vacancies;
--   drop trigger trg_au_seats_sync_vacancy_managers on au.seats;
--   drop trigger trg_au_occupancy_sync_vacancy_managers on au.occupancy_history;
--   drop function public.phx_sync_vacancy_managers_after_org_change(), public.phx_sync_open_vacancy_managers(),
--   public.phx_vacancy_manager_from_seat(), public.phx_vacancy_seat_manager(text);
--   The values the triggers already wrote stay; nothing else is lost.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive and not bulk: at most the ~44 open seated vacancy rows, and the backfill at the end
-- changes zero rows today (every open seated vacancy already matches its seat, checked 2026-09-20).

begin;

-- 1. The manager the organogram gives a seat: the occupant of its parent seat, when there is one.
create or replace function public.phx_vacancy_seat_manager(p_seat_id text)
returns table (manager_hr_id text, manager_name text, region_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.occupant_hr_id::text, e.full_name::text, s.region_name::text
    from au.v_org_tree s
    join au.v_org_tree p on p.seat_id = s.parent_seat_id
    join public.employees e on e.hr_id = p.occupant_hr_id
   where s.seat_id = p_seat_id
     and p.occupant_hr_id is not null;
$$;

revoke execute on function public.phx_vacancy_seat_manager(text) from public, anon, authenticated;
grant execute on function public.phx_vacancy_seat_manager(text) to service_role;

-- 2. Every write to an open, seated vacancy carries the seat's manager.
create or replace function public.phx_vacancy_manager_from_seat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if lower(coalesce(new.status, 'open')) <> 'open' or new.seat_id is null then
    return new;
  end if;

  select * into v from public.phx_vacancy_seat_manager(new.seat_id);
  if v.manager_hr_id is null then
    return new;
  end if;

  new.manager_hr_id := v.manager_hr_id;
  new.manager_name := v.manager_name;
  new.region_name := coalesce(v.region_name, new.region_name);
  return new;
end;
$$;

revoke execute on function public.phx_vacancy_manager_from_seat() from public, anon, authenticated;

drop trigger if exists trg_position_vacancies_sync_manager_from_seat on public.position_vacancies;
-- Named to sort AFTER trg_position_vacancies_stamp_seat, which stamps seat_id on INSERT first.
create trigger trg_position_vacancies_sync_manager_from_seat
  before insert or update on public.position_vacancies
  for each row execute function public.phx_vacancy_manager_from_seat();

-- 3. When the organogram itself moves, re-sync every open seated vacancy. Returns the rows changed.
create or replace function public.phx_sync_open_vacancy_managers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
begin
  with want as (
    select x.id, m.manager_hr_id, m.manager_name, m.region_name
      from public.position_vacancies x
     cross join lateral public.phx_vacancy_seat_manager(x.seat_id) m
     where lower(coalesce(x.status, 'open')) = 'open'
       and x.seat_id is not null
       and (
         x.manager_hr_id is distinct from m.manager_hr_id
         or x.manager_name is distinct from m.manager_name
         or x.region_name is distinct from coalesce(m.region_name, x.region_name)
       )
  )
  update public.position_vacancies v
     set manager_hr_id = want.manager_hr_id,
         manager_name = want.manager_name,
         region_name = coalesce(want.region_name, v.region_name),
         updated_at = now()
    from want
   where v.id = want.id;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke execute on function public.phx_sync_open_vacancy_managers() from public, anon, authenticated;
grant execute on function public.phx_sync_open_vacancy_managers() to service_role;

-- A hire, a departure or a seat move must never be blocked by this bookkeeping, so a failure here is a
-- warning, not an error.
create or replace function public.phx_sync_vacancy_managers_after_org_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.phx_sync_open_vacancy_managers();
  exception when others then
    raise warning 'phx_sync_open_vacancy_managers failed after an organogram change: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke execute on function public.phx_sync_vacancy_managers_after_org_change() from public, anon, authenticated;

drop trigger if exists trg_au_seats_sync_vacancy_managers on au.seats;
create trigger trg_au_seats_sync_vacancy_managers
  after insert or update or delete on au.seats
  for each statement execute function public.phx_sync_vacancy_managers_after_org_change();

drop trigger if exists trg_au_occupancy_sync_vacancy_managers on au.occupancy_history;
create trigger trg_au_occupancy_sync_vacancy_managers
  after insert or update or delete on au.occupancy_history
  for each statement execute function public.phx_sync_vacancy_managers_after_org_change();

-- Backfill: idempotent, and a no-op today.
do $$
begin
  perform public.phx_sync_open_vacancy_managers();
end;
$$;

commit;
