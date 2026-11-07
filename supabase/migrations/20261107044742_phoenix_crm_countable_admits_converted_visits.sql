-- phoenix_crm_countable_admits_converted_visits
--
-- APPLY BY HAND, ONLY AFTER THE RUNNER AND THE LEAVERS STEP (docs/phoenix-crm-ireports360-history-import.md,
-- "Production order"). Never part of the merge: the two doors it once carried moved into 20261107044059, so
-- whenever this lands, crm_visits_unified and crm_checkins_unified serve exactly the rows they served before.
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_countable_visits admits a copied iReports360 visit when it counts —
--      ireports360_kpi_counted: converted with its check-in AND measured against a validated place. Every
--      other copied visit stays out at its root, and an archived one always. Read live on production (7 Nov
--      2026), the database reads this view in the two doors and the two functions of (2) only; the Phoenix CRM
--      screens that read it directly (insight reports, exceptions, rep ranks, the list-check board) then count
--      a converted visit that counts.
--   2. phoenix_crm_rep_entry_days_calc and phoenix_crm_seat_visit_firsts skip every copied visit by name, so
--      (1) moves neither "Phoenix wins the day" nor the adoption board's first Phoenix visit. Their live
--      bodies, with one line added each.
--
-- WHAT DOES NOT CHANGE: the two doors. Both already skip every copied visit on their Phoenix branch
--   (20261107044059, section 8), so a converted visit is served once — as its old iReports360 row, on its own
--   day, half-day and type, carrying counts_in_kpi. Every reader that asks "did he work that day" (deductions,
--   the half-day and holiday-bridge rules, attendance, outstation, Field Workforce Compliance) keeps every row
--   it reads today; every reader that COUNTS visits filters counts_in_kpi. Work evidence and trip evidence read
--   Phoenix rows only through phoenix-work-evidence.ts / crm-trip-evidence-reader.ts, which skip every copied
--   row, so no money moves here.
--
-- WHY (owner, 7 Nov 2026): every old regular visit with a check-in becomes a Phoenix visit; "no visits with no
--   location"; campaign visits are retired; a visit to a customer with no validated place is shown and not
--   counted; never counted twice.
--
-- ROLLBACK: re-run the phoenix_crm_countable_visits statement of 20261107044059. The two functions may stay:
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

notify pgrst, 'reload schema';
commit;

-- READBACK (reads only):
--   select count(*) from public.phoenix_crm_countable_visits where imported_from_ireports360_at is not null;
--     -> the converted visits that count (the runner's "kpi_counted").
--   select count(*) from public.crm_visits_unified;  -> unchanged (the doors are not touched here).
--   select count(*) from public.crm_checkins_unified;  -> unchanged.
--   select count(*) from public.phoenix_crm_rep_entry_days_cache;  -> unchanged.
