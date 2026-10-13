---
name: a-production-postgres-crash-restart-wears-cloudflare-codes
description: "The 521/520/525 bursts are the production Postgres CRASH-RESTARTING, not a Cloudflare flap — twice in three days (10 Oct 11:05:48, 12 Oct 19:04:50 Cairo), each 'not properly shut down' with no shutdown request and no PANIC; confirm it with pg_postmaster_start_time() and cron.job_run_details' `server restarted`, never with the edge status codes."
metadata:
  node_type: memory
  type: project
  originSessionId: 7227dfbc-9a64-48b5-a8d0-94f28cee391e
  modified: 2026-10-13T01:55:17.637Z
---

Reported 2026-10-12 as "a 38-second Supabase edge outage, 79 requests failed". The edge codes verify
exactly — in `edge_logs`, **19:04:41–19:05:19 Cairo: 38 × 521, 32 × 503, 7 × 520, 2 × 525 = 79**,
across 13 / 10 / 3 distinct REST paths. 🔴 **But the edge is not where it broke. The production
Postgres crash-restarted, and the Cloudflare codes are what an edge serves when its origin is gone.**

**The three reads that prove a crash-restart, and the one that cannot.**

1. `postgres_logs` at the moment: `starting PostgreSQL 17.6` · `database system was interrupted; last
   known up at 2026-10-12 16:03:20 UTC` · **`database system was not properly shut down; automatic
   recovery in progress`** · `redo starts at …` · then 11 × `the database system is not accepting
   connections` (19:04:51–19:04:52). **No `received fast shutdown`, no PANIC, no out-of-memory line** —
   the postmaster was killed from outside the process, not asked to stop.
2. `select pg_postmaster_start_time()` — **live, and the cheapest test there is.** It read
   `2026-10-12 19:04:50` Cairo, so the restart is a fact and nothing has restarted since.
3. `cron.job_run_details` records it as a job failure with `return_message = 'server restarted'` —
   that is how the 10 Oct event is still provable days later (jobid 1, runid 289, 11:05:00).
4. 🔴 **`app_error_events` cannot size it** — 17 rows in the whole hour, none of them a 5xx. The 79
   failures are `edge_logs` only, and the status key is **`log_attributes['response.status_code']`**
   (`status_code` alone is empty, and the 503s carry
   `response.headers.proxy_status = 'PostgREST; error=PGRST002'`).

**Both occurrences are the same event, three days apart:** 10 Oct **11:05:48** and 12 Oct **19:04:50**
Cairo, each unclean, each self-recovered in well under a minute. The project reads `ACTIVE_HEALTHY`
afterwards, so project status disproves nothing.

**The box it happens on.** `shared_buffers` 512 MB, `effective_cache_size` 1 GB, `work_mem` 32 MB,
`maintenance_work_mem` 128 MB, `max_worker_processes` 6, `max_connections` 200 — a **2 GB** compute
class, carrying a **3.19 GB** database. Live connections at the time: 17 of 200. Neither connection
count nor CPU is the pressure; memory is the only candidate the settings leave open, and a host-level
kill is exactly what "not properly shut down with no PANIC" looks like.

**What already rides it out, and what cannot.** PR 5736 holds the session through it — measured on
the two events: 10 Oct 11:00–11:30 had **22 logins and 9 born-dead sessions**; 12 Oct 19:00–19:30 had
**5 logins, 0 born dead, 1 revoked**, with one `session_verification_unavailable` row, which is PR
5736's own new branch firing. PR 5737's transport retry covers 521/525 at **200/400/800 ms** — about
1.4 s of budget against a **38 s** outage, so in-flight reads still fail and that is deliberate: a
retry long enough to ride a restart would freeze every page for the length of the restart. 🔴 **Do not
"fix" this by lengthening the retry.**

🔴 **THE ALARM ALREADY EXISTS — DO NOT BUILD A SECOND ONE** (his decision, 13 Oct 2026: build the
restart alarm and draft the Supabase ticket). `runDatabaseRestartCheck()` rides the 15-minute
`job-heartbeat-sweep` clock as a third independent watch, over
`public.note_database_restart()` (migration `20261013150001`), so **there is no new cron job and no
cron-job.org entry to look for.** Two things about it are deliberate and must not be "tidied":
its **idempotency key is the postmaster start time, not the Cairo day** — two restarts in one day
have to be two messages, which is the whole pattern — and it sends **no email**, because it can fire
because the database holding the outbox is unreachable. The migration **seeds** the current start
time so installing it does not fire it, and a new start time with nothing on record is a
`first-sighting` that only logs. Pinned by `tests/database-restart-watch.test.ts`.

Related: [[a-supabase-blip-signs-everyone-out]] · [[a-supabase-stall-costs-a-minute-not-15-seconds]] ·
[[production-supabase-has-no-pitr-only-daily-backups]] · [[a-200-from-a-health-endpoint-can-be-blind]]
