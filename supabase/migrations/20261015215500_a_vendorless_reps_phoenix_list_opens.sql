-- =============================================================================
-- A REP WITH NO IREPORTS360 ACCOUNT AT ALL GETS HIS PHOENIX LIST NOW
-- =============================================================================
-- WHAT: one new door for the DOCTOR LIST — `public.phoenix_crm_doctor_list_reps()` — and the two
--       database readers of the list rule ask it instead of `phoenix_crm_started_team_reps()`:
--       `crm_contact_master_refresh` (its fifth assignment pass, and the freeze set that keeps the
--       vendor passes off those rows) and `crm_contact_list_change_apply` (`v_phoenix_owns` and the
--       seat a decision is mirrored onto). The door is every rep on a started team, UNION every rep
--       `public.phoenix_crm_list_only_reps()` names: he holds a real Phoenix CRM list, he has NO
--       iReports360 account at all (no numeric `employees.crm_id`, no `crm_username`), he holds NO
--       open `source = 'ireports360'` assignment row, and his own team has NOT started. His Phoenix
--       periods open from the day his list was built or the day he took the seat, whichever is
--       later — never earlier than either.
--
-- WHY: Shahd Mohamed Elsayed Ghoneim (`PD-0026`, seat SEAT-PED-REP-AB4, Pedia Behira 1) had an
--      EMPTY doctor droplist. Read on production ozucdzovmcqvepbozvqf, 2026-10-15:
--        crm_contact_assignments   0 rows, ever, for PD-0026
--        phoenix_crm_customers     112 real rows on her seat, built 11 Oct 2026, all `pending`
--        employees                 crm_id NULL, crm_username NULL — no vendor identity
--        phoenix_crm_team_starts    no row for SEAT-PED-DM-AB — her team has not started
--      Both sources therefore write her nothing: the four vendor passes can only key on an
--      iReports360 account she does not have, and the fifth pass only covers a started team. Her
--      two peers on the same unstarted team (`B-177`, `PD-0005`) each see a list because each has a
--      vendor account. Nine more October hires are in the same hole — AI-0026/27/28, CN-0010,
--      PD-0021/24/25/27 — holding 1,223 built list rows between them and nothing on any list screen:
--      Rep Doctor Lists, the Reps List doctor column, the rep KPI coverage and frequency
--      denominators, Employee 360's doctor list and the direct-order venue picker all read
--      `crm_contact_assignments`. Her seat's predecessor (Mahmoud Eltanany, resigned 10 Aug 2026)
--      holds no vendor assignment either, so there is no vendor list to inherit: the Phoenix list IS
--      Behira 1's doctor list.
--
-- OWNER, 2026-10-15: "Everyone in Pedia that logged yesterday and in, tried in, in, in, in
--      validation in Makram Abed, those were new hired and we were in training. So all those should
--      be opened for them, the Phoenix now." — asked as the choice between extending the hand-over
--      rule to a rep with no vendor list, starting his team, and a one-off write for Shahd alone.
--      The rule is the answer he picked, so every rep in that state is opened, on every line.
--
-- RULE: the hand-over is driven by the LIST. A rep with no Phoenix list keeps his vendor list
--       (20261007200000); a rep with no VENDOR list gets his Phoenix list. A rep who has both waits
--       for his team's start, exactly as before — that is what keeps the owner's Start click the one
--       thing that moves a team's counting source.
--
-- 🔴 NOT HERE: `public.phoenix_crm_started_team_reps()` is UNCHANGED, and so is every view built on
--       it. The visits door, the plans door, field-work compliance and its payroll-deduction
--       recommendation, the CRM no-activity / DSM no-record / holiday-bridge connectors, the
--       attendance day maps, the KPI boards and Early Birds all count exactly whom they counted
--       before this file. This moves the DOCTOR LIST and nothing else.
--
-- RECREATED FROM THE LIVE BODIES, both proved byte-identical to production before the edit:
--       crm_contact_master_refresh     md5(prosrc) = 7194a3929cef15051f541d5bab6ee875  (20261015132445)
--       crm_contact_list_change_apply  md5(prosrc) = b5a5a2ab9ec3a9ef14f6bff322c0f445  (20261007200000)
--       The ONLY change inside either body is the function name of the door they read — two call
--       sites each, no filter, no ordering and no written value altered. SECURITY INVOKER,
--       search_path and the advisory lock are untouched. AFTER this file:
--       crm_contact_master_refresh     md5(prosrc) = f099c54bdeed10ee8b8756968a972c73
--       crm_contact_list_change_apply  md5(prosrc) = 40d256cff9fb976d6ba1799f02bedade
--       Those two digests are what proves the apply landed — `create or replace` makes the mere
--       presence of either function worthless as evidence.
-- ROLLBACK: re-apply supabase/migrations/20261015132445_contact_refresh_reads_the_customer_table_once.sql
--       and supabase/migrations/20261007200000_started_reps_doctor_list_is_phoenix_own.sql, in that
--       order; then `drop function if exists public.phoenix_crm_doctor_list_reps(), public.phoenix_crm_list_only_reps();`.
--       Rolling back leaves the already-opened periods in place, closed by nothing — they are
--       `source = 'phoenix_crm'` rows the vendor passes never touch.
--
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — crm_refresh_started_reps,
--       crm_refresh_phoenix_customers, crm_contact_master_activity, crm_refresh_phoenix_lists_all and
--       crm_refresh_phoenix_lists, all inside the body of public.crm_contact_master_refresh, which
--       creates and drops them within its own call. They are SESSION-LOCAL scratch tables; no
--       persistent table is dropped or truncated anywhere here. (`scripts/check-migrations.mjs`
--       matches the statement, not the schema, so it cannot tell pg_temp from public. 🔴 THE
--       ANNOTATION IS IN THIS HEADER AND NOT BESIDE THE STATEMENTS DELIBERATELY: a comment inside the
--       body would change prosrc and break the md5 correspondence above.)
-- =============================================================================

-- ── THE REPS WHOSE LIST IS PHOENIX'S WITHOUT A TEAM START ───────────────────────────────────────
-- A rep who has no iReports360 account cannot be reached by any vendor pass, so nothing would ever
-- write his list. `counted_from` is the later of the day he took the seat and the day the list was
-- built, so a period can never predate either; `counted_until` is his occupancy's own end, which is
-- what closes the window when he leaves the seat.
create or replace function public.phoenix_crm_list_only_reps()
returns table (seat_id text, hr_id text, hr_key text, agent_crm_id bigint, counted_from date, counted_until date)
language sql
stable
security definer
set search_path to 'public'
rows 30
as $function$
  with lists as (
    select c.seat_id,
           min((c.created_at at time zone 'Africa/Cairo')::date) as list_built_on
      from public.phoenix_crm_customers c
     where not c.is_test
       and c.status in ('active', 'pending', 'dropped')
     group by c.seat_id
  )
  select o.seat_id,
         btrim(o.occupant_hr_id),
         lower(btrim(o.occupant_hr_id)),
         null::bigint,
         greatest(o.effective_from, l.list_built_on),
         o.effective_to
    from au.occupancy_history o
    join lists l on l.seat_id = o.seat_id
    join public.employees e on upper(btrim(e.hr_id)) = upper(btrim(o.occupant_hr_id))
   where nullif(btrim(o.occupant_hr_id), '') is not null
     -- No iReports360 account at all. A numeric `crm_id` or a `crm_username` is how every vendor
     -- pass finds a rep, so a rep carrying either is the vendor's and waits for his team's start.
     and (e.crm_id is null or e.crm_id !~ '^[0-9]+$')
     and nullif(btrim(e.crm_username), '') is null
     -- Belt beside the braces: a rep holding an open vendor row has a list already, whatever his
     -- identity columns say, and taking it to Phoenix without a team start is the one thing the
     -- team-start rule exists to prevent.
     and not exists (
       select 1
         from public.crm_contact_assignments a
        where a.effective_to is null
          and a.source = 'ireports360'
          and lower(btrim(a.agent_hr_id)) = lower(btrim(o.occupant_hr_id))
     )
     -- A started rep is already in the other half of the door, with his TEAM's start date. Returning
     -- him here too would offer the fifth pass a second, earlier window and backdate his periods to
     -- the day his list was built — CN-0009's list predates her team's start by five days.
     and not exists (
       select 1
         from public.phoenix_crm_started_team_reps() s
        where s.hr_key = lower(btrim(o.occupant_hr_id))
     )
     and (o.effective_to is null or o.effective_to > greatest(o.effective_from, l.list_built_on))
$function$;

revoke execute on function public.phoenix_crm_list_only_reps() from public, anon, authenticated;
grant execute on function public.phoenix_crm_list_only_reps() to service_role;

comment on function public.phoenix_crm_list_only_reps() is
  'Reps whose doctor list is Phoenix''s without a team start: a Phoenix CRM list, no iReports360 account, no open vendor row, team not started. Owner''s ruling 2026-10-15.';

-- ── THE DOOR THE DOCTOR LIST ASKS ───────────────────────────────────────────────────────────────
-- Deliberately NOT the visits/plans door. `phoenix_crm_started_team_reps()` keeps answering for
-- everything that counts work; this one answers only for whose list Phoenix owns.
create or replace function public.phoenix_crm_doctor_list_reps()
returns table (seat_id text, hr_id text, hr_key text, agent_crm_id bigint, counted_from date, counted_until date)
language sql
stable
security definer
set search_path to 'public'
rows 90
as $function$
  select s.seat_id, s.hr_id, s.hr_key, s.agent_crm_id, s.counted_from, s.counted_until
    from public.phoenix_crm_started_team_reps() s
  union all
  select l.seat_id, l.hr_id, l.hr_key, l.agent_crm_id, l.counted_from, l.counted_until
    from public.phoenix_crm_list_only_reps() l
$function$;

revoke execute on function public.phoenix_crm_doctor_list_reps() from public, anon, authenticated;
grant execute on function public.phoenix_crm_doctor_list_reps() to service_role;

comment on function public.phoenix_crm_doctor_list_reps() is
  'Whose DOCTOR LIST Phoenix owns today: every started team''s reps, plus every rep with a Phoenix list and no iReports360 account. The visits and plans doors are unchanged.';

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
    from public.phoenix_crm_doctor_list_reps() s
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

  -- ── ONE READ OF THE CUSTOMER TABLE, FOR BOTH PASSES ─────────────────────────────────
  -- The name-row pass below creates the `crm_contacts` row a Phoenix-born doctor needs, and the fifth
  -- pass writes his `crm_contact_assignments` row, which has a foreign key to it. They used to read
  -- `public.phoenix_crm_customers` in two separate statements, and this function runs at READ
  -- COMMITTED, where every statement takes a fresh snapshot: a doctor a rep added between the two
  -- statements was invisible to the name pass and visible to the fifth, so 5b referenced a contact
  -- that did not exist and the whole transaction rolled back. Both passes now read this one snapshot,
  -- so the fifth pass's set is a subset of the one the name pass covered, by construction.
  drop table if exists pg_temp.crm_refresh_phoenix_customers;
  create temporary table crm_refresh_phoenix_customers on commit drop as
  select c.seat_id,
         c.own_contact_crm_id,
         c.reference_contact_crm_id,
         c.list_type,
         c.grade,
         c.status,
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
    from pg_temp.crm_refresh_phoenix_customers p
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
      from public.phoenix_crm_doctor_list_reps() s
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
    from public.phoenix_crm_doctor_list_reps() s
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
  'scrape, each skipping a rep whose doctor list Phoenix owns, and a fifth that gives that rep his '
  'PHOENIX CRM list in the same table as a new dated period — the vendor period closed at '
  'counted_from - 1, the Phoenix period opened at counted_from, nothing deleted, so a month already '
  'computed still sees the list as it stood (owner, 2026-10-07). A rep with no Phoenix list KEEPS his '
  'vendor list, which is what stops a district manager''s or an unbuilt list going to zero; from '
  '2026-10-15 a rep with no VENDOR list gets his Phoenix list without waiting for his team — the door '
  'is public.phoenix_crm_doctor_list_reps(), never the visits door. It owns only '
  'source = ''phoenix_crm'' rows and never touches a source = ''phoenix'' row: that is one approved human '
  'decision. See supabase/migrations/20261015215500_a_vendorless_reps_phoenix_list_opens.sql.';

comment on function public.crm_contact_list_change_apply(uuid, text, text) is
  'Approves one doctor-list change. Refuses while the rep''s doctor list is still iReports360''s — his '
  'own team not started AND a vendor list of his own (20261004120000, 20261015215500). From 2026-10-07 a '
  'removal or a regrade is ALSO written into phoenix_crm_customers, because a derived rep''s assignment '
  'rows are rebuilt from that table hourly and a decision recorded only here would be undone by the '
  'next run. Its own row stays source = ''phoenix'', which the derived pass never closes or regrades.';
