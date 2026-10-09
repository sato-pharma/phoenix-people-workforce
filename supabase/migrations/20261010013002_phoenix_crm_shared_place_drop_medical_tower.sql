-- Phoenix CRM — the medical tower is no longer a kind of shared place (owner, 2026-10-09, after the
-- rep-side walk-through: "remove medical tower option").
--
-- The venue kinds were four when the feature shipped an hour earlier (#5670). He read the chooser on
-- the rep's own screen and took one off, so the list is now THREE: polyclinic, medical centre,
-- hospital outpatient. A tower is captured as whichever of those three the sign on it says.
--
-- Nothing is being migrated: read on production immediately before this migration was written,
-- `phoenix_crm_shared_places` held 0 rows and 0 of them were towers, so narrowing the CHECK cannot
-- orphan a venue or a seated place. The guard inside `phoenix_crm_create_shared_place` carries the
-- same list and is re-created with it — leaving it wide would let the RPC accept a kind the table
-- then refuses with 23514 instead of the module's own `phoenix_crm:bad_input`.

alter table public.phoenix_crm_shared_places
  drop constraint if exists phoenix_crm_shared_places_kind_check;

alter table public.phoenix_crm_shared_places
  add constraint phoenix_crm_shared_places_kind_check
  check (kind in ('polyclinic', 'medical_centre', 'hospital_outpatient'));

create or replace function public.phoenix_crm_create_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_name text := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
  v_kind text := coalesce(p ->> 'kind', '');
  v_place jsonb := case when jsonb_typeof(p -> 'place') = 'object' then p -> 'place' end;
  v_hold jsonb := case when jsonb_typeof(p -> 'hold_review') = 'object' then p -> 'hold_review' end;
  v_sign jsonb := case when jsonb_typeof(p -> 'signboard_check') = 'object' then p -> 'signboard_check' end;
  v_source text;
  v_captured_at timestamptz;
  v_id uuid;
begin
  if v_seat is null or v_line is null or v_actor is null or v_name is null or v_place is null
    or v_kind not in ('polyclinic', 'medical_centre', 'hospital_outpatient')
    or nullif(trim(coalesce(v_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  v_source := coalesce(v_place ->> 'point_source', 'pin');
  if v_source not in ('photo', 'pin') then
    v_source := 'pin';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  -- The same slot discipline a place's photo goes through: the photo must be one this server issued
  -- to this person for this territory, and it dates the capture.
  v_captured_at := public.phoenix_crm_take_photo(v_place ->> 'photo_path', v_actor, v_seat, 'place', v_is_test);

  insert into public.phoenix_crm_shared_places (
    seat_id, line_code, name, kind, lat, lon, accuracy_meters,
    pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at,
    point_source, photo_path, captured_at, device_skew_minutes, address, zone,
    brick_id, brick_name, brick_distance_km, brick_lookup, area_code, area_name, region_code, region_name,
    signboard_check, status, created_by_hr_id, is_test
  )
  values (
    v_seat,
    v_line,
    left(v_name, 200),
    v_kind,
    (v_place ->> 'lat')::double precision,
    (v_place ->> 'lon')::double precision,
    (v_place ->> 'accuracy_meters')::numeric,
    coalesce((v_place ->> 'pin_lat')::double precision, (v_place ->> 'lat')::double precision),
    coalesce((v_place ->> 'pin_lon')::double precision, (v_place ->> 'lon')::double precision),
    coalesce((v_place ->> 'pin_accuracy_meters')::numeric, (v_place ->> 'accuracy_meters')::numeric),
    (v_place ->> 'photo_lat')::double precision,
    (v_place ->> 'photo_lon')::double precision,
    (v_place ->> 'photo_accuracy_meters')::numeric,
    nullif(v_place ->> 'photo_captured_at', '')::timestamptz,
    v_source,
    v_place ->> 'photo_path',
    v_captured_at,
    (v_place ->> 'device_skew_minutes')::integer,
    nullif(trim(coalesce(v_place ->> 'address', '')), ''),
    nullif(trim(coalesce(v_place ->> 'zone', '')), ''),
    nullif(trim(coalesce(v_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(v_place ->> 'brick_name', '')), ''),
    (v_place ->> 'brick_distance_km')::numeric,
    -- As on a place: the unknown value is the fallback, never a confident match.
    coalesce(nullif(trim(coalesce(v_place ->> 'brick_lookup', '')), ''), 'could_not_look'),
    nullif(trim(coalesce(v_place ->> 'area_code', '')), ''),
    nullif(trim(coalesce(v_place ->> 'area_name', '')), ''),
    nullif(trim(coalesce(v_place ->> 'region_code', '')), ''),
    nullif(trim(coalesce(v_place ->> 'region_name', '')), ''),
    coalesce(v_sign, v_hold),
    -- A sign that did not confirm the venue's own name holds it: it is saved, and nobody is seated in
    -- it until the Super Admin says so.
    case when v_hold is null then 'active' else 'held' end,
    v_actor,
    v_is_test
  )
  returning id into v_id;

  return jsonb_build_object(
    'shared_place_id', v_id,
    'captured_at', v_captured_at,
    'held', v_hold is not null
  );
end;
$$;

revoke execute on function public.phoenix_crm_create_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_create_shared_place(jsonb) to service_role;
