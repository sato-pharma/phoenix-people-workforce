-- open_vacancy_with_no_manager_adopts_the_region_dm
--
-- WHAT THIS CHANGES: an OPEN position_vacancies row that carries NO manager now adopts the District
--   Manager of its own line + region, when that DM seat is occupied. Three pieces:
--     1. public.phx_vacancy_region_manager(line_id, region_name) - the occupant of that region's DM
--        seat, read-only, and ONLY when the pair resolves to exactly one occupied DM seat.
--     2. public.phx_vacancy_manager_from_seat() - the BEFORE INSERT/UPDATE row trigger gains the
--        same fallback, so a vacancy written with no manager never lands unowned.
--     3. public.phx_sync_open_vacancy_managers() - the organogram sweep gains a SECOND pass that
--        adopts every open, manager-less row the first pass could not reach.
--   The first pass is untouched: a row that HAS a manager still follows its seat's parent, and the
--   new pass only ever fills a NULL. It never overrides a stored manager, so the replacement-
--   ownership engine keeps its say, and filled/cancelled vacancies are still never touched.
--
-- WHY: the sweep's first pass requires `seat_id is not null` and resolves the manager through the
--   seat's PARENT. A vacancy with no organogram seat at all therefore has no route to a manager:
--   VAC-PEDIA-CAIRO-DOWNTOWN-SHOUBRA-MR (id 245, Pedia Cairo, area "Down town") has seat_id NULL
--   because the organogram has no rep seat for that area, and the Line Vacancies page showed it
--   unowned. Its line + region alone are enough to name the right manager - Pedia Cairo's DM seat
--   SEAT-PED-DM-CA, occupied by Zahraa Hamdy Sobeih (PD-0031) - so the engine can do what was done
--   by hand before (the 2026-08-09 repair of id 246 says so in its own note).
--
-- ROLLBACK: re-run the two functions from
--   20260920131903_open_vacancy_manager_follows_organogram_seat.sql, then
--   drop function public.phx_vacancy_region_manager(bigint, text);
--   The values the sweep already wrote stay; nothing else is lost.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- Not destructive and not bulk: the backfill at the end changes ZERO rows today - every open
-- vacancy already carries a manager (checked 2026-10-26, `manager_hr_id is null` returns no open
-- row), so this closes the hole for the NEXT seatless vacancy rather than repairing one now.

begin;

-- 1. The manager a line + region gives on its own: the occupant of that region's DM seat.
--    Deliberately strict - it answers only when the pair resolves to exactly ONE occupied DM seat,
--    so a future organogram carrying two DM seats for one region returns nothing instead of
--    guessing. Today all 23 line+region DM groups are unique and single-occupant.
--    The pseudo-DM seats (PEDIA "Others" and its siblings) carry no occupant, so they answer
--    nothing by construction.
create or replace function public.phx_vacancy_region_manager(
  p_line_id bigint,
  p_region_name text
)
returns table (manager_hr_id text, manager_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select max(s.occupant_hr_id)::text, max(e.full_name)::text
    from au.v_org_tree s
    join public.employees e on e.hr_id = s.occupant_hr_id
   where s.seat_tier = 'DM'
     and s.line_id = p_line_id
     and s.region_name = p_region_name
     and s.occupant_hr_id is not null
     and p_line_id is not null
     and p_region_name is not null
  having count(distinct s.occupant_hr_id) = 1;
$$;

revoke execute on function public.phx_vacancy_region_manager(bigint, text) from public, anon, authenticated;
grant execute on function public.phx_vacancy_region_manager(bigint, text) to service_role;

-- 2. Every write to an open vacancy carries the seat's manager; with no seat and no manager, the
--    region's DM. Replaces the 2026-09-20 body, which returned early on a seatless row.
create or replace function public.phx_vacancy_manager_from_seat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if lower(coalesce(new.status, 'open')) <> 'open' then
    return new;
  end if;

  -- The seat's parent is the first authority and still overrides a stored manager.
  if new.seat_id is not null then
    select * into v from public.phx_vacancy_seat_manager(new.seat_id);
    if v.manager_hr_id is not null then
      new.manager_hr_id := v.manager_hr_id;
      new.manager_name := v.manager_name;
      new.region_name := coalesce(v.region_name, new.region_name);
      return new;
    end if;
  end if;

  -- Nothing came from the organogram seat. Only a row with NO manager at all adopts the region's
  -- DM: a stored manager belongs to whoever put it there (the replacement-ownership engine).
  if new.manager_hr_id is null then
    select * into v from public.phx_vacancy_region_manager(new.line_id, new.region_name);
    if v.manager_hr_id is not null then
      new.manager_hr_id := v.manager_hr_id;
      new.manager_name := v.manager_name;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.phx_vacancy_manager_from_seat() from public, anon, authenticated;

-- 3. The sweep: pass 1 unchanged, plus pass 2 for the rows pass 1 cannot reach.
create or replace function public.phx_sync_open_vacancy_managers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
  v_adopted integer;
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

  -- Pass 2: an open row still carrying NO manager adopts its own line + region's DM. This is the
  -- only route for a vacancy with no organogram seat (id 245, Pedia Cairo "Down town"), and it
  -- also catches a seated row whose parent seat is vacant. `manager_hr_id is null` is the whole
  -- guard - a row with a manager is never re-pointed here.
  with want as (
    select x.id, m.manager_hr_id, m.manager_name
      from public.position_vacancies x
     cross join lateral public.phx_vacancy_region_manager(x.line_id, x.region_name) m
     where lower(coalesce(x.status, 'open')) = 'open'
       and x.manager_hr_id is null
       and m.manager_hr_id is not null
  )
  update public.position_vacancies v
     set manager_hr_id = want.manager_hr_id,
         manager_name = want.manager_name,
         updated_at = now()
    from want
   where v.id = want.id;

  get diagnostics v_adopted = row_count;

  return coalesce(v_changed, 0) + coalesce(v_adopted, 0);
end;
$$;

revoke execute on function public.phx_sync_open_vacancy_managers() from public, anon, authenticated;
grant execute on function public.phx_sync_open_vacancy_managers() to service_role;

-- Backfill: idempotent, and a no-op today.
do $$
begin
  perform public.phx_sync_open_vacancy_managers();
end;
$$;

commit;
