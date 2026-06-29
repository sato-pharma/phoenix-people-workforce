# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL EXECUTION RULES (override everything else)

### Task Tracking — every session, every command
1. Use `TaskCreate` to show all planned steps **before** starting any work.
2. Use `TaskUpdate` to mark each step `completed` **immediately** after finishing it — never batch at the end.
3. Never silently skip a task.

### Phased Plans — complete ALL phases
When the user gives a phased plan or a numbered list of steps/orders:
- **Execute EVERY phase completely**, in order.
- **Never stop after 1–2 phases** without explicit instruction to pause.
- **Never silently skip a phase.** If a phase cannot be done, STOP and explain why before halting.
- This applies regardless of how many phases/orders the user specifies (3, 4, 5 or more).

@AGENTS.md

> The operating rules above (communication, Git/approval workflow, automation-first
> policy, enterprise safety) are mandatory. The sections below describe the codebase
> itself: commands, architecture, and conventions.

## Commands

All commands run from the repo root.

| Task | Command |
| --- | --- |
| Dev server (Turbopack) | `npm run dev` |
| Production build | `npm run build` |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Unit/integration tests | `npm run test` |
| Fast editing gate (typecheck only) | `npm run check:edit` |
| Full hardening gate (lint + typecheck + test + build) | `npm run check:harden` |
| CI gate (same as harden) | `npm run ci` |

**Editing workflow:** use `npm run check:edit` for the tight inner loop while
reshaping UI/config; run `npm run check:harden` before any commit, push, PR,
migration, or deploy. See `docs/editing-guide.md`.

### Tests

- Unit/integration tests live in `tests/*.test.ts`. Each file **exports** a
  `run<Name>Tests()` function using `node:assert/strict` and importing domain code
  directly with `.ts` extensions (e.g. `../src/lib/i18n/config.ts`).
- They are executed as one aggregated suite by `tests/run-tests.ts`, run via Node
  with type-stripping and a custom `@/` alias resolver (`tests/alias-loader.mjs`).
  There is **no per-test filter flag**; to isolate a test temporarily comment out
  the other `runTest(...)` lines in `tests/run-tests.ts`. When you add a test file,
  wire its exported function into `tests/run-tests.ts` or it will not run.
- End-to-end tests use Playwright (`tests/e2e/*.spec.ts`, config
  `playwright.config.ts`). Run with `npx playwright test`. An auth `setup` project
  signs in first and stores browser state; `*.data-bearing.spec.ts` only runs when
  `PLAYWRIGHT_DATA_USER_HRID` / `PLAYWRIGHT_DATA_USER_PASSWORD` are set.

### Database / RLS scripts

Many `db:*` and `phaseNN:*` npm scripts (Node + type-stripping) validate Supabase
RLS, role alignment, and the staged production-migration approval pipeline. These
talk to staging/production Supabase and gate migrations — do not run them casually;
treat them as the migration safety harness described in `docs/security/`.

## Architecture

Phoenix Workforce is a **monolithic Next.js 16 (App Router) + React 19 + Supabase
(Postgres)** HR/workforce platform. UI, route handlers, and domain services live in
one repo. Styling is Tailwind CSS v4 + shadcn (radix-ui primitives, lucide icons).
See `docs/architecture.md` for the domain-level narrative.

### Layout

- `app/` — App Router pages and `app/api/**/route.ts` handlers. Two UIs share the
  app: the **admin** surface (`app/admin`, `app/employees`, `app/payroll`, …) and the
  **employee portal** (`app/employee-portals/**`). Which one a user lands in is decided
  by role via `resolveNavigationMode` in `src/lib/auth/permissions.ts`.
- `src/lib/<domain>/` — domain services and data access (the source of truth for
  business rules). Domains include `payroll`, `expenses`, `outstation`, `coaching`,
  `sales`, `vacation`/leave, `resignations`, `probation`, `offers`, `contracts`,
  `marketing-requests`, `workforce`, `notifications`, `auth`, `supabase`,
  `workflow-registry`, and more.
- `src/components/<domain>/` and `src/components/ui/` — UI composition and shared
  primitives.
- `src/config/` — `system-settings.ts` (brand, deploy URLs, email defaults, editing
  policy) and `system-navigation.ts` (sidebar/nav source of truth).
- `supabase/` — SQL. **`supabase/migrations/` holds the timestamped migrations**
  (`YYYYMMDDHHMMSS_*.sql`) that define the live schema/RLS; the loose `*.sql` files at
  the `supabase/` root are historical hardening/setup scripts. Treat SQL here as part
  of the deliverable, not optional extras.
- `tests/` (unit) and `tests/e2e/` (Playwright). `docs/` holds architecture, editing,
  security, and operating-state notes.
- `local-attendance-agent/` — a separate local .NET/PowerShell ZKTeco attendance agent
  (see its own README); not part of the Next.js build.

### Domain-first rule

Business logic lives in `src/lib/<domain>/`. Pages and components **call domain
services**; they must not re-implement payroll, leave, expense, outstation, HR, or
sales rules inline. When changing behavior, start in `src/lib/<domain>/`.

### Auth & access control (read these together)

This is the most important cross-cutting system. Three files define it:

- `src/lib/auth/permissions.ts` — the heart. Defines `PhoenixRole` (15 roles),
  `PermissionResource`/`PermissionAction`, the **`defaultPermissionMatrix`** (role →
  resource → allowed actions), and `AccessContext` (`{ hrId, loginId, role, scope,
  source }`). Scope (`self`/`team`/`hierarchy`/`line`/`company`/`system`) drives
  row-level visibility helpers like `canAccessPayroll`, `canAccessSales`,
  `canSeeEmployee`, `filterEmployeesForAccess`. The matrix is overridable at runtime
  from the `role_permission_overrides` table (cached ~30s).
- `src/lib/auth/server.ts` — `resolveAccessContext(request)` (API routes) and
  `resolveAccessContextFromPage()` (server components) turn a request/cookies into an
  `AccessContext` by verifying the application-signed session cookie against
  `app_auth_users`. Sessions are rejected on inactive user, role change, or
  session-version mismatch (all audited).
- `src/lib/supabase/server.ts` — two clients: `getSupabaseAdmin()` (service role,
  **bypasses RLS**, server-only/admin/system use) and `getSupabaseUserClient()` (anon
  key, **respects RLS**). Prefer RLS-respecting access for user-scoped reads; reserve
  the admin client for tightly bounded server tasks.

**Auth is application-managed, not Supabase Auth.** Login uses HR_ID + password
(`bcryptjs`) and an app-signed session token; password setup is via one-time links.

### API route convention

Route handlers follow a consistent shape (see `app/api/coaching/` as the reference):

1. `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`.
2. Resolve the caller: `resolveAccessContext(request)`.
3. Enforce permission with `assertPermission(ctx, resource, action)` (throws
   `Forbidden: ...`) or a domain `require*Permission` helper, before any mutation.
4. Delegate work to the `src/lib/<domain>/service.ts`.
5. Catch errors and map them to HTTP status via a shared `jsonError`-style helper
   (forbidden → 403, not authenticated → 401, not found → 404, validation → 400,
   conflict → 409). `isForbiddenError` keys off the `Forbidden:` message prefix.

Always enforce access on the server even though `system-navigation.ts` already hides
links — sidebar visibility is UX, never the security boundary.

### State-machine workflows

Approval flows (payroll, resignations, probation, contracts, outstation, offers,
marketing requests) are governed by the **workflow registry**
(`src/lib/workflow-registry/service.ts`): modules define `statuses` and `actions`
(allowed `from`→`to`, `allowedRoles`, `requiresReason`, side effects, audit log,
notifications). Transitions validate against the registry and write audit logs.

### Notifications & cron

Notifications use an outbox model. The project runs on **Vercel Hobby**, so
`vercel.json` keeps exactly **two daily crons** (`/api/notifications/birthdays`,
`/api/notifications/contract-renewals`). Outbox + probation reminder processing is
shared via `src/lib/notifications/scheduled-processing.ts` and piggybacks on the daily
contract-renewal cron. Do **not** add sub-daily Vercel crons without a Pro upgrade or
an approved external scheduler.

## Conventions

- **Path alias:** `@/*` resolves to both `./*` and `./src/*` (see `tsconfig.json`).
  TS strict mode is on; `.ts` extension imports are allowed.
- **HR_ID is the employee key**, not a DB id. Normalize/compare via the helpers in
  `src/lib/hr-id.ts` and `permissions.ts` (`normalizeHrId`, `hrIdsMatch`) — never
  compare raw strings.
- **Global edit points** (don't hunt): brand/URLs/email → `src/config/system-settings.ts`;
  sidebar/nav/roles → `src/config/system-navigation.ts`; design tokens →
  `src/styles/tokens.css` + `app/globals.css`; shared primitives →
  `src/components/ui/`. (Full table in `docs/editing-guide.md`.)
- **i18n:** Arabic data exists in the model; locale/format helpers are in
  `src/lib/i18n/` (`config.ts`, `format.ts`) but localization is not yet centralized.
- **Security headers / CSP** are defined in `next.config.ts`.
- **Local dev auth:** with `NODE_ENV=development`, `GET /api/dev-auth?role=...` sets a
  dev-preview session cookie so you can browse as any role on localhost (disabled in
  production). `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` additionally allows
  `x-phoenix-role` / `x-phoenix-hr-id` request headers locally.

## Required environment

Server reads these (via `process.env`, see `src/lib/supabase/server.ts` and auth libs):
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, plus the session-signing secret and email/Google Maps
keys used by their respective domains.

## Branch & deployment model

- `main` is **production-only — never edit directly.**
- `codex/work-from-production` is the active working branch for edits/features.
- Production: `https://phoenix-workforce.vercel.app` (verify this exact public domain
  after every production deploy — workspace aliases can diverge from the public alias).
- Keep only two active Vercel deployments: production `main` and the working preview.
- `.vercel/` is local CLI metadata and stays uncommitted.
- Parallel sessions must use isolated git worktrees and never re-clone over the primary
  `.git` — see AGENTS.md § Parallel Session and Git Worktree Safety.

## Protected Files — OWNER UNLOCK REQUIRED

The following two files are **permanently locked** by the owner. No AI session,
developer, or automated tool may read-then-edit, refactor, rename constants,
adjust formulas, or change any value inside them without the owner explicitly
providing the unlock phrase in the active conversation first.

| File | What it protects |
| --- | --- |
| `src/lib/incentives/scheme-2026.ts` | 2026 incentive payout curve, achievement thresholds, semester target formula |
| `src/lib/payroll/policy.ts` | `BASIC_SALARY_RATE` (70%), and all salary derivation formulas (base → basic → net → gross) |
| `src/components/employee-portal/identity-card.tsx` | Employee portal identity banner design — must always use `PhoenixSignatureCard`; do NOT swap for any other component |

**If any request would touch either file** (fix, refactor, rename, extend, delete):

1. STOP — do not proceed.
2. Ask the owner: "This file is locked. Please provide the unlock phrase."
3. Only continue after the owner supplies the correct phrase.

The unlock phrase is: **Sato-1997**

If the owner says "Sato-1997" in the conversation, you may proceed with the requested edit to the locked file. Without it, refuse and ask for the phrase.
