# Testing

## Overview

Phoenix Workforce has two test layers:

- **90+ unit/integration tests** validating domain logic
- **18+ Playwright E2E specs** covering browser workflows

## Unit / Integration Tests

Located in `tests/*.test.ts`. Each file exports a named run function (e.g., `runPayrollWorkflowTests`) using `node:assert/strict`.

### Running

```bash
pnpm run test           # one process, every test, in order — opt-in serial run
pnpm run test:sharded   # the same suite, CPU/memory-bounded shards; CI and remote-check use this
```

This executes `tests/run-tests.ts`, which imports and runs all registered test functions. Tests run with Node.js `--experimental-strip-types` (requires Node 24+ — the repo's `engines.node` floor).

`test:sharded` (`scripts/run-tests-sharded.mjs`) runs that same runner once per CPU with
`PHX_TEST_SHARD=<i>/<n>`, which makes `runTest` execute every nth call. Measured 2026-10-06 on 2
vCPU: serial 213s, two shards 129s. 🔴 **Its point is the REFUSAL, not the speed** — each shard
prints `PHX_SHARD_RESULT shard=i/n seen=S ran=R` from an exit handler, and the parent fails unless
every shard reported, all saw the same S, and the R's sum to it. Without that, a bad divisor or a
shard that died quietly turns into a smaller suite reporting success, which is worse than no
sharding. Every shard still IMPORTS every test file (three set `PHOENIX_AUTH_SECRET` at import
time), so more shards than CPUs costs more than it buys.

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

There is no per-test filter flag, and `PHX_TEST_SHARD` is not one — it splits the suite by position,
not by name. To isolate a test temporarily, comment out other `runTest()` lines in
`tests/run-tests.ts`. Remember to restore them before committing.

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
| `validate` | ci.yml | Structural checks (routes, migrations, sql-backups, deductions contract, stale-domains), `pnpm audit`, the **unit/integration suite on a pull request**, and on every OTHER event the production **build** and the Playwright **login smoke test** — all in one job. 🔴 **The suite runs in whichever required job is idle, and `checks` has it on a push.** Since 2026-10-06 the two `Test` steps are exact complements: `validate` on `pull_request`, `checks` on everything else — because on a PR this job does ~40s of work while `checks` carries the typecheck, and on `main` it is the other way round and `main`'s wall clock IS the production deploy gate. `tests/ci-suite-placement.test.ts` asserts an event can never fall through both. 🔴 **It is NOT a job called `test` and must not become one** — that is a retired check name, and a job protection does not require reads exactly like one that gates (#3950). **So a NEW pinned test belongs in this suite; which job runs it on a given event is ci.yml's business, not yours.** |
| `checks` | ci.yml | `pnpm run lint`, `pnpm exec next typegen`, `pnpm run typecheck` — and the unit suite on every event that is not a pull request (see `validate`). 🔴 **They were separate jobs named `lint`, `typecheck` and `test` until 2026-09-27 (#4527)**, which merged them so GitHub's per-job minute rounding is paid once instead of three times (~14% fewer billable minutes). Those three names **no longer exist as check names**, so a gate waiting for them waits forever. 🔴 **The typecheck is TypeScript 7 since 2026-10-06** — the `typescript-native` alias in package.json, which pnpm links `.bin/tsc` to; ~180s became ~50s. Nothing names the version, so `--checkers 1` is passed as the tell that the alias survives: TypeScript 5 refuses the flag. `docs/ci-self-hosted-runner.md`, "The typecheck moved to TypeScript 7". |
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
push instead, earlier and closer to the author. What remains is the daily 20:17 UTC run over `main` (moved from 05:17 on 2026-10-16)
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

### Reading the contract gates before the push

🔴 **MOST OF WHAT REDDENS `validate/Test` IS NOT THE PR'S OWN FEATURE TEST — IT IS A WHOLE-REPO
CONTRACT GATE THE CHANGE HAD NOTHING TO DO WITH, AND UNTIL 13 OCT 2026 THE ONLY WAY TO MEET ONE WAS
TO PUSH AND WAIT.** Measured that day on `ci.yml` / `pull_request`: **12.1%** of runs failed over
4-8 Oct, **20.0%** over 9-11 Oct, and **40.5%** over 12 Oct 00:00 - 13 Oct 06:00 (46 failed and 24
cancelled of 173 runs). Of the 106 failed runs since 9 Oct the failing step was `validate/Test` 94
times, `checks/Typecheck` 17, `checks/Lint` 5 and `validate/Check migrations` 4.

Four things together made those gates invisible before a push: a local typecheck is denied outright
(`bash-guard.mjs` C8), the unit suite runs only on the box (~125s) or in the PR's own `validate`
(~210s), `tests/run-tests.ts` has **no per-test filter** — only `PHX_TEST_SHARD=<i>/<n>` — and
`runTest` **rethrows at the first failure**, so one red gate reports on a prefix of the suite and
the next push finds a second gate.

**`pnpm run check:contracts` answers in about 8 seconds**, and reports every gate instead of
stopping at the first. The eleven it runs, with the failing CI jobs each caused between 9 and
13 Oct 2026:

| Gate | Red CI jobs |
| --- | --- |
| `AGENTS.md long hooks cite their account in docs/` | 23 |
| `access registry coverage` | 8 |
| `Nothing this app shows anybody assumes its subject is a man` (neutral wording) | 6 |
| `no source-pinning test strips comments unsafely` (the comment-strip ratchet) | 6 |
| `hydration-safe Cairo text` | 5 |
| `portal route skeleton` | 4 |
| `Module memory (owner, 2026-10-02)` | 3 |
| `every runTest( call in this very file is ("a name", aRunFunction)` | 3 — in `checks/Typecheck`, not `Test` |
| `audit entity types` | named among the 12 Oct reds |
| `test wiring is complete` | fires on exactly the push that adds a test file |
| `the Office-allocation board row` | one of the reds — and the one that needed a refactor to get in (below) |

**It is optional and never a gate.** It starts nothing, refuses nothing and blocks no push — the
owner ruled *"keep the pre-push test as a rule, no guard"* on 2026-10-04 — and the PR's own
`validate` + `checks` remain the verdict.

#### The lint and migration reds, the typecheck it cannot reach

`validate/Test` was 94 of the 106 failed runs, but it was not all of them, so the check reaches the
other red steps as far as each honestly can. **Two tool gates** run beside the eleven contract
gates, alongside the shards, each one the CI step's own code rather than a copy of it.

🔴 **ALL 5 OF THE `checks/Lint` REDS WERE ESLINT *ERRORS* ON FILES THE PR HAD CHANGED** — 3 ×
`react-hooks/set-state-in-effect` ("Calling setState synchronously within an effect"), 1 × "Cannot
create components during render", 1 × five counts of `@typescript-eslint/no-explicit-any`. Not one
was elsewhere in the repo, which is what makes the branch's own diff the whole exposure. So the
first tool gate is ESLint over the files this branch changed,
with `--quiet` so it reports **errors only**. That is exactly what reddens the step, and it also
makes the known single-file trap inert, because "Unused eslint-disable directive" is a *warning*.
Measured on 20 changed files: **6.4s cold, ~3s warm**. ESLint here is not type-aware
(`eslint.config.mjs` sets no `project`), which is the only reason per-file linting is cheap at all.
It is a **separate list** from `CONTRACT_GATES` deliberately: a lint run is not one of the suite's
exported functions, and folding it in would have meant loosening the invariant that every contract
gate is the suite's own code.

🔴 **THE 4 `validate/Check migrations` REDS ARE ANSWERED IN FULL, NOT SAMPLED — THE GATE SPAWNS THE
STEP'S OWN SCRIPT.** CI's step is `pnpm run check:migrations`, which is
`node scripts/check-migrations.mjs`, and the tool gate runs that exact file: there is no second copy
of the filename rule, the duplicate-timestamp list, the `DROP TABLE` annotation rule or the
`GRANT … ON ALL TABLES` refusal to drift from it. Measured **465–490 ms** standalone and ~0.6–1.4 s
beside the shards, on 867 migrations. `tests/check-contracts.test.ts` holds `package.json`'s
`check:migrations`, `ci.yml`'s step and the gate's own constant to the same path, so a renamed step
or a moved script fails the suite instead of leaving this gate reproducing something that no longer
gates anything.

Three readings it deliberately does not flatten:

- **Exit 0 is a PASS even with warnings**, exactly as in CI — a `DROP TABLE` with no `-- SAFE:`
  annotation warns and passes, and this repo has 8 such warnings today. Exit 1 is a FAIL. Anything
  else, or a signal, is **SKIP — no verdict**, never a pass.
- **The detail printed is the LAST `[migration-check]` line**, the count summary. A real run opens
  with the cross-branch note and prints a WARN line per warning in between, so a first-match read
  would report "compared against origin/main …" as the step's verdict.
- **The cross-branch timestamp check fails open**, in the script itself: no `origin/main` in the
  object store (a shallow CI checkout, a fresh clone) and it is skipped rather than failed. That is
  the right call there and worth knowing here — a local tree that has not fetched since the
  colliding migration merged still gets a green gate, which is why the script names the commit it
  compared against and how old it was.

🔴 **THE TYPECHECK IS THE ONE IT MOSTLY CANNOT REACH, AND IT SAYS SO ON EVERY RUN.** Of the 17
`checks/Typecheck` reds, **3** were the one shape a source gate can see — `TS2554 Expected 2
arguments, but got 4` / `got 1` in `tests/run-tests.ts`, where a `git rerere`-replayed merge of that
5,400-line file folds the tail of one registration into the head of the next, so **two tests stop
running while both names and both imports survive**, `test-wiring-complete` still passes, and
`pnpm run test` type-checks nothing and reports success. `tests/run-tests-registration-shape.test.ts`
pins that call shape — accepting a single- **or** double-quoted name and a name concatenated with
`+`, because 68 of the registrations are one of those and a stricter gate would have called every
one of them an offender. The other **14** were ordinary type errors across `src/` and `app/`
(TS18047, TS2741, TS2322, TS2559, TS2366, TS2345, TS2339, TS2769), and only a compiler finds one of
those. So the run ends by naming `node scripts/remote-check.mjs typecheck` (~34s on the box): a
check that read as *"the types are fine"* while covering 3 of 17 would be worse than no check,
because a green run would buy a confidence it has not earned.

Six decisions in it that should not be "fixed" back:

- 🔴 **Each gate is the suite's OWN exported run function, imported** (`CONTRACT_GATES` in
  `scripts/check-contracts-gates.mjs`). A gate re-implemented here would drift from the one that
  actually gates the merge, and then a PASS would be a lie. `tests/check-contracts.test.ts` holds
  every entry against `tests/run-tests.ts` by export **and** by the opening of its registered name,
  so a renamed or retired gate fails in the suite rather than leaving the script importing nothing.
- 🔴 **No `--env-file-if-exists=.env.local`.** That flag is what makes `pnpm run test` run against
  **production** Supabase; a check a session is encouraged to run on every branch must not load
  production credentials. `coverage` omits it for the same reason.
- 🔴 **cwd is pinned to the repo root.** `access-registry-coverage` resolves `app/api` from
  `process.cwd()` and the AGENTS.md and neutral-wording gates read by relative path — so a run from
  a subdirectory would not fail, it would measure a smaller tree and **PASS**.
- 🔴 **It is NOT in the `ci` script.** `tests/ci-gate-parity.test.ts` requires every `check:*` named
  in `ci` to appear literally in a `.github/workflows/*.yml` file, so adding it there without a
  workflow step reddens `validate` — and a CI step would be waste, since the sharded suite already
  runs all eleven.
- 🔴 **It shards, and the parent REFUSES a run it cannot prove complete.** Serial it took 20.3s cold
  and 16.9s warm on the owner's laptop; three shards bring it to **8.1s**. Each shard prints
  `PHX_CONTRACT_RESULT shard=i/n ran=<slugs>` from an `exit` handler, and a missing line, a gate run
  twice, a gate no shard ran, a killed shard or a non-zero exit that names no failing gate is **NO
  VERDICT (exit 2), never a pass** — because a bad divisor is otherwise a smaller run reporting
  success, the lesson `scripts/run-tests-sharded.mjs` was built on. The shard count is bounded by
  free memory as well as CPUs (`MAX_CONTRACT_SHARDS` 3), since free RAM here is routinely under
  2.5 GB and `mem-watchdog.ps1` reaps a node job under 500 MB free.
- 🔴 **The lint cache lives OUTSIDE the repo, keyed by the checkout.** An earlier draft wrote
  `.eslintcache-contracts` into the repo root — not the gitignored name, so it showed up as an
  untracked file in `git status` — and one cache shared between worktrees would hand one tree's
  results to another, since every worktree carries the same file names. It goes in the OS temp
  directory under a hash of the checkout's own path, and the ESLint child's memory is reserved out
  of the shard budget before the shards are counted, because it runs alongside them.

#### Nothing is left out any more — and the last one in was fixed, not excused

**The Office-allocation board row** (`tests/needs-you-office-allocation-drift.test.ts`) was the one
candidate the first version could not take. It imported `src/lib/needs-you/sources.ts` — ~30
`@/lib/**` imports including `@/lib/admin/service`, whose head is `getSupabaseAdmin` from
`@/lib/supabase/server`. Nothing reaches the network at import time (the client is built inside the
call), but a Supabase client and `@/lib/env` land in the process, which is the one thing every gate
here must not do.

🔴 **THE FIX WAS NOT TO LOOSEN THE OFFLINE RULE, AND NOT TO COPY THE ASSERTIONS EITHER** — the two
shortcuts that would have made the gate's PASS stop meaning what `validate`'s PASS means. What moved
was the code: the pure function the test exercises now lives in
`src/lib/needs-you/office-allocation-drift-items.ts`, **byte-identical to the block that was in
`sources.ts`**, and the two helpers it shares with every other adapter (`ageDaysSince`, `plural`)
live in `src/lib/needs-you/item-fields.ts` so there is still exactly one definition of each. That
module's whole import graph is `sales/office-distributor` → `sales/contracts`, plus the import-free
`needs-you/types` and `needs-you/item-fields`. The adapter itself — owner-only, two periods, bounded
— is **read from `sources.ts` as source text**, which is what the test already did for everything
else it pins about it; the registry listing is read the same way. Measured: **34 ms**, and the gate
behaves identically in `validate`, where it also still runs. Nothing it checked was changed, added
or dropped.

🔴 **AND THE OFFLINE TRIPWIRE IN `tests/check-contracts.test.ts` IS NOW TRANSITIVE, BECAUSE A NARROW
WRAPPER MODULE DEFEATS A TWO-LEVEL WALK.** It used to read a gate's first-level imports plus one hop
through a `../src/…` module — enough while every gate imported its subject directly, and useless the
moment a gate reaches its subject through a wrapper, since a service import added one level *below*
that wrapper would have put `getSupabaseAdmin` back in the process with the check still green. It now
walks every specifier it can resolve (`@/…` exactly as `tests/alias-loader.mjs` resolves it, relative
hops from the importing file, a `seen` set for cycles) and names the whole trail, so a breach says
which hop introduced it: proved by adding a Supabase import to `item-fields.ts` — two hops down,
invisible to the old walk — and watching the assertion fire with
`…drift.test.ts -> ../src/lib/needs-you/office-allocation-drift-items.ts -> ./item-fields imports @/lib/supabase/server`.
It is still not a proof of purity: a bare package or a dynamic `await import(…)` is beyond any source
walk, so judge a new gate by reading it.

### Before every push: the PR's own CI is the verdict; `remote-check` is optional — except on a push that ADDS a test file (owner, 2026-10-12)

🔴 **ONE STEP CAME BACK, FOR ONE KIND OF PUSH (owner, 2026-10-12: _"make remote-check test mandatory
before a push that adds a test file"_).** A push whose commits add a `tests/**.test.ts(x)` file runs
`node scripts/remote-check.mjs test` first — once, in the background — and pushes on its
`remote-check: PASS — <sha9>`. Every other push is unchanged: commit, push, open the PR.

**What was measured on 12 Oct 2026**, the day he asked: **26 of the 59 PR CI runs that finished went
red — 44%, against 19-23% on 7-11 Oct and 6% on the 6th** — and 116 minutes of wall clock went into
red runs. Grouped by what actually failed, **13 of the 25 were repo-wide contract gates that had
nothing to do with the change being shipped**: 6 the AGENTS.md/rules hook-length gate
(`agents-long-hooks-cite-docs`, which read `56 of 540 hooks exceed 1200 bytes` mid-morning until
#5779 at 14:49 Cairo), **4 the zero-tolerance `comment-strip-ratchet`, which fires on a newly added
test file that strips comment lines by hand instead of importing `stripComments`** — those four are
the ones that no longer reach CI at all: on his instruction the same evening
(*"fix the comment-strip ratchet so new test files use the shared stripper"*),
`.claude/hooks/comment-strip-guard.mjs` refuses the shape at the Write or Edit that introduces it and
names the import, sharing ONE detector with the ratchet
(`.claude/hooks/lib/comment-strip-shapes.mjs`; account: `docs/hook-dispatcher.md`) — 2 the API
reverse-guard backlog and 1 the access registry. Seven were the PR's own new assertions, three the
typecheck and two the same migration rule twice. Four branches ate 16 of the 25, one of them going
red seven times on a different gate each round — serial discovery, because the PR run was the first
thing that ever looked. The suite answers all of that in ~125s on the box; `validate` answers it only
after the push, ~3 minutes later and one CI round each time.

🔴 **AND IT IS A RULE, NOT A GUARD — `push-typecheck-guard.mjs` REMINDS AND NEVER REFUSES OVER THE
SUITE.** Offered exactly that hook on 2026-10-04, the owner answered _"keep the pre-push test as a
rule, no guard"_, and that ruling stands until he lifts it in his own words: never build, propose or
"just suggest" one. What the hook does instead, when the pushed commits add a test file and hold no
`test` PASS for that sha: it prints the rule, the files it saw and the command, and allows the push.
Pinned by `tests/push-typecheck-guard.test.ts`, whose cases fail if the deny arm ever grows past the
typecheck.

The 2026-10-08 account follows — every line of it still holds for every other push.

🔴 **The 2026-10-04 standing step was RETIRED on 2026-10-08** by the owner's performance-recovery plan.
Measured from 1,230 session transcripts: on 4-8 Oct sessions spent **6.5 session-hours a day** in
`remote-check` and **17.6 hours** in foreground loops polling its output, because one 7.7 GB box
served ~9 sessions one run at a time (lint alone took 182s cold), while the hosted PR CI it ran in
front of queues in 2-3 seconds and answers in ~3 minutes. The trade-off is stated plainly: the PR red
rate fell from 24% to 10.5% while the step stood, and some of that may come back as red PR runs —
which block nothing but their own merge, never `main`.

What replaces it:

- **Commit, push, open the PR.** Its `validate` + `checks` are the verdict, and since 2026-10-08 a PR
  that touches a ROUTE or a BUILD-CONFIG file also BUILDS (`scripts/ci-build-risk.mjs`) — about 1 PR
  in 5. Narrowed the same day at the owner's word from "build unless build-inert" (52.5% of PRs): a break
  that lives only in a `src/**` library or component file is caught by `main`'s build, or earlier by
  `remote-check all`.
- **`remote-check` when an earlier answer is worth it — once, with `run_in_background: true`,** acting
  on the completion notification (confirmed to arrive in the Desktop app the same day). Exit 0 PASS,
  1 FAIL, 2-9 NO VERDICT; only `remote-check: PASS|FAIL — <sha9>` naming the sha you pushed counts, and
  a NO VERDICT is never a pass. `bash-guard.mjs` **C14** refuses a foreground poll loop,
  **C15** a foreground run of a check stage (`lockfile` passes), and **C16** a foreground sleep that waits
  on a background task's `tasks/<id>.output` file — the harness notifies when it ends (measured 8 Oct
  2026: ~1 session-hour and 50 session-minutes in 6 hours).
- **One result per sha, reused.** A run that ends in a printed PASS or FAIL records each stage in
  `<git-common-dir>/phx-remote-check/<sha>.json`. The push guard only READS it — it refuses a push
  solely when that record holds a typecheck FAIL for the exact commit, and starts nothing. A recorded
  `test` PASS for the exact sha is also what satisfies the 2026-10-12 rule above, so a re-push of the
  same commit never re-runs the suite.
- **A busy or unreachable box never bills by default:** with an open PR it reads that PR's run by sha;
  without one it ends NO VERDICT (exit 6). `--actions`/`--urgent` still dispatch on request.

The 2026-10-04 account follows, kept for its evidence.

`node scripts/remote-check.mjs test` runs the unit suite on the preview box against the **committed**
sha using the same `test:sharded` runner as CI, with its CPU/memory ceiling and coverage refusal.
This also applies to the test stage inside `remote-check.mjs all`. Nothing runs on the laptop and
the box run consumes no Actions minutes; actual time depends on available capacity. A push follows only a final
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

### A rule-recomputing script runs from a tree on `origin/main`

A script that recomputes a business rule — the store-split net, the split half of the publication
drift — brings **its own copy of the rule** to the comparison, so the checkout it runs in is one of
its inputs. The primary checkout's local `main` is never fast-forwarded, which makes it the worst
tree on the machine for this and the easiest one to be sitting in.

Measured on 2026-10-09. Three store-split rulings merged between 19:16 and 19:29 Cairo and were live
on production at 19:39:58 (#5685's twelve warehouse stems, #5687's طاى جروب, #5689's `تامين`
government word). At 19:35 a session ran `backfill-attribution-store-split.ts --apply 2026-09` in
the primary, still at `077e838dd`, and wrote **423 net rows** computed by pre-merge code — Pedia 87
/ Anti Infective 47 / CNS 289, against the 53 and 309 that current code gives. The figure reached the
owner before it was caught. The same tree had already read `DRIFTED — 213 cells / 45,021.99 EGP`
minutes after a correct rebuild. Nothing downstream could have caught either: the split preserves
every line's unit total, so the units-based publication drift check reads clean by construction.

`scripts/lib/tree-is-current.ts` is the answer, called by `backfill-attribution-store-split.ts`,
`check-store-split-drift.ts` and `check-closing-publication-drift.ts` before they build a
production client.

- **It tests ancestry, not equality.** `origin/main` must be an ancestor of HEAD, so a feature
  branch carrying an unmerged rule change still runs — a guard that refused those would be switched
  off within a day.
- **It fetches `origin/main` first** (best effort, 20s): the local remote-tracking ref can itself be
  hours old, and a comparison against a stale ref is the same defect wearing a check.
- **A behind tree exits 69** (EX_UNAVAILABLE, distinct from the 64 an unknown flag answers with),
  naming both shas, how many commits are missing, `node scripts/new-session.mjs <task>` as the way
  out, and the stand-down.
- **It fails open only when git cannot answer at all** — no `origin/main` ref, no git — and says so
  loudly, so a clone without a remote stays usable.
- **`PHX_STALE_TREE_OK=1 <cmd>`** stands it down for one deliberate pre-merge run, printing that
  the numbers carry this tree's code rather than main's.

Pinned by `tests/store-split-stale-tree-guard.test.ts`, which builds a real bare remote and a clone
genuinely one commit behind it, and was proven by breaking it three ways — dropping the fetch,
allowing a behind tree, and unwiring the call from `check-store-split-drift.ts` — each of which
fired its own headline assertion.

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

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §7 — What gates a change

`check:harden` and the `ask-before-validation` hook are retired at the owner's instruction. Do not
reintroduce them or invent a replacement — no "quick subset" of lint + typecheck before pushing, no
`pnpm run ci` as a pre-push ritual. 🔴 **No step stands in front of the push any more: commit, push,
open the PR, and its checks are the verdict** (owner, 2026-10-08, retiring the 2026-10-04 "remote-check
test before every push"). `node scripts/remote-check.mjs <check>` is optional — once, with
`run_in_background: true`, acting on the notification, never a poll loop or a foreground run (bash-guard C14, C15) — and
`.claude/hooks/push-typecheck-guard.mjs` only reads a recorded verdict for the exact sha, refusing
solely on a recorded typecheck FAIL (`docs/testing.md`, "Before every push"). The two
**required** checks — `validate` (the `check:*` contracts, **the unit suite**, the build on a PR whose
diff can change it, and on non-PR events the build and login smoke) and `checks` (lint, `next typegen`, typecheck) — run on the PR head commit
and block the merge if either is red. 🔴 **THE UNIT SUITE MOVED BACK INTO `validate` ON 2026-09-30, FOR
WALL CLOCK, AND IT IS STILL INSIDE A REQUIRED CHECK.** `checks` ran typecheck (111s) then the suite
(97s) in SERIES on one runner — 80% of a PR's ~260s wait — while `validate` sat on ~37s of work since
the build was gated off pull requests. Beside the typecheck instead of behind it, a PR is ~163s.
🔴 **It is NOT a job called `test`, and must not become one:** that is a retired check name, and a job
protection does not require reads on a PR exactly like one that gates (#3950). `lint`, `typecheck` and
`test` still do not exist as check names. A doc naming any of them as a job or a check name is stale —
but **a pinned test now belongs in `validate`, not `checks`**.

### §7 — Never take "pinned by a required check" on trust; the local typecheck deny

🔴 **NEVER TAKE "PINNED BY A REQUIRED CHECK" ON TRUST, AND NEVER COUNT TO A NUMBER A DOC GAVE YOU —
read the protection API.** Both halves cost real incidents: the 2026-09-17 split left `test` OUT of
protection until 09-18, so every locked-rule test went red without blocking a merge; and the
2026-09-27 rename left 19 places in this repo telling sessions to wait for six checks that can never
all report again. 🔴 **The 2026-09-29 drop was DELIBERATE, not rot** — `mobile` and `secret-scan`
left protection minutes before #4800 took them off the pull request, and the two HAD to move
together: **a required check whose job no longer reports leaves every PR on "Expected — waiting for
status" and nothing can ever merge.** So demoting a check and un-wiring its job are ONE change in
one window, never two — either half alone is a permanent block or the 2026-09-17 shape. Only this
doc lagged, and `node scripts/check-required-checks.mjs` is what catches that lag. `pnpm run ci` is
opt-in: run it **only when the owner names it**.

🔴 **A LOCAL TYPECHECK IS NOW DENIED MECHANICALLY — `bash-guard.mjs` C8, live 2026-09-25 — in every
spelling**, including `pnpm/npm/yarn run typecheck`, `npx`/`pnpm exec tsc --noEmit`,
`node …/typescript/bin/tsc`, `lib/tsc.js`, `.bin/tsc`, a quoted node path, and any script whose body
resolves to one. It had to become a hook because the rule above did not hold on its own: a reaped
typecheck prints **nothing** and exits non-zero, which a session cannot tell from a typo, so it tries
another spelling — **23 of 23 node jobs the memory watchdog killed in its surviving log window were a
typecheck**, six of them inside ten minutes. `PHX_TYPECHECK_OK=1 <cmd>` (`$env:PHX_TYPECHECK_OK=1;`
in PowerShell) stands it down for one command you will sit and watch. Pinned by
`tests/local-typecheck-guard.test.ts`.
