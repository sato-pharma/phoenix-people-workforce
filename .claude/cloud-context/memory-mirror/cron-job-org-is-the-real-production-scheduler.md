---
name: cron-job-org-is-the-real-production-scheduler
description: "The live production scheduler is the third-party cron-job.org, not GCP and not Railway's phoenix-cron — proven by clientUa on the HTTP logs"
metadata: 
  node_type: memory
  type: project
  originSessionId: e5a652a2-e36f-4a55-9063-dcb32f0e0fdd
  modified: 2026-08-02T16:16:17.546Z
---

Verified live 2026-08-02 ~08:2x UTC via `railway logs --service phoenix-people-workforce --http --json`
(read `clientUa` + `httpStatus` per `/api/cron/*` request). **Three** schedulers point at production;
only one works:

| Caller | `clientUa` | srcIp | Result |
| --- | --- | --- | --- |
| **cron-job.org** | `Mozilla/4.0 (compatible; cron-job.org; …)` | 116.203.x.x (Hetzner) | **200 — this is the real scheduler** |
| Google Cloud Scheduler | `Google-Cloud-Scheduler` | 34.116.x.x | **401 on every route, always** |
| Railway `phoenix-cron` | — | — | **zero requests, ever** |

This corrects two things at once:
- AGENTS.md §3 "The 8 Cloud Scheduler cron jobs are NOT running" — the *jobs* run, they just 401.
  But the automation they drove **is** happening, via cron-job.org. Do not tell the owner
  notifications/outbox/iReports are stalled without checking this first.
- [[railway-migration-live-topology-and-cli]] correctly found phoenix-cron never reached the app and
  GCP 401s, but predates cron-job.org and so concludes nothing is scheduling. Something is.

🔴 **cron-job.org is undocumented, free-tier, third-party, and outside the repo.** Its schedule
lives only in that account — no config-as-code, no Railway variable, nothing in git. Nobody can
see or change the schedule from this repo. Treat it as a single point of failure that no
runbook mentions.

🔴 **Railway `phoenix-cron`'s start command is a Cairo/UTC landmine if it is ever re-enabled.**
It reads `H=$(date -u +%H)` (UTC) but the hour lists are Cairo wall-clock numbers:
live-sync `H in 08|09|10|11|12`, rolling sync `H in 09|12|19`, reconcile `D=7 H=04 M=25`.
Cairo is UTC+3, so re-enabling it shifts every job **+3h**: the live sync would fire Cairo
11:00–15:45 while `isWithinLiveSyncWindow()` (`src/lib/crm/dates.ts:55`) only admits Cairo
08:30–12:01 — losing the entire 08:30–11:00 early-bird window and no-op'ing the rest. Subtract 3
from every hour before re-enabling.

Also note its `h()` helper uses `curl -sS` **without `--fail`**, so curl exits 0 on a 401 and the
run looks green through a total outage — the same trap recorded in
[[railway-migration-live-topology-and-cli]].

`HEALTHCHECKS_PING_KEY` and `NOTIFICATION_EMAIL_FROM` are both set on the app service now, so the
dead-man's switch is armed and the outbox `skipped` bug is closed.

**Update 2026-08-02 ~19:15 Cairo — job inventory + the 30s cap.** Added the missing weekly reconcile
as **`phoenix-ireports360-reconcile`** (job id 8203342, Sun 07:25 Africa/Cairo, first fire 2026-08-09).
A same-URL duplicate **`phoenix-reconcile-visits`** (id 8200910, Sun 04:24 Cairo — the old GCP time)
was **disabled, not deleted**, so it can be re-enabled if 04:24 is preferred. An abandoned
`phoenix-inbound-intake (Copy)` also sits Inactive.

🔴 **cron-job.org caps request timeout at 30 s on this account and refuses any higher value.** Jobs
whose route runs longer are logged `Failed (timeout)` even though the request WAS delivered and the
server finishes the work (Next.js routes carry `maxDuration = 300`, and `withDeadMansSwitch` pings at
the end, so Healthchecks still sees success). Already biting live: **`phoenix-notify-daily` logs
Failed (timeout) 30.12 s every morning at 06:36**, and `phoenix-ireports360-sync` runs 25.4 s —
one slow month from the same fate. The reconcile takes ~47 s so it will log a weekly timeout too.
Consequences to watch: cron-job.org can auto-disable a job after repeated failures (failure
notifications are OFF, so it would go dark silently). **Never diagnose these as real failures from
the cron-job.org status alone — check `ireports360_visits_sync_runs` / the outbox instead.**

Cloned jobs arrive with **Enable job OFF** — a clone saved without toggling it never runs.

**Update 2026-08-02 ~13:45 Cairo:** PR #1631 (`1af48312`) shipped an IN-PROCESS continuous CRM
poller (`src/lib/crm/live-poller.ts`, started from instrumentation.ts, gated on
`PHOENIX_LIVE_CRM_POLL=true` which is set on `phoenix-people-workforce`). iReports360 freshness no
longer depends on cron-job.org at all — its 15-min `ireports360-visits-live-sync` job is now
REDUNDANT (harmless, idempotent) and can be deleted from the cron-job.org account. The rolling
3x/day sync + weekly reconcile jobs there are still needed (poller horizon is 2 days).
