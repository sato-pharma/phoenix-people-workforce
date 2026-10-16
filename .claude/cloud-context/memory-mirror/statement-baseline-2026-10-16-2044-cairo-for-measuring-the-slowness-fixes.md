---
name: statement-baseline-2026-10-16-2044-cairo-for-measuring-the-slowness-fixes
description: "A FULL pg_stat_statements baseline (4,048 statements) was saved on production at 2026-10-16 20:44:38 Cairo, after the day's slowness fixes - measure \"what is slow now\" as the delta against it, never from the cumulative stats, which still carry the pre-fix calls."
metadata:
  node_type: memory
  type: project
  originSessionId: 5152d26a-b08d-4c64-a4fc-78dbaae7e534
  modified: 2026-10-16T17:45:06.422Z
---

**What it is.** `select public.phx_capture_query_stats(100000)` was run on production (`ozucdzovmcqvepbozvqf`) at **2026-10-16 17:44:38.016421+00 (20:44:38 Cairo)**. The scheduled capture (cron route `db-health-snapshot`, every 6 hours at :17 past 00/06/12/18 Cairo) keeps only ~100 statements, the top 50 on each of total, max and mean time. This one kept ALL 4,048: 3,717,818 calls and 14,102,260 ms in total. Rows live in `public.pg_stat_statements_snapshots` and are pruned after 90 days (about 2027-01-14).

**Why.** The slowness audit's list was stale for 3 of its first 4 items: `phx_crm_agent_crm_ids_for_hr_ids`, `phx_closing_brick` and `phx_sos_geo_aggregates_without_restricted` had already been fixed by #5998's indexes and price-once change, and `au_v_org_tree` runs in 1.9 ms (the 3.7 s trace was a frozen web server). `pg_stat_statements` is cumulative since its reset (2026-10-14 11:34 Cairo), so its means and maxima still hold the pre-fix calls.

**How to use it.** Compare live statistics with the baseline; this lists what is slow in the calls made AFTER the fixes (run it any time, and check `extensions.pg_stat_statements_info.stats_reset` has not moved past the baseline, or the deltas are meaningless):

```sql
with b as (select queryid, calls, total_exec_ms from public.pg_stat_statements_snapshots
           where captured_at = timestamptz '2026-10-16 17:44:38.016421+00')
select left(regexp_replace(s.query,'\s+',' ','g'),120) as query,
       s.calls - coalesce(b.calls,0) as calls_since,
       round((s.total_exec_time - coalesce(b.total_exec_ms,0))::numeric) as ms_since,
       round(((s.total_exec_time - coalesce(b.total_exec_ms,0)) / nullif(s.calls - coalesce(b.calls,0),0))::numeric,1) as mean_ms_since
from extensions.pg_stat_statements s left join b on b.queryid = s.queryid
where s.dbid = (select oid from pg_database where datname = current_database())
  and s.calls > coalesce(b.calls,0)
order by ms_since desc limit 25;
```

Use `order by mean_ms_since desc` for the per-call slow ones, and ignore rows with few calls. The built-in `v_slow_query_deltas` compares only the two newest captures, so after the 00:17 capture it also shows the window since this baseline for the statements in that capture.

**Caveats.** `pg_stat_statements.max` is 5,000 and 4,047 were in use, so a busy week can evict entries; a statement missing from the baseline reads as all-new. A database restart also resets the counters (as on 10-12 Oct). Related: [[a-restart-wipes-table-stats-and-index-only-scans-fall-back-to-the-heap]], [[pg-stat-statements-times-precisely-and-attributes-never]], [[supabase-blocks-slow-query-logging-gucs]].
