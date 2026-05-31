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
| Working preview | `codex/work-from-production` | https://phoenix-workforce-git-codex-c8df8e-phoenix-workspace-s-projects.vercel.app |

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

## Vercel Hobby Cron Constraint

The current Vercel account is on Hobby limits.

Vercel Hobby allows:

- maximum 2 cron jobs
- cron jobs no more frequent than daily

The production-compatible cron setup is:

- `/api/notifications/birthdays` at `0 4 * * *`
- `/api/notifications/contract-renewals` at `15 4 * * *`

The old `*/15 * * * *` notification-processing cron is not allowed on Hobby. Notification outbox and probation reminder processing are folded into the daily contract-renewal cron through:

```text
src/lib/notifications/scheduled-processing.ts
```

If sub-daily notification processing is needed later, upgrade Vercel to Pro or move that scheduler outside Vercel Cron.

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
