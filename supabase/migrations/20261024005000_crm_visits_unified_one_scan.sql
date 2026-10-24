-- THE VISITS DOOR READS THE VENDOR TABLE ONCE, AND LOOKS AN ENTRY DAY UP BY INDEX
-- =================================================================================================
-- Follows 20261023153000 (the person cache) and 20261023091035 (the entry-days cache). Nothing about
-- the door's OUTPUT changes: same columns, same order, same security_invoker, same grants, and the md5
-- of every row of crm_visits_unified over the whole of its history — 148,484 rows read in three
-- windows — is unchanged across the swap, measured on production before this file was written.
--
-- WHAT WAS SLOW, AND WHY (the account is docs/crm-visits-door-one-scan.md)
--   The door split ireports360_visits on the first team start into two UNION ALL branches, so one read
--   scanned that table twice. The second branch asked "has this rep already got a Phoenix entry that
--   day?" twice, each time against `with entry_days as materialized (select ... from
--   phoenix_crm_rep_entry_days())`. A function scan carries no statistics and no index, so the planner
--   could only walk all 542 rows of that CTE once per vendor row — on one October day that was 4,052
--   join-filter evaluations thrown away, and it grows with the rows AND with the number of entry days.
--
-- WHAT IT IS NOW
--   One scan, with the start bound as an ordinary filter, and the two checks reading
--   phoenix_crm_rep_entry_days_cache directly so they use its PRIMARY KEY (hr_key, entry_day) and its
--   partial (agent_crm_id, entry_day) index. phoenix_crm_rep_entry_days_calc() remains the ONLY body
--   that computes an entry day; this reads what that body wrote.
--
-- MEASURED ON PRODUCTION, nine interleaved runs of each shape, same moment, identical output bytes:
--   one day (22 Oct)               17.0 ms -> 7.0 ms     (-59%)
--   a month straddling the start  563.1 ms -> 336.2 ms   (-40%)
--   a month entirely before it    405.9 ms -> 410.0 ms   (nothing to save: no entry-day check runs)
--
-- 🔴 crm_checkins_unified CARRIES THE SAME CONSTRUCT AND IS DELIBERATELY NOT TOUCHED. The same rewrite
--   was built, proved byte-identical over all 142,363 of its rows, and measured the same way: 11.3 ->
--   11.8 ms on a day and 419.5 -> 411.8 ms on a month — no gain. Its cost is the rows it returns, not
--   the entry-day check. Do not 'finish the job' by changing it without measuring it again.
--
-- Rolling back: re-apply 20261023153000's crm_visits_unified statement, unchanged.

begin;
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
  null::timestamptz as phoenix_synced_at
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
  p.synced_at
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
join public.phoenix_crm_customers customer on customer.id = p.customer_id
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
  null::timestamptz
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

commit;

commit;
