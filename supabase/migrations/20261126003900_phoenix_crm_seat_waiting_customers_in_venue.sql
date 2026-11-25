-- phoenix_crm_seat_waiting_customers_in_venue
--
-- WHAT THIS CHANGES: one new function, phoenix_crm_seat_waiting_customers_in_venue. The Super Admin
-- seats customers who are still WAITING to be validated — on the list, with their hours, but with no
-- place at all — inside an approved building, at the building's own point, exactly as the move into a
-- building (phoenix_crm_seat_places_in_venue) seats a clinic that already has one.
--
-- WHY: the owner, 26 Nov 2026, sending the Tuesday timetable of مستشفي الشروق on Nora Kamal's territory:
-- "We validate them with this timetable photo if it carries their name. If it carries their names,
-- then validate them." The four doctors on it were loaded the same morning as waiting customers. No
-- door could seat them: the move needs an existing place, the rep's own seating needs her within 300 m
-- of the building, and the admin-photo door needs the rep's live reading.
--
-- WHAT IT NEVER DOES: it never validates anybody. It only seats. The building's timetable is then read
-- for each of them by the server (settleVenueTimetable), and phoenix_crm_settle_venue_timetable
-- validates a customer ONLY where the board names him (`match`) and no person's review is waiting —
-- the same automatic validation the rep's own seating performs. A board that does not name him leaves
-- him waiting; an unreadable board (`unjudged`) decides nothing.
--
-- Its refusals, under the seat's lock and the building's row lock:
--   * the building is gone, removed, still waiting for the Super Admin, or has NO timetable on file
--     (phoenix_crm:shared_place_no_timetable — without a board there is nothing to validate him by);
--   * a customer is not on this seat, is a pharmacy, is not waiting (phoenix_crm:customer_not_waiting),
--     already has a place (phoenix_crm:customer_has_a_place — the move is the door for him), or has no
--     hours (phoenix_crm:customer_has_no_hours — a seated place carries at least one window).
--
-- ROLLBACK: drop function public.phoenix_crm_seat_waiting_customers_in_venue(jsonb);
--   (A place it already wrote stays. It reads exactly like a place seated by the move: point_source
--   'shared_place', the building's point and board, and a 'place_seated' list event naming the reason.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new function, no data touched.

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_seat_waiting_customers_in_venue(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_ids jsonb := case when jsonb_typeof(p -> 'customer_ids') = 'array' then p -> 'customer_ids' end;
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_cid uuid;
  v_place_id uuid;
  v_seated jsonb := '[]'::jsonb;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'shared_place_id', '') is null or v_ids is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_array_length(v_ids) = 0 then
    raise exception 'phoenix_crm:no_places_chosen';
  end if;
  -- The same ceiling as the move into a building: a hand-made list, not a business rule.
  if jsonb_array_length(v_ids) > 60 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:move_reason_required';
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
  if v_venue.status <> 'active' then
    raise exception 'phoenix_crm:shared_place_held';
  end if;
  -- 🔴 THE BOARD IS THE WHOLE EVIDENCE HERE. A waiting customer seated in a building with no timetable
  -- would be a place nobody photographed and nothing could ever validate.
  if v_venue.schedule_photo_path is null then
    raise exception 'phoenix_crm:shared_place_no_timetable';
  end if;

  for v_cid in select distinct (value #>> '{}')::uuid from jsonb_array_elements(v_ids)
  loop
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = v_cid
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.list_type not in ('AM', 'PM') then
      raise exception 'phoenix_crm:pharmacy_cannot_be_seated';
    end if;
    -- Only a customer still waiting to be validated. A validated one is moved (his place exists), and a
    -- dropped one is not on the list.
    if v_customer.status <> 'pending' then
      raise exception 'phoenix_crm:customer_not_waiting';
    end if;
    if exists (
      select 1 from public.phoenix_crm_places pl
      where pl.customer_id = v_customer.id and pl.status = 'active'
    ) then
      raise exception 'phoenix_crm:customer_has_a_place';
    end if;
    if jsonb_typeof(v_customer.intake_timings) is distinct from 'array'
       or jsonb_array_length(v_customer.intake_timings) = 0 then
      raise exception 'phoenix_crm:customer_has_no_hours';
    end if;

    insert into public.phoenix_crm_places (
      customer_id, seat_id, address, brick_id, brick_name, zone, lat, lon, accuracy_meters, timings,
      photo_path, captured_at, status, created_by_hr_id, is_test, brick_distance_km, area_code, area_name,
      region_code, region_name, point_source, brick_lookup, shared_place_id, schedule_check, session
    )
    values (
      v_customer.id, v_seat, v_venue.address, v_venue.brick_id, v_venue.brick_name, v_venue.zone,
      -- COPIED FROM THE BUILDING, NEVER RE-RESOLVED, exactly as the move: the same point, so the same
      -- brick, area and region as every other customer behind this door.
      v_venue.lat, v_venue.lon, v_venue.accuracy_meters, v_customer.intake_timings,
      -- The building's own board is this place's photograph — the evidence he is validated by.
      v_venue.schedule_photo_path, now(), 'active', v_actor, v_is_test, v_venue.brick_distance_km,
      v_venue.area_code, v_venue.area_name, v_venue.region_code, v_venue.region_name,
      'shared_place', v_venue.brick_lookup, v_venue.id,
      -- Not read yet. The server reads the board for him after this commits, and the settle decides.
      null,
      v_customer.list_type
    )
    returning id into v_place_id;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_customer.id, v_place_id, 'place_seated', v_actor,
      jsonb_build_object(
        'reason', v_reason,
        'shared_place_id', v_venue.id,
        'shared_place_name', v_venue.name,
        'shared_place_kind', v_venue.kind,
        'timetable_on_file', true,
        -- He had no place before this one: nothing was overwritten.
        'was_waiting', true,
        'after', jsonb_build_object(
          'lat', v_venue.lat, 'lon', v_venue.lon, 'address', v_venue.address,
          'brick_id', v_venue.brick_id, 'area_code', v_venue.area_code,
          'photo_path', v_venue.schedule_photo_path
        )
      ),
      v_is_test
    );

    v_seated := v_seated || jsonb_build_array(jsonb_build_object(
      'place_id', v_place_id,
      'customer_id', v_customer.id,
      'customer_name', v_customer.name
    ));
  end loop;

  return jsonb_build_object(
    'shared_place_id', v_venue.id,
    'shared_place_name', v_venue.name,
    'seated', v_seated,
    'seated_count', jsonb_array_length(v_seated),
    'timetable_on_file', true
  );
end;
$$;

comment on function public.phoenix_crm_seat_waiting_customers_in_venue(jsonb) is
  'The Super Admin seats customers still waiting to be validated, with no place, in an approved building that has a timetable, at the building''s point; the board then validates only those it names (owner, 26 Nov 2026).';

revoke execute on function public.phoenix_crm_seat_waiting_customers_in_venue(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_waiting_customers_in_venue(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
