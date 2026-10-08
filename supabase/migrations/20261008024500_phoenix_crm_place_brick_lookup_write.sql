-- phoenix_crm_place_brick_lookup_write
--
-- WHAT THIS CHANGES:
--   Two functions learn to carry `brick_lookup`, and nothing else moves in either of them:
--     1. phoenix_crm_insert_place — the ONE place-insert helper both phoenix_crm_validate_customer and
--        phoenix_crm_add_place call. One column added to its column list, one expression to its values.
--        Body taken from pg_proc.prosrc at md5 940a818739f18bfd6f771fdbab7738a9 (2,883 bytes).
--     2. phoenix_crm_move_place — one more column in its update, so a move re-states the brick lookup
--        instead of leaving the moved place describing the lookup done at its old coordinates.
--        Body taken from pg_proc.prosrc at md5 bef3bf5af1426def6f16d061346f3a9d (3,138 bytes).
--   No table change — `brick_lookup` itself, its CHECK, its default and its backfill all landed in
--   20261008023051. The ACLs restated below are exactly the ones both functions already carry.
--
-- WHY:
--   🔴 BECAUSE A COLUMN ADDED TO THE PAYLOAD WITHOUT THIS WOULD HAVE BEEN SILENTLY DROPPED, and every
--   new place would have read `could_not_look` for ever. `phoenix_crm_insert_place` names each place
--   column explicitly — it does not spread the jsonb — so `resolvePlaceLocation` returning
--   `brick_lookup` reaches the row only if this function asks for it. The failure would have been
--   invisible: the insert succeeds, the place is correct in every other respect, and the one column
--   added to make "nobody looked" visible would itself have said "nobody looked" about every place in
--   the system. That is the shape of defect `verify-the-emitted-artifact-never-the-source` names.
--
--   The default stays `could_not_look`, so the direction of the mistake is the safe one: a writer that
--   forgets this column can never leave a row claiming a confident brick match it never made.
--
--   `coalesce(..., 'could_not_look')` and not a bare cast: an older caller — a replayed body, a mobile
--   build, a hand-posted payload — sends no such key, and a null would violate the NOT NULL that
--   20261008023051 set. An old caller writing "nobody looked" is correct; an old caller failing is not.
--
-- ROLLBACK:
--   Restore both bodies from the md5s named above. There is no data to lose: dropping these two
--   statements only stops new rows carrying the value, and every existing value stays as written.
--   Nothing else in either function was touched, so a rollback is the two one-line removals.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- replaces two function bodies and rewrites not one row.

begin;
set local lock_timeout = '5s';

-- 1 ─ A new place records whether anybody looked for its brick ───────────────────────────────────

create or replace function public.phoenix_crm_insert_place(p_customer_id uuid, p_seat_id text, p_actor_hr_id text, p_is_test boolean, p_place jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_captured_at timestamptz;
  v_place_id uuid;
  v_source text := coalesce(p_place ->> 'point_source', 'pin');
begin
  if jsonb_typeof(p_place) is distinct from 'object'
    or jsonb_typeof(p_place -> 'timings') is distinct from 'array'
    or nullif(trim(coalesce(p_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A caller that names no source sent one reading, the pin, in lat/lon — exactly as before today.
  if v_source not in ('photo', 'pin') then
    v_source := 'pin';
  end if;

  v_captured_at := public.phoenix_crm_take_photo(p_place ->> 'photo_path', p_actor_hr_id, p_seat_id, 'place', p_is_test);

  -- Every location column here is the SERVER's own resolution of the fixed point (server/list.ts
  -- placePayload), not anything the phone typed. The two raw readings are kept beside it as evidence.
  insert into public.phoenix_crm_places (
    customer_id, seat_id, label, address, brick_id, brick_name, brick_distance_km, brick_lookup,
    area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters,
    timings, photo_path, captured_at, device_skew_minutes, created_by_hr_id, is_test,
    pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, point_source
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
    p_place ->> 'photo_path',
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
    v_source
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$function$;

revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;

-- 2 ─ A moved place re-states the lookup at its NEW coordinates ──────────────────────────────────

create or replace function public.phoenix_crm_move_place(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_to jsonb := p -> 'location';
  v_place public.phoenix_crm_places%rowtype;
  v_after public.phoenix_crm_places%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'place_id', '') is null
    or jsonb_typeof(v_to) is distinct from 'object'
    or (v_to ->> 'lat') is null or (v_to ->> 'lon') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:move_reason_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select pl.* into v_place
  from public.phoenix_crm_places pl
  where pl.id = (p ->> 'place_id')::uuid
    and pl.seat_id = v_seat
    and pl.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:place_not_found';
  end if;
  if v_place.status <> 'active' then
    raise exception 'phoenix_crm:place_retired';
  end if;

  update public.phoenix_crm_places pl
  set lat = (v_to ->> 'lat')::double precision,
      lon = (v_to ->> 'lon')::double precision,
      accuracy_meters = (v_to ->> 'accuracy_meters')::numeric,
      address = nullif(trim(coalesce(v_to ->> 'address', '')), ''),
      zone = nullif(trim(coalesce(v_to ->> 'zone', '')), ''),
      brick_id = nullif(trim(coalesce(v_to ->> 'brick_id', '')), ''),
      brick_name = nullif(trim(coalesce(v_to ->> 'brick_name', '')), ''),
      brick_distance_km = (v_to ->> 'brick_distance_km')::numeric,
      -- 2026-10-08 — the move re-resolves the location through the same resolvePlaceLocation, so the
      -- lookup is re-stated here too. Without this line a moved place would keep describing the
      -- lookup done at coordinates it no longer sits on.
      brick_lookup = coalesce(nullif(trim(coalesce(v_to ->> 'brick_lookup', '')), ''), 'could_not_look'),
      area_code = nullif(trim(coalesce(v_to ->> 'area_code', '')), ''),
      area_name = nullif(trim(coalesce(v_to ->> 'area_name', '')), ''),
      region_code = nullif(trim(coalesce(v_to ->> 'region_code', '')), ''),
      region_name = nullif(trim(coalesce(v_to ->> 'region_name', '')), ''),
      point_source = 'moved',
      moved_at = now(),
      moved_by_hr_id = v_actor,
      move_reason = v_reason,
      updated_at = now()
  where pl.id = v_place.id
  returning pl.* into v_after;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_place.customer_id, v_place.id, 'place_moved', v_actor,
    jsonb_build_object(
      'reason', v_reason,
      'before', jsonb_build_object(
        'lat', v_place.lat, 'lon', v_place.lon, 'point_source', v_place.point_source,
        'address', v_place.address, 'brick_id', v_place.brick_id, 'area_code', v_place.area_code
      ),
      'after', jsonb_build_object(
        'lat', v_after.lat, 'lon', v_after.lon,
        'address', v_after.address, 'brick_id', v_after.brick_id, 'area_code', v_after.area_code
      )
    ),
    v_is_test
  );

  return jsonb_build_object('place_id', v_after.id, 'customer_id', v_after.customer_id, 'moved_at', v_after.moved_at);
end;
$function$;

revoke execute on function public.phoenix_crm_move_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_move_place(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
