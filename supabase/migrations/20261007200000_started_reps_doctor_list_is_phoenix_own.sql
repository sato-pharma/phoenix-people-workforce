-- started_reps_doctor_list_is_phoenix_own
--
-- WHAT THIS CHANGES (owner, 2026-10-07: "every single report that was pulling data from the CRM must
-- stop pulling data from the Go Live teams and pull from the Phoenix CRM … I want the same table the
-- same history as is … nothing show that a drop happened"):
--
--   A STARTED REP'S DOCTOR LIST BECOMES HIS PHOENIX CRM LIST, IN THE SAME TABLE, AS A NEW DATED PERIOD.
--   `crm_contact_master_refresh` gains a FIFTH assignment pass. The four it has all SKIP a started rep —
--   correct, and only half the job: his rows were left frozen as the VENDOR last wrote them, so every
--   screen kept showing a vendor list for a rep whose real list had moved. Esraa Ibrahim Saad is the
--   shape of it, measured on production: 0 doctors on every screen, against 163 in Phoenix CRM.
--
-- WHY A FIFTH PASS AND NOT A FOURTH DOOR. A `crm_contact_assignments_unified` view would mean repointing
--   ten readers — contact-lists, reps-list, reps-list-vacant-areas, rep-kpi-reports-data,
--   phoenix-kpi-data, brick-coverage, shared-customers, venue-contact-options, the Business Review's
--   field link, and the write path — and killing three PostgREST contact embeds, which cannot resolve
--   against a UNION ALL. Writing the rows instead leaves every one of those readers correct with NO code
--   change, keeps the foreign key and the embeds, and gives the owner what he actually asked for: THE
--   SAME TABLE AND THE SAME HISTORY, with the new list populating underneath the old one.
--
-- HOW NOTHING READS AS A DROP. An assignment row is a PERIOD, so a vendor period is CLOSED at
--   `counted_from - 1` and the Phoenix period OPENS at `counted_from`: no gap, no overlap, and no row is
--   ever deleted. A month already computed still sees the list AS IT STOOD — these periods are read by
--   date, so the figures for the days before a team started do not move.
--
-- 🔴 THE GUARD THAT MATTERS: A REP WITH NO PHOENIX LIST KEEPS HIS VENDOR LIST. The vendor close only ever
--   runs for a rep who HAS one. Measured on production 2026-10-07, this is what it protects:
--     · Nermeen Salah Abohussien — vendor 25, Phoenix 0  → keeps her 25
--     · Mahmoud ElHassanin        — vendor  1, Phoenix 0  → keeps his 1
--     · Dina Hamdy Fadel Bdair    — vendor  0, Phoenix 0  → unchanged (a district manager holds no list)
--   Three of the eighteen "started reps" are district managers, so keying this on the started set alone
--   would have taken a real list to zero — the exact defect it is here to fix, in reverse.
--
-- WHAT THE DENOMINATORS DO, rep by rep (vendor open → Phoenix list, production 2026-10-07): 98→98,
--   169→169, 91→91, 150→150, 161→162, 160→164, 133→138, 97→98, 164→168, 177→178, 162→162, 157→172,
--   150→165, 103→93 (14 dropped by his own manager), 0→163 (Esraa). Thirteen of fifteen move by a
--   handful or not at all: the coverage and frequency denominators do not jump, they become RIGHT.
--
-- WHAT IS ON THE LIST: `status in ('active','pending')`. A pending customer IS on the rep's list — he
--   works him — he simply scores nothing until the customer is validated, which `customer_validated`
--   already carries on the visit. `dropped` leaves the list at the drop day, and `outside` never joins
--   it: an out-of-list visit is not an assignment.
--
-- 🔴 THE TWO WRITERS ARE RECONCILED HERE, NOT LEFT TO COLLIDE. `crm_contact_list_change_apply` (the old
--   portal's approve flow, which 20261004120000 deliberately OPENED for a started rep) writes
--   `crm_contact_assignments` directly and never touched `phoenix_crm_customers`. With the list now
--   derived, a manager's approved removal would have been undone within the hour: the customer still
--   read 'active', so the fifth pass would re-open the doctor on the next run — the same "re-open a
--   removed doctor the next morning" the four vendor guards exist to stop. So the apply function now ALSO
--   writes the decision into Phoenix CRM — `status = 'dropped'` for a removal, the new `grade` for a
--   regrade — and its own row stays `source = 'phoenix'`, which this pass never touches. An ADD keeps its
--   `'phoenix'` row and no customer row: nothing to mirror, and the fifth pass cannot re-open what
--   `phoenix_crm_customers` does not hold. Measured first: production holds 0 list changes, ever, and
--   every assignment row is `source = 'ireports360'` — so nothing existing is reinterpreted by this.
--
-- ROLLBACK:
--   Re-run 20261006185533's apply body and 20261004120000's refresh body (four passes, no fifth), then
--     update public.crm_contact_assignments set effective_to = null, updated_at = now()
--      where source = 'ireports360' and effective_to = date '2026-10-02';   -- Delta (1), counted_from - 1
--     delete from public.crm_contact_assignments where source = 'phoenix_crm';
--   Nothing is lost either way: the vendor rows were closed, never deleted. The two CHECK constraints can
--   stay — a value nothing writes costs nothing.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- 🔴 THIS WRITES LIST ROWS ON A LIVE TABLE: it closes the started reps' vendor periods and opens their
-- Phoenix periods. No row is deleted and no existing period's `effective_from` moves.
--
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — crm_refresh_started_reps,
-- crm_contact_master_activity and crm_refresh_phoenix_lists, all inside the body of
-- public.crm_contact_master_refresh, which creates and drops them within its own call. They are
-- SESSION-LOCAL scratch tables; nothing persistent is dropped or truncated, which is the same thing
-- the line above says about the rows. (`scripts/check-migrations.mjs` matches the statement, not the
-- schema, so it cannot tell pg_temp from public; this annotation is placed in the header rather than
-- beside each statement so the function's stored source stays byte-for-byte what production holds.)

begin;
set local lock_timeout = '5s';

-- ── THE THIRD SOURCE VALUE ────────────────────────────────────────────────────────────────────────
-- `'ireports360'` is the vendor scrape and `'phoenix'` is one approved human decision. A derived row is
-- neither: it is rebuilt from phoenix_crm_customers every hour, and the fifth pass must be able to find
-- exactly its own rows so it can never close or regrade a decision somebody made by hand.
--
-- The identity CHECK ends in `else false`, so adding a value WITHOUT extending it would reject every
-- insert the new pass makes — and the hourly refresh would start failing in silence. Both move together.
alter table public.crm_contact_assignments drop constraint if exists crm_contact_assignments_source;
alter table public.crm_contact_assignments
  add constraint crm_contact_assignments_source
  check (source = any (array['ireports360'::text, 'phoenix'::text, 'phoenix_crm'::text]));

alter table public.crm_contact_assignments drop constraint if exists crm_contact_assignments_source_identity;
alter table public.crm_contact_assignments
  add constraint crm_contact_assignments_source_identity
  check (
    case source
      when 'ireports360' then agent_crm_id is not null
      -- A Phoenix row is keyed on the HR id: a started rep may have no CRM account at all, and a
      -- synthetic agent_crm_id would print as a raw code beside a real name.
      when 'phoenix' then agent_hr_id is not null and btrim(agent_hr_id) <> ''
      when 'phoenix_crm' then agent_hr_id is not null and btrim(agent_hr_id) <> ''
      else false
    end
  );

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
  drop table if exists pg_temp.crm_refresh_phoenix_lists;
  create temporary table crm_refresh_phoenix_lists on commit drop as
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

create or replace function public.crm_contact_list_change_apply(
  p_change_id uuid,
  p_decided_by text,
  p_note text default null::text
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_cutover date := (select c.cutover_date from public.crm_cutover c where c.id);
  v_change public.crm_contact_list_changes%rowtype;
  v_rep_crm_id bigint;
  v_contact bigint;
  v_agent_crm_id bigint;
  v_removed integer := 0;
  v_closed integer := 0;
  v_current_grade text;
  v_phoenix_owns boolean;
  -- The rep's Phoenix CRM seat, when his own team has started. Null means the global cutover date is
  -- what opened his list, so there is no Phoenix seat to mirror the decision onto.
  v_seat_id text;
  v_customer_mirrored integer := 0;
begin
  select * into v_change from public.crm_contact_list_changes where id = p_change_id for update;
  if not found then
    raise exception 'That change was not found.' using errcode = 'P0001';
  end if;
  if v_change.status <> 'pending' then
    raise exception 'This change has already been decided or withdrawn.' using errcode = 'P0001';
  end if;

  select case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end
    into v_rep_crm_id
    from public.employees e
   where e.hr_id = v_change.rep_hr_id;

  -- THE SWITCH. This rep's list is Phoenix's either because his own team has started (the live rule) or
  -- because the global cutover date has passed (kept so a future global cutover still works). Before
  -- 2026-10-04 only the second existed, and with the date NULL it refused every change ever requested.
  v_phoenix_owns := exists (
    select 1
      from public.phoenix_crm_started_team_reps() s
     where v_today >= s.counted_from
       and (s.counted_until is null or v_today < s.counted_until)
       and (s.hr_key = lower(btrim(v_change.rep_hr_id))
            or (v_rep_crm_id is not null and s.agent_crm_id = v_rep_crm_id))
  ) or (v_cutover is not null and v_today >= v_cutover);

  if not v_phoenix_owns then
    raise exception 'Doctor lists for this rep still come from iReports360 — their team has not started in Phoenix CRM yet.'
      using errcode = 'P0001';
  end if;

  -- WHICH SEAT THE DECISION LANDS ON. From 2026-10-07 a started rep's list rows are DERIVED from
  -- phoenix_crm_customers by crm_contact_master_refresh's fifth assignment pass, so a removal or a
  -- regrade that only closed a row here would be undone by the next hourly run: the customer would
  -- still read 'active' and the pass would re-open him. The decision therefore reaches Phoenix CRM
  -- itself, below, and the row written here is only what makes the screen answer at once.
  select s.seat_id into v_seat_id
    from public.phoenix_crm_started_team_reps() s
   where v_today >= s.counted_from
     and (s.counted_until is null or v_today < s.counted_until)
     and (s.hr_key = lower(btrim(v_change.rep_hr_id))
          or (v_rep_crm_id is not null and s.agent_crm_id = v_rep_crm_id))
   limit 1;

  if p_decided_by is distinct from (case when v_change.direct then v_change.requested_by else v_change.manager_hr_id end) then
    raise exception 'Only the manager this change was sent to can approve it.' using errcode = 'P0001';
  end if;

  v_contact := v_change.contact_crm_id;

  if v_change.action = 'add' then
    if v_contact is null then
      v_contact := nextval('public.crm_contacts_phoenix_id_seq');
      insert into public.crm_contacts (contact_crm_id, name, speciality, address, source, first_seen_on)
      values (v_contact, btrim(v_change.new_contact_name), btrim(v_change.new_contact_speciality),
              nullif(btrim(v_change.new_contact_address), ''), 'phoenix', v_today);
    elsif exists (
      select 1
        from public.crm_contact_assignments a
       where a.effective_to is null
         and a.contact_crm_id = v_contact
         and a.list_type = v_change.list_type
         and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
              or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id))
    ) then
      raise exception 'That doctor is already on this list.' using errcode = 'P0001';
    end if;

    v_agent_crm_id := case
      when v_rep_crm_id is not null and not exists (
        select 1
          from public.crm_contact_assignments o
         where o.effective_to is null
           and o.contact_crm_id = v_contact
           and o.agent_crm_id = v_rep_crm_id
           and o.list_type = v_change.list_type
      ) then v_rep_crm_id
    end;

    insert into public.crm_contact_assignments (
      contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
    ) values (
      v_contact, v_agent_crm_id, v_change.rep_hr_id, v_change.list_type, v_change.grade, v_today, v_today, 'phoenix'
    );
  else
    select a.grade, a.agent_crm_id
      into v_current_grade, v_agent_crm_id
      from public.crm_contact_assignments a
     where a.effective_to is null
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id))
     order by a.id
     limit 1
     for update;
    if not found then
      raise exception 'That doctor is not on this list any more.' using errcode = 'P0001';
    end if;
    if v_change.action = 'regrade' and v_current_grade is not distinct from v_change.grade then
      raise exception 'That doctor already has this grade.' using errcode = 'P0001';
    end if;

    delete from public.crm_contact_assignments a
     where a.effective_to is null
       and a.effective_from >= v_today
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id));
    get diagnostics v_removed = row_count;

    update public.crm_contact_assignments a
       set effective_to = v_today - 1,
           updated_at = now()
     where a.effective_to is null
       and a.effective_from < v_today
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id));
    get diagnostics v_closed = row_count;

    if v_change.action = 'regrade' then
      insert into public.crm_contact_assignments (
        contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
      ) values (
        v_contact, coalesce(v_agent_crm_id, v_rep_crm_id), v_change.rep_hr_id, v_change.list_type, v_change.grade,
        v_today, v_today, 'phoenix'
      );
      -- THE SAME DECISION, IN PHOENIX CRM. Without this the hourly rebuild reads the old grade from
      -- phoenix_crm_customers and the manager's regrade lasts under an hour.
      if v_seat_id is not null then
        update public.phoenix_crm_customers c
           set grade = v_change.grade,
               updated_at = now()
         where c.seat_id = v_seat_id
           and c.list_type = v_change.list_type
           and not c.is_test
           and c.status <> 'dropped'
           and coalesce(c.reference_contact_crm_id, c.own_contact_crm_id) = v_contact;
        get diagnostics v_customer_mirrored = row_count;
      end if;
    elsif v_seat_id is not null then
      -- A REMOVAL REACHES PHOENIX CRM TOO, for the same reason. `status_changed_at` is what the fifth
      -- pass dates the closed period from, so the day the manager decided is the day the doctor leaves
      -- the list — every month before it keeps him.
      update public.phoenix_crm_customers c
         set status = 'dropped',
             dropped_reason = coalesce(c.dropped_reason, 'other'),
             dropped_note = coalesce(c.dropped_note, 'Removed by an approved doctor-list change.'),
             status_changed_at = now(),
             updated_at = now()
       where c.seat_id = v_seat_id
         and c.list_type = v_change.list_type
         and not c.is_test
         and c.status <> 'dropped'
         and coalesce(c.reference_contact_crm_id, c.own_contact_crm_id) = v_contact;
      get diagnostics v_customer_mirrored = row_count;
    end if;
    -- NOT FOUND IS A VALID ANSWER, not a failure: a doctor added through this screen has an assignment
    -- row and no Phoenix customer row, so there is nothing to mirror — and the fifth pass will not
    -- re-open him either, because it only ever opens what phoenix_crm_customers holds.
  end if;

  update public.crm_contact_list_changes
     set status = 'approved',
         decided_by = p_decided_by,
         decided_at = now(),
         decision_note = nullif(btrim(p_note), ''),
         applied_at = now(),
         applied_contact_crm_id = v_contact,
         updated_at = now()
   where id = p_change_id;

  insert into public.crm_contact_list_change_events (change_id, event, actor_hr_id, detail)
  values (
    p_change_id,
    case when v_change.direct then 'applied_directly' else 'approved' end,
    p_decided_by,
    jsonb_build_object('contactCrmId', v_contact, 'discarded', v_removed, 'closed', v_closed,
                       'customerMirrored', v_customer_mirrored)
  );

  return jsonb_build_object('contactCrmId', v_contact, 'action', v_change.action, 'discarded', v_removed,
                            'closed', v_closed, 'customerMirrored', v_customer_mirrored);
end;
$function$;

comment on function public.crm_contact_master_refresh(boolean) is
  'Rebuilds crm_contacts and crm_contact_assignments. FIVE assignment passes: four from the iReports360 '
  'scrape, each skipping a rep whose own team has started in Phoenix CRM, and a fifth that gives that '
  'rep his PHOENIX CRM list in the same table as a new dated period — the vendor period closed at '
  'counted_from - 1, the Phoenix period opened at counted_from, nothing deleted, so a month already '
  'computed still sees the list as it stood (owner, 2026-10-07). A rep with no Phoenix list KEEPS his '
  'vendor list, which is what stops a district manager''s or an unbuilt list going to zero. It owns only '
  'source = ''phoenix_crm'' rows and never touches a source = ''phoenix'' row: that is one approved human '
  'decision. See supabase/migrations/20261007200000_started_reps_doctor_list_is_phoenix_own.sql.';

comment on function public.crm_contact_list_change_apply(uuid, text, text) is
  'Approves one doctor-list change. Refuses while the rep''s own team is still counted from iReports360 '
  '(20261004120000). From 2026-10-07 a removal or a regrade is ALSO written into phoenix_crm_customers, '
  'because a started rep''s assignment rows are derived from that table hourly and a decision recorded '
  'only here would be undone by the next run. Its own row stays source = ''phoenix'', which the derived '
  'pass never closes or regrades.';

notify pgrst, 'reload schema';

commit;
