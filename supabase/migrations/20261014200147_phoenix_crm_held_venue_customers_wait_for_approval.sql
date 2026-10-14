-- phoenix_crm_held_venue_customers_wait_for_approval
--
-- WHAT THIS CHANGES: three function bodies, no row rewritten.
--   phoenix_crm_validate_customer     a seating in a venue whose status is 'held' leaves the customer PENDING
--                                     (his place is saved, he can be planned, sent and visited) instead of
--                                     validating him. Event: customer_pending, why venue_held.
--   phoenix_crm_decide_shared_place   APPROVING a venue confirms every customer seated in it who is pending,
--                                     unless the building has no timetable on file, the timetable was read as
--                                     another name / no schedule, or the customer's own location is waiting on
--                                     a validation review. Returns the confirmed customers as 'validated'.
--   phoenix_crm_settle_venue_timetable  a board that names a customer no longer releases him while his venue is
--                                     still held.
-- WHY: owner, 2026-10-14. 20261014151354 let a rep seat customers in a venue the system was still checking, and
--   the customer was validated at once, so his visits counted in every KPI before anybody had confirmed the
--   building. The owner's ruling: the visits appear, pending, and count in no KPI "until the admin confirm the
--   polyclinic and the doctors in it". Every KPI already reads customer_validated, so holding the customer
--   pending is the whole mechanism (the same one the Super Admin's own move into a venue with no board uses).
-- NOT CHANGED: a rejection still retires the venue and every place seated in it; an 'outside' customer (the
--   'new' door) is not validated at seating and still joins through his add request; a customer who is already
--   validated at his own clinic and ALSO receives in a polyclinic (phoenix_crm_add_place) keeps his validation.
--   No data is rewritten: production holds one active seated place in a held venue and that customer is
--   'outside', which no KPI counts.
-- DIGESTS: the three bodies below are the live bodies (md5 of pg_proc.prosrc, read off production 2026-10-14:
--   validate_customer 8dd2c45c5bd3b354a3c67dc0a129238a, decide_shared_place 7d648e28f805ba9ae244693c0eea935d,
--   settle_venue_timetable 412c565c0bab71b9371af07474e17931) with only the changes named above.
-- ROLLBACK: re-run the create or replace function statements from 20261012090000 (validate_customer),
--   20261010013001 (decide_shared_place) and 20261010210000 (settle_venue_timetable). Customers left pending by
--   this change are released by approving their venue, or by the Super Admin's own decision.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Rewrites no row; function bodies only.

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

create or replace function public.phoenix_crm_decide_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'shared_place_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_reason text := nullif(trim(coalesce(p ->> 'refusal_reason', '')), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_seated record;
  v_reopened jsonb := '[]'::jsonb;
  v_places integer := 0;
  v_validated jsonb := '[]'::jsonb;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id;
  if not found then
    raise exception 'phoenix_crm:shared_place_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_venue.seat_id));
  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id for update;
  if v_venue.status = 'retired' then
    raise exception 'phoenix_crm:shared_place_retired';
  end if;

  if v_decision = 'approve' then
    update public.phoenix_crm_shared_places
    set status = 'active', decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note,
        refusal_reason = null, updated_at = now()
    where id = v_id;

    -- 🔴 APPROVING THE BUILDING CONFIRMS THE DOCTORS WAITING IN IT (owner, 2026-10-14: a visit to a doctor in
    -- a building the system was still checking counts in no KPI "until the admin confirm the polyclinic and
    -- the doctors in it"). A seating in a held venue left each customer pending
    -- (phoenix_crm_validate_customer); this is the one place that releases them. It is NOT a blanket
    -- validation: a building with no timetable on file, a timetable read as another name or as no
    -- schedule, and a customer whose own location is waiting on a validation review all STAY pending — the
    -- same three holds phoenix_crm_settle_venue_timetable keeps. `unjudged` and an unread board never hold
    -- (owner, 2026-10-08), so they are confirmed here.
    for v_seated in
      select pl.id as place_id, pl.customer_id, pl.schedule_check, pl.is_test, c.name as customer_name
      from public.phoenix_crm_places pl
      join public.phoenix_crm_customers c on c.id = pl.customer_id
      where pl.shared_place_id = v_id and pl.status = 'active' and c.status = 'pending'
      order by pl.created_at
    loop
      if v_venue.schedule_photo_path is null
        or (v_seated.schedule_check ->> 'verdict') in ('other_name', 'no_schedule')
        or exists (
          select 1 from public.phoenix_crm_validation_reviews r
          where r.customer_id = v_seated.customer_id and r.status = 'pending'
        ) then
        continue;
      end if;

      update public.phoenix_crm_customers c
      set status = 'active', validated_at = now(), validated_by_hr_id = v_actor, status_changed_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';
      if found then
        insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'customer_validated', v_actor,
          jsonb_build_object('why', 'shared_place_approved', 'shared_place_id', v_id, 'shared_place_name', v_venue.name),
          v_seated.is_test
        );
        v_validated := v_validated || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id, 'customer_name', v_seated.customer_name, 'place_id', v_seated.place_id
        ));
      end if;
    end loop;
  else
    update public.phoenix_crm_shared_places
    set status = 'retired', decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note,
        refusal_reason = v_reason, retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
    where id = v_id;

    -- Every customer seated in a rejected venue goes back to To validate, exactly as a rejected place
    -- of his own would send him — place retired, customer pending when he has no other active place,
    -- `reopened_at` stamped so he is first in the rep's To validate order.
    for v_seated in
      select pl.id as place_id, pl.customer_id, pl.label, pl.lat, pl.lon, pl.is_test, pl.created_by_hr_id, c.name as customer_name
      from public.phoenix_crm_places pl
      join public.phoenix_crm_customers c on c.id = pl.customer_id
      where pl.shared_place_id = v_id and pl.status = 'active'
      order by pl.created_at
      -- NO `for update` row lock on the cursor, by choice: each row is locked by the `update` that
      -- retires it two lines below, the whole function runs in one transaction behind an advisory
      -- `lock_timeout`, and a venue is decided by one administrator at a time. (It also keeps the
      -- migration-hygiene sweep honest — it reads `for update of pl, c` and `for update\nloop` as
      -- writes to tables called `of` and `loop`.)
    loop
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_seated.place_id;
      v_places := v_places + 1;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'place_retired', v_actor,
        jsonb_build_object(
          'reason', coalesce(v_note, 'This place could not be confirmed.'),
          'label', v_seated.label, 'lat', v_seated.lat, 'lon', v_seated.lon,
          'why', 'shared_place_rejected', 'shared_place_id', v_id
        ),
        v_seated.is_test
      );

      if not exists (
        select 1 from public.phoenix_crm_places pl where pl.customer_id = v_seated.customer_id and pl.status = 'active'
      ) then
        update public.phoenix_crm_customers c
        set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
        where c.id = v_seated.customer_id and c.status = 'active';
        insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, 'customer_pending', v_actor,
          jsonb_build_object('why', 'shared_place_rejected', 'shared_place_id', v_id), v_seated.is_test
        );
      end if;

      -- 🔴 Read from the TABLE, deliberately, so it sees the reopen above — and it fires for a
      -- customer who was already pending, which the branch above never does.
      update public.phoenix_crm_customers c
      set reopened_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';

      -- Who the service tells, and about whom. The rep is the one who captured the TIMETABLE, never
      -- the person deciding: it is his photo.
      if exists (select 1 from public.phoenix_crm_customers c where c.id = v_seated.customer_id and c.status = 'pending') then
        v_reopened := v_reopened || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id,
          'customer_name', v_seated.customer_name,
          'rep_hr_id', v_seated.created_by_hr_id,
          'is_test', v_seated.is_test
        ));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'shared_place_id', v_id,
    'status', case when v_decision = 'approve' then 'active' else 'retired' end,
    'seat_id', v_venue.seat_id,
    'is_test', v_venue.is_test,
    'name', v_venue.name,
    'places_retired', v_places,
    'validated', v_validated,
    'reopened', v_reopened,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_shared_place(jsonb) to service_role;

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
