-- phoenix_crm_insert_place_seats_in_a_held_venue
--
-- WHAT THIS CHANGES: recreates phoenix_crm_insert_place with ONE refusal removed — a venue whose status is
--   'held' no longer raises phoenix_crm:shared_place_held. Everything else is byte-identical to
--   20261010190001 (comment-stripped md5 5ef27c3f9802e24f1ca94245847c38ad, read off production
--   2026-10-14 before this file was written): the venue lock, shared_place_not_found / _retired,
--   already_seated, the board reuse and the AM/PM seating session.
-- WHY: a venue is held when its signboard photo did not confirm its own name. Nothing releases it but the
--   Super Admin, so a rep could not seat a single customer in a building he had just captured, and Save
--   answered "Choose the polyclinic or centre this customer receives in." (7 venues held on production,
--   none ever decided, oldest from 2026-10-13 14:15 Cairo). The owner ruled the rep may choose it anyway.
-- NOT CHANGED: phoenix_crm_seat_places_in_venue (the Super Admin's move) still refuses a held venue, and
--   phoenix_crm_decide_shared_place still retires every place seated in a venue he REJECTS.
-- ROLLBACK: re-run the create or replace function from 20261010190001 (puts the refusal back).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Rewrites no row; function body only.

begin;

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
  v_session text := nullif(trim(coalesce(p_place ->> 'session', '')), '');
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

  -- A seating is AM or PM (owner, 2026-10-10); a clinic of his own carries none and is read from the
  -- customer's list. A caller that names none (a build from before this) is seated in the customer's
  -- own list, which is what its visits counted in until now, so deploy and apply never have to be
  -- simultaneous.
  if v_shared is not null and v_session is null then
    select c.list_type into v_session from public.phoenix_crm_customers c where c.id = p_customer_id and c.list_type in ('AM', 'PM');
  end if;
  if v_shared is not null and (v_session is null or v_session not in ('AM', 'PM')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_shared is null then
    v_session := null;
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
    -- A HELD venue is seatable (owner, 2026-10-14: "make him able to choose him even if the system is
    -- still checking"). It used to raise shared_place_held here, and nothing released a held venue by
    -- itself, so a rep who captured a building could never add a customer to it. A REJECTION still
    -- retires every place seated in it (phoenix_crm_decide_shared_place), so nothing is stranded.
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
    shared_place_id, schedule_check, session
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
    case when jsonb_typeof(p_place -> 'schedule_check') = 'object' then p_place -> 'schedule_check' end,
    v_session
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$$;

revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;

commit;
