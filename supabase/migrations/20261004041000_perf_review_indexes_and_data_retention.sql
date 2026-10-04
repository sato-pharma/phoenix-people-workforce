-- perf_review_indexes_and_data_retention
--
-- WHAT THIS CHANGES:
--   1. notification_events: a GIN index on `recipients`, and (employee_hr_id, created_at desc).
--      The bell's second query (`recipients && $1 ... order by created_at desc limit 20`,
--      src/lib/notifications/in-app.ts) and the portal's `.or(employee_hr_id.eq, recipients.cs)` had
--      no index to use, so every call read the whole table: 18,841 rows, ~3,545 blocks, ~20 ms mean
--      over ~45k calls in pg_stat_statements (read 2026-10-04) — ~6,000 calls a day. A viewer with ONE
--      notification paid the same full scan as the busiest one.
--   2. phoenix_crm_visits / phoenix_crm_places: indexes for the two lookups every CRM capture runs
--      (src/lib/phoenix-crm/server/location-integrity.ts loadHistory) — the rep's own 14-day fixes and
--      the 180-day "anyone on this exact coordinate" replay band. Both tables hold ~140 rows today, so
--      this is cheap now and saves a whole-window scan per capture once the field rollout fills them.
--   3. Retention (owner decisions, 2026-10-04): audit_logs 12 months, email_delivery_events 6 months,
--      attendance_raw_punches 12 months. public.phx_prune_retention() deletes older rows in batches,
--      run daily by pg_cron at 01:40 UTC (04:40 Cairo in summer). Nothing is old enough today: the
--      first rows go in Nov 2026 (email events), Jan 2027 (punches) and May 2027 (audit log). No other
--      table is pruned.
--
-- WHY:
--   Backend performance review, 2026-10-04 (PERF-007, PERF-016, PERF-017).
--
-- LOCKS: plain CREATE INDEX (not CONCURRENTLY — this runs in a transaction). notification_events is
--   26 MB written ~270 times a day; the two CRM tables are tiny. Each build holds the write lock for
--   well under a second.
--
-- ROLLBACK:
--   drop index if exists public.notification_events_recipients_gin_idx,
--     public.notification_events_employee_created_idx, public.phoenix_crm_visits_rep_captured_idx,
--     public.phoenix_crm_visits_lat_idx, public.phoenix_crm_places_creator_captured_idx,
--     public.phoenix_crm_places_lat_idx;
--   select cron.unschedule('phoenix-data-retention');
--   drop function if exists public.phx_prune_retention();
--   Rows the prune already deleted do not come back — they are past the owner's retention period.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration itself deletes no rows; the scheduled job deletes only rows past the retention above.

begin;
set local lock_timeout = '5s';

create index if not exists notification_events_recipients_gin_idx
  on public.notification_events using gin (recipients);

create index if not exists notification_events_employee_created_idx
  on public.notification_events (employee_hr_id, created_at desc);

create index if not exists phoenix_crm_visits_rep_captured_idx
  on public.phoenix_crm_visits (rep_hr_id, is_test, captured_at)
  where lat is not null;

create index if not exists phoenix_crm_visits_lat_idx
  on public.phoenix_crm_visits (lat)
  where lat is not null;

create index if not exists phoenix_crm_places_creator_captured_idx
  on public.phoenix_crm_places (created_by_hr_id, is_test, captured_at);

create index if not exists phoenix_crm_places_lat_idx
  on public.phoenix_crm_places (lat)
  where lat is not null;

-- Owner retention decisions, 2026-10-04 — one function, one row per table, so a change is one edit:
--   audit_logs             12 months, by created_at   (oldest 2026-05-02 -> first delete May 2027)
--   email_delivery_events   6 months, by occurred_at  (oldest 2026-05-22 -> first delete Nov 2026)
--   attendance_raw_punches 12 months, by punch_time   (oldest 2026-01-01 -> first delete Jan 2027)
-- No foreign key references any of the three (checked on production 2026-10-04).
-- Each table is deleted 5,000 rows at a time, at most 100 batches a run, so one run never holds a
-- long lock and a backlog drains over successive days. Returns the rows deleted per table.
create or replace function public.phx_prune_retention()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch integer;
  v_total integer;
  v_round integer;
  v_out jsonb := '{}'::jsonb;
begin
  -- audit_logs: 12 months
  v_total := 0; v_round := 0;
  loop
    delete from public.audit_logs where id in (
      select id from public.audit_logs where created_at < now() - interval '12 months' order by created_at limit 5000);
    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch; v_round := v_round + 1;
    exit when v_batch < 5000 or v_round >= 100;
  end loop;
  v_out := v_out || jsonb_build_object('audit_logs', v_total);

  -- email_delivery_events: 6 months
  v_total := 0; v_round := 0;
  loop
    delete from public.email_delivery_events where id in (
      select id from public.email_delivery_events where occurred_at < now() - interval '6 months' order by occurred_at limit 5000);
    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch; v_round := v_round + 1;
    exit when v_batch < 5000 or v_round >= 100;
  end loop;
  v_out := v_out || jsonb_build_object('email_delivery_events', v_total);

  -- attendance_raw_punches: 12 months
  v_total := 0; v_round := 0;
  loop
    delete from public.attendance_raw_punches where id in (
      select id from public.attendance_raw_punches where punch_time < now() - interval '12 months' order by punch_time limit 5000);
    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch; v_round := v_round + 1;
    exit when v_batch < 5000 or v_round >= 100;
  end loop;
  v_out := v_out || jsonb_build_object('attendance_raw_punches', v_total);

  return v_out;
end;
$$;

revoke execute on function public.phx_prune_retention() from public, anon, authenticated;
grant execute on function public.phx_prune_retention() to service_role;

-- pg_cron is installed on production (it runs phoenix-recovery-snapshot). Scheduling by name replaces
-- an existing job of the same name, so re-running this migration does not stack a second job.
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('phoenix-data-retention', '40 1 * * *', 'select public.phx_prune_retention();');
  else
    raise notice 'pg_cron is not installed here — data retention is not scheduled on this database';
  end if;
end;
$do$;

commit;
