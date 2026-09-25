---
name: healthchecks-live-8-checks-configured
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Healthchecks.io cron-liveness monitor is LIVE and configured (8 checks, Cairo cron, email+Telegram) — unblocks the Sentry-retirement PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 516a53ef-c89e-4a6c-a03a-f0eb456de1af
  modified: 2026-07-31T19:49:17.245Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**Status 2026-07-31 19:48 UTC: all 8 checks exist, are configured, and are `up`.** This was the blocker on PR #1514 (Sentry retirement) — it is now cleared.

**What was already true before today:** the account existed, `HEALTHCHECKS_PING_KEY` was already set on the `phoenix-hr` production service, and 7 of 8 checks had been auto-created by real cron pings (7 slugs returned `OK`/200 on a manual ping, only `phoenix-background-jobs` returned `Created`/201 — the weekly Friday job had never fired since the key was set). Zero `deadmans_switch_ping_failed` warnings in 7 days of prod logs. So the switch was working; only the schedules were unconfigured.

**Configured via the Management API** (`https://healthchecks.io/api/v3`, header `X-Api-Key`, script kept at `scratchpad/configure-healthchecks.py` — idempotent, re-runnable, reads key from `HC_API_KEY` env var). All 8 set to **Cron Expression mode + `Africa/Cairo`**, cron strings copied verbatim from `scripts/setup-gcp-cron.sh`:

| slug | cron | grace |
|---|---|---|
| phoenix-notify-daily | `36 6 * * *` | 60m |
| phoenix-process-notifications | `*/5 * * * *` | 10m |
| phoenix-background-jobs | `0 3 * * 5` | 120m |
| phoenix-inbound-intake | `*/2 * * * *` | 10m |
| phoenix-ireports360-sync | `7 9,12,19 * * *` | 30m |
| phoenix-reconcile-visits | `24 4 * * 0` | 120m |
| phoenix-ireports360-live-sync | `1,16,31,46 8-12 * * *` | 15m |
| phoenix-recruitment-email-intake | `4-59/10 * * * *` | 10m |

**Grace rule:** grace must exceed the job's *max runtime* (routes carry `maxDuration` 300s / 120s), not merely its nominal period — a slow-but-successful run otherwise trips a false alarm. That's why the `*/2` job gets 10m, not 2m.

**Notifications verified wired:** two channels (email + Telegram) attached to **all 8** checks — a red check actually reaches someone. Confirmed via `/api/v3/channels/` and each check's `channels` field.

**Proof it works end-to-end:** `phoenix-inbound-intake` and `phoenix-recruitment-email-intake` recorded REAL cron pings minutes after configuration (not my provisioning pings).

**Gotchas:**
- Auto-provisioned checks default to **1-day period / 1-hour grace**, which silently false-alarms weekly jobs and under-detects `*/2` and `*/5` jobs. Any NEW cron route must get its check tuned after its first ping — the ping URL cannot set schedule/grace (Management API or dashboard only).
- A 9th check `my-first-check` ("My First Check") is the Healthchecks demo default — never pinged, status `new`, harmless; delete when convenient.
- **Never set `HEALTHCHECKS_PING_KEY` on staging.** Slugs are not environment-namespaced and staging runs the same production-built image, so a staging ping would reset (mask) production's checks. See [[claude-config-audit-2026-07-31]].
- The Management API key was pasted into a session transcript on 2026-07-31 — rotate it in Project Settings → API Access if that matters.

Related: [[claude-config-audit-2026-07-31]]
