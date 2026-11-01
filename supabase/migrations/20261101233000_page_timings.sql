-- page_timings: how long each page takes, by the hour, with nobody in it.
--
-- WHY. On 1 Nov 2026 the owner measured every Phoenix CRM and portal page as a signed-in rep and asked
-- that the system "record everything", so the next slow page is named by data rather than by a complaint.
-- His decision the same evening: "hourly medians per page, 30 days, no names". The browser beacon
-- (/api/telemetry/page-timing) already reported two paint times into the per-minute process_health log
-- line, which Railway keeps for days and nobody can query by page; this table keeps an hour's summary
-- per page shape, so /admin/system-audit can show the slowest pages of the week.
--
-- WHAT A ROW IS. One hour, one page SHAPE (`/employee-portals/phoenix-crm/visits`; any segment with a
-- digit is `:id`), one KIND (hard: the document loaded; soft: a tap inside the app reached its page), one
-- DEVICE CLASS (low: four cores or fewer, or 4 GB or less; high; unknown) and one METRIC (ttfb, fcp, lcp,
-- interactive, first_data, soft), with the count of measurements, the median, the 90th percentile and
-- the worst, in milliseconds. There is NO column for a person, a login, an address or a user agent, and
-- src/lib/observability/page-timing-intake.ts is what keeps it that way: the beacon reads no session.
--
-- WHO WRITES. The web process sums an hour in memory (page-timing-store.ts) and calls
-- phx_page_timings_record once the hour has ended (page-timing-flush.ts, from the process-health tick).
-- A second process in the same hour, or a restart, MERGES into the row: the counts add, the maximum takes
-- the larger, and the median and the 90th percentile become the count-weighted average of the two — an
-- approximation, stated here because an exact merge needs the samples, which are deliberately not kept.
--
-- RETENTION. phx_prune_retention gains its fourth period, page_timings at 30 days, on the owner's word
-- above; the pg_cron job that runs it is unchanged. cron.schedule is not called here, so staging, which
-- has no data retention by his decision, gets the table and the functions and no new job.

begin;

create table if not exists public.page_timings (
  hour timestamptz not null,
  path text not null check (char_length(path) <= 200 and path ~ '^/(employee-portals|admin)(/([a-z][a-z-]{0,48}|:id)){0,3}$'),
  kind text not null check (kind in ('hard', 'soft')),
  device text not null check (device in ('low', 'high', 'unknown')),
  metric text not null check (metric in ('ttfb', 'fcp', 'lcp', 'interactive', 'first_data', 'soft')),
  count integer not null check (count > 0),
  p50_ms integer not null check (p50_ms >= 0),
  p90_ms integer not null check (p90_ms >= 0),
  max_ms integer not null check (max_ms >= 0),
  updated_at timestamptz not null default now(),
  primary key (hour, path, kind, device, metric)
);

comment on table public.page_timings is
  'How long each page takes, by the hour: one row per hour, page shape, kind (hard load or tap), device class and metric, holding the count, the median, the 90th percentile and the worst in milliseconds. No person, login, address or user agent is ever stored. Written by phx_page_timings_record from the web process; read by the System Audit''s Slowest pages tab; pruned at 30 days by phx_prune_retention (owner, 2026-11-01).';

-- The Slowest pages tab reads a window by hour, and the primary key already leads with hour.

-- Row security on with no policy and no browser grant: the house norm. The one writer and the one
-- reader go through the service-role client.
alter table public.page_timings enable row level security;

-- Record a batch of hour rows, merging into an hour another process (or this one, before a restart)
-- already wrote. p_rows is an array of {hour, path, kind, device, metric, count, p50_ms, p90_ms, max_ms}.
create or replace function public.phx_page_timings_record(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written integer;
begin
  insert into public.page_timings as t (hour, path, kind, device, metric, count, p50_ms, p90_ms, max_ms)
  select r.hour, r.path, r.kind, r.device, r.metric, r.count, r.p50_ms, r.p90_ms, r.max_ms
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    hour timestamptz, path text, kind text, device text, metric text,
    count integer, p50_ms integer, p90_ms integer, max_ms integer)
  where r.hour is not null and r.path is not null and r.kind is not null and r.device is not null
    and r.metric is not null and coalesce(r.count, 0) > 0
    and r.p50_ms is not null and r.p90_ms is not null and r.max_ms is not null
  on conflict (hour, path, kind, device, metric) do update set
    count = t.count + excluded.count,
    p50_ms = round((t.p50_ms::numeric * t.count + excluded.p50_ms::numeric * excluded.count) / (t.count + excluded.count))::integer,
    p90_ms = round((t.p90_ms::numeric * t.count + excluded.p90_ms::numeric * excluded.count) / (t.count + excluded.count))::integer,
    max_ms = greatest(t.max_ms, excluded.max_ms),
    updated_at = now();
  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

revoke execute on function public.phx_page_timings_record(jsonb) from public, anon, authenticated;
grant execute on function public.phx_page_timings_record(jsonb) to service_role;

-- A window summed per page shape, kind, device class and metric: the count-weighted median and 90th
-- percentile of its hours, and the worst hour's worst. Read by the Slowest pages tab.
create or replace function public.phx_page_timings_summary(p_since timestamptz)
returns table (path text, kind text, device text, metric text, count bigint, p50_ms integer, p90_ms integer, max_ms integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.path, t.kind, t.device, t.metric,
         sum(t.count)::bigint as count,
         round(sum(t.p50_ms::numeric * t.count) / sum(t.count))::integer as p50_ms,
         round(sum(t.p90_ms::numeric * t.count) / sum(t.count))::integer as p90_ms,
         max(t.max_ms) as max_ms
  from public.page_timings t
  where t.hour >= p_since
  group by t.path, t.kind, t.device, t.metric
$$;

revoke execute on function public.phx_page_timings_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.phx_page_timings_summary(timestamptz) to service_role;

-- Retention: the owner's periods of 2026-10-04 unchanged (audit_logs 12 months, email_delivery_events
-- 6 months, attendance_raw_punches 12 months) plus page_timings at 30 days (owner, 2026-11-01). The same
-- 5,000-row batches; the pg_cron job and its _run() wrapper (20261023223000) call this by name and are
-- not touched.
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

  -- page_timings: 30 days (owner, 2026-11-01). A composite key, so the batch is picked by ctid.
  v_total := 0; v_round := 0;
  loop
    delete from public.page_timings where ctid in (
      select ctid from public.page_timings where hour < now() - interval '30 days' order by hour limit 5000);
    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch; v_round := v_round + 1;
    exit when v_batch < 5000 or v_round >= 100;
  end loop;
  v_out := v_out || jsonb_build_object('page_timings', v_total);

  return v_out;
end;
$$;

revoke execute on function public.phx_prune_retention() from public, anon, authenticated;
grant execute on function public.phx_prune_retention() to service_role;

commit;
