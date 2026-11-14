-- phoenix_crm_validation_owner_decisions
--
-- WHAT THIS CHANGES: one new function and three replaced ones. Each replaced function starts from the
--   body production and staging both hold today (identical on the two, read 14 Nov 2026) and changes only
--   what is named here. No table, column, constraint or index changes, and this file writes no row.
--   1. public.phoenix_crm_customer_stands_on_another_place(uuid, uuid) — NEW. True when the customer has
--      another active place that validates him by itself: no decision waiting on it, and either a place of
--      his own, or a seat the building's board names, or a seat a person approved — in a building that is
--      itself active.
--   2. public.phoenix_crm_restore_validation(jsonb) — "Approve it after all" is refused, by name, when the
--      customer was dropped, when the place sits in a retired building, or when the customer already has
--      another active place at the same door (the same building, or within 150 m). Where it validates the
--      customer it also clears `reopened_at`.
--   3. public.phoenix_crm_settle_venue_timetable(jsonb) — a customer the board does not name (or whose
--      building has no board) is no longer sent out of the KPIs when (1) is true for him. He is returned
--      under a new `kept` key. Where it validates a customer it also clears `reopened_at`.
--   4. public.phoenix_crm_seat_places_in_venue(jsonb) — the Super Admin's move into a building with no
--      board no longer sends the customer to pending when (1) is true for him.
-- WHY: the owner's decisions of 14 Nov 2026 on the Phoenix CRM validation audit.
--   2. "Stop and say why". Of 57 take-backs, 15 left a customer with two active places at one door and
--      one left an active seat in a retired building.
--   3 and 4. "Stay in on his clinic". No live case; the rule is set before one appears.
-- ROLLBACK: re-apply the three bodies as they stood — phoenix_crm_restore_validation from
--   20261110214512, phoenix_crm_settle_venue_timetable and phoenix_crm_seat_places_in_venue from the
--   latest migration that defines each — then
--   `drop function public.phoenix_crm_customer_stands_on_another_place(uuid, uuid);`
--   Nothing here writes or removes a row, so there is no data to put back.

create or replace function public.phoenix_crm_customer_stands_on_another_place(p_customer_id uuid, p_place_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1
    from public.phoenix_crm_places o
    where o.customer_id = p_customer_id
      and o.id <> p_place_id
      and o.status = 'active'
      -- A place somebody still has to decide on validates nobody yet.
      and not exists (
        select 1 from public.phoenix_crm_validation_reviews r
        where r.place_id = o.id and r.status = 'pending'
      )
      and (
        -- A place of his own.
        o.shared_place_id is null
        -- Or a seat in a building that is itself active, which its board names or a person approved.
        or (
          exists (
            select 1 from public.phoenix_crm_shared_places sp
            where sp.id = o.shared_place_id and sp.status = 'active'
          )
          and (
            o.schedule_check ->> 'verdict' = 'match'
            or exists (
              select 1 from public.phoenix_crm_validation_reviews r
              where r.place_id = o.id and r.status = 'approved'
            )
          )
        )
      )
  );
$function$;

revoke execute on function public.phoenix_crm_customer_stands_on_another_place(uuid, uuid) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_stands_on_another_place(uuid, uuid) to service_role;

create or replace function public.phoenix_crm_restore_validation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  -- The Super Admin's own spelling of the customer's name (owner, 2026-11-10: "Both"). The service has
  -- already refused everybody else and checked the three names; null means "keep the name as it stands".
  v_corrected text := nullif(left(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), 200), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_renamed boolean := false;
begin
  -- 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"). It used to raise
  -- bad_input on a null note; the four events and the review row this writes all accept one, and
  -- `who` and `when` are on the record whether or not he writes a word about it.
  if v_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  if v_review.status <> 'rejected' then
    raise exception 'phoenix_crm:review_not_rejected';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  -- The place must still be in the state the rejection left it in. A moved or already-active place is
  -- a different story and is not undone here.
  if v_place.status <> 'retired' then
    raise exception 'phoenix_crm:place_not_retired';
  end if;

  -- 🔴 "APPROVE IT AFTER ALL" STOPS AND SAYS WHY (owner, 14 Nov 2026: "Stop and say why"). It used to
  -- bring the place back whatever had happened since the refusal, and 15 customers ended with two active
  -- places at one door, one with an active seat in a retired building. Each of the three is refused by
  -- name before anything is written; he clears what is in the way, then approves.
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:restore_customer_dropped';
  end if;
  if v_place.shared_place_id is not null and exists (
    select 1 from public.phoenix_crm_shared_places sp
    where sp.id = v_place.shared_place_id and sp.status = 'retired'
  ) then
    raise exception 'phoenix_crm:restore_building_retired';
  end if;
  -- The same door, captured again since: another active place of this customer in the same building, or
  -- within 150 m of this one (the line the Google check draws round a door).
  if exists (
    select 1 from public.phoenix_crm_places o
    where o.customer_id = v_place.customer_id
      and o.id <> v_place.id
      and o.status = 'active'
      and (
        (v_place.shared_place_id is not null and o.shared_place_id = v_place.shared_place_id)
        or (
          v_place.lat is not null and v_place.lon is not null and o.lat is not null and o.lon is not null
          and 6371000 * 2 * asin(least(1, sqrt(
            power(sin(radians(o.lat - v_place.lat) / 2), 2)
            + cos(radians(v_place.lat)) * cos(radians(o.lat)) * power(sin(radians(o.lon - v_place.lon) / 2), 2)
          ))) <= 150
        )
      )
  ) then
    raise exception 'phoenix_crm:restore_door_captured_again';
  end if;

  -- The corrected name first, so everything below reads the customer as he now is. The rep's own rename:
  -- the name key, the contact's name row and the history move exactly as when he saves a name himself, and
  -- a second customer of the same name is the administrator's to judge, never a refusal.
  if v_corrected is not null and v_corrected is distinct from v_customer.name and v_customer.status <> 'dropped' then
    perform public.phoenix_crm_rename_customer(jsonb_build_object(
      'seat_id', v_customer.seat_id,
      'actor_hr_id', v_actor,
      'is_test', v_customer.is_test,
      'customer_id', v_customer.id,
      'name', v_corrected,
      'speciality', v_customer.speciality,
      'allow_same_name', true
    ));
    -- A full name still waiting on "PM full names to check" is answered by the name he just wrote.
    update public.phoenix_crm_customers c
    set full_name_held = null,
        full_name_held_at = null,
        full_name_held_by_hr_id = null,
        full_name_held_score = null,
        full_name_held_board = null,
        updated_at = now()
    where c.id = v_customer.id and c.full_name_held is not null;
    select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer.id;
    v_renamed := true;
  end if;

  update public.phoenix_crm_places pl
  set status = 'active', retired_at = null, retired_by_hr_id = null, updated_at = now()
  where pl.id = v_place.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'place_restored', v_actor,
    jsonb_build_object('reason', v_note, 'label', v_place.label, 'why', 'validation_restored', 'review_id', v_id,
      'rejected_by_hr_id', v_review.decided_by_hr_id, 'rejection_note', v_review.decision_note),
    v_review.is_test
  );

  -- The rejection sent him back to To validate when this was his only place; the restore undoes that,
  -- in the REP's own name — he validated it, and a reversal does not take that away from him.
  if v_customer.status = 'pending' then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_review.created_by_hr_id,
        -- A validated customer carries no stamp of an old refusal (validation audit, 14 Nov 2026).
        reopened_at = null,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    v_validated := true;
  end if;

  -- One review row per place (the UNIQUE index), so this is an UPDATE. What it was before is kept in
  -- `google`, beside the events, rather than being thrown away.
  update public.phoenix_crm_validation_reviews r
  set status = 'approved',
      decided_by_hr_id = v_actor,
      decided_at = now(),
      decision_note = v_note,
      google = coalesce(r.google, '{}'::jsonb) || jsonb_build_object(
        'restored', true,
        'rejected_by_hr_id', v_review.decided_by_hr_id,
        'rejected_at', v_review.decided_at,
        'rejection_note', v_review.decision_note
      )
  where r.id = v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_review.seat_id, v_customer.id, v_place.id, 'validation_review_approved', v_actor,
    jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated, 'why', 'restored_after_rejection',
      'renamed', v_renamed),
    v_review.is_test
  );

  return jsonb_build_object(
    'review_id', v_id,
    'status', 'approved',
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'place_id', v_place.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'renamed', v_renamed
  );
end;
$function$;

revoke execute on function public.phoenix_crm_restore_validation(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restore_validation(jsonb) to service_role;

create or replace function public.phoenix_crm_settle_venue_timetable(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_row record;
  v_verdict text;
  v_validated jsonb := '[]'::jsonb;
  v_held jsonb := '[]'::jsonb;
  v_kept jsonb := '[]'::jsonb;
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
    elsif (v_venue.schedule_photo_path is null or v_verdict in ('other_name', 'no_schedule'))
      and public.phoenix_crm_customer_stands_on_another_place(v_row.customer_id, v_row.place_id) then
      -- 🔴 HE STAYS IN ON HIS OWN CLINIC (owner, 14 Nov 2026: "Stay in on his clinic"). A customer this
      -- board does not name, who is also validated at a place of his own, keeps his validation: only the
      -- seat is in doubt, and Place checks shows it for a person to decide. Nothing is written on him.
      if v_row.customer_status = 'active' then
        v_kept := v_kept || jsonb_build_array(jsonb_build_object(
          'customer_id', v_row.customer_id, 'customer_name', v_row.customer_name, 'place_id', v_row.place_id
        ));
      end if;
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

    -- 🔴 NEVER WHILE THE BUILDING ITSELF IS STILL WAITING FOR THE SUPER ADMIN (2026-10-14). A customer seated in
    -- a held venue is pending until that venue is approved, and a board that names him must not release him
    -- ahead of it — approving the venue is what does (phoenix_crm_decide_shared_place).
    elsif v_verdict = 'match' and v_row.customer_status = 'pending' and v_venue.status = 'active' then
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
            -- A validated customer carries no stamp of an old refusal (validation audit, 14 Nov 2026).
            reopened_at = null,
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
    'held', v_held,
    'kept', v_kept
  );
end;
$function$;

revoke execute on function public.phoenix_crm_settle_venue_timetable(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_settle_venue_timetable(jsonb) to service_role;

create or replace function public.phoenix_crm_seat_places_in_venue(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
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
    -- 🔴 UNLESS HE IS VALIDATED AT A PLACE OF HIS OWN (owner, 14 Nov 2026: "Stay in on his clinic") — then
    -- only this seat waits for the building's timetable, and he stays in the KPIs.
    if v_venue.schedule_photo_path is null
       and not public.phoenix_crm_customer_stands_on_another_place(v_place.customer_id, v_place.id) then
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
$function$;

revoke execute on function public.phoenix_crm_seat_places_in_venue(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_places_in_venue(jsonb) to service_role;
