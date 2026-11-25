---
name: a-database-restart-can-be-a-compute-resize
description: "A production database restart can be a compute-size change, not a crash — compare the worker's db_host cpuCount and memTotalMb before and after the restart FIRST; both 25 Nov 2026 restarts (17:33 up to 4 cores/16 GB, 18:59 back to 2 cores/4 GB) were resizes that two sessions misread."
metadata:
  node_type: memory
  type: project
  originSessionId: dacf88c9-3dc6-4464-9325-c560dec156f8
  modified: 2026-11-25T19:30:25.313Z
---

On 25 Nov 2026 production restarted twice. Both were compute-size changes the OWNER made himself on
the Supabase screen (confirmed in chat, 25 Nov 2026: "Yes, I did") — not faults:

- 17:33:04 Cairo: pgbouncer "got SIGINT", Postgres "terminating connection due to administrator
  command" (a clean shutdown), back 17:34:03. `db_host` read cpuCount 2 / memTotalMb 3,864 before
  and cpuCount 4 / memTotalMb 15,635 after. Supabase's own `@supabase-infra/mgmt-api` health-checked
  the project 16 s before, and `@supabase-infra/worker` re-PUT the storage and realtime tenants 2 s
  after it came back (storage_logs / realtime_logs).
- 18:59:43 Cairo: back to cpuCount 2 / memTotalMb 3,864. A session had read this one as "killed from
  outside, same fault as 10 and 12 October" and proposed a Supabase support ticket.
- Before 17:33 the 2-core machine ran at 87–96% user CPU, load up to 6.96 (from about 17:27).

**Why:** a resize looks exactly like an outage in app_error_events (timeouts, "Session verification
unavailable"), and postgres_logs alone cannot say who stopped it.

**How to apply:** for any production restart, read the worker's `db_host` lines either side
(`railway logs <deployment> -s phoenix-workforce-worker -e production --since … --until … | grep db_host`)
and compare `cpuCount` / `memTotalMb` before blaming Supabase or writing a ticket. Who pressed it is
not visible from Phoenix — only the Supabase dashboard (or the owner) can say. The compute size is a
money decision made on the Supabase screen, never in chat. Related: [[a-supabase-blip-signs-everyone-out]].
