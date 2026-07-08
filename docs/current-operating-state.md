# Current Operating State

Last updated: 2026-05-25

This document is the current source of truth for how Phoenix Workforce should be edited, deployed, and verified.

## Git Branches

`main` is production-only.

- Do not edit `main` directly.
- `main` should stay aligned with the live production deployment.
- Production deploys should happen only after validation and explicit approval.

`codex/work-from-production` is the active working branch.

- New feature work, function edits, fixes, and experiments should start here.
- This branch was created from the current production code line.
- Pushes to this branch create/update the Vercel preview deployment.
- Promote changes to `main` only after preview validation.

## Vercel Deployments

The project should keep only two active Vercel deployments:

| Purpose | Branch | URL |
| --- | --- | --- |
| Production | `main` | https://phoenix-workforce.vercel.app |
| Working preview | `codex/work-from-production` | https://phoenix-workforce-git-co-c8df8e-phoenix-hr-workspace-s-projects.vercel.app |

Old Vercel deployments were intentionally removed to reduce confusion. The working preview URL above is the stable branch alias; the underlying deployment-specific URL changes after each branch push. Do not delete the active production deployment or the latest active preview deployment unless explicitly replacing them with newer deployments for the same purpose.

The working preview is configured as a production-data read-only environment. It can read production Supabase data so dashboards are realistic, but Vercel Preview must keep `PHOENIX_PREVIEW_READ_ONLY=true`. With that flag enabled, `proxy.ts` blocks Preview mutations except authentication login/logout/heartbeat. Do not point Preview at production Supabase unless this guard is deployed and enabled.

## Deployment Rules

Production deploy rule:

1. Work on `codex/work-from-production`.
2. Validate locally.
3. Push the branch and test the Vercel preview.
4. Merge or apply the approved change to `main`.
5. Deploy or verify production at `https://phoenix-workforce.vercel.app`.
6. Confirm the public production domain points to the newest production deployment, not only the workspace alias.

Always verify the exact public domain:

```text
https://phoenix-workforce.vercel.app
```

Do not rely only on the workspace Vercel alias:

```text
https://phoenix-workforce-phoenix-workspace-s-projects.vercel.app
```

## Vercel Cron Model

The current Vercel account is on **Pro** (confirmed live against the project 2026-07-02, correcting an earlier "Hobby" note).

The production cron setup (`vercel.json`) is:

- `/api/notifications/daily` at `30 6 * * *` -- consolidated daily run (birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift check, Telegram HR digest, outstation geocode warm-up + high-risk digest)
- `/api/notifications/process?limit=50` at `*/30 * * * *` -- drains the notification outbox faster than once a day, plus probation reminders, deferred/Telegram delivery retries, and misc housekeeping (stale-run reaping, retention)
- `/api/cron/ireports360-visits-sync` at `0 9,12,19 * * *` -- syncs iReports360 CRM visits (rolling 10-day lookback) + probation double-visit auto-tick
- `/api/cron/ireports360-visits-reconcile` at `0 4 * * 0` -- weekly wide reconciliation over a rotating 30-day slice of a 120-day window

The `*/30 * * * *` schedule is only possible because the account is Pro -- Vercel Hobby hard-fails deployment for any cron more frequent than daily. Notification outbox and probation reminder processing run through:

```text
src/lib/notifications/scheduled-processing.ts
```

All 4 crons carry an explicit `maxDuration = 300` and a named `Sentry.withMonitor` heartbeat — see [Observability](observability.md).

If the Vercel plan is ever downgraded to Hobby, fold outbox draining back into the single daily cron or move it to an external scheduler first.

## Local Vercel Metadata

`.vercel/` is local Vercel CLI project metadata.

- It is intentionally ignored in `.gitignore`.
- It should not be committed.
- It does not represent application code.
- It can exist locally without making the Git working tree dirty.

## Security And Dependency State

Current dependency status:

- `npm audit --audit-level=low`: 0 vulnerabilities
- GitHub Dependabot open alerts: 0
- `xlsx` was removed and replaced with `exceljs`
- Next.js is pinned to `16.2.6`

If GitHub reports new security alerts, treat them as a separate security cleanup task.

## Validation Gates

Before pushing code or deploying production, run the relevant checks:

```bash
npm run typecheck
npm run test
npm run build
npm audit --audit-level=low
```

For documentation-only changes, a full build is optional, but `git diff --check` should still pass.

## Current Workflow Summary

Use this rule:

```text
Edit on codex/work-from-production.
Validate on preview.
Keep main as production.
Deploy production only after approval.
```
