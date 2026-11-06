# Architecture

The domain-level narrative for Phoenix Workforce. Operating rules (branching, approval,
validation, worktrees) live in [AGENTS.md](../AGENTS.md); daily commands and the protected-file
gate live in [CLAUDE.md](../CLAUDE.md).

## Overview

Phoenix Workforce is a **monolithic Next.js 16 (App Router) + React 19 + Supabase (Postgres)**
HR/workforce platform. UI, route handlers, and domain services live in one repo. Styling is
Tailwind CSS v4 + shadcn (radix-ui primitives, lucide icons). The product centers on workforce
operations: employee data, payroll, expenses, offers, approvals, notifications, and sales-linked
reporting.

## Layout

- `app/` — App Router pages and `app/api/**/route.ts` handlers. Two UIs share the app: the
  **admin** surface (`app/admin`, `app/employees`, `app/payroll`, …) and the **employee portal**
  (`app/employee-portals/**`). Which one a user lands in is decided by role via
  `resolveNavigationMode` in `src/lib/auth/permissions.ts`.
- `src/lib/<domain>/` — domain services and data access (the source of truth for business rules).
  Domains include `payroll`, `expenses`, `outstation`, `coaching`, `sales`, `vacation`/leave,
  `resignations`, `probation`, `offers`, `contracts`, `marketing-requests`, `workforce`,
  `notifications`, `auth`, `supabase`, `workflow-registry`, and more.
- `src/components/<domain>/` and `src/components/ui/` — UI composition and shared primitives.
- `src/config/` — `system-settings.ts` (brand, deploy URLs, email defaults, editing policy) and
  `system-navigation.ts` (sidebar/nav source of truth).
- `supabase/` — SQL. **`supabase/migrations/` holds the timestamped migrations**
  (`YYYYMMDDHHMMSS_*.sql`) that define the live schema/RLS; the loose `*.sql` files at the
  `supabase/` root are historical hardening/setup scripts. Treat SQL here as part of the
  deliverable, not optional extras. A new one is scaffolded by the `new-migration` skill
  (`.claude/skills/new-migration/SKILL.md`), which mints a timestamp that sorts after every
  migration already on `main` and pre-flights the four content rules CI enforces; a prefix that
  merely sorts early breaks no check and then applies in the wrong order for good.
- `tests/` (unit) and `tests/e2e/` (Playwright). `docs/` holds architecture, editing, security,
  and operating-state notes.
- `local-attendance-agent/` — a separate local .NET/PowerShell ZKTeco attendance agent (see its
  own README); not part of the Next.js build.

## Domain-first rule

Business logic lives in `src/lib/<domain>/`. Pages and components **call domain services**; they
must not re-implement payroll, leave, expense, outstation, HR, or sales rules inline. When
changing behavior, start in `src/lib/<domain>/`.

## Auth and access control (read these three together)

This is the most important cross-cutting system.

- `src/lib/auth/permissions.ts` — the heart. Defines `PhoenixRole` (15 roles),
  `PermissionResource`/`PermissionAction`, the **`defaultPermissionMatrix`** (role → resource →
  allowed actions), and `AccessContext` (`{ hrId, loginId, role, scope, source }`). Scope
  (`self`/`team`/`hierarchy`/`line`/`company`/`system`) drives row-level visibility helpers like
  `canAccessPayroll`, `canAccessSales`, `canSeeEmployee`, `filterEmployeesForAccess`. The matrix is
  overridable at runtime from the `role_permission_overrides` table (cached ~30s).
- `src/lib/auth/server.ts` — `resolveAccessContext(request)` (API routes) and
  `resolveAccessContextFromPage()` (server components) turn a request/cookies into an
  `AccessContext` by verifying the application-signed session cookie against `app_auth_users`.
  Sessions are rejected on inactive user, role change, or session-version mismatch (all audited).
- `src/lib/supabase/server.ts` — two clients: `getSupabaseAdmin()` (service role, **bypasses
  RLS**, server-only/admin/system use) and `getSupabaseUserClient()` (anon key, **respects RLS**).
  Prefer RLS-respecting access for user-scoped reads; reserve the admin client for tightly bounded
  server tasks.

**Auth is application-managed, not Supabase Auth.** Login uses HR_ID + password (`bcryptjs`) and an
app-signed session token; password setup is via one-time links. Session signing is fail-closed on
missing secrets.

Vacancy is represented in **two deliberately separate models** — `public.position_vacancies` (what
we are recruiting for) and the `au` seat model (which sales area is staffed, and when). See
[Two vacancy models](area-unification/vacancy-models.md) before changing either.

## API route convention

Route handlers follow a consistent shape (see `app/api/coaching/` as the reference):

1. `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`.
2. Resolve the caller: `resolveAccessContext(request)`.
3. Enforce permission with `assertPermission(ctx, resource, action)` (throws `Forbidden: ...`) or a
   domain `require*Permission` helper, before any mutation.
4. Delegate work to the `src/lib/<domain>/service.ts`.
5. Catch errors and map them to HTTP status via a shared `jsonError`-style helper (forbidden → 403,
   not authenticated → 401, not found → 404, validation → 400, conflict → 409). `isForbiddenError`
   keys off the `Forbidden:` message prefix.

Always enforce access on the server even though `system-navigation.ts` already hides links —
sidebar visibility is UX, never the security boundary.

## State-machine workflows

Approval flows (payroll, resignations, probation, contracts, outstation, offers, marketing
requests) are governed by the **workflow registry** (`src/lib/workflow-registry/service.ts`):
modules define `statuses` and `actions` (allowed `from`→`to`, `allowedRoles`, `requiresReason`,
side effects, audit log, notifications). Transitions validate against the registry and write audit
logs. Approval state machines are split between the workflow registry and hardcoded TypeScript
tables, and admin pages are split across the `(admin)` route group and a few standalone routes —
both distinctions are documented in
[Workflow & Route Architecture](workflow-and-route-architecture.md).

## Notifications and cron

Notifications use an outbox model with idempotency and retries. The project runs on **Railway**;
the cron routes are driven by **cron-job.org**, a free-tier third-party account **outside this
repo** (Bearer `$CRON_SECRET`, Africa/Cairo time) — daily notifications, outbox processing (every
5 min), background exports (Fri), inbound intake, recruitment email intake, and the iReports360
visit-sync jobs.

🔴 **`scripts/setup-gcp-cron.sh` is NOT the schedule source of truth any more.** The live schedule
exists only in the cron-job.org account — nothing in git can show or change it. The 8 Google Cloud
Scheduler jobs still fire but **401 on every route**, so their existence is not evidence anything is
running. [deployment.md](deployment.md) has the current job inventory and the 30-second-timeout
trap; [observability.md](observability.md) covers the dead-man's-switch.

Every cron sets `maxDuration = 300` and carries a named Healthchecks.io dead-man's-switch heartbeat
(`withDeadMansSwitch`). Notification outbox and probation reminder processing are shared through
`src/lib/notifications/scheduled-processing.ts` and run from the 5-minute outbox-drain job.

**iReports360 is retired** (6 November 2026). The continuous CRM live poll, the scheduled visit-sync
and weekly reconcile jobs, the contact-list rebuild and their Healthchecks slugs are gone, and the
`IREPORTS360_*` secrets are no longer read; the mirrored iReports360 rows stay, and their readers keep
working. `PHOENIX_LIVE_CRM_POLL=true` keeps its old name but now gates only the two in-process timers
started from `instrumentation.ts` — the Early Birds fortnight close and the CRM housekeeping timer
(`src/lib/platform/in-process-host.ts`) — with a production build and Railway's production
environment, so neither can run from a dev machine.

The in-app `/admin/cron-control` dashboard is a UI over the **dead** GCP Cloud Scheduler
(`src/lib/cron-control/*`) and is inert — pausing or rescheduling a job there changes nothing that
actually runs. Use the cron-job.org account instead.

## Deployment model

🔴 **A merge to `main` ships to production immediately.** Railway is GitHub-connected and deploys on
push, at **full traffic**, within minutes — no staged rollout, no no-traffic revision, no smoke
test, no cron wait. Branch protection gates the *merge* (2 required status checks must be green —
`validate` and `checks`; `mobile` and `secret-scan` were demoted 2026-09-29 and taken off
`pull_request` in the same change, so they block nothing and report nothing on a PR — they still run
on `main`, a schedule and a dispatch), but once merged it is live. That list has rotted five times,
so read `branches/main/protection/required_status_checks` live rather than counting against it.
Never merge anything you are not willing to have serving employees within minutes.

This reversed on 2026-08-01 and is the single most important fact to relearn: the old Cloud Run
pipeline deployed a no-traffic revision, smoke-tested it, then promoted — and ran on a schedule
rather than on merge. All of that is gone.

`main` is production-only — never edit it directly. Production public domain:
`https://phoenix-hr.satopharma.com` (Railway service `phoenix-people-workforce`, region
`europe-west4-drams3a` — Amsterdam, EU West, colocated with the Frankfurt Supabase project on
purpose; see [AGENTS.md](../AGENTS.md) § Stable Environment Facts).
There **is** a staging app — a second Railway environment (`staging`) of the same service, at
`https://phoenix-people-workforce-staging.up.railway.app`, pointed at the staging Supabase project.
But there is still no per-branch preview deployment: staging tracks `main` too, so it normally
serves the same commit production does. To confirm what is actually live, request `/api/healthz`
on **the production domain** and read `revision` — the running commit SHA — rather than trusting a
workflow list, a merged PR, or a staging response. See
[deployment.md](deployment.md) § Staging Environment for what staging can and cannot verify.

Full triggers, timing caveats, and verification commands live in
[AGENTS.md](../AGENTS.md) (§ Stable Environment Facts, § Hard-Learned Rules) and
[current-operating-state.md](current-operating-state.md).

## Conventions

- **Path alias:** `@/*` resolves to both `./*` and `./src/*` (see `tsconfig.json`). TS strict mode
  is on; `.ts` extension imports are allowed.
- **HR_ID is the employee key**, not a DB id. Normalize/compare via the helpers in
  `src/lib/hr-id.ts` and `permissions.ts` (`normalizeHrId`, `hrIdsMatch`) — never compare raw
  strings.
- **Global edit points** (don't hunt): brand/URLs/email → `src/config/system-settings.ts`;
  sidebar/nav/roles → `src/config/system-navigation.ts`; design tokens → `src/styles/tokens.css` +
  `app/globals.css`; shared primitives → `src/components/ui/`. Full table in
  [editing-guide.md](editing-guide.md).
- **i18n:** Arabic data exists in the model; locale/format helpers are in `src/lib/i18n/`
  (`config.ts`, `format.ts`) but localization is not yet centralized.
- **Security headers / CSP** are defined in `next.config.ts`.
- **Local dev auth:** with `NODE_ENV=development`, `GET /api/dev-auth?role=...` sets a dev-preview
  session cookie so you can browse as any role on localhost (disabled in production).
  `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` additionally allows `x-phoenix-role` / `x-phoenix-hr-id`
  request headers locally.

## Tests

- Unit/integration tests live in `tests/*.test.ts`. Each file **exports** a `run<Name>Tests()`
  function using `node:assert/strict` and importing domain code directly with `.ts` extensions.
- They are executed as one aggregated suite by `tests/run-tests.ts`, run via Node with
  type-stripping and a custom `@/` alias resolver (`tests/alias-loader.mjs`). There is **no
  per-test filter flag**; to isolate a test temporarily comment out the other `runTest(...)` lines.
  **When you add a test file, wire its exported function into `tests/run-tests.ts` or it will not
  run.**
- End-to-end tests use Playwright (`tests/e2e/*.spec.ts`, config `playwright.config.ts`). Run with
  `pnpm exec playwright test`. An auth `setup` project signs in first and stores browser state;
  `*.data-bearing.spec.ts` only runs when `PLAYWRIGHT_DATA_USER_HRID` /
  `PLAYWRIGHT_DATA_USER_PASSWORD` are set.

## Database and RLS scripts

Many `db:*` and `phaseNN:*` package.json scripts (Node + type-stripping) validate Supabase RLS,
role alignment, and the staged production-migration approval pipeline. These talk to
staging/production Supabase and gate migrations — do not run them casually; treat them as the
migration safety harness described in `docs/security/`.

All schema changes must be migration-based, repeatable, reviewable, and rollback-aware. Never patch
production manually.

## Required environment

Server reads these (via `process.env`, see `src/lib/supabase/server.ts` and auth libs):
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, plus the
session-signing secret and email/Google Maps keys used by their respective domains. Full list in
[environment.md](environment.md).

## Current gaps

- Localization is not centralized even though Arabic data already exists.
- Some workflows still depend on disciplined server-side access boundaries rather than uniformly
  mature database policy coverage.
