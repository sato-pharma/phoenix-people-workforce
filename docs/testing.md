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

A file that skips step 5 never runs. `tests/test-wiring-complete.test.ts` fails CI when any
`tests/*.test.ts` is not imported **and** called by `run-tests.ts`; since 2026-09-30
`.claude/hooks/test-registration-check.mjs` gives the same verdict earlier — right after a session
writes or edits the file — using the guard's own two regexes (pinned equal by
`tests/test-registration-check.test.ts`).

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

CI runs **two** required checks, `validate` and `checks`, both from `.github/workflows/ci.yml`.
🔴 **Read the list from `branches/main/protection/required_status_checks`, not from this table** — it
has now been wrong three times, the names changed on 2026-09-27, and the count changed again on
2026-09-29. A gate counting passes against a number from a doc waits forever for checks that are gone.

🔴 **A pull request's check list IS those two and nothing else.** `mobile` and `secret-scan` were
demoted from protection on 2026-09-29 and taken off `pull_request` in the same change — they had to
move together, because a required check whose job no longer reports leaves every PR waiting on
"Expected" for ever. So their absence from a PR is CORRECT, and neither can stop a bad merge on your
behalf: they surface on `main`, a schedule or a dispatch, which makes them fix-forward detectors
rather than gates.

| Check | Workflow | What it runs |
|---|---|---|
| `validate` | ci.yml | Structural checks (routes, migrations, sql-backups, deductions contract, stale-domains), **the unit/integration suite** (`pnpm run test`, i.e. `tests/run-tests.ts`), `pnpm audit`, and on non-PR events the production **build** and the Playwright **login smoke test** — all in one job. 🔴 **The unit suite lives HERE.** It left for its own `test` job on 2026-09-17 (#3950), moved into `checks` on 2026-09-27, and came back here on 2026-09-30 for wall clock: `checks` was running typecheck then the suite in SERIES on one runner, ~80% of a PR's wait, while `validate` sat on ~37s of work. Beside the typecheck instead of behind it, a PR is ~163s. 🔴 **It is NOT a job called `test` and must not become one** — that is a retired check name, and a job protection does not require reads exactly like one that gates (#3950). **So anything saying a pinned test "runs in the required `validate` job" means this one, and a NEW pinned test belongs here.** |
| `checks` | ci.yml | `pnpm run lint`, `pnpm exec next typegen` and `pnpm run typecheck` — **steps** of one job. 🔴 **They were separate jobs named `lint`, `typecheck` and `test` until 2026-09-27 (#4527)**, which merged them so GitHub's per-job minute rounding is paid once instead of three times (~14% fewer billable minutes). Those three names **no longer exist as check names**, so a gate waiting for them waits forever. |
**Not required, and not on a pull request either — corrected 2026-09-30.** The two rows below used to
sit in the table above as required checks. Both were demoted on 2026-09-29 and taken off
`pull_request` in the same change, so neither reports on a PR at all:

| Reports on | Workflow | What it runs |
|---|---|---|
| `mobile` | ci.yml | `npm ci` and `npm run typecheck` over the Expo app's own npm lockfile, which sits outside the pnpm workspace. **Added 2026-09-18 (#3974)** after #3970 found that lockfile could not be installed without `--legacy-peer-deps` and nothing in CI would have noticed. 🔴 It carries `if: github.event_name != 'pull_request'` — so a red result here is a fix-forward, never something that stopped a merge. |
| `secret-scan` | security-scan.yml | gitleaks (pinned v8.30.1, checksum-verified) over the checked-out tree, `--no-git --redact`, ~13s. 🔴 **Not blocking, on two counts:** `security-scan.yml` has no `pull_request` trigger, and since 2026-09-30 the scanning step carries `continue-on-error`, so a finding is reported while the job concludes success — a red suite there would withhold the production deploy of whatever commit is `main` HEAD when the schedule fires. |

`.github/workflows/security-scan.yml` was deleted on 2026-08-08 by #1889 and restored the same day by
#1894, which also removed the `--exit-code 0` that had made gitleaks incapable of failing (40
consecutive green runs that proved nothing). 🔴 **It no longer runs on a PR at all** — the trigger was
removed on 2026-09-29 and the same gitleaks moved into `bash-guard.mjs` clause C12, which refuses the
push instead, earlier and closer to the author. What remains is the daily 05:17 UTC run over `main`
plus a dispatch. Semgrep's `sast-scan` **is** in the file (its own job, deliberately never a required
check); an earlier version of this paragraph said SAST "no longer runs at all", which is wrong. Since
GHAS is not purchasable on a personal account (`security_and_analysis: null`), these two are the
repo's only automated secret and SAST detection — and neither one gates a merge, so a finding from
either has already shipped by the time you read it.

There is no longer a separate `preview-smoke` job — the login smoke test moved into `validate`. The
full Playwright E2E suite runs only on manual `workflow_dispatch` (the `full-e2e` job).

🔴 **`main` branch protection requires TWO checks green before a merge can land — `validate` and
`checks` — not the 6 this paragraph claimed until 2026-09-30.** There is no required human review
(solo owner), and per AGENTS.md §3 a merge to `main` then deploys to production as soon as that
commit's checks finish. So the merge gate and the deploy gate are the same two checks, which is why a
gate hard-coded to a count from a doc does not merely wait — it waits for checks that no longer exist.
**Count passes against `branches/main/protection/required_status_checks`, read live.**

### Before every push: `remote-check.mjs test` is a standing step (owner rule, 2026-10-04)

`node scripts/remote-check.mjs test` runs the unit suite on the preview box against the **committed**
sha — about 133 s, nothing on the laptop, no Actions minutes — and a push follows only a final
`remote-check: PASS — <sha>` for that exact sha. `all` (lint, typecheck, suite, build — ~7 min) replaces it when the
change adds a route, a file or a member of a closed union, because the suite runs with
`--experimental-strip-types` and cannot see a type error. A docs-only push is not exempt: the module
memory check and the AGENTS.md/CLAUDE.md size budgets run in the suite, and a docs-only PR has broken
`main` — and the first run of this very step, on the PR that introduced it, failed
`AGENTS.md long hooks cite their account in docs/` on an over-long rule line, which CI would have
spent a full round finding. A backgrounded run's notification reports the shell's exit status, so
read the output file's last line.

**Why.** The friction notes of the 2026-09-17..10-03 sessions (49 on disk, 42 with a written note) show
where red CI came from on Claude's own code: 8 sessions a pinned or source-guard test that went stale
or oversized (6) or a defect in the new test (2), 3 a type error. A typecheck hook would have seen
none of the eight. Each red push costs a second full CI run (~14 billable minutes, `ci-self-hosted-runner.md`).
This is **behavioral, not hook-enforced** — a guard that refused `git push` would also stop the
scheduled fold and every session when the box is unreachable. If the box does not answer, say so and
push; never wait on it.

### Waiting for the gate: allow-list `SUCCESS`, never deny-list the unfinished states

Measured 2026-10-02 on one pull request, three false verdicts in roughly ten minutes — every one in
the same direction, claiming the run had finished when it had not, and two of them relayed to the
owner as a reason to merge.

**The first shape.** A loop whose condition was "does any row say `pending`?" The window right after
a push has no check runs at all yet — longer when that push CANCELS the previous run before GitHub
creates the next, which is what happens when fixups land a minute apart. In that window
`gh pr checks` prints `no checks reported on the '<branch>' branch` and exits **non-zero**. An empty
list contains no row saying `pending`, so the condition was satisfied and the loop reported the pull
request settled. Two separate watchers did this inside the same minute, both naming a head whose
`ci.yml` run was still `in_progress`.

**The second shape, which is the instructive one.** The rewrite asked branch protection for the
required check names and required each to be *present and not `PENDING`*. It printed
`ALL REQUIRED GREEN` on a run that was still going, because `gh pr checks --json name,state` returns
`QUEUED` and `IN_PROGRESS` as well as `PENDING` — and a deny-list naming only `PENDING` treats the
other two as finished. Fixing the empty-list hole had not fixed the bug; it had only moved it, because
both versions enumerated the states that mean *wait*, and there was always one more.

**So the rule is about the shape, not the state names.** Read the required contexts live from
`branches/main/protection/required_status_checks` (never from a doc — see the paragraph above), and
treat the gate as green **only when every one of them is literally `SUCCESS`**. Absent, `QUEUED`,
`IN_PROGRESS`, `PENDING`, `NEUTRAL`, `SKIPPED` on a required context, and an unreadable or empty list
all mean keep waiting; `FAILURE` is red. A watcher built this way can only ever be wrong toward "not
finished yet", which costs a minute of waiting. The deny-list is wrong in the direction that hands
the owner a merge approval for a pull request nothing has verified.

Two practical notes. `gh pr checks` exits non-zero both when the list is empty **and** when any check
is failing, so a wrapper that treats a non-zero exit as an error will throw on the very result it was
watching for — capture the output and branch on the states, not on the exit code. And a check that
protection does not require (`mobile`, `full-e2e`) reading `skipping` is not a failure and not a
gate; only the required contexts decide.
