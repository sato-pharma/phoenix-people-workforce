-- phoenix_crm_one_tap_visit
--
-- WHAT THIS CHANGES (owner rulings, 2026-09-29 — the rep's flow rebuilt):
--   1. A visit needs NO photo. "Log visit" is one tap: the server stamps the time (capture_source
--      'server') and the GPS reading the page took silently is stored beside it. phoenix_crm_visits.
--      photo_path loses NOT NULL; a caller that still sends a photo is served exactly as before, slot
--      and all.
--   2. The visit's DAY ends at 02:00, not midnight: "only today's visits, until 2 AM the next
--      morning". visit_date is the Cairo date of (capture time − 2 hours). Never a past day, never a
--      future day — the day is always the server's own.
--   3. An OUT-OF-LIST visit: to a customer the rep met and validated at the door who is not on his
--      list yet (status `outside`). It needs no off-plan approval — the district manager and SFE
--      approve the CUSTOMER instead — and it counts only once he is admitted, in the month it
--      happened, because every report counts a customer's visits only once validated_at is set.
--      unplanned_kind records which of the two off-plan kinds a visit is: out_of_plan | out_of_list.
--   4. The photo's own reading (photo_lat/photo_lon/photo_accuracy_meters/photo_captured_at, added
--      2026-09-29) is finally WRITTEN — the columns existed and the save function never filled them.
--   5. phoenix_crm_countable_visits admits an out-of-list visit (its customer's validated_at does the
--      rest), and day activities gain `sales_day`.
--
-- WHY: the owner, 2026-09-29 — "the medical rep just presses; in the back end we take his location",
--   and "the visits of today are entered today, maximum 2 AM".
--
-- ROLLBACK:
--   re-apply 20260927200000_phoenix_crm_offline_capture.sql (save_visit) and
--   20260926193000_phoenix_crm_day_activities.sql (save_day_activity) and 20260926163000's view;
--   photo_path NOT NULL can only be restored once no visit without a photo exists.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. The visit's columns ───────────────────────────────────────────────────────────────────────

alter table public.phoenix_crm_visits alter column photo_path drop not null;

alter table public.phoenix_crm_visits
  add column if not exists unplanned_kind text;

-- Every off-plan visit saved before today was one to a customer on the rep's list.
update public.phoenix_crm_visits v
set unplanned_kind = 'out_of_plan'
where v.is_unplanned
  and v.unplanned_kind is null;

alter table public.phoenix_crm_visits drop constraint if exists phoenix_crm_visits_unplanned_kind;
alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_unplanned_kind check (
    (unplanned_kind is null or unplanned_kind in ('out_of_plan', 'out_of_list'))
    and (unplanned_kind is null) = (not is_unplanned)
  );

-- SAFE: widening a CHECK to admit the server's own clock; every existing row already satisfies it.
alter table public.phoenix_crm_visits drop constraint if exists phoenix_crm_visits_capture_source;
alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_capture_source check (capture_source in ('slot', 'offline_anchor', 'server'));

comment on column public.phoenix_crm_visits.capture_source is
  'Which clock dated this visit: server (the one-tap Log visit — the server''s own now()), slot (a photo slot the server issued at that moment) or offline_anchor (a server-minted anchor plus elapsed monotonic time).';
comment on column public.phoenix_crm_visits.unplanned_kind is
  'Why an off-plan visit was off the plan: out_of_plan (a customer on his list, not on today''s sent plan — needs the manager then SFE) or out_of_list (a customer met and validated at the door — counts once the customer is admitted). Null on a planned visit.';

-- ── 2. The one predicate for "does this visit count" ─────────────────────────────────────────────
-- Recreated with the same shape: security_invoker, every visit column (select v.*), and one more way
-- in. An out-of-list visit carries no approval row; its customer's validated_at — null until the
-- district manager and SFE admit him — is what every report joins on, so it counts from admission.
create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select v.*
  from public.phoenix_crm_visits v
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list';

comment on view public.phoenix_crm_countable_visits is
  'Visits that count in a KPI: everything that was on a sent plan, an off-plan visit the manager and the SFE have approved, and an out-of-list visit (which counts once its customer is admitted — every report joins the customer''s validated_at). Every phoenix_crm_report_* function reads this, never phoenix_crm_visits. The anti-fraud path deliberately does NOT.';

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- ── 3. Day activities: Sales day ─────────────────────────────────────────────────────────────────

-- SAFE: widening a CHECK to admit one more value; every existing row already satisfies the new form.
alter table public.phoenix_crm_day_activities drop constraint if exists phoenix_crm_day_activities_type;
alter table public.phoenix_crm_day_activities
  add constraint phoenix_crm_day_activities_type
  check (activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day'));

create or replace function public.phoenix_crm_save_day_activity(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(btrim(p ->> 'seat_id'), '');
  v_line text := nullif(btrim(p ->> 'line_code'), '');
  v_rep text := nullif(btrim(p ->> 'rep_hr_id'), '');
  v_actor text := nullif(btrim(p ->> 'actor_hr_id'), '');
  v_date date := nullif(p ->> 'activity_date', '')::date;
  v_type text := nullif(btrim(p ->> 'activity_type'), '');
  v_half boolean := coalesce((p ->> 'half_day')::boolean, false);
  v_note text := nullif(btrim(p ->> 'note'), '');
  v_row public.phoenix_crm_day_activities%rowtype;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
begin
  if v_seat is null or v_actor is null or v_date is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:day_activity:' || v_seat || ':' || v_date::text));

  if v_type is null then
    delete from public.phoenix_crm_day_activities
    where seat_id = v_seat and activity_date = v_date and is_test = v_is_test;
    return jsonb_build_object('cleared', true);
  end if;

  if v_type not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  insert into public.phoenix_crm_day_activities (
    seat_id, line_code, rep_hr_id, entered_by_hr_id, activity_date, activity_type, half_day, note, is_test
  )
  values (v_seat, v_line, v_rep, v_actor, v_date, v_type, v_half, v_note, v_is_test)
  on conflict (seat_id, activity_date, is_test) do update
    set activity_type = excluded.activity_type,
        half_day = excluded.half_day,
        note = excluded.note,
        entered_by_hr_id = excluded.entered_by_hr_id,
        line_code = excluded.line_code,
        rep_hr_id = excluded.rep_hr_id,
        updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'cleared', false,
    'id', v_row.id,
    'activity_date', v_row.activity_date,
    'activity_type', v_row.activity_type,
    'half_day', v_row.half_day,
    'note', v_row.note
  );
end;
$$;

-- ── 4. Saving a visit: one tap, the server's clock, the 02:00 day ────────────────────────────────

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
    or v_kind not in ('single', 'double', 'chain')
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
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and v_senior is not null)
  ) then
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
    senior_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability, photo_path, lat, lon,
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
    v_senior, v_actor, v_products, v_comment, v_pharmacy, v_availability, v_photo,
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

-- Restated, as every migration that replaces these functions restates them: `check:migrations`
-- refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;
revoke execute on function public.phoenix_crm_save_day_activity(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_day_activity(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
