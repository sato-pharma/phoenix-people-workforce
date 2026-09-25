---
name: supabase-blocks-slow-query-logging-gucs
description: "Supabase blocks log_min_duration_statement and track_io_timing by BOTH routes; the in-DB pg_stat_statements snapshot is the workaround"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-10T02:58:41.509Z
---

**You cannot turn on slow-query logging on this project. Both routes are blocked — verified
live 2026-08-10, don't spend time rediscovering it.**

- `supabase --experimental postgres-config update --config log_min_duration_statement=1000`
  → **HTTP 400 `Unrecognized keys: "log_min_duration_statement", "track_io_timing"`**.
  The config API only accepts a small allowlist (this project overrides `max_connections=200`).
- `ALTER DATABASE postgres SET log_min_duration_statement = …` → silently refused, the setting
  never appears in `pg_db_role_setting`. Both are superuser-context GUCs and the `postgres`
  role is not superuser here.

Consequence: a query ran **17.5s, 192 times, and nothing anywhere reported it**. `auto_explain`
IS already on at `log_min_duration = 10000`, so only >10s queries leave any trace, and that
trace lives in log retention, not anywhere queryable.

**How it's covered now (PR #1992, merged 2026-08-10):** `public.phx_capture_query_stats(top)`
snapshots `pg_stat_statements` into `public.pg_stat_statements_snapshots`, driven by
`/api/cron/db-health-snapshot` (schedule it on **cron-job.org**, see
[[cron-job-org-is-the-real-production-scheduler]]). Read `public.v_slow_query_deltas` for what
did the most work between the two most recent captures; `public.v_db_health` reproduces the
whole audit in one row.

**Why the capture ranks on three axes and must keep doing so:** the first version ranked only by
cumulative `total_exec_time` and could not see the very query it existed to catch — something
slow *per call* has a small cumulative total until it has already done damage, so it never
enters a top-50 list headed by PostgREST queries with 6,917s. It now takes the union of top-N
by `total_exec_time`, `max_exec_time` AND `mean_exec_time`. Don't "simplify" that back.

There is still **no I/O attribution** (`track_io_timing` off), so `shared_blks_*` counts are
available but not the time spent on them.

**Why:** two independent blocked routes look like a mistake on the third attempt; they aren't.

**How to apply:** never promise the owner slow-query logs. Point at `v_slow_query_deltas`
instead, and treat the absence of I/O timing as permanent unless Supabase changes the allowlist.
