-- phoenix_crm_trusted_point_places
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_places.point_source accepts 'trusted' — a place the Super Admin validated on the point
--      the reps' own readings agree on (src/lib/phoenix-crm/trusted-point-rules.ts), with no photo.
--   2. phoenix_crm_places.photo_path is nullable, and a new CHECK keeps it required on every place except
--      one born on a trusted point (trusted_basis set).
--   3. New column phoenix_crm_places.trusted_basis jsonb — the evidence the point stands on (readings used
--      of the total, days, reps, spread, first and last day). A 'trusted' place must carry it.
--   4. The timings CHECK allows an EMPTY array on a trusted-point place only: the Super Admin does not know
--      the clinic's hours, and the rep adds them later through the usual hours editor.
--   5. New SECURITY DEFINER RPC public.phoenix_crm_place_on_trusted_point(p jsonb), service_role only.
--
--   phoenix_crm_photos_to_fingerprint needs no change: since 20261002215832 both of its branches already
--   require `photo_path is not null`, so a photo-less place is never a fingerprint candidate.
--
-- WHY (owner, Super Admin, 2026-11-10): "what administrator validates will be validated as follow: we will
--   search all locations for this customer in phx crm, then we will compare with the locations of checkins
--   of this customer from the old crm until we find a trusted point or trusted average location... based on
--   this location we will extract the brick, area and all what we need." A doctor with no signboard
--   (Dr Bahaa Kamal) can never be validated at the door, so he has no place and no visit of his is ever
--   measured. Account: docs/phoenix-crm-trusted-point.md.
--
--   🔴 The basis CHECK is ONE-WAY on purpose — `point_source = 'trusted'` implies a basis, not the reverse:
--   a trusted place the Super Admin later MOVES becomes point_source 'moved' (phoenix_crm_places_moved
--   requires it) and keeps its basis as the record, and its photo_path stays null. A two-way CHECK, or a
--   photo CHECK keyed on point_source, would make that move fail with a constraint error.
--
-- ROLLBACK (only while no trusted place exists — `select count(*) from phoenix_crm_places where
--   trusted_basis is not null` must be 0, else retire/delete those first):
--     drop function if exists public.phoenix_crm_place_on_trusted_point(jsonb);
--     alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_photo_or_trusted;
--     alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_trusted_basis;
--     alter table public.phoenix_crm_places drop constraint phoenix_crm_places_timings;
--     alter table public.phoenix_crm_places add constraint phoenix_crm_places_timings check (jsonb_typeof(timings) = 'array' and jsonb_array_length(timings) between 1 and 60);
--     alter table public.phoenix_crm_places drop constraint phoenix_crm_places_point_source;
--     alter table public.phoenix_crm_places add constraint phoenix_crm_places_point_source check (point_source in ('photo','pin','moved','shared_place'));
--     alter table public.phoenix_crm_places drop column trusted_basis;
--     alter table public.phoenix_crm_places alter column photo_path set not null;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it relaxes constraints, adds one nullable column and one function, and writes no row.

begin;
set local lock_timeout = '5s';

-- ── 1-4. The table ─────────────────────────────────────────────────────────────────────────────

alter table public.phoenix_crm_places add column if not exists trusted_basis jsonb;

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_point_source;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_point_source
  check (point_source in ('photo', 'pin', 'moved', 'shared_place', 'trusted'));

alter table public.phoenix_crm_places alter column photo_path drop not null;

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_photo_or_trusted;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_photo_or_trusted
  check (photo_path is not null or trusted_basis is not null);

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_trusted_basis;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_trusted_basis
  check (
    (point_source <> 'trusted' or trusted_basis is not null)
    and (trusted_basis is null or jsonb_typeof(trusted_basis) = 'object')
  );

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_timings;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_timings
  check (
    jsonb_typeof(timings) = 'array'
    and jsonb_array_length(timings) <= 60
    and (jsonb_array_length(timings) >= 1 or trusted_basis is not null)
  );

-- ── 5. The Super Admin validates a customer on a trusted point ─────────────────────────────────
--
-- The server (src/lib/phoenix-crm/server/trusted-point.ts) gathers the readings, runs the rule and resolves
-- the brick, area and region with the same resolver every captured place uses; this function only writes,
-- under the seat's lock, after re-checking every guard. It never takes a photo slot.
create or replace function public.phoenix_crm_place_on_trusted_point(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := nullif(trim(coalesce(p ->> 'actor_hr_id', '')), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_loc jsonb := p -> 'location';
  v_basis jsonb := p -> 'basis';
  v_customer public.phoenix_crm_customers%rowtype;
  v_place_id uuid;
  v_event text;
  v_was text;
begin
  if v_seat is null or v_actor is null or p ->> 'customer_id' is null
    or jsonb_typeof(v_loc) is distinct from 'object'
    or jsonb_typeof(v_basis) is distinct from 'object'
    or (v_loc ->> 'lat') is null or (v_loc ->> 'lon') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = (p ->> 'customer_id')::uuid
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:archived';
  end if;
  if v_customer.status not in ('pending', 'active') then
    raise exception 'phoenix_crm:not_on_list';
  end if;
  -- A pharmacy is never validated; a place belongs to an AM or PM customer.
  if v_customer.list_type not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if exists (
    select 1 from public.phoenix_crm_places pl
    where pl.customer_id = v_customer.id and pl.status = 'active'
  ) then
    raise exception 'phoenix_crm:already_has_place';
  end if;
  if exists (
    select 1 from public.phoenix_crm_validation_reviews r
    where r.customer_id = v_customer.id and r.status = 'pending'
  ) then
    raise exception 'phoenix_crm:location_in_review';
  end if;

  insert into public.phoenix_crm_places (
    customer_id, seat_id, lat, lon, accuracy_meters, timings, photo_path, captured_at, created_by_hr_id, is_test,
    point_source, trusted_basis, address, zone, brick_lookup, brick_id, brick_name, brick_distance_km,
    area_code, area_name, region_code, region_name
  )
  values (
    v_customer.id,
    v_seat,
    (v_loc ->> 'lat')::double precision,
    (v_loc ->> 'lon')::double precision,
    nullif(v_loc ->> 'accuracy_meters', '')::numeric,
    '[]'::jsonb,
    null,
    now(),
    v_actor,
    v_is_test,
    'trusted',
    v_basis,
    left(nullif(v_loc ->> 'address', ''), 200),
    left(nullif(v_loc ->> 'zone', ''), 80),
    coalesce(nullif(v_loc ->> 'brick_lookup', ''), 'could_not_look'),
    nullif(v_loc ->> 'brick_id', ''),
    nullif(v_loc ->> 'brick_name', ''),
    nullif(v_loc ->> 'brick_distance_km', '')::numeric,
    nullif(v_loc ->> 'area_code', ''),
    nullif(v_loc ->> 'area_name', ''),
    nullif(v_loc ->> 'region_code', ''),
    nullif(v_loc ->> 'region_name', '')
  )
  returning id into v_place_id;

  v_was := v_customer.status;
  if v_customer.status = 'pending' then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_actor,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    v_event := 'customer_validated';
  else
    -- Already active (validated by hand before this existed): left validated as he is; the place is added.
    v_event := 'place_added';
  end if;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, v_place_id, v_event, v_actor,
    jsonb_build_object('mode', 'trusted_point', 'basis', v_basis, 'was', v_was),
    v_is_test
  );

  return jsonb_build_object(
    'place_id', v_place_id,
    'customer_id', v_customer.id,
    'status', 'active',
    'event', v_event
  );
end;
$$;

-- Revoking from `public` also strips service_role, which is a member of it, so the grant that follows is
-- mandatory rather than decorative.
revoke execute on function public.phoenix_crm_place_on_trusted_point(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_place_on_trusted_point(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
