---
name: the-22-oct-stall-was-four-database-machine-restarts
description: "22 Oct 2026 database stall (212 timeouts, median DB time 2–13 s 13:00–13:40 Cairo) was the production Postgres MACHINE hard-restarting four times (11:30, 11:51, 12:33, 14:25 Cairo) while swapping on 2 GB RAM — not Monthly Closing; heaviest load was the Phoenix CRM unified views."
metadata:
  node_type: memory
  type: project
  originSessionId: e6a04225-ac71-4e9f-b85e-a9de1876a818
  modified: 2026-10-23T00:51:40.418Z
---

Read 23 Oct 2026 ~04:00 Cairo.

- `public.database_restarts` shows 4 whole-instance restarts on 22 Oct (11:30:33, 11:51:25, 12:33:48, 14:25:32 Cairo); PgBouncer, PostgREST and Auth booted in the same second; Postgres logged "not properly shut down", no PANIC/OOM line. Earlier: one a day on 12, 14, 17, 18, 19, 20 Oct.
- Machine since the 14:25 boot: MemTotal 2.03 GB, ~5.1 GB swapped out, ~2.8 GB swapped in, oom_kill 0. Swap thrash → host hang → host reboot is the working theory; WHY the host hangs is Supabase's to explain.
- Load growth calm vs stall (50 min each): auth session bundle 4.3k→11.2k, `crm_visits_unified` 1.8k→5.0k, CRM plan entries / check-ins 4–5×. pg_stat_statements top total time is all CRM unified views. Closing RPCs stayed ≤87 per 10 min (the PR 6165 limiter held).
- Restarts predate the 21–22 Oct CRM feature merges (6226, 6245, 6260…), so those did not start the problem; whether they worsened 22 Oct is not proven.
- Restarts reset visibility maps: `phoenix_crm_touch_trail` 57% all-visible, `ireports360_plan_entries` 74%.

**Why:** a future "the database was slow" question should start at `database_restarts` and swap, not at the busiest feature.
**How to apply:** check restarts + `/proc` swap counters first; see [[a-production-postgres-crash-restart-wears-cloudflare-codes]] and [[a-restart-wipes-table-stats-and-index-only-scans-fall-back-to-the-heap]].
