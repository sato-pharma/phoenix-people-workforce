# Production database load: the 25 Oct 2026 baseline

This is the "before" figure for the 2026-10-25 load audit's fixes. The "after" is re-read from the same view after a full working day, on 26 Oct around 22:00 Cairo.

Read from production (`ozucdzovmcqvepbozvqf`) on **25 Oct 2026 at 23:36 Cairo**. These are the statistics since the 16:14 Cairo restart, about 7 h 22 min. `pg_stat_statements` was not reset, and it never should be for this comparison.

## The box

- Restarts in the 14 days to 25 Oct: **11**, read from `public.database_restarts`. Every one fell between 11:30 and 19:04 Cairo.
- The most recent restart was 25 Oct at 16:14:29 Cairo.
- Memory: 2.03 GB in total, about 530 MB swapped out, and `oom_kill` at 0.

## The top 15 statements by total time

| # | Statement | Calls | Total (s) | Mean (ms) |
| --- | --- | ---: | ---: | ---: |
| 1 | `crm_contact_assignments` page walk, the Reps List company roster (`loadContactRoster`) | 2,371 | 527 | 222 |
| 2 | `select public.crm_agent_crm_ids_reconcile_run()`, the pg_cron job | 30 | 118 | 3,931 |
| 3 | `crm_plan_entries_unified`: `agent_crm_id` read | 425 | 79 | 185 |
| 4 | A PostgREST scalar RPC call | 62 | 66 | 1,065 |
| 5 | `crm_plan_entries_unified`: `agent_crm_id` read, the second shape | 306 | 63 | 206 |
| 6 | `crm_checkins_unified`: `contact_crm_id` read | 1,523 | 59 | 39 |
| 7 | `crm_visits_unified` row read | 1,674 | 57 | 34 |
| 8 | `source_of_sales_import_rows` read | 410 | 40 | 98 |
| 9 | `crm_contact_assignments`: `agent` read | 1,118 | 36 | 33 |
| 10 | A PostgREST set-returning RPC call | 116 | 29 | 249 |
| 11 | `ireports360_plan_entries`: `agent_hr_id` lookup, the contact sync (`loadCrmContactSyncTargets`) | 124 | 28 | 229 |
| 12 | `crm_checkins_unified`: `contact_crm_id` read, the second shape | 313 | 26 | 84 |
| 13 | `source_of_sales_import_rows` read, the second shape | 452 | 26 | 58 |
| 14 | `select public.phoenix_crm_rep_entry_days_reconcile_run()` | 89 | 23 | 254 |
| 15 | `employees` name read | 644 | 22 | 33 |

## What each fix should move

- **Row 1** should fall to a handful of calls. Each one becomes a single `phx_crm_contact_roster()` call of about 180 ms, held in the shared read cache. That comes with PR 6473.
- **Row 11** should disappear, replaced by `phx_crm_agent_crm_ids_by_hr(text[])` on two index-only scans. That also comes with PR 6473.
- **Row 2** should fall to one run an hour, about 7 a working day instead of about 30. That comes from `20261026000000_crm_agent_crm_ids_reconcile_hourly.sql`, live on production since 25 Oct at 23:39 Cairo. Each run also got lighter: since 25 Oct at 23:41 Cairo the reconcile reads the CRM visits once per run instead of twice (`20261025030000_crm_agent_crm_ids_reconcile_single_pass.sql`, from another session’s PR 6471, live in the database before that PR merges).
- **The restart count** is the figure that matters. If restarts continue once the load has fallen, the remaining lever is the compute class. That is decided on Supabase → Project Settings → Compute and Disk.

## Deeper fixes, live on production since 25 Oct at 23:54 Cairo

These come from `20261026010000_db_load_sweep_skipscan_and_indexes.sql`. Each index was built with `create index concurrently` before the file was applied, so no write lock landed on a working table. Every figure below is `explain (analyze, buffers)` on production with the caller’s exact query, before and after.

| Read | Who calls it | Before | After |
| --- | --- | ---: | ---: |
| The attribution freshness sweep’s list of months (`au.f_refresh_stale_attribution_periods`) | the attribution scheduler | 264 ms, 8,353 buffers | 16 ms, 1,479 buffers |
| Withdrawing a notification by key prefix (`event_key like …%`) | `withdrawInAppNotificationsByEventKeyPrefix` | 92 ms mean, 103,592 blocks read from disk | 1.7 ms, 207 buffers |
| The Master Map change probe (newest active customer-map row) | `src/lib/sales/master-map/fingerprint.ts`, every five minutes | 54 ms mean | 0.18 ms, 4 buffers |
| The stale CRM sync run reaper (`status = running`) | `reapStaleIReports360SyncRuns` | 36 ms mean, 22,226 blocks read | 0.1 ms, 2 buffers |
| The live poller’s deep-run read | `readDeepRunMarkers` | 11.9 ms mean | 1.0 ms, 111 buffers |

- **The sweep returns the same months.** On production the old and new lists were both the 11 months 2026-01 to 2026-11, with none on only one side. Everything after the list is the 29 Sep body unchanged. That includes the exclusion of published months, which reads `monthly_closing_publications`, never the locks.
- **The probe must stay `cross join lateral (… limit 1)`.** Written as a plain `exists`, the planner turns it back into a read of the whole sales rollup, and the 264 ms returns with every result still correct. `tests/db-load-sweep-skipscan.test.ts` refuses that.

### Not fixed in this pass, on purpose

- **The CRM sync’s freshness read** (`getLatestSuccessfulSyncRunFor`, 38 calls, 21 ms mean) stays a 10.7 ms whole-table read. 48,139 of the run log’s 48,182 rows are successes, so the planner rightly reads the table rather than an index, and the read is only a fallback.
- **The import-row reads** (rows 8 and 13) filter on a leading-wildcard `ilike %…%`, which an ordinary index cannot answer.
- **The CRM check-in view reads** (rows 6 and 12) need a change to the `crm_checkins_unified` view itself, which belongs in its own pass.
- **The hourly contact-master refresh** (row 4, about 1.1 s) is already tuned.

## How to re-read it

```sql
select now(), (select stats_reset from pg_stat_statements_info),
  (select count(*) from public.database_restarts where postmaster_start_at > now() - interval '14 days'),
  (select json_agg(t) from (select left(regexp_replace(query, '\s+', ' ', 'g'), 110) q, calls,
     round(total_exec_time / 1000) total_s, round(mean_exec_time) mean_ms
   from pg_stat_statements order by total_exec_time desc limit 15) t);
```

A restart resets `pg_stat_statements`, so compare the rates (calls and seconds per hour since `stats_reset`), not the raw totals.
