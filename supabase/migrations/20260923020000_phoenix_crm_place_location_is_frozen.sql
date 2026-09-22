-- Phoenix CRM — a place's location is resolved at capture, separated into its parts, and never edited.
--
-- Owner, 2026-09-23: "the capture location is never editable and its separated when captured to brick
-- area region clean addresss and raw location".
--
-- Before this, the phone sent `address`, `zone` and `brick_name` and both functions wrote whatever it
-- sent. The capture screen seeded the address box from the location and then invited the rep to
-- "Correct it if it is wrong", and `phoenix_crm_update_place` let an edit rewrite the address, the
-- part of town and the brick weeks later. So the record of WHERE a customer is could drift away from
-- where the photo was actually taken — the one thing a validation exists to prove.
--
-- The five parts, each written once, at capture:
--
--   * raw location — `lat`, `lon`, `accuracy_meters`, `captured_at`, `device_skew_minutes` (already
--     here, unchanged: the coordinates the camera reported);
--   * clean address — `address`, now Google's formatted address for those coordinates, resolved on
--     the server through the same lookup that burns the address into the photo, so the picture and
--     the row cannot disagree;
--   * brick — `brick_id` / `brick_name`, the nearest brick centroid to the point, with
--     `brick_distance_km` beside it: a brick further than the server's trust radius is left unnamed,
--     and the distance is stored either way because a wrong brick is visible in nothing else;
--   * area — `area_code` / `area_name`, and
--   * region — `region_code` / `region_name`, both that brick's, by code as well as name (a name is a
--     display string that changes spelling; territory is matched on codes).
--
-- `zone` stays, as the part of town the address named, and is now resolved with the address rather
-- than typed. `label` — the place's NAME, "Evening clinic" — is the one thing on a place the rep
-- still writes, and the one thing an edit still reaches, alongside the days and hours.
--
-- No backfill: `phoenix_crm_places` is empty (0 rows on production, 0 on staging — nobody has
-- validated a customer yet), so every row that will ever exist is written by the new path.

alter table public.phoenix_crm_places
  add column if not exists brick_distance_km numeric,
  add column if not exists area_code text,
  add column if not exists area_name text,
  add column if not exists region_code text,
  add column if not exists region_name text;

comment on column public.phoenix_crm_places.address is
  'Clean address: the map''s formatted address for the captured coordinates, resolved server-side at capture. Never typed, never edited (owner, 2026-09-23).';
comment on column public.phoenix_crm_places.zone is
  'Part of town, from the same lookup as the address. Never typed, never edited (owner, 2026-09-23).';
comment on column public.phoenix_crm_places.brick_distance_km is
  'Kilometres from the captured point to the named brick''s centre. A far match is how a wrong brick shows itself; it is null when no brick was near enough to name.';
comment on column public.phoenix_crm_places.area_code is 'Area of the brick the captured point fell in. Matched on the CODE; the name beside it is for display.';
comment on column public.phoenix_crm_places.region_code is 'Region of the brick the captured point fell in. Matched on the CODE; the name beside it is for display.';

-- ── The capture writes the whole location ────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_insert_place(
  p_customer_id uuid,
  p_seat_id text,
  p_actor_hr_id text,
  p_is_test boolean,
  p_place jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_captured_at timestamptz;
  v_place_id uuid;
begin
  if jsonb_typeof(p_place) is distinct from 'object'
    or jsonb_typeof(p_place -> 'timings') is distinct from 'array'
    or nullif(trim(coalesce(p_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  v_captured_at := public.phoenix_crm_take_photo(p_place ->> 'photo_path', p_actor_hr_id, p_seat_id, 'place', p_is_test);

  -- Every location column here is the SERVER's own resolution of the coordinates (server/list.ts
  -- placePayload), not anything the phone typed: the phone no longer sends an address, a zone or a
  -- brick at all.
  insert into public.phoenix_crm_places (
    customer_id, seat_id, label, address, brick_id, brick_name, brick_distance_km,
    area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters,
    timings, photo_path, captured_at, device_skew_minutes, created_by_hr_id, is_test
  )
  values (
    p_customer_id,
    p_seat_id,
    nullif(trim(coalesce(p_place ->> 'label', '')), ''),
    nullif(trim(coalesce(p_place ->> 'address', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_name', '')), ''),
    (p_place ->> 'brick_distance_km')::numeric,
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
    p_is_test
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$$;

-- ── An edit reaches the name and the hours, and nothing that says where the place is ─────────────

create or replace function public.phoenix_crm_update_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_action text := coalesce(p ->> 'action', '');
  v_place public.phoenix_crm_places%rowtype;
  v_after public.phoenix_crm_places%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'place_id', '') is null or v_action not in ('edit', 'retire') then
    raise exception 'phoenix_crm:bad_input';
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

  if v_action = 'edit' then
    if jsonb_typeof(p -> 'timings') is distinct from 'array' or jsonb_array_length(p -> 'timings') = 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    -- The `set` list is the whole guarantee. `address`, `zone`, `brick_id`, `brick_name`,
    -- `brick_distance_km`, `area_*` and `region_*` are absent on purpose: a caller may send them and
    -- they are ignored, because the location belongs to the capture (owner, 2026-09-23). This is the
    -- same shape the photo and the coordinates have always had, extended to the rest of the location.
    update public.phoenix_crm_places pl
    set timings = p -> 'timings',
        label = nullif(trim(coalesce(p ->> 'label', '')), ''),
        updated_at = now()
    where pl.id = v_place.id
    returning pl.* into v_after;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_place.customer_id, v_place.id, 'place_updated', v_actor,
      jsonb_build_object(
        'before', jsonb_build_object('timings', v_place.timings, 'label', v_place.label),
        'after', jsonb_build_object('timings', v_after.timings, 'label', v_after.label)
      ),
      v_is_test
    );
  else
    if not exists (
      select 1
      from public.phoenix_crm_places pl
      where pl.customer_id = v_place.customer_id
        and pl.status = 'active'
        and pl.id <> v_place.id
    ) then
      raise exception 'phoenix_crm:last_place';
    end if;
    update public.phoenix_crm_places pl
    set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
    where pl.id = v_place.id;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_place.customer_id, v_place.id, 'place_retired', v_actor, '{}'::jsonb, v_is_test);
  end if;

  return jsonb_build_object('place_id', v_place.id, 'customer_id', v_place.customer_id);
end;
$$;

-- `create or replace` keeps each existing ACL. Restated because `revoke ... from anon, authenticated`
-- WITHOUT `public` is the silent no-op this repo's secdef guard exists to catch: both roles inherit
-- EXECUTE through PUBLIC. Revoking PUBLIC on a default ACL also strips service_role, so each grant is
-- not optional.
revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;
revoke execute on function public.phoenix_crm_update_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_update_place(jsonb) to service_role;

notify pgrst, 'reload schema';
