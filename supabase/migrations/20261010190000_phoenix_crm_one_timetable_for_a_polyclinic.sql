-- phoenix_crm_one_timetable_for_a_polyclinic
--
-- WHAT THIS CHANGES:
--   The TIMETABLE of a polyclinic is photographed ONCE, for the building, and every customer seated
--   in it afterwards is saved against that one photograph — no second camera, no third, no fourth:
--     1. public.phoenix_crm_shared_places gains `schedule_photo_path`, `schedule_photo_captured_at`
--        and `schedule_photo_by_hr_id` — the venue's own timetable, beside the venue's own signboard
--        photo it already keeps in `photo_path`;
--     2. every venue that already has somebody seated in it is backfilled from the EARLIEST seating's
--        own photo, so no rep who has already photographed a board is asked for it again;
--     3. phoenix_crm_places_photo_uidx becomes PARTIAL — `where shared_place_id is null`. One photo is
--        still evidence of one capture for a place captured at its own door; a SEATED row's photo is
--        the building's timetable and is deliberately shared by the customers behind that door;
--     4. phoenix_crm_insert_place learns the seating branch: it locks the venue, refuses a customer
--        already seated in it, and either REUSES the venue's stored timetable (no photo slot consumed,
--        the seating dated now) or consumes the fresh slot and makes that photo the venue's timetable.
--        Body taken from pg_proc.prosrc, live on production 2026-10-10 (md5 514d1e77c9ea451f8e36da5781abc4c0).
--
-- WHY:
--   Owner, 2026-10-10, in chat: "in polyclinic the validation must be as we discussed, but we will
--   make one edit — when he adds the doctors, the three doctors we agreed in the same polyclinic, ask
--   him for only one timetable, not for every doctor."
--
--   🔴 IT SUPERSEDES 20261010013001's OWN "WHY THE TIMETABLE PHOTO IS PER CUSTOMER AND NOT ONE SHARED
--   IMAGE", which named the two obstacles rather than a reason to keep it: the unique index (now
--   partial, step 3) and the evidence stamp the camera burns in (the stamp is the VENUE's name now,
--   because the board is the building's). The timetable of a polyclinic lists every person who
--   receives there — that is what makes it the right evidence for each of them — so one photograph of
--   it answers the same question about all three doctors, and the schedule read still asks that
--   question once per customer against that one image.
--
--   🔴 WHY THE SLOT IS NOT CONSUMED TWICE: public.phoenix_crm_take_photo marks a slot `used_at` and
--   refuses a second use ('phoenix_crm:photo_used'). It is the slot that made a seating idempotent —
--   press Save twice and the second answered photo_used. A reused timetable has no fresh slot, so the
--   idempotence is restored by the explicit refusal in step 4: one customer sits in one venue once,
--   checked while the venue's row is locked, which serialises two saves in the same building.
--
-- ROLLBACK:
--   drop index if exists public.phoenix_crm_shared_places_timetable_uidx;
--   drop index if exists public.phoenix_crm_places_photo_uidx;
--   create unique index phoenix_crm_places_photo_uidx on public.phoenix_crm_places (photo_path);
--     -- (that recreation FAILS while two seated rows share one timetable; delete the newer seatings
--     --  first, or leave the partial index in place — it is strictly weaker, never wrong.)
--   alter table public.phoenix_crm_shared_places
--     drop column if exists schedule_photo_path,
--     drop column if exists schedule_photo_captured_at,
--     drop column if exists schedule_photo_by_hr_id;
--   Then restore phoenix_crm_insert_place from 20261010013001, which is quoted there in full.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration rewrites not one place, customer, visit or venue row: it adds three nullable columns,
-- fills them from rows that already exist, and swaps one index for a narrower one.

begin;
set local lock_timeout = '5s';

-- 1 ─ The venue keeps its own timetable ─────────────────────────────────────────────────────────

alter table public.phoenix_crm_shared_places
  -- The photograph of the board on the wall inside the building, taken once. A seated customer's
  -- place row carries this same path in its own `photo_path`, which is what the Place checks page,
  -- the signed-photo read and a refusal all already work off.
  add column if not exists schedule_photo_path text,
  add column if not exists schedule_photo_captured_at timestamptz,
  add column if not exists schedule_photo_by_hr_id text;

comment on column public.phoenix_crm_shared_places.schedule_photo_path is
  'The building''s own timetable photo, taken ONCE and reused for every customer seated in it (owner, 2026-10-10: "ask him for only one timetable, not for every doctor"). Replaced whenever a rep photographs the board again, which is how a changed timetable is recorded.';

-- One capture, one venue. A photo slot is single-use, so two venues can never legitimately name the
-- same path; nulls are unconstrained, which is every venue nobody has been seated in yet.
create unique index if not exists phoenix_crm_shared_places_timetable_uidx
  on public.phoenix_crm_shared_places (schedule_photo_path);

-- 2 ─ Backfill: the board a rep has ALREADY photographed is the venue's ─────────────────────────
--
-- The earliest seating in each venue, because that is the one taken when the rep was standing at the
-- board with nobody seated yet. Only venues with a seating are touched; `is null` keeps it re-runnable.
with first_seating as (
  select distinct on (pl.shared_place_id)
    pl.shared_place_id,
    pl.photo_path,
    pl.captured_at,
    pl.created_by_hr_id
  from public.phoenix_crm_places pl
  where pl.shared_place_id is not null
  order by pl.shared_place_id, pl.captured_at asc, pl.id asc
)
update public.phoenix_crm_shared_places s
set schedule_photo_path = f.photo_path,
    schedule_photo_captured_at = f.captured_at,
    schedule_photo_by_hr_id = f.created_by_hr_id,
    updated_at = now()
from first_seating f
where f.shared_place_id = s.id
  and s.schedule_photo_path is null;

-- 3 ─ One photo is one capture — for a place captured at its OWN door ───────────────────────────
--
-- A seated row's photo is the building's timetable, and the whole point of this migration is that the
-- customers behind one door share it. The guard stays exactly as strong as it was for every place a
-- rep captures himself, which is every row where `shared_place_id is null`.
-- SAFE: the index is replaced in the same transaction by a partial one over the same column; no row
-- is read, written or deleted by either statement.
drop index if exists public.phoenix_crm_places_photo_uidx;
create unique index if not exists phoenix_crm_places_photo_uidx
  on public.phoenix_crm_places (photo_path)
  where shared_place_id is null;

-- 4 ─ The place insert reuses the venue's timetable ─────────────────────────────────────────────

create or replace function public.phoenix_crm_insert_place(p_customer_id uuid, p_seat_id text, p_actor_hr_id text, p_is_test boolean, p_place jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_captured_at timestamptz;
  v_place_id uuid;
  v_source text := coalesce(p_place ->> 'point_source', 'pin');
  v_shared uuid := nullif(p_place ->> 'shared_place_id', '')::uuid;
  v_photo text := nullif(trim(coalesce(p_place ->> 'photo_path', '')), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
begin
  if jsonb_typeof(p_place) is distinct from 'object'
    or jsonb_typeof(p_place -> 'timings') is distinct from 'array'
    or v_photo is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A caller that names no source sent one reading, the pin, in lat/lon — exactly as before today.
  -- 'shared_place' joins the three: the point was copied from a venue this place must name.
  if v_source not in ('photo', 'pin', 'shared_place') then
    v_source := 'pin';
  end if;
  if v_source = 'shared_place' and v_shared is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  if v_shared is null then
    v_captured_at := public.phoenix_crm_take_photo(v_photo, p_actor_hr_id, p_seat_id, 'place', p_is_test);
  else
    -- 🔴 THE TIMETABLE IS THE BUILDING'S, PHOTOGRAPHED ONCE (owner, 2026-10-10). The venue's row is
    -- locked for the rest of this transaction, which is what makes the two checks below race-proof:
    -- two reps seating two doctors in the same building at the same second queue here.
    select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_shared for update;
    if not found then
      raise exception 'phoenix_crm:shared_place_not_found';
    end if;
    if v_venue.status = 'retired' then
      raise exception 'phoenix_crm:shared_place_retired';
    end if;
    if v_venue.status = 'held' then
      raise exception 'phoenix_crm:shared_place_held';
    end if;
    -- 🔴 ONE CUSTOMER SITS IN ONE BUILDING ONCE, and this refusal is what replaces the idempotence the
    -- photo slot used to give a seating: a reused timetable consumes no slot, so a second Save would
    -- otherwise write a second identical row instead of answering photo_used. His hours are windows in
    -- the ONE row (`timings`), so a second row was never how a doctor receives twice in a building.
    if exists (
      select 1
      from public.phoenix_crm_places pl
      where pl.customer_id = p_customer_id
        and pl.shared_place_id = v_shared
        and pl.status = 'active'
    ) then
      raise exception 'phoenix_crm:already_seated';
    end if;

    if v_venue.schedule_photo_path is not null and v_photo = v_venue.schedule_photo_path then
      -- The board is already on file: no camera was opened, so there is no slot to consume and no
      -- phone clock to compare. The seating is dated NOW — when this customer was seated — and never
      -- the day the board was photographed.
      v_captured_at := now();
    else
      v_captured_at := public.phoenix_crm_take_photo(v_photo, p_actor_hr_id, p_seat_id, 'place', p_is_test);
      -- A fresh photograph of the board becomes the venue's timetable, whether it is the first one or
      -- a replacement for a board that changed. The earlier seatings keep the photo they were saved
      -- against, which is the evidence that was true of them.
      update public.phoenix_crm_shared_places
      set schedule_photo_path = v_photo,
          schedule_photo_captured_at = v_captured_at,
          schedule_photo_by_hr_id = upper(trim(p_actor_hr_id)),
          updated_at = now()
      where id = v_shared;
    end if;
  end if;

  -- Every location column here is the SERVER's own resolution of the fixed point (server/list.ts
  -- placePayload), not anything the phone typed. The two raw readings are kept beside it as evidence.
  insert into public.phoenix_crm_places (
    customer_id, seat_id, label, address, brick_id, brick_name, brick_distance_km, brick_lookup,
    area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters,
    timings, photo_path, captured_at, device_skew_minutes, created_by_hr_id, is_test,
    pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, point_source,
    shared_place_id, schedule_check
  )
  values (
    p_customer_id,
    p_seat_id,
    nullif(trim(coalesce(p_place ->> 'label', '')), ''),
    nullif(trim(coalesce(p_place ->> 'address', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_name', '')), ''),
    (p_place ->> 'brick_distance_km')::numeric,
    -- 2026-10-08. 🔴 The fallback is the UNKNOWN value, never 'matched': a caller that sends no key —
    -- an older build, a replayed body — must land on "nobody looked", which is both true of it and the
    -- safe direction. The column's CHECK rejects anything that is not one of the three.
    coalesce(nullif(trim(coalesce(p_place ->> 'brick_lookup', '')), ''), 'could_not_look'),
    nullif(trim(coalesce(p_place ->> 'area_code', '')), ''),
    nullif(trim(coalesce(p_place ->> 'area_name', '')), ''),
    nullif(trim(coalesce(p_place ->> 'region_code', '')), ''),
    nullif(trim(coalesce(p_place ->> 'region_name', '')), ''),
    nullif(trim(coalesce(p_place ->> 'zone', '')), ''),
    (p_place ->> 'lat')::double precision,
    (p_place ->> 'lon')::double precision,
    (p_place ->> 'accuracy_meters')::numeric,
    p_place -> 'timings',
    v_photo,
    v_captured_at,
    (p_place ->> 'device_skew_minutes')::integer,
    upper(trim(p_actor_hr_id)),
    p_is_test,
    coalesce((p_place ->> 'pin_lat')::double precision, (p_place ->> 'lat')::double precision),
    coalesce((p_place ->> 'pin_lon')::double precision, (p_place ->> 'lon')::double precision),
    coalesce((p_place ->> 'pin_accuracy_meters')::numeric, (p_place ->> 'accuracy_meters')::numeric),
    (p_place ->> 'photo_lat')::double precision,
    (p_place ->> 'photo_lon')::double precision,
    (p_place ->> 'photo_accuracy_meters')::numeric,
    nullif(p_place ->> 'photo_captured_at', '')::timestamptz,
    v_source,
    v_shared,
    case when jsonb_typeof(p_place -> 'schedule_check') = 'object' then p_place -> 'schedule_check' end
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$$;

revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;

commit;
