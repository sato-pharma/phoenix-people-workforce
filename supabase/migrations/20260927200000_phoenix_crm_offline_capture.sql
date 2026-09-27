-- phoenix_crm_visits: the offline capture (A1, phase 3)
--
-- WHAT THIS CHANGES:
--   1. Four columns on public.phoenix_crm_visits — capture_source, time_anchor_id, offline_seconds,
--      synced_at.
--   2. public.phoenix_crm_save_visit, replaced, so a visit captured with no signal is dated by the
--      time the SERVER derived from its anchor instead of by the photo slot's issue time.
--
-- WHY (owner, 2026-09-27, when he was offered the phone's clock or the sync time and refused both):
--
--   "I want the Cairo time, but I don't want the time on the phone because they may install an app
--    that changes the time in the phone. I need what protects the system from fraud, but at the same
--    time I need it to be accurate Cairo time."
--
--   Phases 1 and 2 built the answer: the phone sends a DURATION measured on the monotonic clock —
--   which has no setter — against an ANCHOR the server minted and can look up. This is the third
--   piece: the save accepting the result.
--
-- 🔴 THE PHOTO SLOT IS NOT RELAXED, AND DOES NOT NEED TO BE.
--   The obvious fear about offline capture is the slot's 2-hour life. It never applies: a queued
--   visit uploads its photo ON RECONNECT, so the slot is minted fresh at sync and consumed within
--   seconds. `phoenix_crm_take_photo` is called exactly as before and still proves the path was
--   issued to this person for this territory and never used. All that changes is which clock DATES
--   the visit.
--
-- 🔴 offline_captured_at IS DERIVED IN TYPESCRIPT AND NEVER COPIED FROM A REQUEST.
--   src/lib/phoenix-crm/offline-clock.ts reads the anchor row, checks the claim against the window
--   the server brackets at both ends itself, and hands the result to saveVisit. The phone sends an
--   anchor id and an elapsed duration; it never sends a timestamp. The two fences in this file are a
--   second, independent check in the database: never later than now(), never older than a day. A
--   value outside them is DROPPED and the visit is dated at arrival — never refused, because a rep
--   must not lose a real visit to a clock argument, and never explained to him.
--
-- 🔴 dwell_seconds IS NULL FOR AN OFFLINE VISIT.
--   now() - captured_at means "how long the photo has been in hand" and is meaningful only when the
--   save follows the shutter by seconds. On a visit that waited six hours in a queue it would read as
--   six hours of dwell and hand D4's duration analysis a fabricated figure.
--
-- WHAT DOES NOT CHANGE: the one-visit-a-customer-a-day key (on the Cairo date of the capture, which
--   is now the right date rather than the sync date), and the planned-or-not verdict, which is still
--   evaluated as of captured_at — so a plan he sent before walking into the dead spot still counts.
--
-- ROLLBACK:
--   (re-apply 20260926234500_phoenix_crm_visit_dwell.sql to restore the previous function)
--   alter table public.phoenix_crm_visits
--     drop constraint if exists phoenix_crm_visits_capture_source,
--     drop constraint if exists phoenix_crm_visits_offline_seconds,
--     drop column if exists capture_source,
--     drop column if exists time_anchor_id,
--     drop column if exists offline_seconds,
--     drop column if exists synced_at;
--
-- Verification after apply:
--   select prosecdef from pg_proc where proname = 'phoenix_crm_save_visit';   -- t
--   select count(*) from public.phoenix_crm_visits where capture_source <> 'slot';  -- 0
--   select conname from pg_constraint where conrelid = 'public.phoenix_crm_visits'::regclass
--     and conname like '%capture_source%';

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_visits
  add column if not exists capture_source text not null default 'slot',
  add column if not exists time_anchor_id uuid,
  add column if not exists offline_seconds integer,
  add column if not exists synced_at timestamptz;

comment on column public.phoenix_crm_visits.capture_source is
  'Which clock dated this visit: slot (the server issued the photo slot at that moment) or offline_anchor (derived from a server-minted anchor plus elapsed monotonic time on the phone).';
comment on column public.phoenix_crm_visits.offline_seconds is
  'How long the visit waited on the phone before it reached Phoenix. Null on an online visit.';
comment on column public.phoenix_crm_visits.synced_at is
  'The server''s own receipt. Stamped for every visit, so the gap against captured_at is readable.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.phoenix_crm_visits'::regclass and conname = 'phoenix_crm_visits_capture_source'
  ) then
    alter table public.phoenix_crm_visits
      add constraint phoenix_crm_visits_capture_source check (capture_source in ('slot', 'offline_anchor'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.phoenix_crm_visits'::regclass and conname = 'phoenix_crm_visits_offline_seconds'
  ) then
    alter table public.phoenix_crm_visits
      add constraint phoenix_crm_visits_offline_seconds
      check (offline_seconds is null or offline_seconds between 0 and 172800);
  end if;
end;
$$;

-- The manager's read: which visits came in offline, newest first.
create index if not exists phoenix_crm_visits_offline_idx
  on public.phoenix_crm_visits (capture_source, captured_at desc) where capture_source <> 'slot';

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
  -- New: the rep's "why I went", and where his approval starts when he went off plan.
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
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_captured_at timestamptz;
  v_date date;
  -- A1: the offline path. `offline_captured_at` is derived IN TYPESCRIPT by
  -- src/lib/phoenix-crm/offline-clock.ts from a server-minted anchor plus elapsed MONOTONIC time,
  -- and passed in by saveVisit. 🔴 It is NEVER copied from the request body — the phone sends a
  -- duration and an anchor id, never a timestamp, which is the owner's whole requirement
  -- (2026-09-27: "I don't want the time on the phone because they may install an app that changes
  -- the time in the phone"). The two bounds below are a second fence in the database itself.
  v_offline_at timestamptz := nullif(p ->> 'offline_captured_at', '')::timestamptz;
  v_anchor_id uuid := nullif(p ->> 'time_anchor_id', '')::uuid;
  v_offline_seconds integer;
  v_source text := 'slot';
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_customer_id is null or v_photo is null
    or v_kind not in ('single', 'double', 'chain')
    or v_flag not in ('ok', 'far', 'weak_gps', 'no_place')
    or v_first_stage not in ('manager_pending', 'sfe_pending')
    or (v_pharmacy is not null and char_length(v_pharmacy) > 120) then
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

  -- E3: an unknown value is DROPPED, never raised. A rep at a door with a photo he cannot retake must
  -- not lose the visit because his build sent a next step this release does not know. The dependants
  -- go with their parent, so the row can never say "by 30 Sept" under "Nothing to follow".
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
  -- A pending customer (carried over from iReports360, not validated yet) is a real, visitable
  -- customer, exactly as the list and the visit form treat him. Only a genuinely dropped customer
  -- is refused here, and 'phoenix_crm:customer_dropped' — "This customer has left the list." — is
  -- correct for that case.
  if v_customer.status not in ('active', 'pending') then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if v_place_id is not null and not exists (
    select 1 from public.phoenix_crm_places pl where pl.id = v_place_id and pl.customer_id = v_customer.id
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  if v_reuse then
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
  else
    v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test);
  end if;

  -- A1 · THE OFFLINE CAPTURE TIME.
  --
  -- The photo slot is STILL consumed above, unchanged: that is what proves the path was issued to
  -- this person for this territory and has not been used before. What changes is only which clock
  -- DATES the visit. A queued visit uploads its photo on reconnect, so its slot is minted fresh at
  -- sync — which is why the slot's own 2-hour life never has to be relaxed for this to work.
  --
  -- Two fences, and both are one-sided in the safe direction:
  --   * never later than now(), so a claim can't reach into the future;
  --   * never earlier than the anchor, which is checked in TypeScript and re-checked here only as a
  --     sanity floor of one day, because an offline_captured_at older than that would have failed
  --     ANCHOR_MAX_AGE_SECONDS before it ever arrived.
  -- Outside them the value is DROPPED and the visit is dated at arrival — never refused, because a
  -- rep must not lose a real visit to a clock argument, and never explained to him.
  if v_offline_at is not null
     and v_offline_at <= now()
     and v_offline_at > now() - interval '1 day' then
    v_offline_seconds := greatest(floor(extract(epoch from (now() - v_offline_at)))::bigint, 0)::integer;
    v_captured_at := v_offline_at;
    v_source := 'offline_anchor';
  end if;

  v_date := (v_captured_at at time zone 'Africa/Cairo')::date;

  -- D3: how long the door photo has been in hand. Server-derived from the server's own captured_at,
  -- so the phone cannot forge it; clamped to the same 2 hours a photo slot lasts, because a value
  -- outside that range would only ever be a clock oddity and must not refuse the visit.
  -- 🔴 NULL for an offline visit, never a number. now() - captured_at is "how long the photo has been
  -- in hand", which is meaningful only when the save follows the shutter by seconds. On a visit that
  -- waited six hours in a queue it would read as six hours of dwell and hand D4's duration analysis a
  -- fabricated figure — so the honest answer is that it was not measured.
  v_dwell := case
    when v_source = 'offline_anchor' then null
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

  -- WAS HE PLANNED? Not "is he on a plan row now" — the rep owns his own draft plan and today is an
  -- editable day, so that test would let him place the doctor at the door and never be unplanned.
  --
  -- And NOT "did this plan ever reach review", which is the same trap one step further in.
  -- phoenix_crm_plan_events is append-only: nothing deletes from it, so a Saturday 'submitted' row
  -- outlives every reopen and every return. An `exists` over those rows would let a rep standing at an
  -- unplanned door tap Reopen (his own seat, so it is allowed), add the doctor to today, and save —
  -- the Saturday event still satisfies it, no reason is asked, nobody is told, and it counts at once.
  -- The same looseness misfires with no misconduct at all: after a manager RETURNS a week, every visit
  -- to a customer on a plan row would read as planned for the rest of it.
  --
  -- So: the plan's status AS OF this visit's server-issued captured_at — the latest event wins, which
  -- is the shape phoenix_crm_report_plan_vs_actual's own sent_days uses, so the save and the report
  -- answer the same question. A draft or returned plan is the rep's to edit and is never authority.
  --
  -- A manager's own single visit (no rep on it) was never on anybody's plan by construction and
  -- belongs to nobody's call rate, so it is never raised for approval.
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

  if not v_on_sent_plan and (v_clarification is null or char_length(v_clarification) < 10 or char_length(v_clarification) > 500) then
    raise exception 'phoenix_crm:clarification_required';
  end if;

  -- The voice note, when there is one. Two things about this call are the point of the whole
  -- migration that introduced it. It happens AFTER v_date is settled, so nothing it does can reach the
  -- date. And phoenix_crm_take_voice returns VOID, where phoenix_crm_take_photo returns the issue time
  -- that becomes captured_at -- so there is no value here to assign to v_captured_at even by mistake.
  if v_voice is not null then
    perform public.phoenix_crm_take_voice(v_voice, v_actor, v_seat, v_is_test);
  end if;

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability, photo_path, lat, lon,
    accuracy_meters, place_id, distance_meters, location_flag, device_skew_minutes, is_test,
    voice_note_path, voice_note_seconds, voice_note_bytes, is_unplanned,
    -- E3
    next_step, next_step_on, objection, objection_note,
    -- E2
    samples_given,
    -- D3
    dwell_seconds, form_open_seconds,
    -- A1
    capture_source, time_anchor_id, offline_seconds, synced_at
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
    v_voice, v_voice_seconds, v_voice_bytes, not v_on_sent_plan,
    -- E3
    v_next_step, v_next_step_on, v_objection, v_objection_note,
    -- E2
    v_samples,
    -- D3. A zero form_open is "the phone said nothing", not "he was there no time": stored as null so
    -- the board can tell an unanswered stopwatch from a suspiciously constant one.
    v_dwell, nullif(v_form_open, 0),
    -- A1. synced_at is the server's own receipt and is stamped for EVERY visit, online or not: the
    -- pair (captured_at, synced_at) is what lets a human see the gap at all, and on an online visit
    -- they are seconds apart, which is the useful baseline.
    v_source, case when v_source = 'offline_anchor' then v_anchor_id else null end, v_offline_seconds, now()
  );

  if not v_on_sent_plan then
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
    'capture_source', v_source,
    'duplicate', false
  );
end;
$$;

-- Restated, as every migration that replaces this function restates it and for the same reason:
-- `check:migrations` refuses any file whose only function is SECURITY DEFINER and that carries no
-- revoke from PUBLIC.
revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
