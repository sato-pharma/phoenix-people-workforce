-- crm_doors_count_converted_old_visits
--
-- APPLY ONLY AFTER THE CONVERSION RAN (docs/phoenix-crm-ireports360-history-import.md, "The conversion"): the
-- archive must be filled and the copied visits measured, or the old visits this stops serving from iReports360
-- are served by nobody until it runs.
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_countable_visits admits a copied iReports360 visit when it counts —
--      ireports360_kpi_counted: converted with its check-in AND measured against a validated place. Every
--      other copied visit stays out at its root, and an archived one always.
--   2. phoenix_crm_rep_entry_days_calc and phoenix_crm_seat_visit_firsts skip every copied visit by name, so
--      (1) moves neither "Phoenix wins the day" nor the adoption board's first Phoenix visit. Their live
--      bodies, with one line added each.
--   3. crm_visits_unified, the 20261106235920 body with three changes:
--        the iReports360 arm no longer serves a campaign visit (-8), a visit in the visits archive, or a visit
--        copied into Phoenix CRM;
--        the Phoenix arm LEFT-joins the counted windows, so a converted visit dated before its team started
--        is served — the countable view already holds only the ones that count.
--   4. crm_checkins_unified, the same body with one line: the Phoenix arm skips a copied visit, whose
--      position is the old check-in the iReports360 arm already serves. Its rows do not change.
--
-- WHY (owner, 7 Nov 2026): every old regular visit with a check-in becomes a Phoenix visit; "no visits with no
--   location"; campaign visits are retired; a visit to a customer with no validated place is shown and not
--   counted; never counted twice. Leave, meetings, training, travel and every other old row type are served
--   exactly as before — none is ever copied or archived.
--
-- WHAT MOVES (measured read-only on production, 7 Nov 2026, before any run): the iReports360 visit rows the
--   door serves for January to November fall from 106,228 regular and 32,110 campaign to the located ones
--   nobody copied; the converted visits that count are served from Phoenix instead. Month by month in the
--   same doc. Nothing pays from this door's old days: work evidence and trip evidence read Phoenix rows only
--   through phoenix-work-evidence.ts / crm-trip-evidence-reader.ts, which skip every copied row.
--
-- ROLLBACK: re-run the crm_visits_unified and crm_checkins_unified statements of 20261106235920 (same
--   columns) and the phoenix_crm_countable_visits statement of 20261107044059. The two functions may stay:
--   their added line skips rows the countable view no longer admits. Nothing here writes or deletes a row.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- 1. The countable view admits a converted visit that counts --------------------------------------------------

create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select
    v.id, v.seat_id, v.line_code, v.customer_id, v.list_type, v.visit_date, v.captured_at, v.kind,
    v.rep_hr_id, v.manager_hr_id, v.senior_hr_id, v.entered_by_hr_id, v.products, v.comment,
    v.photo_path, v.lat, v.lon, v.accuracy_meters, v.place_id, v.distance_meters, v.location_flag,
    v.device_skew_minutes, v.is_test, v.created_at, v.pharmacy_name, v.product_availability,
    v.voice_note_path, v.voice_note_seconds, v.voice_note_bytes, v.is_unplanned, v.next_step,
    v.next_step_on, v.objection, v.objection_note, v.samples_given, v.dwell_seconds,
    v.form_open_seconds, v.capture_source, v.time_anchor_id, v.offline_seconds, v.synced_at,
    v.photo_lat, v.photo_lon, v.photo_accuracy_meters, v.photo_captured_at, v.unplanned_kind,
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does. Coalesced so the
    -- column stays two-state although the join below is a left one.
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id,
    -- Appended (20261029212200), last for the same reason.
    v.imported_from_ireports360_at,
    -- Appended (owner, 2026-11-07), the history view's three, so both views keep one column list.
    v.ireports360_checkin_id,
    v.ireports360_kpi_counted,
    v.archived_at
  from public.phoenix_crm_visits v
  -- LEFT, so the planner drops this join for every reader that never asks for customer_validated
  -- (phoenix_crm_rep_entry_days above all). It can never null-extend: customer_id is NOT NULL and
  -- carries the foreign key. Never "fix" it back to inner — that restores a customer lookup per visit.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      -- 🔴 AN IN, NOT A LEFT JOIN (speed, 2026-10-28). The join probed the off-plan table's primary key
      -- once for EVERY visit any reader walked — about 12 million probes — to read one column. The IN is
      -- one hash of the approved rows per read. Exact: visit_id is that table's primary key, so the list
      -- holds no NULL and at most one row per visit. Never "fix" it back to a join.
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    -- A recorded visit counts once the Administrator approves it (owner, 2026-10-16).
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    )
    -- 🔴 A VISIT COPIED FROM iREPORTS360 COUNTS ONLY WHEN IT WAS CONVERTED AND MEASURED AGAINST A VALIDATED
    -- PLACE (owner, 7 Nov 2026) — ireports360_kpi_counted, which the trigger phoenix_crm_visits_old_system_kpi
    -- keeps. Every other copied visit stays out at the root, as since 20261031160000. A reader that judges,
    -- alarms or pays still skips EVERY copied row by imported_from_ireports360_at, converted or not.
    and (v.imported_from_ireports360_at is null or v.ireports360_kpi_counted)
    and v.archived_at is null;

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- 2. The entry days and the adoption board skip every copied visit -------------------------------------------
--
-- The live bodies (read 7 Nov 2026), each with ONE line added: `and p.imported_from_ireports360_at is null`.
-- A converted old visit is history, never a day the rep worked in Phoenix CRM, so it never drops a vendor
-- row ("Phoenix wins the day") and is never the seat's first Phoenix visit.

create or replace function public.phoenix_crm_rep_entry_days_calc(p_hr_key text default null::text, p_day date default null::date)
 returns table(hr_key text, agent_crm_id bigint, entry_day date)
 language sql
 stable security definer rows 400
 set search_path to 'public'
as $function$
  with entries as (
    select lower(btrim(p.rep_hr_id)) as hr_key, p.visit_date as entry_day
      from public.phoenix_crm_countable_visits p
      join public.phoenix_crm_started_team_seats() team
        on team.seat_id = p.seat_id
       and p.visit_date >= team.starts_on
       and (team.stops_on is null or p.visit_date < team.stops_on)
     where not p.is_test
       and nullif(btrim(p.rep_hr_id), '') is not null
       and p.imported_from_ireports360_at is null
       and (p_day is null or p.visit_date = p_day)
       and (p_hr_key is null or lower(btrim(p.rep_hr_id)) = p_hr_key)
    union
    select lower(btrim(a.rep_hr_id)), a.activity_date
      from public.phoenix_crm_day_activities a
      join public.phoenix_crm_started_team_seats() team on team.seat_id = a.seat_id
      left join public.phoenix_crm_team_starts run
        on run.team_seat_id = team.team_seat_id
       and run.starts_on = team.starts_on
       and run.stops_on is not distinct from team.stops_on
     where not a.is_test
       and nullif(btrim(a.rep_hr_id), '') is not null
       and a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))
       and (team.stops_on is null or a.activity_date < team.stops_on)
       and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd', 'interviews')
       and (p_day is null or a.activity_date = p_day)
       and (p_hr_key is null or lower(btrim(a.rep_hr_id)) = p_hr_key)
  )
  select e.hr_key, person.agent_crm_id, e.entry_day
    from entries e
    left join lateral (
      select case when emp.crm_id ~ '^[0-9]+$' then emp.crm_id::bigint end as agent_crm_id
        from public.employees emp
       where upper(btrim(emp.hr_id)) = upper(e.hr_key)
       order by emp.hr_id
       limit 1
    ) person on true
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_calc(text, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_calc(text, date) to service_role;

create or replace function public.phoenix_crm_seat_visit_firsts(p_seat_ids text[], p_is_test boolean)
 returns table(seat_id text, first_visit_on date, visits_ever integer)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select v.seat_id, min(v.visit_date) as first_visit_on, count(*)::integer as visits_ever
  from public.phoenix_crm_countable_visits v
  where v.seat_id = any(p_seat_ids)
    and v.is_test = p_is_test
    and v.imported_from_ireports360_at is null
  group by v.seat_id;
$function$;

revoke execute on function public.phoenix_crm_seat_visit_firsts(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_visit_firsts(text[], boolean) to service_role;

-- 3 and 4. The two doors ------------------------------------------------------------------------------------

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
     -- 🔴 AN OLD VISIT IS SERVED ONLY AS A VISIT WITH A LOCATION, AND ONCE (owner, 7 Nov 2026). A campaign
     -- visit is retired; a regular visit with no check-in location is in the visits archive; a visit copied into
     -- Phoenix CRM is served by the Phoenix arm below when it counts (converted, measured against a validated
     -- place) and by nobody when it does not. Every other kind of row — leave, meeting, training, travel — is
     -- untouched: none is ever copied or archived.
     and x.visit_type <> -8
     and not exists (select 1 from public.phoenix_crm_visit_archive a where a.crm_visit_id = x.crm_visit_id)
     and not exists (select 1 from public.phoenix_crm_imported_visit_sources s where s.crm_visit_id = x.crm_visit_id)
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
-- LEFT, so a converted old visit (owner, 7 Nov 2026) — dated before its team started, in no window — is
-- served too: the countable view admits one only when it counts, and its own old row is never served above.
left join public.phoenix_crm_counted_seat_windows() team
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
  and (team.seat_id is not null or p.imported_from_ireports360_at is not null)
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
  -- A converted old visit's position is its old check-in, which the iReports360 arm above already serves on
  -- that day: served here as well, the check-in would count twice (owner, 7 Nov 2026).
  and p.imported_from_ireports360_at is null
  and p.lat is not null
  and p.lon is not null;

revoke all on table public.crm_checkins_unified from anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- READBACK (reads only):
--   select count(*) from public.phoenix_crm_countable_visits where imported_from_ireports360_at is not null;
--     -> the converted visits that count (the runner's "kpi_counted").
--   select to_char(visit_date, 'YYYY-MM'), source, count(*) from public.crm_visits_unified
--    where visit_type in (0, -8) group by 1, 2 order by 1, 2;  -> no -8; the month table in the doc.
--   select count(*) from public.crm_checkins_unified;  -> unchanged.
--   select count(*) from public.phoenix_crm_rep_entry_days_cache;  -> unchanged.
