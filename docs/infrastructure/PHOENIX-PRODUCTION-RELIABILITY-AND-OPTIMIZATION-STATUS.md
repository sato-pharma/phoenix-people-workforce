# Phoenix — production reliability and optimisation status

A read-only check made on 28 Oct 2026 between 02:15 and 03:30 Cairo. Nothing was changed, bought, restarted or
migrated, and no `EXPLAIN ANALYZE` was run. Only plain `SELECT` statements, plain `EXPLAIN`, grouped log queries
and single readings of Supabase's metrics endpoint were used. Every claim carries one label:

- **MEASURED**: read from a live system during this check, and the source is named.
- **INFERRED**: reasoned from measurements or from the code, but not observed directly.
- **NOT MEASURED**: no source we can read holds it.

All times are Cairo local (UTC+3 for the whole period). The eight earlier reports in this folder are called
EXEC, BASE, ROAD, VAL, PGA, COST, ARCH and EXT, after their file names; `VAL:243` means line 243 of VAL.

## The recommendation

**Keep Supabase Small for now, and add three things that cost nothing: a Supabase Support ticket filed today, a host
sampler, and one more database fix. Move to Medium on the next working-hours restart, as VAL §11 already says.**
The case is in §10. In short:

- **The restarts are worse than the reports said: 14 between 7 and 25 Oct, not 9, 10 or 11** (§3). Each one is a
  reset of the whole database machine, not a Postgres crash on its own. No restart has happened since 25 Oct 16:14,
  but at the old rate a quiet spell that long would happen by chance about 1 time in 6. So nothing is proven fixed.
- **What causes the resets cannot be read from our side.** The evidence fits a 2 GB machine that runs out of memory,
  swaps until it stops answering, and is then reset by the platform. Only Supabase can confirm it, so §3.5 holds a
  ready Support request.
- **Medium is a 4 GB machine for about $45 more a month.** It removes the memory squeeze if the squeeze is the
  cause. It does not help if the platform is resetting the machine for another reason. The one-week trial costs
  about $10 and can be reversed.

## 1. Verified implementation status

Read live at 02:15–02:40: `origin/main` at `4d3079458` (PR 6620), production `/api/healthz` revision
`4d307945870c…` at 02:21, the production migration ledger, and the worktrees. **MEASURED** unless marked.

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | CRM planning view | **Completed and production verified** | Migration ledger row `20261027224627 crm_plan_door_reads_only_the_rows_it_returns` (01:46). Code PR 6620 merged 02:09 and is the revision production serves (02:21). Measured by the session that built it: 70 % and 77 % fewer pages a call, the same 10,065 rows (ROAD:68-80). |
| 2 | Double Visit Analytics | **Completed and production verified** | PR 6619 merged 02:02, served from 02:10. A read-only request sent to production at 02:13 with the new filter was accepted and returned the same 512 visits for 19–25 Oct as before. One week measured: 9,807 → 3,360 pages, 62 → 38 ms (VAL:249-262). The cut on an average call is NOT MEASURED. |
| 3 | CRM visit view (`crm_visits_unified` as a whole) | **Not started** | Only the Double Visit read of this view was changed. A clean workspace named `codex/crm-visit-checkin-views` exists, made from `main` at 02:09, with no change and no commit in it. Another session may be about to start; this check did not touch it. |
| 4 | CRM check-in view | **Not started** | Same workspace as item 3, empty. PGA:123 leaves it for its own pass. |
| 5 | Source of Sales import search | **Not started** | No commit since 27 Oct touches it. PGA:198 holds it until an approved `EXPLAIN ANALYZE`. |
| 6 | Hidden-tab polling | **Completed and production verified** for the one screen that needed it; **the badge fold is Blocked** | PR 6618 (live 01:48) stops the activity dashboard polling a hidden tab. Every other poller already skipped a hidden tab, or must run while hidden (VAL:38). Folding the sidebar's 11 badge reads into one needs a new database function, which is a migration (VAL:234-241). |
| 7 | Touch-trail retention | **Partially implemented: deployed, nothing is old enough to archive yet** | PR 6608 merged 27 Oct 21:13 and is in the live revision. Its private archive bucket and access policy exist in production, and the archive is empty (0 files at 02:22). The trail keeps 30 days and its oldest day is **3 Oct** (read at 02:42; the table is 992 MB). So the nightly 04:37 run archives **nothing until 2 Nov**, the first night 3 Oct falls outside the window. An empty archive before then is correct, not a failure. **Whether the job is registered on cron-job.org is NOT VERIFIED**: the read-only scheduler check was refused by this session's permission settings. The migration file `20261027175121` has no ledger row, although its bucket and policy exist, so it was applied by another route (INFERRED). Deleted rows free space inside the table for reuse; the file on disk does not shrink. |
| 8 | Application caching | **Completed and production verified**, with Redis **withdrawn** | Roster cache live 26 Oct (PRs 6471 and 6473). The 26 Oct cache audit closed every finding (`docs/production-audits/cache-audit-2026-10-26.md:8-11`). PR 6608's "skip an unchanged contact-list refresh" stamp function exists in production (ledger `20261027174307`). Redis is not built and VAL:182-196 withdrew it. |

**Not repeated:** items 1, 2, 6 and 8 are done. Item 7 needs only its scheduler entry confirmed and its first real
run, on 2 Nov, checked (§9).

## 2. Conflicts between the earlier reports, and how they resolve

| Conflict | Says | Resolved by live data |
| --- | --- | --- |
| Restart count | 9 (EXEC:20, COST:38, VAL:281); 10 (VAL:33, 320, 340); 11 between 12 and 25 Oct (BASE:57, ROAD:46) | **14 between 7 and 25 Oct** (§3.1). The `database_restarts` table starts on 12 Oct and holds 11 rows; the Postgres log adds 7, 10 and 11 Oct. The three restarts PGA:48-50 left unconfirmed (20 Oct 14:11, 22 Oct 11:30 and 12:33) are confirmed by the other services' boot lines in the same minute. |
| Restart window | 11:30–19:04 (BASE:57, PGA:118) against 11:05–19:04 (VAL:33, 106) | 11:05–19:04, with 7 Oct at 15:05 inside it. Two fell on a Saturday (10 and 17 Oct). |
| The decision | Medium now (EXEC:10, COST:45-48, ARCH:26, EXT:52, 223) against keep Small (VAL:13-15) | VAL is the later report, and the owner chose A at about 01:30. This report keeps A and sharpens the trigger (§10). |
| Status claims | "nothing below has been started" (EXEC:6); "only Stage 2a has started" (ROAD:5-6); touch trail "in progress" (PGA:139, ROAD:64) | Stale. PRs 6608, 6618, 6619 and 6620 are merged and live (§1). |
| Visit-view load | 12,527 calls and 43M pages called "the visit view" (PGA:194) | That row is one query shape, the Double Visit read (VAL:249-250). The whole view is larger: 13.9 % of statement time (PGA:98). |
| Request-cut target | "at least 20 %" (ROAD:66, EXEC:64, COST:39) against 15 %, then withdrawn (VAL:83, 171, 284) | Withdrawn. The code already skips hidden tabs; no target is set. |
| Acceptance window and stall size | 5 working days and stalls over 5 s (ROAD:39, 47, 94) against 10 days and over 10 s (VAL:263, 277, 282) | VAL's 10 days and 10 s stand; §4 measures both thresholds. |
| Badge reads | "one read instead of eleven" (COST:81, ROAD:66) against "not done" (VAL:238-239) | Not done; it needs a migration (§1, item 6). |
| Free memory at night | 605 MB (PGA:37) against 863 MB (VAL:30) | Both are single readings at different times. Read again here: **766 MB available at 02:38**. Nothing samples it, which is gap 1 in §4. |
| Cached reads | about 95 (BASE:77) against 35 (VAL:418) | Different counting rules; it changes no decision. |

## 3. Database crash restarts: root-cause findings

### 3.1 The fourteen events (MEASURED, Postgres log and `database_restarts`)

The Postgres start time of each, in Cairo time:

| # | Day | Time | # | Day | Time |
| --- | --- | --- | --- | --- | --- |
| 1 | Wed 7 Oct | 15:05:05 | 8 | Mon 19 Oct | 13:51:27 |
| 2 | Sat 10 Oct | 11:05:48 | 9 | Tue 20 Oct | 14:11:09 |
| 3 | Sun 11 Oct | 13:14:01 | 10 | Thu 22 Oct | 11:30:33 |
| 4 | Mon 12 Oct | 19:04:50 | 11 | Thu 22 Oct | 11:51:25 |
| 5 | Wed 14 Oct | 11:34:32 | 12 | Thu 22 Oct | 12:33:48 |
| 6 | Sat 17 Oct | 12:30:10 | 13 | Thu 22 Oct | 14:25:32 |
| 7 | Sun 18 Oct | 11:54:34 | 14 | Sun 25 Oct | 16:14:29 |

- Logs go back to at least 1 Oct; 1–6 Oct and 8–9 Oct have no restart.
- The current Postgres start time is 25 Oct 16:14:29, so there has been **no restart since**: 58.8 hours at 03:00 on
  28 Oct.
- At the old rate (0.72 a day), 58.8 quiet hours happen by chance about 17 % of the time. **No change is proven yet.**

### 3.2 What the evidence shows

**MEASURED:**

- **Eleven events show the full crash-recovery sequence:** "database system was interrupted", then "not properly
  shut down; automatic recovery in progress", then "redo starts". Re-read here for 7 Oct and 11 Oct.
- **No day from 1 to 27 Oct has any of these lines:** "terminated by signal", "out of memory", "could not fork",
  "remaining connection slots", PANIC, or a fast or smart shutdown. Postgres was never killed in place and never
  asked to stop.
- **Before an event, everything goes quiet together.** On 25 Oct, Supabase's API gateway logged nothing for 85 s from
  16:12:43, and its connection pooler logged nothing for 124 s from 16:12:23. On 20 Oct, all 13 requests in the
  14:10 minute failed, then 536 of 1,398 in the 14:11 minute. On 14 Oct, 158 requests failed between 11:29 and 11:36.
- **The 25 Oct event restarted the whole machine (INFERRED from three MEASURED inputs):** Auth and Postgres started
  within 7 s of each other, the CPU counters agree with that start, and the endpoint's restart counter reads 0.
- **The machine:** 1,932 MB of RAM, 2 CPUs, 1,024 MB of swap.
  - At 02:38 there was 766 MB available, 196 MB of swap in use and 1,877 MB committed, which is 97 % of RAM.
  - Since 25 Oct 16:14, it has written 6,693 MB to swap and read 3,918 MB back, with 2.92 million major page faults
    and 0 out-of-memory kills.
  - At night it barely swaps (two readings 62 s apart: 0 pages out and 0.03 pages a second in). **The swapping
    therefore happens in the daytime (INFERRED).**
- **The root disk is 88 % full:** 1,210 MB free of 9,977 MB. The data disk has 6,532 of 12,058 MB free, and the
  database is 4,309 MB.
- **CPU since the reset:** 20 % busy, steal 0.54 %, I/O wait 0.47 %. The CPU is not the bottleneck.
- **Statement timeouts cluster on restart days:** 14 on 7 Oct, 10 on 10 Oct, 9 on 18 Oct and 32 on 22 Oct, against
  0–2 on a calm day. But 9 Oct had 20 timeouts and no restart.
- **Connections:** 16 of 200 at night, nobody waiting in the pooler, and 0 deadlocks since the reset.

### 3.3 The hypotheses

| Hypothesis | For | Against | Verdict |
| --- | --- | --- | --- |
| **The 2 GB machine runs out of memory, swaps until it stops answering, and the platform resets it** | 97 % of RAM committed even at night; gigabytes of daytime swap; every service silent for 85–124 s, then a whole-machine restart; all 14 in the daytime | No memory-pressure data or kernel log is exported, so the reset's trigger is not seen | **Most likely, not established** |
| A program's memory is pushed out and re-read from the root disk in bursts | The root disk read 61 GB since the reset, but only 3.9 GB of that was swap | Average disk busy time is about 1 %; bursts cannot be seen without pressure data | Plausible, part of the first one |
| Postgres crashes on its own | None | No "terminated by signal" line on any day; the machine restarts, not just Postgres | **Ruled out** |
| One heavy query tips it over | Timeouts cluster on restart days | 9 Oct had 20 timeouts and no restart, and stalls of up to 15 s happen without one | A contributor at most |
| Too many connections | None | 16 of 200 in use; no "remaining connection slots" line | **Unsupported** |
| Lock contention | None | 0 deadlocks; no lock-timeout spike in the log | **Unsupported** |
| A Supabase platform event (maintenance or a host move) | Cannot be excluded from our side | 14 resets in 19 days, all in the daytime, do not look like maintenance | Only Support can rule it out |

### 3.4 What cannot be determined from our side

- What started each reset: the platform's health check, the host, or maintenance.
- The machine's boot time for each event, the kernel log, and memory/CPU/I-O pressure. The metrics endpoint does not
  export them.
- The memory curve in the minutes before each event, because nothing samples the endpoint (gap 1 in §4).
- Why Postgres wrote no startup lines for events 9, 10 and 12.
- What ran just before each event. The query statistics are wiped at each restart, and the last 6-hourly snapshot is
  all that survives.

### 3.5 Supabase Support request (ready to send; holds no credential and no employee data)

> **Subject:** Project ozucdzovmcqvepbozvqf (Small compute) — 14 unplanned database restarts, 7–25 Oct 2026
>
> Our production project restarted 14 times between 7 and 25 October 2026. Each time, Postgres logged "database
> system was interrupted" and "not properly shut down; automatic recovery in progress", with no "terminated by
> signal", out-of-memory or shutdown-request line before it. Before the 25 October event, the API gateway and the
> pooler logged nothing for 85 s and 124 s, and Auth and Postgres then started within 7 s of each other. We read
> this as a reset of the whole instance.
>
> Postgres start times (UTC): 7 Oct 12:05:05 · 10 Oct 08:05:48 · 11 Oct 10:14:01 · 12 Oct 16:04:50 · 14 Oct
> 08:34:32 · 17 Oct 09:30:10 · 18 Oct 08:54:34 · 19 Oct 10:51:27 · 20 Oct 11:11:09 · 22 Oct 08:30:33 · 22 Oct
> 08:51:25 · 22 Oct 09:33:48 · 22 Oct 11:25:32 · 25 Oct 13:14:29. We also saw a 15 s stall with no restart on
> 27 Oct at 17:22 UTC.
>
> On the instance we read 1,932 MB of RAM, 1,877 MB committed, 6.7 GB swapped out in the 58 hours after the last
> event, 0 out-of-memory kills, and a root filesystem 88 % full.
>
> Please tell us, for each event:
> 1. What triggered the restart: a health-check reboot, memory exhaustion on the host, maintenance, or a move to
>    another host.
> 2. The instance's boot time, and the kernel log and memory/CPU/I-O pressure for the 5 minutes before.
> 3. Why Postgres wrote no startup lines for the 20 Oct 11:11, 22 Oct 08:30 and 22 Oct 09:33 events.
>
> And in general:
> 4. Does your health checker reboot an instance that stops answering, and after how long?
> 5. Is swap on the root filesystem, and does its 88 % use matter?
> 6. Was there any compute change or platform event on our project around 7 October?
> 7. Would the Medium (4 GB) tier be expected to stop these restarts, given what you see?
> 8. Can `/customer/v1/privileged/metrics` export the boot time and pressure-stall data?

**Sending it is a message on the company's behalf, so it waits for the owner's word (§8).**

## 4. Monitoring: what exists, the gaps, and a design

### 4.1 What already watches production (MEASURED, `origin/main` at `4d3079458`)

- `/api/healthz` (the deployed revision, no database) and `/api/readyz` (one small read; the release gate).
- **The restart alarm:** `src/lib/observability/database-restart-alert.ts`, run by the 15-minute job-heartbeat
  sweep (`app/api/cron/job-heartbeat-sweep/route.ts`). It writes `database_restarts` and sends a Telegram message.
- **A query-statistics snapshot every 6 hours** (`app/api/cron/db-health-snapshot`, cron-job.org), into
  `pg_stat_statements_snapshots`.
- **A `process_health` line once a minute** in the Railway logs (`src/lib/observability/process-health.ts`). It
  covers the web server only: its event-loop delay, its memory and some route timings.
- A browser page-timing beacon, the read-only synthetic journeys on GitHub, a Healthchecks.io dead-man's switch for
  the cron jobs, and `drainHealth` on the email outbox.
- **Nothing reads the database machine's memory, swap or CPU.** No code calls the metrics endpoint.

### 4.2 Gaps

| Measure | Today | Gap |
| --- | --- | --- |
| Available host memory | Missing | No sampler |
| Swap-in and swap-out rates | Missing | No sampler |
| Major page faults | Missing | No sampler |
| CPU use and CPU steal | Missing (Railway shows the web server only) | No sampler |
| Database restarts | Covered, up to 15 min late | No record of the minutes before |
| API P50, P95 and P99 | Partly: some web routes, in logs, no alarm | No daily figure for Supabase's gateway |
| Query timeouts | Partly: a few routes handle the error | Never counted |
| Supabase 5xx | Partly: only seen through restarts | Never counted |
| Peak working-hours use | Missing: one-off audits only | No daily figure |
| Memory pressure and boot time | Not exported | Only Support can add them (§3.5, question 8) |

### 4.3 Design: two pieces, nothing new to buy

**Piece 1 — a host sampler (fills the first five gaps and the "minutes before" gap).**

- **What it does:** once a minute, read Supabase's metrics endpoint from the server and keep about 15 figures:
  - available memory, swap used, swap-in and swap-out rates, major faults;
  - CPU by mode (including steal) and the load;
  - free space on the root disk and the data disk;
  - the Postgres and Auth start times, so a restart is seen within a minute.
- **Where it runs:** beside the existing once-a-minute `process_health` tick, on the server only, and in one
  process only, so two copies never read at once. The key never reaches a browser, and a non-browser User-Agent is
  sent, because the key refuses a browser one.
- **What it records:**
  - one `db_host` log line a minute;
  - **no new table**, so no migration. A stored history would be a later, separate migration for approval.
- **Its alarm:** Telegram, through the existing path, when available memory stays under 100 MB for 5 minutes (the
  trigger already written in VAL §11), or when the root disk falls under 500 MB free.
- **Its overhead:** one 460 KB request a minute, which took 1.3–1.8 s each time it was read here.
  - That is a small read on the database machine, and no query on Postgres.
  - It is switched off if the database's own load rises while it runs (VAL:313).

**Piece 2 — one daily log summary (fills the API, timeout, 5xx and peak-hour gaps).**

- **What it does:** at 23:30, one grouped query over that day's Supabase gateway and Postgres logs, by hour:
  - requests;
  - P50, P95 and P99 response time;
  - 5xx count;
  - statement timeouts;
  - minutes with three or more requests over 5 s.
- **Where it goes:** a Telegram summary, plus an alarm when the P99 passes 3 s in any working hour, or when there are
  more than 10 timeouts in a day (calm days have 0–2).
- **Its overhead:** it reads Supabase's log store, not the database.
- **Its credential:** the query needs Supabase's management token, which can also change production. So it should
  run where that token already lives today, the laptop's scheduled-task runner, and never in the web app.
  - This is the one design choice that touches a credential, and it is listed in §8.

**What these two pieces answer:** whether low memory and swapping line up, minute by minute, with the slow minutes
and the 5xx bursts. That is the link VAL said was missing.

## 5. Three highest-value remaining optimisations

*(filled in below from the query-statistics check)*

## 6. Expected benefits and cost implications

## 7. Production risks

| Risk | Evidence | Effect if it happens | Guard |
| --- | --- | --- | --- |
| **Another restart under today's load** | MEASURED: 14 in 19 days, all between 11:05 and 19:04; none in the 58.8 hours since 25 Oct | 1–3 minutes of failed requests (603 server errors on 25 Oct; 536 of 1,398 requests in one minute on 20 Oct). All 14 recovered by themselves. | The restart alarm (within 15 minutes). The next working-hours restart fires the move to Medium (§10). |
| **No point-in-time recovery** | MEASURED: 7 daily backups are the whole recovery story | Crash recovery covers a restart. It does not cover a bad bulk change. | No bulk or destructive change without saying so first. Nothing in this report deletes anything. |
| **Root disk 88 % full** | MEASURED: 1,210 MB free of 9,977 MB | NOT MEASURED. If swap or logs live there, a full disk could stop the machine. | Support question 5; the sampler's 500 MB alarm. |
| **The touch-trail deletes begin on 2 Nov at 04:37** | MEASURED: oldest day 3 Oct, 992 MB table | About 95,000–181,000 rows a night leave the table. Clean-up then runs at night on a 2 GB machine. | The job deletes only rows it has read back from storage, named one by one. Two days at most each night. Check on 2 Nov (§9). |
| **The sampler's own cost** | MEASURED: 460 KB a read, 1.3–1.8 s | One request a minute on the web server and a small read on the database machine | Kept outside the request path, with a 10-second limit, no overlap, and a switch to turn it off. |
| **The daily summary's credential** | MEASURED: the log query needs Supabase's management token | Anyone holding it can change production | Never in the web app or a browser. It runs only where the token already lives. |
| **An optimisation changes which rows a role sees** | INFERRED: each one rewrites a view, a function or a query | A manager or rep sees more or fewer rows | Same row count for every role before and after, a role sweep, and a reversal ready before it ships. |
| **Moving to Medium** | Supabase documents a restart on any compute change | A few minutes offline (NOT MEASURED here) | Done outside working hours, announced first, reversed the same way. |
| **Two sessions on one view** | MEASURED: an empty workspace for the visit and check-in views exists | Two versions of one migration | That workspace is left alone. The view work starts only after checking it. |

## 8. Required approvals

Each one is the owner's, one at a time.

1. **Send the Supabase Support request (§3.5).** It is a message on the company's behalf. It is filed from the Supabase
   dashboard's Support page under the owner's account. It holds no credential and no employee data.
2. **Build and deploy the host sampler (§4.3, piece 1).** It is code only: no migration, no new table, one deploy. It
   merges on his word, by number.
3. **The daily log summary (§4.3, piece 2).** Choose where it runs: the laptop's scheduled-task runner, where the
   token already lives, or not at all for now.
4. **Each of the top three (§5).** Every database change is named and approved before it is applied. Each code change
   merges on his word, by number.
5. **Any `EXPLAIN ANALYZE` on production** beyond the runs approved on 28 Oct.
6. **Moving to Medium.** It is a paid change, so it is decided on Supabase's **Project Settings → Compute and Disk**
   screen and never in a chat. This report only sets out when (§10).

## 9. Exact next engineering action

**Build the host sampler, as one pull request:**

- **Where:** a branch `codex/db-host-sampler` from `origin/main`.
- **New file:** `src/lib/observability/db-host-metrics.ts`. It reads Supabase's metrics endpoint once a minute and
  keeps the figures listed in §4.3.
- **Start-up:** from `startProcessHealthReporter` in `src/lib/observability/process-health.ts`, in one process role
  only.
- **Output:** one `db_host` log line a minute, plus a Telegram alarm through the path the restart alarm already uses
  (`src/lib/observability/database-restart-alert.ts`).
- **Off switch:** an environment variable turns it off, with no deploy.
- **Tests:** the parser and the 5-minute rule, registered in `tests/run-tests.ts`.
- **Not touched:** no table, no migration, no access rule, no payroll or CRM logic.
- **Proof after the deploy:** the first ten `db_host` lines in the Railway log, and the database's own load in the
  same minutes compared with the day before.

**Then, with no approval needed:**

- After 04:37 on 2 Nov, read the archive's file count and the oldest day left in the trail. The oldest day should
  move from 3 Oct to 4 Oct.
- Confirm the job is on cron-job.org from its dashboard. The read-only check from this session was refused.

## 10. Final infrastructure decision

**Stay on Supabase Small (Decision A, about $90.50 a month) and buy nothing today.**

1. **Why not Medium tonight:**
   - The database has been quiet for 58.8 hours, though at the old rate that happens by chance 1 time in 6.
   - The cause of the resets is inferred, not confirmed.
   - Medium also leaves the CPU and the volume of requests unchanged.
   - The owner chose A at about 01:30, and nothing measured since contradicts it.
2. **The trigger stays as VAL §11 wrote it, and it is close.** All 14 restarts came in working hours. On the old
   pattern, the next one fires the move to Medium: +$45 a month, or about $10 for a one-week trial.
   - Support's answer can bring that decision forward. If Supabase says the resets come from memory exhaustion,
     Medium is the fix and need not wait for another restart.
   - If Supabase names a platform cause, Medium is not the fix, and the case stays with Supabase.
3. **If Medium is bought, keep it on one condition.** After 14 days, keep it only if swapping has fallen and no
   restart has happened. Otherwise go back to Small the same way: memory was not the cause, and the extra $45 a month
   buys nothing.
4. **Still unsupported:**
   - Redis (VAL §8).
   - Large: nothing measured needs dedicated cores.
   - A read replica.
   - Any host outside Supabase and Railway: it would move employee data to a new processor, with no measured need.
5. **What makes the decision safe either way:** the sampler (§9) and the Support answer (§3.5). Together they turn
   "most likely memory" into a measured yes or no within a week, for $0.
