---
name: railway-http-logs-only-cover-the-current-deployment
description: "Railway HTTP logs are scoped to ONE deployment (a replaced build's logs are gone), a pull without `--since` covers only minutes, and `--path` silently returns nothing — use `-f '@path:...'` plus `--since`, and never read an empty result as \"this route is never called\"."
metadata: 
  node_type: memory
  type: project
  originSessionId: 885945ff-7d14-439a-8530-7a58998f28fa
  modified: 2026-09-15T20:35:34.657Z
---

Verified 2026-08-23 while confirming which `/api/cron/*` routes run on a schedule; refined 2026-09-15 (CLI 5.30.3) while measuring AI suggest timings.

**Three traps, and together they manufacture a confident wrong answer.**

1. **`railway logs --http --path /api/cron/foo` returns NOTHING, always.** The flag is accepted, exits 0, prints zero rows — even for a path you can see in the unfiltered stream seconds earlier. Still true on 2026-09-15: `--path` gave 0 rows where `--filter "@path:..."` gave 127. The filter that works is the query syntax: `railway logs -e production -s phoenix-people-workforce --http --json -f '@path:/api/cron/foo' -n 500`.

2. **Without `--since`, a pull covers only the live build's LAST MINUTES.** A plain `-n 500` pull covered 12 minutes. `--since <ISO timestamp>` (with the deployment id as the positional argument) reaches back to that build's start: on 2026-09-15 it returned 127 AI suggest requests spanning five hours (17:59–23:05 Cairo) that plain pulls had shown as zero.

3. **The window never crosses a deployment.** Once a build is replaced its logs are gone — `railway logs <removed deployment id> --http --since …` answers "Problem processing request" — so `--since 30d` cannot reach past the current build. With ~30 merges a day a build often lives well under an hour (the ~20 minutes measured 2026-08-23 was that build's age, not a fixed window). `railway deployment list --json` gives the ids and which one is live.

So `/api/notifications/daily` and `/api/cron/background-jobs` — both certainly scheduled — returned **zero rows**. An hourly job showed exactly one hit. **An empty Railway HTTP log proves nothing about whether a route is called** — prove the query can see traffic first (count all HTTP rows, or include a known cron path as a control).

**How to actually confirm a cron cadence** (the schedules live only in cron-job.org, which no session can read):
- If the route triggers a GitHub workflow, count its `workflow_dispatch` events: `gh run list --workflow=X.yml --limit 300 --json event,createdAt`. Machine-driven ones cluster on a fixed second past the hour; GitHub's own `schedule` events scatter at random minutes.
- Otherwise use the **side effects with timestamps** — an audit row, a rotated token, a run table. If the work is deterministic when configured and has not happened in N days, nothing is calling it on a cadence shorter than N. That is how both `*-rotate-sheet-token` routes were shown to have no schedule.
- Railway HTTP logs are still good for **who called it** (`clientUa` = `cron-job.org`) once you have a hit — just not for **how often** beyond the live build.

Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]], [[github-actions-cron-secret-went-stale-after-a-railway-rotation]].
