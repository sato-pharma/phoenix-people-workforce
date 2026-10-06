-- phoenix_crm_visit_company_and_admin_edit
--
-- WHAT THIS CHANGES (owner, 2026-10-06):
--   1. A CHAIN visit may carry a PRODUCT MANAGER in place of the senior manager. The rep now ticks ONE
--      person from one list under "Double visit" and TWO under "Chain visit", and the list holds his
--      managers and his line's product managers. A chain is the visit's manager plus one more person: a
--      senior manager (senior_hr_id) OR a product manager (product_manager_hr_id) — never both, never
--      neither. `phoenix_crm_visits_participants` is widened to say so, and the product-manager column
--      is now allowed on exactly two kinds, 'product_manager' and 'chain'.
--      🔴 A product manager is STILL never in manager_hr_id: `double_visits` is counted from
--      kind = 'double' on every board, and a double visit WITH a product manager is still filed as the
--      'product_manager' kind it always was.
--   2. phoenix_crm_save_visit accepts that shape. The body is the live 20261004005543 definition with
--      three surgical edits (the chain clause, the passenger clause, and the comment that explains them)
--      and NOTHING else — extracted from that migration and patched in place rather than retyped, so no
--      other rule can drift.
--   3. phoenix_crm_visit_edits: one row per correction the Super Admin makes to a visit a rep submitted —
--      what the three things said before and after, who changed them, when. Production has no
--      point-in-time recovery, so a correction keeps its own copy of what it replaced.
--   4. phoenix_crm_admin_edit_visit(p jsonb): corrects WHO WAS ON a visit, its PRODUCTS and its COMMENT,
--      and nothing else. It never touches the customer, the day, the time, the location, the photo or the
--      voice note — the evidence every figure and integrity check reads. Who was on the visit changes only
--      on a visit the rep entered himself or the Super Admin entered for him, so a manager's own visit
--      never turns into one that reads as entered by somebody who was not on it. The products are copied
--      to the pharmacy visits that visit filed (linked_from_visit_id), which have always carried the same
--      products. It notifies nobody: a correction to a record is not a check on the rep.
--
-- WHY: a rep who picks the wrong kind of visit — a double that was a chain, the wrong manager — had no
--   remedy short of hand SQL on production, and the owner asked for the Super Admin to be able to enter
--   the visit and edit it.
--
-- WHO MAY CALL IT: the service role only (revoked from public, anon and authenticated below). The
--   TypeScript service admits the Super Admin alone — territoryForVisitEdit in
--   src/lib/phoenix-crm/server/access.ts — and re-checks every person against the territory's own chain
--   and the line's own product managers; this function re-checks the shape and who entered the visit.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_admin_edit_visit(jsonb);
--   The audit table stays: it is the only copy of what a correction replaced.
--   Chain visits that carry a product manager have to be rewritten first (set kind = 'product_manager'
--   and manager_hr_id = null, or null the product manager and add a senior manager), then:
--     alter table public.phoenix_crm_visits drop constraint phoenix_crm_visits_participants;
--     add the 20261002205436 version of it back, and re-run 20261004005543's save_visit block.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This widens one check, replaces one function, adds one table and one function, and writes no rows.

begin;
set local lock_timeout = '5s';

-- ── 1. A chain may carry a product manager ──────────────────────────────────────────────────────────

alter table public.phoenix_crm_visits
  drop constraint if exists phoenix_crm_visits_participants;

alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_participants
  check (
    (
      (kind = 'single' and senior_hr_id is null and ((rep_hr_id is null) <> (manager_hr_id is null)))
      or (kind = 'double' and rep_hr_id is not null and manager_hr_id is not null and senior_hr_id is null)
      -- A chain: the visit's manager and ONE more — a senior manager or a product manager, never both.
      or (kind = 'chain' and rep_hr_id is not null and manager_hr_id is not null and ((senior_hr_id is not null) <> (product_manager_hr_id is not null)))
      or (
        kind = 'product_manager'
        and rep_hr_id is not null
        and manager_hr_id is null
        and senior_hr_id is null
        and product_manager_hr_id is not null
      )
    )
    -- The column exists only for its own two kinds, so no other kind can quietly carry a passenger.
    and (kind in ('product_manager', 'chain') or product_manager_hr_id is null)
  );

comment on column public.phoenix_crm_visits.product_manager_hr_id is
  'The line''s product manager who was on the visit (owner, 2026-10-02). Set on kind = ''product_manager'' '
  'and, since 2026-10-06, on kind = ''chain'' in place of the senior manager; on no other kind. NEVER '
  'manager_hr_id: a double visit means the rep with his district manager, and double_visits is counted from that.';

-- ── 2. The one writer, with the three edits named above ─────────────────────────────────────────────

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
  -- The pharmacies NAMED on this visit are visits to those pharmacies too (owner, 2026-10-03). WHICH
  -- pharmacy on his list each name is was decided by the caller (pharmacy-call-rules.ts
  -- splitNamedPharmacies, then linkNamedPharmacy for each name, where both are tested); here each is
  -- only checked to be his, and filed. ONE BOX CAN NAME TWO PHARMACIES ("صيدليه التهامي، صيدليه الرحمه",
  -- 2026-10-03): the caller sends one entry per name in `linked_pharmacies`. A caller from before this
  -- sends one match as linked_pharmacy_id / linked_pharmacy_new — read below as a list of one, named
  -- with the whole box, exactly as 20261003175653 filed it.
  v_links jsonb;
  v_entry jsonb;
  v_entry_name text;
  v_entry_id uuid;
  v_entry_new boolean;
  v_link public.phoenix_crm_customers%rowtype;
  v_link_visit uuid;
  v_link_created boolean;
  v_filed jsonb := '[]'::jsonb;
  v_is_pharmacy boolean;
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
  -- not ask for him. 2026-10-06: a CHAIN has two people besides the rep — a manager and ONE more, who is
  -- a senior manager OR a product manager, never both and never neither.
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and ((v_senior is not null) <> (v_product_manager is not null)))
    or (v_kind = 'product_manager' and v_rep is not null and v_manager is null and v_senior is null and v_product_manager is not null)
  ) or (v_kind not in ('product_manager', 'chain') and v_product_manager is not null)
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
  v_is_pharmacy := v_customer.list_type = 'Pharmacy';
  -- A pharmacy's own visit is named after the pharmacy (owner, 2026-10-03), so the day's Pharmacies
  -- figure — distinct pharmacy names — counts it, and counts it ONCE beside a doctor's visit that named
  -- the same pharmacy. A name the phone sent for it is not used: the pharmacy is the customer.
  if v_is_pharmacy then
    v_pharmacy := left(v_customer.name, 120);
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
  v_on_sent_plan := v_is_pharmacy or v_rep is null or exists (
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
  --
  -- 🔴 A PHARMACY IS NEVER OUT OF PLAN, NEVER OUT OF LIST AND NEVER APPROVED (owner, 2026-10-02: "no
  -- approval for an unplanned pharmacy visit"; 2026-10-03: "Pharmacy don't need a validation. It is
  -- visit is logged normally."). Until 2026-10-03 this block filed EVERY pharmacy visit out_of_plan —
  -- a reason, then the manager and SFE — because a pharmacy is never on a plan; not one rep ever saved
  -- one. It is filed as planned whatever its status, and counts the moment it is saved.
  if v_is_pharmacy then
    v_on_sent_plan := true;
    v_unplanned_kind := null;
  elsif v_customer.status = 'outside' then
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

  -- 🔴 A PHARMACY NAMED ON A DOCTOR'S VISIT IS A VISIT TO THAT PHARMACY (owner, 2026-10-03: "consider
  -- this as a pharmacy visit and make it count everywhere"). He checks the pharmacy's stock beside the
  -- doctor and types its name on the doctor's visit; that pharmacy now gets its own visit, filed beside
  -- this one — same day, same time, same products.
  --   · it is a SINGLE visit by whoever's visit this is — the rep, or the manager on a visit of his own.
  --     A double, chain or product-manager visit is the doctor's: copying its people here would credit
  --     the manager with a second double visit for one stop (phoenix_crm_report_manager_visits counts
  --     every double and chain row);
  --   · it carries NO stock answers: they stay on the doctor's visit, where every stock reader has
  --     always found them by the pharmacy's name — a copy here would report each missing product twice;
  --   · the pharmacy must be HIS: this seat, this world, a pharmacy, not in the Archive. Anything else
  --     the caller sent is IGNORED, never raised: the doctor's visit is saved whatever becomes of it;
  --   · nothing on his list matched → it is added to his list (new, pending — a pharmacy needs no
  --     validation), and visited;
  --   · one a day, like every customer: a pharmacy already visited today keeps the visit it has;
  --   · ONE BOX, TWO PHARMACIES — "صيدليه التهامي، صيدليه الرحمه": each name is its own pharmacy and
  --     gets its own visit, named as he spelled it. Five at most; a name the caller could not place is
  --     skipped, never raised.
  -- It has no photo and no place reading of its own — nobody stood at the pharmacy with a phone for it
  -- — so the location report and the behaviour sweep leave it out by linked_from_visit_id.
  if not v_is_pharmacy and v_pharmacy is not null then
    v_links := case
      when jsonb_typeof(p -> 'linked_pharmacies') = 'array' then p -> 'linked_pharmacies'
      else jsonb_build_array(jsonb_build_object(
        'name', v_pharmacy,
        'id', nullif(p ->> 'linked_pharmacy_id', ''),
        'new', coalesce((p ->> 'linked_pharmacy_new')::boolean, false)
      ))
    end;

    for v_entry in
      select e.value from jsonb_array_elements(v_links) with ordinality as e(value, n) order by e.n limit 5
    loop
      v_entry_name := nullif(trim(coalesce(v_entry ->> 'name', '')), '');
      v_entry_id := case
        when (v_entry ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_entry ->> 'id')::uuid
      end;
      v_entry_new := coalesce((v_entry ->> 'new') = 'true', false);
      v_link := null;
      v_link_visit := null;
      v_link_created := false;
      continue when v_entry_name is null or char_length(v_entry_name) > 120;

      if v_entry_id is not null then
        select c.* into v_link
        from public.phoenix_crm_customers c
        where c.id = v_entry_id
          and c.seat_id = v_seat
          and c.is_test = v_is_test
          and c.list_type = 'Pharmacy'
          and c.status in ('active', 'pending', 'outside');
      elsif v_entry_new then
        -- The caller decided "new" from a read taken before this call, so the name is checked again
        -- here, under the SAME lock phoenix_crm_add_pharmacy takes: two saves naming one new pharmacy,
        -- or a save racing Add a pharmacy, file one pharmacy, never two rows for it.
        perform pg_advisory_xact_lock(hashtext('phoenix_crm_add_pharmacy|' || v_seat || '|' || v_is_test::text));
        select c.* into v_link
        from public.phoenix_crm_customers c
        where c.seat_id = v_seat
          and c.is_test = v_is_test
          and c.list_type = 'Pharmacy'
          and c.status in ('active', 'pending', 'outside')
          and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(v_entry_name, '\s+', ' ', 'g')))
        order by (c.status = 'active') desc, c.id
        limit 1;
        if v_link.id is null then
          insert into public.phoenix_crm_customers (
            seat_id, line_code, list_type, name, origin, status, created_by_hr_id, is_test, intake_note
          )
          values (
            v_seat, v_customer.line_code, 'Pharmacy', v_entry_name, 'new', 'pending', v_actor, v_is_test,
            left('Added when the visit to ' || v_customer.name || ' named it.', 300)
          )
          returning * into v_link;
          v_link_created := true;
        end if;
      end if;

      if v_link.id is not null then
        insert into public.phoenix_crm_visits (
          id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
          senior_hr_id, product_manager_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability,
          lat, lon, accuracy_meters, place_id, distance_meters, location_flag, is_test,
          is_unplanned, unplanned_kind, samples_given,
          capture_source, time_anchor_id, offline_seconds, synced_at,
          linked_from_visit_id
        )
        values (
          gen_random_uuid(), v_seat, v_line, v_link.id, 'Pharmacy', v_date, v_captured_at, 'single', v_rep,
          case when v_rep is null then v_manager end,
          null, null, v_actor, v_products, null, v_entry_name, '{}'::jsonb,
          (p ->> 'lat')::double precision,
          (p ->> 'lon')::double precision,
          (p ->> 'accuracy_meters')::numeric,
          null, null, 'no_place', v_is_test,
          false, null, '{}'::jsonb,
          v_source, case when v_source = 'offline_anchor' then v_anchor_id else null end, v_offline_seconds, now(),
          v_id
        )
        on conflict (seat_id, customer_id, visit_date, is_test) do nothing
        returning id into v_link_visit;
        v_filed := v_filed || jsonb_build_array(jsonb_build_object(
          'customer_id', v_link.id, 'name', v_link.name, 'visit_id', v_link_visit, 'created', v_link_created
        ));
      end if;
    end loop;
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
    -- The first one filed, as before, for a caller that reads one; every one of them beside it.
    'linked_pharmacy', v_filed -> 0,
    'linked_pharmacies', v_filed,
    'duplicate', false
  );
end;
$$;

revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;

-- ── 3. What a correction replaced, kept ─────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_visit_edits (
  id uuid primary key default gen_random_uuid(),
  -- No foreign key, deliberately: the Super Admin can still remove a visit he entered, and a copy of
  -- what its corrections replaced must outlive the visit (exactly as phoenix_crm_removed_visits does).
  visit_id uuid not null,
  seat_id text not null,
  customer_id uuid,
  visit_date date not null,
  edited_by_hr_id text not null,
  edited_at timestamptz not null default now(),
  is_test boolean not null default false,
  -- The three things a correction may change, as they stood before and as they stand now.
  before_edit jsonb not null,
  after_edit jsonb not null
);

comment on table public.phoenix_crm_visit_edits is
  'A visit a rep submitted, corrected by the Super Admin (owner, 2026-10-06): who was on it, its products and its comment, as they were and as they became. Production has no point-in-time recovery, so a correction keeps its own copy.';

create index if not exists phoenix_crm_visit_edits_visit_idx
  on public.phoenix_crm_visit_edits (visit_id, edited_at desc);

alter table public.phoenix_crm_visit_edits enable row level security;
drop policy if exists phoenix_crm_visit_edits_service_role on public.phoenix_crm_visit_edits;
create policy phoenix_crm_visit_edits_service_role
  on public.phoenix_crm_visit_edits for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_edits from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_edits to service_role;

-- ── 4. Correcting a visit a rep submitted ───────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_admin_edit_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  -- Who was on the visit changes ONLY when the caller says so; otherwise the three slots below are
  -- ignored, so a typo in a comment can never re-check (or move) anybody.
  v_change_who boolean := coalesce((p ->> 'change_who')::boolean, false);
  v_kind text := coalesce(p ->> 'kind', '');
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  v_product_manager text := upper(nullif(trim(coalesce(p ->> 'product_manager_hr_id', '')), ''));
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_products text[];
  v_visit public.phoenix_crm_visits%rowtype;
  v_new_kind text;
  v_new_manager text;
  v_new_senior text;
  v_new_product_manager text;
  v_linked_before jsonb;
begin
  if v_id is null or v_seat is null or v_actor is null
    or v_comment is null or char_length(v_comment) > 1000 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The same per-territory lock the rep's own save takes, so a correction and a save cannot interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select v.* into v_visit
  from public.phoenix_crm_visits v
  where v.id = v_id
    and v.seat_id = v_seat
    and v.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_not_found';
  end if;

  v_new_kind := v_visit.kind;
  v_new_manager := v_visit.manager_hr_id;
  v_new_senior := v_visit.senior_hr_id;
  v_new_product_manager := v_visit.product_manager_hr_id;

  if v_change_who then
    -- Only a visit the rep entered himself, or the Super Admin entered for him. A manager's own visit
    -- keeps its people: re-picking them would turn his record into one that reads as entered by
    -- somebody who was not on it.
    if v_visit.rep_hr_id is null
      or not (v_visit.entered_by_hr_id = v_visit.rep_hr_id or v_visit.capture_source = 'admin') then
      raise exception 'phoenix_crm:visit_people_fixed';
    end if;

    -- The shape `phoenix_crm_visits_participants` holds, for a visit that has a rep on it, refused here
    -- as a sentence rather than as a constraint violation.
    if not (
      (v_kind = 'single' and v_manager is null and v_senior is null and v_product_manager is null)
      or (v_kind = 'double' and v_manager is not null and v_senior is null and v_product_manager is null)
      or (v_kind = 'chain' and v_manager is not null and ((v_senior is not null) <> (v_product_manager is not null)))
      or (v_kind = 'product_manager' and v_manager is null and v_senior is null and v_product_manager is not null)
    ) or v_manager = v_visit.rep_hr_id
      or v_senior = v_visit.rep_hr_id
      or v_senior = v_manager
      or v_product_manager = v_visit.rep_hr_id then
      raise exception 'phoenix_crm:bad_participants';
    end if;

    v_new_kind := v_kind;
    v_new_manager := v_manager;
    v_new_senior := v_senior;
    v_new_product_manager := v_product_manager;
  end if;

  -- Nothing different: no copy, no write, and the caller is told so.
  if v_new_kind is not distinct from v_visit.kind
    and v_new_manager is not distinct from v_visit.manager_hr_id
    and v_new_senior is not distinct from v_visit.senior_hr_id
    and v_new_product_manager is not distinct from v_visit.product_manager_hr_id
    and v_products is not distinct from v_visit.products
    and v_comment is not distinct from v_visit.comment then
    return jsonb_build_object('visit_id', v_id, 'changed', false);
  end if;

  -- The pharmacy visits this one filed carry the same products it does, so they follow it.
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'products', to_jsonb(l.products)) order by l.id), '[]'::jsonb)
  into v_linked_before
  from public.phoenix_crm_visits l
  where l.linked_from_visit_id = v_id;

  -- The copy first, so nothing is overwritten that is not already kept.
  insert into public.phoenix_crm_visit_edits (
    visit_id, seat_id, customer_id, visit_date, edited_by_hr_id, is_test, before_edit, after_edit
  )
  values (
    v_visit.id, v_visit.seat_id, v_visit.customer_id, v_visit.visit_date, v_actor, v_visit.is_test,
    jsonb_build_object(
      'kind', v_visit.kind,
      'manager_hr_id', v_visit.manager_hr_id,
      'senior_hr_id', v_visit.senior_hr_id,
      'product_manager_hr_id', v_visit.product_manager_hr_id,
      'products', to_jsonb(v_visit.products),
      'comment', v_visit.comment,
      'linked_pharmacy_visits', v_linked_before
    ),
    jsonb_build_object(
      'kind', v_new_kind,
      'manager_hr_id', v_new_manager,
      'senior_hr_id', v_new_senior,
      'product_manager_hr_id', v_new_product_manager,
      'products', to_jsonb(v_products),
      'comment', v_comment
    )
  );

  update public.phoenix_crm_visits
  set kind = v_new_kind,
      manager_hr_id = v_new_manager,
      senior_hr_id = v_new_senior,
      product_manager_hr_id = v_new_product_manager,
      products = v_products,
      comment = v_comment
  where id = v_id;

  update public.phoenix_crm_visits
  set products = v_products
  where linked_from_visit_id = v_id
    and products is distinct from v_products;

  return jsonb_build_object('visit_id', v_id, 'changed', true);
end;
$$;

revoke execute on function public.phoenix_crm_admin_edit_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_edit_visit(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
