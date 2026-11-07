-- crm_doors_count_every_seat_from_vendor_retirement
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_counted_seat_windows() — NEW. Which territory (REP seat) counts from Phoenix CRM on which
--      day: a started team's territory from its start, cut off at the day iReports360 was retired, and EVERY
--      territory from that day on, with no end. The windows never overlap, so a visit is served once.
--   2. phoenix_crm_counted_day_activity_windows() — NEW. The same for a recorded day activity: a territory or
--      the team's own seat, from the earlier of its start and its day_activities_from (the rule of
--      20261029195520, unchanged), cut off at the retirement day; and every territory and district-manager
--      seat from that day on.
--   3. crm_visits_unified — the iReports360 branch ends the day BEFORE the retirement day; the Phoenix visit
--      branch reads (1) and the day-activity branch reads (2) instead of the started-team join. Every select
--      item is the 20261029195520 body, line for line.
--   4. crm_checkins_unified — the same two changes on the 20261028024500 body.
--
-- WHY (owner, 6 Nov 2026): "ANY SINGLE SOURCE OF FIELD WORK IS NOW THE PHOENIX CRM ... WIRE IT EVERY WHERE",
--   and on the start question, "Count all teams from 6 Nov". iReports360 was retired at 03:16 Cairo on
--   6 Nov (crm_cutover.vendor_sync_retired_at) and its sync code deleted (PR #49), but the two doors still
--   (a) left room for an iReports360 row dated after that day and (b) served a Phoenix row only for a seat
--   under a team the Super Admin had started and not stopped — a Stop, or a seat added later, would have
--   left that person with no field work at all now that the vendor sends nothing.
--
-- WHAT DOES NOT MOVE TODAY (read live on production before writing this):
--   * the last iReports360 visit and check-in are dated 5 Nov, so the vendor bound drops no row;
--   * every REP seat sits under one of the 21 started teams and none is stopped, so (1) serves exactly the
--     rows the started-team join served before; 0 Phoenix visits sit on a seat outside a started team;
--   * the before-the-start iReports360 archive, "Phoenix wins the day" and its cache are untouched;
--   * crm_plan_entries_unified is NOT changed: its vendor rows stopped with the sync, and the plan door's
--     Phoenix arm reads plan items, not seats.
--
-- ROLLBACK: re-run the crm_visits_unified statement of 20261029195520 and the crm_checkins_unified
--   statement of 20261028024500 (same columns, so create or replace takes them back), then
--   drop function public.phoenix_crm_counted_seat_windows(); drop function public.phoenix_crm_counted_day_activity_windows();
--   Nothing here writes or deletes a row.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phoenix_crm_counted_seat_windows()
 returns table(seat_id text, starts_on date, stops_on date)
 language sql
 stable security definer rows 200
 set search_path to 'public'
as $function$
  -- ONE ROW, ALWAYS: a scalar subquery answers null when crm_cutover has no row, so the cross joins below
  -- can never come back empty and silently drop every window.
  with retired as (
    select (select (c.vendor_sync_retired_at at time zone 'Africa/Cairo')::date from public.crm_cutover c where c.id) as on_day
  )
  -- A started team's territory, for the days of its start that fall before the retirement day.
  -- least() skips a null, so an open start ends at the retirement day and an unset retirement keeps the stop.
  select t.seat_id, t.starts_on, least(t.stops_on, r.on_day)
    from public.phoenix_crm_started_team_seats() t
    cross join retired r
   where t.starts_on < coalesce(r.on_day, 'infinity'::date)
  union all
  -- EVERY territory from the retirement day, open-ended: a Stop or a seat added later no longer hides it.
  select s.seat_id, r.on_day, null::date
    from au.seats s
    cross join retired r
   where r.on_day is not null
     and s.seat_tier = 'REP'
$function$;

revoke execute on function public.phoenix_crm_counted_seat_windows() from public, anon, authenticated;
grant execute on function public.phoenix_crm_counted_seat_windows() to postgres, service_role;

create or replace function public.phoenix_crm_counted_day_activity_windows()
 returns table(seat_id text, counted_from date, stops_on date)
 language sql
 stable security definer rows 240
 set search_path to 'public'
as $function$
  with retired as (
    select (select (c.vendor_sync_retired_at at time zone 'Africa/Cairo')::date from public.crm_cutover c where c.id) as on_day
  ),
  started as (
    select t.seat_id, t.team_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_started_team_seats() t
    union
    -- The manager's OWN seat ("Yes, the whole team"): a district manager has no territory of his own, so
    -- a day he recorded sits on his team seat. phoenix_crm_started_team_reps counts that seat the same way.
    select s.team_seat_id, s.team_seat_id, s.starts_on, s.stops_on from public.phoenix_crm_team_starts s
  ),
  counted as (
    select w.seat_id,
           -- From the team's start, or from its day_activities_from when that is EARLIER (never later),
           -- read from the SAME start run the seat came from (owner, 2026-10-10).
           least(w.starts_on, coalesce(run.day_activities_from, w.starts_on)) as counted_from,
           w.stops_on
      from started w
      left join public.phoenix_crm_team_starts run
        on run.team_seat_id = w.team_seat_id
       and run.starts_on = w.starts_on
       and run.stops_on is not distinct from w.stops_on
  )
  select k.seat_id, k.counted_from, least(k.stops_on, r.on_day)
    from counted k
    cross join retired r
   where k.counted_from < coalesce(r.on_day, 'infinity'::date)
  union all
  -- EVERY territory and every district-manager seat from the retirement day, open-ended.
  select s.seat_id, r.on_day, null::date
    from au.seats s
    cross join retired r
   where r.on_day is not null
     and s.seat_tier in ('REP', 'DM', 'ACTING_DM')
$function$;

revoke execute on function public.phoenix_crm_counted_day_activity_windows() from public, anon, authenticated;
grant execute on function public.phoenix_crm_counted_day_activity_windows() to postgres, service_role;

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
     -- 🔴 THE ARCHIVE ENDS THE DAY BEFORE iREPORTS360 WAS RETIRED (owner, 6 Nov 2026: "ANY SINGLE SOURCE OF
     -- FIELD WORK IS NOW THE PHOENIX CRM"). Read live from crm_cutover.vendor_sync_retired_at, on its Cairo
     -- day; while it is unset the bound is open, exactly as before.
     and x.visit_date < coalesce((select (c.vendor_sync_retired_at at time zone 'Africa/Cairo')::date from public.crm_cutover c where c.id), 'infinity'::date)
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
-- WHICH SEAT COUNTS ON WHICH DAY (owner, 6 Nov 2026): a started team's territory from its start, and EVERY
-- territory from the day iReports360 was retired, whatever its start or stop. The windows never overlap, so
-- a visit is served once. phoenix_crm_counted_seat_windows() is that rule, once, for both Phoenix doors.
join public.phoenix_crm_counted_seat_windows() team
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
  -- A sales day reads as iReports360 carried one: code -7, its comment beginning "Sales day". Interviews is
  -- served as Admin Work (-20), the kind it sits beside, its comment beginning "Interviews" (owner, 2026-10-29).
  case a.activity_type
    when 'sales_day' then btrim('Sales day ' || coalesce(a.note, ''))
    when 'interviews' then btrim('Interviews ' || coalesce(a.note, ''))
    else a.note
  end,
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
    when 'interviews' then -20
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
    when 'interviews' then 'Admin Work'
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
-- A territory, or the team's own seat where a district manager's day sits ("Yes, the whole team"), from the
-- earlier of its start and its day_activities_from — and every one of them from the day iReports360 was
-- retired. phoenix_crm_counted_day_activity_windows() holds that rule, once.
join public.phoenix_crm_counted_day_activity_windows() team
  on team.seat_id = a.seat_id
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(a.rep_hr_id))
-- A RECORDED day activity (never a planned one), real, of a kind this branch names: a kind the module
-- adds later is left out until it is given its worked-day code here.
where not a.is_test
  -- Counted from the team's start, or from its day_activities_from when that is EARLIER (never later).
  and a.activity_date >= team.counted_from
  and (team.stops_on is null or a.activity_date < team.stops_on)
  and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd', 'interviews');

revoke all on table public.crm_visits_unified from anon, authenticated;

create or replace view public.crm_checkins_unified
  with (security_invoker = true)
as
select
  c.id,
  c.crm_checkin_id,
  c.agent_crm_id,
  c.agent_hr_id,
  c.contact_crm_id,
  coalesce(truth.name, c.contact_name) as contact_name,
  c.lat,
  c.lon,
  c.address,
  c.check_date,
  c.raw_payload,
  c.synced_at,
  c.created_at,
  c.updated_at,
  'ireports360'::text as source,
  c.agent_crm_id as exclusion_crm_id
from (
  -- 🔴 ONE SCAN OF THE VENDOR TABLE, NOT TWO, AND THE ENTRY DAY IS AN INDEX LOOKUP (speed, 2026-10-28) —
  -- the visit door's shape since 20261024005000, on the check-in's wall-clock day. The split below was two
  -- UNION ALL runs over the same table, so the rep list's 50-doctor read walked the (contact_crm_id,
  -- check_date) index twice; and the two checks asked a MATERIALIZED CTE over
  -- phoenix_crm_rep_entry_days(), which a function scan left the planner no way to index. The two arms
  -- stay mutually exclusive on the SAME live bound, so no row is produced twice or lost.
  select x.*
    from public.ireports360_checkins x
   where x.check_date < coalesce(
     (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
     'infinity'::timestamptz
   )
     -- 🔴 THE ARCHIVE ENDS THE DAY BEFORE iREPORTS360 WAS RETIRED — the visit door's bound, on the
     -- check-in's wall clock as stored (Cairo, labelled UTC — the vendor convention).
     and x.check_date < coalesce(
       (select (k.vendor_sync_retired_at at time zone 'Africa/Cairo')::date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
       'infinity'::timestamptz
     )
     and (
       -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): the visit door's split, on the check-in's wall-clock
       -- day. A vendor check-in's day is its wall clock as stored (Cairo, labelled UTC — the vendor
       -- convention), so a check-in before that day's midnight "UTC" is on a day before it, where no rep
       -- has an entry day and nothing is asked.
       x.check_date < (
         select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC'
           from public.phoenix_crm_team_starts t
       )
       -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP: the same rule as the visit
       -- door, on the same entry days.
       or (
         -- 🔴 READ FROM THE CACHE TABLE, NOT THROUGH phoenix_crm_rep_entry_days(). The function is that
         -- table and nothing else, and phoenix_crm_rep_entry_days_calc() is still the ONLY body that
         -- COMPUTES an entry day — this reads what that body wrote. The door is security_invoker and is
         -- granted to postgres and service_role alone; the cache carries exactly those two grants and
         -- both roles are BYPASSRLS, so reading it directly reaches the same rows for the same readers
         -- the SECURITY DEFINER function did.
         not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where e.hr_key = lower(btrim(x.agent_hr_id))
              and e.entry_day = (x.check_date at time zone 'UTC')::date
         )
         -- A check-in the sync could not give an hr id is still his, by his CRM id.
         and not exists (
           select 1
             from public.phoenix_crm_rep_entry_days_cache e
            where nullif(btrim(x.agent_hr_id), '') is null
              and e.agent_crm_id = x.agent_crm_id
              and e.entry_day = (x.check_date at time zone 'UTC')::date
         )
       )
     )
) c
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = c.contact_crm_id
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  -- The same expression as the visit door and the plan door, to the character.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
  customer.name,
  p.lat,
  p.lon,
  null::text,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  p.created_at,
  p.created_at,
  p.created_at,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint)
from public.phoenix_crm_countable_visits p
-- The visit door's own windows: a started team's territory from its start, every territory from the day
-- iReports360 was retired.
join public.phoenix_crm_counted_seat_windows() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing (the cache's own key), so a person can never double a check-in.
left join public.crm_person_by_hr_key_cache agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
-- Real only, and only a visit whose position was read: a check-in is a time AND a place.
where not p.is_test
  and p.lat is not null
  and p.lon is not null;

revoke all on table public.crm_checkins_unified from anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- READBACK (reads only):
--   select proname, prosecdef, proacl from pg_proc where proname in ('phoenix_crm_counted_seat_windows', 'phoenix_crm_counted_day_activity_windows');
--     -> both prosecdef true; proacl names postgres and service_role only.
--   select position('phoenix_crm_counted_seat_windows()' in pg_get_viewdef('public.crm_visits_unified'::regclass)) > 0,
--          position('phoenix_crm_counted_day_activity_windows()' in pg_get_viewdef('public.crm_visits_unified'::regclass)) > 0,
--          position('phoenix_crm_counted_seat_windows()' in pg_get_viewdef('public.crm_checkins_unified'::regclass)) > 0;
--     -> true, true, true.
--   The row counts of both doors by source and month, before and after, equal.
