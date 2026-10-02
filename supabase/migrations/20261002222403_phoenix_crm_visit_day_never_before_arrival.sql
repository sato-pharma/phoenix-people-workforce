-- Phoenix CRM — a visit never lands on a visit day EARLIER than the one it arrived on.
--
-- Found by the 2026-10-02 Phoenix CRM audit. Two paths could move a visit across the 02:00 cutoff
-- and file it as YESTERDAY's work:
--
--   1. The photo slot. `phoenix_crm_take_photo` returns the slot's ISSUE time and a slot lives two
--      hours, so a save arriving at 02:30 Cairo can be dated 01:00 — which is the previous visit
--      day (owner, 2026-09-29: "the visits of today are entered today, maximum 2 AM").
--   2. A reused place photo. `reuse_place_photo` dates the visit from the PLACE's captured_at, which
--      is itself that photo's slot issue time, and the place need only have been created in the last
--      thirty minutes — so up to two and a half hours can separate the date from the arrival.
--
-- Both are API-only: the web visit form sends no photo at all (the one-tap visit, 2026-09-29) and
-- the app sends its own. Neither needed the reach — a slot proves WHEN THE PHOTO WAS TAKEN, and it
-- was never evidence of which day the work belongs to. Yesterday is a day whose plan is closed and
-- whose figures have been read, and visit_date is what the one-a-day key, the planned-or-not verdict
-- and every report follow.
--
-- WHAT CHANGES: exactly one block in `phoenix_crm_save_visit`. When the SLOT dated the visit and
-- that date falls on an earlier visit day than now(), the visit is dated at arrival instead and
-- capture_source becomes 'server'. SILENTLY — the visit is real and is never refused, and no rep is
-- told a check exists (Phoenix CRM Golden Rule #1).
--
-- WHAT DOES NOT CHANGE: the offline anchor. It is the ONE path that may reach back, deliberately,
-- because the server brackets the claim at both ends with its own two readings — and since this
-- change's TypeScript half, only the app may make the claim at all
-- (src/lib/phoenix-crm/server/capture-client.ts). An offline capture of 19:00 synced at 02:30 is
-- still filed under the 19:00 day, which is the whole point of that feature. The Super Admin's
-- `phoenix_crm_admin_enter_visit` is a different function and is untouched: entering a visit a rep
-- missed logging, on a day he chooses, is exactly what it is for.
--
-- The body below is the live 20261002205436 definition with ONE block inserted and NOTHING else —
-- extracted from that migration and patched in place rather than retyped, so no other rule can drift.
--
-- Rollback: re-run 20261002205436's function block. No column, constraint, table or row changes here,
-- so nothing else has to be undone.

-- One transaction, a 5s lock ceiling, and PostgREST told to re-read the schema (the module contract).
begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_save_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_kind text := coalesce(p ->> 'kind', '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  -- The line's product manager who came along (owner, 2026-10-02). WHETHER he is one of the line's is
  -- settled by the caller before it gets here: he holds no seat in the organogram, so there is nothing
  -- in this database to check him against (src/lib/phoenix-crm/server/visits.ts loadLineProductManagers).
  v_product_manager text := upper(nullif(trim(coalesce(p ->> 'product_manager_hr_id', '')), ''));
  -- Optional since 2026-09-29: the one-tap Log visit sends none, and the server's clock dates it.
  v_photo text := nullif(trim(coalesce(p ->> 'photo_path', '')), '');
  v_reuse boolean := coalesce((p ->> 'reuse_place_photo')::boolean, false);
  v_place_id uuid := nullif(p ->> 'place_id', '')::uuid;
  v_flag text := coalesce(p ->> 'location_flag', '');
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_pharmacy text := nullif(trim(coalesce(p ->> 'pharmacy_name', '')), '');
  v_availability jsonb := coalesce(p -> 'product_availability', '{}'::jsonb);
  -- E2: what he handed over. Narrowed to the line's own products by the caller, exactly as
  -- product_availability is; here it only has to be a bag and not too big a one.
  v_samples jsonb := coalesce(p -> 'samples_given', '{}'::jsonb);
  -- D3: digits only, so a phone sending "abc" lands as null rather than raising. `::integer` on a
  -- free-text value would abort the whole save, and no rep loses a visit over a stopwatch.
  v_form_open integer := least(
    coalesce(nullif(regexp_replace(coalesce(p ->> 'form_open_seconds', ''), '[^0-9]', '', 'g'), '')::bigint, 0),
    7200
  )::integer;
  v_dwell integer;
  v_voice text := nullif(trim(coalesce(p ->> 'voice_note_path', '')), '');
  v_voice_seconds integer := nullif(p ->> 'voice_note_seconds', '')::integer;
  v_voice_bytes integer := nullif(p ->> 'voice_note_bytes', '')::integer;
  -- The rep's "why I went", and where his approval starts when he went off plan.
  v_clarification text := nullif(regexp_replace(trim(coalesce(p ->> 'unplanned_reason', '')), '\s+', ' ', 'g'), '');
  -- E3: the outcome. Read here and validated below rather than trusted, because the ONLY thing the
  -- caller is allowed to do with a value it does not recognise is drop it.
  v_next_step text := nullif(btrim(p ->> 'next_step'), '');
  v_next_step_on date := nullif(p ->> 'next_step_on', '')::date;
  v_objection text := nullif(btrim(p ->> 'objection'), '');
  v_objection_note text := nullif(regexp_replace(trim(coalesce(p ->> 'objection_note', '')), '\s+', ' ', 'g'), '');
  v_first_stage text := coalesce(p ->> 'unplanned_first_status', 'manager_pending');
  v_reviewer text := upper(nullif(trim(coalesce(p ->> 'reviewer_hr_id', '')), ''));
  v_on_sent_plan boolean;
  v_unplanned_kind text;
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_captured_at timestamptz;
  v_date date;
  -- A1: the offline path. `offline_captured_at` is derived IN TYPESCRIPT by
  -- src/lib/phoenix-crm/offline-clock.ts from a server-minted anchor plus elapsed MONOTONIC time,
  -- and passed in by saveVisit. 🔴 It is NEVER copied from the request body — the phone sends a
  -- duration and an anchor id, never a timestamp. The two bounds below are a second fence here.
  v_offline_at timestamptz := nullif(p ->> 'offline_captured_at', '')::timestamptz;
  v_anchor_id uuid := nullif(p ->> 'time_anchor_id', '')::uuid;
  v_offline_seconds integer;
  v_source text := 'server';
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_customer_id is null
    or v_kind not in ('single', 'double', 'product_manager', 'chain')
    or v_flag not in ('ok', 'far', 'weak_gps', 'no_place')
    or v_first_stage not in ('manager_pending', 'sfe_pending')
    or (v_pharmacy is not null and char_length(v_pharmacy) > 120)
    or (v_reuse and v_photo is null) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_availability) <> 'object' then
    v_availability := '{}'::jsonb;
  end if;
  -- E2: dropped, never raised. A bag of junk keys costs the rep nothing; the column's own CHECK
  -- would otherwise refuse the whole visit over a field that is not the visit.
  if jsonb_typeof(v_samples) <> 'object' or (select count(*) from jsonb_object_keys(v_samples)) > 20 then
    v_samples := '{}'::jsonb;
  end if;

  -- E3: an unknown value is DROPPED, never raised. The dependants go with their parent, so the row
  -- can never say "by 30 Sept" under "Nothing to follow".
  if v_next_step is not null and v_next_step not in ('follow_up', 'send_data', 'arrange_double', 'invite_event', 'pharmacy_stock', 'none') then
    v_next_step := null;
  end if;
  if v_next_step is null or v_next_step = 'none' then
    v_next_step_on := null;
  end if;
  if v_objection is not null and v_objection not in ('price', 'efficacy', 'safety', 'competitor', 'formulary', 'no_time', 'none') then
    v_objection := null;
  end if;
  if v_objection is null or v_objection = 'none' then
    v_objection_note := null;
  else
    v_objection_note := left(v_objection_note, 300);
  end if;
  -- A product manager rides in his OWN slot and in no other: never as the manager, which is the
  -- district manager and is what every board counts `double_visits` from, and never on a kind that did
  -- not ask for him.
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and v_senior is not null)
    or (v_kind = 'product_manager' and v_rep is not null and v_manager is null and v_senior is null and v_product_manager is not null)
  ) or (v_kind <> 'product_manager' and v_product_manager is not null)
    or (v_product_manager is not null and v_product_manager = coalesce(v_rep, '')) then
    raise exception 'phoenix_crm:bad_participants';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  if not found then
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));
    -- A retry racing its own first attempt waits on the lock, then finds it here.
    select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  end if;
  if found then
    if v_existing.seat_id <> v_seat or v_existing.entered_by_hr_id <> v_actor then
      raise exception 'phoenix_crm:id_conflict';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'visit_date', v_existing.visit_date,
      'captured_at', v_existing.captured_at,
      'customer_id', v_existing.customer_id,
      'is_unplanned', v_existing.is_unplanned,
      'unplanned_kind', v_existing.unplanned_kind,
      'duplicate', true
    );
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  -- A pending customer (carried over, not validated yet) and one met outside the list (validated at
  -- the door, waiting to be admitted) are both real, visitable customers. Only a customer in the
  -- Archive is refused here — "This customer has left the list."
  if v_customer.status not in ('active', 'pending', 'outside') then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if v_place_id is not null and not exists (
    select 1 from public.phoenix_crm_places pl where pl.id = v_place_id and pl.customer_id = v_customer.id
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  if v_photo is null then
    -- THE ONE-TAP VISIT (owner, 2026-09-29): no photo, and the server's own clock dates it at the
    -- moment it arrives. The phone never states a time.
    v_captured_at := now();
    v_source := 'server';
  elsif v_reuse then
    select pl.captured_at into v_captured_at
    from public.phoenix_crm_places pl
    where pl.photo_path = v_photo
      and pl.customer_id = v_customer.id
      and pl.created_by_hr_id = v_actor
      and pl.is_test = v_is_test
      and pl.created_at > now() - interval '30 minutes';
    if not found then
      raise exception 'phoenix_crm:photo_not_issued';
    end if;
    if exists (select 1 from public.phoenix_crm_visits v where v.photo_path = v_photo) then
      raise exception 'phoenix_crm:photo_used';
    end if;
    v_source := 'slot';
  else
    v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test);
    v_source := 'slot';
  end if;

  -- 🔴 A PHOTO SLOT CANNOT REACH BACK PAST 02:00 INTO YESTERDAY'S VISIT DAY (2026-10-02).
  --
  -- A visit slot lives two hours (phoenix_crm_take_photo) and a reused place photo adds its own
  -- thirty-minute window on top of that, so a save arriving at 02:30 can carry an issue time of
  -- 01:00 — and THE VISIT DAY ENDS AT 02:00 (owner, 2026-09-29), so the row would be filed, counted
  -- and read as YESTERDAY's: a day whose plan is closed and whose figures have been read. A slot
  -- proves WHEN THE PHOTO WAS TAKEN. It was never evidence of which day the work belongs to, and the
  -- one-a-day key, the planned-or-not verdict and every report follow visit_date.
  --
  -- The offline anchor is the ONE path allowed to reach back, and it earns it twice over: the server
  -- brackets the claim at BOTH ends with its own two readings, and only the app can make the claim at
  -- all (src/lib/phoenix-crm/server/capture-client.ts).
  --
  -- Silently, never as a refusal (Golden Rule #1): the visit is real, so it is dated at arrival. The
  -- row then reads capture_source 'server' beside a photo_path, which is how the board can see that
  -- the slot's own time was not used — and dwell_seconds stays null rather than a made-up zero.
  if v_source = 'slot'
     and ((v_captured_at - interval '2 hours') at time zone 'Africa/Cairo')::date
       < ((now() - interval '2 hours') at time zone 'Africa/Cairo')::date then
    v_captured_at := now();
    v_source := 'server';
  end if;

  -- A1 · THE OFFLINE CAPTURE TIME. Two fences, both one-sided in the safe direction: never later than
  -- now(), never older than a day. Outside them the value is DROPPED and the visit is dated at arrival
  -- — never refused, and never explained to the rep.
  if v_offline_at is not null
     and v_offline_at <= now()
     and v_offline_at > now() - interval '1 day' then
    v_offline_seconds := greatest(floor(extract(epoch from (now() - v_offline_at)))::bigint, 0)::integer;
    v_captured_at := v_offline_at;
    v_source := 'offline_anchor';
  end if;

  -- THE VISIT DAY ENDS AT 02:00 (owner, 2026-09-29): "the visits of today are entered today, maximum
  -- 2 AM". A visit logged at 01:30 on Tuesday is Monday's; one at 02:00 is Tuesday's. The same
  -- arithmetic is src/lib/phoenix-crm/calendar.ts cairoBusinessDay, pinned by a test on both sides.
  v_date := ((v_captured_at - interval '2 hours') at time zone 'Africa/Cairo')::date;

  -- D3: how long the door photo has been in hand. Meaningful only when a photo slot dated the visit
  -- and the save followed the shutter by seconds — so NULL for the one-tap visit and for an offline
  -- one, never a number made up for them.
  v_dwell := case
    when v_source <> 'slot' then null
    else least(greatest(floor(extract(epoch from (now() - v_captured_at)))::bigint, 0), 7200)::integer
  end;

  if exists (
    select 1
    from public.phoenix_crm_visits v
    where v.seat_id = v_seat
      and v.customer_id = v_customer.id
      and v.visit_date = v_date
      and v.is_test = v_is_test
  ) then
    raise exception 'phoenix_crm:already_visited';
  end if;

  -- WAS HE PLANNED? The plan's status AS OF this visit's server-issued captured_at — the latest event
  -- wins, the shape phoenix_crm_report_plan_vs_actual's own sent_days uses. A draft or returned plan
  -- is the rep's to edit and is never authority. A manager's own single visit (no rep on it) was never
  -- on anybody's plan and belongs to nobody's call rate, so it is never raised for approval.
  --
  -- STILL PLANNED (owner, 2026-10-02). A week a reviewer returned for ONE day is still authority on
  -- every OTHER day: only the returned day waits for the rep to send the week again. That return is the
  -- latest event — to 'returned', with `returned_day` in its details (phoenix_crm_plan_transition) — and
  -- it counts for the days it left as sent until an edit request is acknowledged AFTER it: that
  -- acknowledgement opens the whole week to the rep (plan-rules.ts `standingReturnedDay`), and a day he
  -- can change is never authority. A week returned whole carries no day, and stays no authority at all.
  -- plan-rules.ts `planDayStatus` is this rule for every screen that asks.
  v_on_sent_plan := v_rep is null or exists (
    select 1
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = v_seat
      and pl.is_test = v_is_test
      and i.plan_date = v_date
      and i.customer_id = v_customer.id
      and (
        select e.to_status
        from public.phoenix_crm_plan_events e
        where e.plan_id = pl.id
          and e.to_status is not null
          and e.created_at <= v_captured_at
        order by e.created_at desc, e.id desc
        limit 1
      ) in ('submitted', 'approved')
  ) or exists (
    select 1
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = v_seat
      and pl.is_test = v_is_test
      and i.plan_date = v_date
      and i.customer_id = v_customer.id
      and v_date <> (
        select case
          when e.to_status = 'returned'
            and not exists (
              select 1
              from public.phoenix_crm_plan_edit_requests r
              where r.plan_id = pl.id
                and r.hr_acknowledged_at > e.created_at
                and r.hr_acknowledged_at <= v_captured_at
            )
          then nullif(e.details ->> 'returned_day', '')::date
        end
        from public.phoenix_crm_plan_events e
        where e.plan_id = pl.id
          and e.to_status is not null
          and e.created_at <= v_captured_at
        order by e.created_at desc, e.id desc
        limit 1
      )
  );

  -- Out of list: a customer the rep met and validated at the door. The district manager and SFE
  -- approve the CUSTOMER, not this visit, so no reason is asked and no approval row is raised; the
  -- visit counts once he is admitted, because every report joins his validated_at.
  if v_customer.status = 'outside' then
    v_on_sent_plan := false;
    v_unplanned_kind := 'out_of_list';
  elsif not v_on_sent_plan then
    v_unplanned_kind := 'out_of_plan';
    if v_clarification is null or char_length(v_clarification) < 10 or char_length(v_clarification) > 500 then
      raise exception 'phoenix_crm:clarification_required';
    end if;
  end if;

  -- The voice note, when there is one. It happens AFTER v_date is settled, so nothing it does can
  -- reach the date; phoenix_crm_take_voice returns VOID, so there is no value here to date it with.
  if v_voice is not null then
    perform public.phoenix_crm_take_voice(v_voice, v_actor, v_seat, v_is_test);
  end if;

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, product_manager_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability, photo_path, lat, lon,
    accuracy_meters, place_id, distance_meters, location_flag, device_skew_minutes, is_test,
    voice_note_path, voice_note_seconds, voice_note_bytes, is_unplanned, unplanned_kind,
    next_step, next_step_on, objection, objection_note,
    samples_given,
    dwell_seconds, form_open_seconds,
    capture_source, time_anchor_id, offline_seconds, synced_at,
    photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
    v_senior, v_product_manager, v_actor, v_products, v_comment, v_pharmacy, v_availability, v_photo,
    (p ->> 'lat')::double precision,
    (p ->> 'lon')::double precision,
    (p ->> 'accuracy_meters')::numeric,
    v_place_id,
    (p ->> 'distance_meters')::integer,
    v_flag,
    (p ->> 'device_skew_minutes')::integer,
    v_is_test,
    v_voice, v_voice_seconds, v_voice_bytes, not v_on_sent_plan, v_unplanned_kind,
    v_next_step, v_next_step_on, v_objection, v_objection_note,
    v_samples,
    -- A zero form_open is "the page said nothing", not "he was there no time": stored as null.
    v_dwell, nullif(v_form_open, 0),
    -- synced_at is the server's own receipt and is stamped for EVERY visit.
    v_source, case when v_source = 'offline_anchor' then v_anchor_id else null end, v_offline_seconds, now(),
    -- The photo's own reading, when a photo was taken. NULL is NOT MEASURED, never "same place".
    (p ->> 'photo_lat')::double precision,
    (p ->> 'photo_lon')::double precision,
    (p ->> 'photo_accuracy_meters')::numeric,
    nullif(p ->> 'photo_captured_at', '')::timestamptz
  );

  if v_unplanned_kind = 'out_of_plan' then
    insert into public.phoenix_crm_unplanned_visits (
      visit_id, seat_id, line_code, rep_hr_id, entered_by_hr_id, customer_id, visit_date,
      clarification, status, manager_hr_id, is_test
    )
    values (
      v_id, v_seat, v_line, coalesce(v_rep, v_actor), v_actor, v_customer.id, v_date,
      v_clarification, v_first_stage, v_reviewer, v_is_test
    );
    insert into public.phoenix_crm_unplanned_visit_events (visit_id, event_type, actor_hr_id, to_status, version, note)
    values (v_id, 'raised', v_actor, v_first_stage, 1, v_clarification);
  end if;

  return jsonb_build_object(
    'id', v_id,
    'visit_date', v_date,
    'captured_at', v_captured_at,
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'is_unplanned', not v_on_sent_plan,
    'unplanned_kind', v_unplanned_kind,
    'capture_source', v_source,
    'duplicate', false
  );
end;
$$;
-- `create or replace` keeps the ACL, but the migration contract requires every recreated public
-- SECURITY DEFINER function to restate it: anon and authenticated inherit EXECUTE through PUBLIC, so
-- revoking only those two is a no-op, and revoking PUBLIC on a default ACL also strips service_role.
revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;

comment on function public.phoenix_crm_save_visit(jsonb) is
  'The ONE writer of a Phoenix CRM visit. Since 2026-10-02 a visit whose PHOTO SLOT would date it on '
  'an earlier visit day than the save arrived on is dated at arrival instead (capture_source '
  'server), silently: a slot lives two hours and a reused place photo longer, and the 02:00 cutoff '
  'made that a visit filed as yesterday''s. The offline anchor still dates a visit before arrival, '
  'which is what it is for.';

-- Without this PostgREST keeps its old schema cache, and the app reads the new shape as missing.
notify pgrst, 'reload schema';

commit;
