-- phoenix_crm_pharmacy_pin_and_phone
--
-- WHAT THIS CHANGES (owner, 2026-10-09: "visiting pharmacy or adding a new pharmacy — make it
-- optional to add its location by a pin button … optional if you want to save its location, do this;
-- if you want, also don't do this. And also make optional to add the responsible person's phone
-- number. And of course, when he captured the location, the location is then cleaned and separated
-- into area, brick, governorate"):
--
--   1. Thirteen nullable `pharmacy_pin_*` columns on phoenix_crm_customers — the pharmacy's own
--      location as the rep pinned it, plus the geography resolved FROM that pin: the clean address,
--      the governorate, the Phoenix area and the Phoenix brick. Every one of them optional, and a
--      pharmacy with none of them behaves exactly as it does today.
--   2. phoenix_crm_add_pharmacy takes an optional `phone` and an optional `pin` — written in the SAME
--      save as the name, never a second step that could fail after the first one landed. A pharmacy
--      already on his list is still returned rather than inserted twice, and what he captured fills
--      ONLY the fields that are empty on it: a pin or a phone already on file is never overwritten by
--      an add he meant as an add.
--   3. phoenix_crm_set_pharmacy_details(p jsonb) — new. The pin and the phone on a pharmacy already on
--      his list: absent means leave it, null means clear it. This is the correction path, and the one
--      the Pharmacy visit screen and the pharmacy's own page call.
--
-- WHY THE GEOGRAPHY IS NOT COMPUTED HERE: the brick index lives in the Source-of-Sales masters and
-- the clean address comes from a reverse geocode — both outside this module's reach (Phoenix CRM reads
-- its own tables, the organogram, people and products; anything else is delegated to src/lib/crm).
-- The caller resolves the pin through the SAME function a doctor's place uses (resolvePinGeography in
-- src/lib/phoenix-crm/server/list.ts), so a pharmacy and a clinic can never disagree about which brick
-- a point falls in. These columns therefore store a RESOLVED result and never anything the phone typed.
--
--   🔴 THE PIN IS A RECORD, NOT A CHECK. A pharmacy needs no validation (owner, 2026-10-03) and
--   nothing here changes that: no visit is measured against this pin, no visit is flagged far from it,
--   no approval waits on it, and no KPI reads it. It exists so the pharmacy can be found again and so
--   its area, brick and governorate are known.
--
-- EXPAND-ONLY: thirteen nullable columns with their own checks, one function replaced with the same
-- signature and every existing behaviour kept (a body with no `phone` and no `pin` key does exactly
-- what it did), and one new function.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_set_pharmacy_details(jsonb);
--   re-apply phoenix_crm_add_pharmacy from 20261003211501_phoenix_crm_add_pharmacy.sql;
--   alter table public.phoenix_crm_customers
--     drop column pharmacy_pin_lat, drop column pharmacy_pin_lon, drop column pharmacy_pin_accuracy_meters,
--     drop column pharmacy_pin_captured_at, drop column pharmacy_pin_captured_by_hr_id,
--     drop column pharmacy_pin_address, drop column pharmacy_pin_governorate,
--     drop column pharmacy_pin_area_code, drop column pharmacy_pin_area_name,
--     drop column pharmacy_pin_brick_id, drop column pharmacy_pin_brick_name,
--     drop column pharmacy_pin_brick_distance_km, drop column pharmacy_pin_brick_lookup;
--   -- SAFE: drops only the pharmacy locations the reps pinned. Nothing else reads them.
--   🔴 A COLUMN DROP IS TWO DEPLOYS, NEVER ONE (AGENTS.md §2.1, Migrations): ship the build that stops
--   naming these columns FIRST, because PostgREST answers a missing column by failing the WHOLE read.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This adds columns and functions and writes no rows.

begin;
set local lock_timeout = '5s';

-- ── 1. The pharmacy's pin, and the geography resolved from it ───────────────────────────────────────
alter table public.phoenix_crm_customers
  add column if not exists pharmacy_pin_lat double precision,
  add column if not exists pharmacy_pin_lon double precision,
  add column if not exists pharmacy_pin_accuracy_meters numeric,
  add column if not exists pharmacy_pin_captured_at timestamptz,
  add column if not exists pharmacy_pin_captured_by_hr_id text,
  add column if not exists pharmacy_pin_address text,
  add column if not exists pharmacy_pin_governorate text,
  add column if not exists pharmacy_pin_area_code text,
  add column if not exists pharmacy_pin_area_name text,
  add column if not exists pharmacy_pin_brick_id text,
  add column if not exists pharmacy_pin_brick_name text,
  add column if not exists pharmacy_pin_brick_distance_km numeric,
  add column if not exists pharmacy_pin_brick_lookup text;

-- `add constraint if not exists` does not exist, so each one is guarded by name.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_customers_pharmacy_pin_pair') then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_pharmacy_pin_pair
      check ((pharmacy_pin_lat is null) = (pharmacy_pin_lon is null));
  end if;
  -- A pin belongs to a PHARMACY. A doctor's or an account's location is a validated place with a
  -- signboard photo and two readings (phoenix_crm_places) — never this column, which asks for neither.
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_customers_pharmacy_pin_is_a_pharmacy') then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_pharmacy_pin_is_a_pharmacy
      check (pharmacy_pin_lat is null or list_type = 'Pharmacy');
  end if;
  -- The three answers the brick lookup can give. "could_not_look" is NOT "none_nearby": the first says
  -- the brick master could not be read, the second that the pin is nowhere near a Phoenix brick, and a
  -- reader that collapses them reports a pharmacy outside the territory when nobody actually looked.
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_customers_pharmacy_pin_brick_lookup') then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_pharmacy_pin_brick_lookup
      check (pharmacy_pin_brick_lookup is null or pharmacy_pin_brick_lookup in ('matched', 'none_nearby', 'could_not_look'));
  end if;
end;
$$;

comment on column public.phoenix_crm_customers.pharmacy_pin_lat is
  'The pharmacy''s own location as the rep pinned it (owner, 2026-10-09). Optional, pharmacies only. A RECORD, never a check: no visit is measured against it and no KPI reads it.';
comment on column public.phoenix_crm_customers.pharmacy_pin_governorate is
  'The governorate the pin falls in, from the reverse geocode. Null when the lookup could not be made — never guessed from the brick.';
comment on column public.phoenix_crm_customers.pharmacy_pin_brick_lookup is
  'matched | none_nearby | could_not_look — whether a brick was found, no brick was near, or the brick master could not be read.';

-- ── 2. Adding a pharmacy, now with its location and its responsible person''s phone ─────────────────
-- Unchanged but for the phone and the pin: same signature, same lock, same match, same answer.
create or replace function public.phoenix_crm_add_pharmacy(p jsonb)
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
  v_name text := nullif(btrim(regexp_replace(coalesce(p ->> 'name', ''), '\s+', ' ', 'g')), '');
  v_from text := coalesce(p ->> 'from', 'list');
  -- Both optional. Spaces are dropped from the phone here too, so the check reads what the rep meant.
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
  v_pin jsonb := case when jsonb_typeof(p -> 'pin') = 'object' then p -> 'pin' else null end;
  v_existing public.phoenix_crm_customers;
  v_added public.phoenix_crm_customers;
begin
  if v_seat is null or v_line is null or v_actor is null or v_name is null
    or char_length(v_name) > 120
    or v_from not in ('list', 'visit') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phoenix_crm:bad_phone';
  end if;
  if v_pin is not null and (v_pin -> 'lat') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- One add at a time per territory, so the check below and the insert after it cannot interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm_add_pharmacy|' || v_seat || '|' || v_is_test::text));

  select c.* into v_existing
  from public.phoenix_crm_customers c
  where c.seat_id = v_seat
    and c.is_test = v_is_test
    and c.list_type = 'Pharmacy'
    and c.status in ('active', 'pending', 'outside')
    and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(v_name)
  order by (c.status = 'active') desc, c.id
  limit 1;

  if v_existing.id is not null then
    -- It is already his. What he captured fills only what is EMPTY: he meant to add a pharmacy, not to
    -- replace a location or a phone somebody (perhaps he) already recorded for it. Correcting one is a
    -- deliberate act, and that is phoenix_crm_set_pharmacy_details.
    if (v_phone is not null and v_existing.phone is null) or (v_pin is not null and v_existing.pharmacy_pin_lat is null) then
      update public.phoenix_crm_customers c
      set phone = case when v_phone is not null and c.phone is null then v_phone else c.phone end,
          pharmacy_pin_lat = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'lat')::double precision else c.pharmacy_pin_lat end,
          pharmacy_pin_lon = case when v_pin is not null and c.pharmacy_pin_lon is null then (v_pin ->> 'lon')::double precision else c.pharmacy_pin_lon end,
          pharmacy_pin_accuracy_meters = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'accuracy_meters')::numeric else c.pharmacy_pin_accuracy_meters end,
          pharmacy_pin_captured_at = case when v_pin is not null and c.pharmacy_pin_lat is null then coalesce((v_pin ->> 'captured_at')::timestamptz, now()) else c.pharmacy_pin_captured_at end,
          pharmacy_pin_captured_by_hr_id = case when v_pin is not null and c.pharmacy_pin_lat is null then v_actor else c.pharmacy_pin_captured_by_hr_id end,
          pharmacy_pin_address = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'address', 400) else c.pharmacy_pin_address end,
          pharmacy_pin_governorate = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'governorate', 120) else c.pharmacy_pin_governorate end,
          pharmacy_pin_area_code = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'area_code', 40) else c.pharmacy_pin_area_code end,
          pharmacy_pin_area_name = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'area_name', 120) else c.pharmacy_pin_area_name end,
          pharmacy_pin_brick_id = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'brick_id', 40) else c.pharmacy_pin_brick_id end,
          pharmacy_pin_brick_name = case when v_pin is not null and c.pharmacy_pin_lat is null then left(v_pin ->> 'brick_name', 120) else c.pharmacy_pin_brick_name end,
          pharmacy_pin_brick_distance_km = case when v_pin is not null and c.pharmacy_pin_lat is null then (v_pin ->> 'brick_distance_km')::numeric else c.pharmacy_pin_brick_distance_km end,
          pharmacy_pin_brick_lookup = case when v_pin is not null and c.pharmacy_pin_lat is null then v_pin ->> 'brick_lookup' else c.pharmacy_pin_brick_lookup end,
          updated_at = now()
      where c.id = v_existing.id
      returning c.* into v_existing;
    end if;
    return jsonb_build_object('customer_id', v_existing.id, 'customer_name', v_existing.name, 'created', false);
  end if;

  insert into public.phoenix_crm_customers (
    seat_id, line_code, list_type, name, origin, status, created_by_hr_id, is_test, intake_note, phone,
    pharmacy_pin_lat, pharmacy_pin_lon, pharmacy_pin_accuracy_meters, pharmacy_pin_captured_at,
    pharmacy_pin_captured_by_hr_id, pharmacy_pin_address, pharmacy_pin_governorate,
    pharmacy_pin_area_code, pharmacy_pin_area_name, pharmacy_pin_brick_id, pharmacy_pin_brick_name,
    pharmacy_pin_brick_distance_km, pharmacy_pin_brick_lookup
  )
  values (
    v_seat, v_line, 'Pharmacy', v_name, 'new', 'pending', v_actor, v_is_test,
    case when v_from = 'visit' then 'Added by the rep on Pharmacy visit.' else 'Added by the rep on the List.' end,
    v_phone,
    (v_pin ->> 'lat')::double precision,
    (v_pin ->> 'lon')::double precision,
    (v_pin ->> 'accuracy_meters')::numeric,
    case when v_pin is null then null else coalesce((v_pin ->> 'captured_at')::timestamptz, now()) end,
    case when v_pin is null then null else v_actor end,
    left(v_pin ->> 'address', 400),
    left(v_pin ->> 'governorate', 120),
    left(v_pin ->> 'area_code', 40),
    left(v_pin ->> 'area_name', 120),
    left(v_pin ->> 'brick_id', 40),
    left(v_pin ->> 'brick_name', 120),
    (v_pin ->> 'brick_distance_km')::numeric,
    v_pin ->> 'brick_lookup'
  )
  returning * into v_added;

  return jsonb_build_object('customer_id', v_added.id, 'customer_name', v_added.name, 'created', true);
end;
$$;

revoke execute on function public.phoenix_crm_add_pharmacy(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_add_pharmacy(jsonb) to service_role;

-- ── 3. The pharmacy's location and phone, set or corrected on a pharmacy already on his list ────────
create or replace function public.phoenix_crm_set_pharmacy_details(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  -- Present, even as null, means "set it"; absent means "leave it" — the same contract as the phone on
  -- "Change the details", so a caller one release behind changes nothing it did not name.
  v_sets_phone boolean := (p -> 'phone') is not null;
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
  v_sets_pin boolean := (p -> 'pin') is not null;
  v_pin jsonb := case when jsonb_typeof(p -> 'pin') = 'object' then p -> 'pin' else null end;
  v_customer public.phoenix_crm_customers%rowtype;
  v_before jsonb;
begin
  if v_seat is null or v_actor is null or v_customer_id is null or not (v_sets_phone or v_sets_pin) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phoenix_crm:bad_phone';
  end if;
  if v_sets_pin and v_pin is not null and (v_pin -> 'lat') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.list_type is distinct from 'Pharmacy' then
    raise exception 'phoenix_crm:not_a_pharmacy';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;

  v_before := jsonb_build_object(
    'phone', v_customer.phone,
    'pin_lat', v_customer.pharmacy_pin_lat,
    'pin_lon', v_customer.pharmacy_pin_lon,
    'governorate', v_customer.pharmacy_pin_governorate,
    'area_name', v_customer.pharmacy_pin_area_name,
    'brick_name', v_customer.pharmacy_pin_brick_name
  );

  update public.phoenix_crm_customers c
  set phone = case when v_sets_phone then v_phone else c.phone end,
      pharmacy_pin_lat = case when v_sets_pin then (v_pin ->> 'lat')::double precision else c.pharmacy_pin_lat end,
      pharmacy_pin_lon = case when v_sets_pin then (v_pin ->> 'lon')::double precision else c.pharmacy_pin_lon end,
      pharmacy_pin_accuracy_meters = case when v_sets_pin then (v_pin ->> 'accuracy_meters')::numeric else c.pharmacy_pin_accuracy_meters end,
      pharmacy_pin_captured_at = case
        when not v_sets_pin then c.pharmacy_pin_captured_at
        when v_pin is null then null
        else coalesce((v_pin ->> 'captured_at')::timestamptz, now())
      end,
      pharmacy_pin_captured_by_hr_id = case
        when not v_sets_pin then c.pharmacy_pin_captured_by_hr_id
        when v_pin is null then null
        else v_actor
      end,
      pharmacy_pin_address = case when v_sets_pin then left(v_pin ->> 'address', 400) else c.pharmacy_pin_address end,
      pharmacy_pin_governorate = case when v_sets_pin then left(v_pin ->> 'governorate', 120) else c.pharmacy_pin_governorate end,
      pharmacy_pin_area_code = case when v_sets_pin then left(v_pin ->> 'area_code', 40) else c.pharmacy_pin_area_code end,
      pharmacy_pin_area_name = case when v_sets_pin then left(v_pin ->> 'area_name', 120) else c.pharmacy_pin_area_name end,
      pharmacy_pin_brick_id = case when v_sets_pin then left(v_pin ->> 'brick_id', 40) else c.pharmacy_pin_brick_id end,
      pharmacy_pin_brick_name = case when v_sets_pin then left(v_pin ->> 'brick_name', 120) else c.pharmacy_pin_brick_name end,
      pharmacy_pin_brick_distance_km = case when v_sets_pin then (v_pin ->> 'brick_distance_km')::numeric else c.pharmacy_pin_brick_distance_km end,
      pharmacy_pin_brick_lookup = case when v_sets_pin then v_pin ->> 'brick_lookup' else c.pharmacy_pin_brick_lookup end,
      updated_at = now()
  where c.id = v_customer.id
  returning c.* into v_customer;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, 'pharmacy_details_set', v_actor,
    jsonb_build_object(
      'from', v_before,
      'to', jsonb_build_object(
        'phone', v_customer.phone,
        'pin_lat', v_customer.pharmacy_pin_lat,
        'pin_lon', v_customer.pharmacy_pin_lon,
        'governorate', v_customer.pharmacy_pin_governorate,
        'area_name', v_customer.pharmacy_pin_area_name,
        'brick_name', v_customer.pharmacy_pin_brick_name
      )
    ),
    v_is_test
  );

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'phone', v_customer.phone,
    'pinned', v_customer.pharmacy_pin_lat is not null
  );
end;
$$;

revoke execute on function public.phoenix_crm_set_pharmacy_details(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_set_pharmacy_details(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
