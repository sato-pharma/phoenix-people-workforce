---
name: the-25-oct-restart-was-the-2gb-box-swapping-again
description: "Prod DB restarts (11 in 14 days to 25 Oct, all working hours) are the 2 GB compute box hanging under load — not a Postgres crash; lowering work_mem is NOT the lever (zero temp spill)."
metadata:
  node_type: memory
  type: project
  originSessionId: 6c55ac05-7a8e-4bd0-b489-b353be8a0999
  modified: 2026-10-25T21:13:21.001Z
---

25 Oct 2026 16:14:29 Cairo restart, read from `public.database_restarts` and the logs: every service on the box
(Postgres, PgBouncer, PostgREST, Auth) went silent for ~105 s from 16:12:42, the poolers came back BEFORE
Postgres, and Postgres logged "not properly shut down; automatic recovery" with no PANIC and no OOM line —
the host hung and was rebooted. Same signature as [[a-production-postgres-crash-restart-wears-cloudflare-codes]]
and [[the-22-oct-stall-was-four-database-machine-restarts]].

Live metrics that evening (`/customer/v1/privileged/metrics`, service-role key): MemTotal 2.03 GB, ~530 MB
swapped out in 7 quiet hours, oom_kill 0. Restarts 12–25 Oct: 11, every one 11:30–19:04 Cairo — load-driven.

**Lowering `work_mem` (32 MB, see [[disk-io-temp-spill-workmem]]) is NOT the lever:** pg_stat_statements since
the restart shows 0 MB temp on every top query, and work_mem is a ceiling, not a reservation — cutting it
only brings the July disk spill back.

The top load since the restart: `loadContactRoster` (src/lib/crm/reps-list.ts) — every rep opened on the Reps
List reads the WHOLE company's 13,095 open assignments as 14 parallel 1,000-row pages (2,357 page reads,
222 ms mean, in 7 h ≈ 168 full reads). Then the 15-minute `crm_agent_crm_ids_reconcile_run` cron (4 s mean,
9.7 s max).

Owner chose (25 Oct ~23:40 Cairo) to cache the roster: PR 6471, commit 60757512b, puts it through
`getOrLoadShared` (namespace `crm:contact-roster`, dropped by `bustListSummaries`). Re-read
pg_stat_statements after it deploys to see the roster page reads fall.

The reconcile is lighter twice over since that evening: it reads `_calc()` ONCE per run (migration
`20261025030000`, live on production 23:41 Cairo, PR 6471 — EXPLAIN had shown two Function Scans plus a
third through `_rebuild()`), and a parallel session's PR 6474 moved its job from every 15 minutes to
hourly at minute 7 (`20261026000000`, also already live). Measure the new mean from pg_stat_statements.
Its global `stats_reset` still reads the 16:14 Cairo restart (read 26 Oct 00:05 Cairo), so compare RATES per
hour since then, never raw totals.

Second pass, live 25 Oct 23:54 Cairo (PR 6474, `20261026010000`): the attribution sweep skip-scans its months
(264 → 16 ms a call) and four indexes stop four polled whole-table reads — the notification prefix withdraw
(92 → 1.7 ms), the Master Map change probe (54 → 0.18 ms), the sync-run reaper (36 → 0.1 ms), the deep-run
read (11.9 → 1.0 ms). Numbers in `docs/perf/2026-10-25-db-load-baseline.md`.

Interim read, 26 Oct 00:12 Cairo (PRs 6473 and 6474 merged 00:09 and 00:11, neither serving yet): the first
hourly reconcile under the single-pass body ran at 00:07 in 833 ms (its pg_stat_statements entry restarted at
1 call; the old 30-call, 3.9 s mean entry is gone). Roster page reads still 2,371, unchanged since 23:36 because
nobody opens the Reps List at night. 0 restarts since 16:14. The real after-check is 26 Oct 20:07 Cairo.

**Why:** the real fix is a bigger compute class — a money decision on Supabase → Project Settings → Compute
and Disk, never offered as chat words.
**How to apply:** never propose a work_mem cut for the restarts; the load lever Claude can pull is the roster
fan-out.
