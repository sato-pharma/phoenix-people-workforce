# Testing

## Overview

Phoenix Workforce has two test layers:

- **90+ unit/integration tests** validating domain logic
- **18+ Playwright E2E specs** covering browser workflows

## Unit / Integration Tests

Located in `tests/*.test.ts`. Each file exports a named run function (e.g., `runPayrollWorkflowTests`) using `node:assert/strict`.

### Running

```bash
pnpm run test
```

This executes `tests/run-tests.ts`, which imports and runs all registered test functions. Tests run with Node.js `--experimental-strip-types` (requires Node 24+ — the repo's `engines.node` floor).

### Adding a Test

1. Create `tests/your-feature.test.ts`
2. Export an async function: `export async function runYourFeatureTests() { ... }`
3. Use `node:assert/strict` for assertions
4. Import domain code directly with `.ts` extensions (e.g., `../src/lib/domain/service.ts`)
5. Wire the function into `tests/run-tests.ts` by adding a `runTest()` call
6. Run `pnpm run test` to verify

### Filtering Tests

There is no per-test filter flag. To isolate a test temporarily, comment out other `runTest()` lines in `tests/run-tests.ts`. Remember to restore them before committing.

### Path Alias

Tests use a custom alias loader (`tests/alias-loader.mjs`) that resolves the `@/*` path alias to both `./*` and `./src/*`.

## E2E Tests (Playwright)

Located in `tests/e2e/*.spec.ts`. Configuration in `playwright.config.ts`.

### Running

```bash
# Smoke test (login only)
pnpm run test:e2e:smoke

# Full suite
pnpm run test:e2e

# Install browsers first if needed
npx playwright install --with-deps chromium
```

### Auth Setup

The E2E suite has an auth `setup` project that signs in and stores browser state. Subsequent specs reuse this authenticated state.

### Data-Bearing Tests

Specs named `*.data-bearing.spec.ts` only run when these environment variables are set:

- `PLAYWRIGHT_DATA_USER_HRID`
- `PLAYWRIGHT_DATA_USER_PASSWORD`

These test against real data and require valid credentials.

## Test Categories

| Category | Examples |
|---|---|
| Payroll & salary | payroll-engine-hardening, payroll-workflow, salary-allowance-policy |
| Auth & security | auth-session, access-governance-hardening, login-page-hardening |
| Employee lifecycle | employee-access-provisioning, employee-import-seat-validation |
| Sales & reporting | sales-source-of-truth, sales-period, sales-role-mapping |
| Leave & vacation | vacation-calculations, vacation-module, leave-source-of-truth |
| Coaching | coaching-scoring, coaching-permissions, coaching-analytics |
| Expenses & outstation | medical-rep-expenses, outstation-policy-classification |
| Workflow & registry | workflow-registry, workflow-registry-enforcement, workflow-control |
| Phase validation | phase13-33 (staging/production validation smoke tests, registered in `run-tests.ts`) |

## CI Integration

CI runs three checks, all from `.github/workflows/ci.yml`:

| Check | Workflow | What it runs |
|---|---|---|
| `validate` | ci.yml | Structural checks (routes, migrations, sql-backups, deductions contract, stale-domains), `pnpm audit`, the **unit/integration suite** (`pnpm run test`), the production **build**, and the Playwright **login smoke test** — all in one job. |
| `lint` | ci.yml | `pnpm run lint` (parallel job). |
| `typecheck` | ci.yml | `next typegen` + `pnpm run typecheck` (parallel job). |

`.github/workflows/security-scan.yml` (OSS gitleaks secret scan + Semgrep SAST, both
non-blocking) was removed 2026-08-08 at owner request; it was never a required check.

There is no longer a separate `preview-smoke` job — the login smoke test moved into
`validate`. The full Playwright E2E suite runs only on manual `workflow_dispatch` (the
`full-e2e` job). Per AGENTS.md §2, `main` branch protection **requires these 3 checks green before a merge can
land** (there is no required human review — solo owner); per AGENTS.md §3 a merge to `main` then
deploys to production immediately.
