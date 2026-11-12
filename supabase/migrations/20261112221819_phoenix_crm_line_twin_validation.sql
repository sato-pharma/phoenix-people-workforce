-- phoenix_crm_line_twin_validation
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_places.point_source accepts 'line_twin' — a COPY of a place another line validated for
--      the same doctor (src/lib/phoenix-crm/line-twins.ts). A copy has no photo and must carry its
--      trusted_basis (kind 'line_twin', the source place, customer, seat, line and validation).
--   2. New SECURITY DEFINER RPC public.phoenix_crm_share_line_validation(p jsonb), service_role only: under
--      the waiting row's seat lock, re-checks every guard, copies the source places onto it and validates
--      it. Any guard that no longer holds returns {skipped: <why>} rather than raising, so one race never
--      stops a batch.
--   3. New trigger phoenix_crm_places_line_twin_follow: a copy follows its source. When the source place is
--      retired its copies are retired, and a row left with no place goes back to waiting; when the source
--      moves, its copies move with it.
--   4. New partial index on the copy's source place id, which the trigger reads on every place update.
--
-- WHY (owner, Super Admin, 2026-11-12): "Between all the three lines … if it is one place in the three or
--   one customer, then and it is validated, make in the three lines validation." Then: "You will compare
--   only in the Phoenix validated customers", and of a waiting row joining AND validated twins sharing one
--   point, "Both". Today a rep's third visit to his own unvalidated row of a doctor another line validated
--   is refused. Account: docs/phoenix-crm-line-twins.md.
--
-- ROLLBACK (only while no copy exists — `select count(*) from phoenix_crm_places where point_source =
--   'line_twin'` must be 0, else retire those first and send their customers back to waiting):
--     drop trigger if exists phoenix_crm_places_line_twin_follow on public.phoenix_crm_places;
--     drop function if exists public.phoenix_crm_places_line_twin_follow();
--     drop function if exists public.phoenix_crm_share_line_validation(jsonb);
--     drop index if exists public.phoenix_crm_places_line_twin_source_idx;
--     alter table public.phoenix_crm_places drop constraint phoenix_crm_places_trusted_basis;
--     alter table public.phoenix_crm_places add constraint phoenix_crm_places_trusted_basis check (((point_source <> 'trusted') or (trusted_basis is not null)) and ((trusted_basis is null) or (jsonb_typeof(trusted_basis) = 'object')));
--     alter table public.phoenix_crm_places drop constraint phoenix_crm_places_point_source;
--     alter table public.phoenix_crm_places add constraint phoenix_crm_places_point_source check (point_source in ('photo', 'pin', 'moved', 'shared_place', 'trusted'));
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it widens one CHECK, adds a function, a trigger and an index, and writes no row. The
-- rows are written later by scripts/phoenix-crm-line-twins.ts --apply, announced first.

begin;
set local lock_timeout = '5s';

-- ── 1. The table ───────────────────────────────────────────────────────────────────────────────

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_point_source;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_point_source
  check (point_source in ('photo', 'pin', 'moved', 'shared_place', 'trusted', 'line_twin'));

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_trusted_basis;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_trusted_basis
  check (
    (point_source not in ('trusted', 'line_twin') or trusted_basis is not null)
    and (trusted_basis is null or jsonb_typeof(trusted_basis) = 'object')
  );

create index if not exists phoenix_crm_places_line_twin_source_idx
  on public.phoenix_crm_places ((trusted_basis ->> 'source_place_id'))
  where point_source = 'line_twin';

-- ── 2. A waiting row takes another line's validation ───────────────────────────────────────────
--
-- The server (src/lib/phoenix-crm/server/line-twins.ts) decides WHICH row is the same doctor and which
-- source places to copy (the pure rule in line-twins.ts); this function only writes, under the target
-- seat's lock, after re-checking that the row is still waiting and every source is still a Phoenix
-- validation of the same list on another line. It never takes a photo slot.
create or replace function public.phoenix_crm_share_line_validation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_ids jsonb := p -> 'source_place_ids';
  v_customer public.phoenix_crm_customers%rowtype;
  v_source record;
  v_place_id uuid;
  v_place_ids uuid[] := '{}';
  v_source_customers uuid[] := '{}';
  v_validated_by text := upper(nullif(trim(coalesce(p ->> 'validated_by_hr_id', '')), ''));
  v_wanted int;
  v_found int;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'customer_id', '') is null
    or jsonb_typeof(v_ids) is distinct from 'array'
    or jsonb_array_length(v_ids) not between 1 and 5 then
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
  if v_customer.list_type not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_customer.status <> 'pending' or v_customer.validated_at is not null then
    return jsonb_build_object('skipped', 'not_waiting', 'customer_id', v_customer.id);
  end if;
  if exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active') then
    return jsonb_build_object('skipped', 'has_place', 'customer_id', v_customer.id);
  end if;
  if exists (select 1 from public.phoenix_crm_validation_reviews r where r.customer_id = v_customer.id and r.status = 'pending') then
    return jsonb_build_object('skipped', 'in_review', 'customer_id', v_customer.id);
  end if;
  if exists (
    select 1 from public.phoenix_crm_list_requests q
    where q.seat_id = v_seat
      and q.is_test = v_is_test
      and q.kind = 'drop'
      and q.status = 'pending'
      and (
        q.customer_id = v_customer.id
        or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
      )
  ) then
    return jsonb_build_object('skipped', 'drop_requested', 'customer_id', v_customer.id);
  end if;
  if v_customer.full_name_held is not null then
    return jsonb_build_object('skipped', 'full_name_held', 'customer_id', v_customer.id);
  end if;

  -- Every source must still be an own place of a Phoenix validation of the same list, on another seat and line.
  v_wanted := (select count(distinct e) from jsonb_array_elements_text(v_ids) e);
  select count(*) into v_found
  from public.phoenix_crm_places pl
  join public.phoenix_crm_customers sc on sc.id = pl.customer_id
  where pl.id in (select e::uuid from jsonb_array_elements_text(v_ids) e)
    and pl.status = 'active'
    and pl.point_source <> 'line_twin'
    and pl.is_test = v_is_test
    and pl.seat_id <> v_seat
    and sc.status = 'active'
    and sc.validated_at is not null
    and sc.list_type = v_customer.list_type
    and sc.is_test = v_is_test
    and sc.line_code is distinct from v_customer.line_code;
  if v_found <> v_wanted then
    return jsonb_build_object('skipped', 'source_gone', 'customer_id', v_customer.id);
  end if;

  for v_source in
    select pl.*, sc.line_code as source_line, sc.validated_at as source_validated_at, sc.validated_by_hr_id as source_validated_by, e.ord
    from jsonb_array_elements_text(v_ids) with ordinality as e(id, ord)
    join public.phoenix_crm_places pl on pl.id = e.id::uuid
    join public.phoenix_crm_customers sc on sc.id = pl.customer_id
    order by e.ord
  loop
    if not (v_source.customer_id = any (v_source_customers)) then
      v_source_customers := v_source_customers || v_source.customer_id;
    end if;
    v_validated_by := coalesce(v_validated_by, upper(v_source.source_validated_by));

    insert into public.phoenix_crm_places (
      customer_id, seat_id, label, address, brick_id, brick_name, zone, lat, lon, accuracy_meters, timings,
      photo_path, captured_at, created_by_hr_id, is_test, brick_distance_km, area_code, area_name, region_code,
      region_name, pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters,
      photo_captured_at, point_source, brick_lookup, session, trusted_basis
    )
    values (
      v_customer.id, v_seat, v_source.label, v_source.address, v_source.brick_id, v_source.brick_name, v_source.zone,
      v_source.lat, v_source.lon, v_source.accuracy_meters, v_source.timings,
      null, v_source.captured_at, v_actor, v_is_test, v_source.brick_distance_km, v_source.area_code, v_source.area_name,
      v_source.region_code, v_source.region_name,
      case when v_source.point_source in ('photo', 'pin') then v_source.pin_lat end,
      case when v_source.point_source in ('photo', 'pin') then v_source.pin_lon end,
      case when v_source.point_source in ('photo', 'pin') then v_source.pin_accuracy_meters end,
      v_source.photo_lat, v_source.photo_lon, v_source.photo_accuracy_meters, v_source.photo_captured_at,
      'line_twin', v_source.brick_lookup, v_source.session,
      jsonb_build_object(
        'kind', 'line_twin',
        'source_place_id', v_source.id,
        'source_customer_id', v_source.customer_id,
        'source_seat_id', v_source.seat_id,
        'source_line', v_source.source_line,
        'source_point_source', v_source.point_source,
        'source_validated_at', v_source.source_validated_at,
        'source_validated_by_hr_id', v_source.source_validated_by
      )
    )
    returning id into v_place_id;
    v_place_ids := v_place_ids || v_place_id;
  end loop;

  update public.phoenix_crm_customers c
  set status = 'active',
      validated_at = now(),
      validated_by_hr_id = coalesce(v_validated_by, v_actor),
      dropped_reason = null,
      dropped_note = null,
      status_changed_at = now(),
      updated_at = now()
  where c.id = v_customer.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, v_place_ids[1], 'customer_validated', v_actor,
    jsonb_build_object(
      'mode', 'line_twin',
      'place_ids', to_jsonb(v_place_ids),
      'source_place_ids', v_ids,
      'source_customer_ids', to_jsonb(v_source_customers),
      'validated_by_hr_id', coalesce(v_validated_by, v_actor),
      'reference_contact_crm_id', v_customer.reference_contact_crm_id
    ),
    v_is_test
  );

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'place_ids', to_jsonb(v_place_ids),
    'status', 'active',
    'event', 'customer_validated'
  );
end;
$$;

-- Revoking from `public` also strips service_role, which is a member of it, so the grant that follows is
-- mandatory rather than decorative.
revoke execute on function public.phoenix_crm_share_line_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_share_line_validation(jsonb) to service_role;

-- ── 3. A copy follows its source ───────────────────────────────────────────────────────────────
--
-- 🔴 A copy is never left pointing at a door its source no longer stands at. Retired source: the copies
-- are retired and a row left with no place goes back to waiting (never `reopened_at`: nobody refused
-- him). Moved source: the copies take the new point; the pin reading is cleared, as it was the source
-- rep's and no longer describes it. The server restamps the copies' visits after a move it makes.
create or replace function public.phoenix_crm_places_line_twin_follow()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_copy record;
begin
  if old.status = 'active' and new.status = 'retired' then
    for v_copy in
      update public.phoenix_crm_places pl
      set status = 'retired',
          retired_at = now(),
          retired_by_hr_id = 'SYSTEM',
          updated_at = now()
      where pl.point_source = 'line_twin'
        and pl.status = 'active'
        and (pl.trusted_basis ->> 'source_place_id') = new.id::text
      returning pl.id, pl.customer_id, pl.seat_id, pl.is_test
    loop
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (v_copy.seat_id, v_copy.customer_id, v_copy.id, 'place_retired', 'SYSTEM',
        jsonb_build_object('why', 'source_retired', 'source_place_id', new.id), v_copy.is_test);

      if not exists (select 1 from public.phoenix_crm_places pl where pl.customer_id = v_copy.customer_id and pl.status = 'active') then
        update public.phoenix_crm_customers c
        set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
        where c.id = v_copy.customer_id and c.status = 'active';
        if found then
          insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
          values (v_copy.seat_id, v_copy.customer_id, 'customer_pending', 'SYSTEM',
            jsonb_build_object('why', 'line_twin_source_retired', 'source_place_id', new.id), v_copy.is_test);
        end if;
      end if;
    end loop;
  elsif new.status = 'active' and (old.lat is distinct from new.lat or old.lon is distinct from new.lon) then
    update public.phoenix_crm_places pl
    set lat = new.lat,
        lon = new.lon,
        accuracy_meters = new.accuracy_meters,
        address = new.address,
        zone = new.zone,
        brick_id = new.brick_id,
        brick_name = new.brick_name,
        brick_distance_km = new.brick_distance_km,
        brick_lookup = new.brick_lookup,
        area_code = new.area_code,
        area_name = new.area_name,
        region_code = new.region_code,
        region_name = new.region_name,
        pin_lat = null,
        pin_lon = null,
        pin_accuracy_meters = null,
        trusted_basis = pl.trusted_basis || jsonb_build_object('source_point_source', new.point_source, 'followed_at', now()),
        updated_at = now()
    where pl.point_source = 'line_twin'
      and pl.status = 'active'
      and (pl.trusted_basis ->> 'source_place_id') = new.id::text;
  end if;
  return null;
end;
$$;

drop trigger if exists phoenix_crm_places_line_twin_follow on public.phoenix_crm_places;
create trigger phoenix_crm_places_line_twin_follow
  after update of status, lat, lon on public.phoenix_crm_places
  for each row
  when (old.point_source <> 'line_twin' and (old.status is distinct from new.status or old.lat is distinct from new.lat or old.lon is distinct from new.lon))
  execute function public.phoenix_crm_places_line_twin_follow();

notify pgrst, 'reload schema';

commit;
