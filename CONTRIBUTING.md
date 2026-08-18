# Contributing to Phoenix Workforce

Phoenix Workforce is a private enterprise HR/workforce platform. This repository is not open source. All changes require review and approval before merging. This guide covers the workflow, conventions, and safety rules every contributor must follow.

## Branch Strategy

- **`main`** is production-only. Never commit or push directly to `main`.
- A long-lived **working branch** holds active development; all edits, fixes, and features land there before promotion to `main`.
- Feature branches branch off the working branch and stay short-lived and focused on a single change.
- The exact working-branch name and deployment mapping are documented in [docs/current-operating-state.md](docs/current-operating-state.md).

## Toolchain

Verified on the owner's machine 2026-08-10. Versions are what is actually in use, not minimums.

| CLI | Version | Needed for | Authenticate with |
| --- | --- | --- | --- |
| `node` | 24.15.0 | runtime | — |
| `pnpm` | 11.13.1 | every repo script | — |
| `git` | 2.55.0 | — | — |
| `gh` | 2.95.0 | all GitHub work — PRs, checks, API (never the GitHub MCP tools) | `gh auth login` |
| `supabase` | 2.109.1 | migrations, project inspection | `supabase login` |
| `railway` | 5.30.3 | production logs, variables, deploy status | `railway login` |
| `psql` / `pg_dump` | 18.4 | direct DB work and snapshot exports; 18.x reads the 17.6 server fine | uses `SUPABASE_DB_URL` |
| `jq` | 1.8.2 | JSON in shell pipelines | — |
| `python` | 3.13 | ad-hoc data/text processing | — |
| `openssl` | 3.5.7 | secret generation | — |
| `docker` | 29.5.2 | only `supabase start` (local stack); the daemon is normally not running | — |

Playwright is a **devDependency**, not a global CLI — use `pnpm exec playwright`. The configs only
target chromium, so `pnpm exec playwright install chromium` is enough; there is no need to pull
firefox and webkit.

**Installed but dead — do not use, and do not verify against them:** `gcloud` (the GCP billing
account was closed 2026-08-01; every API returns `BILLING_DISABLED`) and `vercel` (decommissioned).
Both linger on PATH and will happily run, which is exactly the trap. Production is Railway.

No AWS CLI is required. The `aws-…` strings throughout the repo are the Supabase pooler hostname
(`aws-0-eu-central-1.pooler.supabase.com`), not an AWS dependency.

## Development Workflow

1. Clone the repo and run `pnpm install`.
2. Copy `.env.example` to `.env.local` and fill in the required environment variables.
3. Start the dev server with `pnpm run dev` (Turbopack on macOS/Linux; webpack on Windows for stability).
4. Edit freely — do not run checks between edits. `pnpm run check:edit` (typecheck only) is
   available mid-task if you want a fast sanity read, but it is optional.
5. When the task is finished, **push and let CI answer**. There is no local full gate to run — the
   PR runs lint, typecheck, tests and build itself, and a red one blocks the merge.
6. Never push a broken build.

## Commit Messages

Use conventional commit format: `type(scope): description`.

- **Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `security`
- Keep the subject line under 72 characters.
- Focus on the "why", not just the "what".
- Example: `feat(payroll): add mid-month advance calculation for hourly staff`

## Pull Request Process

1. Create a PR from your feature branch into the working branch.
2. Fill out the PR template completely, including a summary, test plan, and risk assessment.
3. All CI gates must pass: lint, typecheck, tests, and production build.
4. At least one code review approval is required before merging.
5. Include screenshots or recordings for any UI changes.
6. Link related issues or tasks in the PR description.

## Code Conventions

- **TypeScript strict mode** is enforced. No `any` without justification.
- **Domain-first rule:** business logic lives in `src/lib/<domain>/`. Pages and components call domain services; they must not re-implement business rules inline.
- Use the `@/*` path alias (resolves to both `./*` and `./src/*`).
- **HR_ID is the employee key.** Always compare using `normalizeHrId` and `hrIdsMatch` from `src/lib/hr-id.ts`. Never compare raw HR_ID strings.
- Shared UI primitives live in `src/components/ui/`. Domain components live in `src/components/<domain>/`.

## Testing Requirements

- Add tests for all new domain logic. Tests live in `tests/*.test.ts`.
- Each test file exports a `run<Name>Tests()` function using `node:assert/strict`.
- Wire new test functions into `tests/run-tests.ts` or they will not execute.
- E2E tests use Playwright and live in `tests/e2e/`. See `playwright.config.ts` for setup.
- Run `pnpm run test` before pushing. Do not merge with failing tests.

## Database & Migration Rules

- All SQL schema changes go in `supabase/migrations/` with a `YYYYMMDDHHMMSS_` timestamp prefix.
- Test every migration on staging before applying to production.
- Never apply migrations to production without explicit approval.
- Document RLS impact for any table or policy change.
- Use the RLS-respecting client (`getSupabaseUserClient`) for user-scoped reads. Reserve the service-role client (`getSupabaseAdmin`) for tightly bounded server-only tasks.

## Security Considerations

This is an enterprise HR platform handling sensitive data including payroll, PII, contracts, and employee records. Treat every change with production-grade care.

- Always enforce permissions on the server side using `assertPermission(ctx, resource, action)`.
- Sidebar visibility is UX, never the security boundary. Server-side checks are mandatory.
- Validate all inputs at system boundaries (API routes, form submissions).
- Review RLS impact for every schema change. Ensure row-level security policies cover new tables.
- Never log or expose sensitive employee data in client-side code or error messages.

## Assisted Development

Automated tooling may be used during development. All changes -- whether manually written or tool-assisted -- follow the same review, validation, and approval process. No tool-generated change bypasses the branch, validate, review, approve, merge workflow. See [docs/development-workflow.md](docs/development-workflow.md) for engineering governance details.

## What NOT to Do

- Do not push directly to `main`. It is production-only, and **a merge to `main` ships to
  production immediately at full traffic** — see [docs/deployment.md](docs/deployment.md).
- Do not apply migrations to production without approval. The deploy applies none, so a migration
  must land **before** the merge or the new code will select a column that does not exist.
- Do not hardcode secrets or credentials. Use environment variables.
- Do not bypass RLS with the service-role client for user-scoped data access.
- Do not add or reschedule a cron without approval. Vercel crons no longer exist, and neither does
  Cloud Scheduler — the live scheduler is a third-party cron-job.org account outside this repo, so
  a schedule change cannot be made or reviewed in a PR. See [docs/deployment.md](docs/deployment.md).
- Do not merge a PR whose checks are red, and do not reintroduce a local full-validation gate to
  run before pushing — `check:harden` was retired on 2026-08-18 and CI is the gate.
- Do not re-implement domain business logic inside components or pages.
