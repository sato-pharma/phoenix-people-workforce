---
name: public-functions-are-parallel-unsafe-by-default
description: "~200 public functions are PARALLEL UNSAFE (Postgres' default), and expression predicates like lower(btrim(col)) leave the planner with no statistics"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-13T20:20:17.724Z
---

Two planner traps that together made the monthly closing call take 12.8s. Both are invisible
in the SQL — the query text looks fine.

**1. `PARALLEL UNSAFE` is the default nobody chose.** `CREATE FUNCTION` without a parallel
marking gets `PARALLEL UNSAFE`, which forbids the planner from using the function in a parallel
plan at all. Measured 2026-08-10: **204 functions in `public`** carried it. PR #1992 marked only
the 13 read-only reporters (`phx_closing_*`, `analytics_sos_*`) `PARALLEL SAFE`.
Never mark one without checking `provolatile in ('s','i')` and that the body has no
INSERT/UPDATE/DELETE/DDL/nextval. (`phx_fold_customer_name` and `phx_normalize_arabic` were
already SAFE + IMMUTABLE.)

**CORRECTION 2026-08-14 — do NOT treat this as a free win. Measured twice, it bought ~nothing
both times.** PR #2099 marked the whole `au` sales-vs-target chain SAFE (18 functions) and
`phx_sales_vs_target_range` went 873–929 ms → 874 ms: identical buffers, identical output,
unchanged plan. `au.f_monthly_attribution` went 479 → 435 ms, i.e. noise. Parallelism was NOT
the blocker and this was verified, not assumed: on the same backend a plain
`count(*), sum(total_qty)` over `source_of_sales_fact_rollup` plans **and launches 2 workers**
(Parallel Seq Scan, 90 ms), and `max_parallel_workers_per_gather` reads `2 / source=database`.
The attribution query simply does not want a parallel plan — its period filter narrows the scan
to ~3,210 buffers vs 7,434 for the whole table, under what `parallel_setup_cost = 1000` pays
for, and most of the remaining time is plpgsql per-row work, not a scannable aggregate.
**So mark functions SAFE for correctness (one UNSAFE leaf forces the whole tree serial forever),
never as a performance plan. Get the plan first.**

**2. An expression predicate has NO statistics until an expression index exists.**
`where lower(btrim(official_line)) = …` had no covering index, so the planner guessed:
estimated **273 rows where 72,914 came back — 267x** — and chose sort/merge plans that ground
for seconds. Adding `(lower(btrim(official_line)), period)` indexes + `ANALYZE` cut it to 2.7x
and the plan switched to HashAggregate. `sos_rows_line_period_idx` shows ~0 scans **by design**
— it is carried for the statistics ANALYZE derives from it, not for rows fetched. Do not
"clean it up" as an unused index.

**3. A SET clause blocks inlining.** Adding `SET search_path` to a SQL function makes it
non-inlinable. That's why `phx_fold_customer_name` deliberately keeps a mutable search_path
despite the advisor warning — it's IMMUTABLE, SECURITY INVOKER, unreachable by anon/authenticated,
and now evaluated 72,914x per closing call.

**4. `ALTER DATABASE … SET` does not reach existing pooler backends.** Settings bind when a
server backend connects. Supavisor hands out backends established earlier — PostgREST connections
here sat idle up to 12 days — so `SHOW` keeps returning the old value and the change lands only
as connections recycle. It is applied correctly; check `pg_db_role_setting`, not `SHOW`.

**Why:** each looked like "the query is just heavy". None of them were.

**How to apply:** when a reporting RPC is slow, check `proparallel` and expression-predicate
statistics BEFORE rewriting any SQL. See also [[every-db-round-trip-crosses-the-atlantic]].
