---
name: a-restart-wipes-table-stats-and-index-only-scans-fall-back-to-the-heap
description: "After the production database restarts, big read-mostly tables show n_live_tup 1 and are never vacuumed, so their visibility map stays half-empty and an \"Index Only Scan\" still does thousands of heap fetches - `VACUUM (ANALYZE)` on the table fixed it (source_of_sales_import_rows 77% to 100% visible, 3,828 to 1,373 buffers, 205 to 164 ms)."
metadata:
  node_type: memory
  type: reference
  originSessionId: 5152d26a-b08d-4c64-a4fc-78dbaae7e534
  modified: 2026-10-16T17:39:28.659Z
---

On 2026-10-16 `phx_sos_geo_aggregates_without_restricted` still took ~205 ms with every buffer cached, after a covering index had been added. The plan showed `Index Only Scan ... Heap Fetches: 6190`: only 76.6% of `source_of_sales_import_rows`' pages were marked all-visible, and `pg_stat_user_tables` read `n_live_tup = 1`, `last_autovacuum null`. The production database was hard-restarted on 10, 11 and 12 Oct, which resets the stats counters, so autovacuum thinks a 400,000-row table is tiny and never triggers on an insert-only table.

`vacuum (analyze) public.source_of_sales_import_rows;` ran through `supabase-production` `execute_sql` in seconds (no lock on reads or writes) and set the table to 100% visible with correct stats.

**Why:** an index-only scan is only index-only for pages the visibility map vouches for.

**How to apply:** when an index-only scan shows `Heap Fetches` in the thousands, read `relallvisible / relpages` from `pg_class` before designing anything. Same survey on 2026-10-16 found `audit_logs` 71%, `ireports360_checkins` 73%, `activity_events` 37%, `notification_events` 38%, `weekly_sales_rows` 66% (`n_live_tup` 1) and `ireports360_plan_entries` 88% under 90%; at his word ("vacuum the six large tables the survey found") all six got `VACUUM (ANALYZE)` at 20:38 Cairo and read 100% visible with real row counts afterwards. A later restart will wipe the counters again, so re-run the survey (`relallvisible/relpages` under 0.9 on tables over 3,000 pages) rather than assuming it holds. Related: [[n-live-tup-is-stale-use-real-count]], [[a-production-postgres-crash-restart-wears-cloudflare-codes]].
