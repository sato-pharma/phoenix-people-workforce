-- phoenix_crm_visit_samples
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_visits gains ONE column, samples_given jsonb, defaulting to '{}' — what the rep
--      handed over on the visit: free medical samples of his own line's products, and pens, block
--      notes and giveaways.
--   2. phoenix_crm_save_visit is re-created to carry it. Nothing else about it changes.
--
-- WHY (owner, 2026-09-26, in his own words): "free medical samples, pens, block notes, giveaways".
--
-- 🔴 A RECORD OF WHAT HE LEFT, NEVER A STOCK MOVEMENT. There is no balance, no allocation and no
--    "you have 12 left", and nothing anywhere subtracts. The moment a number here is treated as
--    inventory, two things follow that he did not ask for and that Golden Rule #1 forbids: the rep
--    has to be ISSUED a quantity before he can work, and any gap between what he was issued and what
--    he reports becomes an accusation. This is a note of what he handed over, in the same spirit as
--    the products he discussed.
--
-- JUNK IS DROPPED, NEVER REFUSED — the same rule as the visit's outcome, for the same reason: the rep
-- is at a door holding a photo he cannot retake. Only `products`, the pharmacy name and the photo can
-- refuse a visit, because those ARE the visit.
--
-- THE KEY SPACE: one object, {item: quantity}, with two kinds of key — 'material:pen',
-- 'material:block_note', 'material:giveaway', and a bare product name from the rep's own line, which
-- is a free sample of that product. The 'material:' prefix is RESERVED and a bare key wearing it is
-- dropped by src/lib/phoenix-crm/samples.ts, so a product one day called "Pen" can never silently
-- become the pen count on a manager's board. product_availability keys products bare in this same
-- table, so a sample reads there the way it reads here.
--
-- ROLLBACK:
--   begin;
--   alter table public.phoenix_crm_visits
--     drop constraint if exists phoenix_crm_visits_samples_given,
--     drop column if exists samples_given;
--   -- then re-apply 20260926210000 (save_visit).
--   commit;
--   (Additive: the column has a default and no existing row is read or written.)
--
-- Verification after apply:
--   select count(*) from information_schema.columns
--    where table_name = 'phoenix_crm_visits' and column_name = 'samples_given';   -- 1
--   select prosecdef from pg_proc where proname = 'phoenix_crm_save_visit';       -- t

begin;
set local lock_timeout = '5s';

-- ── 1. The column ────────────────────────────────────────────────────────────────────────────────
-- A default of '{}' rather than null, matching product_availability beside it: every reader can then
-- treat "nothing handed over" and "saved before this existed" the same way, which is what they are.
alter table public.phoenix_crm_visits
  add column if not exists samples_given jsonb not null default '{}'::jsonb;

comment on column public.phoenix_crm_visits.samples_given is
  'What the rep handed over: {item: quantity}, where item is material:pen / material:block_note / '
  'material:giveaway, or a bare product name from his line (a free sample of it). A RECORD, never a '
  'stock movement — nothing subtracts, nothing is allocated, and no balance exists anywhere.';

-- An object, and small. The per-key rules live in the application, which can drop a bad key without
-- costing the rep the visit; this only stops the column holding something that is not a bag at all.
--
-- The 20-KEY cap is NOT here, and cannot be: Postgres refuses a subquery in a CHECK constraint
-- ("cannot use subquery in check constraint"), so `count(*) from jsonb_object_keys(...)` is not
-- available to one. A byte cap is, and it is the same guard in a form the column can hold — 2,400
-- characters is comfortably above 20 items at the application's own 80-character key limit and
-- nowhere near a runaway bag. The key count itself is enforced twice in code: parseSamplesGiven cuts
-- the bag, and phoenix_crm_save_visit below empties one that arrives too big.
alter table public.phoenix_crm_visits
  drop constraint if exists phoenix_crm_visits_samples_given,
  add constraint phoenix_crm_visits_samples_given
    check (jsonb_typeof(samples_given) = 'object' and char_length(samples_given::text) <= 2400);

-- ── 2. Saving a visit carries it ─────────────────────────────────────────────────────────────────
-- Carried over verbatim from 20260926210000 with FOUR insertions, all marked E2 below.
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
    samples_given
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
    v_samples
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

-- Restated, as the migration before this one restates it and for the same reason: `check:migrations`
-- refuses any file whose only function is SECURITY DEFINER and that carries no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
