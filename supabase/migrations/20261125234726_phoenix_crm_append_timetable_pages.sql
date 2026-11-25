-- phoenix_crm_append_timetable_pages
--
-- WHAT THIS CHANGES: one new function, phoenix_crm_append_timetable_pages. It ADDS photos to the
-- timetable a building already has on file, after the photos already there, instead of replacing it
-- (owner, 25 Nov 2026: "The timetable uploaded is already correct. I don't want to replace it. I want
-- to have the two options: replace the current timetable or ... add to what exists" — the rest of a
-- big board, or another day's timetable of the same building). The first photo stays the building's
-- board (phoenix_crm_shared_places.schedule_photo_path) and every photo already on file stays; the new
-- ones become its next pages in phoenix_crm_timetable_pages, still at most five photos in all (the
-- table's own CHECK, page_number between 2 and 5).
--
-- Every rule of phoenix_crm_add_timetable_pages holds here too: each new page is a place photo slot the
-- server issued to the person saving, on that seat; it is never another building's board, a customer's
-- own door photo or another board's page; and the board must be the one on file at that moment. The one
-- difference is that a board that already has pages takes more. A retry of the same save finds its
-- pages already there and writes nothing.
--
-- WHY: a building's timetable is often more than one board, and a rep finds the second one on another
-- day — the day he validates the doctor written on it. Until now the only way to add it was to
-- photograph the whole timetable again, which replaced the correct board on file.
--
-- ROLLBACK: drop function public.phoenix_crm_append_timetable_pages(jsonb);
--   (Nothing existing is changed. Pages already appended stay in phoenix_crm_timetable_pages, where they
--   read exactly like pages taken with a fresh board.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new function, no data touched.

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_append_timetable_pages(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_first text := nullif(trim(coalesce(p ->> 'first_photo_path', '')), '');
  v_pages jsonb := coalesce(p -> 'pages', '[]'::jsonb);
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_page jsonb;
  v_path text;
  v_seen text[] := array[]::text[];
  v_paths text[] := array[]::text[];
  v_number smallint;
  v_mine integer;
  v_added integer := 0;
begin
  if v_seat is null or v_actor is null or v_first is null or nullif(p ->> 'shared_place_id', '') is null
     or jsonb_typeof(v_pages) <> 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_array_length(v_pages) = 0 then
    return jsonb_build_object('pages', 0, 'added', 0, 'already', false);
  end if;
  if jsonb_array_length(v_pages) > 4 then
    raise exception 'phoenix_crm:too_many_timetable_pages';
  end if;

  for v_page in select value from jsonb_array_elements(v_pages)
  loop
    v_path := nullif(trim(coalesce(v_page ->> 'photo_path', '')), '');
    if v_path is null or v_path = v_first or v_path = any (v_paths) then
      raise exception 'phoenix_crm:bad_input';
    end if;
    v_paths := v_paths || v_path;
  end loop;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select sp.* into v_venue
  from public.phoenix_crm_shared_places sp
  where sp.id = (p ->> 'shared_place_id')::uuid
    and sp.seat_id = v_seat
    and sp.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:shared_place_not_found';
  end if;
  if v_venue.status = 'retired' then
    raise exception 'phoenix_crm:shared_place_retired';
  end if;
  -- The pages belong to the board on the wall NOW; a board replaced meanwhile takes none of them.
  if v_venue.schedule_photo_path is distinct from v_first then
    raise exception 'phoenix_crm:timetable_changed';
  end if;

  -- A retry of the same save: every one of these photos is already a page of this board.
  select count(*) into v_mine
  from public.phoenix_crm_timetable_pages tp
  where tp.first_photo_path = v_first and tp.photo_path = any (v_paths);
  if v_mine = array_length(v_paths, 1) then
    return jsonb_build_object(
      'pages', (select count(*) from public.phoenix_crm_timetable_pages tp where tp.first_photo_path = v_first),
      'added', 0,
      'already', true
    );
  end if;

  select coalesce(max(tp.page_number), 1) into v_number
  from public.phoenix_crm_timetable_pages tp
  where tp.first_photo_path = v_first;
  if v_number + (array_length(v_paths, 1) - v_mine) > 5 then
    raise exception 'phoenix_crm:too_many_timetable_pages';
  end if;

  for v_page in select value from jsonb_array_elements(v_pages)
  loop
    v_path := trim(v_page ->> 'photo_path');
    -- Already a page of this very board (a retry that half-landed): kept as it is.
    if exists (select 1 from public.phoenix_crm_timetable_pages tp where tp.photo_path = v_path and tp.first_photo_path = v_first) then
      continue;
    end if;
    -- A slot the server issued to this person, on this seat, for a place photo.
    if not exists (
      select 1 from public.phoenix_crm_photo_uploads u
      where u.path = v_path
        and upper(u.issued_to_hr_id) = v_actor
        and u.seat_id = v_seat
        and u.purpose = 'place'
        and u.is_test = v_is_test
    ) then
      raise exception 'phoenix_crm:photo_not_issued';
    end if;
    -- Never another building's board, a customer's own door photo or another board's page.
    if exists (select 1 from public.phoenix_crm_shared_places sp where sp.schedule_photo_path = v_path or sp.photo_path = v_path)
       or exists (select 1 from public.phoenix_crm_places pl where pl.photo_path = v_path)
       or exists (select 1 from public.phoenix_crm_timetable_pages tp where tp.photo_path = v_path) then
      raise exception 'phoenix_crm:photo_used';
    end if;
    v_seen := v_seen || v_path;
    v_number := v_number + 1;
    v_added := v_added + 1;
    insert into public.phoenix_crm_timetable_pages
      (photo_path, first_photo_path, page_number, shared_place_id, seat_id, added_by_hr_id, is_test, reading)
    values
      (v_path, v_first, v_number, v_venue.id, v_seat, v_actor, v_is_test,
       case when jsonb_typeof(v_page -> 'reading') = 'object' then v_page -> 'reading' else null end);
  end loop;

  return jsonb_build_object('pages', v_number - 1, 'added', v_added, 'already', false);
end;
$$;

comment on function public.phoenix_crm_append_timetable_pages(jsonb) is
  'Adds photos to the timetable a building already has on file, after its existing pages, at most five photos in all (owner, 25 Nov 2026: replace the timetable, or add to it).';

revoke execute on function public.phoenix_crm_append_timetable_pages(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_append_timetable_pages(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
