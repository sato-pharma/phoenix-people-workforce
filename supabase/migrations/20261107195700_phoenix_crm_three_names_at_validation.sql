-- phoenix_crm_three_names_at_validation
--
-- WHAT THIS CHANGES: one function body and one CHECK, no row rewritten.
--   phoenix_crm_validate_customer   takes an optional 'full_name'. For a listed customer (modes 'reference' and
--                                   'listed') it renames him to it through phoenix_crm_rename_customer — the
--                                   same call phoenix_crm_decide_full_name makes — and clears a full name the
--                                   Super Admin was holding for him, inside the validation's own transaction.
--   phoenix_crm_validation_reviews  refusal_reason CHECK gains a ninth key, 'short_name': a validation sent back
--                                   because the customer still carries only one or two names.
-- WHY: owner, 2026-11-07: validations were arriving holding only two names, and the visit save then refused
--   the same customer for his short name. "Don't accept from the beginning the two names. Must enter the three
--   names." The app now asks for the first, middle and last name at validation and sends them here; one
--   step, not two. Place checks cannot approve a clinic customer with a short name; he is sent back with
--   'short_name' (his choice for the validations already waiting).
-- NOT CHANGED: the venue CHECK phoenix_crm_shared_places_refusal_reason_check (a building has no person's
--   name); the 'new' and 'outside' modes; a caller that sends no 'full_name' gets exactly the old function.
-- DIGESTS: the function body below is the 20261014200147 body (live md5(prosrc) 32d1dd0f968ffaca89210e2731819aa2
--   on staging and production, 2026-11-07) with only the two additions named above.
-- ROLLBACK: re-run the phoenix_crm_validate_customer statement from 20261014200147, then drop and re-add
--   phoenix_crm_validation_reviews_refusal_reason with the eight keys of 20261010013001 — only while no
--   row carries refusal_reason = 'short_name'. A name written by a validation stays; it is the rep's own rename.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Rewrites no row; one function body and one constraint.

begin;

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
    if v_ref.customer_id is not null and exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.customer_id = v_ref.customer_id and r.status = 'pending'
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
    if exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.customer_id = v_customer.id and r.status = 'pending'
    ) then
      raise exception 'phoenix_crm:location_in_review';
    end if;

    if v_validate_now then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_actor,
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

    if v_mode = 'new' then
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

alter table public.phoenix_crm_validation_reviews
  drop constraint if exists phoenix_crm_validation_reviews_refusal_reason;
alter table public.phoenix_crm_validation_reviews
  add constraint phoenix_crm_validation_reviews_refusal_reason check (
    refusal_reason is null or refusal_reason in (
      'no_signboard', 'wrong_name', 'too_dark', 'not_at_door', 'photo_of_paper', 'point_off',
      'schedule_other_name', 'schedule_missing', 'short_name'
    )
  );

commit;
