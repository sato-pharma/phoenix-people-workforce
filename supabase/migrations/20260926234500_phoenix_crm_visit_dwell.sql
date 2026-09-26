-- phoenix_crm_visit_dwell
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_visits gains TWO columns, dwell_seconds and form_open_seconds.
--   2. phoenix_crm_save_visit is re-created to fill them. Nothing else about it changes.
--
-- WHY (owner, 2026-09-26, Golden Rule #1, the BLIND half):
--   "never make the medical rep feel that the system is here to catch him ... every violation is
--   recorded in the admin and the SFE account." A visit that took eleven seconds from the door photo
--   to Save is not proof of anything on its own, and it is never shown to the rep, never mentioned to
--   him, and never able to cost him a visit. It is one signal among several for the Super Admin's
--   board in Phase 5, where a rep whose every visit lasts EXACTLY the same number of seconds is worth
--   a quiet look — and a rep who is simply quick is not.
--
-- THE TWO ARE NOT THE SAME KIND OF FACT, and that is the whole point of having both:
--
--   * dwell_seconds is SERVER-DERIVED — now() minus the visit's own server-issued captured_at. The
--     phone sends nothing and cannot forge it. It is the real elapsed time between the photo slot
--     being issued at the door and the save arriving.
--   * form_open_seconds is what the PHONE counted, and is unverifiable alone. It is here precisely
--     because a forged one is CONSTANT: a build that lies reports the same number every time, which
--     is a far louder signal than any single value. Clamped, never refused.
--
-- 🔴 NEITHER REACHES THE REP. Neither joins VISIT_COLUMNS, VisitRow or mapVisitRow, and both are in
--    SILENT_COLUMNS in tests/phoenix-crm-blind-half.test.ts. The ONLY mention either gets in
--    src/lib/phoenix-crm/server/visits.ts is inside saveVisit's own RPC payload — a write, never a
--    read — and that test pins exactly that.
--
-- 🔴 AND NEITHER CAN REFUSE A VISIT. A phone sending "abc" seconds, or nothing at all, saves exactly
--    as it always did. The rep is standing at a door with a photo he cannot retake.
--
-- ROLLBACK:
--   begin;
--   alter table public.phoenix_crm_visits
--     drop constraint if exists phoenix_crm_visits_dwell_seconds,
--     drop constraint if exists phoenix_crm_visits_form_open_seconds,
--     drop column if exists dwell_seconds, drop column if exists form_open_seconds;
--   -- then re-apply 20260926230000 (save_visit).
--   commit;
--   (Additive: both columns are nullable and no existing row is read or written.)
--
-- Verification after apply:
--   select count(*) from information_schema.columns
--    where table_name = 'phoenix_crm_visits' and column_name in ('dwell_seconds','form_open_seconds');  -- 2
--   select prosecdef from pg_proc where proname = 'phoenix_crm_save_visit';                             -- t

begin;
set local lock_timeout = '5s';

-- ── 1. The two columns ───────────────────────────────────────────────────────────────────────────
-- Nullable with no default: every visit already on file is correct without a backfill, because none
-- of them was timed and a 0 would be a measurement nobody took.
alter table public.phoenix_crm_visits
  add column if not exists dwell_seconds integer,
  add column if not exists form_open_seconds integer;

comment on column public.phoenix_crm_visits.dwell_seconds is
  'Server-derived: now() - captured_at at save. The phone sends nothing and cannot forge it. NEVER '
  'shown to the rep and never able to refuse a visit — one signal among several on the Super Admin''s '
  'integrity board, where a CONSTANT value matters and a single small one does not.';
comment on column public.phoenix_crm_visits.form_open_seconds is
  'What the phone counted with the form open. Unverifiable alone, and here because a forged one is '
  'CONSTANT. Clamped, never refused. NEVER shown to the rep.';

-- A photo slot lasts 2 hours (phoenix_crm_take_photo), so a saved visit cannot legitimately sit
-- longer than that between its photo and its save; both columns are held to the same ceiling.
alter table public.phoenix_crm_visits
  drop constraint if exists phoenix_crm_visits_dwell_seconds,
  add constraint phoenix_crm_visits_dwell_seconds
    check (dwell_seconds is null or dwell_seconds between 0 and 7200);

alter table public.phoenix_crm_visits
  drop constraint if exists phoenix_crm_visits_form_open_seconds,
  add constraint phoenix_crm_visits_form_open_seconds
    check (form_open_seconds is null or form_open_seconds between 0 and 7200);

-- ── 2. Saving a visit times it ───────────────────────────────────────────────────────────────────
-- Carried over verbatim from 20260926230000 with FOUR insertions, all marked D3 below.
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

  v_date := (v_captured_at at time zone 'Africa/Cairo')::date;

  -- D3: how long the door photo has been in hand. Server-derived from the server's own captured_at,
  -- so the phone cannot forge it; clamped to the same 2 hours a photo slot lasts, because a value
  -- outside that range would only ever be a clock oddity and must not refuse the visit.
  v_dwell := least(greatest(floor(extract(epoch from (now() - v_captured_at)))::bigint, 0), 7200)::integer;

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
    dwell_seconds, form_open_seconds
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
    v_dwell, nullif(v_form_open, 0)
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
    'duplicate', false
  );
end;
$$;

-- Restated, as the two migrations before this one restate it and for the same reason:
-- `check:migrations` refuses any file whose only function is SECURITY DEFINER and that carries no
-- revoke from PUBLIC.
revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
