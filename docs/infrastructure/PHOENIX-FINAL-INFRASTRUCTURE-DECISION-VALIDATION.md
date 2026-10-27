# Phoenix — final infrastructure decision, validated

A read-only check of the seven reports in this folder, made on 28 Oct 2026 between 00:10 and 01:30 Cairo. Nothing was
changed, bought, restarted or migrated, and no `EXPLAIN ANALYZE` was run. The earlier reports were treated as starting
evidence, not as facts. Every claim below carries one of three labels:

- **MEASURED**: read from a live system during this validation, and the source is named.
- **INFERRED**: reasoned from measurements or from the code, but not observed directly.
- **NOT MEASURED**: no source we can read holds it. The plan says how to measure it.

## The decision

**DECISION A: keep Supabase Small and optimise.** Medium is bought only if one of the measured triggers in §11 fires.

The earlier recommendation was Medium (+$45 a month), with Redis on Railway. **It is withdrawn.**

- The database swaps during the working day, but no measurement links that swapping to the restarts or to the slow
  requests.
- The one cost that is measured is the overhead of the requests themselves, about 673,000 a day. Nothing shows that
  Medium would reduce it.
- **Corrected at 01:50 Cairo, after the code was re-read to build step 3:** the code already does most of what step 3
  was to add (V9, V10). The free fixes left without a database change are small, so A rests on the triggers in §11,
  not on a cut in requests.
- §13 explains why A is the better choice.

## 1. Verified findings

| # | Finding | Evidence | Label | Confidence |
| --- | --- | --- | --- | --- |
| V1 | **Swapping comes and goes; it is not constant.** | Overnight, 0.023 pages a second were written to swap, against 8.6 a second on average since the 25 Oct boot. 208 MB of the 1 GB swap is in use, 863 MB of memory was free at night, and no process was killed for lack of memory. | MEASURED (database host counters) | High |
| V2 | **The swapping happens during the working day.** | About 530 MB had gone to swap in the first 7 quiet hours after the boot, 6.6 GB by the next evening, and about 7 GB by 28 Oct. | MEASURED (three reads) | High |
| V3 | **The pages Postgres reads are already in its memory.** 99.06 % of page reads were found in Postgres's own buffers. | `pg_stat_database`, 27 Oct | MEASURED | High |
| V4 | **The database crashed and restarted 10 times between 10 and 25 Oct**, always between 11:05 and 19:04 Cairo, and not since 25 Oct 16:14. | Postgres's own log. Each start reports that the database "was not properly shut down", and no shutdown request comes before any of them. | MEASURED | High |
| V5 | **The CPU is not saturated on average.** It averages about 20 % of 2 cores (14.6 % at night). Under 1 % of its time is lost to other tenants on the shared host: 0.55 % since the boot, about 0.3 % in a later read. | Host CPU counters since the boot | MEASURED | High, for the average |
| V6 | **SQL work is a small share of the CPU.** Statement time totals 11,313 s, about 13 % of the CPU-seconds the host was busy since the boot. | `pg_stat_statements` against the host counters | MEASURED. Which service uses the rest is NOT MEASURED. | Medium |
| V7 | **A request costs far more than its SQL.** | The sign-in bundle runs in 0.42 ms in the database. At Supabase's front door it takes 93 ms for a typical request and 784 ms for the slowest 5 %; 58 ms of the typical figure is spent inside Supabase. The employees read takes 0.13 ms in the database and 236 ms for a typical request. | MEASURED (`pg_stat_statements`, Supabase request logs) | High |
| V8 | **27 Oct (Cairo day): 673,000 requests to Supabase and no server errors (no 5xx).** The sign-in bundle alone was 103,604 of them (15 %). | Supabase request logs | MEASURED | High |
| V9 | **One screen polled while its tab was hidden: the activity dashboard, every 30 s (Super Admin only).** Step 3 stops it. The Zoom-due check (every 15 s) and mailbox alerts (every 2 minutes) also run while hidden, and must: one opens the interview's Zoom at its start time, the other sends a desktop notice when Phoenix is not in front. The WhatsApp inbox, the sidebar badges, the session pulse, the new-CV bar and the recruitment overview already skip a hidden tab. *Corrected 01:50: the first version said three screens, and that the WhatsApp inbox polls while hidden.* | Code, re-read while building step 3 | MEASURED (code). Their share of requests is NOT MEASURED. | High |
| V10 | **The sign-in bundle is already read once per page render**, and one session pulse already carries the badges, the bell and the keep-alive that used to be three requests. A second read inside one API request happens only on the device-import refusal path, which is rare. *Corrected 01:50: the first version said a request can read it twice, as if that were common.* | Code | MEASURED (code) | High |
| V11 | **Releases: 309 web deployments were created 22–28 Oct for 301 commits; 22 have failed since 20 Oct; 27 went live on 27 Oct.** One web server, one worker. | Railway | MEASURED | High |
| V12 | **A release that goes live adds about 870 requests in the next 5 minutes (+24 %) and does not slow requests** (348 ms average against 361 ms before). At 27 releases a day that is about 3.5 % of a day's requests. | Supabase request logs around each go-live | MEASURED. Approximate: releases cluster in busy hours. | Medium |
| V13 | **Scheduled jobs use about 210 s of database time a day.** | Job logs | MEASURED | High |
| V14 | **Postgres almost never runs out of sort memory:** 12 overflow files, 149 MB in all, since the boot. | `pg_stat_database` | MEASURED | High |
| V15 | **The CRM roster read has not been called since 26 Oct 00:12**, when the roster cache went live; its count stays at 2,371. | `pg_stat_statements` | MEASURED | High |

## 2. Corrected findings

| Earlier claim | Corrected reading | Where it appeared (corrected in place) |
| --- | --- | --- |
| "640 MB of shared buffers" | **512 MB** (65,536 pages of 8 kB). | Executive decision, external options, roadmap, architecture, PostgreSQL audit |
| "21.7 % CPU" | **About 20 % average, 14.6 % at night.** The steal figure (0.55 % since the boot) stands. | Executive decision, baseline, cost and performance, PostgreSQL audit |
| "11 working-hours restarts in the 14 days to 25 Oct" | **Postgres's log shows 9 crash restarts between 11 and 25 Oct, or 10 counting 10 Oct.** The restart table also lists 20 Oct 14:11, 22 Oct 11:30 and 22 Oct 12:33, but none of these has a crash-recovery line in the log. What the table recorded at those times is NOT MEASURED. | Executive decision, cost and performance, PostgreSQL audit |
| The CRM contact-assignment read (2,371 calls) as the first query to fix | **Every one of those calls came before the roster cache went live (PRs 6471 and 6473, 26 Oct 00:09).** The count has not moved since, so it is no longer a target. | Executive decision, PostgreSQL audit |
| "116 deploys in two days" | **116 merges.** Railway shows 27 go-lives on 27 Oct. A go-live empties the caches; a merge does not. | PostgreSQL audit |
| "The API layer's per-request cost is most of the server's CPU" | **SQL work is 13 % of the busy CPU.** The other 87 % is shared by the API layer, sign-in, the connection pooler, logging and Postgres's background work. The split between them is NOT MEASURED. | Roadmap |
| "The machine is short of memory, and that is the main cause of the stalls" | **The machine swaps during the day (MEASURED).** That this causes the stalls and restarts is INFERRED: no timeline links them. | PostgreSQL audit, Finding 1 |
| A database larger than memory as the source of the pressure | **The data's size is not the problem in itself:** 99 % of page reads come from Postgres's buffers. What swaps is the daytime working memory of the services that share the 2 GB. | Executive decision, PostgreSQL audit |
| **Executive decision: Medium** | **Replaced by this report's Decision A.** | Executive decision |

## 3. Unsupported assumptions

The earlier reports relied on each of these, openly or by implication, and no measurement supports any of them:

1. **That Medium would stop the restarts.**
   - The restart cause cannot be read: Supabase does not expose its reason.
   - The out-of-memory counter starts again at every boot, so it says nothing about the earlier restarts.
2. **That swapping causes the slow requests.** No minute-by-minute swap or page-fault history exists to compare with them.
3. **That the slow requests (784 ms for a 0.42 ms query) are caused by memory.**
   - CPU peaks, the API layer's connection pool or the network could explain them just as well.
   - None of these is measured per minute.
4. **That peak CPU is safe.**
   - Only averages can be read.
   - The busiest five minutes, and the steal in them, are NOT MEASURED.
5. **That a cache that survives releases would cut the load materially.**
   - The most expensive cached read, sales against target, used 488 s of database time since the boot: about 3½ minutes a day.
   - That is about 0.1 % of the database server's 2 cores.
6. **That the number of requests drives the memory pressure.**
   - The number of requests drives work per request; what a request does drives memory.
   - Neither is measured.
7. **That a short-lived cache of the sign-in bundle is safe.**
   - A role change, a disabled account or a revoked permission must take effect on the very next request.
   - A cache with any lifetime breaks that (Investigation 5).
8. **"Weekday requests down at least 20 %".**
   - This target was set before the sources were measured.
   - The sources named here carry about a third of the day (§7). How much of that can go is NOT MEASURED.

## 4. Actual root causes

What is known, most certain first:

1. **The overhead of each request: high confidence, MEASURED.**
   - Requests cost many times their SQL, and there are about 673,000 a day.
   - A page that makes several reads one after another pays about 100 ms for each at a typical moment, and up to about
     800 ms at the slow end.
   - This is the measured cost behind slow pages.
2. **Memory pressure on the 2 GB host during the day.**
   - That it swaps is MEASURED; that it harms performance is INFERRED (medium confidence).
   - The swapping follows the working day. Postgres and Supabase's own services share 2 GB.
3. **Heavy reads that scan far more pages than they return: medium to high confidence, MEASURED.**
   - The combined CRM visit and plan views: 43 million and 41 million pages scanned.
   - The import-row search: 1.1 million pages read from disk.
   - The contact-list refresh.
   - These pull cold pages into memory in the busiest hours.
4. **The working-hours restarts.**
   - The cause is NOT MEASURED; low confidence.
   - Their timing (all between 11:05 and 19:04) links them to load.
   - Before the 22 Oct 11:51 restart there were query timeouts and a dropped secure connection.
   - None has happened since the 25 Oct load fixes. But 2.4 quiet days would happen by chance about one time in five at
     the old rate of 0.66 a day.
5. **Heavy hand-run checks during busy hours: medium confidence, MEASURED on 27 Oct.**
   - A 110-second check at 19:36 and a 42-second one at 20:07.

**Not causes:**
- Releases: about 3.5 % of requests.
- Scheduled jobs: about 210 s a day.
- The disk: 1.4 % used.
- Connections: never timed out.
- The CPU: not on average. Its peaks are NOT MEASURED.

## 5. Confidence by conclusion

| Conclusion | Confidence | What would raise it |
| --- | --- | --- |
| The database server is not short of CPU on average | High | — |
| CPU peaks do not limit it | Low (NOT MEASURED) | One working day sampled every minute (§10, step 1) |
| The swapping comes and goes, and happens in the day | High | — |
| The swapping causes the stalls and restarts | Low to medium | Per-minute swap and page-fault samples compared with the slow minutes |
| 4 GB would stop the swapping | Medium (INFERRED) | The same samples: peak memory demand in the day, against 2 GB |
| Request overhead dominates the cost of a cheap call | High | — |
| Request overhead dominates the cost of a whole page | Medium | Timing whole pages |
| Releases do not add material load | Medium | — |
| Redis would not pay for itself | High | — |
| The restart problem is fixed | Low (2.4 quiet days) | 7 quiet working days, which would happen by chance about 1 % of the time |

## 6. Expected benefit of upgrading Supabase (Medium, +$45 a month)

**What it would do (INFERRED, nothing measured directly):**
- Medium has twice the RAM, so the daytime working memory (§4, point 2) would fit with room to spare.
- Swapping should then mostly stop.
- If the restarts are caused by memory, they should stop too.

**What it does not buy:**
- The CPU stays at 2 shared cores, so the request overhead (§4, point 1) is not expected to change. Whether Medium gives
  the API layer more connections or workers is NOT MEASURED.
- It does not make the requests fewer or the heavy reads cheaper.

**Cost:**
- $45 a month.
- One restart to move up and one to move back. Supabase bills by the hour, so a one-week trial costs about $10.

**Large and above (Decision C) is unsupported:** Large is 8 GB with 2 dedicated cores, +$95 a month, and nothing
measured calls for dedicated cores.

## 7. Expected benefit of reducing the database workload

**The ceiling (MEASURED):** on 27 Oct, the paths these changes touch carried about 221,000 of the 673,000 requests
(33 %):

| Path | Requests |
| --- | ---: |
| Sign-in bundle | 103,604 |
| Employees | 51,471 |
| App user accounts | 18,900 |
| Notification events | 17,386 |
| Notification read states | 8,809 |
| WhatsApp classification sessions | 7,600 |
| Rate-limit counter | 7,202 |
| Telegram links | 5,892 |

**How much of that can go: NOT MEASURED, and less than first thought.** The code already skips hidden tabs and reads
the sign-in bundle once per page (V9, V10). The 15 % target first set in §11 is withdrawn.

**What the changes do:**
- Fewer requests mean less API-layer work on the shared 2 cores, and less queueing. This is the only option aimed at the
  cost that is measured.
- Lighter CRM reads and a narrower import search mean fewer pages pulled from disk, and less memory churn in the day.
- **Sign-in, access control, payroll and CRM rules stay as they are.** The changes alter how often data is read, never
  what is allowed or what is returned.

**Cost:** $0.

## 8. Expected benefit of Redis

**What it would save (MEASURED):**
- A cache that survives a release would save about 870 requests per release.
- It would also save the most expensive cached read's 3½ minutes of database time a day.

**What it would add:**
- A new store holding employee data outside Supabase. That needs a data-protection review, a private network only and
  no disk copy.
- A second way for pages to fail, which must fall back to a live read.
- About $1–3 a month.

**What it cannot do:** it adds no memory to the database host, which is where the swapping is.

**Verdict: not justified (high confidence).**

## 9. Final monthly cost comparison

**Supabase:**
- The Pro plan costs $25 and includes a $10 compute credit.
- Production, on Small, costs $15.
- Staging costs $10: it runs on Micro, INFERRED from its settings (256 MB of shared buffers, 60 connections, Micro's
  defaults).
- Production has 12 GB of disk, 4 GB over the 8 GB included, at $0.125 a GB: $0.50.
- Data transfer was not read in this check.

**Railway: about $50.**
- Railway refused this account's usage read in this check ("Not Authorized").
- So the figure is the earlier estimate, from measured memory and CPU, not an invoice.
- The Pro plan's $20 includes $20 of usage.

**Redis on Railway, if added:** about 50–100 MB of memory and very little CPU, at $10 per GB-month and $20 per
vCPU-month: about $1–3.

| Option | Supabase | Railway | Total a month | Meets the measured requirements? |
| --- | ---: | ---: | ---: | --- |
| **A. Small + free optimisations** | ≈ $40.50 | ≈ $50 | **≈ $90.50** | Yes on the evidence so far, to be shown by §11 |
| B. Small + caching inside the app (no Redis) | ≈ $40.50 | ≈ $50 | ≈ $90.50 | Same as A. The safe caching is part of A. |
| B, with Redis | ≈ $40.50 | ≈ $51–53 | ≈ $91.50–93.50 | No measured need |
| C. Medium, no Redis | ≈ $85.50 | ≈ $50 | ≈ $135.50 | The fallback if a §11 trigger fires |
| D. Medium + Redis (the earlier recommendation) | ≈ $85.50 | ≈ $51–53 | ≈ $136.50–138.50 | Redis has no measured need |
| E. Large | ≈ $135.50 | ≈ $50 | ≈ $185.50 | Unsupported |

## 10. Ranked action plan

1. **Measure one working day. Read-only, $0.**
   - Every minute, sample the database host's free memory, swap in and out, page faults, CPU by mode and steal.
   - Sample Supabase's requests and their times each minute alongside.
   - This answers the four NOT MEASURED questions that separate A from B: peak memory, peak CPU, steal at peak, and
     whether swapping lines up with slow requests.
   - Nothing in production changes.
2. **Keep heavy hand-run checks out of 09:00–17:00 Cairo.** $0.
3. **The one hidden-tab poll left: in this pull request, $0.**
   - The activity dashboard stops asking while its tab is hidden, and refreshes the moment the tab is shown again.
   - The rest of the first list is already in the code (V9, V10).
   - **Not done, and why:**
     - Folding the sidebar's eleven badge reads into one needs a new database function, which is a migration. It is
       not made without the owner's word, and the pulse already keeps each viewer's badges for 20 s.
     - The 60-second caches for names and the Telegram link are dropped. No read they would save has a measured
       share, and each would add a way to show a stale name or link.
4. **Lighter heavy reads: one pull request, $0** (Stage 2a, held in `_wt-crm-read-load-cut`).
   - The combined CRM views read only the sources and columns each screen needs, and the import-row search is narrowed.
   - Each read shape first needs the owner's approval for one `EXPLAIN (ANALYZE, BUFFERS)`, run outside working hours.
   - Every role must get exactly the same rows back, shown by a role sweep.
   - **Measured at 01:55 Cairo on 28 Oct, with the owner's approval: the Double Visit Analytics read.** It is the
     heaviest read shape on the database: 12,527 calls and about 42.9 million pages since the statistics reset,
     3,424 pages a call on average. One 7-day run (19 to 25 Oct) touched 9,807 pages.
     - **Where the pages went:** 7,512 of them (77 %) looked up the customer of 2,504 Phoenix visits, and 2,149 of
       those visits were then dropped because they were not double visits.
     - **Why:** the double-visit test let a Phoenix row qualify by its partner's CRM id. That id comes from a join, so
       Postgres could test it only after all the joins, customer included.
     - **The fix, code only and no migration:** the CRM-id half now names `source.neq.phoenix`. On a Phoenix row,
       the CRM id comes from the partner the HR id names, so the HR-id half already covers every one of them.
     - **Measured after:** the same run touched 3,360 pages (−66 %), execution fell from 62 ms to 38 ms, and the
       same 512 rows came back. August to October, both tests return the same 6,062 rows. Across all 7,067 Phoenix
       rows, none changes.
     - The cut on an average call is NOT MEASURED. It depends on how many Phoenix visits in a run are not double
       visits.
5. **Watch 10 working days against §11, then stay on Small or move to Medium.**

**Not recommended:**
- **Redis** (§8) and **Large** (§6).
- **A cut to `work_mem`:**
  - Postgres uses less than its 32 MB limit: 12 overflow files since the boot.
  - Lowering it would save nothing measurable and risks sorts spilling to disk.
- **Fewer shared buffers:** the 99 % hit rate depends on them.
- **A Railway volume to keep the cache across releases:**
  - Railway documents a short outage on each release for a service with a volume.
  - At 27 releases a day that costs more than the cache saves (INFERRED from Railway's documentation, not tested).

## 11. Objective acceptance criteria

Measured over 10 working days in a row, once step 3 is live. Today's figure is in brackets.

**Decision A holds, and the database stays on Small, when all of these are true:**

- Database crash restarts: **0** [9 between 11 and 25 Oct].
- Working-hours stalls of query timeouts lasting over 10 seconds: **0** [27 Oct 20:22, about 15 s].
- Server errors (5xx) at Supabase's front door: **under 0.01 % of requests every day** [0 on 27 Oct].
- Weekday requests: recorded each day, with no target [673,000 on 27 Oct]. The 15 % cut first set here is withdrawn,
  because the code already does most of what step 3 was to add.
- The sign-in bundle at the front door: **slowest 5 % under 500 ms**, and a typical request no slower than 93 ms
  [784 ms and 93 ms].
- Working-hours swap-out, from step 1's sampler: **at most half the first measured day's average.**
- Access: a role sweep returns the same pages and rows before and after, for Super Admin, the CEO, a manager and a rep.
  A disabled account and a removed role are refused on the very next request.

**Move to Medium (Decision B) when any one of these happens:**

- One database crash restart in working hours.
- Two working-hours stalls over 10 seconds in one week.
- Step 1's sampler shows under 100 MB of free memory for 5 minutes or more on 2 working days, with step 3 live.

## 12. Rollback conditions

**Step 3 (polling and single reads):** reverted by one pull request, with no database change, if any of these happens:
- Any role sees a different page or a different set of rows.
- A disabled or revoked account gets even one more answer than it does today.
- A badge or inbox on a visible tab is staler than its old poll interval.
- Server errors rise.

**Step 4 (lighter reads):** reverted if any screen's row count differs for any role, or if the slowest 5 % of those
reads get slower.

**Medium, if a trigger fires and it is bought:** go back to Small after 14 days if two things are both true. Swapping
has not fallen, and restarts or stalls still happen. That would mean memory was not the cause. Going back is the same
screen and one restart. If restarts stop and swapping falls, keep Medium.

**Step 1's sampler:** stopped if it ever adds measurable load. It reads the host's metrics, not the database's tables.

## 13. Why Decision A is better

- **B buys memory for a cause that is inferred, not shown.** A spends nothing while step 1 measures that cause. The
  code already avoids most needless requests, so what A changes in the code now is small. Medium stays one change
  away, behind triggers agreed in advance.
- **Being wrong with A costs at most one more crash restart**, from which the database recovered by itself all 10 times,
  before Medium follows the same evening.
- **Being wrong with B costs $540 a year and a restart**, and leaves the slow-request cost where it is.
- **C (Large) is unsupported:** nothing measured asks for dedicated cores.

---

## Appendix: the six investigations, answered

### Investigation 1: memory pressure

1. **The 7 GB swapped since the boot comes and goes; it is not constant.**
   - At night: 0.023 pages a second. Since the boot: 8.6 on average. Free memory at night: 863 MB.
   - MEASURED.
2. **Peak memory use in working hours: NOT MEASURED.**
   - The host's metrics show the present moment only; no history can be read. Step 1 measures it.
3. **Swap rates during the stalls: NOT MEASURED**, for the same reason.
4. **Whether page faults line up with slow requests: NOT MEASURED.**
   - The slow end of the cheapest call (784 ms) shows queueing somewhere on the way, but not where.
5. **Restart causes: they were not graceful.**
   - All 10 crash restarts start "not properly shut down", with no shutdown request before them. So they were not a
     planned maintenance restart or a stop made from the dashboard (MEASURED).
   - Memory against the platform's own action: NOT MEASURED. The out-of-memory counter starts again at each boot, and
     Supabase does not expose its reason.
   - Load is likely, from their timing (INFERRED).
6. **Whether 4 GB would help the working set: INFERRED, medium.**
   - The data's working set fits (99 % hit rate).
   - It is the daytime working memory around it that swaps. 4 GB would hold that; how big it is at peak is NOT MEASURED.
7. **A setting change or a smaller working set instead of an upgrade: possibly, not proven.**
   - A `work_mem` cut saves nothing measurable (V14), and fewer shared buffers would lower the hit rate.
   - The safe lever is lighter heavy reads (step 4), which pull fewer cold pages in during the day. Whether that avoids
     the upgrade is what §11 decides.

### Investigation 2: CPU

1. **Peak CPU: NOT MEASURED.** Average about 20 %, nights 14.6 % (MEASURED).
2. **The busiest five minutes: NOT MEASURED.** Step 1 measures them.
3. **Steal in those minutes: NOT MEASURED.** Under 1 % on average: 0.55 % since the boot (MEASURED).
4. **Postgres against Supabase's other services:**
   - SQL work is about 13 % of the busy CPU-seconds (MEASURED).
   - The split of the rest between the API layer, sign-in, the pooler and logging is NOT MEASURED.
5. **Statement time was treated as CPU in places: corrected (§2).**
   - Statement time includes waiting for the disk and for locks, so it is an upper limit on its own CPU, not a share of it.

### Investigation 3: request volume

**Top 20 paths, 27 Oct, Cairo day (MEASURED, Supabase request logs):**

| # | Path | Requests | Total seconds at Supabase's front door |
| ---: | --- | ---: | ---: |
| 1 | Sign-in bundle (function) | 103,604 | 22,549 |
| 2 | Employees | 51,471 | 18,036 |
| 3 | CRM visits | 20,077 | 9,105 |
| 4 | App user accounts | 18,900 | 5,380 |
| 5 | Notification events | 17,386 | 4,055 |
| 6 | Combined CRM visits view | 12,909 | 8,380 |
| 7 | CRM places | 11,393 | 3,351 |
| 8 | CRM customers | 10,864 | 3,640 |
| 9 | Plan items | 9,654 | 4,307 |
| 10 | Notification read states | 8,809 | 1,716 |
| 11 | Touch trail (writes) | 8,025 | 1,398 |
| 12 | WhatsApp classification sessions | 7,600 | 937 |
| 13 | Direct-order approval steps | 7,419 | 1,582 |
| 14 | CRM plans | 7,227 | 3,934 |
| 15 | Rate-limit counter (function) | 7,202 | 1,246 |
| 16 | Notification deliveries (writes) | 7,168 | 1,221 |
| 17 | Manager plans | 7,167 | 3,016 |
| 18 | Module locks | 6,360 | 819 |
| 19 | Vacation approval steps | 6,110 | 2,015 |
| 20 | Telegram links | 5,892 | 1,502 |

These 20 carry about 335,000 requests, half the day. The next two are direct orders (5,795) and areas (5,571).

Which server code sends each request: NOT MEASURED. Railway keeps no request log for a replaced deployment, and returned
a single row for the live one.

**The rest of the investigation:**

- **Unnecessary polling (code, re-read at 01:50):**
  - Only the activity dashboard polled while its tab was hidden. Step 3 stops it.
  - Zoom-due and mailbox alerts must run while hidden: they open a due Zoom and send a desktop notice.
  - The WhatsApp inbox, the sidebar badges, the 30-second pulse, the new-CV bar and the recruitment overview already
    skip a hidden tab.
- **Duplicates (code):**
  - The sign-in bundle is read once per page render. The pulse already carries three polls in one request.
  - A second read inside one API request happens only on the device-import refusal path.
- **Batching:** the sidebar's 11 badge reads could become one, but only through a new database function (a migration).
- **Caching:** none added.
- **Requests and memory pressure:** NOT MEASURED. INFERRED to be small: the number of requests drives work per
  request, and the heavy reads drive memory.
- **How much can go without new infrastructure:** through the code alone, little. The 33 % in §7 is the share of the
  paths, not what can go.

### Investigation 4: releases

1. **116 merges is not 116 releases.** 27 went live on 27 Oct, and 309 deployments were created over 22–28 Oct for 301
   commits, 22 of them failed (MEASURED).
2. **Every go-live empties the page cache and the in-memory caches** (INFERRED, high):
   - About 35 cached reads keep their cache on the container's own disk, and each release gets a new container.
   - The worker loses its in-memory caches the same way.
3. **The load from each release:** about 870 extra requests in 5 minutes, with no slowdown (MEASURED, approximate).
4. **Releases are not a material cause:** about 3.5 % of a day's requests (INFERRED, medium).
5. **Can it be improved without Redis?**
   - A volume costs an outage on every release (§10, not recommended).
   - Everything else needs a cache outside the container.
6. **A cache that survives releases is not justified:** the most expensive cached read costs 3½ minutes a day.

### Investigation 5: caching safely

- **Access scope:**
  - The cache audit of 26 Oct closed every finding and found no data shown to the wrong user.
  - Step 3 adds no cache at all.
- **Employee and payroll data:** nothing payroll is cached anywhere new, and nothing new leaves Supabase and the app
  servers.
- **Database access rules (RLS) and the app's access checks:** unchanged. Every read still goes through them.
- **Disabled accounts and removed permissions:**
  - The sign-in bundle stays live on every request.
  - Its existing 10-minute copy is used only when two live reads both fail. It is cleared on revoke and on forced
    sign-out, and a version change is refused live.
- **One condition to keep (INFERRED from the code):** that clearing happens only inside one server. If the web service
  ever runs more than one copy, a revoke must clear every copy before more are added.
- **Invalidation:** nothing new to clear, since step 3 adds no cache.

### Investigation 6: costs

See §9.

- **Credits:** the Supabase Pro plan's $10 compute credit covers staging's Micro, and the Railway Pro plan includes
  $20 of usage.
- **Storage:** $0.50 for production's extra disk.
- **Data transfer:** not read in this check.
- **Railway's live bill:** not readable with this account's access, so the ≈ $50 is an estimate.
