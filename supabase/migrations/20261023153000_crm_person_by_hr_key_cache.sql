-- crm_person_by_hr_key_cache
--
-- WHAT THIS CHANGES:
--   The two union doors stop rebuilding "one employee row per HR id, whatever the casing" seven
--   times on every read.
--
--   * public.crm_person_by_hr_key_calc(p_hr_key) is NEW and holds the ONE body - byte for byte the
--     `select distinct on (upper(btrim(e.hr_id))) ... order by upper(btrim(e.hr_id)), e.hr_id`
--     subquery the doors carried seven copies of, plus one optional narrowing argument.
--   * public.crm_person_by_hr_key_cache is a NEW table keyed on that hr_key, 220 rows today. It
--     carries `full_name` as employees holds it AND `full_name_nz` (blank as NULL), because the two
--     iReports360 sites read the blank-as-NULL form and the five Phoenix sites read the raw one -
--     so neither site's expression changes by a character.
--   * crm_visits_unified (six copies) and crm_checkins_unified (one) now JOIN that table. Nothing
--     else in either door changes: same columns, same order, same security_invoker, same grants.
--   * The cache is kept current by an AFTER STATEMENT trigger on employees - insert, delete, or an
--     update of hr_id, crm_id or full_name - which rebuilds all 220 rows THROUGH _calc(), so there
--     is no second copy of the rule. A hire or a rename is in the cache in the writer's own
--     transaction.
--   * public.crm_person_by_hr_key_reconcile() compares the cache with _calc() and rebuilds it when
--     they differ, scheduled every 15 minutes on pg_cron - a safety net, not the staleness bound,
--     because employees is the only input and it IS triggered.
--   * The migration backfills and then REFUSES TO COMMIT unless the cache and _calc() agree row for
--     row.
--
-- WHY:
--   Speed, and it is the owner's instruction of 2026-10-23: "cut the 22 ms planning time on
--   crm_visits_unified".
--
--   Measured on production the same day, one day's first page of crm_visits_unified, nine
--   interleaved runs of each shape, medians:
--
--     today                     planning 9.21 ms - execution 17.40 ms - 736 buffers
--     with this cache           planning 8.61 ms - execution 11.52 ms - 348 buffers
--
--   So the planning win is small (-7%) and the EXECUTION win is the real one: -34% of the time and
--   -53% of every buffer touched, because seven Sort+Unique passes over employees (about 198
--   buffers each) become seven lookups in a 220-row table with a primary key.
--
--   THE PLANNING TIME ITSELF IS THE JOIN-ORDER SEARCH, NOT THESE SUBQUERIES, and no local change to
--   the view moves it much. A DISTINCT ON subquery is already an optimisation fence, so it never
--   joined the planner's search space in the first place. Measured the same way:
--   join_collapse_limit/from_collapse_limit at 4 instead of 8 takes planning from 10.09 ms to
--   5.24 ms on this door and from 3.97 ms to 2.62 ms on the check-in door, with execution unchanged
--   (17.03 -> 16.87 and 6.36 -> 6.94). That is a database-wide planner knob, not a property of one
--   view, so it is NOT in this migration.
--
--   The 22 ms in the instruction was measured in a cold session: planning touched 2,274 catalog
--   buffers on the first statement of a new connection and 39 on every one after, so about 13 of
--   those 22 ms were a cold catalog, not work the app pays per read.
--
-- THE STALENESS WINDOW:
--   employees is the ONLY input, and it is trigger-watched on the three columns that decide the
--   answer, so the cache is exact on the hot path. The 15-minute reconcile exists for a write that
--   bypasses the trigger (a TRUNCATE, a disabled trigger, a restore) and it repairs rather than
--   warns. If a name or a crm_id ever disagrees with crm_person_by_hr_key_calc(), the cache is the
--   suspect and _calc() is the truth:
--     select public.crm_person_by_hr_key_reconcile();
--   returns the number of differing rows and repairs them.
--
-- LOCKS:
--   Creates one table and four functions, adds one statement-level trigger on employees, and
--   replaces two views in place. The backfill writes 220 rows into the table this migration just
--   created. No application row is read for writing and no existing row is modified, so nothing
--   outside the new table can be lost. Both `create or replace view` statements keep every column,
--   in order, so no dependent view or grant is disturbed.
--
-- ROLLBACK:
--   Re-apply the view halves of 20261022163000 (its two `create or replace view` statements), which
--   put both doors back on the inline subqueries and leave the table, the trigger and the schedule
--   in place doing no harm. Drop them afterwards if the revert is final.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- -- 1. The one body ------------------------------------------------------------------------------
-- Byte for byte the subquery the two doors carried seven copies of, plus the narrowing predicate.
-- `distinct on (upper(btrim(hr_id))) ... order by upper(btrim(hr_id)), hr_id` keeps the row with the
-- lowest hr_id among the ones sharing a case-insensitive key - that tie-break IS the rule, because
-- it is what makes a person unable to double a visit.
create or replace function public.crm_person_by_hr_key_calc(p_hr_key text default null)
 returns table(hr_key text, hr_id text, crm_id text, full_name text, full_name_nz text)
 language sql stable security definer rows 400 set search_path to 'public'
as $function$
  select distinct on (upper(btrim(e.hr_id)))
         upper(btrim(e.hr_id)) as hr_key,
         e.hr_id,
         e.crm_id,
         e.full_name,
         nullif(btrim(e.full_name), '') as full_name_nz
    from public.employees e
   where p_hr_key is null or upper(btrim(e.hr_id)) = p_hr_key
   order by upper(btrim(e.hr_id)), e.hr_id
$function$;

revoke execute on function public.crm_person_by_hr_key_calc(text) from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_calc(text) to service_role;

-- -- 2. The cache ---------------------------------------------------------------------------------
-- Granted exactly as the two doors are: service_role only. The doors are security_invoker and are
-- themselves readable by service_role alone, so this adds no reach to any browser key.
create table if not exists public.crm_person_by_hr_key_cache (
  hr_key       text primary key,
  hr_id        text not null,
  crm_id       text,
  full_name    text,
  full_name_nz text
);

alter table public.crm_person_by_hr_key_cache enable row level security;
revoke all on table public.crm_person_by_hr_key_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.crm_person_by_hr_key_cache to service_role;

-- -- 3. The rebuild -------------------------------------------------------------------------------
-- 220 rows, so the whole table is rebuilt rather than one key touched: there is no OLD-key arm to
-- get wrong, and a rename that changes the casing of an hr_id moves a row between keys for free.
create or replace function public.crm_person_by_hr_key_rebuild()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  delete from public.crm_person_by_hr_key_cache;
  insert into public.crm_person_by_hr_key_cache (hr_key, hr_id, crm_id, full_name, full_name_nz)
  select c.hr_key, c.hr_id, c.crm_id, c.full_name, c.full_name_nz
    from public.crm_person_by_hr_key_calc() c;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$function$;

revoke execute on function public.crm_person_by_hr_key_rebuild() from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_rebuild() to service_role;

-- -- 4. The trigger -------------------------------------------------------------------------------
-- Named on the three columns that decide the answer, so the hundred other employee columns HR edits
-- every day do not rebuild anything.
create or replace function public.crm_person_by_hr_key_on_employee()
 returns trigger
 language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  perform public.crm_person_by_hr_key_rebuild();
  return null;
end
$function$;

revoke execute on function public.crm_person_by_hr_key_on_employee() from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_on_employee() to service_role;

drop trigger if exists crm_person_by_hr_key_sync on public.employees;
create trigger crm_person_by_hr_key_sync
after insert or delete or update of hr_id, crm_id, full_name on public.employees
for each statement execute function public.crm_person_by_hr_key_on_employee();

-- -- 5. The reconcile -----------------------------------------------------------------------------
-- Compares VALUES, not just keys, and repairs. Returns the number of rows that differed.
create or replace function public.crm_person_by_hr_key_reconcile()
 returns integer
 language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  v_diff integer;
begin
  select count(*) into v_diff
    from (
      (select * from public.crm_person_by_hr_key_cache
        except
       select * from public.crm_person_by_hr_key_calc())
      union all
      (select * from public.crm_person_by_hr_key_calc()
        except
       select * from public.crm_person_by_hr_key_cache)
    ) d;

  if v_diff > 0 then
    perform public.crm_person_by_hr_key_rebuild();
    raise warning 'crm_person_by_hr_key_cache was % row(s) out of step with _calc() and has been rebuilt', v_diff;
  end if;

  return v_diff;
end
$function$;

revoke execute on function public.crm_person_by_hr_key_reconcile() from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_reconcile() to service_role;

-- -- 6. The backfill, and the check that refuses to commit ----------------------------------------
do $do$
declare
  v_rows integer;
  v_diff integer;
begin
  v_rows := public.crm_person_by_hr_key_rebuild();

  select count(*) into v_diff
    from (
      (select * from public.crm_person_by_hr_key_cache
        except
       select * from public.crm_person_by_hr_key_calc())
      union all
      (select * from public.crm_person_by_hr_key_calc()
        except
       select * from public.crm_person_by_hr_key_cache)
    ) d;

  if v_diff <> 0 then
    raise exception 'crm_person_by_hr_key_cache disagrees with _calc() on % row(s) - refusing to commit', v_diff;
  end if;

  if v_rows = 0 then
    raise exception 'crm_person_by_hr_key_cache backfilled 0 rows - refusing to commit';
  end if;

  raise notice 'crm_person_by_hr_key cache backfilled: % row(s), 0 differences against _calc()', v_rows;
end
$do$;

-- -- 7. The 15-minute reconcile schedule ------------------------------------------------------------
-- cron.schedule(name, schedule, command) UPDATES the job of that name for the same owner rather
-- than stacking a second caller, so re-applying this migration re-points one job. Guarded on
-- pg_extension: where pg_cron is absent this raises a warning instead of failing, and the cache is
-- then only as current as the trigger makes it - which is every employees write that matters.
do $do$
declare
  v_named integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here - crm-person-by-hr-key-reconcile was NOT scheduled; the trigger still keeps the cache current on every write';
    return;
  end if;

  perform cron.schedule(
    'crm-person-by-hr-key-reconcile',
    '*/15 * * * *',
    'select public.crm_person_by_hr_key_reconcile();'
  );

  select count(*) into v_named from cron.job where jobname = 'crm-person-by-hr-key-reconcile';
  if v_named <> 1 then
    raise exception 'expected exactly one cron job named crm-person-by-hr-key-reconcile, found %', v_named;
  end if;

  raise notice 'crm-person-by-hr-key-reconcile scheduled every 15 minutes';
end
$do$;

-- -- 8. The two doors, reading the cache ------------------------------------------------------------
-- 20261022163000's views, word for word, with each inline person subquery replaced by a join to the
-- cache. Every column, its order, the security_invoker setting and both grants are unchanged.

create or replace view public.crm_visits_unified
  with (security_invoker = true)
as
-- THE ENTRY DAYS, BUILT ONCE PER READ (2026-10-19). phoenix_crm_rep_entry_days() rebuilds every Phoenix
-- entry day from the whole of Phoenix CRM's history each time it runs, and the two checks below used to run
-- it once each. Materialized, so one read builds it at most once — and only when that read reaches a vendor
-- row dated from Phoenix CRM's first day on.
with entry_days as materialized (
  select e.hr_key, e.agent_crm_id, e.entry_day from public.phoenix_crm_rep_entry_days() e
)
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
  -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): no rep has a Phoenix entry on a day earlier than the first
  -- team start, or than that start's earlier day_activities_from, so "Phoenix wins the day" can drop nothing
  -- there and is not asked. Every read of a July, August or September day used to build every Phoenix entry
  -- day, twice, to learn that. The bound is read live, so a team started later moves nothing.
  select x.*
    from public.ireports360_visits x
   where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
     and x.visit_date < (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)
         from public.phoenix_crm_team_starts t
     )
  union all
  -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP (owner, 2026-10-16): on a day he has
  -- a countable entry in Phoenix CRM his iReports360 row is dropped; on a day he has none, the vendor row
  -- counts. A district manager has no entry day (the function reads rep seats only), so he keeps both.
  select x.*
    from public.ireports360_visits x
   where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
     and x.visit_date >= (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)
         from public.phoenix_crm_team_starts t
     )
     and not exists (
       select 1
         from entry_days e
        where e.hr_key = lower(btrim(x.agent_hr_id))
          and e.entry_day = x.visit_date
     )
     -- A vendor row the sync could not give an hr id is still his, by his CRM id.
     and not exists (
       select 1
         from entry_days e
        where nullif(btrim(x.agent_hr_id), '') is null
          and e.agent_crm_id = x.agent_crm_id
          and e.entry_day = x.visit_date
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

create or replace view public.crm_checkins_unified
  with (security_invoker = true)
as
-- THE ENTRY DAYS, BUILT ONCE PER READ (2026-10-19). phoenix_crm_rep_entry_days() rebuilds every Phoenix
-- entry day from the whole of Phoenix CRM's history each time it runs, and the two checks below used to run
-- it once each. Materialized, so one read builds it at most once — and only when that read reaches a vendor
-- row dated from Phoenix CRM's first day on.
with entry_days as materialized (
  select e.hr_key, e.agent_crm_id, e.entry_day from public.phoenix_crm_rep_entry_days() e
)
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
  -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): the visit door's split, on the check-in's wall-clock day. A
  -- vendor check-in's day is its wall clock as stored (Cairo, labelled UTC — the vendor convention), so a
  -- check-in before that day's midnight "UTC" is on a day before it.
  select x.*
    from public.ireports360_checkins x
   where x.check_date < coalesce(
     (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
     'infinity'::timestamptz
   )
     and x.check_date < (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC'
         from public.phoenix_crm_team_starts t
     )
  union all
  -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP: the same rule as the visit door,
  -- on the same entry days.
  select x.*
    from public.ireports360_checkins x
   where x.check_date < coalesce(
     (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
     'infinity'::timestamptz
   )
     and x.check_date >= (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC'
         from public.phoenix_crm_team_starts t
     )
     and not exists (
       select 1
         from entry_days e
        where e.hr_key = lower(btrim(x.agent_hr_id))
          and e.entry_day = (x.check_date at time zone 'UTC')::date
     )
     -- A check-in the sync could not give an hr id is still his, by his CRM id.
     and not exists (
       select 1
         from entry_days e
        where nullif(btrim(x.agent_hr_id), '') is null
          and e.agent_crm_id = x.agent_crm_id
          and e.entry_day = (x.check_date at time zone 'UTC')::date
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
join public.phoenix_crm_started_team_seats() team
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

commit;
