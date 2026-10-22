-- =============================================================================
-- A PENDING COPY FILLS THE VENDOR'S BLANK IN THE VENDOR PASS, SO THE TWO PASSES STOP UNDOING EACH OTHER
-- =============================================================================
-- WHAT: `public.crm_contact_master_refresh(boolean)` changes in two places; every other line of the body is
--       20261022163100's, byte for byte.
--       1. `crm_refresh_phoenix_truth` now holds EVERY doctor Phoenix CRM has, with a `trusted` flag
--          (Phoenix-born, or a reference customer a rep validated), one row each, picked in the name-row
--          pass's own order: trusted first, then an active row over a dropped one, then the latest
--          validation, then the latest edit.
--       2. THE VENDOR LIST PASS writes, for the name, the speciality and the phone: a TRUSTED Phoenix value,
--          else the vendor's, else the PENDING copy's. The last fallback is new.
--       The name-row pass, both conflict arms and every filter are untouched.
--
-- WHY: owner, 2026-10-22 05:1x Cairo: "fix the phone loop on Peter Alphonse and Mahmoud Khalafa". Both
--      doctors (vendor contacts 95487 and 105208) carry a phone only on a PENDING Phoenix copy, and none in
--      the vendor list. Every run, the vendor pass wrote the vendor's empty phone, and the name-row pass then
--      filled the blank from the pending copy — two writes per doctor per run, `updated_at` moved every hour,
--      the same phone at the end. Measured on production ozucdzovmcqvepbozvqf the same night: a second
--      refresh 15 s after the first reported listContactsChanged = 2, those two. The loop predates
--      20261022163100 (the blank-fill arm it kept for pending copies had it too). With the pending copy as the
--      vendor pass's last fallback, both passes offer the same value and the second run changes nothing.
--
-- NOT CHANGED: a pending copy still overrides nothing the vendor holds (some name a different doctor), and a
--      trusted value still replaces the vendor's (owner, 2026-10-22: Phoenix is the source of trust).
--
-- RECREATED FROM THE LIVE BODY, proved byte-identical to production and staging before the edit:
--       crm_contact_master_refresh     md5(prosrc) = a99ddecb38b6332a972a787e52443806  (20261022163100)
--       The body was generated from that file by exact string replacement, each replacement asserted to
--       match exactly once. SECURITY INVOKER, search_path and the advisory lock are untouched; the comment
--       is re-emitted with one clause added. AFTER this file:
--       crm_contact_master_refresh     md5(prosrc) = 0e5d0165b9ca43d1fb4a18f4ef2015e1
--       That digest is what proves the apply landed — `create or replace` makes the mere presence of the
--       function worthless as evidence.
-- ROLLBACK: re-apply supabase/migrations/20261022163100_phoenix_wins_the_contact_refresh.sql (it re-emits
--       the previous body of this function); nothing it wrote needs undoing.
--
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — crm_refresh_started_reps,
--       crm_refresh_phoenix_customers, crm_refresh_phoenix_truth, crm_contact_master_activity,
--       crm_refresh_phoenix_lists_all and crm_refresh_phoenix_lists, all inside the body of
--       public.crm_contact_master_refresh, which creates and drops them within its own call. They are
--       SESSION-LOCAL scratch tables; no persistent table is dropped or truncated anywhere here.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This file writes
-- no row itself; the two doctors' phones are already the value the refresh now writes in one pass.
-- =============================================================================

create or replace function public.crm_contact_master_refresh(p_include_activity boolean default false)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_lists_live boolean := coalesce(
    (now() at time zone 'Africa/Cairo')::date < (select c.cutover_date from public.crm_cutover c where c.id),
    true
  );
  v_list_contacts integer := 0;
  v_activity_added integer := 0;
  v_activity_updated integer := 0;
  v_bricks integer := 0;
  v_closed integer := 0;
  v_touched integer := 0;
  v_opened integer := 0;
  v_discarded integer := 0;
  v_regions_from_name integer := 0;
  v_started_reps integer := 0;
  v_assignments_frozen integer := 0;
  v_phoenix_reps integer := 0;
  v_vendor_handed_over integer := 0;
  v_phoenix_opened integer := 0;
  v_phoenix_closed integer := 0;
  v_phoenix_regraded integer := 0;
  v_phoenix_touched integer := 0;
  v_step timestamptz := clock_timestamp();
  v_ms jsonb := '{}'::jsonb;
  v_started_keys text[];
  v_started_crm_ids bigint[];
begin
  perform pg_advisory_xact_lock(hashtext('public.crm_contact_master_refresh'));

  drop table if exists pg_temp.crm_refresh_started_reps;
  create temporary table crm_refresh_started_reps on commit drop as
  select distinct s.hr_key, s.agent_crm_id
    from public.phoenix_crm_doctor_list_reps() s
   where v_today >= s.counted_from
     and (s.counted_until is null or v_today < s.counted_until);
  get diagnostics v_started_reps = row_count;

  select coalesce(array_agg(s.hr_key) filter (where s.hr_key is not null), '{}'::text[]),
         coalesce(array_agg(s.agent_crm_id) filter (where s.agent_crm_id is not null), '{}'::bigint[])
    into v_started_keys, v_started_crm_ids
    from pg_temp.crm_refresh_started_reps s;

  select count(*) into v_assignments_frozen
    from public.crm_contact_assignments a
   where a.effective_to is null
     and (
       (nullif(btrim(a.agent_hr_id), '') is not null and lower(btrim(a.agent_hr_id)) = any (v_started_keys))
       or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
           and a.agent_crm_id = any (v_started_crm_ids))
     );

  -- ── ONE READ OF THE CUSTOMER TABLE, FOR EVERY PASS ──────────────────────────────────
  -- The name-row pass below creates the `crm_contacts` row a Phoenix-born doctor needs, and the fifth
  -- pass writes his `crm_contact_assignments` row, which has a foreign key to it. They used to read
  -- `public.phoenix_crm_customers` in two separate statements, and this function runs at READ
  -- COMMITTED, where every statement takes a fresh snapshot: a doctor a rep added between the two
  -- statements was invisible to the name pass and visible to the fifth, so 5b referenced a contact
  -- that did not exist and the whole transaction rolled back. Both passes now read this one snapshot,
  -- so the fifth pass's set is a subset of the one the name pass covered, by construction. Since
  -- 2026-10-22 it is built BEFORE the vendor list pass, which reads what Phoenix holds from it too.
  drop table if exists pg_temp.crm_refresh_phoenix_customers;
  create temporary table crm_refresh_phoenix_customers on commit drop as
  select c.seat_id,
         c.own_contact_crm_id,
         c.reference_contact_crm_id,
         c.list_type,
         c.grade,
         c.status,
         c.validated_at,
         c.is_test,
         c.name,
         c.speciality,
         c.phone,
         c.created_at,
         c.status_changed_at,
         c.updated_at
    from public.phoenix_crm_customers c
   where not c.is_test
     and c.status in ('active', 'pending', 'dropped');
  analyze pg_temp.crm_refresh_phoenix_customers;

  -- ── WHAT PHOENIX HOLDS ABOUT EACH DOCTOR, AND WHEN IT WINS ─────────────────────────────────────────
  -- Owner, 2026-10-22: once Phoenix CRM holds a doctor, Phoenix is the source of trust and its data
  -- override the old CRM's. TRUSTED means a Phoenix-born doctor, or a reference customer a rep VALIDATED:
  -- a pending reference row is a copy of the vendor list awaiting that check, and some of those copies
  -- name a different doctor, so it overrides nothing — it only fills a blank. One row per doctor, picked
  -- in the name-row pass's own order (trusted first, then an active row over a dropped one, then the latest
  -- validation — among trusted rows the order public.crm_contact_phoenix_truth uses), so the vendor pass
  -- below and the name-row pass are offered the SAME Phoenix row and can never undo each other.
  drop table if exists pg_temp.crm_refresh_phoenix_truth;
  create temporary table crm_refresh_phoenix_truth on commit drop as
  select distinct on (coalesce(t.reference_contact_crm_id, t.own_contact_crm_id))
         coalesce(t.reference_contact_crm_id, t.own_contact_crm_id) as contact_crm_id,
         (t.reference_contact_crm_id is null or t.validated_at is not null) as trusted,
         nullif(btrim(t.name), '') as name,
         nullif(btrim(t.speciality), '') as speciality,
         nullif(btrim(t.phone), '') as phone
    from pg_temp.crm_refresh_phoenix_customers t
   order by coalesce(t.reference_contact_crm_id, t.own_contact_crm_id),
            (t.reference_contact_crm_id is null or t.validated_at is not null) desc,
            (t.status = 'active') desc, t.validated_at desc nulls last, t.updated_at desc;
  analyze pg_temp.crm_refresh_phoenix_truth;

  if v_lists_live then
  insert into public.crm_contacts as c (
    contact_crm_id, name, name_ar, speciality, phone, address, city, zone, crm_region_name,
    source, first_seen_on
  )
  select x.contact_crm_id, x.name, x.name_ar, x.speciality, x.phone, x.address, x.city, x.zone,
         x.crm_region_name, x.source, x.first_seen_on
    from (
      select distinct on (m.contact_crm_id)
             m.contact_crm_id as contact_crm_id,
             -- Trusted Phoenix first; the vendor next; a pending copy only fills what both leave blank —
             -- exactly what the name-row pass below would write, so a second run changes nothing.
             coalesce(case when t.trusted then t.name end, nullif(btrim(m.contact_name), ''), t.name) as name,
             nullif(btrim(m.contact_name_ar), '') as name_ar,
             coalesce(case when t.trusted then t.speciality end, nullif(btrim(m.speciality), ''), t.speciality) as speciality,
             coalesce(case when t.trusted then t.phone end, nullif(btrim(m.phone), ''), t.phone) as phone,
             nullif(btrim(m.address), '') as address,
             nullif(btrim(m.city), '') as city,
             nullif(btrim(m.zone), '') as zone,
             nullif(btrim(m.crm_region_name), '') as crm_region_name,
             'list'::text as source,
             least((m.first_seen_at at time zone 'Africa/Cairo')::date, v_today) as first_seen_on
        from public.ireports360_contacts m
        left join pg_temp.crm_refresh_phoenix_truth t on t.contact_crm_id = m.contact_crm_id
       where m.contact_crm_id > 0
         and m.contact_crm_id <> 100000
       order by m.contact_crm_id, m.synced_at desc nulls last, m.list_type, m.agent_crm_id
    ) x
    left join public.crm_contacts e on e.contact_crm_id = x.contact_crm_id
   where e.contact_crm_id is null
      or (e.name, e.name_ar, e.speciality, e.phone, e.address, e.city, e.zone, e.crm_region_name, e.source)
           is distinct from
         (coalesce(x.name, e.name), x.name_ar, x.speciality, x.phone,
          x.address, x.city, x.zone, x.crm_region_name, 'list')
      or e.first_seen_on > x.first_seen_on
  on conflict (contact_crm_id) do update set
         name = coalesce(excluded.name, c.name),
         name_ar = excluded.name_ar,
         speciality = excluded.speciality,
         phone = excluded.phone,
         address = excluded.address,
         city = excluded.city,
         zone = excluded.zone,
         crm_region_name = excluded.crm_region_name,
         source = 'list',
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.name_ar, c.speciality, c.phone, c.address, c.city, c.zone, c.crm_region_name, c.source)
           is distinct from
         (coalesce(excluded.name, c.name), excluded.name_ar, excluded.speciality, excluded.phone,
          excluded.address, excluded.city, excluded.zone, excluded.crm_region_name, 'list')
      or c.first_seen_on > excluded.first_seen_on;
  get diagnostics v_list_contacts = row_count;
  end if;

  -- ── A STARTED REP'S OWN DOCTORS GET THEIR NAME ROW, AND PHOENIX'S NAME WINS ──────────────────────────
  -- A doctor born in Phoenix CRM answers to `own_contact_crm_id` (20261007193000) and has no row in
  -- `crm_contacts`, so every per-doctor report would print a bare id. The activity pass below finds him
  -- once he has a visit or a plan; this one finds him the moment he is on a list, which is sooner, and
  -- it is what lets the fifth assignment pass reference him at all — `crm_contact_assignments` has a
  -- foreign key to this table.
  -- What it offers (owner, 2026-10-22: Phoenix is the source of trust): a TRUSTED row's name, speciality
  -- and phone REPLACE what the row holds; an untrusted one (a pending reference copy) only fills a blank,
  -- as every row used to. A blank in Phoenix never erases a value already on file.
  insert into public.crm_contacts as c (
    contact_crm_id, name, speciality, phone, source, first_seen_on
  )
  select x.contact_crm_id, o.name, o.speciality, o.phone, x.source, x.first_seen_on
    from (
      select distinct on (coalesce(p.reference_contact_crm_id, p.own_contact_crm_id))
             coalesce(p.reference_contact_crm_id, p.own_contact_crm_id) as contact_crm_id,
             nullif(btrim(p.name), '') as name,
             nullif(btrim(p.speciality), '') as speciality,
             nullif(btrim(p.phone), '') as phone,
             (p.reference_contact_crm_id is null or p.validated_at is not null) as trusted,
             'phoenix'::text as source,
             least((p.created_at at time zone 'Africa/Cairo')::date, v_today) as first_seen_on
        from pg_temp.crm_refresh_phoenix_customers p
       where not p.is_test
         and p.status in ('active', 'pending', 'dropped')
       order by coalesce(p.reference_contact_crm_id, p.own_contact_crm_id),
                (p.reference_contact_crm_id is null or p.validated_at is not null) desc,
                (p.status = 'active') desc, p.validated_at desc nulls last, p.updated_at desc
    ) x
    left join public.crm_contacts e on e.contact_crm_id = x.contact_crm_id
    cross join lateral (
      select case when x.trusted then x.name else coalesce(e.name, x.name) end as name,
             case when x.trusted then x.speciality else coalesce(e.speciality, x.speciality) end as speciality,
             case when x.trusted then x.phone else coalesce(e.phone, x.phone) end as phone
    ) o
   where e.contact_crm_id is null
      or (e.name, e.speciality, e.phone) is distinct from
         (coalesce(o.name, e.name), coalesce(o.speciality, e.speciality), coalesce(o.phone, e.phone))
      or e.first_seen_on > x.first_seen_on
  on conflict (contact_crm_id) do update set
         -- Phoenix's value replaces the one on file; a blank offered keeps what is there.
         name = coalesce(excluded.name, c.name),
         speciality = coalesce(excluded.speciality, c.speciality),
         phone = coalesce(excluded.phone, c.phone),
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.speciality, c.phone) is distinct from
         (coalesce(excluded.name, c.name), coalesce(excluded.speciality, c.speciality), coalesce(excluded.phone, c.phone))
      or c.first_seen_on > excluded.first_seen_on;

  v_ms := v_ms || jsonb_build_object('list', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  if p_include_activity then
    drop table if exists pg_temp.crm_contact_master_activity;
    create temporary table crm_contact_master_activity on commit drop as
    with visit_latest as (
      select distinct on (v.contact_crm_id)
             v.contact_crm_id,
             nullif(btrim(v.contact_name), '') as name,
             nullif(btrim(v.speciality), '') as speciality,
             v.crm_region_id,
             nullif(btrim(v.crm_region_name), '') as crm_region_name,
             (min(v.visit_date) over w)::date as first_on,
             (max(v.visit_date) over w)::date as last_on
        from public.crm_visits_unified v
       where v.contact_crm_id > 0
         and v.contact_crm_id <> 100000
      window w as (partition by v.contact_crm_id)
       order by v.contact_crm_id, v.visit_date desc nulls last, v.crm_visit_id desc nulls last
    ),
    plan_latest as (
      select distinct on (p.contact_crm_id)
             p.contact_crm_id,
             nullif(btrim(p.contact_name), '') as name,
             nullif(btrim(p.speciality), '') as speciality,
             nullif(btrim(p.crm_region_name), '') as crm_region_name,
             (min(p.plan_date) over w)::date as first_on
        from public.crm_plan_entries_unified p
       where p.contact_crm_id > 0
         and p.contact_crm_id <> 100000
      window w as (partition by p.contact_crm_id)
       order by p.contact_crm_id, p.plan_date desc nulls last, p.crm_plan_entry_id desc nulls last
    )
    select coalesce(v.contact_crm_id, p.contact_crm_id) as contact_crm_id,
           case when v.contact_crm_id is not null then 'visit' else 'plan' end as source,
           coalesce(v.name, p.name) as name,
           coalesce(v.speciality, p.speciality) as speciality,
           v.crm_region_id,
           coalesce(v.crm_region_name, p.crm_region_name) as crm_region_name,
           least(v.first_on, p.first_on, (now() at time zone 'Africa/Cairo')::date) as first_seen_on,
           v.last_on as last_visited_on
      from visit_latest v
      full join plan_latest p on p.contact_crm_id = v.contact_crm_id;

    insert into public.crm_contacts as c (
      contact_crm_id, name, speciality, crm_region_id, crm_region_name, source, first_seen_on, last_visited_on
    )
    select a.contact_crm_id, a.name, a.speciality, a.crm_region_id, a.crm_region_name, a.source,
           a.first_seen_on, a.last_visited_on
      from pg_temp.crm_contact_master_activity a
     where not exists (select 1 from public.crm_contacts e where e.contact_crm_id = a.contact_crm_id)
    on conflict (contact_crm_id) do nothing;
    get diagnostics v_activity_added = row_count;

    update public.crm_contacts c
       set name = coalesce(c.name, a.name),
           speciality = coalesce(c.speciality, a.speciality),
           crm_region_id = coalesce(c.crm_region_id, a.crm_region_id),
           crm_region_name = coalesce(c.crm_region_name, a.crm_region_name),
           first_seen_on = least(c.first_seen_on, a.first_seen_on),
           last_visited_on = greatest(c.last_visited_on, a.last_visited_on),
           updated_at = now()
      from pg_temp.crm_contact_master_activity a
     where a.contact_crm_id = c.contact_crm_id
       and (c.name, c.speciality, c.crm_region_id, c.crm_region_name, c.first_seen_on, c.last_visited_on)
             is distinct from
           (coalesce(c.name, a.name), coalesce(c.speciality, a.speciality), coalesce(c.crm_region_id, a.crm_region_id),
            coalesce(c.crm_region_name, a.crm_region_name), least(c.first_seen_on, a.first_seen_on),
            greatest(c.last_visited_on, a.last_visited_on));
    get diagnostics v_activity_updated = row_count;
  end if;
  v_ms := v_ms || jsonb_build_object('activity', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  if exists (
    select 1
      from public.crm_contacts w
     where w.crm_region_id is null
       and nullif(btrim(w.crm_region_name), '') is not null
  ) then
    update public.crm_contacts c
       set crm_region_id = r.crm_region_id,
           updated_at = now()
      from (
        select distinct on (lower(btrim(m.crm_region_name))) lower(btrim(m.crm_region_name)) as region_name, m.crm_region_id
          from public.ireports360_visits m
         where m.crm_region_id is not null
           and nullif(btrim(m.crm_region_name), '') is not null
           and lower(btrim(m.crm_region_name)) in (
             select lower(btrim(w.crm_region_name))
               from public.crm_contacts w
              where w.crm_region_id is null
                and nullif(btrim(w.crm_region_name), '') is not null
           )
         order by lower(btrim(m.crm_region_name)), m.visit_date desc nulls last
      ) r
     where c.crm_region_id is null
       and lower(btrim(c.crm_region_name)) = r.region_name;
    get diagnostics v_regions_from_name = row_count;
  end if;
  v_ms := v_ms || jsonb_build_object('regions', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  with resolved as (
    select c.contact_crm_id,
           case
             when cr.status = 'mapped' and cr.brick_id is not null then cr.brick_id
             when rr.status = 'mapped' and rr.brick_id is not null then rr.brick_id
           end as brick_id,
           case
             when cr.status = 'mapped' and cr.brick_id is not null then 'customer'
             when rr.status = 'mapped' and rr.brick_id is not null then 'region'
             else 'pending'
           end as brick_status
      from public.crm_contacts c
      left join public.ireports360_crm_customer_brick_resolutions cr on cr.crm_contact_id = c.contact_crm_id
      left join public.ireports360_crm_region_brick_resolutions rr on rr.crm_region_id = c.crm_region_id
  )
  update public.crm_contacts c
     set brick_id = r.brick_id,
         brick_status = r.brick_status,
         updated_at = now()
    from resolved r
   where r.contact_crm_id = c.contact_crm_id
     and (c.brick_id, c.brick_status) is distinct from (r.brick_id, r.brick_status);
  get diagnostics v_bricks = row_count;
  v_ms := v_ms || jsonb_build_object('bricks', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  if v_lists_live then

  -- THE FOUR ASSIGNMENT PASSES. Each one skips a rep whose own team has started in Phoenix CRM: the
  -- VENDOR never writes his rows again. The fifth pass below is what then keeps them current.
  -- Leaving the INSERT unguarded would be the whole bug — a doctor a manager removed would have no open
  -- row, so `not exists (...)` would be true and the vendor would re-open him.

  delete from public.crm_contact_assignments a
   where a.effective_to is null
     and a.effective_from >= v_today
     and a.source = 'ireports360'
     and not exists (
       select 1
         from public.ireports360_contacts m
        where m.contact_crm_id = a.contact_crm_id
          and m.agent_crm_id = a.agent_crm_id
          and m.list_type = a.list_type
          and (m.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(m.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
          and public.crm_contact_fold_grade(m.contact_grade) is not distinct from a.grade
     )
     and not (
       (nullif(btrim(a.agent_hr_id), '') is not null and lower(btrim(a.agent_hr_id)) = any (v_started_keys))
       or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
           and a.agent_crm_id = any (v_started_crm_ids))
     );
  get diagnostics v_discarded = row_count;

  update public.crm_contact_assignments a
     set effective_to = greatest(a.effective_from, least(a.last_seen_on, v_today - 1)),
         updated_at = now()
   where a.effective_to is null
     and a.source = 'ireports360'
     and not exists (
       select 1
         from public.ireports360_contacts m
        where m.contact_crm_id = a.contact_crm_id
          and m.agent_crm_id = a.agent_crm_id
          and m.list_type = a.list_type
          and (m.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(m.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
          and public.crm_contact_fold_grade(m.contact_grade) is not distinct from a.grade
     )
     and not (
       (nullif(btrim(a.agent_hr_id), '') is not null and lower(btrim(a.agent_hr_id)) = any (v_started_keys))
       or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
           and a.agent_crm_id = any (v_started_crm_ids))
     );
  get diagnostics v_closed = row_count;

  update public.crm_contact_assignments a
     set last_seen_on = greatest(a.last_seen_on, s.seen_on),
         agent_hr_id = coalesce(s.agent_hr_id, a.agent_hr_id),
         updated_at = now()
    from (
      select m.contact_crm_id, m.agent_crm_id, m.list_type, m.agent_hr_id,
             public.crm_contact_fold_grade(m.contact_grade) as grade,
             least((coalesce(m.synced_at, now()) at time zone 'Africa/Cairo')::date, v_today) as seen_on
        from public.ireports360_contacts m
       where m.contact_crm_id > 0
         and m.contact_crm_id <> 100000
    ) s
   where a.effective_to is null
     and a.source = 'ireports360'
     and s.contact_crm_id = a.contact_crm_id
     and s.agent_crm_id = a.agent_crm_id
     and s.list_type = a.list_type
     and (s.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(s.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
     and s.grade is not distinct from a.grade
     and (a.last_seen_on < s.seen_on or coalesce(s.agent_hr_id, a.agent_hr_id) is distinct from a.agent_hr_id)
     and not (
       (nullif(btrim(a.agent_hr_id), '') is not null and lower(btrim(a.agent_hr_id)) = any (v_started_keys))
       or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
           and a.agent_crm_id = any (v_started_crm_ids))
     );
  get diagnostics v_touched = row_count;

  insert into public.crm_contact_assignments (
    contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on
  )
  select s.contact_crm_id, s.agent_crm_id, s.agent_hr_id, s.list_type, s.grade,
         s.starts_on,
         greatest(s.seen_on, s.starts_on)
    from (
      select m.contact_crm_id, m.agent_crm_id, m.agent_hr_id, m.list_type,
             public.crm_contact_fold_grade(m.contact_grade) as grade,
             least((coalesce(m.synced_at, now()) at time zone 'Africa/Cairo')::date, v_today) as seen_on,
             least(
               v_today,
               greatest(
                 coalesce((m.first_seen_at at time zone 'Africa/Cairo')::date, v_today),
                 coalesce(prev.last_to + 1, (m.first_seen_at at time zone 'Africa/Cairo')::date, v_today)
               )
             ) as starts_on
        from public.ireports360_contacts m
        left join lateral (
          select max(p.effective_to) as last_to
            from public.crm_contact_assignments p
           where p.contact_crm_id = m.contact_crm_id
             and p.agent_crm_id = m.agent_crm_id
             and p.list_type = m.list_type
             and p.effective_to is not null
        ) prev on true
       where m.contact_crm_id > 0
         and m.contact_crm_id <> 100000
         and not exists (
           select 1
             from public.crm_contact_assignments o
            where o.effective_to is null
              and o.contact_crm_id = m.contact_crm_id
              and o.agent_crm_id = m.agent_crm_id
              and o.list_type = m.list_type
         )
         and not (
           (nullif(btrim(m.agent_hr_id), '') is not null and lower(btrim(m.agent_hr_id)) = any (v_started_keys))
           or (nullif(btrim(m.agent_hr_id), '') is null and m.agent_crm_id is not null
               and m.agent_crm_id = any (v_started_crm_ids))
         )
    ) s;
  get diagnostics v_opened = row_count;
  end if;

  -- ── 5. THE FIFTH PASS: A STARTED REP'S LIST IS HIS PHOENIX CRM LIST ──────────────────────────────
  -- OUTSIDE `v_lists_live` on purpose: a started team's list must follow Phoenix whether or not the
  -- vendor sweep is still running for everyone else. That is the whole point of a per-team switch.
  --
  -- `agent_crm_id` is carried when the rep has a CRM account and left NULL when he does not — never a
  -- synthetic value, which the screens would print as a raw code beside a real name.
  drop table if exists pg_temp.crm_refresh_phoenix_lists_all;
  drop table if exists pg_temp.crm_refresh_phoenix_lists;
  create temporary table crm_refresh_phoenix_lists_all on commit drop as
  select
    r.hr_key,
    r.hr_id,
    r.agent_crm_id,
    r.counted_from,
    coalesce(c.reference_contact_crm_id, c.own_contact_crm_id) as contact_crm_id,
    c.list_type,
    public.crm_contact_fold_grade(c.grade) as grade,
    c.status,
    -- Never before the team's start, and never before the customer existed. Cairo days throughout: a
    -- bare `::date` on a timestamptz would read a UTC day and misdate a row saved after 22:00 Cairo.
    greatest(
      r.counted_from,
      least(v_today, (c.created_at at time zone 'Africa/Cairo')::date)
    ) as starts_on,
    -- A dropped customer leaves the list the day BEFORE the drop, so he is out of today's list and out
    -- of every KPI denominator from then on, while the months he was on it keep him.
    greatest(r.counted_from, least(v_today, (c.status_changed_at at time zone 'Africa/Cairo')::date)) - 1 as dropped_to
  from (
    select distinct s.seat_id, s.hr_key, s.hr_id, s.agent_crm_id, s.counted_from
      from public.phoenix_crm_doctor_list_reps() s
     where v_today >= s.counted_from
       and (s.counted_until is null or v_today < s.counted_until)
  ) r
  join pg_temp.crm_refresh_phoenix_customers c
    on c.seat_id = r.seat_id
   and not c.is_test
   -- `outside` never joins a list: an out-of-list visit is not an assignment.
   and c.status in ('active', 'pending', 'dropped');

  -- 🔴 ONE ROW PER (REP, DOCTOR, LIST). A doctor can sit on a seat as TWO customer rows — a rep adds him
  -- (own id N), then adds him again the next day by reference to the first (reference N, own id M) —
  -- and the unique key under the assignments table is the doctor, never the customer. Passes 5b-5e were
  -- written as if a doctor were one row, so two rows differing in grade or creation day made 5b insert the
  -- same key twice, and the whole transaction rolled back. A live row beats a dropped one (a doctor who
  -- has any live customer is on the list, and 5c must not close him), an active one beats a pending one,
  -- and the earliest start keeps the history longest.
  create temporary table crm_refresh_phoenix_lists on commit drop as
  select ranked.hr_key, ranked.hr_id, ranked.agent_crm_id, ranked.counted_from, ranked.contact_crm_id,
         ranked.list_type, ranked.grade, ranked.status, ranked.starts_on, ranked.dropped_to
    from (
      select x.*,
             row_number() over (
               partition by x.hr_key, x.contact_crm_id, x.list_type
               order by (x.status in ('active', 'pending')) desc,
                        (x.status = 'active') desc,
                        case when x.status = 'dropped' then null else x.starts_on end asc nulls last,
                        x.dropped_to desc nulls last,
                        x.grade asc nulls last
             ) as rn
        from pg_temp.crm_refresh_phoenix_lists_all x
    ) ranked
   where ranked.rn = 1;

  select count(distinct hr_key) into v_phoenix_reps
    from pg_temp.crm_refresh_phoenix_lists
   where status in ('active', 'pending');

  -- 5a. HAND THE VENDOR LIST OVER, ONCE. Closed at `counted_from - 1`, so the vendor answers up to the
  -- day before the team started and Phoenix from the start day: no gap, no overlap, nothing deleted.
  -- 🔴 ONLY for a rep who HAS a Phoenix list. Without that guard this takes a real list to zero —
  -- Nermeen Salah's 25 doctors and Mahmoud ElHassanin's 1, and every district manager among the
  -- started people holds no Phoenix list at all.
  update public.crm_contact_assignments a
     set effective_to = greatest(a.effective_from, l.counted_from - 1),
         updated_at = now()
    from (select distinct hr_key, agent_crm_id, counted_from
            from pg_temp.crm_refresh_phoenix_lists
           where status in ('active', 'pending')) l
   where a.effective_to is null
     and a.source = 'ireports360'
     and ((nullif(btrim(a.agent_hr_id), '') is not null and l.hr_key = lower(btrim(a.agent_hr_id)))
          or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
              and l.agent_crm_id = a.agent_crm_id));
  get diagnostics v_vendor_handed_over = row_count;

  -- 5b. OPEN his Phoenix periods. One row per (contact, rep, list) with no open period yet.
  insert into public.crm_contact_assignments (
    contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
  )
  select l.contact_crm_id, l.agent_crm_id, l.hr_id, l.list_type, l.grade,
         -- Never before a period this rep already closed for the same doctor and list, so two periods
         -- can never overlap on one key.
         greatest(l.starts_on, coalesce(prev.last_to + 1, l.starts_on)),
         v_today,
         'phoenix_crm'
    from (select distinct hr_key, hr_id, agent_crm_id, contact_crm_id, list_type, grade, starts_on
            from pg_temp.crm_refresh_phoenix_lists
           where status in ('active', 'pending')) l
    left join lateral (
      select max(p.effective_to) as last_to
        from public.crm_contact_assignments p
       where p.contact_crm_id = l.contact_crm_id
         and p.list_type = l.list_type
         and lower(btrim(p.agent_hr_id)) = l.hr_key
         and p.effective_to is not null
    ) prev on true
   where not exists (
     select 1
       from public.crm_contact_assignments o
      where o.effective_to is null
        and o.contact_crm_id = l.contact_crm_id
        and o.list_type = l.list_type
        and (lower(btrim(o.agent_hr_id)) = l.hr_key
             or (nullif(btrim(o.agent_hr_id), '') is null and o.agent_crm_id is not null
                 and o.agent_crm_id = l.agent_crm_id))
   )
   -- The unique index is (doctor, agent_crm_id, list) while the guard above reads the rep's hr id, so an
   -- open row carrying the same agent_crm_id under another hr id would sail past it and abort the run
   -- for everyone. Skipping one row is the smaller failure.
   and not exists (
     select 1
       from public.crm_contact_assignments k
      where k.effective_to is null
        and l.agent_crm_id is not null
        and k.contact_crm_id = l.contact_crm_id
        and k.agent_crm_id = l.agent_crm_id
        and k.list_type = l.list_type
   );
  get diagnostics v_phoenix_opened = row_count;

  -- 5c. CLOSE a period whose customer has been dropped, or who has left this rep's Phoenix list
  -- altogether. Closed, never deleted — the months he was on the list keep him.
  update public.crm_contact_assignments a
     set effective_to = greatest(a.effective_from, least(v_today - 1, d.dropped_to)),
         updated_at = now()
    from (select distinct hr_key, contact_crm_id, list_type, dropped_to
            from pg_temp.crm_refresh_phoenix_lists
           where status = 'dropped') d
   where a.effective_to is null
     and a.source = 'phoenix_crm'
     and a.contact_crm_id = d.contact_crm_id
     and a.list_type = d.list_type
     and lower(btrim(a.agent_hr_id)) = d.hr_key;
  get diagnostics v_phoenix_closed = row_count;

  -- 5d. A REGRADE IS A NEW PERIOD, NOT AN EDIT. The grade decides a doctor's frequency norm, so
  -- rewriting it in place would restate every month already scored against the old one. The open period
  -- closes yesterday and 5b opens the new grade on the next run.
  update public.crm_contact_assignments a
     set effective_to = greatest(a.effective_from, v_today - 1),
         updated_at = now()
    from (select distinct hr_key, contact_crm_id, list_type, grade
            from pg_temp.crm_refresh_phoenix_lists
           where status in ('active', 'pending')) g
   where a.effective_to is null
     and a.source = 'phoenix_crm'
     and a.contact_crm_id = g.contact_crm_id
     and a.list_type = g.list_type
     and lower(btrim(a.agent_hr_id)) = g.hr_key
     and a.grade is distinct from g.grade
     and a.effective_from < v_today;
  get diagnostics v_phoenix_regraded = row_count;

  -- 5e. STILL ON THE LIST TODAY. `last_seen_on` is what every "as at" read and the vendor close pass
  -- use to date a period's last sighting; a derived row that never moved it would look abandoned.
  update public.crm_contact_assignments a
     set last_seen_on = v_today,
         updated_at = now()
    from (select distinct hr_key, contact_crm_id, list_type
            from pg_temp.crm_refresh_phoenix_lists
           where status in ('active', 'pending')) l
   where a.effective_to is null
     and a.source = 'phoenix_crm'
     and a.contact_crm_id = l.contact_crm_id
     and a.list_type = l.list_type
     and lower(btrim(a.agent_hr_id)) = l.hr_key
     and a.last_seen_on < v_today;
  get diagnostics v_phoenix_touched = row_count;

  v_ms := v_ms || jsonb_build_object('assignments', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);

  return jsonb_build_object(
    'includeActivity', p_include_activity,
    'listsLive', v_lists_live,
    'startedRepsFrozen', v_started_reps,
    'assignmentsFrozen', v_assignments_frozen,
    'listContactsChanged', v_list_contacts,
    'activityContactsAdded', v_activity_added,
    'activityContactsUpdated', v_activity_updated,
    'bricksChanged', v_bricks,
    'regionsFromName', v_regions_from_name,
    'assignmentsDiscarded', v_discarded,
    'assignmentsClosed', v_closed,
    'assignmentsTouched', v_touched,
    'assignmentsOpened', v_opened,
    'phoenixListReps', v_phoenix_reps,
    'phoenixVendorHandedOver', v_vendor_handed_over,
    'phoenixAssignmentsOpened', v_phoenix_opened,
    'phoenixAssignmentsClosed', v_phoenix_closed,
    'phoenixAssignmentsRegraded', v_phoenix_regraded,
    'phoenixAssignmentsTouched', v_phoenix_touched,
    'contactsTotal', (select count(*) from public.crm_contacts),
    'openAssignments', (select count(*) from public.crm_contact_assignments where effective_to is null),
    'ms', v_ms
  );
end;
$function$;

comment on function public.crm_contact_master_refresh(boolean) is
  'Rebuilds crm_contacts and crm_contact_assignments. FIVE assignment passes: four from the iReports360 '
  'scrape, each skipping a rep whose doctor list Phoenix owns, and a fifth that gives that rep his '
  'PHOENIX CRM list in the same table as a new dated period — the vendor period closed at '
  'counted_from - 1, the Phoenix period opened at counted_from, nothing deleted, so a month already '
  'computed still sees the list as it stood (owner, 2026-10-07). A rep with no Phoenix list KEEPS his '
  'vendor list, which is what stops a district manager''s or an unbuilt list going to zero; from '
  '2026-10-15 a rep with no VENDOR list gets his Phoenix list without waiting for his team — the door '
  'is public.phoenix_crm_doctor_list_reps(), never the visits door. It owns only '
  'source = ''phoenix_crm'' rows and never touches a source = ''phoenix'' row: that is one approved human '
  'decision. From 2026-10-22 Phoenix is the source of trust (owner): a Phoenix-born doctor''s and a '
  'VALIDATED Phoenix CRM customer''s name, speciality and phone replace the vendor''s in crm_contacts; '
  'a pending reference copy only fills a blank. See '
  'supabase/migrations/20261015215500_a_vendorless_reps_phoenix_list_opens.sql and '
  'supabase/migrations/20261022163100_phoenix_wins_the_contact_refresh.sql (a pending copy fills a vendor '
  'blank in the vendor pass itself since 20261022163300, so the two passes never undo each other).';
