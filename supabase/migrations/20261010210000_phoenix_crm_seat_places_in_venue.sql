-- phoenix_crm_seat_places_in_venue
--
-- WHAT THIS CHANGES:
--   Three new functions, and NOT ONE table, column, index or constraint:
--     1. public.phoenix_crm_seat_places_in_venue(p jsonb) — the Super Admin moves several standalone
--        customers of one rep INTO a venue he has already validated. Each place keeps its id, its
--        hours and its label, and takes the building's point exactly;
--     2. public.phoenix_crm_set_venue_timetable(p jsonb) — a rep photographs a building's timetable on
--        its own, without seating anybody. Until today a venue's timetable was only ever written as a
--        side effect of a rep seating a customer in it, so a building whose customers the Super Admin
--        had already moved in had nobody left to seat and could never get one;
--     3. public.phoenix_crm_settle_venue_timetable(p jsonb) — reads the `schedule_check` verdict
--        already on every place seated in one venue and settles each customer: validated on a match,
--        held out of the KPIs while the building's board does not name him.
--
-- WHY:
--   Owner, 2026-10-10, in chat: "only the super admin can move a customer in one list … to a
--   polyclinic. For example, a doctor is entered as a separate customer, but actually he is in this
--   polyclinic. So add the option to the admin to move this doctor to — and the validated polyclinics
--   of the rep I am standing in his account appears. And I move the doctors to the polyclinic."
--
--   On the doctor's own location he ruled the question invalid: "since he is in the polyclinic, he's
--   already in the polyclinic. His only place is mismatched. So he's supposed that his location be
--   exactly matching with the polyclinic I'm moving him to." → the moved place takes the venue's
--   point EXACTLY and nothing is offered to choose.
--
--   On a venue with no timetable yet (9 of the 18 live venues on the day he asked): "No, you will
--   count the visit normally … but it will not be included in KPIs until the timetable of the doctor
--   in the polyclinic is updated. So we validate the polyclinic normally as we validate anything, and
--   we validate the customer inside the polyclinic by the timetable." → the move ALWAYS goes through,
--   his visits are planned, sent and recorded, and he is held out of every KPI until the board names
--   him.
--
--   🔴 THE KPI HOLD-OUT IS `validated_at = null`, AND NO KPI CODE CHANGES. A customer at status
--   `pending` can be planned (phoenix_crm_save_plan admits 'active' and 'pending'), the plan can be
--   sent, and the visit is recorded (phoenix_crm_save_visit refuses only a dropped one) — and
--   phoenix_crm_countable_visits.customer_validated takes him out of every KPI in the system, which is
--   exactly the shape he described. A new "waiting for the timetable" column would have had to travel
--   through the countable view, its TypeScript twin and the unified views, touching every KPI surface
--   there is, to say the thing `validated_at` already says.
--
--   🔴 WHY A SEATED PLACE DROPS ITS OWN READINGS INSTEAD OF COPYING THE VENUE'S. `seatedPlacePayload`
--   (src/lib/phoenix-crm/server/shared-places.ts) states the rule for a rep's seating and it is the
--   same rule here: `pin_*` and `photo_*` are left EMPTY because nobody took a reading at this row —
--   the point is the venue's, taken once at its door. Filling them from the venue would be a record
--   claiming a capture that never happened, and `assessCaptureTrust` reads an absence as UNMEASURED,
--   which is what it is. All 8 seated rows live on production read exactly that way. It also closes
--   the hole the plan for this change was worried about: a later "Move this place to the photo
--   reading" cannot drag a seated doctor off the building, because there is no reading left to move to.
--
--   🔴 WHY `signboard_check` IS CLEARED WITH THE PHOTO, AND `captured_at` IS NOT TOUCHED. The
--   signboard verdict describes the door photograph that the building's timetable replaces, so leaving
--   it would have the Place checks board render a verdict about a photograph no longer on the row.
--   `captured_at` dates the row's ORIGINAL capture at his own door, which did happen; the move itself
--   is dated by its `place_seated` event, and the board's own date is the venue's
--   `schedule_photo_captured_at`.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_settle_venue_timetable(jsonb);
--   drop function if exists public.phoenix_crm_set_venue_timetable(jsonb);
--   drop function if exists public.phoenix_crm_seat_places_in_venue(jsonb);
--   All three are new in this migration and nothing existed under these names before it, so dropping
--   them restores the previous state exactly. A seating already performed is NOT undone by the drop:
--   it is a place row holding the venue's point, and the way back is the Place checks board, which
--   sends a seated customer back to To validate with no new code (loadValidatedPlaces has no
--   shared_place_id filter).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration writes NOTHING: it creates three functions and rewrites no place, customer, visit or
-- venue row. The first row any of them touches is the one the Super Admin names on the screen.

begin;
set local lock_timeout = '5s';

-- 1 ─ The Super Admin seats standalone customers in a venue ──────────────────────────────────────

create or replace function public.phoenix_crm_seat_places_in_venue(p jsonb)
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
  v_ids jsonb := case when jsonb_typeof(p -> 'place_ids') = 'array' then p -> 'place_ids' end;
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_after public.phoenix_crm_places%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_pid uuid;
  v_photo text;
  v_kept_photo boolean;
  v_seated jsonb := '[]'::jsonb;
  v_held jsonb := '[]'::jsonb;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'shared_place_id', '') is null or v_ids is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- He picks the building, then ticks the doctors, so an empty tick-list is its own sentence rather
  -- than "something in this entry is missing".
  if jsonb_array_length(v_ids) = 0 then
    raise exception 'phoenix_crm:no_places_chosen';
  end if;
  -- One rep's whole standalone book is 59 places at the widest point on production today. 60 is a
  -- ceiling on a hand-ticked list, not a business rule.
  if jsonb_array_length(v_ids) > 60 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:move_reason_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  -- The same three refusals `sharedPlaceForSeating` gives, repeated under the venue's row lock so a
  -- phone cannot get round them: gone, removed, or still being checked.
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

  for v_pid in select distinct (value #>> '{}')::uuid from jsonb_array_elements(v_ids)
  loop
    select pl.* into v_place
    from public.phoenix_crm_places pl
    where pl.id = v_pid
      and pl.seat_id = v_seat
      and pl.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:place_not_found';
    end if;
    if v_place.status <> 'active' then
      raise exception 'phoenix_crm:place_retired';
    end if;
    -- A place already inside a building is never re-seated: its point is that building's, and moving
    -- it again would overwrite the audit of where it came from with a point that is not its own.
    if v_place.shared_place_id is not null then
      raise exception 'phoenix_crm:already_in_a_venue';
    end if;

    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = v_place.customer_id
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.status = 'dropped' then
      raise exception 'phoenix_crm:customer_dropped';
    end if;
    -- 🔴 A seated place carries the AM or PM session its customer's list follows
    -- (`phoenix_crm_places_seated_has_session`, found on staging). A pharmacy has neither, so it is
    -- never seated in a building.
    if v_customer.list_type not in ('AM', 'PM') then
      raise exception 'phoenix_crm:pharmacy_cannot_be_seated';
    end if;
    -- A customer may hold up to five places, so his OTHER places have to be checked too: two rows of
    -- one doctor behind one door would make him two clinics in the same building, and his hours are
    -- windows in the one row.
    if exists (
      select 1
      from public.phoenix_crm_places other
      where other.customer_id = v_place.customer_id
        and other.status = 'active'
        and other.shared_place_id = v_venue.id
    ) then
      raise exception 'phoenix_crm:already_seated';
    end if;

    -- The building's timetable when it has one; otherwise his own door photograph STAYS, because
    -- `photo_path` is not null and his evidence is the only evidence there is until a board exists.
    v_photo := coalesce(v_venue.schedule_photo_path, v_place.photo_path);
    v_kept_photo := v_photo = v_place.photo_path;

    -- 🔴 ONE STATEMENT, AND IT HAS TO BE. `phoenix_crm_places_photo_uidx` is partial — `where
    -- shared_place_id is null` — so the row only becomes free to share the building's timetable at the
    -- instant `shared_place_id` is set; and `phoenix_crm_places_moved` forces all three `moved_*`
    -- fields to empty in the same statement that leaves `point_source = 'moved'`.
    update public.phoenix_crm_places pl
    set shared_place_id = v_venue.id,
        point_source = 'shared_place',
        photo_path = v_photo,
        -- COPIED FROM THE VENUE, NEVER RE-RESOLVED: it is the SAME point, so re-resolving would pay
        -- for a second brick and map lookup to answer a question already answered at the building's
        -- door — and could answer it differently if the brick master changed in between, leaving two
        -- rows at one coordinate in two bricks.
        lat = v_venue.lat,
        lon = v_venue.lon,
        accuracy_meters = v_venue.accuracy_meters,
        address = v_venue.address,
        zone = v_venue.zone,
        brick_id = v_venue.brick_id,
        brick_name = v_venue.brick_name,
        brick_distance_km = v_venue.brick_distance_km,
        brick_lookup = v_venue.brick_lookup,
        area_code = v_venue.area_code,
        area_name = v_venue.area_name,
        region_code = v_venue.region_code,
        region_name = v_venue.region_name,
        -- No reading was taken at this row for this building. See the header.
        pin_lat = null,
        pin_lon = null,
        pin_accuracy_meters = null,
        photo_lat = null,
        photo_lon = null,
        photo_accuracy_meters = null,
        photo_captured_at = null,
        -- Both describe the photograph on the row. They survive only while that photograph does.
        device_skew_minutes = case when v_kept_photo then v_place.device_skew_minutes else null end,
        signboard_check = case when v_kept_photo then v_place.signboard_check else null end,
        -- The timetable question is now asked about the BUILDING's board, so any earlier verdict is
        -- about a different photograph. The read runs again after this transaction and lands here.
        schedule_check = null,
        session = v_customer.list_type,
        moved_at = null,
        moved_by_hr_id = null,
        move_reason = null,
        updated_at = now()
    where pl.id = v_place.id
    returning pl.* into v_after;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_place.customer_id, v_place.id, 'place_seated', v_actor,
      jsonb_build_object(
        'reason', v_reason,
        'shared_place_id', v_venue.id,
        'shared_place_name', v_venue.name,
        'shared_place_kind', v_venue.kind,
        'timetable_on_file', v_venue.schedule_photo_path is not null,
        -- 🔴 THE DOOR PHOTOGRAPH THAT IS OVERWRITTEN IS RECOVERABLE FROM HERE AND NOWHERE ELSE, with
        -- the verdict that was read on it. Nothing else keeps it once the board takes its place.
        'before', jsonb_build_object(
          'lat', v_place.lat, 'lon', v_place.lon, 'point_source', v_place.point_source,
          'address', v_place.address, 'brick_id', v_place.brick_id, 'area_code', v_place.area_code,
          'photo_path', v_place.photo_path, 'signboard_check', v_place.signboard_check,
          'schedule_check', v_place.schedule_check
        ),
        'after', jsonb_build_object(
          'lat', v_after.lat, 'lon', v_after.lon,
          'address', v_after.address, 'brick_id', v_after.brick_id, 'area_code', v_after.area_code,
          'photo_path', v_after.photo_path
        )
      ),
      v_is_test
    );

    v_seated := v_seated || jsonb_build_array(jsonb_build_object(
      'place_id', v_place.id,
      'customer_id', v_place.customer_id,
      'customer_name', v_customer.name
    ));

    -- 🔴 THE HOLD, WHEN THE BUILDING HAS NO BOARD YET — his own ruling, and it is structural rather
    -- than a verdict on evidence: there is no photograph to read, so nothing was judged and nothing
    -- can be wrong. A venue that DOES have a board is settled by
    -- phoenix_crm_settle_venue_timetable, after the board has been read for each of them.
    --
    -- `reopened_at` is deliberately NOT set, unlike the rejected-venue path: he is not being asked to
    -- photograph this doctor's own door again — that would undo the seating. What is waiting is the
    -- BUILDING's timetable.
    if v_venue.schedule_photo_path is null then
      update public.phoenix_crm_customers c
      set status = 'pending',
          validated_at = null,
          validated_by_hr_id = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_place.customer_id
        and c.status = 'active';
      if found then
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_seat, v_place.customer_id, v_place.id, 'customer_pending', v_actor,
          jsonb_build_object(
            'why', 'venue_timetable_missing',
            'shared_place_id', v_venue.id,
            'shared_place_name', v_venue.name
          ),
          v_is_test
        );
        v_held := v_held || jsonb_build_array(to_jsonb(v_place.customer_id));
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'shared_place_id', v_venue.id,
    'shared_place_name', v_venue.name,
    'seated', v_seated,
    'seated_count', jsonb_array_length(v_seated),
    'held', v_held,
    'timetable_on_file', v_venue.schedule_photo_path is not null
  );
end;
$$;

revoke execute on function public.phoenix_crm_seat_places_in_venue(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_places_in_venue(jsonb) to service_role;

-- 2 ─ A rep photographs the building's timetable on its own ──────────────────────────────────────

create or replace function public.phoenix_crm_set_venue_timetable(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_photo text := nullif(trim(coalesce(p ->> 'photo_path', '')), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_before text;
  v_captured_at timestamptz;
begin
  if v_seat is null or v_actor is null or v_photo is null or nullif(p ->> 'shared_place_id', '') is null then
    raise exception 'phoenix_crm:bad_input';
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

  -- The same slot discipline every photograph in this module goes through: it must be one this server
  -- issued to THIS person for THIS territory, it is single-use, and it dates the capture.
  v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'place', v_is_test);
  v_before := v_venue.schedule_photo_path;

  update public.phoenix_crm_shared_places sp
  set schedule_photo_path = v_photo,
      schedule_photo_captured_at = v_captured_at,
      schedule_photo_by_hr_id = v_actor,
      updated_at = now()
  where sp.id = v_venue.id;

  -- A venue-level event: no customer, which `phoenix_crm_list_events.customer_id` allows.
  insert into public.phoenix_crm_list_events (seat_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, 'venue_timetable_set', v_actor,
    jsonb_build_object(
      'shared_place_id', v_venue.id,
      'shared_place_name', v_venue.name,
      'photo_path', v_photo,
      -- Null the first time, the replaced board afterwards: "the timetable changed" is the same door.
      'before_photo_path', v_before
    ),
    v_is_test
  );

  return jsonb_build_object(
    'shared_place_id', v_venue.id,
    'shared_place_name', v_venue.name,
    'schedule_photo_path', v_photo,
    'captured_at', v_captured_at,
    'replaced', v_before is not null
  );
end;
$$;

revoke execute on function public.phoenix_crm_set_venue_timetable(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_set_venue_timetable(jsonb) to service_role;

-- 3 ─ Settling every customer seated in one venue against its board ──────────────────────────────

create or replace function public.phoenix_crm_settle_venue_timetable(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_row record;
  v_verdict text;
  v_validated jsonb := '[]'::jsonb;
  v_held jsonb := '[]'::jsonb;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'shared_place_id', '') is null then
    raise exception 'phoenix_crm:bad_input';
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

  for v_row in
    select pl.id as place_id, pl.customer_id, pl.schedule_check, c.status as customer_status, c.name as customer_name
    from public.phoenix_crm_places pl
    join public.phoenix_crm_customers c on c.id = pl.customer_id
    where pl.shared_place_id = v_venue.id
      and pl.status = 'active'
    order by pl.created_at
    -- No `for update` on the cursor, by choice, exactly as phoenix_crm_decide_shared_place records:
    -- each row is locked by the update that settles it, the whole function runs in one transaction
    -- behind the seat's advisory lock, and one venue is settled by one caller at a time.
  loop
    v_verdict := v_row.schedule_check ->> 'verdict';

    -- 🔴 A DECISION OF HIS IS NEVER UNDONE HERE: a place whose review the Super Admin already approved
    -- keeps its customer validated whatever the board says, because that approval was his own click.
    if exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.place_id = v_row.place_id and r.status = 'approved'
    ) then
      null;
    elsif v_venue.schedule_photo_path is null or v_verdict in ('other_name', 'no_schedule') then
      -- Out of the KPIs: either the building has no board at all, or its board was read and does not
      -- name him. His visits are still planned, sent and recorded — that is his ruling.
      update public.phoenix_crm_customers c
      set status = 'pending',
          validated_at = null,
          validated_by_hr_id = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_row.customer_id
        and c.status = 'active';
      if found then
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_seat, v_row.customer_id, v_row.place_id, 'customer_pending', v_actor,
          jsonb_build_object(
            'why', case when v_venue.schedule_photo_path is null then 'venue_timetable_missing' else coalesce(v_row.schedule_check ->> 'reason', v_verdict) end,
            'shared_place_id', v_venue.id,
            'shared_place_name', v_venue.name
          ),
          v_is_test
        );
        v_held := v_held || jsonb_build_array(jsonb_build_object(
          'customer_id', v_row.customer_id, 'customer_name', v_row.customer_name, 'place_id', v_row.place_id
        ));
      end if;

    elsif v_verdict = 'match' and v_row.customer_status = 'pending' then
      -- The board names him, so the board validates him — the same automatic validation the rep's own
      -- seating door performs on a match.
      --
      -- 🔴 NEVER WHILE A PERSON'S DECISION IS STILL WAITING. A seating the system held raised a
      -- pending `phoenix_crm_validation_reviews` row, and that row is the Super Admin's own click: a
      -- settle that validated past it would be an approval taken on his behalf, and would leave his
      -- board holding a pending review for a customer already validated.
      if not exists (
        select 1 from public.phoenix_crm_validation_reviews r
        where r.place_id = v_row.place_id and r.status = 'pending'
      ) then
        update public.phoenix_crm_customers c
        set status = 'active',
            validated_at = now(),
            validated_by_hr_id = v_actor,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_row.customer_id
          and c.status = 'pending';
        if found then
          insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
          values (
            v_seat, v_row.customer_id, v_row.place_id, 'customer_validated', v_actor,
            jsonb_build_object(
              'why', 'venue_timetable_names_customer',
              'shared_place_id', v_venue.id,
              'shared_place_name', v_venue.name
            ),
            v_is_test
          );
          v_validated := v_validated || jsonb_build_array(jsonb_build_object(
            'customer_id', v_row.customer_id, 'customer_name', v_row.customer_name, 'place_id', v_row.place_id
          ));
        end if;
      end if;
    end if;
    -- 🔴 EVERY OTHER CASE IS LEFT ALONE, AND `unjudged` IS THE ONE THAT MATTERS: no key, unreadable
    -- bytes, a call that failed. The locked rule is that `unjudged` NEVER holds (owner, 2026-10-08 —
    -- the key has run dry silently twice), and an outage at the model's end must never de-validate a
    -- rep's list. A null `schedule_check` is the same answer: not read yet, so nothing is decided.
  end loop;

  return jsonb_build_object(
    'shared_place_id', v_venue.id,
    'shared_place_name', v_venue.name,
    'timetable_on_file', v_venue.schedule_photo_path is not null,
    'validated', v_validated,
    'held', v_held
  );
end;
$$;

revoke execute on function public.phoenix_crm_settle_venue_timetable(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_settle_venue_timetable(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
