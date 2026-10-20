---
name: a-production-postgres-crash-restart-wears-cloudflare-codes
description: "The 521/520/525 bursts are the WHOLE DATABASE INSTANCE being hard-restarted, not a Cloudflare flap and not a Postgres crash — three days running (10 Oct 11:05:48, 11 Oct 13:14:01, 12 Oct 19:04:50 Cairo), each 'not properly shut down' with no shutdown request and no PANIC, and PgBouncer/PostgREST/GoTrue all booting in the same second BEFORE the postmaster; confirm it with pg_postmaster_start_time() and the sidecars' own boot lines, never with the edge status codes. CORRECTED 2026-10-16: the hourly recovery.take_snapshots() was NOT cleared — the 10 Oct restart landed 48 s into its 11:05 run, and its 36-50 s runs (8, 11, 14 Oct at :05) were database-wide stalls; it now streams a fingerprint (20261016103901). ADDED 2026-10-19: SEVEN restarts by then (10, 11, 12, 14, 17, 18, 19 Oct, all 11:05-19:05 Cairo, none at night); before each, EVERY service on the box (PgBouncer, PostgREST, Auth, Postgres) goes silent for 30-70 s at once, then all restart — the machine hung and was rebooted, consistent with the 2 GB box swapping (node_vmstat_pswpout 1.75 GB on 19 Oct 16:30 Cairo, boot time not exported, oom_kill 0); read it from /customer/v1/privileged/metrics."
metadata:
  node_type: memory
  type: project
  originSessionId: 7227dfbc-9a64-48b5-a8d0-94f28cee391e
  modified: 2026-10-19T13:10:54.077Z
---

Reported 2026-10-12 as "a 38-second Supabase edge outage, 79 requests failed". The edge codes verify
exactly — in `edge_logs`, **19:04:41–19:05:19 Cairo: 38 × 521, 32 × 503, 7 × 520, 2 × 525 = 79**,
across 13 / 10 / 3 distinct REST paths. 🔴 **But the edge is not where it broke. The production
Postgres crash-restarted, and the Cloudflare codes are what an edge serves when its origin is gone.**

**The reads that prove it, the one that is decisive, and the one that cannot size it.**

1. `postgres_logs` at the moment: `starting PostgreSQL 17.6` · `database system was interrupted; last
   known up at 2026-10-12 16:03:20 UTC` · **`database system was not properly shut down; automatic
   recovery in progress`** · `redo starts at …` · then 11 × `the database system is not accepting
   connections` (19:04:51–19:04:52). **No `received fast shutdown`, no PANIC, no out-of-memory line** —
   the postmaster was killed from outside the process, not asked to stop. Severity sweep of the whole
   day: the only non-LOG lines are application `ERROR`s and the 11 `FATAL … not accepting connections`
   from the restart itself.
2. 🔴 **THE DECISIVE READ — THE SIDECARS. `postgres_logs` ALONE CANNOT TELL A POSTGRES CRASH FROM A
   WHOLE-INSTANCE KILL, AND THIS IS THE WHOLE-INSTANCE KILL.** Ask `pgbouncer_logs` /
   `postgrest_logs` / `auth_logs` for `%process up:%`, `Starting PostgREST%` and `%Go runtime
   metrics%` in a 60-second window around the restart. **All three boot together, and PgBouncer and
   PostgREST come up BEFORE the postmaster** — so PostgREST then logs `connection to server at
   "localhost" … refused`, `PGRST000`, `PGRST002` and serves 503s until Postgres is ready, which is
   the 503 half of the edge burst. Measured on all three days: 12 Oct PgBouncer 16:04:48.86 /
   PostgREST 16:04:49.05 / postmaster 16:04:50.37 · 11 Oct 10:14:00.58 / 10:14:00.66 / 10:14:01.84 ·
   10 Oct 08:05:46.77 / 08:05:46.80 / 08:05:48.19 (UTC). **An OOM-killed or PANICking postmaster
   leaves those three processes alive and reconnecting; it does not restart them.** The binary string
   is byte-identical on all three days (`PostgreSQL 17.6 on x86_64-pc-linux-gnu, compiled by gcc
   (GCC) 15.2.0, 64-bit`), so **a Postgres version upgrade is ruled out** as well.
3. `select pg_postmaster_start_time()` — **live, and the cheapest test there is.** It read
   `2026-10-12 19:04:50` Cairo, so the restart is a fact and nothing has restarted since.
4. `cron.job_run_details` records it as a job failure with `return_message = 'server restarted'` —
   that is how the 10 Oct event is still provable days later (jobid 1, runid 289, 11:05:00).
5. 🔴 **`app_error_events` cannot size it** — 17 rows in the whole hour, none of them a 5xx. The 79
   failures are `edge_logs` only, and the status key is **`log_attributes['response.status_code']`**
   (`status_code` alone is empty, and the 503s carry
   `response.headers.proxy_status = 'PostgREST; error=PGRST002'`).

🔴 **IT IS THREE DAYS RUNNING, NOT TWICE — AND THE MIDDLE ONE WAS INVISIBLE UNTIL SOMEONE ASKED FOR
IT.** 10 Oct **11:05:48**, 11 Oct **13:14:01**, 12 Oct **19:04:50** Cairo, each unclean, each
self-recovered in well under a minute, nothing restarted since. The 11 Oct event produced no report
because nobody was looking at that minute: **count the restarts from the logs, never from the
incidents that got reported.** `query_logs` takes a **24-hour window at most**, so a multi-day sweep
is one query per day — `starting PostgreSQL%` is the cheap needle. The clock times are unrelated
(11:05 / 13:14 / 19:04 Cairo), so **it is not a maintenance window** either. The project reads
`ACTIVE_HEALTHY` afterwards, so project status disproves nothing.

🔴 **AND THEREFORE THE CAUSE IS NOT PROVABLE FROM INSIDE THE DATABASE — STOP LOOKING FOR IT THERE.**
🔴 **CORRECTION, 2026-10-16 — THE HOURLY SNAPSHOT WAS CLEARED ON THE WRONG EVIDENCE.** The durations
below are the runs that FINISHED. The 10 Oct 11:05 run never did: the restart at 11:05:48 killed it
48 s in (`cron.job_run_details` runid 289, `server restarted`), so it has no duration to be quiet
about. And on days with no restart the same job ran 50.4 s (8 Oct 16:05), 36.1 s (11 Oct 13:05) and
45.2 s (14 Oct 17:05), each the minute production stalled — edge requests collapsing, PGRST001,
renders timing out (React #441, #412, PGRST002 in the Error Monitor). It was building
`monthly_closing_locks` (28.5 MB) as JSON and casting it to text twice every hour on the 2 GB
compute. That does not prove it caused the host-level restarts, which stay Supabase's to explain;
it does mean "every in-house suspect is exonerated" was false. The check is now a streamed
fingerprint that builds nothing on an unchanged hour (migration `20261016103901`, first production
run 2.1 s against 5.5 s). Account: `docs/security/recovery-snapshots.md`, "The streamed fingerprint".

What follows is the original reading. Every in-house suspect is exonerated by evidence, not by assumption: `cron.job_run_details` shows the
three jobs at 3.4–9.8 s with the 19:05 run starting *after* the restart; `edge_logs` requests/min were
**falling** into it (2480, 2313, 2112, 936, 646, 1600, 2021, 652 over 15:56–16:03 UTC, then 59 with
58 × 5xx at 16:04); connections were 17 of 200; there is no OOM, PANIC, `signal 9` or
`crash of another server process` line anywhere. What is left is the host, and the only in-house
candidate the settings leave open is memory pressure on the **2 GB** compute class. **Supabase's own
host-side record is the only thing that can settle it** — which is exactly what his 13 Oct decision
(the support ticket) already covers.

**The box it happens on.** `shared_buffers` 512 MB, `effective_cache_size` 1 GB, `work_mem` 32 MB,
`maintenance_work_mem` 128 MB, `max_worker_processes` 6, `max_connections` 200 — a **2 GB** compute
class, carrying a **3.19 GB** database. Live connections at the time: 17 of 200. Neither connection
count nor CPU is the pressure; memory is the only candidate the settings leave open, and a host-level
kill is exactly what "not properly shut down with no PANIC" looks like.

**What already rides it out, and what cannot.** PR 5736 holds the session through it — measured on
two of the three: 10 Oct 11:00–11:30 had **22 logins and 9 born-dead sessions**; 12 Oct 19:00–19:30 had
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
