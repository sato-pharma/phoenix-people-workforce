---
name: outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line
description: "FIXED 2026-08-27 (#2462 prod 9f61f582; cured #2464; alarmed #2468 prod c943d46f, wiring verified live). The outbox drain ran fine every 5 min but always processed 0: its SQL LIMIT was applied BEFORE the attempts<max_attempts filter ran in JS, so 50 exhausted rows filled the whole batch and permanently blocked every retryable row behind them. Kept for the diagnosis, the parallel-session collision, the fact that an empty queue also reports attempted:0, and the safe way to prove a Healthchecks /fail hop without alerting anyone."
metadata: 
  node_type: memory
  type: project
  originSessionId: e7f88217-2a8b-4598-b043-5afd26b36bd5
  modified: 2026-08-27T17:27:38.637Z
---

**FIXED 2026-08-27 — read the RESOLVED block below before acting on anything here.** What follows
described live state until `9f61f582` shipped; the diagnosis is kept because it is how the fault was
found, and because the last paragraph (an empty queue also reports `attempted: 0`) is still true.

**The drain was HEALTHY and did nothing.** cron-job.org job **8200914**
`phoenix-process-notifications` -> `/api/notifications/process?limit=50` fires **every 5 minutes**,
returns **HTTP 200**, ~3-5s, and reports `"outbox":{"attempted":0,"sent":0,"failed":0}` every time.
Verified live 2026-08-27 (50/50 recent executions OK; body read via
`GET /jobs/8200914/history/{identifier}` - the list endpoint returns an EMPTY body, only the
per-execution endpoint has it).

**The bug is an ordering mistake in `loadDueNotificationOutboxRows`**
(`src/lib/notifications/email.ts`):

```
.in("status", ["pending","failed"])
.or(next_attempt_at is null / <= now)
.order("created_at", ascending)
.limit(limit)                                   <-- LIMIT applied in SQL, first
...then in JS:  .filter(row => row.attempts < row.max_attempts)   <-- filter applied AFTER
```

So the query takes the **50 oldest** due rows, then throws away any that are exhausted. Measured
2026-08-27: the window held **exactly 50 rows, all 50 permanently exhausted** (`attempts = 5 = max`),
created 2026-08-09 -> 2026-08-14. `limit` is 50 (the cron URL says `?limit=50`, clamped to [1,50]).
One full batch of dead rows = the JS filter empties it = **`attempted: 0`, forever.** Anything newer
sits behind them and is never reached. That is why nothing has drained since 2026-08-14: that is the
day the exhausted count reached 50.

**Consequence: retries are silently dead.** Any email whose inline send fails lands in `failed` and
is never retried - it queues behind the blockage. Inline sends still work normally (that is how
~30/day go out), so this is invisible from the product.

## Cleared 2026-08-27 - the code bug WAS still live at this point (fixed later the same day)

On the owner's instruction the 50 exhausted rows were retired to `status='skipped'`
(marker `last_error like 'Retired 2026-08-27%'`, reversible, payloads kept). Verified after: the
batch window holds **0** rows, `pending`/`failed` is **0** overall, totals conserved
(sent 1787, skipped 177, total 1964 before and after). The queue is clear, so the next email that
fails will be row 1 of 50 and WILL be retried.

**This was a data fix. The ordering bug in the query is untouched, so it WILL recur** once 50 rows
exhaust again. *(True when written. FIXED and SHIPPED the same day - see the RESOLVED block below.)*

## RESOLVED 2026-08-27 - shipped to production as `9f61f582`

**Two sessions built this fix in parallel, four minutes apart, and neither knew about the other.**
PR **#2462** (`codex/outbox-drain-batch-window`, 15:27Z) and PR **#2463** (`codex/outbox-batch-window`,
15:31Z) - same bug, same file, same test filename, two different implementations. #2462 merged as
`9f61f582` at 15:33:43Z with all four required checks green, and production confirmed serving that
revision at 15:36:10Z via `/api/healthz`. That merge left **#2463 `DIRTY`** (conflicted).

The merged fix pages past exhausted rows: `loadDueNotificationOutboxRows(limit, fetchPage)`, page
size **100**, capped at **10 pages**. The page-fetcher is injected, and
`tests/notification-outbox-batch-window.test.ts` reproduces the exact 50-against-50 shape.

**#2463 has one thing #2462 does NOT, and it is the important one: it LOGS the exhausted rows it
walks past.** The merged fix is silent, and silence is why this bug survived thirteen days.
**PORTED and SHIPPED as #2465 (`d5b19776`) - this is DONE, not outstanding.** #2463's other
differences (20 pages, page size = limit) are not improvements worth a second PR on their own; its
`.order("id")` tiebreaker went in via #2464 instead, better justified.

**How to notice this collision earlier next time:** `git worktree list` showed *two* outbox-named
worktrees before either PR was visible in `gh pr list`. A branch exists before its PR does - the
worktree list is the earlier signal. Related: [[two-sessions-fixed-one-bug-main-was-never-ci-validated]].

**The accumulation is bounded, contrary to first impressions.** Retention deletes `failed`/`skipped`
rows at 90 days (`cleanupOldNotificationData`, same file). August created **116** exhausted rows in
27 days (~4.3/day), so the due window stabilises near **390** against the 1,000-row scan cap - about
2.5x headroom. The starvation only returns if the failure rate roughly triples **or** the retention
cron quietly stops.

## The code fix as originally written for #2463 (NOT the merged implementation)

**The prescription written above is impossible and was wrong:** `attempts < max_attempts` cannot go
into the SQL `WHERE` clause, because **PostgREST has no column-to-column comparison** and
`max_attempts` is a per-row column. It reads a uniform **5** across all 1,964 production rows today,
which is exactly the trap - hardcoding `5` would be the same bug wearing a different hat, and would
break silently the first time a row is queued with a different budget.

So the window is **WALKED** instead. `collectDueNotificationOutboxRows(limit, fetchPage, maxPages)`
pages in `created_at` order via `.range(offset, offset + limit - 1)`, accumulating rows that still
have retries left, until it has `limit` of them or the due set runs out. Capped at **20 pages** so
one cron tick can never become a table scan. Exhausted rows can still DELAY a batch; they can never
again CONSUME one. Walking past exhausted rows now logs the count - the original failure was silent
for thirteen days, and that line is the signal that would have caught it in one.

The page-fetcher is **injected** so the loop is testable with no database:
`tests/notification-outbox-batch-window.test.ts` seeds the exact production shape (50 exhausted rows,
one retryable behind them) and asserts the retryable row comes back. **Confirmed to fire** - reverting
to fetch-then-filter fails it on its own headline assertion with `actual: []`, which is the
production symptom exactly. A source-level assertion could not have caught this: it is a pagination
ORDERING mistake, not a missing string.

**No end-to-end proof exists yet:** with an empty queue the drain still reports `attempted: 0`,
which is indistinguishable from the broken state. Only a real future failure proves the retry path.
Do not claim it is proven working.

**Corrects an earlier wrong call in this same session:** "the drain is dead / triggering it would
blast 49 stale emails". Both false. The drain was running the whole time, and those 49 could never
have been reached. The 49 were neutralised anyway (`last_error like 'Neutralised 2026-08-27%'`,
reversible) - harmless, but it did NOT clear the blockage, because the 50 exhausted rows are the
blockage. **Never infer a cron's health from database state alone** - read its execution history and
its response body. Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]],
[[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]].

## CURED 2026-08-27 - PR #2464, merge `2e93c273` - and it was 1 of 3, not 1

Paging (#2462 above) survives the dead rows; it does not remove them. It has a **ceiling** -
`outboxScanPageSize * outboxMaxScanPages` = **1,000 rows** - and exhausted rows keep accumulating,
so the identical freeze returns once 1,000 collect. #2464 keeps them out of the due window in SQL
instead:

```ts
.lt("attempts", notificationOutboxMaxAttempts)   // email.ts, fetchDueNotificationOutboxPage
.lt("attempts", notificationDeliveryMaxAttempts) // system.ts, telegram AND push retry drains
```

`attempts < max_attempts` is **not expressible in PostgREST** (no column-to-column comparison), but
`attempts < 5` is, and `max_attempts` is `NOT NULL DEFAULT 5` on both tables - measured 5 on all
**22,304** production rows. The per-row JS check stays and remains the authority; the SQL filter is
a prefilter, not a replacement.

**The email outbox was never the only one.** `processTelegramDeliveryRetries` and
`processPushDeliveryRetries` in `src/lib/notifications/system.ts` have the identical defect and
nothing had ever covered them. Measured on production the same day, against a limit of 50:

| drain | old window | dead weight | after `.lt` |
| --- | --- | --- | --- |
| telegram | 25 | 25 (**50% to freeze**) | 0 |
| push | 16 | 16 (32%) | 0 |
| email outbox | 0 | 0 | 0 |

Both were counting toward the same silent death. Nobody was watching either, because the outbox is
the one that got the attention.

Also added: `.order("id")` as a tiebreaker after `.order("created_at")` on all three - `created_at`
is not unique (7 production rows share one, in pairs), so without a total order the row on a
page or limit boundary can be skipped or returned twice.

Pinned by `tests/notification-drain-starvation-guard.test.ts`, registered in `tests/run-tests.ts`,
break-verified four ways (each break caught by its intended headline assertion). Every slice is
taken **by marker**, never a byte window - see
[[source-pinning-tests-slice-a-fixed-byte-window]].

**The lasting lesson is the shape, not the table.** A retry drain that caps rows in SQL but tests
eligibility in JS starves behind its own corpses, and reports `200` / `attempted: 0` while doing it -
indistinguishable from an empty queue. If you meet another one, the fix is to make the SQL window
exclude terminal rows, not to page further past them.

**Verified LIVE 2026-08-27 18:54 Cairo.** Production serves `d5b19776` (#2465, the log line ported
from #2463), which CONTAINS `2e93c273` — so #2464 never served as its own revision. Do not verify a
deploy by exact SHA match when merges are landing minutes apart; test that the serving revision is a
DESCENDANT of yours. The same query re-run against production after the deploy:

| drain | old window | dead slots wasted | new window |
| --- | --- | --- | --- |
| telegram | 50-cap, 25 rows | **25 (all of them)** | 0 |
| push | 50-cap, 16 rows | **16 (all of them)** | 0 |

Every row in both windows was terminal. Those 41 batch slots now go to rows that can still send.

## An approval to merge EXPIRES when the base moves - 2026-08-27

Two of these PRs were mine (**#2463**, **#2466**); both went fully green and both were closed as
duplicates. The waste is covered above. What is NOT covered above is what happened at the merge
itself, which is the sharper lesson.

**`gh pr merge` failed with `GraphQL: Base branch was modified. Review and try the merge again.`**
`main` had advanced between the check I ran seconds earlier and the merge call. Moments later a
parallel session **closed the PR outright**. Every session here authenticates as `Gawish-1997`, so
the timeline's actor field **cannot** tell you which session acted - do not try to infer it, and do
not assume the owner did it.

**The dangerous part was what merging would have done.** My branch was still green, still
`MERGEABLE` a minute before, and based on the pre-#2464 tree. `git diff --stat origin/main HEAD`
showed it would have **deleted 156 lines of #2464's test file** and reverted its `system.ts`. Green
checks prove a tree that no longer exists.

**So: `git diff --stat origin/main HEAD` immediately before every merge, and re-read the four checks
against the CURRENT head.** A standing "merge it" from the owner is approval for the change he was
shown - when the base moves under it, the safe move is to rebase, re-verify, and say what changed,
not to retry the merge. GitHub also **refuses to reopen** a closed PR whose head was force-pushed
(`Could not open the pull request`), so a narrowed branch needs a fresh PR number.

## #2465's warning CANNOT FIRE - verified 2026-08-27, and I built it twice

The log line above is shipped, but it is **dead code in this database**, and any note here implying
the drain is now audible is wrong.

**Why:** #2464 merged six minutes before #2465 and added `.lt("attempts",
notificationOutboxMaxAttempts)` to the page fetcher. That strips every exhausted row in SQL, before
the JS `attempts < row.max_attempts` test runs. So `skippedExhausted` can only be non-zero for a row
whose `max_attempts` differs from the constant `5`.

**Measured live** (`notification_outbox`, production `ozucdzovmcqvepbozvqf`):

```
max_attempts  rows   first_seen   last_seen
5             1964   2026-06-20   2026-08-27
```

Uniform across every row the table has ever held. The condition the warning tests for does not
occur, so the warning never fires.

**I argued for it twice** - in #2463 and again in #2466, where I wrote that it covers "the one case
the prefilter cannot express". That case does not exist here. Both PRs were closed as duplicates
anyway; the reasoning was also wrong.

**The general lesson, which is the valuable part:** an alert keyed to an INTERNAL COUNTER dies the
moment the internals move - here, within six minutes, without anyone noticing. The liveness monitor
was no better: `withDeadMansSwitch` alerts on a ping that never arrived, and this job never stopped.
It ran perfectly and did nothing, pinging `success` ~3,700 times across the 13-day freeze. **Only a
black-box invariant about OUTCOMES survives a refactor** - e.g. "a queue that had work due before
this run started, and attempted nothing, is broken". `codex/outbox-drain-alerting` was building
exactly that, uncommitted, as this was written.

## `attempts > 0` on a sent row is NOT evidence of a retry - measured 2026-08-27 20:14 Cairo

The obvious test for "did the drain finally deliver something" is: find a row that failed inline and
was later sent, i.e. `status = 'sent' AND attempts > 0`. **That test matches every row in the table
and proves nothing.**

```
sent, attempts = 0     0
sent, attempts > 0     1789      <- all of them
```

The send path increments `attempts` BEFORE attempting, so a first-time success already reads
`attempts = 1`. There is no `attempts = 0` sent row and never has been.

**Use the CREATED -> SENT GAP instead.** Inline sends complete in ~1-2 seconds, from the request
that created the row. A drain delivery cannot be faster than the next 5-minute cron tick, so the gap
is minutes. Measured on the two rows sent after the fix:

```
152a06d3   created 16:05:41Z   sent 16:05:43Z   gap 1.8s   last_error: none
5d5cec1f   created 16:26:32Z   sent 16:26:34Z   gap 1.2s   last_error: none
```

Both inline. **The retry path is still UNPROVEN** - not because it is broken, but because nothing
has failed since the fix shipped. A clean queue cannot prove a drain.

**State at that check** (prod `33041477`, notifications code unchanged since #2465): pending 0,
failed 0, processing 0, armed 0, sent 1789, skipped 177. Cron job 8200914: **50 of 50 executions
HTTP 200**, every 5 min, ~3.5s.

I had written the `attempts > 0` test into a scheduled follow-up check before verifying it. It would
have reported a delivered retry on the first inline send. Deleted. **Verify the DISCRIMINATOR before
trusting a probe** - a test that cannot fail is worse than no test, because it reports success.

## The black-box outcome alarm SHIPPED - #2468, prod `c943d46f`, 2026-08-27 20:18 Cairo

`codex/outbox-drain-alerting`, uncommitted when the section above was written, is now live. It is the
alarm that section argued for: **not** an internal counter (those died in six minutes when #2464
moved the prefilter under #2465's warning) and **not** a liveness ping (`withDeadMansSwitch` pinged
`success` ~3,700 times across the whole 13-day freeze). It is an invariant about the OUTCOME - a run
that began with work due and finished with due work still queued reports `healthy: false` and writes
a `drain_stranded` ERROR, taking the Healthchecks monitor red. The reading that hid the freeze,
`attempted: 0` against a non-empty queue, is no longer indistinguishable from an empty queue.

Timings, for what a Railway ship actually costs: merged 20:15:32 Cairo, GitHub deployment row created
20:15:37 (**+5s** - that row is how you tell a real build from an auto-deploy that silently lost the
race, since both look like "still building"), production serving `c943d46f` at 20:18:00 (**+2m28s**).
Post-merge `CI` on `main`'s own head: **success**. `secret-scan` has no run on the merge commit and
that is CORRECT - `security-scan.yml` is `on: pull_request` plus a daily schedule, never `push`.

`validate` ran the new test inside the full suite, including a wiring guard asserting the drain route
never reverts to `withDeadMansSwitch`. Break-verified: the stranded reading returns `healthy: false`,
and reverting it fails the test on its own headline assertion.

**Still unproven end-to-end, and say so.** This is alerting code, so its first genuine proof needs a
real drain that strands work. The queue has been clean since the fix - and per the section above, a
clean queue cannot prove a drain either way.

## The alarm's WIRING is proven - 2026-08-27 20:26 Cairo. The INVARIANT still is not.

The line directly above is right about the invariant and too pessimistic about everything downstream
of it. The alert chain has five links; **four are now verified against live infrastructure.** Only
the first - "a genuinely stranded queue makes `assessDrainHealth` return `healthy: false`" - waits on
a real failure, and that is the only one a clean queue can block.

| link | verified how | verdict |
| --- | --- | --- |
| stranded queue -> `healthy: false` | registered test only | **UNPROVEN in prod** |
| unhealthy verdict -> route pings `"fail"` | `tests/notification-drain-health-alert.test.ts`, green on `main` | proven |
| `/fail` -> check goes DOWN | throwaway check, live (below) | **proven** |
| DOWN -> a human is told | email + telegram attached to the real check | proven |
| deployed code is pinging at all | ping **#9499 at 17:20:03Z**, after the 17:15:37Z deploy | proven |

**The check was already tuned correctly, which is not the default.** `dead-mans-switch.ts` warns that
auto-provisioned checks land on a 1-day period / 1-hour grace - useless for a `*/5` job. It is not on
those defaults: `*/5 * * * *`, tz `Africa/Cairo`, grace **600s**, 9,499 pings, notifying **email and
telegram**. `node scripts/healthchecks-sync.mjs` (dry run, read-only) reports all **15** declared
checks `ok` / "Everything already matches", so `scripts/healthchecks-sync.mjs` had already done its
job. Run that dry run before ever suspecting the monitor's configuration.

**The monitor's own flip history is the cleanest record of the freeze that exists.** Seven status
flips on `phoenix-process-notifications`, and the last one is `2026-08-14T15:05:00Z -> DOWN`,
`15:10:03Z -> UP`. **Then nothing for thirteen days**, while the outbox delivered nothing at all. The
ledger of the alarm that was supposed to catch this contains no entry for it. That is what
"`withDeadMansSwitch` pinged success ~3,700 times" looks like from the monitor's side.

**Every DOWN in that history came from a MISSED ping. No `/fail` had ever been sent to this check** -
so the exact transition #2468 introduces had never once run in production.

### How to prove a `/fail` hop without touching production or waking anyone

Do **not** ping the real check, and do **not** manufacture a stranded row on a live queue to test a
monitor. Use a throwaway that notifies nobody:

1. `POST /api/v3/checks/` with `{name, slug, channels: ""}` - `channels: ""` means no channels.
   Auto-provisioning via `?create=1` **inherits the project defaults**, which here would email and
   telegram the owner, so create through the Management API, never by pinging a new slug.
2. **Read it back and assert `channels` is empty before pinging.** That gate is the whole safety
   argument; without it this procedure sends a real alert to a real person.
3. `POST <ping_url>/fail`, then poll `GET /api/v3/checks/<uuid>`.
4. `DELETE` it in a `finally`, then re-list and confirm the project is back to its declared count.

Measured 2026-08-27: `/fail` -> HTTP 200, status -> **`down`**, flip `17:25:30Z -> DOWN` at the same
instant as the ping. Deleted; project back to **15** checks. Zero notifications fired.

**One trap in my own instrumentation, worth repeating because it is the theme of this whole file.**
The pings listing showed `kind=success` for that fail ping - and that was **my script's display
fallback** (`p.kind || "success"`) for an absent field, not the API. The authoritative signals are
the status and the flip. A probe that formats an unknown as a success is the same defect as a cron
that reports `attempted: 0` on a frozen queue: **never let a display default stand in for a
measurement.** See also the `attempts > 0` probe two sections up, which had exactly this shape.
