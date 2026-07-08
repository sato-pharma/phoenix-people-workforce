# Deployment

## Infrastructure

Phoenix Workforce is deployed on Vercel with a Supabase PostgreSQL backend.

| Component | Service | Plan |
|---|---|---|
| Application hosting | Vercel | Pro |
| Database + Auth | Supabase | Free/Pro |
| Email delivery | Resend | — |
| Error monitoring | Sentry | Developer (free) |
| Attendance agent | Local Windows machine | — |

## Branch Model

| Branch | Purpose | Deployment |
|---|---|---|
| main | Production only | Auto-deploys to production |
| working branch | Active development | Auto-deploys to preview |

Never push directly to main. All changes go through the working branch and are promoted after validation. The exact working-branch name is documented in [current-operating-state.md](current-operating-state.md).

## Deployment Workflow

1. Develop on the working branch (or a feature branch)
2. Run check:harden locally (lint + typecheck + test + build)
3. Push to trigger Vercel preview deployment
4. Verify the preview deployment
5. Merge/promote to main for production deployment
6. Verify the production deployment at the public domain

## Production Verification

Always verify the exact public production domain after deployment:
https://phoenix-workforce.vercel.app

Do not rely solely on Vercel workspace aliases, as they can diverge from the public domain.

## Database Deployment

Application deploys are not complete until matching database migrations have been applied. See docs/migrations.md for the migration policy and approval workflow.

## Vercel Cron Jobs

`vercel.json` keeps four crons:

| Endpoint | Schedule | Purpose |
|---|---|---|
| /api/notifications/daily | 30 6 * * * (6:30 AM UTC) | Consolidated daily run: birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift check, Telegram HR digest, outstation geocode warm-up + high-risk digest |
| /api/notifications/process?limit=50 | */30 * * * * (every 30 min) | Drains the notification outbox, probation reminders, and deferred/Telegram delivery retries (`src/lib/notifications/scheduled-processing.ts`) faster than once a day |
| /api/cron/ireports360-visits-sync | 0 9,12,19 * * * (3x/day UTC) | Syncs iReports360 CRM visits (rolling 10-day lookback) + probation double-visit auto-tick |
| /api/cron/ireports360-visits-reconcile | 0 4 * * 0 (weekly, Sunday) | Wide reconciliation over a rotating 30-day slice of a 120-day window |

The 30-minute schedule requires Vercel Pro -- Hobby hard-fails deployment for any cron more frequent than daily. Every cron carries an explicit `maxDuration = 300` and a named `Sentry.withMonitor` heartbeat — see [Observability](observability.md). Do not add additional cron jobs, and do not downgrade the Vercel plan, without folding outbox draining back into the daily cron or moving it to an external scheduler.

## Environment Variables

Production environment variables are configured in the Vercel dashboard. See docs/environment.md for the full list and .env.github-secrets.example for variables needed in GitHub Actions.

## Preview Environment Safety

The preview deployment connects to production Supabase for realistic data. The PHOENIX_PREVIEW_READ_ONLY=true flag must be enabled, which blocks all mutations except authentication (login/logout/heartbeat) via the proxy guard in proxy.ts.

## Rollback

Vercel supports instant rollback to any previous deployment. For database rollbacks, see docs/migrations.md.
