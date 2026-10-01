-- phoenix_crm_admin_entry
--
-- WHAT THIS CHANGES (owner, 2026-10-01): the Super Admin enters a visit a rep MISSED logging — for any
-- rep, on any day that has already begun, from anywhere.
--   1. phoenix_crm_visits.capture_source gains 'admin': the visit was entered for the rep by the Super
--      Admin, on a day the Super Admin chose. The rep sees it marked "Entered by the Super Admin".
--   2. phoenix_crm_visits.lat / lon lose NOT NULL, and a new CHECK allows them to be missing ONLY on an
--      'admin' visit, both together. "Anywhere": he is not at the door, so the visit has no reading —
--      recording his own position, or a made-up point, would put a false location into every
--      distance and integrity check that reads one. Every other visit still needs both.
--   3. phoenix_crm_admin_enter_visit(p jsonb): the Super Admin's own path. The DAY is his to choose
--      and never later than the visit day running now (the 02:00 day); the time is his, or noon; the
--      visit is planned or unplanned AS HE CHOOSES ("I choose planned or unplanned") — planned counts
--      at once, unplanned raises the same manager-then-SFE approval a rep's off-plan visit does, with
--      his reason as its clarification. One visit per customer per day, exactly as for a rep.
--   A missed DAY ACTIVITY needs no change here: phoenix_crm_save_day_activity already takes its date
--   and records who entered it.
--
-- WHY: the owner, 2026-10-01 — "the rep is responsible for all his records, but if he missed a visit
--   or record, admin can enter it for him", "for anyone, anytime, anywhere".
--
-- WHO MAY CALL IT: the service role only (revoked from public, anon and authenticated below). The
--   TypeScript service admits the Super Admin alone — territoryForMissedRecord in
--   src/lib/phoenix-crm/server/access.ts — and that is the gate, as it is for every Phoenix CRM write.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_admin_enter_visit(jsonb);
--   then, once no 'admin' visit exists (delete or re-date them first — they have no location):
--   alter table public.phoenix_crm_visits drop constraint phoenix_crm_visits_location_source;
--   alter table public.phoenix_crm_visits alter column lat set not null, alter column lon set not null;
--   and restore phoenix_crm_visits_capture_source to ('slot', 'offline_anchor', 'server').
--   Nothing here deletes or rewrites a row: every existing visit already satisfies both CHECKs.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. Who dated the visit: 'admin' ──────────────────────────────────────────────────────────────

-- SAFE: widening a CHECK to admit one more value; every existing row already satisfies the new form.
alter table public.phoenix_crm_visits drop constraint if exists phoenix_crm_visits_capture_source;
alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_capture_source check (capture_source in ('slot', 'offline_anchor', 'server', 'admin'));

comment on column public.phoenix_crm_visits.capture_source is
  'Which clock dated this visit: server (the one-tap Log visit — the server''s own now()), slot (a photo slot the server issued at that moment), offline_anchor (a server-minted anchor plus elapsed monotonic time), or admin (the Super Admin entered a visit the rep missed logging, on a day he chose, with no location).';

-- ── 2. A visit with no location — the Super Admin's only ─────────────────────────────────────────

-- SAFE: widening a column; the CHECK below keeps every visit but an 'admin' one exactly as strict.
alter table public.phoenix_crm_visits alter column lat drop not null;
alter table public.phoenix_crm_visits alter column lon drop not null;

alter table public.phoenix_crm_visits drop constraint if exists phoenix_crm_visits_location_source;
alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_location_source check (
    (lat is null) = (lon is null)
    and (lat is not null or capture_source = 'admin')
  );

comment on column public.phoenix_crm_visits.lat is
  'Where the visit was saved. Null ONLY on an admin visit (capture_source = ''admin''): entered later by the Super Admin, so there is no reading — never a position of his own, never a made-up point.';

-- ── 3. Entering a visit a rep missed logging ─────────────────────────────────────────────────────

create or replace function public.phoenix_crm_admin_enter_visit(p jsonb)
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
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_date date := nullif(p ->> 'visit_date', '')::date;
  -- Minutes past midnight, Cairo, on the chosen day; null = he gave no time, and noon stands in.
  v_minute integer := nullif(p ->> 'visit_minute', '')::integer;
  -- HIS choice, never inferred from the plan ("I choose planned or unplanned").
  v_planned boolean := (p ->> 'planned')::boolean;
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_clarification text := nullif(regexp_replace(trim(coalesce(p ->> 'unplanned_reason', '')), '\s+', ' ', 'g'), '');
  v_first_stage text := coalesce(p ->> 'unplanned_first_status', 'manager_pending');
  v_reviewer text := upper(nullif(trim(coalesce(p ->> 'reviewer_hr_id', '')), ''));
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  -- The visit day running now ends at 02:00 Cairo, exactly as phoenix_crm_save_visit dates a visit.
  v_running_day date := ((now() - interval '2 hours') at time zone 'Africa/Cairo')::date;
  v_captured_at timestamptz;
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_rep is null
    or v_customer_id is null or v_date is null or v_planned is null
    or v_first_stage not in ('manager_pending', 'sfe_pending')
    or (v_minute is not null and (v_minute < 0 or v_minute > 1439))
    or (v_comment is not null and char_length(v_comment) > 1000) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- Anytime that has HAPPENED: a day that has not begun yet holds no visit to have missed.
  if v_date > v_running_day then
    raise exception 'phoenix_crm:future_day';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  if found then
    -- The same entry sent twice (a dropped connection, a second press): the visit already saved answers,
    -- exactly as phoenix_crm_save_visit answers a rep's retry. Anything else under that id is refused.
    if v_existing.capture_source = 'admin'
       and v_existing.entered_by_hr_id = v_actor
       and v_existing.seat_id = v_seat
       and v_existing.customer_id = v_customer_id
       and v_existing.visit_date = v_date
       and v_existing.is_test = v_is_test then
      return jsonb_build_object(
        'id', v_existing.id,
        'visit_date', v_existing.visit_date,
        'captured_at', v_existing.captured_at,
        'customer_id', v_existing.customer_id,
        'customer_name', (select c.name from public.phoenix_crm_customers c where c.id = v_existing.customer_id),
        'list_type', v_existing.list_type,
        'is_unplanned', v_existing.is_unplanned,
        'unplanned_kind', v_existing.unplanned_kind,
        'capture_source', 'admin',
        'duplicate', true
      );
    end if;
    raise exception 'phoenix_crm:id_conflict';
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  -- His list: a validated customer, or one carried over and not validated yet. One met outside the list
  -- is still waiting to be admitted — his visit was saved at the door when he was validated — and one
  -- in the Archive has left the list.
  if v_customer.status = 'outside' then
    raise exception 'phoenix_crm:not_on_list';
  end if;
  if v_customer.status not in ('active', 'pending') then
    raise exception 'phoenix_crm:customer_dropped';
  end if;

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

  if not v_planned and (v_clarification is null or char_length(v_clarification) < 10 or char_length(v_clarification) > 500) then
    raise exception 'phoenix_crm:clarification_required';
  end if;

  -- The time he gives, on the day he chose, in Cairo — noon when he gives none. A time before 02:00 is
  -- the small hours AFTER that day, which still belong to it: the visit day ends at 02:00.
  v_captured_at := (
    (v_date + case when coalesce(v_minute, 720) < 120 then 1 else 0 end)::timestamp
    + make_interval(mins => coalesce(v_minute, 720))
  ) at time zone 'Africa/Cairo';
  -- Never later than the moment it is entered: a time still ahead on today's day is today, now.
  if v_captured_at > now() then
    v_captured_at := now();
  end if;

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, entered_by_hr_id, products, comment, product_availability, samples_given, photo_path,
    lat, lon, accuracy_meters, place_id, distance_meters, location_flag, is_test,
    is_unplanned, unplanned_kind, capture_source, synced_at
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, 'single', v_rep, null,
    null, v_actor, v_products, v_comment, '{}'::jsonb, '{}'::jsonb, null,
    -- No reading: he was not at the door. 'no_place' says there is nothing to measure against.
    null, null, null, null, null, 'no_place', v_is_test,
    not v_planned, case when v_planned then null else 'out_of_plan' end, 'admin', now()
  );

  if not v_planned then
    insert into public.phoenix_crm_unplanned_visits (
      visit_id, seat_id, line_code, rep_hr_id, entered_by_hr_id, customer_id, visit_date,
      clarification, status, manager_hr_id, is_test
    )
    values (
      v_id, v_seat, v_line, v_rep, v_actor, v_customer.id, v_date,
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
    'is_unplanned', not v_planned,
    'unplanned_kind', case when v_planned then null else 'out_of_plan' end,
    'capture_source', 'admin',
    'duplicate', false
  );
end;
$$;

revoke execute on function public.phoenix_crm_admin_enter_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_enter_visit(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
