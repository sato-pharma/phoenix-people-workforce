# Contributing to Phoenix Workforce

Phoenix Workforce is a private enterprise HR/workforce platform. This repository is not open source. All changes require review and approval before merging. This guide covers the workflow, conventions, and safety rules every contributor must follow.

## Branch Strategy

- **`main`** is production-only. Never commit or push directly to `main`.
- A long-lived **working branch** holds active development; all edits, fixes, and features land there before promotion to `main`.
- Feature branches branch off the working branch and stay short-lived and focused on a single change.
- The exact working-branch name and deployment mapping are documented in [docs/current-operating-state.md](docs/current-operating-state.md).

## Development Workflow

1. Clone the repo and run `npm install`.
2. Copy `.env.example` to `.env.local` and fill in the required environment variables.
3. Start the dev server with `npm run dev` (Turbopack).
4. Use `npm run check:edit` (typecheck only) as the fast inner loop while editing.
5. Run `npm run check:harden` (lint + typecheck + test + build) before every commit, push, or PR.
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
- Run `npm run test` before pushing. Do not merge with failing tests.

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

- Do not push directly to `main`. It is production-only.
- Do not apply migrations to production without approval.
- Do not hardcode secrets or credentials. Use environment variables.
- Do not bypass RLS with the service-role client for user-scoped data access.
- Do not add Vercel crons. The Hobby plan limit is 2 and both slots are in use.
- Do not skip `npm run check:harden` before pushing or opening a PR.
- Do not re-implement domain business logic inside components or pages.
