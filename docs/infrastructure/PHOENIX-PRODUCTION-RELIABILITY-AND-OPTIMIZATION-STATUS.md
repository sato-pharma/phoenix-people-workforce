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

**Keep Supabase Small for now, and add three things that cost nothing: a Supabase Support request filed today, a host
sampler, and three code-only read cuts. Move to Medium on the next working-hours restart, as VAL §11 already says.**
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
| 1 | CRM planning view | **Completed and production verified** | Migration ledger row `20261027224627 crm_plan_door_reads_only_the_rows_it_returns` (01:46). Code PR 6620 merged 02:09 and is the revision production serves (02:21). Measured when it was built: 70 % and 77 % fewer pages a call, the same 10,065 rows (ROAD:68-80). |
| 2 | Double Visit Analytics | **Completed and production verified** | PR 6619 merged 02:02, served from 02:10. A read-only request sent to production at 02:13 with the new filter was accepted and returned the same 512 visits for 19–25 Oct as before. One week measured: 9,807 → 3,360 pages, 62 → 38 ms (VAL:249-262). The cut on an average call is NOT MEASURED. |
| 3 | CRM visit view (`crm_visits_unified` as a whole) | **Not started** | Only the Double Visit read of this view was changed. A clean workspace named `codex/crm-visit-checkin-views` exists, made from `main` at 02:09, with no change and no commit in it. Other work may be about to start there; this check did not touch it. |
| 4 | CRM check-in view | **Not started** | Same workspace as item 3, empty. PGA:123 leaves it for its own pass. |
| 5 | Source of Sales import search | **Not started** | No commit since 27 Oct touches it. PGA:198 holds it until an approved `EXPLAIN ANALYZE`. |
| 6 | Hidden-tab polling | **Completed and production verified** for the one screen that needed it; **the badge fold is Blocked** | PR 6618 (live 01:48) stops the activity dashboard polling a hidden tab. Every other poller already skipped a hidden tab, or must run while hidden (VAL:38). Folding the sidebar's 11 badge reads into one needs a new database function, which is a migration (VAL:234-241). |
| 7 | Touch-trail retention | **Partially implemented: deployed, nothing is old enough to archive yet** | PR 6608 merged 27 Oct 21:13 and is in the live revision. Its private archive bucket and access policy exist in production, and the archive is empty (0 files at 02:22). The trail keeps 30 days and its oldest day is **3 Oct** (read at 02:42; the table is 992 MB). So the nightly 04:37 run archives **nothing until 2 Nov**, the first night 3 Oct falls outside the window. An empty archive before then is correct, not a failure. **Whether the job is registered on cron-job.org is NOT VERIFIED**: the read-only scheduler check was refused by this machine's permission settings. The migration file `20261027175121` has no ledger row, although its bucket and policy exist, so it was applied by another route (INFERRED). Deleted rows free space inside the table for reuse; the file on disk does not shrink. |
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

**How they were chosen.**

- **Source:** Postgres's own statement statistics, from the 25 Oct 16:14 restart to 28 Oct 02:21. That is about 58
  hours, with 11,333 s of execution in all. Each figure below was re-read for this report (MEASURED).
- **The plans:** plain `EXPLAIN` only, which gives estimates. Nothing was timed with `EXPLAIN ANALYZE`.
- **The code:** read on `origin/main` at `d0bc1682d`.
- **The filter:** every pick passes all seven of the brief's tests. In particular, none changes a business rule, an
  access rule, a table or a cache lifetime the owner has not already chosen. None needs a migration, and none costs
  money.
- **The one bigger item:** the Source of Sales import search costs more than any of the three. It is set out after
  them because its fix is not designed yet and will most likely need a migration.

### 5.1 The doctor-list summaries read

1. **Code location:** `getRepListSummaries` in `src/lib/crm/contact-lists.ts`.
   - Its page size is 1,000 (line 44).
   - The function starts at line 311, and its offset pages are at line 328.
   - It sits inside a 300-second `unstable_cache` (line 340).
2. **Measured bottleneck:**
   - **This is the largest single reader of database pages: 8.9 % of all page reads.** That is 61.9M pages, or 9,487
     a call, over 6,522 calls at 31.0 ms on average (202 s in all).
   - The table `crm_contact_assignments` is only 4 MB, with 25,663 rows of which 13,354 are open. It took 103M page
     hits in the window.
3. **Root cause:**
   - Each build counts the open rows, then reads 14 pages at once, each by offset (`.range(n·1000, …)`) in `id` order.
   - An offset makes Postgres walk past every earlier row and throw it away. So page 14 walks about 14,000 rows to
     return 1,000, and one build walks about 258,000 rows in all (INFERRED from the row counts).
   - Plain `EXPLAIN` of page 14: cost 1,074–1,096. The same page read as an `id` range: 0.29–92.5, about 12 times
     lower.
4. **Exact change:**
   - Keep the exact count, both "open only" filters, the cache and its 300 seconds unchanged.
   - Read the table's lowest and highest `id` (two one-row reads on the primary key).
   - Cut that span into as many `id` ranges as there are pages.
   - Read each range with the house helpers already in use: `keysetRanges` and `fetchAllRowsKeyset` in
     `src/lib/supabase/paginated.ts`, the pattern of `src/lib/sales/normalizer/customer-suggest.ts`.
   - Join the ranges in order, so rows still arrive in `id` order.
   - Requests go from 15 to about 23 a build, but each one walks only its own range. Fixed ranges also cannot skip
     or repeat a row that changes mid-build, as an offset can (20,928 updates in the window).
5. **Expected improvement (INFERRED):**
   - About 80–90 % fewer pages on this read, which is about 50M pages over 58 hours, and most of its 202 s.
   - **How to measure:** compare the new read's pages per call in the statement statistics with today's 9,487.
     Before shipping, one approved `EXPLAIN (ANALYZE, BUFFERS)` of page 14 in both forms gives the real figure.
6. **Regression tests:** `tests/crm-contact-lists.test.ts:565-615`.
   - Kept: the cache, the two filters, the parallel read and the exact count.
   - One line changes: the `id` order becomes the `id` cursor.
   - New assertions: no `.range(`, and `keysetRanges(` and `fetchAllRowsKeyset(` are both present.
   - Proven by putting `.range(` back and watching the new assertion fail.
   - Plus a same-output check: one rep's list summaries read both ways return identical rows.
7. **Rollback:** revert the commit. No data or table changes.

### 5.2 Check-in pins on every Phoenix CRM list load

1. **Code location:**
   - `loadObservedPointsFor` in `src/lib/crm/shared-customers.ts:159`, called on every list load from
     `src/lib/phoenix-crm/server/list.ts:1457`.
   - It calls `loadCheckins` in `src/lib/crm/reps-list.ts:460`, which already reads in keyset pages.
2. **Measured bottleneck:**
   - 8,496 calls at 31.2 ms on average, up to 1,466 ms: 265.5 s in all.
   - **3.3 % of all reads from disk:** 27 disk reads a call, about 232,000 in all.
   - The check-ins table is 80 MB but took 614,787 disk reads. It keeps falling out of memory and being read back in,
     which is the memory pressure of §3 seen from the database's side.
3. **Root cause:**
   - The plan is sound: an index scan on contact and day.
   - The waste is repetition. Every list load reads every check-in for the same doctors again, from disk, to work out
     one pin per doctor, and nothing is kept between loads.
4. **Exact change:**
   - Wrap only the worked-out pins (one small row per doctor) in the existing in-process cache, `getOrLoadShared` in
     `src/lib/cache/shared-read.ts`.
   - Key it on the sorted list of doctor ids, and keep it for the 60 seconds the owner already chose for display reads
     on 16 Oct. That cache holds nothing that decides money, an approval or a notification.
   - The pattern to copy is `loadBrickNames` in `src/lib/crm/brick-geo.ts`.
   - `loadCheckins` itself is not changed, and neither is its other caller.
   - **Access is not loosened (INFERRED from the code).** The pins depend only on the doctor ids asked for, and those
     ids come from the list the caller is already allowed to see. A cache hit therefore needs the same ids. The
     iReports360-only rule, which keeps a Phoenix visit's position off a rep's screen, stays in the read. The cache
     lives in the web server's own memory and never leaves it.
5. **Expected improvement: NOT MEASURED.**
   - It depends on how often one list is reopened within a minute, and nothing records that.
   - The same read is shared with the old reps' board, so the list's share of the 265.5 s cannot be split out.
   - **How to measure:** this read's calls per working hour before and after, from the statement statistics. The cache
     also reports a hit or a miss on every read, which can be counted in the log.
6. **Regression tests:** in `tests/shared-read-cache.test.ts`, assert that:
   - `loadObservedPointsFor` uses `getOrLoadShared(` and `sharedReadKey(`;
   - the cached value is a list, not a `Map`, because a `Map` does not survive the cache.
   - `tests/portal-rep-navigation-speed.test.ts` stays green unchanged.
   - Proven by removing the wrapper and watching the new assertion fail.
7. **Rollback:** revert the commit. Nothing is stored outside the process.

### 5.3 The validated-places board

1. **Code location:** `loadValidatedPlaces` in `src/lib/phoenix-crm/server/validation-reviews.ts:868`. It reads
   every page through `readEveryPage` (line 870), ordered by `created_at` then `id`, with a 10,000-row cap
   (line 885).
2. **Measured bottleneck:**
   - 1,440 calls at 80.8 ms on average, up to 795 ms: 116.4 s in all.
   - The table has 4,178 rows of about 1.8 KB each, and 22 columns are read.
3. **Root cause:**
   - No index covers `created_at`.
   - So each of a load's ~5 page reads scans the whole table and sorts it in memory, only to return 1,000 rows.
     Plain `EXPLAIN` of page 4: a full scan and a sort, cost 1,298–1,300.
4. **Exact change, kept inside the module's rule** (`.claude/rules/phoenix-crm-place-checks.md:37`: every read on this
   page goes through `readEveryPage`):
   - Keep `readEveryPage`, the "active" filter, the seat scope and the cap.
   - Order the database read by `id` alone, which walks the primary key with no sort and no full scan.
   - Then sort the rows in code by `created_at` then `id`, so the board shows exactly the same order.
   - **One caveat:** if a seat ever passed 10,000 active places, the cap would keep an arbitrary 10,000 rather than the
     newest. Today the whole table holds 4,178, so today's output is unchanged. A log warning at the cap would make
     that visible.
5. **Expected improvement (INFERRED from plain EXPLAIN):**
   - About half of this read's 116 s.
   - A cursor read would save about three-quarters, but it would change the module's rule, so it is not proposed.
   - **How to measure:** this read's mean time in the statement statistics, before and after.
6. **Regression tests:**
   - `tests/phoenix-crm-place-checks-in-overflow.test.ts:102-115` and `tests/phoenix-crm-refuse-validation.test.ts:88-93`
     stay as they are.
   - New assertions: the read orders by `id` descending; there is no `created_at` order in the query; and there is a
     sort in code on `created_at`.
   - Proven by putting the old order back and watching the new assertion fail.
7. **Rollback:** revert the commit.

### 5.4 The larger item that needs a decision first: the Source of Sales import search

- **Where:** `readImportRowsFrom` in `src/lib/sales/monthly-closing-details.ts:432`.
- **What it costs (MEASURED):** two read shapes, 2,599 calls at 97 ms and 4,060 calls at 50 ms. That is **455 s and
  15.8 % of all disk reads**, the largest disk cost on the database.
- **What we know:**
  - Each page is a seek on batch and row number with a text match on the line.
  - The page also works out the invoice reference from each row's stored original file row.
  - Which of those two causes the disk reads is not known.
- **What is ruled out:**
  - Caching: the rows changed 949 times in the window, and this read is the Monthly Closing's own source.
  - Changing which rows it returns: the Monthly Closing is the one sales truth and stays exactly as it is.
- **What it needs:**
  1. One `EXPLAIN (ANALYZE, BUFFERS)` of one page. It takes about 0.1 s, run after working hours with a 20-second
     limit.
  2. Then, most likely, a migration (an index, or a stored invoice reference), named and approved before it is
     applied.

## 6. Expected benefits and cost implications

| Change | Expected benefit | Label | Monthly cost |
| --- | --- | --- | ---: |
| 5.1 Doctor-list summaries | About 50M fewer page reads in 58 hours (80–90 % of the largest page reader) | INFERRED | $0 |
| 5.2 Check-in pins | Fewer of the check-in table's disk reads (3.3 % of all disk reads today) | NOT MEASURED | $0 |
| 5.3 Validated-places board | About 58 s fewer in 58 hours | INFERRED | $0 |
| 5.4 Import search | Up to 15.8 % of all disk reads, once a fix is designed | NOT MEASURED | $0 (one migration) |
| Host sampler (§4.3) | Shows whether memory and swapping line up with the stalls | — | $0, but see the transfer note below |
| Daily log summary (§4.3) | Daily P50/P95/P99, 5xx, timeouts and peak hours | — | $0 |
| Supabase Support request | The cause of the resets, from the only party that can see it | — | $0 |
| Medium, kept | Twice the memory. It stops the restarts only if memory is the cause, and leaves CPU and request volume unchanged. | INFERRED | +$45 (≈ $90.50 → ≈ $135.50 in all) |
| Medium, one-week trial | The same, reversible | INFERRED | ≈ $10 once |

**What the three cuts do for the restarts:**

- They make the daytime database lighter. 5.1 removes a large share of the page work. 5.2 and 5.4 attack the disk
  reads that a short-of-memory machine keeps repeating.
- **They are not shown to stop the restarts**, and no number is promised. A lighter database leaves more of the 2 GB
  for the cache, which should mean less swapping (INFERRED). The sampler is what will show it.
- Together, 5.1–5.3 touch about 584 s of the 11,333 s measured (5 %) and about 10 % of all page reads. Adding 5.4 makes it
  1,039 s (9 %) and about 19 % of all disk reads.

**The sampler's data transfer:**

- Each reading of the metrics endpoint was 460 KB. Once a minute, that is about 660 MB a day, or about 20 GB a month,
  before compression.
- Supabase's Pro plan includes 250 GB of transfer a month, but this project's current use was not read. Whether this
  endpoint's traffic counts toward the allowance is NOT MEASURED.
- So the sampler asks for a compressed reply, and its real size on the wire is checked on the day it ships. If it is
  still large, it reads every 2 minutes instead.

## 7. Production risks

| Risk | Evidence | Effect if it happens | Guard |
| --- | --- | --- | --- |
| **Another restart under today's load** | MEASURED: 14 in 19 days, all between 11:05 and 19:04; none in the 58.8 hours since 25 Oct | 1–3 minutes of failed requests (603 server errors on 25 Oct; 536 of 1,398 requests in one minute on 20 Oct). All 14 recovered by themselves. | The restart alarm (within 15 minutes). The next working-hours restart fires the move to Medium (§10). |
| **No point-in-time recovery** | MEASURED: 7 daily backups are the whole recovery story | Crash recovery covers a restart. It does not cover a bad bulk change. | No bulk or destructive change without saying so first. Nothing in this report deletes anything. |
| **Root disk 88 % full** | MEASURED: 1,210 MB free of 9,977 MB | NOT MEASURED. If swap or logs live there, a full disk could stop the machine. | Support question 5; the sampler's 500 MB alarm. |
| **The touch-trail deletes begin on 2 Nov at 04:37** | MEASURED: oldest day 3 Oct, 992 MB table | About 95,000–181,000 rows a night leave the table. Clean-up then runs at night on a 2 GB machine. | The job deletes only rows it has read back from storage, named one by one. Two days at most each night. Check on 2 Nov (§9). |
| **The sampler's own cost** | MEASURED: 460 KB a read, 1.3–1.8 s | One request a minute on the web server, a small read on the database machine, and about 20 GB of transfer a month before compression (§6) | Kept outside the request path, with a 10-second limit, no overlap, and a switch to turn it off. It asks for a compressed reply, its size on the wire is checked on day one, and it falls back to every 2 minutes. |
| **The daily summary's credential** | MEASURED: the log query needs Supabase's management token | Anyone holding it can change production | Never in the web app or a browser. It runs only where the token already lives. |
| **An optimisation changes which rows a role sees** | INFERRED: each one rewrites a read | A manager or rep sees more or fewer rows | Same row count for every role before and after, a role sweep, and a reversal ready before it ships. |
| **Moving to Medium** | Supabase documents a restart on any compute change | A few minutes offline (NOT MEASURED here) | Done outside working hours, announced first, reversed the same way. |
| **Two pieces of work on one view** | MEASURED: an empty workspace for the visit and check-in views exists | Two versions of one migration | That workspace is left alone. The view work starts only after checking it. |

## 8. Required approvals

Each one is the owner's, one at a time.

1. **Send the Supabase Support request (§3.5).** It is a message on the company's behalf. It is filed from the Supabase
   dashboard's Support page under the owner's account. It holds no credential and no employee data.
2. **Build and deploy the host sampler (§4.3, piece 1).** It is code only: no migration, no new table, one deploy. It
   merges on his word, by number.
3. **The daily log summary (§4.3, piece 2).** Choose where it runs: the laptop's scheduled-task runner, where the
   token already lives, or not at all for now.
4. **The three read cuts (§5.1–5.3).** Code only, with no migration. They merge on his word, by number.
   **The import search (§5.4)** first needs one approved `EXPLAIN (ANALYZE, BUFFERS)`, then a migration that is named
   and approved before it is applied.
5. **Any `EXPLAIN ANALYZE` on production** beyond the runs approved on 28 Oct.
6. **Moving to Medium.** It is a paid change, so it is decided on Supabase's **Project Settings → Compute and Disk**
   screen and never in a chat. This report only sets out when (§10).

## 9. Exact next engineering action

**First pull request: the host sampler, carrying this report with it.**

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
- **Proof after the deploy:** the first ten `db_host` lines in the Railway log, the reply's size on the wire, and the
  database's own load in the same minutes compared with the day before.

**Second pull request, after one working day of sampler readings: the three read cuts of §5.1–5.3, together.**

- **Why wait a day:** that day's readings are the "before" figure for swapping that VAL §11 measures against. Without
  them, no one can say whether the cuts changed anything.
- **What it carries:** each cut's test, plus a same-output check for each cut against production rows.
- **The role sweep:** the rep's list, a manager's list and the validated-places board, run as a rep, a manager and the
  Super Admin, with denial paths included.
- **The proof:** each read's pages per call and mean time in the statement statistics, one working day before and
  one after.

**Then, with no approval needed:**

- After 04:37 on 2 Nov, read the archive's file count and the oldest day left in the trail. The oldest day should
  move from 3 Oct to 4 Oct.
- Confirm the job is on cron-job.org from its dashboard. The read-only check made for this report was refused.

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
