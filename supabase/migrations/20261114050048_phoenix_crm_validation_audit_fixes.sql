-- phoenix_crm_validation_audit_fixes
--
-- WHAT THIS CHANGES: replaces four functions. Each one starts from the body production holds today (the
--   digests are below) and changes only what is named here. No table, column, constraint, index or grant
--   changes, and this file writes no row.
--   1. public.phoenix_crm_validate_customer(jsonb) — its two `location_in_review` refusals (the reference
--      door and the listed door) count a pending validation review only while the place that review is
--      about is still active. Its two updates that validate a customer also clear `reopened_at`.
--   2. public.phoenix_crm_decide_validation_review(jsonb) — the update that validates the customer on an
--      approval also clears `reopened_at`. Nothing else in it changes.
--   3. public.phoenix_crm_place_on_trusted_point(jsonb) — where it validates the customer it now withdraws
--      a drop request still pending on him and writes the `request_withdrawn` event, with the statement
--      phoenix_crm_decide_validation_review uses; the same update clears `reopened_at`; and the actor's HR
--      id is upper-cased on the way in, as every sibling function does.
--   4. public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) — a place seated in a building
--      (point_source 'shared_place') is written with null pin_lat, pin_lon and pin_accuracy_meters. A place
--      of the customer's own is written exactly as before.
-- WHY: the Phoenix CRM place-validation audit of 2026-11-14.
--   1. Rejecting a building (phoenix_crm_decide_shared_place) and retiring a place
--      (phoenix_crm_update_place) both retire the place and leave a pending review of it pending. The
--      customer goes back to To validate, and the door then answered `location_in_review` to the very
--      capture it had asked for. Latent: production holds 49 pending reviews today and none of them is on
--      a place that is not active.
--   2. `reopened_at` is stamped when a validation is refused and puts the customer first in To validate.
--      Nothing cleared it when he was validated afterwards (only phoenix_crm_restore_shared_place does),
--      so the stamp of an old refusal came back, with its age, the next time he was sent to To validate by
--      a path that stamps nothing. 237 active customers carry one today. Every reader filters on
--      status = 'pending', so clearing it on validation changes nothing that is on screen now.
--   3. The trusted point was the one validating door that left an open drop request standing on a customer
--      it had just validated, and it stored the actor as typed where its siblings upper-case it.
--   4. A seating has no reading of its own: the service sends no pin for it, so the building's point was
--      copied into the pin columns, where it reads as a second reading taken at this customer's place. 641
--      of the 643 seated places carry that copy today; the 2 the Super Admin moved are already null
--      (phoenix_crm_seat_places_in_venue). No CHECK constraint needs a pin, and every reader falls back to
--      lat/lon or branches on point_source.
-- NOT IN THIS FILE, deliberately:
--   * Holding a customer pending when his held validation is approved while his building is still held.
--     phoenix_crm_decide_shared_place skips, on approving the building, a customer whose own timetable
--     verdict is other_name or no_schedule (and every customer of a building with no timetable on file).
--     Those are the customers a review is held for, so "approve the review, then the building" would leave
--     them pending with nothing left to decide: 3 of the 9 reviews pending today on a place seated in a
--     held building. It needs the building's release changed in the same file
--     (phoenix_crm_decide_shared_place and the same holds in phoenix_crm_restore_shared_place).
--   * The same "any pending review" test in phoenix_crm_place_on_trusted_point,
--     phoenix_crm_decide_shared_place and phoenix_crm_restore_shared_place is left as it is.
--   * `reopened_at` is still not cleared by the other functions that validate a customer:
--     phoenix_crm_restore_validation, phoenix_crm_decide_shared_place, phoenix_crm_settle_venue_timetable,
--     phoenix_crm_share_line_validation, phoenix_crm_decide_request and phoenix_crm_reverse_list_request.
--   * No backfill: the 237 stamps and the 641 copied pins stay as they are. Either would be a bulk change
--     to production rows, which is announced to the owner first and is not this file's to make.
-- ROLLBACK: re-run the block of each function from the migration that last defined it —
--   phoenix_crm_validate_customer from 20261111030456_phoenix_crm_sweep_fixes.sql,
--   phoenix_crm_decide_validation_review from
--   20261015212903_phoenix_crm_reject_after_approve_and_optional_note.sql,
--   phoenix_crm_insert_place from 20261014151354_phoenix_crm_insert_place_seats_in_a_held_venue.sql, and
--   phoenix_crm_place_on_trusted_point from 20261110213959_phoenix_crm_trusted_point_places.sql (that file
--   carries two comment lines production's copy does not; the statements are the same). Nothing this file
--   makes the functions write needs undoing: a cleared stamp belongs to a validated customer, a withdrawn
--   request to a customer who was validated, and a null pin to a place whose point is in lat/lon.
--
-- md5(prosrc) on production, project ozucdzovmcqvepbozvqf, read 2026-11-14 — BEFORE this file, and what
-- pg_proc must answer AFTER it:
--   phoenix_crm_validate_customer         9afe35c9423006f25758c15b2132b850  ->  840e6dd3a80a0f9bb88b1d5acc8a1464
--   phoenix_crm_decide_validation_review  77737492e3003b763a4580f170aee0f0  ->  69ffc695771d1894e25c49ef68d762e2
--   phoenix_crm_place_on_trusted_point    4ccbbaf14c251ad0c77534cdeaa1e9fc  ->  8d2b86912b0c8213750d198025117307
--   phoenix_crm_insert_place              0c9e11e60c6d2efa353e38b3c99f7b81  ->  3e91888ef7e42d084516534ce8b3e89a
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

-- 1. The door: a review of a retired place holds nobody, and a validation clears the old refusal stamp.
create or replace function public.phoenix_crm_validate_customer(p jsonb)
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
  v_mode text := coalesce(p ->> 'mode', '');
  v_first_stage text := coalesce(nullif(p ->> 'first_stage', ''), 'manager');
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
  -- 2026-10-03: the Google check. `hold_review` holds the place for the Super Admin; `google` is the
  -- listing a matched place stood at. Both optional: a caller that sends neither gets the old function.
  v_hold jsonb := case when jsonb_typeof(p -> 'hold_review') = 'object' then p -> 'hold_review' end;
  v_google jsonb := case when jsonb_typeof(p -> 'google') = 'object' then p -> 'google' end;
  v_review_id uuid;
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_name text;
  v_name_key text;
  v_list_type text;
  v_grade text;
  v_place jsonb;
  v_request_id uuid;
  v_request_kind text;
  v_event text := 'customer_validated';
  -- 2026-10-14: a seating in a venue the Super Admin has not decided yet. The customer is SAVED and can be
  -- planned, sent and visited, but he is not validated, so no KPI counts him until the venue is approved.
  v_venue_held boolean := false;
  v_validate_now boolean := true;
  -- 2026-11-07 (owner): a clinic doctor listed with only one or two names is validated with all three. The
  -- app sends the full name, already judged against the signboard, and it is written in this same
  -- transaction, so a refused validation writes no name. Optional: a caller that sends none gets the old
  -- function.
  v_full_name text := nullif(regexp_replace(trim(coalesce(p ->> 'full_name', '')), '\s+', ' ', 'g'), '');
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'place') is distinct from 'object'
    or v_first_stage not in ('manager', 'sfe') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phoenix_crm:bad_phone';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  -- 🔴 READ UNDER THE SEAT'S LOCK, which phoenix_crm_decide_shared_place takes too, so an approval cannot
  -- land between this read and the insert below and leave a customer pending in an approved building.
  if nullif(p -> 'place' ->> 'shared_place_id', '') is not null then
    select (s.status = 'held') into v_venue_held
    from public.phoenix_crm_shared_places s
    where s.id = (p -> 'place' ->> 'shared_place_id')::uuid;
    v_venue_held := coalesce(v_venue_held, false);
  end if;
  v_validate_now := v_hold is null and not v_venue_held;

  if v_mode = 'reference' then
    select r.* into v_ref
    from public.phoenix_crm_reference_entry(v_seat, (p ->> 'reference_contact_crm_id')::bigint, v_is_test) r;
    if not found then
      raise exception 'phoenix_crm:not_on_reference_list';
    end if;
    if v_ref.state = 'validated' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    -- A customer in the Archive comes back only through "Ask to bring back" — the district manager,
    -- then SFE (owner, 2026-09-29). Re-validating him was a door around that decision.
    if v_ref.state = 'dropped' then
      raise exception 'phoenix_crm:archived';
    end if;
    -- His location is already with the Super Admin: a second validation would add a second place
    -- beside the one being checked.
    -- 2026-11-14 (validation audit): only while that place is still ACTIVE. A rejected building retires the
    -- place and leaves its review pending, and this door then answered location_in_review to the very
    -- capture it had asked for.
    if v_ref.customer_id is not null and exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.customer_id = v_ref.customer_id and r.status = 'pending'
        and exists (select 1 from public.phoenix_crm_places pl where pl.id = r.place_id and pl.status = 'active')
    ) then
      raise exception 'phoenix_crm:location_in_review';
    end if;

    if v_ref.customer_id is not null then
      perform 1 from public.phoenix_crm_customers c where c.id = v_ref.customer_id for update;

      if v_validate_now then
        update public.phoenix_crm_customers c
        set status = 'active',
            validated_at = now(),
            validated_by_hr_id = v_actor,
            -- 2026-11-14 (validation audit): validated, so nothing waits to be captured again. Left standing,
            -- the stamp of an old refusal came back with its age the next time he was sent to To validate.
            reopened_at = null,
            dropped_reason = null,
            dropped_note = null,
            status_changed_at = now(),
            phone = coalesce(v_phone, c.phone),
            updated_at = now()
        where c.id = v_ref.customer_id
        returning c.* into v_customer;
      else
        -- Held: the place is saved, the customer is not validated until the Super Admin decides.
        update public.phoenix_crm_customers c
        set phone = coalesce(v_phone, c.phone),
            updated_at = now()
        where c.id = v_ref.customer_id
        returning c.* into v_customer;
      end if;
    else
      insert into public.phoenix_crm_customers (
        seat_id, line_code, list_type, name, speciality, grade, origin, reference_contact_crm_id,
        status, validated_at, validated_by_hr_id, created_by_hr_id, is_test, phone
      )
      values (
        v_seat, v_line, v_ref.list_type, left(v_ref.name, 200), left(v_ref.speciality, 120), v_ref.grade, 'reference', v_ref.contact_crm_id,
        case when v_validate_now then 'active' else 'pending' end,
        case when v_validate_now then now() end,
        case when v_validate_now then v_actor end,
        v_actor, v_is_test, v_phone
      )
      returning * into v_customer;
    end if;

    if v_validate_now then
      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'Validated instead of dropped'
        where q.seat_id = v_seat
          and q.is_test = v_is_test
          and q.kind = 'drop'
          and q.status = 'pending'
          and (
            q.customer_id = v_customer.id
            or (q.customer_id is null and q.reference_contact_crm_id = v_ref.contact_crm_id)
          )
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
      from withdrawn w;
    end if;

  elsif v_mode = 'listed' then
    -- A customer the SFE loaded from a sheet: already on the list, already graded by him, and carrying
    -- no iReports360 contact at all — so `phoenix_crm_reference_entry` can never find him and the
    -- reference branch above cannot serve him. He is validated at the door like any other.
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
      -- The Archive is frozen. He comes back through "Ask to bring back", never through a validation.
      raise exception 'phoenix_crm:archived';
    end if;
    if v_customer.status <> 'pending' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    -- 2026-11-14 (validation audit): as at the reference door above, a review of a place that is no longer
    -- active holds nobody.
    if exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.customer_id = v_customer.id and r.status = 'pending'
        and exists (select 1 from public.phoenix_crm_places pl where pl.id = r.place_id and pl.status = 'active')
    ) then
      raise exception 'phoenix_crm:location_in_review';
    end if;

    if v_validate_now then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_actor,
          reopened_at = null,
          status_changed_at = now(),
          phone = coalesce(v_phone, c.phone),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'Validated instead of dropped'
        where q.seat_id = v_seat
          and q.is_test = v_is_test
          and q.kind = 'drop'
          and q.status = 'pending'
          and q.customer_id = v_customer.id
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
      from withdrawn w;
    else
      update public.phoenix_crm_customers c
      set phone = coalesce(v_phone, c.phone),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;
    end if;

  elsif v_mode in ('new', 'outside') then
    v_name := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_list_type := coalesce(p ->> 'list_type', '');
    v_grade := nullif(p ->> 'proposed_grade', '');
    if v_name is null or v_list_type not in ('AM', 'PM')
      or (v_mode = 'new' and coalesce(v_grade, '') not in ('A', 'B', 'C'))
      or (v_grade is not null and v_grade not in ('A', 'B', 'C')) then
      raise exception 'phoenix_crm:bad_input';
    end if;
    -- 2026-10-12: the DOOR folds the name, exactly as the bulk loader has since 2026-10-05 (owner:
    -- "ONE CUSTOMER, ONE NAME KEY — THE LOADER FOLDS THE NAME, IT DOES NOT lower() IT"). That rule was
    -- written about the loader and the door was simply not in the change, so lower() kept letting a
    -- second row for the same doctor through: 7 live groups and 9 rows in production on 2026-10-12,
    -- every one of them an honorific ("د.محمود سعد" beside "محمود سعد") or an alef/yeh spelling
    -- ("أشرف إدوارد" beside "اشرف ادوارد"). phoenix_crm_fold_name is the one authority on the key.
    --
    -- Three fences, all the owner's: it only ever SKIPS — nothing is merged, nothing is deleted, and
    -- there is NO unique index, because 55 live duplicate groups could not satisfy one; the scope stays
    -- the SEAT and the list (594 of 624 production pairs straddle two lines and are correct); and the
    -- key is never identityNameKey, which collapses محمود onto محمد.
    --
    -- An empty fold is NOT a key. The function returns '' for a name that folds away to nothing, and
    -- comparing '' would collide every such row onto one customer, so an empty key skips the check —
    -- the same reading the loader takes.
    v_name_key := public.phoenix_crm_fold_name(v_name);
    if not coalesce((p ->> 'allow_same_name')::boolean, false) and v_name_key <> '' and exists (
      select 1
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending', 'outside')
        and c.list_type = v_list_type
        and public.phoenix_crm_fold_name(c.name) = v_name_key
    ) then
      raise exception 'phoenix_crm:same_name';
    end if;

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, origin, status, validated_at,
      validated_by_hr_id, created_by_hr_id, is_test, phone
    )
    values (
      v_seat, v_line, v_list_type, v_name, nullif(trim(coalesce(p ->> 'speciality', '')), ''), null, 'new', 'outside', null,
      null, v_actor, v_is_test, v_phone
    )
    returning * into v_customer;
    v_event := 'customer_met_outside';

    -- 2026-11-11 (sweep): an OUTSIDE customer with a grade is filed for approval too. The owner's rule is
    -- that a customer met outside the list is approved by the district manager and then SFE, but only
    -- `new` filed the request, so 159 outside customers and their visits waited with nobody asked. The
    -- rep's form now asks the grade on the outside entry as well; without one (an older phone) nothing
    -- changes and the customer waits as before.
    if v_mode = 'new' or v_grade is not null then
      insert into public.phoenix_crm_list_requests (
        seat_id, line_code, kind, customer_id, list_type, customer_name, current_grade, proposed_grade,
        requested_by_hr_id, is_test, stage
      )
      values (v_seat, v_line, 'add', v_customer.id, v_list_type, v_name, null, v_grade, v_actor, v_is_test, v_first_stage)
      returning id into v_request_id;
      v_request_kind := 'add';
    end if;

  -- The `restore` mode was retired on 2026-10-02: it inserted an ACTIVE place onto a customer sitting in
  -- the Archive, with no status check and outside the five-clinic cap. `listed` above is the shape it
  -- should always have had — a customer on the list, by id, `pending` only.
  else
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- 2026-11-07: the three names the rep wrote at the door become the customer's name, through the rep's own
  -- rename (the name key, the contact's name row and the history move exactly as when he saves a name), and a
  -- full name the Super Admin was holding for him is settled by it. Only a listed customer: a new or outside
  -- customer already carries the name he typed.
  if v_full_name is not null and v_mode in ('reference', 'listed')
    and v_full_name is distinct from v_customer.name then
    perform public.phoenix_crm_rename_customer(jsonb_build_object(
      'seat_id', v_seat,
      'actor_hr_id', v_actor,
      'is_test', v_is_test,
      'customer_id', v_customer.id,
      'name', v_full_name,
      'speciality', v_customer.speciality,
      'allow_same_name', true
    ));
  end if;
  if v_full_name is not null and v_mode in ('reference', 'listed') then
    update public.phoenix_crm_customers c
    set full_name_held = null,
        full_name_held_at = null,
        full_name_held_by_hr_id = null,
        full_name_held_score = null,
        full_name_held_board = null,
        updated_at = now()
    where c.id = v_customer.id
      and c.full_name_held is not null;
    select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_customer.id;
  end if;

  -- 2026-10-12: the five-place cap, which this path never had. phoenix_crm_add_place checks it and
  -- then calls phoenix_crm_insert_place; this function called insert_place DIRECTLY, so validating a
  -- listed customer who already holds five clinics added a sixth. Nothing pinned its absence, and the
  -- comment on the retired `restore` mode above has said "outside the five-clinic cap" since
  -- 2026-10-02 about exactly this shape. Production on 2026-10-12 holds no customer at or over the cap
  -- (the most on one is 2), so this is prevention, not a repair. Verbatim from add_place, including the
  -- error name, which src/lib/phoenix-crm/server/db.ts already answers 409 "A customer can have at
  -- most five places." for — a new error code would have reached the rep as an unexplained failure.
  if (select count(*) from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active') >= 5 then
    raise exception 'phoenix_crm:too_many_places';
  end if;

  v_place := public.phoenix_crm_insert_place(v_customer.id, v_seat, v_actor, v_is_test, p -> 'place');

  if v_hold is not null and v_event = 'customer_validated' then
    v_event := 'validation_held';
  end if;
  -- A seating in a venue still waiting for the Super Admin leaves the customer pending, and the event says
  -- so — never 'customer_validated' for a customer no KPI counts.
  if v_venue_held and v_hold is null and v_customer.status = 'pending' and v_event = 'customer_validated' then
    v_event := 'customer_pending';
  end if;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_event, v_actor,
    jsonb_build_object('mode', v_mode, 'reference_contact_crm_id', v_customer.reference_contact_crm_id)
      || case when v_event = 'customer_pending' then jsonb_build_object('why', 'venue_held', 'shared_place_id', p -> 'place' ->> 'shared_place_id') else '{}'::jsonb end
      || case when v_google is not null then jsonb_build_object('google', v_google) else '{}'::jsonb end,
    v_is_test
  );

  if v_hold is not null then
    insert into public.phoenix_crm_validation_reviews (seat_id, customer_id, place_id, is_test, kind, google, created_by_hr_id)
    values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_is_test, 'validation', v_hold, v_actor)
    returning id into v_review_id;
    -- An outside customer's own event names his arrival; the hold gets its line beside it.
    if v_event <> 'validation_held' then
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, 'validation_held', v_actor, jsonb_build_object('mode', v_mode), v_is_test);
    end if;
  end if;

  if v_request_id is not null then
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_customer.id, v_request_id, 'request_created', v_actor,
      jsonb_build_object('kind', v_request_kind, 'proposed_grade', v_grade, 'stage', v_first_stage), v_is_test
    );
  end if;

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'status', v_customer.status,
    'place_id', v_place ->> 'place_id',
    'captured_at', v_place ->> 'captured_at',
    'restored', false,
    'grade_request_id', v_request_id,
    'request_id', v_request_id,
    'request_kind', v_request_kind,
    'phone', v_customer.phone,
    'held', v_hold is not null,
    'review_id', v_review_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;

-- 2. The Super Admin's approval of a held validation clears the old refusal stamp.
create or replace function public.phoenix_crm_decide_validation_review(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  -- what the rep is told about his own photo (2026-10-08). Accepted null here and REQUIRED by the
  -- service; the column CHECK is what guarantees the value is one of the eight.
  v_reason text := nullif(trim(coalesce(p ->> 'refusal_reason', '')), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_reopened boolean := false;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  -- 🔴 THE ONE EDIT OF THIS MIGRATION (owner, 2026-10-15: "make admin able to reject validation even
  -- if approved before"). A REJECT of an APPROVED review is the undo of that approval and runs the
  -- reject branch below exactly as a held review's rejection does — the place is retired, the
  -- customer goes back to To validate when it was his only one, reopened_at is stamped and the rep is
  -- told what is wrong with his photo. Everything else still raises review_decided: approving an
  -- approved review changes nothing, and a rejected one is reversed by
  -- phoenix_crm_restore_validation, which checks the place is still retired before it brings it back.
  if not (v_review.status = 'approved' and v_decision = 'reject') and v_review.status <> 'pending' then
    raise exception 'phoenix_crm:review_decided';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  if v_decision = 'approve' then
    update public.phoenix_crm_validation_reviews
    set status = 'approved', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note
    where id = v_id;

    if v_review.kind = 'validation' and v_customer.status = 'pending' and v_place.status = 'active' then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_review.created_by_hr_id,
          -- 2026-11-14 (validation audit): validated, so nothing waits to be captured again.
          reopened_at = null,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;
      v_validated := true;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'Validated instead of dropped'
        where q.seat_id = v_review.seat_id
          and q.is_test = v_review.is_test
          and q.kind = 'drop'
          and q.status = 'pending'
          and (
            q.customer_id = v_customer.id
            or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
          )
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_review.seat_id, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_review.is_test
      from withdrawn w;
    end if;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_approved', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated), v_review.is_test
    );
  else
    update public.phoenix_crm_validation_reviews
    set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note,
        refusal_reason = v_reason
    where id = v_id;

    if v_place.status = 'active' then
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_place.id;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_review.seat_id, v_customer.id, v_place.id, 'place_retired', v_actor,
        jsonb_build_object('reason', coalesce(v_note, 'The location could not be confirmed against Google Maps.'), 'label', v_place.label,
          'lat', v_place.lat, 'lon', v_place.lon, 'why', 'validation_rejected'),
        v_review.is_test
      );
    end if;

    if v_customer.status = 'active' and not exists (
      select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active'
    ) then
      update public.phoenix_crm_customers c
      set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
      where c.id = v_customer.id;
      v_reopened := true;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
      values (v_review.seat_id, v_customer.id, 'customer_pending', v_actor,
        jsonb_build_object('reference_contact_crm_id', v_customer.reference_contact_crm_id, 'why', 'validation_rejected'), v_review.is_test);
    end if;

    -- he is waiting to capture this place again, from now (2026-10-08).
    -- 🔴 c.status is read from the TABLE, deliberately, so it sees the reopen above; and this fires
    -- for a customer who was ALREADY pending (a held first validation), which v_reopened never does.
    update public.phoenix_crm_customers c
    set reopened_at = now(), updated_at = now()
    where c.id = v_customer.id and c.status = 'pending';

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_rejected', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'reopened', v_reopened, 'refusal_reason', v_reason), v_review.is_test
    );
  end if;

  return jsonb_build_object(
    'review_id', v_id,
    'status', case when v_decision = 'approve' then 'approved' else 'rejected' end,
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'reopened', v_reopened,
    -- so the service notifies the rep without a second read. rep_hr_id is the rep who VALIDATED,
    -- never the person deciding: he is the one whose photo this is.
    'rep_hr_id', v_review.created_by_hr_id,
    'customer_name', v_customer.name,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_validation_review(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_validation_review(jsonb) to service_role;

-- 3. The trusted point withdraws a pending drop request, clears the stamp and upper-cases the actor.
create or replace function public.phoenix_crm_place_on_trusted_point(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
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
        reopened_at = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;

    -- 2026-11-14 (validation audit): a drop request still open on him is withdrawn, exactly as the rep's own
    -- validation and the approval of a held one withdraw it. This door validated him and left it standing.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          stage = null,
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Validated instead of dropped'
      where q.seat_id = v_seat
        and q.is_test = v_is_test
        and q.kind = 'drop'
        and q.status = 'pending'
        and (
          q.customer_id = v_customer.id
          or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
        )
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
    from withdrawn w;

    v_event := 'customer_validated';
  else
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

revoke execute on function public.phoenix_crm_place_on_trusted_point(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_place_on_trusted_point(jsonb) to service_role;

-- 4. A place seated in a building is written with no pin reading.
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
    -- 2026-11-14 (validation audit): a seating has NO reading of its own. The building's point is already in
    -- lat/lon above; copied into the pin as well, it read as a second reading taken at this customer's own
    -- place. Null, exactly as the Super Admin's move leaves it (phoenix_crm_seat_places_in_venue).
    case when v_source = 'shared_place' then null else coalesce((p_place ->> 'pin_lat')::double precision, (p_place ->> 'lat')::double precision) end,
    case when v_source = 'shared_place' then null else coalesce((p_place ->> 'pin_lon')::double precision, (p_place ->> 'lon')::double precision) end,
    case when v_source = 'shared_place' then null else coalesce((p_place ->> 'pin_accuracy_meters')::numeric, (p_place ->> 'accuracy_meters')::numeric) end,
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

notify pgrst, 'reload schema';

commit;
