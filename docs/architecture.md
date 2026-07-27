# Architecture

## Overview

Phoenix Workforce is a monolithic Next.js application that combines UI, route handlers, and domain services in one repository. The product centers on workforce operations: employee data, payroll, expenses, offers, approvals, notifications, and sales-linked reporting.

## Runtime Shape

- `app/` contains App Router pages and `app/api/*` route handlers
- `src/lib/` holds domain services and integration logic
- `src/components/` contains UI composition for dashboards, tables, forms, and workflows
- `supabase/` contains SQL used to evolve schema, enforce RLS, and harden operational behavior

## Workflow Governance and Route Layout

Approval state machines are split between the workflow registry and hardcoded TypeScript
tables, and admin pages are split across the `(admin)` route group and a few standalone
routes. Both distinctions — with the per-module governance table, the `leave_requests`
registry-key alias, and route/app-shell ownership rules — are documented in
[Workflow & Route Architecture](workflow-and-route-architecture.md).

## Main Domains

### Auth and Access

- Request access is resolved in server-side auth helpers
- Session signing is application-managed and now fail-closed on missing secrets
- Access control combines application permission checks with Supabase RLS for user-scoped reads

### Employees and Lifecycle

- Employee data powers directory, lifecycle events, resignation handling, and vacancy creation
- Vacancy is represented in **two deliberately separate models** — `public.position_vacancies`
  (what we are recruiting for) and the `au` seat model (which sales area is staffed, and when).
  See [Two vacancy models](area-unification/vacancy-models.md) before changing either
- Imports and bulk actions bring operational data into the platform
- Arabic name fields already exist in the model and affect future localization requirements

### Offers and Hiring

- Public offer links render confirmation pages
- State mutation is performed through explicit `POST` handlers
- Final approval and employee-creation flows are moving into transactional database RPC paths

### Payroll and Expenses

- Payroll batches, salary records, flags, and expense imports are core financial workflows
- Recent hardening moved high-risk reads away from broad service-role defaults
- Transactional handling is required for imports and approval chains to avoid partial financial state

### Sales and Reporting

- Sales imports feed dashboards and period reporting
- Reporting now uses real datasets instead of placeholder randomization in overview calculations

### Notifications

- Notifications are shifting to an outbox-based model with idempotency and retries
- Test and processor endpoints require tighter access control because they can create operational side effects

## Data Access Model

- Supabase remains the system of record
- User-scoped reads should prefer authenticated request-scoped clients with RLS
- Service-role access should be reserved for tightly bounded server-only tasks
- SQL hardening scripts in `supabase/` are part of the application delivery surface, not optional extras

## Delivery and Validation

- CI now runs lint, typecheck, test, and build in sequence
- Production readiness depends on both application deployment and coordinated Supabase SQL rollout

## Current Git And Deployment Model

- `main` is production-only. Do not edit it directly.
- Feature work happens on a `codex/<task>` branch/worktree, PR'd against `main`.
- Production public domain: `https://phoenix-hr.satopharma.com` (GCP Cloud Run, service `phoenix-hr`, `europe-west3`).
- Cloud Run auto-deploys both production and a separate staging service (`phoenix-hr-staging`, `us-central1`) from `main` after CI passes — there is no per-branch preview deployment.
- The exact public production domain must be checked after every production deploy — confirm the public domain mapping is serving the same revision as the workspace-internal Cloud Run URL.
- Deployment mapping and the Cloud Scheduler cron model are documented in [current-operating-state.md](current-operating-state.md).

## Current Cloud Scheduler Cron Model

Google Cloud Scheduler drives five jobs (see `scripts/setup-gcp-cron.sh`),
authenticated via a `Bearer $CRON_SECRET` header against the public domain,
scheduled in Africa/Cairo time:

- `/api/notifications/daily` -- once daily (6:36 AM Cairo); internally runs
  birthdays, contract renewals, and the other daily SLA/digest jobs.
- `/api/notifications/process?limit=50` -- every 5 minutes; drains the
  notification outbox, probation reminders, and deferred/Telegram delivery retries.
- `/api/cron/background-jobs?limit=10` -- weekly (Fridays); drains queued
  admin-requested exports.
- `/api/cron/ireports360-visits-sync` -- 3x daily; syncs iReports360 CRM visits.
- `/api/cron/ireports360-visits-reconcile` -- weekly; wide reconciliation over a
  rotating slice of a 120-day window.

Notification outbox and probation reminder processing are shared through
`src/lib/notifications/scheduled-processing.ts` and run from the 5-minute
outbox-drain job. Unlike the retired Vercel-cron model, Cloud Scheduler has no
plan-tier frequency limit. All five crons carry an explicit `maxDuration = 300` and
a named `Sentry.withMonitor` heartbeat.

## Current Gaps

- Localization is not centralized even though Arabic data already exists
- Some workflows still depend on disciplined server-side access boundaries rather than uniformly mature database policy coverage
