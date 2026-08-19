-- Speed up phx_territory_area_pharmacies by giving its (area, period) filter a matching index.
--
-- The territory drill-down (fetchTerritoryAreaPharmacies -> src/lib/sales/territory/pharmacies.ts)
-- calls this RPC with ONE area, one line, and a ~6-month period window, to render one area's
-- brick -> pharmacy -> month breakdown. The function filters
-- source_of_sales_customer_directory_rollup (205,871 rows / 74 MB heap on prod) by:
--     upper(btrim(coalesce(area_code, ''))) = <area>   AND   period = any(<periods>)
--
-- area_code is the ONLY selective predicate (one area ~= 2% of the table), but nothing could serve
-- it: the sole area index (sos_customer_directory_rollup_geo_idx) LEADS with region_code, which the
-- query never constrains, and the predicate wraps area_code in upper(btrim(coalesce(...))) which no
-- plain-column index matches. period is non-selective (6 of 7 periods), so sos_..._period_idx is
-- correctly ignored. The planner therefore PARALLEL SEQ SCANS the entire 74 MB rollup on every call
-- -- ~80,000 rows scanned to keep ~3,900. Measured on prod (area AB5 / line CNS / 6 months):
-- 440 ms warm, and a 3.26 s mean in pg_stat_statements (the same scan reading the 74 MB heap cold
-- from disk).
--
-- This EXPRESSION index matches the predicate exactly -- (upper(btrim(coalesce(area_code,''))),
-- period) -- so the planner switches to a Bitmap Index Scan on the one selective column. An index
-- cannot change query output; the function body is untouched and returns byte-identical rows.
-- Proven on staging (Phoenix-HR-Staging, cifwmndunmlxjhyjugxa, 148,727 rows) with the same
-- AB5 / CNS / 5-month call: Parallel Seq Scan (67,827 rows scanned, 589 ms cold) -> Bitmap Index
-- Scan on this index (8,028 matched, 1,760 heap blocks, 64 ms) -- a ~9x drop, plan-verified.
--
-- ANALYZE after creating: an EXPRESSION index only gets planner statistics from ANALYZE, without
-- which the planner may misestimate its selectivity and skip it.
--
-- Bound lock acquisition and execution so a busy production table fails safe instead of blocking
-- imports indefinitely. On prod this index is hand-applied CREATE INDEX CONCURRENTLY (no write lock
-- on this read-heavy, import-written table); the IF NOT EXISTS below then makes this migration a
-- no-op there, while staging / CI replay builds it plainly.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists sos_customer_directory_rollup_area_period_idx
  on public.source_of_sales_customer_directory_rollup (upper(btrim(coalesce(area_code, ''))), period);

analyze public.source_of_sales_customer_directory_rollup;

reset statement_timeout;
reset lock_timeout;
