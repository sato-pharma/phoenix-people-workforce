-- phoenix_crm_visit_any_companions
--
-- WHAT THIS CHANGES (owner, 2026-10-27 — "Everything is applicable"):
--   1. NEW TABLE phoenix_crm_visit_companions — everyone who went on a visit with the rep (or with a
--      district manager on his own visit): one row per person, `side` 'manager' or 'product'. A row links
--      to EXACTLY one of phoenix_crm_visits / phoenix_crm_manager_visits, and goes with it on delete.
--      The visit's three fixed places (manager, senior, product manager) stay filled as before — the
--      nearest manager, the next manager up, the first product-side person — so every existing reader
--      keeps working; this table holds them too, plus everyone past them.
--   2. phoenix_crm_visits_participants: a CHAIN is the rep, a manager and at least one more. The senior
--      and the product manager may now BOTH be on it (before: one or the other, never both). Every other
--      shape is unchanged, so the kind still says who went and the double-visit figure cannot inflate.
--   3. phoenix_crm_set_visit_companions(visit, list) — rewrites one visit's rows from its fixed places
--      plus the list, and refuses a list that does not match the visit's kind
--      (single: nobody; double: one manager; product_manager: product side only; chain: two or more,
--      a manager among them). phoenix_crm_visit_companion_ids(visit) reads them back.
--   4. phoenix_crm_save_visit, phoenix_crm_admin_edit_visit, phoenix_crm_admin_enter_visit take a
--      `companions` key (a list of {hr_id, side}); the edit keeps the companions in its before/after copy;
--      the Super Admin's missed-visit entry gains the product side. Bodies are the production ones
--      (md5 of prosrc read 2026-10-27: 2b2d499b…, 8e9e08c7…, 73762e9d…) with only these edits.
--   5. crm_visits_unified gains ONE column at the end, companion_hr_ids text[] — everyone on a Phoenix
--      rep visit; null on the vendor rows and the day activities. double_hr_id / double2_hr_id unchanged.
--   6. The off-plan reviewer trigger counts any companion as "on the visit" (a reviewer never signs off
--      a visit he was on).
--   NO BACKFILL: an existing visit's people are its fixed places, and every reader unions the two.
--   Nothing is deleted or rewritten; no existing row changes.
--
-- WHY: a visit can carry any mix of the people offered — the rep with his District Sales Manager, the
--   Regional or National Sales Manager, the Product Manager, the Group Product Manager, the Training
--   Manager — and the table held two of them at most, so a third was credited nowhere.
--
-- ROLLBACK (in this order):
--   re-run the function bodies of 20261010180118 (phoenix_crm_save_visit), 20261006234611
--   (phoenix_crm_admin_edit_visit), 20261024213000 (phoenix_crm_admin_enter_visit), 20261023065727 (the
--   trigger function); re-run THIS file's crm_visits_unified with the Phoenix branch's companion_hr_ids
--   expression replaced by `null::text[]` (create or replace cannot drop a column, and the view
--   crm_visits_checkin_flags depends on it, so the column stays and goes empty); then
--   drop function public.phoenix_crm_set_visit_companions(uuid, jsonb);
--   drop function public.phoenix_crm_visit_companion_ids(uuid);
--   drop table public.phoenix_crm_visit_companions;   -- loses who came past the fixed places
--   and the old CHECK only once no chain carries both a senior and a product manager.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. Who went on each visit ───────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_visit_companions (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid references public.phoenix_crm_visits (id) on delete cascade,
  manager_visit_id uuid references public.phoenix_crm_manager_visits (id) on delete cascade,
  -- Always stored upper-cased and trimmed, so one person is one key whatever the casing he arrived in.
  hr_id text not null,
  side text not null,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_visit_companions_one_visit check ((visit_id is null) <> (manager_visit_id is null)),
  constraint phoenix_crm_visit_companions_hr_id check (char_length(hr_id) between 1 and 40 and hr_id = upper(btrim(hr_id))),
  constraint phoenix_crm_visit_companions_side check (side in ('manager', 'product')),
  constraint phoenix_crm_visit_companions_position check (position >= 0 and position < 12)
);

create unique index if not exists phoenix_crm_visit_companions_visit_person
  on public.phoenix_crm_visit_companions (visit_id, hr_id) where visit_id is not null;
create unique index if not exists phoenix_crm_visit_companions_manager_visit_person
  on public.phoenix_crm_visit_companions (manager_visit_id, hr_id) where manager_visit_id is not null;
-- "Every visit this person went on" — each companion's own day reads by person.
create index if not exists phoenix_crm_visit_companions_person
  on public.phoenix_crm_visit_companions (hr_id);

-- Exactly as phoenix_crm_visits: RLS on, the service role alone.
alter table public.phoenix_crm_visit_companions enable row level security;
drop policy if exists phoenix_crm_visit_companions_service_role on public.phoenix_crm_visit_companions;
create policy phoenix_crm_visit_companions_service_role
  on public.phoenix_crm_visit_companions for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_companions from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_companions to service_role;

-- ── 2. A chain may carry the senior AND the product manager ─────────────────────────────────────

-- SAFE: widening a CHECK; every existing row already satisfies the new form (only the chain line changes).
alter table public.phoenix_crm_visits drop constraint if exists phoenix_crm_visits_participants;
alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_participants check (
    (
      (kind = 'single' and senior_hr_id is null and ((rep_hr_id is null) <> (manager_hr_id is null)))
      or (kind = 'double' and rep_hr_id is not null and manager_hr_id is not null and senior_hr_id is null)
      or (kind = 'chain' and rep_hr_id is not null and manager_hr_id is not null
          and (senior_hr_id is not null or product_manager_hr_id is not null))
      or (kind = 'product_manager' and rep_hr_id is not null and manager_hr_id is null and senior_hr_id is null
          and product_manager_hr_id is not null)
    )
    and (kind in ('product_manager', 'chain') or product_manager_hr_id is null)
  );

-- ── 3. Writing and reading one visit's companions ───────────────────────────────────────────────

create or replace function public.phoenix_crm_set_visit_companions(p_visit_id uuid, p_companions jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_visit public.phoenix_crm_visits%rowtype;
  v_list jsonb := case when jsonb_typeof(p_companions) = 'array' then p_companions else '[]'::jsonb end;
  v_count integer;
  v_managers integer;
begin
  select v.* into v_visit from public.phoenix_crm_visits v where v.id = p_visit_id;
  if not found then
    raise exception 'phoenix_crm:visit_not_found';
  end if;
  if jsonb_array_length(v_list) > 12 or exists (
    select 1
    from jsonb_array_elements(v_list) as e
    where jsonb_typeof(e) <> 'object'
      or nullif(btrim(coalesce(e ->> 'hr_id', '')), '') is null
      or char_length(btrim(e ->> 'hr_id')) > 40
      or coalesce(e ->> 'side', '') not in ('manager', 'product')
  ) then
    raise exception 'phoenix_crm:bad_participants';
  end if;

  delete from public.phoenix_crm_visit_companions where visit_id = p_visit_id;

  -- A visit with no rep is the manager's own, and the manager place is HIM: nobody came with him here.
  if v_visit.rep_hr_id is null then
    if jsonb_array_length(v_list) > 0 then
      raise exception 'phoenix_crm:bad_participants';
    end if;
    return 0;
  end if;

  -- The fixed places first, in their order, then the list; one row per person, the first side he
  -- arrived with kept; never the rep himself.
  insert into public.phoenix_crm_visit_companions (visit_id, hr_id, side, position)
  select p_visit_id, s.hr_id, s.side, (row_number() over (order by s.ord) - 1)::smallint
  from (
    select distinct on (x.hr_id) x.hr_id, x.side, x.ord
    from (
      select upper(btrim(v_visit.manager_hr_id)) as hr_id, 'manager'::text as side, 0::bigint as ord
      where nullif(btrim(coalesce(v_visit.manager_hr_id, '')), '') is not null
      union all
      select upper(btrim(v_visit.senior_hr_id)), 'manager', 1
      where nullif(btrim(coalesce(v_visit.senior_hr_id, '')), '') is not null
      union all
      select upper(btrim(v_visit.product_manager_hr_id)), 'product', 2
      where nullif(btrim(coalesce(v_visit.product_manager_hr_id, '')), '') is not null
      union all
      select upper(btrim(e.value ->> 'hr_id')), e.value ->> 'side', 2 + e.ordinality
      from jsonb_array_elements(v_list) with ordinality as e (value, ordinality)
    ) x
    where x.hr_id <> upper(btrim(v_visit.rep_hr_id))
    order by x.hr_id, x.ord
  ) s;
  get diagnostics v_count = row_count;

  select count(*) filter (where c.side = 'manager')
  into v_managers
  from public.phoenix_crm_visit_companions c
  where c.visit_id = p_visit_id;

  -- The kind still says who went, so the double-visit figure counts what it always counted.
  if v_count > 12 or not (
    (v_visit.kind = 'single' and v_count = 0)
    or (v_visit.kind = 'double' and v_count = 1 and v_managers = 1)
    or (v_visit.kind = 'product_manager' and v_count >= 1 and v_managers = 0)
    or (v_visit.kind = 'chain' and v_count >= 2 and v_managers >= 1)
  ) then
    raise exception 'phoenix_crm:bad_participants';
  end if;
  return v_count;
end;
$$;

revoke execute on function public.phoenix_crm_set_visit_companions(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_set_visit_companions(uuid, jsonb) to service_role;

-- Everyone on one rep visit, sorted: its fixed places and its rows. An older visit has no rows and
-- answers from its fixed places alone — which is why nothing had to be copied into the table.
create or replace function public.phoenix_crm_visit_companion_ids(p_visit_id uuid)
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(array_agg(distinct x.hr_id order by x.hr_id), '{}'::text[])
  from (
    select upper(btrim(h)) as hr_id
    from public.phoenix_crm_visits v
    cross join lateral unnest(array[v.manager_hr_id, v.senior_hr_id, v.product_manager_hr_id]) as h
    where v.id = p_visit_id
      and v.rep_hr_id is not null
      and nullif(btrim(coalesce(h, '')), '') is not null
    union
    select c.hr_id
    from public.phoenix_crm_visit_companions c
    where c.visit_id = p_visit_id
  ) x;
$$;

revoke execute on function public.phoenix_crm_visit_companion_ids(uuid) from public, anon, authenticated;
grant execute on function public.phoenix_crm_visit_companion_ids(uuid) to service_role;

-- ── 4. The rep's save ───────────────────────────────────────────────────────────────────────────

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
  v_list_type text;
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
  -- not ask for him. 2026-10-27 (owner: "Everything is applicable"): a CHAIN is the rep, a manager and
  -- AT LEAST one more — the manager above him, a product-side person, or both. Everyone past the three
  -- fixed places is in phoenix_crm_visit_companions, written right after the visit below.
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and (v_senior is not null or v_product_manager is not null))
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

  -- WHICH LIST THE VISIT COUNTS IN (owner, 2026-10-10). A visit at a place seated in a polyclinic or
  -- centre counts in that SEATING's session, AM or PM; every other visit counts in the customer's list.
  -- The visit's list_type is what every board reads, so AM and PM KPIs follow the session he planned.
  v_list_type := coalesce(
    (select pl.session from public.phoenix_crm_places pl where pl.id = v_place_id and pl.customer_id = v_customer.id),
    v_customer.list_type
  );

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
    v_id, v_seat, v_line, v_customer.id, v_list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
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

  -- Everyone who came, BEFORE the off-plan row below: its reviewer trigger reads this list.
  perform public.phoenix_crm_set_visit_companions(v_id, p -> 'companions');

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
    'list_type', v_list_type,
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

-- ── 5. The Super Admin's correction ─────────────────────────────────────────────────────────────

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
  -- Everyone on the visit, the fixed places and phoenix_crm_visit_companions together, sorted.
  v_before_set text[];
  v_after_set text[];
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

  v_before_set := public.phoenix_crm_visit_companion_ids(v_id);
  v_after_set := v_before_set;
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
      or (v_kind = 'chain' and v_manager is not null and (v_senior is not null or v_product_manager is not null))
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
    select coalesce(array_agg(distinct s.hr_id order by s.hr_id), '{}'::text[])
    into v_after_set
    from (
      select upper(btrim(h)) as hr_id
      from unnest(array[v_manager, v_senior, v_product_manager]) as h
      where nullif(btrim(coalesce(h, '')), '') is not null
      union
      select upper(btrim(e ->> 'hr_id'))
      from jsonb_array_elements(case when jsonb_typeof(p -> 'companions') = 'array' then p -> 'companions' else '[]'::jsonb end) as e
      where jsonb_typeof(e) = 'object'
        and nullif(btrim(coalesce(e ->> 'hr_id', '')), '') is not null
        and upper(btrim(e ->> 'hr_id')) <> upper(btrim(v_visit.rep_hr_id))
    ) s;
  end if;

  -- Nothing different: no copy, no write, and the caller is told so.
  if v_new_kind is not distinct from v_visit.kind
    and v_new_manager is not distinct from v_visit.manager_hr_id
    and v_new_senior is not distinct from v_visit.senior_hr_id
    and v_new_product_manager is not distinct from v_visit.product_manager_hr_id
    and v_after_set is not distinct from v_before_set
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
      'companion_hr_ids', to_jsonb(v_before_set),
      'products', to_jsonb(v_visit.products),
      'comment', v_visit.comment,
      'linked_pharmacy_visits', v_linked_before
    ),
    jsonb_build_object(
      'kind', v_new_kind,
      'manager_hr_id', v_new_manager,
      'senior_hr_id', v_new_senior,
      'product_manager_hr_id', v_new_product_manager,
      'companion_hr_ids', to_jsonb(v_after_set),
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

  if v_change_who then
    perform public.phoenix_crm_set_visit_companions(v_id, p -> 'companions');
  end if;

  update public.phoenix_crm_visits
  set products = v_products
  where linked_from_visit_id = v_id
    and products is distinct from v_products;

  return jsonb_build_object('visit_id', v_id, 'changed', true);
end;
$$;

revoke execute on function public.phoenix_crm_admin_edit_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_edit_visit(jsonb) to service_role;

-- ── 6. The Super Admin's missed-visit entry ─────────────────────────────────────────────────────

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
  -- Single, double or chain — HIS choice too (owner, 2026-10-24). An older caller sends none: single.
  v_kind text := coalesce(nullif(trim(coalesce(p ->> 'kind', '')), ''), 'single');
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  -- The first product-side person who came (2026-10-27); everyone past the fixed places is in
  -- phoenix_crm_visit_companions, written right after the visit.
  v_product_manager text := upper(nullif(trim(coalesce(p ->> 'product_manager_hr_id', '')), ''));
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
    or (v_comment is not null and char_length(v_comment) > 1000)
    -- The four a rep logs himself (2026-10-27: the product side too — "Everything is applicable").
    or v_kind not in ('single', 'double', 'product_manager', 'chain')
    or (v_kind = 'single' and (v_manager is not null or v_senior is not null or v_product_manager is not null))
    or (v_kind = 'double' and (v_manager is null or v_senior is not null or v_product_manager is not null))
    or (v_kind = 'product_manager' and (v_manager is not null or v_senior is not null or v_product_manager is null))
    or (v_kind = 'chain' and (v_manager is null or (v_senior is null and v_product_manager is null)))
    or v_product_manager = v_rep then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- Anytime that has HAPPENED: a day that has not begun yet holds no visit to have missed.
  if v_date > v_running_day then
    raise exception 'phoenix_crm:future_day';
  end if;

  -- None is allowed on his entry (owner, 2026-10-24); twelve stays the most, as everywhere.
  select coalesce(array_agg(trim(e.value) order by e.ordinality), '{}'::text[])
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if cardinality(v_products) > 12 then
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
        'kind', v_existing.kind,
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
    senior_hr_id, product_manager_hr_id, entered_by_hr_id, products, comment, product_availability, samples_given, photo_path,
    lat, lon, accuracy_meters, place_id, distance_meters, location_flag, is_test,
    is_unplanned, unplanned_kind, capture_source, synced_at
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
    v_senior, v_product_manager, v_actor, v_products, v_comment, '{}'::jsonb, '{}'::jsonb, null,
    -- No reading: he was not at the door. 'no_place' says there is nothing to measure against.
    null, null, null, null, null, 'no_place', v_is_test,
    not v_planned, case when v_planned then null else 'out_of_plan' end, 'admin', now()
  );

  -- Everyone who came, BEFORE the off-plan row below: its reviewer trigger reads this list.
  perform public.phoenix_crm_set_visit_companions(v_id, p -> 'companions');

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
    'kind', v_kind,
    'is_unplanned', not v_planned,
    'unplanned_kind', case when v_planned then null else 'out_of_plan' end,
    'capture_source', 'admin',
    'duplicate', false
  );
end;
$$;

revoke execute on function public.phoenix_crm_admin_enter_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_admin_enter_visit(jsonb) to service_role;

-- ── 7. The off-plan reviewer who was on the visit skips himself — any companion counts ───────────

create or replace function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status = 'manager_pending'
    and new.manager_hr_id is not null
    and exists (
      select 1 from public.phoenix_crm_visits v
      where v.id = new.visit_id
        and upper(btrim(new.manager_hr_id)) in (
          upper(btrim(coalesce(v.manager_hr_id, ''))),
          upper(btrim(coalesce(v.senior_hr_id, ''))),
          upper(btrim(coalesce(v.product_manager_hr_id, '')))
        )
    ) or (
      new.status = 'manager_pending'
      and new.manager_hr_id is not null
      -- Anyone else who came (2026-10-27): the save writes this list before the off-plan row.
      and exists (
        select 1 from public.phoenix_crm_visit_companions c
        where c.visit_id = new.visit_id
          and c.hr_id = upper(btrim(new.manager_hr_id))
      )
    ) then
    new.status := 'sfe_pending';
  end if;
  return new;
end;
$$;

revoke execute on function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself() from public, anon, authenticated;
grant execute on function public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself() to service_role;

-- ── 8. The visits door: one more column, everyone on the visit ──────────────────────────────────

create or replace view public.crm_visits_unified
  with (security_invoker = true)
as
select
  v.id,
  v.crm_visit_id,
  v.visit_date,
  v.agent_crm_id,
  -- PHOENIX NAMES THE PERSON (owner, 2026-10-22): the employee the row's hr id resolves to, with the vendor's
  -- "( territory )" kept so every board that reads the territory off this label still finds it. A row with
  -- no hr id keeps the vendor label here (see the header).
  case when agent_person.full_name_nz is not null then concat_ws(' ', agent_person.full_name_nz, substring(v.agent_name from '(\([^()]*\))\s*$')) else v.agent_name end as agent_name,
  v.agent_hr_id,
  v.double_crm_id,
  case when double_person.full_name_nz is not null then concat_ws(' ', double_person.full_name_nz, substring(v.double_name from '(\([^()]*\))\s*$')) else v.double_name end as double_name,
  v.double_hr_id,
  v.contact_crm_id,
  -- PHOENIX NAMES THE DOCTOR: his validated Phoenix customer's name and speciality, when he has one.
  coalesce(truth.name, v.contact_name) as contact_name,
  v.customer_name,
  v.comment,
  v.visit_type,
  v.visit_type_description,
  v.call_type,
  v.ampm,
  v.attendance,
  v.crm_save_date,
  v.raw_payload,
  v.synced_at,
  v.created_at,
  v.updated_at,
  v.visit_date_time,
  v.crm_region_id,
  v.crm_region_name,
  coalesce(truth.speciality, v.speciality) as speciality,
  v.crm_contact_grade,
  'ireports360'::text as source,
  v.agent_crm_id as exclusion_crm_id,
  null::boolean as phoenix_customer_validated,
  -- The second person beside the rep. The vendor shape has one partner column, so it is null on every
  -- vendor row — appended, never inserted, so nothing reading by position moves.
  null::bigint as double2_crm_id,
  null::text as double2_name,
  null::text as double2_hr_id,
  -- THE PHOENIX FIELD SET (owner, 2026-10-07: "everything, GPS and evidence included" on the admin
  -- reports). Null on every iReports360 row, because the vendor feed never carried any of it —
  -- appended, never inserted, so nothing reading by position moves. What each READER may see of the
  -- location and timing half is golden rule #1's three tiers, decided per role in TypeScript
  -- (src/lib/crm/phoenix-visit-detail.ts), never by hiding a column here.
  null::text as visit_kind,
  null::text as entered_by_hr_id,
  null::text[] as products,
  null::jsonb as samples_given,
  null::jsonb as product_availability,
  null::text as objection,
  null::text as objection_note,
  null::text as next_step,
  null::date as next_step_on,
  null::text as visit_pharmacy_name,
  null::boolean as is_unplanned,
  null::text as unplanned_kind,
  null::text as photo_path,
  null::text as voice_note_path,
  null::integer as voice_note_seconds,
  null::double precision as lat,
  null::double precision as lon,
  null::numeric as accuracy_meters,
  null::integer as distance_meters,
  null::text as location_flag,
  null::double precision as photo_lat,
  null::double precision as photo_lon,
  null::numeric as photo_accuracy_meters,
  null::integer as dwell_seconds,
  null::integer as form_open_seconds,
  null::text as capture_source,
  null::integer as offline_seconds,
  null::integer as device_skew_minutes,
  null::timestamptz as phoenix_synced_at,
  null::text[] as companion_hr_ids
from (
  -- 🔴 ONE SCAN OF THE VENDOR TABLE, NOT TWO, AND THE ENTRY DAY IS AN INDEX LOOKUP (speed, 2026-10-23).
  -- Two things were paid on every read. (1) The split below was two UNION ALL branches over the same
  -- table, so one read scanned ireports360_visits twice. (2) Each "Phoenix wins the day" check walked a
  -- MATERIALIZED CTE of all 542 entry days ONCE PER VENDOR ROW — a function scan carries no statistics
  -- and no index, so the planner had nothing else to use. Merged into one scan reading the cache TABLE,
  -- the checks become probes of its own PRIMARY KEY (hr_key, entry_day) and its partial
  -- (agent_crm_id, entry_day) index. Measured on production, nine interleaved runs of each shape: one
  -- day 17.0 -> 7.0 ms, a month straddling the first team start 563 -> 336 ms, every row identical.
  -- The two arms stay mutually exclusive on the SAME live bound, so no row is produced twice or lost.
  select x.*
    from public.ireports360_visits x
   where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
     and (
       -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): no rep has a Phoenix entry on a day earlier than the
       -- first team start, or than that start's earlier day_activities_from, so "Phoenix wins the day" can
       -- drop nothing there and is not asked. The bound is read live, so a team started later moves nothing.
       x.visit_date < (
         select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)
           from public.phoenix_crm_team_starts t
       )
       -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP (owner, 2026-10-16): on a
       -- day he has a countable entry in Phoenix CRM his iReports360 row is dropped; on a day he has none,
       -- the vendor row counts. A district manager has no entry day (rep seats only), so he keeps both.
       or (
         -- 🔴 READ FROM THE CACHE TABLE, NOT THROUGH phoenix_crm_rep_entry_days(). The function is that
         -- table and nothing else, and phoenix_crm_rep_entry_days_calc() is still the ONLY body that
         -- COMPUTES an entry day — this reads what that body wrote. Both doors are security_invoker and
         -- are granted to postgres and service_role alone; the cache carries exactly those two grants and
         -- both roles are BYPASSRLS, so reading it directly reaches the same rows for the same readers
         -- the SECURITY DEFINER function did.
         not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where e.hr_key = lower(btrim(x.agent_hr_id))
              and e.entry_day = x.visit_date
         )
         -- A vendor row the sync could not give an hr id is still his, by his CRM id.
         and not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where nullif(btrim(x.agent_hr_id), '') is null
              and e.agent_crm_id = x.agent_crm_id
              and e.entry_day = x.visit_date
         )
       )
     )
) v
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = v.contact_crm_id
-- One row per person whatever the casing (the cache's own key), so a person can never double a visit.
left join public.crm_person_by_hr_key_cache agent_person on agent_person.hr_key = upper(btrim(v.agent_hr_id))
left join public.crm_person_by_hr_key_cache double_person on double_person.hr_key = upper(btrim(v.double_hr_id))
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  p.visit_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  case when p.rep_hr_id is not null and partner1.crm_id ~ '^[0-9]+$' then partner1.crm_id::bigint end,
  case when p.rep_hr_id is not null then partner1.full_name end,
  case when p.rep_hr_id is not null then coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id) end,
  -- A doctor a rep added in Phoenix CRM has no vendor id and answers to his own, so no per-doctor
  -- report drops him. 923 of 12,574 customers are in that position today.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
  customer.name,
  null::text,
  p.comment,
  0,
  'Regular Visit'::text,
  null::integer,
  p.list_type,
  null::integer,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  -- When the row reached the server — NEVER phoenix_crm_visits.synced_at, which is the offline-capture
  -- fact golden rule #1 keeps off every rep-facing read (tests/phoenix-crm-blind-half.test.ts).
  p.created_at,
  p.created_at,
  p.created_at,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::integer,
  null::text,
  customer.speciality,
  customer.grade,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint),
  p.customer_validated,
  case when p.rep_hr_id is not null and partner2.crm_id ~ '^[0-9]+$' then partner2.crm_id::bigint end,
  case when p.rep_hr_id is not null then partner2.full_name end,
  -- One line, like every other select item: the door's own row-shape pin reads this list a LINE at a
  -- time, so an expression wrapped over six lines counts as six columns and the two branches stop
  -- matching item for item.
  case when p.rep_hr_id is not null then case when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id) when p.product_manager_hr_id is not null then p.senior_hr_id end end,
  -- THE PHOENIX FIELD SET, in the order the columns were appended. One select item per line: the
  -- door's row-shape pin reads this list a LINE at a time.
  p.kind,
  p.entered_by_hr_id,
  p.products,
  p.samples_given,
  p.product_availability,
  p.objection,
  p.objection_note,
  p.next_step,
  p.next_step_on,
  p.pharmacy_name,
  p.is_unplanned,
  p.unplanned_kind,
  p.photo_path,
  p.voice_note_path,
  p.voice_note_seconds,
  p.lat,
  p.lon,
  p.accuracy_meters,
  p.distance_meters,
  p.location_flag,
  p.photo_lat,
  p.photo_lon,
  p.photo_accuracy_meters,
  p.dwell_seconds,
  p.form_open_seconds,
  p.capture_source,
  p.offline_seconds,
  p.device_skew_minutes,
  p.synced_at,
  -- EVERYONE who came with the rep (2026-10-27): the three fixed places and every row of
  -- phoenix_crm_visit_companions, once each, sorted. double_hr_id/double2_hr_id above stay the first two.
  case when p.rep_hr_id is not null then (select array_agg(distinct cv.hr_id order by cv.hr_id) from (select upper(btrim(h)) as hr_id from unnest(array[p.manager_hr_id, p.senior_hr_id, p.product_manager_hr_id]) as h where nullif(btrim(coalesce(h, '')), '') is not null union select c.hr_id from public.phoenix_crm_visit_companions c where c.visit_id = p.id) cv) end
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
-- LEFT, not INNER, so a read that wants none of the four columns below gets no join at all: the FK
-- on p.customer_id is NOT NULL and validated, so this cannot drop a row either way (20261024180000).
left join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing (the cache's own key), so a person can never double a visit.
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
-- SLOT 1 — the first person beside the rep, in the order the rep's own form puts them: the manager who
-- rode along, else the product manager (whose visits carried nobody at all before this), else the
-- senior. Taking the product manager here is what repairs every existing reader without a new column.
left join public.crm_person_by_hr_key_cache partner1 on partner1.hr_key = upper(btrim(coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id)))
-- SLOT 2 — the chain's other person: the senior above the manager, or the product manager who came
-- with him. Never the same person as slot 1, because each column is read once.
left join public.crm_person_by_hr_key_cache partner2 on partner2.hr_key = upper(btrim(
  case
    when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id)
    when p.product_manager_hr_id is not null then p.senior_hr_id
  end
))
-- phoenix_crm_countable_visits is the module's one predicate for "this visit counts" (an off-plan visit
-- only once approved) — read, never re-typed. Its other half, customer_validated (owner, 2026-10-01), is
-- CARRIED rather than filtered: a working rep's visit to a customer he has not validated yet is still a
-- day's work for every "did he work" reader, and the call rate leaves it out of the rate by the column.
where not p.is_test
union all
select
  a.id,
  -1 - ('x' || substr(md5(a.id::text), 1, 13))::bit(52)::bigint,
  a.activity_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  a.rep_hr_id,
  null::bigint,
  null::text,
  null::text,
  null::bigint,
  null::text,
  null::text,
  -- A sales day reads as iReports360 carried one: code -7, its comment beginning "Sales day".
  case when a.activity_type = 'sales_day' then btrim('Sales day ' || coalesce(a.note, '')) else a.note end,
  case a.activity_type
    when 'meeting' then -11
    when 'conference' then -1
    when 'health_day' then -15
    when 'sales_day' then -7
    when 'training' then -9
    when 'admin_work' then -20
    when 'travel' then -12
    when 'group_meeting' then -2
    when 'rtd' then -22
  end,
  case a.activity_type
    when 'meeting' then 'Meeting'
    when 'conference' then 'Conference'
    when 'health_day' then 'Health Day'
    when 'sales_day' then 'Sales day'
    when 'training' then 'Training'
    when 'admin_work' then 'Admin Work'
    when 'travel' then 'Traveling'
    when 'group_meeting' then 'Group Meeting'
    when 'rtd' then 'RTD'
  end,
  null::integer,
  null::text,
  null::integer,
  (a.created_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  a.created_at,
  a.created_at,
  a.updated_at,
  a.activity_date::timestamp at time zone 'UTC',
  null::integer,
  null::text,
  null::text,
  null::text,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint),
  null::boolean,
  null::bigint,
  null::text,
  null::text,
  null::text,
  null::text,
  null::text[],
  null::jsonb,
  null::jsonb,
  null::text,
  null::text,
  null::text,
  null::date,
  null::text,
  null::boolean,
  null::text,
  null::text,
  null::text,
  null::integer,
  null::double precision,
  null::double precision,
  null::numeric,
  null::integer,
  null::text,
  null::double precision,
  null::double precision,
  null::numeric,
  null::integer,
  null::integer,
  null::text,
  null::integer,
  null::integer,
  null::timestamptz,
  null::text[]
from public.phoenix_crm_day_activities a
join (
  select t.seat_id, t.team_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_started_team_seats() t
  union
  -- The manager's OWN seat ("Yes, the whole team"): a district manager has no territory of his own, so
  -- a day he recorded sits on his team seat. phoenix_crm_started_team_reps counts that seat the same way.
  select s.team_seat_id, s.team_seat_id, s.starts_on, s.stops_on from public.phoenix_crm_team_starts s
) team
  on team.seat_id = a.seat_id
left join public.phoenix_crm_team_starts run
  on run.team_seat_id = team.team_seat_id
 and run.starts_on = team.starts_on
 and run.stops_on is not distinct from team.stops_on
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(a.rep_hr_id))
-- A RECORDED day activity (never a planned one), real, of a kind this branch names: a kind the module
-- adds later is left out until it is given its worked-day code here.
where not a.is_test
  -- Counted from the team's start, or from its day_activities_from when that is EARLIER (never later).
  and a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))
  and (team.stops_on is null or a.activity_date < team.stops_on)
  and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd');

notify pgrst, 'reload schema';
commit;
