# Deployment

## Infrastructure

Phoenix Workforce is deployed on **GCP Cloud Run** with a Supabase PostgreSQL backend.
Hosting migrated off Vercel; Vercel is legacy/decommissioned (no runtime dependency —
see `docs/disaster-recovery-runbook.md` § Vercel retirement).

| Component | Service | Notes |
|---|---|---|
| Application hosting (production) | GCP Cloud Run | Service `phoenix-hr`, project `phoenix-workforce-498619`, region `europe-west3` |
| Application hosting (staging) | GCP Cloud Run | Service `phoenix-hr-staging`, same project, region `us-central1` |
| Database + Auth | Supabase | Separate production (`ozucdzovmcqvepbozvqf`) and staging (`cifwmndunmlxjhyjugxa`) projects |
| Scheduled jobs | Google Cloud Scheduler | See "Cron Jobs" below |
| Email delivery | Resend | — |
| Error monitoring | Self-hosted (app_error_events + Cloud Logging) | Included in GCP |
| Attendance agent | Local Windows machine | — |

## Branch Model

| Branch | Purpose | Deployment |
|---|---|---|
| `main` | Production only | Auto-deploys to production AND staging on CI success |
| feature/task branch | Active development | No live deployment — verified via CI's `preview-smoke` job (a local Playwright run inside the CI runner, not a deployed URL) and local dev testing |

Never push directly to `main`. Work happens on a branch/PR, merges after CI passes,
then the deploy workflows take over automatically. There is no per-branch preview
deployment in the old Vercel sense — see "Deployment Workflow" below for what
verification actually happens pre- vs post-merge. The current active
working-branch convention (if any beyond ad hoc `codex/<task>` branches) is
documented in [current-operating-state.md](current-operating-state.md).

## Deployment Workflow

1. Develop on a branch/worktree, open a PR to `main`.
2. `.github/workflows/ci.yml` runs on the PR: `validate` (routes/migrations/stale-domain
   checks, audit, build), `lint-typecheck`, and `preview-smoke` (a Playwright login
   smoke test run against the built app **inside the CI runner**, pointed at the
   staging Supabase project — despite the job name, this does not deploy or hit any
   live preview URL).
3. Run `pnpm run check:harden` locally too (lint + typecheck + test + build).
4. After merge to `main`, CI runs again; on success, `deploy-cloud-run.yml` (production)
   and `deploy-cloud-run-staging.yml` (staging) both trigger via `workflow_run` and
   deploy independently. Each builds a new image, deploys it as a new revision with
   **no traffic**, smoke-tests that specific revision (healthz/login/webhook/cron-auth
   checks), and only then promotes it to 100% traffic — a failing revision never
   takes live traffic.
5. Verify the production deployment at the public domain; staging is separately
   browsable at its own Cloud Run URL for manual QA against staging data (see
   AGENTS.md's Stable Environment Facts for both URLs).

## Production Verification

Always verify the exact public production domain after deployment:
https://phoenix-hr.satopharma.com

Do not rely on the workspace-internal Cloud Run URL
(`https://phoenix-hr-897559113412.europe-west3.run.app`) alone — confirm the public
domain mapping is serving the same revision.

## Database Deployment

Application deploys are not complete until matching database migrations have been applied. See docs/migrations.md for the migration policy — there is currently no scripted production-migration approval pipeline (the prior phase28-36 scripts were retired 2026-07-11); applies go through the Supabase MCP/CLI directly with explicit approval, and a daily CI job (`.github/workflows/migration-drift-check.yml`) catches anything merged but never actually applied.

## Cron Jobs (Google Cloud Scheduler)

`scripts/setup-gcp-cron.sh` provisions five jobs against the public domain,
authenticated via a `Bearer $CRON_SECRET` header, scheduled in **Africa/Cairo**
time (last aligned 2026-07-17 — schedules are deliberately de-collided so no two
jobs share a firing minute):

| Job | Schedule (Cairo) | Endpoint | Purpose |
|---|---|---|---|
| `phoenix-notify-daily` | 6:36 AM daily | `/api/notifications/daily` | Consolidated daily run: birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift check, Telegram HR digest |
| `phoenix-process-notifications` | every 5 min | `/api/notifications/process?limit=50` | Drains the notification outbox, probation reminders, and deferred/Telegram delivery retries (`src/lib/notifications/scheduled-processing.ts`); also doubles as a keep-warm heartbeat |
| `phoenix-background-jobs` | Fridays 3:00 AM | `/api/cron/background-jobs?limit=10` | Drains queued admin-requested exports, sends a Super-Admin Telegram recap |
| `phoenix-ireports360-sync` | 9:07/12:07/19:07 AM daily | `/api/cron/ireports360-visits-sync` | Syncs iReports360 CRM visits (rolling 10-day lookback) + probation double-visit auto-tick |
| `phoenix-reconcile-visits` | Sundays 4:24 AM | `/api/cron/ireports360-visits-reconcile` | Wide reconciliation over a rotating 30-day slice of a 120-day window |

The Scheduler job **location** metadata stays `us-central1` regardless of which
region the app itself runs in — jobs only fire HTTP requests, so the location is
irrelevant to latency and moving it would mean delete+recreate for no benefit. Every
cron carries an explicit `maxDuration = 300` and a named Healthchecks.io dead-man's-switch
heartbeat (`withDeadMansSwitch`) — see [Observability](observability.md). The in-app
`/admin/cron-control` dashboard can view/pause/resume/run/reschedule these live, but editing a schedule
there does **not** update `setup-gcp-cron.sh` — keep the script's `--schedule`/
`--time-zone` flags in sync by hand, or a future re-run of the script will silently
revert the change. Unlike the old Vercel-cron model, Cloud Scheduler has no
plan-tier frequency limit.

## Environment Variables

Production environment variables are configured directly on the Cloud Run service
(`gcloud run services update phoenix-hr --update-env-vars ...`), not in a Vercel
dashboard. See docs/environment.md for the full list and .env.github-secrets.example
for variables needed in GitHub Actions.

## Staging Environment Safety

Staging (`phoenix-hr-staging`) points at its own isolated Supabase project
(`cifwmndunmlxjhyjugxa`) — no shared third-party secrets with production. It is not
a read-only mirror of production data the way the old Vercel preview was; it has
its own staging dataset. `PHOENIX_PREVIEW_READ_ONLY` / the `proxy.ts` preview-read-only
guard are legacy from the Vercel-preview model and are inert on Cloud Run (neither
environment sets `APP_ENV=preview`) unless deliberately reused for some future
read-only surface.

## Rollback

Cloud Run keeps prior revisions; traffic can be moved back instantly with no rebuild:

```bash
gcloud run services update-traffic phoenix-hr \
  --region=europe-west3 --project=phoenix-workforce-498619 \
  --to-revisions <GOOD_REVISION>=100
```

See docs/disaster-recovery-runbook.md for the full incident-response procedure. For
database rollbacks, see docs/migrations.md.
