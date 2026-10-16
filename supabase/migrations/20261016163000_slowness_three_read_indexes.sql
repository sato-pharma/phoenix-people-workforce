-- Three indexes for the three slow reads the 2026-10-16 slowness audit could fix with an index alone.
--
-- Measured on production from pg_stat_statements over the 2.2 days since its 14 Oct reset, each with an
-- EXPLAIN (ANALYZE, BUFFERS) on staging before and after:
--
-- (a) CHECK-INS BY CONTACT. The Reps List reads `crm_checkins_unified` by `contact_crm_id = any(50 ids)`
--     ordered by check_date (3,610 calls, 127 ms mean). No index LEADS with contact_crm_id, so the plan
--     walked the whole (agent_crm_id, contact_crm_id, check_date) index: 783 ms for 1,638 rows on
--     production, 1,127 of 2,526 buffers from disk. Staging: 31.6 ms -> 10.2 ms warm.
--
-- (b) DEPARTED AGENTS' CRM IDS. `phx_crm_agent_crm_ids_for_hr_ids` (449 calls, 519 ms mean, 5.5 s max)
--     needs only agent_crm_id for each agent_hr_id, but the existing (agent_hr_id, visit_date) index
--     sends it to the heap for every visit — 52,708 rows across 18,850 blocks. INCLUDE (agent_crm_id)
--     makes it an index-only scan: staging 670 ms cold / 265 ms warm -> 163 ms, buffers 22,256 -> 4,204.
--     `ireports360_visits_agent_idx` is left in place: it is now redundant, and it is dropped only once
--     this one is seen in use.
--
-- (c) A MONTH'S VALIDATED SALES ROWS BY BATCH. `phx_sos_geo_aggregates_without_restricted` (92 calls,
--     1,049 ms mean) bitmap-scans `source_of_sales_import_rows` for one month's validated batches —
--     44,591 rows across 8,862 blocks, 6,908 from disk. A partial covering index answers it from the
--     index alone: staging 480 ms -> 165 ms warm, buffers 8,714 -> 1,742. About 40 MB on production.
--
-- No figure changes: an index changes how a row is found, never which rows a query returns.
--
-- CREATED CONCURRENTLY ON PRODUCTION FIRST, by hand, so the write lock a plain CREATE INDEX takes never
-- landed on the CRM sync or a sales import. CONCURRENTLY cannot run inside a transaction and migrations
-- do, so the statements below are the plain form guarded by IF NOT EXISTS: a no-op where the index is
-- already there, and correct for staging and for any database rebuilt from migrations.

create index if not exists perf_ireports360_checkins_contact_crm_id_check_date
  on public.ireports360_checkins (contact_crm_id, check_date);

create index if not exists perf_ireports360_visits_agent_hr_id_visit_date_crm
  on public.ireports360_visits (agent_hr_id, visit_date)
  include (agent_crm_id);

create index if not exists perf_source_of_sales_import_rows_batch_id_valid_geo
  on public.source_of_sales_import_rows (batch_id)
  include (product_code, region_code, region_name, area_code, area_name, brick_id, official_line, qty, bonus_qty, value)
  where validation_state = 'valid';
