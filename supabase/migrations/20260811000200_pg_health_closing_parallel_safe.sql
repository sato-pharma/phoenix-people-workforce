-- Closing / analytics read latency, from the 2026-08-10 production Postgres health audit.
--
-- phx_closing_channel_totals was the slowest thing in the database: 17,483 ms worst case,
-- 4.4-8.4 s mean across its three call shapes. Two independent causes, neither of them
-- the query text:
--
-- 1. PARALLEL UNSAFE. Every one of these functions is a read-only STABLE reporter, but
--    none declared a parallel mode, and PostgreSQL's default for CREATE FUNCTION is
--    UNSAFE — which forbids the planner from putting the call in a parallel plan at all.
--    204 functions in `public` carry that default. Only the 13 verified read-only
--    reporters are changed here; each was checked to contain no INSERT/UPDATE/DELETE/
--    TRUNCATE/DDL/nextval before being marked. (phx_fold_customer_name and
--    phx_normalize_arabic, which they call, were already SAFE and IMMUTABLE.)
--
-- 2. A missing index behind the `names` CTE — see the companion index below. It runs
--    DISTINCT ON (period, distributor_code, client_code) ORDER BY ..., latest_row_created_at
--    DESC, while the only supporting index led with client_code, so 205k rows were sorted
--    on every single call.
--
-- Measured on production, CNS across 7 periods with the real channel stems:
--   before                       12,781 ms
--   + directory DISTINCT index    8,958 ms
--   + PARALLEL SAFE + 2 workers   (see migration result)
-- Output is byte-identical throughout: 35 rows, 95,062,107.01 EGP.

-- ── 1. the index the DISTINCT ON always wanted ──────────────────────────────────
-- Leads with the SAME expression the CTE filters on, lower(btrim(official_line)), then
-- carries the DISTINCT ON key in order. A first attempt led with `period` and was never
-- chosen once this one existed (0 scans against 23) -- it was dropped rather than left
-- to rot, which is the mistake this whole audit was cleaning up after.
-- (Created CONCURRENTLY on production ahead of this migration; IF NOT EXISTS makes this
--  a no-op there and correct everywhere else.)
create index if not exists sos_customer_directory_rollup_line_distinct_idx
  on public.source_of_sales_customer_directory_rollup
  (lower(btrim(official_line)), period, distributor_code, client_code, latest_row_created_at desc);

-- ── 1b. statistics for the expression the planner was blind to ──────────────────
-- The retail and direct CTEs both filter on lower(btrim(official_line)), which no index
-- covered, so the planner had no selectivity data and guessed: it estimated 273 rows
-- where 72,914 came back (267x), and picked sort/merge plans that ground for seconds.
-- An expression index is what makes ANALYZE collect statistics on that expression -- the
-- estimate is now 26,934 vs 72,914 (2.7x) and the plan switched to HashAggregate.
-- sos_rows_line_period_idx shows few scans by design: it is carried for the statistics
-- it produces, not for the rows it fetches.
create index if not exists sos_fact_rollup_line_period_idx
  on public.source_of_sales_fact_rollup (lower(btrim(official_line)), period);
create index if not exists sos_rows_line_period_idx
  on public.source_of_sales_import_rows (lower(btrim(official_line)), invoice_period);

analyze public.source_of_sales_fact_rollup;
analyze public.source_of_sales_import_rows;
analyze public.source_of_sales_customer_directory_rollup;

-- ── 2. let the planner parallelise the read-only reporters ──────────────────────
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.provolatile in ('s','i')          -- never mark a VOLATILE function
      and p.proparallel = 'u'
      and p.proname in (
        'phx_closing_channel_totals','phx_closing_channel_breakdown','phx_closing_brick',
        'phx_closing_customers','phx_closing_corrections','phx_closing_distributor_product',
        'phx_closing_publication_drift','phx_closing_publication_snapshot',
        'analytics_sos_by_area','analytics_sos_by_customer','analytics_sos_by_line',
        'analytics_sos_by_period','analytics_sos_by_product'
      )
      -- belt and braces: refuse anything whose body can write
      and p.prosrc !~* '\m(insert|update|delete|truncate|create|drop|alter|nextval|setval|grant|revoke)\M'
  loop
    execute format('alter function %s parallel safe', r.sig);
  end loop;
end $$;

-- ── 3. give a gather node more than one worker ──────────────────────────────────
-- Was 1, so even a parallel-safe plan could only ever recruit a single helper.
-- Bounded by max_parallel_workers = 2, so this cannot oversubscribe the instance.
do $$
begin
  execute format('alter database %I set max_parallel_workers_per_gather = 2', current_database());
end $$;
