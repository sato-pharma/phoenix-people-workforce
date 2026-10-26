#!/usr/bin/env node
// THE OFFLINE REPO-WIDE CONTRACT GATES, AND THE DRIVER THAT RUNS THEM ALL.
//
// WHY THIS EXISTS. Measured 13 Oct 2026 Cairo on ci.yml / pull_request: 12.1% of runs failed over
// 4-8 Oct, 20.0% over 9-11 Oct, and 40.5% over 12 Oct 00:00 - 13 Oct 06:00. Of the 106 failed runs
// since 9 Oct, 94 failed in `validate/Test` — and what fails there is repeatedly NOT the PR's own
// feature test but a WHOLE-REPO CONTRACT GATE the change had nothing to do with. A session could
// not see any of them before pushing: a local typecheck is denied (bash-guard C8), the unit suite
// runs only on the box (~125s) or in the PR's own validate (~210s), tests/run-tests.ts has no
// per-test filter, and `runTest` RETHROWS at the first failure — so one red gate hides the rest and
// the next push finds a second one.
//
// Every gate below is offline: node:fs plus source text. No Supabase client, no env, no network.
// So they all run here in seconds, and — the point — THE RUN CONTINUES PAST A FAILURE, which the
// sharded suite structurally cannot do.
//
// 🔴 EACH GATE IS THE SUITE'S OWN EXPORTED RUN FUNCTION, IMPORTED. Never a second copy of an
// assertion: a gate re-implemented here would drift from the one that actually gates the merge, and
// then this script's PASS would be a lie. If a gate is renamed or retired, the table below stops
// matching tests/run-tests.ts and `tests/check-contracts.test.ts` goes red — it is not possible for
// this file to quietly run nothing.
//
// 🔴 NOTHING IS LEFT OUT ANY MORE, AND THE LAST ONE IN COST A SMALL REFACTOR. "the
// Office-allocation board row" (tests/needs-you-office-allocation-drift.test.ts) was the one
// candidate this script could not take: it imported src/lib/needs-you/sources.ts — ~30 `@/lib/**`
// imports including @/lib/admin/service, whose head is `getSupabaseAdmin` from
// @/lib/supabase/server. Nothing reaches the network at import time (the client is built inside the
// call), but a Supabase client and @/lib/env land in the process, which is the one thing every gate
// here must not do. The fix was not to loosen the rule: the pure function the test actually
// exercises moved, unchanged, into src/lib/needs-you/office-allocation-drift-items.ts — whose whole
// import graph is office-distributor -> sales/contracts, needs-you/types and needs-you/item-fields,
// all import-free or nearly so — and the test now reads the ADAPTER from source text, which is what
// it already did for everything else it pins. `tests/check-contracts.test.ts` walks that graph
// TRANSITIVELY, so a service import added anywhere beneath that wrapper fails the suite instead of
// silently putting a database client back in this process.
//
// This file is BOTH the table (imported by scripts/check-contracts.mjs and by the test) and the
// child entry point. The driver runs only under the main-module guard at the bottom — the idiom in
// scripts/module-memory/build.mjs and .claude/hooks/module-memory-injector.mjs — so importing this
// module executes nothing.
'use strict';

import { createHash } from 'node:crypto';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { availableBytes } from './run-tests-sharded-plan.mjs';

/**
 * The node flags the gates need, taken from `package.json`'s `test` script — minus one.
 *
 * 🔴 `--env-file-if-exists=.env.local` IS DELIBERATELY ABSENT. That flag is what makes
 * `pnpm run test` run with PRODUCTION Supabase credentials in the process
 * (`the-test-suite-runs-with-production-credentials-and-app-env-production`). An offline gate needs
 * none of it, and a check a session is encouraged to run on every branch must not load them.
 * `package.json`'s `coverage` script omits it for the same reason.
 * `tests/check-contracts.test.ts` asserts it never comes back.
 *
 * The other three are all load-bearing: `--experimental-strip-types` for every `.ts` import,
 * `--experimental-specifier-resolution=node` for the extensionless ones, and the alias loader for
 * the `@/…` hops (react-418-hydration-safe-text reaches @/lib/format/cairo-zone through two).
 */
export const TS_NODE_FLAGS = [
  '--experimental-strip-types',
  '--experimental-specifier-resolution=node',
  '--experimental-loader',
  './tests/alias-loader.mjs',
];

/** The child this launcher runs — relative to the repo root, which is also the required cwd. */
export const GATE_RUNNER = 'scripts/check-contracts-gates.mjs';

/**
 * One offline repo-wide gate.
 *
 * 🔴 THIS TYPEDEF IS LOAD-BEARING, NOT DECORATION. `tsconfig.json` has `allowJs` with `strict`, so
 * the `.ts` test that imports this module type-checks against whatever is inferred here — and an
 * un-annotated parameter makes a function return `any[]`, which turns every `.map((gate) => …)` in
 * the TEST into `TS7006: Parameter 'gate' implicitly has an 'any' type`. That is a red `checks` job
 * caused by a missing comment in a file nothing type-checks directly, and it is how this very PR
 * first went red. `scripts/run-tests-sharded-plan.mjs` annotates its exports for the same reason.
 *
 * @typedef {object} ContractGate
 * @property {string} slug short machine name, and the unit of shard coverage
 * @property {string} file the test file, relative to the repo root
 * @property {string} export the run function that file exports
 * @property {string} namePrefix the opening of the name it is registered under in run-tests.ts
 * @property {number | null} redJobs failing CI jobs it caused 9-13 Oct 2026, or null
 * @property {number} costMs measured run time, a packing hint only
 */

/**
 * One entry per gate.
 *
 * `namePrefix` is the opening of the name the gate is registered under in tests/run-tests.ts,
 * verbatim. It is what this script prints, and `tests/check-contracts.test.ts` asserts the real
 * registered name still starts with it — so the two cannot drift apart silently. (The prefix rather
 * than the whole name because several of those names are a thousand characters of prose.)
 *
 * `redJobs` is the number of failing CI jobs that gate caused between 9 and 13 Oct 2026, which is
 * why it is here. `null` means it was named among the 12 Oct reds without its own count, or that it
 * fires on the shape of push this script exists to serve.
 *
 * `costMs` is this gate's measured run time (cold, 13 Oct 2026, the owner's 16 GB laptop) and is
 * ONLY a packing hint for {@link shardGates}. A stale figure costs an unbalanced split and nothing
 * else — never correctness — so it is not worth maintaining, and no test pins it.
 *
 * @type {ContractGate[]}
 */
export const CONTRACT_GATES = [
  {
    slug: 'agents-long-hooks-cite-docs',
    file: 'tests/agents-long-hooks-cite-docs.test.ts',
    export: 'runAgentsLongHooksCiteDocsTests',
    namePrefix: 'AGENTS.md long hooks cite their account in docs/',
    redJobs: 23,
    costMs: 149,
  },
  {
    slug: 'access-registry-coverage',
    file: 'tests/access-registry-coverage.test.ts',
    export: 'runAccessRegistryCoverageTests',
    namePrefix: 'access registry coverage',
    redJobs: 8,
    costMs: 6907,
  },
  {
    slug: 'neutral-wording',
    file: 'tests/neutral-wording.test.ts',
    export: 'runNeutralWordingTests',
    namePrefix: 'Nothing this app shows anybody assumes its subject is a man',
    redJobs: 6,
    costMs: 8214,
  },
  {
    slug: 'comment-strip-ratchet',
    file: 'tests/comment-strip-ratchet.test.ts',
    export: 'runCommentStripRatchetTests',
    namePrefix: 'no source-pinning test strips comments unsafely',
    redJobs: 6,
    costMs: 1907,
  },
  {
    slug: 'react-418-hydration-safe-text',
    file: 'tests/react-418-hydration-safe-text.test.ts',
    export: 'runReact418HydrationSafeTextTests',
    namePrefix: 'hydration-safe Cairo text: engine-independent month names',
    redJobs: 5,
    costMs: 1532,
  },
  {
    slug: 'portal-route-skeleton',
    file: 'tests/portal-route-skeleton.test.ts',
    export: 'runPortalRouteSkeletonTests',
    namePrefix: 'portal route skeleton (six shapes behind one door',
    redJobs: 4,
    costMs: 92,
  },
  {
    slug: 'module-memory',
    file: 'tests/module-memory.test.ts',
    export: 'runModuleMemoryTests',
    namePrefix: 'Module memory (owner, 2026-10-02)',
    redJobs: 3,
    costMs: 866,
  },
  {
    slug: 'audit-entity-types',
    file: 'tests/audit-entity-types.test.ts',
    export: 'runAuditEntityTypesTests',
    namePrefix: 'audit entity types',
    redJobs: null,
    costMs: 8,
  },
  {
    slug: 'test-wiring-complete',
    file: 'tests/test-wiring-complete.test.ts',
    export: 'runTestWiringCompleteTests',
    namePrefix: 'test wiring is complete',
    redJobs: null,
    costMs: 596,
  },
  {
    // The one `checks/Typecheck` red a source-text gate can actually see: 3 of the 17 were TS2554
    // in tests/run-tests.ts, where a rerere-replayed merge folds two registrations into one call.
    // The other 14 were ordinary type errors across src/ and app/, which need a real compiler —
    // see the note this script prints at the end of every run.
    slug: 'run-tests-registration-shape',
    file: 'tests/run-tests-registration-shape.test.ts',
    export: 'runRunTestsRegistrationShapeTests',
    namePrefix: 'every runTest( call in this very file is',
    redJobs: 3,
    costMs: 165,
  },
  {
    // The gate the first version of this script could not take — see the note at the top. Its
    // function now lives in src/lib/needs-you/office-allocation-drift-items.ts, so the only thing
    // this gate loads is that pure module; the adapter in needs-you/sources.ts is read as text.
    slug: 'needs-you-office-allocation-drift',
    file: 'tests/needs-you-office-allocation-drift.test.ts',
    export: 'runNeedsYouOfficeAllocationDriftTests',
    namePrefix: 'the Office-allocation board row reports a month whose COMMITTED Office spread',
    redJobs: null,
    costMs: 120,
  },
  {
    // Same shape as the row above, and offline for the same reason: the function lives in
    // src/lib/needs-you/seat-drift-items.ts, whose only runtime imports are ./types; the drift
    // shape arrives as a type-only import that `--experimental-strip-types` erases, and the
    // adapter in needs-you/sources.ts is read as TEXT.
    slug: 'needs-you-seat-drift',
    file: 'tests/needs-you-seat-drift.test.ts',
    export: 'runNeedsYouSeatDriftTests',
    namePrefix: 'the organogram seat-drift board row reports an active person whose employees record',
    redJobs: null,
    costMs: 120,
  },
  // THE 2026-10-23 REPEAT OFFENDERS. Read from the failing-test lines of 126 red PR runs, 8-23 Oct 2026
  // (every one of 19-23 Oct, every third of 8-18 Oct): ten tests turned unrelated PRs red again and
  // again without being in this table. These four are the ones that are offline (source text only)
  // and fast; each comment gives how many different PRs it turned red in that sample. `redJobs` stays
  // null because that field is printed as a 9-13 Oct count. Left to the PR's own CI, deliberately:
  //   - tests/unknown-flag-gates.test.ts (6 PRs) spawns every argument-parsing script and ran past
  //     five minutes here — its source half is a gate since 26 Oct, see the end of this list;
  //   - HR function governance (5), sidebar labels never clip (3), Phoenix CRM edges (3) and the
  //     malformed uuid id guards (2) reach @/lib/supabase/server, so they are not offline. (The
  //     sidebar test's missing-width half is a gate since 26 Oct — see the end of this list.)
  {
    // 3 PRs.
    slug: 'recruitment-premium-depth',
    file: 'tests/recruitment-premium-depth.test.ts',
    export: 'runRecruitmentPremiumDepthTests',
    namePrefix: "recruitment and the ATS carry the owner's premium polish",
    redJobs: null,
    costMs: 278,
  },
  {
    // 2 PRs.
    slug: 'employee-portal-premium-depth',
    file: 'tests/employee-portal-premium-depth.test.ts',
    export: 'runEmployeePortalPremiumDepthTests',
    namePrefix: "the employee portal carries the owner's premium polish",
    redJobs: null,
    costMs: 353,
  },
  {
    // 2 PRs.
    slug: 'heredoc-backslash-damage',
    file: 'tests/heredoc-backslash-damage.test.ts',
    export: 'runHeredocBackslashDamageTests',
    namePrefix: 'heredoc backslash damage sweep (no control byte in source',
    redJobs: null,
    costMs: 3300,
  },
  {
    // 2 PRs.
    slug: 'hr-id-storage-casing',
    file: 'tests/hr-id-storage-casing.test.ts',
    export: 'runHrIdStorageCasingTests',
    namePrefix: 'hr ids are stored in canonical casing everywhere',
    redJobs: null,
    costMs: 4960,
  },
  // THE 2026-10-26 SPLITS. Read from all 187 failed jobs of 18-25 Oct 2026: two tests that the list above
  // had to leave to CI kept turning branches red on a part of them that needs nothing but the source
  // text. Each was split, and only that half is here; the rest still runs in the PR's own CI.
  {
    // 10 jobs on 8 branches; 9 of the 11 messages were a new refuseUnknownFlags gate missing from PINNED.
    // The probes that spawn every script stay in runUnknownFlagGatesTests.
    slug: 'unknown-flag-gates-source',
    file: 'tests/unknown-flag-gates.test.ts',
    export: 'runUnknownFlagGatesSourceTests',
    namePrefix: 'the unknown-flag source ratchets',
    redJobs: null,
    costMs: 790,
  },
  {
    // 9 jobs on 6 branches, the unrelated ones (calendar, CRM team statistics, the admin delete) all
    // on these scans: a migration or reader naming a manager-plan table. The rest of the manager-plan
    // test reaches src/lib/phoenix-crm/server and is not offline.
    slug: 'phoenix-crm-manager-plan-source',
    file: 'tests/phoenix-crm-manager-plan-source.test.ts',
    export: 'runPhoenixCrmManagerPlanSourceTests',
    namePrefix: 'the CRM manager-plan source scans',
    redJobs: null,
    costMs: 2660,
  },
  // THE 2026-10-26 FORGOTTEN STEPS. Two more reds of 18-25 Oct were a step a session forgot, not a bug:
  // a sidebar label added without re-measuring it, and a puppeteer-core bump that never reached the
  // runtime image's pin. Both checks are offline once a value import is moved out of the way, so they
  // are here, and dockerfile-reproducible comes with the second because it reads the same pin.
  {
    // 4 jobs on 4 branches, all the missing-width message. Offline since system-navigation.ts reads
    // adminShellEmployeeRoles from src/lib/auth/admin-shell-roles.ts instead of permissions.ts; the
    // no-clip half needs the permission matrix and stays in tests/sidebar-label-width.test.ts.
    slug: 'sidebar-label-snapshot',
    file: 'tests/sidebar-label-snapshot.test.ts',
    export: 'runSidebarLabelSnapshotTests',
    namePrefix: 'sidebar label snapshot has a measured width',
    redJobs: null,
    costMs: 400,
  },
  {
    // 3 jobs on 2 branches: the weekly dependency refresh of 25 Oct (image 25.15.0, lock 25.16.0) and
    // Dependabot's 25.13.0 bump, twice. Neither could have run sync-runtime-extras; both now do or
    // are told to (lockfile.yml, dependabot.yml).
    slug: 'offer-pdf-runtime',
    file: 'tests/offer-pdf-runtime.test.ts',
    export: 'runOfferPdfRuntimeTests',
    namePrefix: "offer PDF runtime (the image's puppeteer pin matches package.json",
    redJobs: null,
    costMs: 300,
  },
  {
    // Never red on its own in that window only because the old rethrow stopped the run at the
    // puppeteer gate first: it pins the same two versions (puppeteer-core AND sharp) against
    // pnpm-lock.yaml, from file text alone.
    slug: 'dockerfile-reproducible',
    file: 'tests/dockerfile-reproducible.test.ts',
    export: 'runDockerfileReproducibleTests',
    namePrefix: 'the production image is built from pinned inputs',
    redJobs: null,
    costMs: 200,
  },
];

/**
 * Import specifiers that take a gate out of scope for this script.
 *
 * A gate reached through one of these is not offline — it puts a database client, the env bag or
 * the Next runtime in the process — so it belongs to the PR's own `validate`, not here.
 * `tests/check-contracts.test.ts` runs this over every gate's WHOLE resolvable import graph, not
 * its first level, so neither the table nor anything beneath a gate can grow one quietly.
 *
 * `/needs-you/sources` is named here by hand because that module reaches the Supabase client
 * several hops down, through a specifier none of the other patterns match.
 */
export const NOT_OFFLINE = /supabase|@\/lib\/env|^next\/|\/needs-you\/sources/;

// ---------------------------------------------------------------------------------------------
// TOOL GATES — a red CI step this script can reproduce by RUNNING A TOOL rather than by calling
// one of the suite's own run functions.
//
// 🔴 THEY ARE A SEPARATE LIST ON PURPOSE. Every entry in CONTRACT_GATES is the suite's own exported
// function, held against tests/run-tests.ts by the test — that invariant is what makes a PASS here
// mean the same thing as a PASS in `validate`. A lint run has no such function to import, so
// folding it into that table would have meant loosening the one check that keeps this script
// honest. It gets its own list, its own reporting line, and its own place in the summary.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} ToolGate
 * @property {string} slug
 * @property {string} what one line, printed by `--list`
 * @property {number | null} redJobs failing CI jobs it caused 9-13 Oct 2026
 * @property {number} reserveBytes resident set its child needs, reserved out of the shard budget
 */

/**
 * The tool-reproducible gates.
 *
 * All 5 of the `checks/Lint` reds between 9 and 13 Oct 2026 were ESLint ERRORS on files the PR had
 * changed — 3 × `react-hooks/set-state-in-effect` ("Calling setState synchronously within an
 * effect"), 1 × "Cannot create components during render", 1 × five counts of
 * `@typescript-eslint/no-explicit-any`. Not one was elsewhere in the repo, which is what makes this
 * cheap: the branch's own diff is the whole exposure.
 *
 * `validate/Check migrations` was 4 more of those reds, and it is the ONLY red step left that this
 * script can answer for in full — not a sample of it, the step itself: CI runs
 * `pnpm run check:migrations`, which is `node scripts/check-migrations.mjs`, and this gate spawns
 * that same file. Nothing is re-implemented, so a PASS here is the step's own verdict.
 *
 * @type {ToolGate[]}
 */
export const TOOL_GATES = [
  {
    slug: 'changed-files-lint',
    // No red count in here: `--list` prints `redJobs` beside it, and carrying the figure in both
    // read as "(the 5 checks/Lint reds, 9-13 Oct 2026)  (5 red CI jobs, 9-13 Oct 2026)".
    what: 'ESLint ERRORS on the files this branch changed',
    redJobs: 5,
    // It loads typescript-eslint's parser and the whole rule set, which is heavier than a gate
    // shard even for one file.
    reserveBytes: 500 * 1024 * 1024,
  },
  {
    slug: 'migration-check',
    what: "the migration folder, through validate's own `check:migrations` script",
    redJobs: 4,
    // `node:fs` over supabase/migrations plus one `git ls-tree`. Measured 465-490 ms and a peak
    // well under this; it is here so the shard division accounts for the child at all.
    reserveBytes: 64 * 1024 * 1024,
  },
];

/**
 * Memory the tool-gate children need together, reserved out of {@link contractShardCount}'s budget
 * because they run ALONGSIDE the shards rather than after them.
 *
 * Summed from the table rather than written as a figure, so adding a tool gate cannot forget it.
 */
export const TOOL_GATE_BYTES = TOOL_GATES.reduce((sum, gate) => sum + gate.reserveBytes, 0);

/**
 * The migration gate's script, relative to the repo root.
 *
 * 🔴 IT IS THE SAME FILE `package.json`'s `check:migrations` NAMES, AND THE SAME ONE `ci.yml`'s
 * "Check migrations" STEP RUNS. `tests/check-contracts.test.ts` asserts all three still agree: a
 * second copy of those rules, or a path that drifted, would make a PASS here mean something the CI
 * step does not. It is offline by the same standard as every other gate — `node:fs` over
 * `supabase/migrations`, plus one `git ls-tree origin/main` that FAILS OPEN when there is no
 * `origin/main` to read, so a stale local ref can leave a collision unseen and never fakes a pass.
 */
export const MIGRATION_CHECK_SCRIPT = 'scripts/check-migrations.mjs';

/**
 * The one line of `check-migrations.mjs` output worth reporting as this gate's detail.
 *
 * 🔴 THE **LAST** `[migration-check]` LINE, NOT THE FIRST. That script prints a `[migration-check]
 * WARN: …` line per warning as it goes and its count summary at the end, so a first-match read
 * reports one warning as the whole verdict — and on this repo today it would, because a `DROP TABLE`
 * with no `-- SAFE:` annotation warns on every run and still passes. Warnings are not what reddens
 * the step; errors are.
 *
 * @param {string} output the child's stdout (its stderr carries the warnings and the error summary)
 * @returns {string | null}
 */
export function migrationDetail(output) {
  const lines = String(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[migration-check]') && !/^\[migration-check\]\s*WARN/i.test(line));
  const last = lines[lines.length - 1];
  return last ? last.replace(/^\[migration-check\]\s*/, '') : null;
}

/** Extensions `eslint.config.mjs` actually has rules for. Anything else is not worth a child. */
export const LINT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Above this many changed files the lint is SKIPPED rather than run.
 *
 * A branch this wide is not the case this script serves — it is a rebase or a generated sweep, the
 * lint would dominate a check whose whole promise is seconds, and the PR's own `checks` job covers
 * it either way. Skipping is reported as a skip, never as a pass.
 */
export const MAX_LINT_FILES = 200;

/**
 * The three git reads that define "the files this branch changed", in order.
 *
 * 🔴 `git diff <base>` IS AGAINST THE WORKING TREE, NOT THE LAST COMMIT — deliberately. A session
 * runs this BEFORE committing, so the files it is about to be judged on are usually still dirty;
 * diffing base..HEAD would lint the previous version of the work and report on code the PR will not
 * contain. `ls-files --others` is there for the same reason one step further out: a brand-new route
 * file is untracked until it is added, and a new `app/api` route is exactly what goes red.
 *
 * @param {string} base the merge-base sha
 * @returns {string[][]}
 */
export function changedFileCommands(base) {
  return [
    ['diff', '--name-only', '--diff-filter=ACMR', base],
    ['ls-files', '--others', '--exclude-standard'],
  ];
}

/**
 * The lintable files among raw `git` output lines.
 *
 * 🛑 `mobile/` IS EXCLUDED. The mobile app is frozen (AGENTS.md §4) and its Expo typecheck reports
 * separately in CI without ever gating a merge, so a mobile file has nothing to say here.
 *
 * @param {string[]} outputs raw stdout from {@link changedFileCommands}
 * @returns {string[]}
 */
export function lintableChangedFiles(outputs) {
  const files = new Set();
  for (const output of outputs) {
    for (const raw of String(output).split('\n')) {
      const file = raw.trim();
      if (!file) continue;
      if (file.startsWith('mobile/')) continue;
      if (!LINT_EXTENSIONS.has(path.extname(file))) continue;
      files.add(file);
    }
  }
  return [...files].sort();
}

/** ESLint's own entry point. Spawned through node, never `pnpm exec` — bash-guard C6 in a worktree. */
export const ESLINT_BIN = 'node_modules/eslint/bin/eslint.js';

/**
 * The ESLint arguments, and why each one is here.
 *
 * `--quiet` reports ERRORS ONLY, which is exactly what reddens the CI step — every one of the five
 * reds was an error, and a warning has never failed it. It also sidesteps the known single-file
 * trap: "Unused eslint-disable directive" is a warning, so linting a subset of the repo cannot
 * manufacture a failure the full run would not have.
 *
 * `--no-warn-ignored` keeps a changed file that `eslint.config.mjs` ignores from printing a notice
 * about itself; `--cache` is what turns a 6.4s cold run into 2.9s warm, measured on 20 files.
 *
 * 🔴 THE CACHE LIVES OUTSIDE THE REPO. `.eslintcache` is gitignored but a developer's own full-repo
 * run writes it, and a check meant to be run casually must not fight over that file or leave an
 * untracked one behind — an earlier draft of this did exactly that and showed up in `git status`.
 *
 * @param {string[]} files
 * @param {string} cacheLocation
 * @returns {string[]}
 */
export function eslintArgs(files, cacheLocation) {
  return [ESLINT_BIN, '--quiet', '--no-warn-ignored', '--cache', '--cache-location', cacheLocation, ...files];
}

/**
 * Where the ESLint cache for this checkout goes: the OS temp dir, keyed by the checkout's own path.
 *
 * Keyed, because every worktree on this machine is a different tree with the same file names, and
 * one shared cache would hand one worktree's results to another.
 *
 * @param {string} root absolute path of the repo root
 * @returns {string}
 */
export function lintCacheLocation(root) {
  const key = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(tmpdir(), 'phx-check-contracts', key, 'eslintcache');
}

/**
 * What this check CANNOT tell you, printed at the end of every run.
 *
 * 🔴 SAYING SO IS THE POINT. 14 of the 17 `checks/Typecheck` reds between 9 and 13 Oct 2026 were
 * ordinary type errors across src/ and app/ — TS18047, TS2741, TS2322, TS2559, TS2366, TS2345,
 * TS2339, TS2769 — and no amount of source-text gating finds one of those; only a compiler does.
 * A tool that quietly covered 3 of 17 while reading as "the types are fine" would be worse than no
 * tool, because a green run here would buy a confidence it has not earned.
 */
export const TYPECHECK_NOTE =
  'Types are NOT covered here beyond the one shape above (run-tests-registration-shape, 3 of the 17\n' +
  '  checks/Typecheck reds 9-13 Oct 2026). The other 14 were ordinary type errors only a compiler\n' +
  '  finds, and a local typecheck is denied on this machine (bash-guard C8). For those:\n' +
  '      node scripts/remote-check.mjs typecheck      # reads the PR\'s `static` job on GitHub, nothing on this laptop';

/**
 * Resident set one gate shard needs. Measured on this repo: a shard loads only its own gates'
 * modules, not the suite's 2,200-file graph, so this is a fraction of
 * `run-tests-sharded-plan.mjs`'s 1.8 GB `SHARD_BYTES` — but it is not nothing, because
 * neutral-wording and access-registry-coverage each read most of `src/` and `app/` into strings.
 */
export const CONTRACT_SHARD_BYTES = 400 * 1024 * 1024;

/**
 * The ceiling on shards. Three, not four: the two expensive gates dominate the wall clock, so a
 * third shard already buys almost all of the win, and every extra child re-pays the ~1.3s node +
 * loader startup and another copy of whatever corpus its gates read.
 */
export const MAX_CONTRACT_SHARDS = 3;

/**
 * How many shards to run. `PHX_CONTRACT_SHARDS` overrides.
 *
 * 🔴 MEMORY IS A CEILING HERE AS WELL AS CPU, and on the owner's laptop it is the one that bites:
 * free RAM is routinely under 2.5 GB with a dozen sessions open, and `mem-watchdog.ps1` reaps any
 * node job when free RAM falls under 500 MB. A check a session runs casually, on every branch, must
 * not be the thing that triggers that — so it serialises itself rather than risk it.
 *
 * `availableBytes` is `run-tests-sharded-plan.mjs`'s, not a second copy: MemAvailable on Linux,
 * `os.freemem()` elsewhere.
 *
 * `reserveBytes` is memory this run has already promised to something else — in practice the
 * ESLint child of {@link TOOL_GATES}, which the launcher starts alongside the shards. Subtracting
 * it before the division is the difference between three shards plus a lint on a box with 1.6 GB
 * free and four node processes racing `mem-watchdog.ps1` for it.
 *
 * @param {string | undefined} override the raw `PHX_CONTRACT_SHARDS` value, or undefined
 * @param {{ cpus?: () => number, bytes?: () => number, gates?: number, reserveBytes?: number }} [probes] seam for the test
 * @returns {number}
 */
export function contractShardCount(override, probes = {}) {
  const gateCount = probes.gates ?? CONTRACT_GATES.length;
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`PHX_CONTRACT_SHARDS must be a positive integer, got ${override}`);
    }
    return Math.min(n, gateCount);
  }
  const cpus = (probes.cpus ?? availableParallelism)();
  const free = (probes.bytes ?? availableBytes)() - (probes.reserveBytes ?? 0);
  const byMemory = Math.floor((free * 0.8) / CONTRACT_SHARD_BYTES);
  return Math.max(1, Math.min(MAX_CONTRACT_SHARDS, cpus, byMemory, gateCount));
}

/**
 * The gates belonging to shard `index` of `total`, packed longest-first.
 *
 * Longest-processing-time-first rather than round-robin, because the costs here are wildly uneven —
 * one gate is 8.2s and another is 8ms — and interleaving by position would leave one shard holding
 * both expensive gates, which is the whole wall clock. Deterministic for a given gate list, which
 * is what lets the parent prove coverage.
 *
 * @param {ContractGate[]} gates
 * @param {number} index 1-based
 * @param {number} total
 * @returns {ContractGate[]}
 */
export function shardGates(gates, index, total) {
  if (total <= 1) return [...gates];
  const bins = Array.from({ length: total }, () => ({ load: 0, gates: [] }));
  for (const gate of [...gates].sort((a, b) => (b.costMs ?? 0) - (a.costMs ?? 0))) {
    const lightest = bins.reduce((min, bin) => (bin.load < min.load ? bin : min), bins[0]);
    lightest.gates.push(gate);
    lightest.load += gate.costMs ?? 0;
  }
  // Back into table order inside the shard, so the output reads predictably.
  const mine = new Set(bins[index - 1].gates.map((gate) => gate.slug));
  return gates.filter((gate) => mine.has(gate.slug));
}

/** The machine-readable line every shard prints, which is how the parent proves coverage. */
export const SHARD_RESULT_RE = /^PHX_CONTRACT_RESULT shard=(\d+)\/(\d+) ran=(\S*)$/m;

/**
 * Every gate the shards between them reported running, or the reason that is not all of them.
 *
 * @param {Array<{ index: number, out: string }>} outputs
 * @param {number} total
 * @param {ContractGate[]} [gates]
 * @returns {string[]}
 */
export function coverageProblems(outputs, total, gates = CONTRACT_GATES) {
  const problems = [];
  const ran = [];
  for (const { index, out } of outputs) {
    const line = SHARD_RESULT_RE.exec(out);
    if (!line) {
      problems.push(`shard ${index}/${total} printed no PHX_CONTRACT_RESULT line, so what it ran is unknown`);
      continue;
    }
    if (Number(line[2]) !== total) {
      problems.push(`shard ${index} reported a total of ${line[2]}, not ${total}`);
    }
    for (const slug of line[3].split(',').filter(Boolean)) ran.push(slug);
  }
  for (const gate of gates) {
    const times = ran.filter((slug) => slug === gate.slug).length;
    if (times === 0) problems.push(`no shard ran ${gate.slug}`);
    if (times > 1) problems.push(`${gate.slug} ran in ${times} shards`);
  }
  for (const slug of new Set(ran)) {
    if (!gates.some((gate) => gate.slug === slug)) problems.push(`a shard ran an unknown gate: ${slug}`);
  }
  return problems;
}

/**
 * How the gate's own failure reads.
 *
 * 🔴 THE OFFENDING VALUE IS PRINTED, NOT JUST THE MESSAGE. Most of these gates assert
 * `deepEqual(offenders, [], "a sentence")`, and a sentence without the offenders is unactionable —
 * "all app/api routes must be present in the access registry" does not say WHICH route. node
 * usually appends its own diff; when it does, repeating it would be noise, so this only adds the
 * rendering when the message does not already carry one.
 */
function explain(error) {
  const lines = [];
  const message = error && error.message ? String(error.message) : String(error);
  lines.push(message);
  if (error && error.code === 'ERR_ASSERTION' && 'actual' in error && !message.includes('actual')) {
    const shown = inspect(error.actual, {
      depth: 4,
      maxArrayLength: null,
      maxStringLength: null,
      breakLength: 100,
      sorted: true,
    });
    lines.push('actual: ' + shown);
  }
  if (error && error.stack && error.code !== 'ERR_ASSERTION') lines.push(String(error.stack));
  return lines.join('\n');
}

/**
 * Run every gate, in order, CONTINUING PAST A FAILURE.
 *
 * The suite has done the same since 26 Oct 2026 (`runTest` records a failure and carries on); until
 * then it rethrew, and one red gate told a session about a prefix of the gates and nothing about the
 * rest. Returns the slugs that failed.
 */
export async function runContractGates({
  gates = CONTRACT_GATES,
  log = console.log,
  err = console.error,
  summarize = true,
} = {}) {
  const failed = [];
  const startedAll = performance.now();

  for (const gate of gates) {
    const startedAt = performance.now();
    let run = null;
    try {
      // A URL, not a relative specifier: this module is reached by an absolute path from the
      // launcher, and a `../tests/…` string would resolve against whatever that path turned out to
      // be. The file URL is the same on Windows and on the CI box.
      const loaded = await import(new URL('../' + gate.file, import.meta.url).href);
      run = loaded[gate.export];
      if (typeof run !== 'function') {
        throw new Error(`${gate.file} does not export ${gate.export} as a function`);
      }
    } catch (error) {
      failed.push(gate.slug);
      err(`FAIL ${gate.slug} — could not be loaded`);
      err(indent(explain(error)));
      continue;
    }

    try {
      await run();
      log(`PASS ${gate.slug} (${(performance.now() - startedAt).toFixed(0)}ms)  ${gate.namePrefix}`);
    } catch (error) {
      failed.push(gate.slug);
      err(`FAIL ${gate.slug} (${(performance.now() - startedAt).toFixed(0)}ms)  ${gate.namePrefix}`);
      err(indent(explain(error)));
    }
  }

  // A sharded run leaves the summary to the parent, which is the only process that can count.
  if (summarize) {
    const totalMs = performance.now() - startedAll;
    if (failed.length === 0) {
      log(`\n${gates.length} contract gates passed in ${(totalMs / 1000).toFixed(1)}s.`);
    } else {
      err(
        `\n${failed.length} of ${gates.length} contract gates FAILED in ${(totalMs / 1000).toFixed(1)}s: ` +
          failed.join(', ') +
          '\nEach one is a whole-repo contract, not your feature — fix it here rather than in a red PR.',
      );
    }
  }
  return failed;
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const spec = /^(\d+)\s*\/\s*(\d+)$/.exec(process.env.PHX_CONTRACT_SHARD ?? '');
  if (process.env.PHX_CONTRACT_SHARD && !spec) {
    console.error(
      `PHX_CONTRACT_SHARD must read <index>/<total>, e.g. 1/3 — got ${JSON.stringify(process.env.PHX_CONTRACT_SHARD)}`,
    );
    process.exit(2);
  }
  const index = spec ? Number(spec[1]) : 1;
  const total = spec ? Number(spec[2]) : 1;
  if (spec && (total < 1 || index < 1 || index > total)) {
    console.error(`PHX_CONTRACT_SHARD is out of range: ${process.env.PHX_CONTRACT_SHARD}`);
    process.exit(2);
  }

  const mine = shardGates(CONTRACT_GATES, index, total);

  // Printed from `exit` rather than after the run, so a gate that takes the process down with it
  // still leaves the parent able to tell what this shard covered. The parent REFUSES on a missing
  // line — without that, a bad divisor is simply fewer gates reporting success.
  process.on('exit', () => {
    console.log(`PHX_CONTRACT_RESULT shard=${index}/${total} ran=${mine.map((gate) => gate.slug).join(',')}`);
  });

  // Awaited at top level, so the work is finished when this module finishes loading.
  const failed = await runContractGates({ gates: mine, summarize: total === 1 });
  process.exit(failed.length === 0 ? 0 : 1);
}
