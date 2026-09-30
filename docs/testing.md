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

A file that skips step 5 never runs, and nothing else notices. Two things catch it since 2026-09-30:
`.claude/hooks/test-registration-check.mjs` warns the session right after it writes or edits such a
file, and `tests/test-registration-check.test.ts` fails CI if any `tests/*.test.ts` is not imported
**and** called by `run-tests.ts`.

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

CI runs four required checks — three from `.github/workflows/ci.yml`, one from
`.github/workflows/security-scan.yml`. 🔴 **Read the list from
`branches/main/protection/required_status_checks`, not from this table** — it has been wrong twice,
and the names below changed on 2026-09-27:

| Check | Workflow | What it runs |
|---|---|---|
| `validate` | ci.yml | Structural checks (routes, migrations, sql-backups, deductions contract, stale-domains), `pnpm audit`, the production **build**, and the Playwright **login smoke test** — all in one job. |
| `checks` | ci.yml | `pnpm run lint`, `pnpm exec next typegen`, `pnpm run typecheck` and the **unit/integration suite** (`pnpm run test`, i.e. `tests/run-tests.ts`) — four **steps** of one job. 🔴 **They were three separate jobs named `lint`, `typecheck` and `test` until 2026-09-27 (#4527)**, which merged them so GitHub's per-job minute rounding is paid once instead of three times (~14% fewer billable minutes). Those three names **no longer exist as check names**, so a gate waiting for them waits forever. The unit suite left `validate` for its own job on 2026-09-17 (#3950) and landed here ten days later. **Anything that says a pinned test "runs in the required `validate` job", or in a required `test` job, means this one.** |
| `mobile` | ci.yml | `npm ci` and `npm run typecheck` inside `mobile/` — the Expo app, which keeps its own npm lockfile outside the pnpm workspace. **Added 2026-09-18 (#3974)**, after #3970 found `mobile/package-lock.json` could not be installed without `--legacy-peer-deps` and nothing in CI would ever have noticed. The job always runs and always reports; a detect step decides whether to do the work, so a PR that leaves `mobile/` alone pays about nine seconds. |
| `secret-scan` | security-scan.yml | gitleaks (pinned v8.30.1, checksum-verified) over the checked-out tree, `--no-git --redact`, ~13s. **Blocking** — any finding fails the check. |

`.github/workflows/security-scan.yml` was deleted on 2026-08-08 by #1889 and restored the same day
by #1894, which also removed the `--exit-code 0` that had made gitleaks incapable of failing (40
consecutive green runs that proved nothing). It now runs on every PR — no path filter, so docs-only
PRs get it too — plus daily at 05:17 UTC over `main`, and it **is** a required check. Semgrep's
`sast-scan` was deliberately not restored (4m14s per PR against gitleaks' 13s, and Sonar covered
overlapping ground), so SAST no longer runs at all. Since GHAS is not purchasable on a personal
account (`security_and_analysis: null`), this job is the repo's only automated secret detection.

There is no longer a separate `preview-smoke` job — the login smoke test moved into
`validate`. The full Playwright E2E suite runs only on manual `workflow_dispatch` (the
`full-e2e` job). Per AGENTS.md §2, `main` branch protection **requires these 6 checks green before a merge can
land** (there is no required human review — solo owner); per AGENTS.md §3 a merge to `main` then
deploys to production immediately.
