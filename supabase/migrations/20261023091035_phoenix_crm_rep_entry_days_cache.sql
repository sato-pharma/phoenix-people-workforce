-- phoenix_crm_rep_entry_days_cache
--
-- WHAT THIS CHANGES:
--   The Phoenix entry days stop being rebuilt from all of Phoenix CRM's history on every read.
--
--   * public.phoenix_crm_rep_entry_days_calc(p_hr_key, p_day) is NEW and holds the ONE body — the
--     exact rows public.phoenix_crm_rep_entry_days() returned before this migration, with two
--     optional narrowing arguments (both default null, which is today's whole-history behaviour).
--   * public.phoenix_crm_rep_entry_days_cache is a NEW table keyed on (hr_key, entry_day).
--   * public.phoenix_crm_rep_entry_days() keeps its name, arguments, column list, STABLE SECURITY
--     DEFINER and `rows 400`, and now READS THAT TABLE. Nothing else changes: crm_visits_unified,
--     crm_checkins_unified, phoenix-kpi-data.ts, phoenix-team-starts.ts and
--     phoenix-vendor-leftovers.ts are untouched and all five get the cache for free.
--   * The cache is kept current by AFTER ROW triggers on the four tables that decide whether a
--     rep-day is an entry day (phoenix_crm_visits, phoenix_crm_day_activities,
--     phoenix_crm_unplanned_visits, phoenix_crm_visit_recordings), each recomputing exactly the one
--     (rep, day) key it touched THROUGH _calc — so there is no second copy of the rule to drift —
--     and by a statement-level rebuild on phoenix_crm_team_starts.
--   * public.phoenix_crm_rep_entry_days_reconcile() compares the cache with _calc() and rebuilds it
--     when they differ, scheduled every 5 minutes on pg_cron. That is what covers the inputs NOT
--     trigger-watched (see THE STALENESS WINDOW below).
--   * The migration backfills the cache and then REFUSES TO COMMIT unless the cache and _calc()
--     agree row for row.
--
-- WHY:
--   Speed, and it is the same instruction as 20261023040102 (owner, 2026-10-23: "speed up the rep
--   entry-days step in crm_visits_unified"). That migration made the customer join removable and
--   took the function from 18,025 buffers to about 4,500. This one removes the rebuild itself.
--
--   Measured on production, 23 October 2026, one first-page read of crm_visits_unified for a single
--   day inside a 23-day window: 79.4 ms execution and 5,885 buffers, of which the `entry_days`
--   MATERIALIZED CTE — phoenix_crm_rep_entry_days() — was 35.2 ms and 4,509 buffers. 44% of the
--   execution and 77% of every buffer touched, to produce 542 rows describing 16 days.
--
--   It is paid on EVERY read of both unified doors, and a company-wide window is deliberately read
--   one calendar day per request (reads.ts, dayScanSlices, which exists because an ordered scan of a
--   whole window hit the 8-second statement timeout on 14 and 16 September), so a 23-day window pays
--   it 23 times. pg_stat_statements since the 22 October restart: 20,610 calls naming these views,
--   3,074 s of 5,582 s — 55.1% of all execution time on this database.
--
--   And it grows. The function reads phoenix_crm_visits (4,225 rows today) in full, plus its
--   unplanned and recording joins, every time. Reading a 542-row indexed table does not.
--
-- THE STALENESS WINDOW — read this before changing the triggers:
--   Six things decide the answer. The four fact tables above are trigger-watched, so a rep saving a
--   visit or a day activity changes the cache IN HIS OWN TRANSACTION and the day-wins rule is exact
--   on the hot path. phoenix_crm_team_starts rebuilds the whole cache on any write.
--   The remaining two are NOT trigger-watched: employees (hr_id/crm_id, which only feeds the
--   agent_crm_id column) and au.seats (which seats are REP under a started team, via
--   phoenix_crm_started_team_seats()). Both change only through an administrative action — a hire, a
--   promotion, a reparenting — and a write there can leave the cache wrong until the reconcile runs,
--   at most 5 minutes. That is the deliberate trade: a cross-schema trigger on au.seats would fire
--   on every seat write in the platform, and the reconcile covers EVERY input rather than only the
--   ones enumerated here, including any this comment has not thought of.
--   So: if a figure ever disagrees with phoenix_crm_rep_entry_days_calc(), the cache is the suspect
--   and _calc() is the truth. `select public.phoenix_crm_rep_entry_days_reconcile();` returns the
--   number of differing rows and repairs them.
--
-- LOCKS:
--   Creates one table and six functions; adds five triggers. The backfill writes 542 rows into the
--   table this migration just created. No application row is read for writing and no existing row is
--   modified, so nothing outside the new table can be lost.
--
-- ROLLBACK:
--   create or replace function public.phoenix_crm_rep_entry_days()
--    returns table(hr_key text, agent_crm_id bigint, entry_day date)
--    language sql stable security definer rows 400 set search_path to 'public'
--   as $$ select c.hr_key, c.agent_crm_id, c.entry_day from public.phoenix_crm_rep_entry_days_calc() c $$;
--   That one statement puts every reader back on the live computation and leaves the table, the
--   triggers and the schedule in place doing no harm. Drop them afterwards if the revert is final.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. The one body ──────────────────────────────────────────────────────────────────────────────
-- Byte-for-byte the pre-migration body of phoenix_crm_rep_entry_days(), plus the two narrowing
-- predicates. Both arguments null is the whole history, which is what the rebuild and the reconcile
-- ask for; the triggers ask for one rep and one day, where `visit_date = p_day` reaches
-- phoenix_crm_visits_day_idx and the recompute stays a few milliseconds.

create or replace function public.phoenix_crm_rep_entry_days_calc(
  p_hr_key text default null,
  p_day date default null
)
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
       and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd')
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

-- ── 2. The cache ─────────────────────────────────────────────────────────────────────────────────
-- (agent_crm_id, entry_day) carries the second anti-join in both unified views, the one that matches
-- a vendor row whose agent has no hr_id at all.

create table if not exists public.phoenix_crm_rep_entry_days_cache (
  hr_key       text        not null,
  entry_day    date        not null,
  agent_crm_id bigint,
  refreshed_at timestamptz not null default now(),
  primary key (hr_key, entry_day)
);

create index if not exists phoenix_crm_rep_entry_days_cache_crm_day_idx
  on public.phoenix_crm_rep_entry_days_cache (agent_crm_id, entry_day)
  where agent_crm_id is not null;

alter table public.phoenix_crm_rep_entry_days_cache enable row level security;

grant select, insert, update, delete on table public.phoenix_crm_rep_entry_days_cache to service_role;

comment on table public.phoenix_crm_rep_entry_days_cache is
  'Cache of phoenix_crm_rep_entry_days_calc(). Kept current by AFTER triggers on the four Phoenix CRM fact tables and rebuilt by phoenix_crm_rep_entry_days_reconcile() every 5 minutes. _calc() is the truth; this table is only its materialisation.';

-- ── 3. Rebuild, and the single-key recompute the triggers use ────────────────────────────────────

create or replace function public.phoenix_crm_rep_entry_days_rebuild()
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  delete from public.phoenix_crm_rep_entry_days_cache;
  insert into public.phoenix_crm_rep_entry_days_cache (hr_key, entry_day, agent_crm_id)
  select c.hr_key, c.entry_day, c.agent_crm_id
    from public.phoenix_crm_rep_entry_days_calc() c
  on conflict (hr_key, entry_day) do update
    set agent_crm_id = excluded.agent_crm_id,
        refreshed_at = now();
  select count(*) into v_rows from public.phoenix_crm_rep_entry_days_cache;
  return v_rows;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_rebuild() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_rebuild() to service_role;

create or replace function public.phoenix_crm_rep_entry_days_touch(p_hr_id text, p_day date)
 returns void
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_key text := lower(btrim(p_hr_id));
begin
  -- A visit a manager entered carries no rep_hr_id, and _calc() never counts one: nothing to do.
  if v_key is null or v_key = '' or p_day is null then
    return;
  end if;
  delete from public.phoenix_crm_rep_entry_days_cache
   where hr_key = v_key and entry_day = p_day;
  insert into public.phoenix_crm_rep_entry_days_cache (hr_key, entry_day, agent_crm_id)
  select c.hr_key, c.entry_day, c.agent_crm_id
    from public.phoenix_crm_rep_entry_days_calc(v_key, p_day) c
  on conflict (hr_key, entry_day) do update
    set agent_crm_id = excluded.agent_crm_id,
        refreshed_at = now();
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_touch(text, date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_touch(text, date) to service_role;

-- ── 4. The triggers ──────────────────────────────────────────────────────────────────────────────
-- Each one recomputes only the keys it could have changed, and on an UPDATE that moved the rep or
-- the date it recomputes BOTH the old key and the new one. They return null because they are AFTER
-- triggers: nothing downstream reads the result.

create or replace function public.phoenix_crm_rep_entry_days_on_visit()
 returns trigger
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.phoenix_crm_rep_entry_days_touch(old.rep_hr_id, old.visit_date);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.phoenix_crm_rep_entry_days_touch(new.rep_hr_id, new.visit_date);
  end if;
  return null;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_on_visit() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_on_visit() to service_role;

create or replace function public.phoenix_crm_rep_entry_days_on_day_activity()
 returns trigger
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.phoenix_crm_rep_entry_days_touch(old.rep_hr_id, old.activity_date);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.phoenix_crm_rep_entry_days_touch(new.rep_hr_id, new.activity_date);
  end if;
  return null;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_on_day_activity() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_on_day_activity() to service_role;

-- phoenix_crm_countable_visits drops a visit whose off-plan approval is missing and one carrying an
-- unapproved recording, so a decision on either child changes its rep-day without touching the
-- visit row at all. The visit may already be gone on a cascade — then there is nothing to recompute
-- and the visit's own trigger has done it.

create or replace function public.phoenix_crm_rep_entry_days_on_visit_child()
 returns trigger
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_ids   uuid[] := '{}';
  v_id    uuid;
  v_visit record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_ids := array_append(v_ids, old.visit_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_ids := array_append(v_ids, new.visit_id);
  end if;
  foreach v_id in array v_ids loop
    for v_visit in
      select v.rep_hr_id, v.visit_date from public.phoenix_crm_visits v where v.id = v_id
    loop
      perform public.phoenix_crm_rep_entry_days_touch(v_visit.rep_hr_id, v_visit.visit_date);
    end loop;
  end loop;
  return null;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_on_visit_child() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_on_visit_child() to service_role;

-- A team start, a stop or a day_activities_from re-dates whole teams at once, so there is no one key
-- to recompute: rebuild. Statement-level — 21 rows, written only when the Super Admin presses Start.

create or replace function public.phoenix_crm_rep_entry_days_on_team_start()
 returns trigger
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  perform public.phoenix_crm_rep_entry_days_rebuild();
  return null;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_on_team_start() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_on_team_start() to service_role;

drop trigger if exists phoenix_crm_rep_entry_days_visit on public.phoenix_crm_visits;
create trigger phoenix_crm_rep_entry_days_visit
  after insert or update or delete on public.phoenix_crm_visits
  for each row execute function public.phoenix_crm_rep_entry_days_on_visit();

drop trigger if exists phoenix_crm_rep_entry_days_day_activity on public.phoenix_crm_day_activities;
create trigger phoenix_crm_rep_entry_days_day_activity
  after insert or update or delete on public.phoenix_crm_day_activities
  for each row execute function public.phoenix_crm_rep_entry_days_on_day_activity();

drop trigger if exists phoenix_crm_rep_entry_days_unplanned on public.phoenix_crm_unplanned_visits;
create trigger phoenix_crm_rep_entry_days_unplanned
  after insert or update or delete on public.phoenix_crm_unplanned_visits
  for each row execute function public.phoenix_crm_rep_entry_days_on_visit_child();

drop trigger if exists phoenix_crm_rep_entry_days_recording on public.phoenix_crm_visit_recordings;
create trigger phoenix_crm_rep_entry_days_recording
  after insert or update or delete on public.phoenix_crm_visit_recordings
  for each row execute function public.phoenix_crm_rep_entry_days_on_visit_child();

drop trigger if exists phoenix_crm_rep_entry_days_team_start on public.phoenix_crm_team_starts;
create trigger phoenix_crm_rep_entry_days_team_start
  after insert or update or delete on public.phoenix_crm_team_starts
  for each statement execute function public.phoenix_crm_rep_entry_days_on_team_start();

-- ── 5. The reconcile — what covers every input the triggers do not watch ─────────────────────────
-- EXCEPT treats two nulls as equal, so a null agent_crm_id on both sides is not a difference.

create or replace function public.phoenix_crm_rep_entry_days_reconcile()
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_diff integer;
begin
  with truth as (
    select c.hr_key, c.entry_day, c.agent_crm_id from public.phoenix_crm_rep_entry_days_calc() c
  ), cached as (
    select k.hr_key, k.entry_day, k.agent_crm_id from public.phoenix_crm_rep_entry_days_cache k
  )
  select count(*) into v_diff from (
    (select t.hr_key, t.entry_day, t.agent_crm_id from truth t
     except
     select c.hr_key, c.entry_day, c.agent_crm_id from cached c)
    union all
    (select c.hr_key, c.entry_day, c.agent_crm_id from cached c
     except
     select t.hr_key, t.entry_day, t.agent_crm_id from truth t)
  ) d;
  if v_diff > 0 then
    perform public.phoenix_crm_rep_entry_days_rebuild();
    raise warning 'phoenix_crm_rep_entry_days cache differed from phoenix_crm_rep_entry_days_calc() by % row(s) and was rebuilt', v_diff;
  end if;
  return v_diff;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_reconcile() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_reconcile() to service_role;

-- ── 6. The reader every caller already uses ──────────────────────────────────────────────────────
-- Same name, same arguments, same three columns in the same order, same STABLE SECURITY DEFINER and
-- the same `rows 400` it carried before, so no plan anywhere changes shape over a new row estimate.

create or replace function public.phoenix_crm_rep_entry_days()
 returns table(hr_key text, agent_crm_id bigint, entry_day date)
 language sql
 stable security definer rows 400
 set search_path to 'public'
as $function$
  select c.hr_key, c.agent_crm_id, c.entry_day
    from public.phoenix_crm_rep_entry_days_cache c
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days() to service_role;

-- ── 7. Backfill, and refuse to commit a cache that disagrees with the truth ──────────────────────

do $do$
declare
  v_rows integer;
  v_diff integer;
begin
  v_rows := public.phoenix_crm_rep_entry_days_rebuild();

  with truth as (
    select c.hr_key, c.entry_day, c.agent_crm_id from public.phoenix_crm_rep_entry_days_calc() c
  ), cached as (
    select k.hr_key, k.entry_day, k.agent_crm_id from public.phoenix_crm_rep_entry_days_cache k
  )
  select count(*) into v_diff from (
    (select t.hr_key, t.entry_day, t.agent_crm_id from truth t
     except
     select c.hr_key, c.entry_day, c.agent_crm_id from cached c)
    union all
    (select c.hr_key, c.entry_day, c.agent_crm_id from cached c
     except
     select t.hr_key, t.entry_day, t.agent_crm_id from truth t)
  ) d;

  if v_diff <> 0 then
    raise exception 'phoenix_crm_rep_entry_days cache backfill disagrees with phoenix_crm_rep_entry_days_calc() on % row(s) — not committing', v_diff;
  end if;

  raise notice 'phoenix_crm_rep_entry_days cache backfilled: % row(s), 0 differences against _calc()', v_rows;
end
$do$;

-- ── 8. The 5-minute reconcile schedule ───────────────────────────────────────────────────────────
-- cron.schedule(name, schedule, command) UPDATES the job of that name for the same owner rather than
-- stacking a second caller, so re-applying this migration re-points one job. Guarded on
-- pg_extension: where pg_cron is absent this raises a warning instead of failing, and the cache is
-- then only as current as the triggers make it — which is every rep-day a rep or a manager writes.

do $do$
declare
  v_named integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed here — phoenix-crm-rep-entry-days-reconcile was NOT scheduled; the triggers still keep the cache current on every write';
    return;
  end if;

  perform cron.schedule(
    'phoenix-crm-rep-entry-days-reconcile',
    '*/5 * * * *',
    'select public.phoenix_crm_rep_entry_days_reconcile();'
  );

  select count(*) into v_named from cron.job where jobname = 'phoenix-crm-rep-entry-days-reconcile';
  if v_named <> 1 then
    raise exception 'expected exactly one cron job named phoenix-crm-rep-entry-days-reconcile, found %', v_named;
  end if;

  raise notice 'phoenix-crm-rep-entry-days-reconcile scheduled every 5 minutes';
end
$do$;

commit;
