-- phoenix_crm_timetable_pages
--
-- WHAT THIS CHANGES: a polyclinic's timetable may be photographed in more than one photo (owner,
-- 25 Nov 2026: "make the rep able to upload multiple photos for a timetable … and every photo
-- appear … he can validate 1, 2, 3 doctors in one timetable if it has their name"). The first photo
-- stays exactly where it always was — phoenix_crm_shared_places.schedule_photo_path, and the
-- photo_path of every customer seated in the building. Pages 2 to 5 are new rows here, keyed on that
-- first photo, so a later replacement of the board leaves the old pages attached to the old first
-- photo and the new board starts with none. Each page keeps the reader's answer about it, so a board
-- is read once however many doctors are seated behind it.
--
-- One function writes the table, phoenix_crm_add_timetable_pages: every page must be a place photo
-- slot the server issued to the person saving, on that seat, and the first photo must be the
-- building's board on file at that moment. A page is never a second building's board or a customer's
-- own door photo. It is written once per board and never rewritten.
--
-- WHY: one board on the wall often does not fit one photo, and a building may keep a timetable per
-- floor or speciality, so the doctor the rep is seating is on the second photo. Until now only the
-- first could be sent, and that doctor was held as "not on the timetable".
--
-- ROLLBACK: drop function public.phoenix_crm_add_timetable_pages(jsonb);
--           drop table public.phoenix_crm_timetable_pages;
--   (Nothing existing is changed. Dropping the table loses the extra pages only; every first page,
--   every place and every verdict stays.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new empty table and one new function.

begin;

set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_timetable_pages (
  photo_path text primary key references public.phoenix_crm_photo_uploads (path),
  first_photo_path text not null references public.phoenix_crm_photo_uploads (path),
  page_number smallint not null,
  shared_place_id uuid not null references public.phoenix_crm_shared_places (id),
  seat_id text not null,
  added_by_hr_id text not null,
  is_test boolean not null default false,
  -- What the timetable reader saw on this one page, when it saw a board (kind 'read'); null when it
  -- was never read or the read was lost. Evidence only: the verdict is each customer's own row.
  reading jsonb,
  added_at timestamptz not null default now(),
  constraint phoenix_crm_timetable_pages_number check (page_number between 2 and 5),
  constraint phoenix_crm_timetable_pages_not_first check (photo_path <> first_photo_path),
  constraint phoenix_crm_timetable_pages_one_number unique (first_photo_path, page_number)
);

comment on table public.phoenix_crm_timetable_pages is
  'Pages 2-5 of a polyclinic timetable photographed in several photos (owner, 25 Nov 2026). Page 1 is phoenix_crm_shared_places.schedule_photo_path; rows are keyed on it. Written only by phoenix_crm_add_timetable_pages.';

create index if not exists phoenix_crm_timetable_pages_shared_place_idx
  on public.phoenix_crm_timetable_pages (shared_place_id);

alter table public.phoenix_crm_timetable_pages enable row level security;
create policy phoenix_crm_timetable_pages_service_role
  on public.phoenix_crm_timetable_pages for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_timetable_pages from public, anon, authenticated;
grant all on table public.phoenix_crm_timetable_pages to service_role;

create or replace function public.phoenix_crm_add_timetable_pages(p jsonb)
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
  v_number smallint := 1;
  v_existing integer;
begin
  if v_seat is null or v_actor is null or v_first is null or nullif(p ->> 'shared_place_id', '') is null
     or jsonb_typeof(v_pages) <> 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_array_length(v_pages) = 0 then
    return jsonb_build_object('pages', 0, 'already', false);
  end if;
  if jsonb_array_length(v_pages) > 4 then
    raise exception 'phoenix_crm:too_many_timetable_pages';
  end if;

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

  -- Written once per board: a retry of the same save finds its pages already there.
  select count(*) into v_existing from public.phoenix_crm_timetable_pages tp where tp.first_photo_path = v_first;
  if v_existing > 0 then
    return jsonb_build_object('pages', v_existing, 'already', true);
  end if;

  for v_page in select value from jsonb_array_elements(v_pages)
  loop
    v_path := nullif(trim(coalesce(v_page ->> 'photo_path', '')), '');
    if v_path is null or v_path = v_first or v_path = any (v_seen) then
      raise exception 'phoenix_crm:bad_input';
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
    insert into public.phoenix_crm_timetable_pages
      (photo_path, first_photo_path, page_number, shared_place_id, seat_id, added_by_hr_id, is_test, reading)
    values
      (v_path, v_first, v_number, v_venue.id, v_seat, v_actor, v_is_test,
       case when jsonb_typeof(v_page -> 'reading') = 'object' then v_page -> 'reading' else null end);
  end loop;

  return jsonb_build_object('pages', v_number - 1, 'already', false);
end;
$$;

revoke execute on function public.phoenix_crm_add_timetable_pages(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_add_timetable_pages(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
