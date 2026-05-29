# Deployment

## Infrastructure

Phoenix Workforce is deployed on Vercel with a Supabase PostgreSQL backend.

| Component | Service | Plan |
|---|---|---|
| Application hosting | Vercel | Hobby |
| Database + Auth | Supabase | Free/Pro |
| Email delivery | Resend | — |
| Error monitoring | Sentry | Developer (free) |
| Attendance agent | Local Windows machine | — |

## Branch Model

| Branch | Purpose | Deployment |
|---|---|---|
| main | Production only | Auto-deploys to production |
| codex/work-from-production | Active development | Auto-deploys to preview |

Never push directly to main. All changes go through the working branch and are promoted after validation.

## Deployment Workflow

1. Develop on codex/work-from-production (or a feature branch)
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

The Vercel Hobby plan limits cron jobs to 2 daily schedules:

| Endpoint | Schedule | Purpose |
|---|---|---|
| /api/notifications/birthdays | 0 4 * * * (4 AM UTC) | Birthday notifications |
| /api/notifications/contract-renewals | 15 4 * * * (4:15 AM UTC) | Contract renewals + outbox processing + probation reminders |

Do not add additional cron jobs without upgrading the Vercel plan or using an external scheduler.

## Environment Variables

Production environment variables are configured in the Vercel dashboard. See docs/environment.md for the full list and .env.github-secrets.example for variables needed in GitHub Actions.

## Preview Environment Safety

The preview deployment connects to production Supabase for realistic data. The PHOENIX_PREVIEW_READ_ONLY=true flag must be enabled, which blocks all mutations except authentication (login/logout/heartbeat) via the proxy guard in proxy.ts.

## Rollback

Vercel supports instant rollback to any previous deployment. For database rollbacks, see docs/migrations.md.
