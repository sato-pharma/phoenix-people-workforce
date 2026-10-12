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
