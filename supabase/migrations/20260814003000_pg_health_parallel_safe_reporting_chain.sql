-- Sales-vs-target read latency. Found by the db-health snapshot cron, not by a person:
-- with phx_closing_channel_totals fixed (migration 20260811000200), the new heaviest
-- consumer in pg_stat_statements became phx_sales_vs_target_range at 1,214 ms mean /
-- 7,044 ms max over 156 calls in a single 6-hour window.
--
-- This is the same defect as 20260811000200 -- PARALLEL UNSAFE, PostgreSQL's default for
-- CREATE FUNCTION -- but one level deeper, which is why the earlier migration missed it.
-- phx_sales_vs_target_range is a thin wrapper; the work happens in `au`:
--
--   phx_sales_vs_target_range
--     -> au.f_sales_vs_target_range          (loops once per month in the range)
--       -> au.f_monthly_achievement          746 ms per month, measured
--         -> au.f_monthly_attribution        479 ms  <- 64% of the cost
--         -> au.f_line_area_map_asof           3 ms
--         -> au.f_seat_occupant_asof          12 ms total (300 calls, 2 per map row)
--
-- Marking only the public wrapper would have achieved nothing: a plan is parallel-safe
-- only if EVERY function it references is, so one UNSAFE leaf anywhere in that tree keeps
-- the whole thing serial. All five links plus the rest of the `au` read-only reporting
-- family are marked together for that reason.
--
-- Measured cost shape on production (Jul 2026, warm cache, all shared_hit / zero read --
-- this is CPU-bound work, not an I/O or missing-index problem, so no index can help it):
--   1 month  (Jul)      762 ms,  965 rows
--   2 months (Jul-Aug)  929 ms, 1,634 rows
-- i.e. ~762 ms fixed + ~167 ms per additional month. The range is capped at 24 months,
-- so the ceiling is roughly 4.5-6.5 s as history accumulates -- worth fixing, but NOT the
-- 18 s that a naive linear reading of the per-month loop would predict.
--
-- What this migration deliberately does NOT do: touch au.f_monthly_attribution's logic.
-- That function is where 64% of the time goes, but it is the SoS attribution engine and
-- carries the Office allocation golden rule. Changing PARALLEL marking is a planner hint
-- with no effect on results; rewriting the attribution query is a separate, owner-approved
-- task. Every function below was verified STABLE, non-writing, and free of temp tables,
-- cursors, sequences, advisory locks, dblink and set_config before being listed. The four
-- VOLATILE seat-mutation functions (hire_into_seat, resign_occupant, transfer_occupant,
-- sync_area_state_for_seat) are excluded and must stay UNSAFE.
--
-- MEASURED RESULT ON PRODUCTION: NO SPEEDUP. Read this before assuming otherwise.
--   phx_sales_vs_target_range('2026-07','2026-08')  before 929 / 873 / 881 ms
--                                                    after  874 ms
--   au.f_monthly_attribution('2026-07')              before 479 ms -> after 435 ms
-- Identical buffer counts (6,022) and identical output (1,634 rows, 123,751.996 units,
-- 10,676,588.67 EGP actual), so the plan did not change.
--
-- Parallelism is NOT the thing that was missing, and this was verified rather than assumed:
-- a plain `select count(*), sum(total_qty) from source_of_sales_fact_rollup` on the same
-- backend plans and launches 2 workers with a Parallel Seq Scan (90 ms), so the capability
-- is live -- max_parallel_workers_per_gather = 2 reads source=database, and the earlier
-- ALTER DATABASE has reached these backends. The attribution query simply does not want a
-- parallel plan: its period filter narrows the scan to ~3,210 buffers against 7,434 for the
-- whole table, which is under what parallel_setup_cost = 1000 will pay for, and much of the
-- remaining time is plpgsql per-row work rather than a scannable aggregate.
--
-- So this migration is kept for correctness, not for speed. It removes a real blocker --
-- one UNSAFE leaf forces the entire tree serial forever, so no future plan in this family
-- could ever have used a worker -- and it brings `au` in line with what 20260811000200
-- already did for the public closing family. The actual 435 ms lives inside
-- au.f_monthly_attribution's own body and needs a query rewrite, which is deliberately out
-- of scope here because that function carries the Office allocation golden rule.
--
-- Reversible in one statement: alter function <sig> parallel unsafe.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind = 'f'
      and p.provolatile in ('s','i')          -- never mark a VOLATILE function
      and p.proparallel = 'u'                 -- only touch what still carries the default
      and (
        (n.nspname = 'au' and p.proname in (
          -- the sales-vs-target chain
          'f_sales_vs_target_range','f_monthly_achievement','f_monthly_attribution',
          'f_line_area_map_asof','f_seat_occupant_asof',
          -- the rest of the au read-only reporting family, same risk profile
          'f_monthly_attribution_reconcile','f_last_occupied_seat_by_hr_id',
          'f_line_area_occupancy_drift','f_sales_area_trend','f_sales_brick_detail',
          'f_sales_direct_breakdown','f_sales_source_breakdown',
          'f_sales_source_breakdown_detail','f_sales_source_breakdown_line',
          'f_sales_source_files'
        ))
        or
        (n.nspname = 'public' and p.proname in (
          'phx_sales_vs_target_range','phx_monthly_attribution','phx_monthly_closing_matrix'
        ))
      )
      -- belt and braces: refuse anything whose body can write or change session state
      and p.prosrc !~* '\m(insert|update|delete|truncate|create|drop|alter|nextval|setval|grant|revoke)\M'
      and p.prosrc !~* '\m(pg_advisory|set_config|dblink)\M'
  loop
    execute format('alter function %s parallel safe', r.sig);
  end loop;
end $$;

-- ── the one foreign key that lost its covering index ────────────────────────────
-- Flagged by public.v_db_health, which had read 0 unindexed FKs since 20260811000100
-- and went to 1. expense_claims.employee_hr_id -> employees.hr_id is ON DELETE RESTRICT,
-- so without this every employee delete seq-scans expense_claims to prove no rows point
-- at the row being removed.
--
-- Plain CREATE INDEX rather than CONCURRENTLY on purpose: the table is 432 kB, so the
-- build is sub-millisecond and the brief SHARE lock is not worth the cost of a migration
-- that cannot run inside a transaction block.
create index if not exists expense_claims_employee_hr_id_idx
  on public.expense_claims (employee_hr_id);
