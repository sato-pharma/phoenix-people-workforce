-- =============================================================================
-- THE DOCTOR-LIST REFRESH SURVIVES A DOCTOR ADDED TWICE ON ONE SEAT
-- =============================================================================
-- WHAT: public.crm_contact_master_refresh gets one change. Its fifth pass (a started rep's list is his
--       Phoenix CRM list) now collapses phoenix_crm_customers to ONE row per (rep, doctor, list) before it
--       opens, closes, regrades or touches anything, and its 5b insert also refuses a key an open row
--       already holds under another hr id. No row is changed by this file.
--
-- WHY: from 2026-10-11 15:00 Cairo every run aborted with
--         duplicate key value violates unique constraint "crm_contact_assignments_open_uidx"
--      ten to thirteen times an hour, and the whole transaction rolled back each time, so no doctor list,
--      region or brick refreshed for any rep in the company. Read by running the function inside a block
--      that always rolls back and catching the violation:
--         Key (contact_crm_id, agent_crm_id, list_type)=(1000038395, 1542, PM) already exists
--         at the 5b insert.
--      The doctor sits on seat SEAT-AIF-REP-CA2 as two customer rows: one created 2026-10-10 (own id
--      1000038395) and one created 2026-10-11 by reference to the first (reference 1000038395, own id
--      1000038463). The unique key under the assignments table is the DOCTOR, not the customer, and 5b-5e
--      assumed one row per doctor: the two rows differ by creation day, so SELECT DISTINCT kept both and
--      5b inserted the same key twice. Measured the same day: 158 doctor/list keys hold more than one live
--      customer row, 140 of them differing in grade or creation day, so the next one would have aborted the
--      run too.
--
-- RULE: a live customer beats a dropped one, active beats pending, the earliest start wins. That
--       also stops 5c closing a doctor who still has a live row (28 keys hold both a dropped and a
--       live row, which this pass used to open and close again on every run).
--
-- NOT HERE: the add path that lets a rep add a doctor he already has. That is a separate defect; this
--       function must hold whatever the table contains.
--
-- RECREATED FROM THE LIVE BODY: md5(prosrc) = 6526947fa48b1c51fb9b5f25c1334892 before this file, read on production
--       ozucdzovmcqvepbozvqf. SECURITY INVOKER, search_path and the advisory lock are untouched.
-- ROLLBACK: re-apply supabase/migrations/20261007200000_started_reps_doctor_list_is_phoenix_own.sql's
--       crm_contact_master_refresh definition.
--
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — crm_refresh_started_reps,
--       crm_contact_master_activity, crm_refresh_phoenix_lists_all and crm_refresh_phoenix_lists,
--       all inside the body of public.crm_contact_master_refresh, which creates and drops them
--       within its own call. They are SESSION-LOCAL scratch tables; no persistent table is dropped
--       or truncated anywhere here. (`scripts/check-migrations.mjs` matches the statement, not the
--       schema, so it cannot tell pg_temp from public. 🔴 THE ANNOTATION IS IN THIS HEADER AND NOT
--       BESIDE THE STATEMENTS DELIBERATELY: the md5(prosrc) above is this body read off production,
--       and a comment inside the body would change prosrc and break that correspondence.)
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
begin
  perform pg_advisory_xact_lock(hashtext('public.crm_contact_master_refresh'));

  drop table if exists pg_temp.crm_refresh_started_reps;
  create temporary table crm_refresh_started_reps on commit drop as
  select distinct s.hr_key, s.agent_crm_id
    from public.phoenix_crm_started_team_reps() s
   where v_today >= s.counted_from
     and (s.counted_until is null or v_today < s.counted_until);
  get diagnostics v_started_reps = row_count;

  select count(*) into v_assignments_frozen
    from public.crm_contact_assignments a
   where a.effective_to is null
     and exists (
       select 1
         from pg_temp.crm_refresh_started_reps s
        where (nullif(btrim(a.agent_hr_id), '') is not null and s.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and s.agent_crm_id = a.agent_crm_id)
     );

  if v_lists_live then
  insert into public.crm_contacts as c (
    contact_crm_id, name, name_ar, speciality, phone, address, city, zone, crm_region_name,
    source, first_seen_on
  )
  select distinct on (m.contact_crm_id)
         m.contact_crm_id,
         nullif(btrim(m.contact_name), ''),
         nullif(btrim(m.contact_name_ar), ''),
         nullif(btrim(m.speciality), ''),
         nullif(btrim(m.phone), ''),
         nullif(btrim(m.address), ''),
         nullif(btrim(m.city), ''),
         nullif(btrim(m.zone), ''),
         nullif(btrim(m.crm_region_name), ''),
         'list',
         least((m.first_seen_at at time zone 'Africa/Cairo')::date, v_today)
    from public.ireports360_contacts m
   where m.contact_crm_id > 0
     and m.contact_crm_id <> 100000
   order by m.contact_crm_id, m.synced_at desc nulls last, m.list_type, m.agent_crm_id
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

  -- ── A STARTED REP'S OWN DOCTORS GET THEIR NAME ROW ────────────────────────────────────────────────
  -- A doctor born in Phoenix CRM answers to `own_contact_crm_id` (20261007193000) and has no row in
  -- `crm_contacts`, so every per-doctor report would print a bare id. The activity pass below finds him
  -- once he has a visit or a plan; this one finds him the moment he is on a list, which is sooner, and
  -- it is what lets the fifth assignment pass reference him at all — `crm_contact_assignments` has a
  -- foreign key to this table.
  insert into public.crm_contacts as c (
    contact_crm_id, name, speciality, phone, source, first_seen_on
  )
  select distinct on (coalesce(p.reference_contact_crm_id, p.own_contact_crm_id))
         coalesce(p.reference_contact_crm_id, p.own_contact_crm_id),
         nullif(btrim(p.name), ''),
         nullif(btrim(p.speciality), ''),
         nullif(btrim(p.phone), ''),
         'phoenix',
         least((p.created_at at time zone 'Africa/Cairo')::date, v_today)
    from public.phoenix_crm_customers p
   where not p.is_test
     and p.status in ('active', 'pending', 'dropped')
   order by coalesce(p.reference_contact_crm_id, p.own_contact_crm_id), p.updated_at desc nulls last
  on conflict (contact_crm_id) do update set
         -- A name the vendor already carries is left alone: the vendor row is the one every historical
         -- report was keyed on, and renaming it would restate months already read. Only a blank is filled.
         name = coalesce(c.name, excluded.name),
         speciality = coalesce(c.speciality, excluded.speciality),
         phone = coalesce(c.phone, excluded.phone),
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.speciality, c.phone) is distinct from
         (coalesce(c.name, excluded.name), coalesce(c.speciality, excluded.speciality), coalesce(c.phone, excluded.phone))
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

  update public.crm_contacts c
     set crm_region_id = r.crm_region_id,
         updated_at = now()
    from (
      select distinct on (lower(btrim(m.crm_region_name))) lower(btrim(m.crm_region_name)) as region_name, m.crm_region_id
        from public.ireports360_visits m
       where m.crm_region_id is not null
         and nullif(btrim(m.crm_region_name), '') is not null
       order by lower(btrim(m.crm_region_name)), m.visit_date desc nulls last
    ) r
   where c.crm_region_id is null
     and lower(btrim(c.crm_region_name)) = r.region_name;
  get diagnostics v_regions_from_name = row_count;
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
     and not exists (
       select 1
         from pg_temp.crm_refresh_started_reps s
        where (nullif(btrim(a.agent_hr_id), '') is not null and s.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and s.agent_crm_id = a.agent_crm_id)
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
     and not exists (
       select 1
         from pg_temp.crm_refresh_started_reps s
        where (nullif(btrim(a.agent_hr_id), '') is not null and s.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and s.agent_crm_id = a.agent_crm_id)
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
     and not exists (
       select 1
         from pg_temp.crm_refresh_started_reps f
        where (nullif(btrim(a.agent_hr_id), '') is not null and f.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and f.agent_crm_id = a.agent_crm_id)
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
         and not exists (
           select 1
             from pg_temp.crm_refresh_started_reps f
            where (nullif(btrim(m.agent_hr_id), '') is not null and f.hr_key = lower(btrim(m.agent_hr_id)))
               or (nullif(btrim(m.agent_hr_id), '') is null and m.agent_crm_id is not null
                   and f.agent_crm_id = m.agent_crm_id)
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
      from public.phoenix_crm_started_team_reps() s
     where v_today >= s.counted_from
       and (s.counted_until is null or v_today < s.counted_until)
  ) r
  join public.phoenix_crm_customers c
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
  'Rebuilds crm_contact_assignments from the iReports360 scrape and from Phoenix CRM. FIVE assignment passes: '
  'four from the scrape, each skipping a rep whose own team has started in Phoenix CRM, and a fifth that '
  'gives that rep his PHOENIX CRM list as a new dated period (owner, 2026-10-07). The fifth pass holds ONE '
  'row per (rep, doctor, list): a doctor can sit on a seat as two customer rows, and the unique key under '
  'the table is the doctor, so a live row beats a dropped one, active beats pending, and the earliest '
  'start wins (2026-10-12; before it two rows aborted every run for 26 hours). A rep with no Phoenix list '
  'KEEPS his vendor list. It owns only source = ''phoenix_crm'' rows and never touches source = ''phoenix''. '
  'See supabase/migrations/20261012184500_contact_refresh_survives_a_doctor_added_twice.sql.';
