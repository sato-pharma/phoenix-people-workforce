# Current Operating State

Last updated: 2026-07-20

This document is the current source of truth for how Phoenix Workforce should be edited, deployed, and verified.

## Git Branches

`main` is production-only.

- Do not edit `main` directly.
- `main` should stay aligned with the live production deployment.
- Production deploys should happen only after validation and explicit approval.
- New feature work, function edits, fixes, and experiments happen on a focused
  `codex/<task>` branch/worktree per AGENTS.md's Branch And Change Isolation rules,
  opened as a PR against `main`.

There is no more single long-lived "working branch" with its own live preview
deployment — that was a Vercel-era model. `ci.yml` does still push-trigger (not just
PR-trigger) on `codex/work-from-production` specifically, alongside `main`/`master`;
verify this branch's actual current state before treating it as "the" active branch
for new work.

## Hosting

Production and staging both run on **GCP Cloud Run** (migrated off Vercel):

| Purpose | Cloud Run service | Region | URL |
| --- | --- | --- | --- |
| Production | `phoenix-hr` | `europe-west3` | https://phoenix-hr.satopharma.com |
| Staging | `phoenix-hr-staging` | `us-central1` | see AGENTS.md Stable Environment Facts |

Both deploy **from `main`**, automatically, after CI succeeds (`workflow_run` trigger
on `deploy-cloud-run.yml` / `deploy-cloud-run-staging.yml`) — there is no per-branch
preview URL. Each deploy builds a new image, deploys it as a new revision with no
traffic, smoke-tests that revision directly, then promotes to 100% traffic. Staging
has its own isolated Supabase project (`cifwmndunmlxjhyjugxa`), not a read-only
mirror of production data.

## Deployment Rules

Production deploy rule:

1. Work on a branch/worktree, not directly on `main`.
2. Validate locally (`pnpm run check:harden`).
3. Push, open a PR, confirm CI is green (including the `preview-smoke` job — a
   Playwright smoke test run inside the CI runner against staging Supabase, not a
   deployed preview despite the name).
4. Merge to `main` after approval.
5. Both Cloud Run deploy workflows fire automatically; verify production at
   `https://phoenix-hr.satopharma.com` once promoted.
6. Confirm the public production domain is serving the newest revision, not just
   the workspace-internal Cloud Run URL.

Always verify the exact public domain:

```text
https://phoenix-hr.satopharma.com
```

## Cloud Scheduler Cron Model

Google Cloud Scheduler drives five jobs (provisioned by `scripts/setup-gcp-cron.sh`,
last aligned 2026-07-17), authenticated via `Bearer $CRON_SECRET` against the public
domain, scheduled in **Africa/Cairo** time:

- `phoenix-notify-daily` — 6:36 AM — `/api/notifications/daily` (consolidated daily
  run: birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment,
  resignation SLA, weekly-plan drift check, Telegram HR digest)
- `phoenix-process-notifications` — every 5 min — `/api/notifications/process?limit=50`
  (drains the notification outbox, probation reminders, deferred/Telegram retries;
  also a keep-warm heartbeat)
- `phoenix-background-jobs` — Fridays 3:00 AM — `/api/cron/background-jobs?limit=10`
  (drains queued admin-requested exports)
- `phoenix-ireports360-sync` — 9:07/12:07/19:07 AM — syncs iReports360 CRM visits
  (rolling 10-day lookback) + probation double-visit auto-tick
- `phoenix-reconcile-visits` — Sundays 4:24 AM — weekly wide reconciliation over a
  rotating 30-day slice of a 120-day window

Notification outbox and probation reminder processing run through:

```text
src/lib/notifications/scheduled-processing.ts
```

Unlike the old Vercel-cron model, Cloud Scheduler has no plan-tier frequency limit —
the 5-minute drain schedule is not gated on any paid tier. All five crons carry an
explicit `maxDuration = 300` and a named Healthchecks.io dead-man's-switch heartbeat
(`withDeadMansSwitch`) — see [Observability](observability.md). The in-app `/admin/cron-control` dashboard can
view/pause/resume/run/reschedule these live, but does not update
`setup-gcp-cron.sh` — keep that script's flags in sync by hand after any live
reschedule.

## Local Vercel Metadata

`.vercel/` may still exist locally as inert Vercel CLI metadata from before the
Cloud Run migration.

- It is intentionally ignored in `.gitignore`.
- It should not be committed.
- It does not represent application code, and nothing in the running app reads it.
- It can exist locally without making the Git working tree dirty.

## Security And Dependency State

Current dependency status:

- `pnpm audit --audit-level=low`: 0 vulnerabilities
- GitHub Dependabot open alerts: 0
- `xlsx` was removed and replaced with `exceljs`
- Next.js is pinned to `16.2.6`

If GitHub reports new security alerts, treat them as a separate security cleanup task.

## Validation Gates

Before pushing code or deploying production, run the relevant checks:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm audit --audit-level=low
```

For documentation-only changes, a full build is optional, but `git diff --check` should still pass.

## Current Workflow Summary

Use this rule:

```text
Work on a codex/<task> branch or worktree, PR'd against main.
Validate via CI (lint, typecheck, test, build, staging-pointed smoke test).
Keep main as production.
Merge only after CI is green and approval is given.
Cloud Run auto-deploys both production and staging from main after merge.
```
