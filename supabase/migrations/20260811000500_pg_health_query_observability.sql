-- Slow-query observability, from the 2026-08-10 production Postgres health audit.
--
-- WHY THIS EXISTS RATHER THAN LOG SETTINGS
-- The audit found a query running 17.5 seconds, 192 times, that nothing had surfaced:
-- log_min_duration_statement is -1 and track_io_timing is off. Neither can be changed on
-- this platform -- Supabase's config API rejects both keys outright ("Unrecognized keys"),
-- and ALTER DATABASE refuses them because both are superuser-context GUCs. auto_explain
-- IS already active at 10s, so only the very worst queries leave any trace at all, and
-- that trace lives in log retention rather than anywhere the app can query.
--
-- So the history is captured into the database instead: a periodic snapshot of
-- pg_stat_statements, which gives queryable, retained, app-visible slow-query history
-- that survives log rotation and needs no platform privilege.

-- ── snapshots ───────────────────────────────────────────────────────────────────
create table if not exists public.pg_stat_statements_snapshots (
  id                bigint generated always as identity primary key,
  captured_at       timestamptz      not null default now(),
  queryid           bigint           not null,
  query_sample      text             not null,
  calls             bigint           not null,
  total_exec_ms     double precision not null,
  mean_exec_ms      double precision not null,
  max_exec_ms       double precision not null,
  rows_returned     bigint           not null,
  shared_blks_hit   bigint,
  shared_blks_read  bigint
);

comment on table public.pg_stat_statements_snapshots is
  'Periodic pg_stat_statements capture. Query text is the normalised form ($1 placeholders), so it carries no literals and no PII.';

create index if not exists pg_stat_statements_snapshots_captured_idx
  on public.pg_stat_statements_snapshots (captured_at desc);
create index if not exists pg_stat_statements_snapshots_query_idx
  on public.pg_stat_statements_snapshots (queryid, captured_at desc);

-- House pattern: RLS on, no policy. Denies anon and authenticated outright; the
-- service-role client the app uses bypasses RLS. Matches all 302 other public tables.
alter table public.pg_stat_statements_snapshots enable row level security;

-- ── capture ─────────────────────────────────────────────────────────────────────
create or replace function public.phx_capture_query_stats(p_top integer default 50)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  n integer;
begin
  -- Rank on THREE axes, not just cumulative time. Ranking by total_exec_time alone
  -- was the first version of this function, and it silently failed its own purpose:
  -- a 3.5s query called 15 times has ~50s cumulative and never enters a top-50 list
  -- headed by PostgREST queries with 6,917s. The query worth catching is the one that
  -- is slow PER CALL, long before its cumulative total climbs anywhere near the top.
  insert into public.pg_stat_statements_snapshots (
    queryid, query_sample, calls, total_exec_ms, mean_exec_ms, max_exec_ms,
    rows_returned, shared_blks_hit, shared_blks_read
  )
  with ranked as (
    select s.*,
           row_number() over (order by s.total_exec_time desc) as r_total,
           row_number() over (order by s.max_exec_time  desc)  as r_max,
           row_number() over (order by s.mean_exec_time desc)  as r_mean
    from extensions.pg_stat_statements s
    where s.dbid = (select oid from pg_database where datname = current_database())
      and s.queryid is not null
      and s.calls > 0
  )
  select r.queryid,
         left(regexp_replace(r.query, '\s+', ' ', 'g'), 300),
         r.calls, r.total_exec_time, r.mean_exec_time, r.max_exec_time,
         r.rows, r.shared_blks_hit, r.shared_blks_read
  from ranked r
  where r.r_total <= greatest(p_top, 1)
     or r.r_max   <= greatest(p_top, 1)
     or r.r_mean  <= greatest(p_top, 1);

  get diagnostics n = row_count;

  delete from public.pg_stat_statements_snapshots
  where captured_at < now() - interval '90 days';

  return n;
end;
$$;

revoke execute on function public.phx_capture_query_stats(integer) from public, anon, authenticated;
grant execute on function public.phx_capture_query_stats(integer) to service_role;

-- ── what got slower since the previous capture ──────────────────────────────────
create or replace view public.v_slow_query_deltas
with (security_invoker = true) as
with bounds as (
  select max(captured_at) as newest from public.pg_stat_statements_snapshots
),
newest as (
  select s.* from public.pg_stat_statements_snapshots s, bounds b
  where s.captured_at = b.newest
),
previous as (
  select distinct on (s.queryid) s.*
  from public.pg_stat_statements_snapshots s, bounds b
  where s.captured_at < b.newest
  order by s.queryid, s.captured_at desc
)
select
  n.queryid,
  n.query_sample,
  n.captured_at,
  n.calls  - coalesce(p.calls, 0)                        as calls_since,
  round((n.total_exec_ms - coalesce(p.total_exec_ms, 0))::numeric, 1) as total_ms_since,
  round(n.mean_exec_ms::numeric, 1)                      as mean_ms_now,
  round(coalesce(p.mean_exec_ms, n.mean_exec_ms)::numeric, 1) as mean_ms_before,
  round(n.max_exec_ms::numeric)                          as max_ms_now
from newest n
left join previous p on p.queryid = n.queryid
where n.calls > coalesce(p.calls, 0)
order by (n.total_exec_ms - coalesce(p.total_exec_ms, 0)) desc;

comment on view public.v_slow_query_deltas is
  'Per-query work done between the two most recent captures. This is the view that would have surfaced the 17.5s closing call.';

-- ── the audit, as a query anyone can re-run ─────────────────────────────────────
create or replace view public.v_db_health
with (security_invoker = true) as
select
  pg_size_pretty(pg_database_size(current_database()))                                as db_size,
  (select count(*) from pg_namespace
    where nspname ~ '_?[0-9]{8}$' and nspname not in ('public','au'))                  as abandoned_snapshot_schemas,
  (select coalesce(pg_size_pretty(sum(pg_relation_size(s.indexrelid))), '0 bytes')
     from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
    where s.idx_scan = 0 and s.last_idx_scan is null
      and not i.indisprimary and not i.indisunique
      and pg_relation_size(s.indexrelid) >= 1048576)                                  as unused_index_bytes_over_1mb,
  (select count(*) from pg_constraint
    where not convalidated and connamespace = 'public'::regnamespace)                 as not_valid_constraints,
  (select count(*) from pg_constraint con
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index i where i.indrelid = con.conrelid
          and (select array_agg(x order by o)
                 from unnest(string_to_array(i.indkey::text,' ')::smallint[]) with ordinality q(x,o)
                where o <= array_length(con.conkey,1)) @> con.conkey::smallint[]))     as unindexed_foreign_keys,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname = 'public' and not c.relrowsecurity)          as public_tables_without_rls,
  (select round(100.0 * max(age(datfrozenxid)) / 2000000000, 4) from pg_database)      as pct_to_wraparound,
  (select round(100.0 * sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2)
     from pg_statio_user_tables)                                                      as heap_cache_hit_pct;

comment on view public.v_db_health is
  'The 2026-08-10 health audit reduced to one row, so the score is reproducible on demand instead of requiring a manual session.';
