---
name: outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line
description: "FIXED 2026-08-27. A retry drain that caps rows in SQL (LIMIT) but tests eligibility (attempts<max_attempts) in JS STARVES behind its own exhausted rows — one full batch of terminal rows empties in the JS filter, so it returns 200/attempted:0 forever, indistinguishable from an empty queue. All THREE drains (email outbox + telegram + push) had it. Kept for the bug shape and its fix, and the operational lessons: an empty queue also reports attempted:0, never infer a cron's health from DB state, an internal-counter alarm dies on refactor, and the safe way to prove a Healthchecks /fail hop without alerting anyone."
metadata: 
  node_type: memory
  type: project
  originSessionId: e7f88217-2a8b-4598-b043-5afd26b36bd5
  modified: 2026-09-26T03:14:22.887Z
---

**FIXED and SHIPPED 2026-08-27.** The notifications drain ran every 5 minutes, returned HTTP 200 in ~3–5 s,
and reported `"outbox":{"attempted":0,"sent":0,"failed":0}` every time — while delivering nothing for 13
days. Kept for the bug shape and the operational lessons, which outlive the incident.

## The bug shape (the transferable lesson)

🔴 **A retry drain that caps rows in SQL but tests eligibility in JS starves behind its own corpses.**
`loadDueNotificationOutboxRows` (`src/lib/notifications/email.ts`) applied `.limit(50)` in SQL and THEN, in
JS, `.filter(row => row.attempts < row.max_attempts)`. So it took the 50 oldest due rows and threw away the
exhausted ones — and once ≥50 exhausted rows (`attempts = max = 5`) sat at the head of the window, the JS
filter emptied the whole batch: **`attempted: 0`, forever, with everything newer stranded behind them.** It
reports `200` / `attempted: 0` the whole time, **indistinguishable from an empty queue** — which is why it
survived silently for 13 days. Inline sends still worked (that is how ~30/day went out), so it was invisible
from the product; only queued RETRIES were dead.

**The fix: make the SQL window EXCLUDE terminal rows, do not page further past them.** `attempts <
max_attempts` is NOT expressible in PostgREST (no column-to-column comparison), but `attempts < 5` is —
`max_attempts` is `NOT NULL DEFAULT 5`, uniform across every production row the tables have ever held. So the
page fetcher gained `.lt("attempts", <maxAttempts constant>)` as a **prefilter**; the per-row JS check stays
as the authority. Paging past exhausted rows (page size 100, capped) was the first fix and survives dead rows
but has a scan ceiling that re-freezes once enough accumulate — the `.lt` prefilter is the real cure.

🔴 **The email outbox was never the only drain with this shape.** `processTelegramDeliveryRetries` and
`processPushDeliveryRetries` (`src/lib/notifications/system.ts`) had the identical defect and had never been
covered — measured against a limit of 50, telegram was already 50% dead weight, push 32%. Fix all three.
Also add **`.order("id")` as a tiebreaker after `.order("created_at")`** on each: `created_at` is not unique,
so without a total order a row on a page/limit boundary can be skipped or returned twice. Pinned by a
break-verified starvation-guard test (each break caught by its intended headline assertion; slices taken by
MARKER, never a byte window — [[source-pinning-tests-slice-a-fixed-byte-window]]).

**Accumulation is bounded:** retention deletes `failed`/`skipped` rows at 90 days
(`cleanupOldNotificationData`), so the due window stabilises with headroom against the scan cap; starvation
only returns if the failure rate roughly triples OR the retention cron quietly stops.

## Operational lessons (the valuable half)

- 🔴 **A clean queue cannot prove a drain.** An empty queue reports `attempted: 0` too, so the retry path is
  only ever proven by a real future failure — never claim it works off a clean queue.
- 🔴 **Never infer a cron's health from database state alone** — read its execution HISTORY and its response
  BODY. (cron-job.org: the history LIST endpoint returns an empty body; only the per-execution endpoint
  `GET /jobs/{id}/history/{identifier}` carries it.) [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]],
  [[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]]
- 🔴 **An alert keyed to an INTERNAL COUNTER dies the moment the internals move** — a "log the rows I walked
  past" warning became dead code six minutes after it shipped, when the SQL prefilter stripped the very rows
  it counted. A liveness ping is no better: `withDeadMansSwitch` pinged `success` ~3,700 times across the
  whole 13-day freeze (it ran perfectly and did nothing). **Only a black-box invariant about OUTCOMES
  survives a refactor** — the shipped alarm asserts "a run that began with work due and finished with due
  work still queued is broken" (`assessDrainHealth` → `healthy: false` → `drain_stranded` ERROR → the monitor
  goes red), so `attempted: 0` against a non-empty queue is no longer mistaken for an empty one.
- 🔴 **Verify the DISCRIMINATOR before trusting a probe — a test that cannot fail reports success.**
  `status='sent' AND attempts>0` proves nothing about retries: the send path increments `attempts` BEFORE
  attempting, so a first-time success already reads `attempts=1` and there is no `attempts=0` sent row. Use
  the **CREATED→SENT gap** instead — inline sends complete in ~1–2 s, a drain delivery cannot beat the next
  5-minute tick.
- 🔴 **Never let a display default stand in for a measurement** — a pings listing showed a `/fail` ping as
  `kind=success` because the script had `p.kind || "success"` for an absent field, the same defect as the
  cron reporting `attempted:0` on a frozen queue. The authoritative signals are the STATUS and the FLIP.

### Prove a Healthchecks `/fail` hop without alerting anyone

Do NOT ping the real check, and do NOT manufacture a stranded row on a live queue. Use a throwaway that
notifies nobody: (1) `POST /api/v3/checks/` via the Management API with `channels: ""` — never
auto-provision with `?create=1`, which inherits the project defaults (here: email + telegram to the owner);
(2) **read it back and assert `channels` is empty before pinging** — that gate is the whole safety argument;
(3) `POST <ping_url>/fail`, poll `GET /api/v3/checks/<uuid>` for `down`; (4) `DELETE` in a `finally` and
re-list to confirm the declared count. `node scripts/healthchecks-sync.mjs` (dry run, read-only) reports
declared-check drift — run it before ever suspecting the monitor's configuration.

## Parallel-session and deploy-verify lessons

Two sessions built this same fix four minutes apart, neither knowing the other. **`git worktree list` shows
two same-named worktrees before either PR appears in `gh pr list`** — a branch exists before its PR, so the
worktree list is the earlier collision signal ([[two-sessions-fixed-one-bug-main-was-never-ci-validated]]).
🔴 **An approval to merge EXPIRES when the base moves** — `main` advancing between the check and the merge
call made one merge would-be revert 156 lines of a sibling PR's test. **Run `git diff --stat origin/main HEAD`
immediately before every merge and re-read the required checks against the CURRENT head — green checks prove
a tree that no longer exists.** Every session authenticates as the one owner login (`it-gawish-hr` since 27 Oct 2026, `Gawish-1997` before), so the timeline's actor field
cannot tell you which session acted; do not infer it, and do not assume the owner did. GitHub refuses to
reopen a closed PR whose head was force-pushed, so a narrowed branch needs a fresh PR number.

**Do not verify a deploy by exact SHA match when merges land minutes apart** — test that the serving revision
is a DESCENDANT of yours (`git merge-base --is-ancestor`). The GitHub deployment row appears ~5 s after the
merge and is how you tell a real Railway build from an auto-deploy that silently lost the race. `secret-scan`
having no run on a merge commit is CORRECT — `security-scan.yml` is `on: pull_request` + a daily schedule,
never `push`.
