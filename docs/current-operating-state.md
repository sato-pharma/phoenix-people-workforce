# Current Operating State

Last updated: 2026-08-04 (Railway cutover corrections).

> **This file deliberately does not restate hosting, deploy, or cron facts.** It used to, and it
> drifted: after the 2026-08-01 GCP shutdown it still described Cloud Run deploys, a staging app,
> and a Cloud Scheduler cron model for days, because the same facts were written out in four
> different files and only some were corrected. Facts live in one place now, and this file points
> at it.

| You want | Read |
| --- | --- |
| Hosting, deploy workflow, production verification, cron, rollback | [deployment.md](deployment.md) |
| Logging, alerting, health probes, dead-man's-switch | [observability.md](observability.md) |
| Operating rules, approval gates, validation policy | [AGENTS.md](../AGENTS.md) |
| Codebase layout, auth, API conventions, deployment-model summary | [architecture.md](architecture.md) |

The one-line version: **Railway, and a merge to `main` ships to production immediately at full
traffic.** There is no staging app. Confirm what is live with `/api/healthz` → `revision`.

## Git Branches

`main` is production-only.

- Do not edit `main` directly.
- `main` stays aligned with the live production deployment — it *is* the deployment.
- New feature work, fixes, and experiments happen on a focused `codex/<task>` branch/worktree per
  AGENTS.md § 5, opened as a PR against `main`.

There is no long-lived "working branch" with its own live preview deployment — that was a
Vercel-era model. `codex/work-from-production` is not special either: as of 2026-08-04 `ci.yml`
push-triggers on `main` and `master` only. Every other branch is validated through its PR.

## Validation Gates

See [AGENTS.md § 7](../AGENTS.md). The short version: **validate once per task, not once per step** —
make all the edits, then run `pnpm run check:harden` once before you push.

For documentation-only changes a full build is unnecessary; review the diff, links, and secret
exposure, and confirm `git diff --check` passes.

## Local Vercel Metadata

`.vercel/` may still exist locally as inert Vercel CLI metadata from before the Cloud Run migration
(which has itself since been replaced by Railway).

- It is intentionally ignored in `.gitignore`.
- It must not be committed.
- Nothing in the running app reads it, and it does not make the working tree dirty.

## Security And Dependency State

Do not pin dependency versions in this file — the previous copy claimed Next.js `16.2.6` while
`package.json` said `16.2.11`. Read `package.json` for versions.

Standing expectations:

- `pnpm audit --audit-level=low` should report 0 vulnerabilities.
- GitHub Dependabot open alerts should be 0.
- `xlsx` was removed and replaced with `exceljs` — do not reintroduce it.

If GitHub reports new security alerts, treat them as a separate security cleanup task.
