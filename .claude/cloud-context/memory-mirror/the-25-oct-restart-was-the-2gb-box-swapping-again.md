---
name: the-25-oct-restart-was-the-2gb-box-swapping-again
description: "Prod DB restarts (11 in 14 days to 25 Oct, all working hours) are the 2 GB compute box hanging under load — not a Postgres crash; lowering work_mem is NOT the lever (zero temp spill)."
metadata:
  node_type: memory
  type: project
  originSessionId: 6c55ac05-7a8e-4bd0-b489-b353be8a0999
  modified: 2026-10-25T20:18:24.596Z
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

**Why:** the real fix is a bigger compute class — a money decision on Supabase → Project Settings → Compute
and Disk, never offered as chat words.
**How to apply:** never propose a work_mem cut for the restarts; the load lever Claude can pull is the roster
fan-out.
