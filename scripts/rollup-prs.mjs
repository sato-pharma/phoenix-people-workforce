#!/usr/bin/env node
// Groups the open pull requests into the FEWEST merges that are still safe, and builds the roll-up
// branch for you. It never merges and it never closes anything without being told to.
//
// WHY IT EXISTS. A merge costs a full CI run on the PR and another on `main` — about 28 billable
// minutes, because GitHub rounds every job up to the whole minute. So the bill is driven by the NUMBER
// OF MERGES, not by the size of the changes: six open PRs merged one at a time cost roughly the same
// as six large ones. `bash-guard.mjs` clause C10 already refuses to merge a PR under
// `PHX_MERGE_MIN_FILES` files, which stops the cheap mistake — but it leaves you holding a small PR
// with nowhere to put it. This is the other half of C10: the place to put it.
//
// WHAT IT WILL NOT DO, and each of these is a rule rather than a limitation:
//
//   * It never merges. Merging is one of the two protected actions (AGENTS.md §6) and needs the
//     owner's word every time. The point of a roll-up is that he says it ONCE instead of six times.
//   * It never closes a PR unless you pass --close-superseded, and then only a `dependabot` one whose
//     files are a strict subset of another open PR. A human's PR is never closed by a script.
//   * It refuses to roll up anything carrying a migration, a protected file, or a frozen path. Those
//     need their own visible approval, and burying one inside a roll-up is how it gets approved by
//     accident.
//   * It never rolls up a PR whose REQUIRED checks have FAILED. One approval is supposed to be enough
//     to ship the roll-up; a member whose required check is red makes the roll-up red too, so the
//     owner's single approval can never go green until somebody else's unrelated fix lands — which is
//     the exact opposite of "never hand him more than one merge at a time". Measured 2026-09-30 with
//     three PRs open (#4877 red, #4882 green, #4883 pending): this script printed
//     `ONE branch can carry #4883 + #4882 + #4877` and `--apply` would have built it.
//   * And it never BUILDS over a member whose required checks have not FINISHED. That guard asked only
//     about terminal failure, so a PR whose checks were still queued rolled up as though it were
//     green: on 2026-09-30 `--apply` built #4896 from #4895 (green) and #4894 (queued), #4894 then went
//     red on four TypeScript errors in `src/lib/phoenix-crm/server/list.ts` plus two of its own tests,
//     and the roll-up inherited a red it could never clear — holding the GREEN PR hostage, because a
//     roll-up's members must not be merged separately. So `--apply` WAITS for the members' required
//     checks and builds only from the ones that finished green. Pending is deliberately NOT treated as
//     red in the classification: a roll-up is usually built minutes after a PR is opened, so refusing
//     every fresh PR would make this useless exactly when it is wanted. See `rollup-check-state.mjs`.
//   * It groups only PRs whose file sets are DISJOINT. Two PRs touching one file might merge cleanly
//     and still be wrong together — `tests/run-tests.ts` is the standing example: both sides append at
//     the same anchor, git puts the conflict INSIDE one `await runTest(` call, and keeping both sides
//     yields one call with four arguments that compiles, goes green, and silently retires one of the
//     two tests. Disjointness is cheap to verify and that class of damage is not.
//
//   node scripts/rollup-prs.mjs                  # measure and print the plan (default, changes nothing)
//   node scripts/rollup-prs.mjs --apply          # build the branch, push it, open ONE PR
//   node scripts/rollup-prs.mjs --max-files 3    # what counts as "small" (default: PHX_MERGE_MIN_FILES, else 4)
//   node scripts/rollup-prs.mjs --json           # the whole reading
//   node scripts/rollup-prs.mjs --close-superseded   # with --apply: close subsumed dependabot PRs
//   node scripts/rollup-prs.mjs --apply --wait 40    # how long to wait for the members' required checks
//                                                    # (minutes; default PHX_ROLLUP_WAIT_MINUTES, else 25)
//   node scripts/rollup-prs.mjs --apply --no-wait     # do not wait: build only from members already green
//   node scripts/rollup-prs.mjs --verify-heads        # read-only: has an open roll-up's member been pushed
//                                                     # since it was carried? exit 3 when one has
'use strict';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GITHUB_OWNER, REPO, readProtectionContexts } from './required-check-names.mjs';
import { rollupBranchName } from './rollup-branch-name.mjs';
import { isRollupBranch, overlappingRollup, rollupMemberHeads, rollupMembers } from './rollup-duplicate-guard.mjs';
import { staleRollupMembers } from './rollup-member-guard.mjs';
import { rollupBuildVerdict, MIN_MEMBERS } from './rollup-build-verdict.mjs';
import { pathDeltaLanded, registryAddedLinesLanded, SHARED_REGISTRY_PATH } from './rollup-carried.mjs';
import { membersReadyToBuild, requiredCheckState, requiredGateUsable, waitForRequiredChecks } from './rollup-check-state.mjs';

/** A merge pays a full run on the PR and another on `main`. Used only to report the saving. */
const BILLABLE_MINUTES_PER_MERGE = 28;

/**
 * Is this path the protected file `base` names — the file itself, or a directory it was split into?
 *
 * 🔴 IT IS NOT A STRING PREFIX, AND IT WAS, WHICH MISREPORTED A REAL PR. A bare
 * `startsWith('src/lib/sales/office-allocation')` also matches `office-allocation-drift.ts`, a
 * read-only neighbour that touches no locked formula — so on 2026-10-09 #5694 was reported to the
 * owner as carrying a protected file, and had to be corrected to him by hand. The locked region
 * lives in `office-allocation.ts` alone (CLAUDE.md, "Protected Files"). A prefix is wrong in the
 * same way for every entry: `payroll/policy-notes.ts` and `scheme-2026-archive.ts` are not locked
 * either.
 *
 * It still holds if a locked file becomes a FOLDER of that name, which is the only direction where
 * being loose is the safe mistake.
 */
const protectedFile = (base) => (p) => p === base || p.startsWith(`${base}.`) || p.startsWith(`${base}/`);

/**
 * Paths that must never be folded into a roll-up.
 *
 * A migration is applied BY HAND before its merge and is the one thing CI never checks, so it needs
 * its own approval and its own announcement. A protected file needs the owner's explicit word on that
 * specific change. `mobile/` and the Expo toolchain are frozen at the owner's instruction.
 */
const NEVER_ROLL_UP = [
  { test: (p) => p.startsWith('supabase/migrations/'), why: 'carries a migration — applied by hand, needs its own approval' },
  { test: (p) => p === 'CLAUDE.md', why: 'CLAUDE.md is a protected file — the owner approves that change specifically' },
  { test: protectedFile('src/lib/incentives/scheme-2026'), why: 'protected: the 2026 incentive curve' },
  { test: protectedFile('src/lib/payroll/policy'), why: 'protected: salary derivation' },
  { test: protectedFile('src/lib/sales/office-allocation'), why: 'protected: the Office golden rule' },
  { test: protectedFile('src/components/employee-portal/identity-card'), why: 'protected: the portal identity banner' },
  { test: (p) => p.startsWith('mobile/') || p === 'eas.json', why: 'the mobile app is frozen' },
];

/**
 * Reading a PR's required checks — RED, PENDING, or finished green — lives in
 * `rollup-check-state.mjs`, together with the account of why pending is a third answer and not a
 * flavour of red. The required list itself is never written down anywhere: it comes from
 * `branches/main/protection/required_status_checks`, read live by the same module
 * `scripts/check-required-checks.mjs` uses, because it has rotted five times (4 -> 5 -> 6 -> 4 -> 2)
 * and three of the names a doc still quotes stopped being check names on 2026-09-27 (AGENTS.md §2).
 *
 * A check that is red but NOT required must not disqualify anything: today two checks still run on a
 * PR and NEITHER gates the merge (protection read live 2026-09-29), so a red one of those is a thing
 * to read, not a reason to refuse a roll-up.
 */

const args = process.argv.slice(2);

/**
 * 🔴 AN UNKNOWN FLAG IS REFUSED, BECAUSE A SILENTLY IGNORED ONE IS INDISTINGUISHABLE FROM AN OLD SCRIPT.
 *
 * Every flag here arrived in a different merge, and a session runs this from its own worktree — whose
 * copy of the script can be days older than `main`. Ignoring an unrecognised flag means `--no-wait` on a
 * checkout that predates the wait runs the OLD behaviour, reports success, and builds over members whose
 * checks never finished: the operator reads the flag they typed as the behaviour they got.
 *
 * That is very probably what happened on 2026-09-30, when roll-up #4937 was reported as built by
 * `--apply --no-wait` over a member whose required checks were still running. The current code does not
 * reproduce it — measured, with `validate` success and `checks` in_progress the member reads
 * `settled=false` and is dropped — while a pre-wait copy of this script accepts `--no-wait` as a no-op
 * and behaves exactly as observed. A refusal makes that failure loud instead of invisible, whatever
 * version is on disk.
 */
const KNOWN_FLAGS = new Set([
  '--json', '--apply', '--close-superseded', '--settle', '--max-files', '--wait', '--no-wait',
  '--verify-heads',
]);
{
  const unknown = args.filter((a, i) => {
    if (!a.startsWith('--')) return args[i - 1] !== '--max-files' && args[i - 1] !== '--wait';
    return !KNOWN_FLAGS.has(a);
  });
  if (unknown.length > 0) {
    console.error(`[rollup] unknown argument(s): ${unknown.join(', ')}`);
    console.error('[rollup] Known: ' + [...KNOWN_FLAGS].join(', ')
      + '. A flag this copy of the script does not know is REFUSED rather than ignored — an ignored one '
      + 'reads as the behaviour you asked for while the old behaviour runs.');
    process.exit(2);
  }
}

const asJson = args.includes('--json');
const apply = args.includes('--apply');
const closeSuperseded = args.includes('--close-superseded');
const settle = args.includes('--settle');
const verifyHeads = args.includes('--verify-heads');

// 🔴 `--verify-heads` PROMISES READ-ONLY, AND BLOCK ORDER CANNOT KEEP THAT PROMISE. Its block sits
// after `--settle`'s, so `--verify-heads --settle` would close every carried PR and only THEN report
// — a mutation performed by the very run you asked to look without touching anything. Raised in
// review on #5201 before it could bite.
//
// Refused at PARSE time, which is the only place no side effect can precede it. Moving the
// verification block above `--settle` would not be enough: `--apply` pushes a branch and opens a PR
// further down, and `--close-superseded` closes bot PRs, so each would still mutate after a
// "read-only" run had been asked for. A combination whose meaning is contradictory is refused
// rather than silently ordered, for the same reason an unknown flag is.
if (verifyHeads && (settle || apply || closeSuperseded)) {
  const offenders = [settle && '--settle', apply && '--apply', closeSuperseded && '--close-superseded'].filter(Boolean);
  console.error(`[rollup] --verify-heads is READ-ONLY and cannot be combined with ${offenders.join(', ')}.`);
  console.error('[rollup] Those flags close, push or open things, and they run BEFORE the verification would '
    + 'report — so the combination mutates GitHub during a run asked for as a look. Run --verify-heads on '
    + 'its own, read the answer, then re-run with the write flag.');
  process.exit(2);
}
const maxFilesArg = (() => {
  const i = args.indexOf('--max-files');
  return i >= 0 ? Number(args[i + 1]) : NaN;
})();
const maxFiles = Number.isFinite(maxFilesArg)
  ? maxFilesArg
  : Number(process.env.PHX_MERGE_MIN_FILES ?? 4);

/**
 * How long `--apply` will wait for a member's required checks to FINISH before giving up on that one.
 *
 * 25 minutes is chosen from this repo's own numbers: the two required jobs settle in about 163s
 * side-by-side (AGENTS.md §7), and a busy hour queues runs behind each other rather than slowing them
 * down. So the wait is generous enough that the normal case never times out, and short enough that
 * nobody sits on it — a member that times out is not refused, it simply rolls up on the next run.
 * `--no-wait` builds from whatever is already green, which is the same tool without the patience.
 */
const WAIT_POLL_SECONDS = 30;
const noWait = args.includes('--no-wait');
const waitArg = (() => {
  const i = args.indexOf('--wait');
  return i >= 0 ? Number(args[i + 1]) : NaN;
})();
const waitMinutes = Number.isFinite(waitArg) && waitArg >= 0
  ? waitArg
  : Number(process.env.PHX_ROLLUP_WAIT_MINUTES ?? 25);

function gh(argv, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (err) {
    if (allowFail) return '';
    const detail = String(err?.stderr || err?.message || err).split('\n')[0];
    console.error(`[rollup] could not reach GitHub: ${detail}`);
    process.exit(1);
  }
}

function git(argv, { cwd = process.cwd(), allowFail = false, env, input, raw = false } = {}) {
  try {
    const out = execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
    // A patch must keep its trailing newline or `git apply` refuses it, so `raw` skips the trim.
    return raw ? out : out.trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------- read the open PRs

/**
 * `PHX_ROLLUP_FIXTURE=<file.json>` reads the PR set from a file instead of calling `gh`.
 *
 * It exists because the grouping rules are the whole value of this script and they have to be testable
 * in the required `checks` job, which has no network and no `gh` auth. Shimming `gh` onto PATH does NOT
 * work here: `execFileSync('gh', …)` without a shell resolves `.exe` but not a `.cmd` or an
 * extensionless script, so on this machine a shim is silently skipped and the REAL `gh.exe` runs — the
 * first attempt at that test reached `api.github.com` and timed out rather than failing as a miss.
 *
 * It is also useful by hand: an analysis of a past PR set can be re-run offline from a saved
 * `--json` capture. `--apply` is refused in this mode, because a snapshot is not the live repository.
 *
 * Shape: `[{ number, title, headRefName, headRefOid, paths: [...], author?, isDraft?, mergeStateStatus?,
 * carried?, redRequired?, checksPending?, statusCheckRollup? }]`
 *
 * `redRequired` and `checksPending` state the check verdict outright and BOTH DEFAULT TO FINISHED AND
 * GREEN, so every fixture written before either field existed keeps its verdict exactly.
 * `statusCheckRollup` is the richer seam: give it the real `[{ name, conclusion }]` shape, name the
 * gate with `PHX_ROLLUP_REQUIRED`, and the actual `requiredCheckState()` split runs — which is the only
 * way "red but NOT required", "required and still pending" and "required and green" can be told apart
 * offline, since all three collapse to `redRequired: false`.
 */
const fixturePath = process.env.PHX_ROLLUP_FIXTURE;

let open;
if (fixturePath) {
  open = JSON.parse(readFileSync(fixturePath, 'utf8')).map((p) => ({
    number: p.number,
    title: p.title ?? `pr ${p.number}`,
    headRefName: p.headRefName ?? `codex/pr-${p.number}`,
    headRefOid: p.headRefOid ?? String(p.number).padStart(40, '0'),
    changedFiles: p.paths.length,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    mergeStateStatus: p.mergeStateStatus ?? 'CLEAN',
    isDraft: p.isDraft ?? false,
    author: { login: p.author ?? GITHUB_OWNER },
    paths: p.paths,
    carriedFixture: p.carried === true,
    // Present-and-null is NOT the same as absent, and the difference is the only way to test the live
    // read offline. ABSENT means "this fixture states its own verdict" (and says nothing, so: green) —
    // that is what keeps every older fixture's verdict. PRESENT-AND-NULL is what GitHub actually
    // returns for a commit with no check contexts yet, so it takes the same normalisation the live read
    // takes and comes out PENDING. Without this distinction the fixture default would mask the live
    // hole permanently: the one branch a test can reach would be the one branch that is allowed to
    // answer "green" with no evidence.
    statusCheckRollup: 'statusCheckRollup' in p ? (p.statusCheckRollup ?? []) : null,
    redRequired: p.redRequired === true,
    pendingFixture: p.checksPending === true,
  }));
} else {
  open = JSON.parse(
    gh([
      'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100',
      '--json', 'number,title,headRefName,headRefOid,changedFiles,additions,deletions,mergeStateStatus,isDraft,author,statusCheckRollup',
    ]) || '[]',
  );
  for (const pr of open) {
    const detail = JSON.parse(
      gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'files,commits']) || '{"files":[],"commits":[]}',
    );
    pr.paths = detail.files.map((f) => f.path);
    // The head commit's own date, so a check that RAN BEFORE IT can be told from one that ran for it.
    // `statusCheckRollup` can still carry the previous commit's green runs for a while after a push, and
    // the stale-SHA guard cannot see that: the head has not moved, only the checks are old.
    pr.headCommittedAt = detail.commits?.[detail.commits.length - 1]?.committedDate ?? null;
    // 🔴 LIVE, A MISSING ROLLUP MEANS NOTHING HAS REPORTED — NEVER THAT NOTHING IS RED. GitHub returns
    // `statusCheckRollup: null` for a commit that has no check contexts yet, which is precisely a PR
    // opened seconds ago: the case a roll-up is most often built against. Left as null it falls through
    // to the branch where a FIXTURE states its own verdict, and a fixture that says nothing defaults to
    // finished-and-green — so the whole point of #4906's wait was silently skipped for the freshest
    // PRs, and `--no-wait` would build from one outright. Measured 2026-09-30 with a null rollup:
    // `settled=true`, and the member was carried into the group.
    //
    // Normalising to `[]` here sends it through the real filter instead, where every required name is
    // unreported and therefore PENDING. The fixture default is deliberately untouched: it keeps every
    // existing fixture's verdict, and it is now the only thing that branch serves.
    pr.statusCheckRollup = pr.statusCheckRollup ?? [];
  }
}

// ------------------------------------------------------- which checks actually gate, read live

/**
 * The live required list, as a Set — or `null` when the gate could not be read, which makes every
 * check count, red or unfinished (see `requiredCheckState`). Never a name from a file: AGENTS.md's own
 * §2 says to read protection and count against what it returns, because the list has rotted five times.
 *
 * In fixture mode there is no network, so `PHX_ROLLUP_REQUIRED` stands in; absent, the fixture is
 * judged the way an unreadable gate is, which is the same code path either way.
 */
const requiredEnv = process.env.PHX_ROLLUP_REQUIRED;
let requiredContexts = null;
let protectionNote = '';
if (fixturePath) {
  if (requiredEnv) requiredContexts = new Set(requiredEnv.split(',').map((s) => s.trim()).filter(Boolean));
  else protectionNote = 'fixture mode with no PHX_ROLLUP_REQUIRED — judging on every check';
} else {
  const live = readProtectionContexts();
  if (live.skipped) protectionNote = `${live.skipped} — judging on EVERY failed check, not just the required ones`;
  // An EMPTY contexts array is a SUCCESSFUL read that names nothing, which is what a rule moved to a
  // ruleset looks like (the classic array is deprecated). Kept as an empty Set it would make every entry
  // fail `required.has(name)` and every PR read green at once, on a 200. It is an unreadable gate in
  // every sense that matters here, so it is recorded as one and says which of the two it was.
  else if (live.contexts.length === 0) protectionNote = 'branch protection returned an EMPTY required-check list — a rule may have moved to a ruleset, and the classic contexts array is deprecated';
  else requiredContexts = new Set(live.contexts);
}

for (const pr of open) {
  // A fixture may state the verdict outright (`redRequired` / `checksPending`) or hand over the real
  // rollup shape; when it hands over the shape, the real split runs and its answer wins.
  if (pr.statusCheckRollup) {
    const state = requiredCheckState(pr.statusCheckRollup, requiredContexts, pr.headCommittedAt ?? null);
    pr.redChecks = state.red;
    pr.pendingChecks = state.pending;
  } else {
    pr.redChecks = pr.redRequired ? ['a required check (stated by the fixture)'] : [];
    pr.pendingChecks = pr.pendingFixture ? ['a required check (stated by the fixture)'] : [];
  }
  pr.redRequired = pr.redChecks.length > 0;
  // Nothing is left to wait for and nothing is red: the only state `--apply` may build from.
  pr.checksSettled = pr.redChecks.length === 0 && pr.pendingChecks.length === 0;
  // It is large, it is already distilled into the two lists, and `--json` dumps `open` whole.
  delete pr.statusCheckRollup;
  delete pr.pendingFixture;
}

for (const pr of open) {
  pr.isBot = /\[bot\]$/.test(pr.author?.login ?? '') || (pr.author?.login ?? '').includes('dependabot');
  pr.blockers = [];
  for (const rule of NEVER_ROLL_UP) {
    const hit = pr.paths.find((p) => rule.test(p));
    if (hit) pr.blockers.push(`${rule.why} (${hit})`);
  }
  // 🔴 A ROLL-UP IS NEVER A MEMBER OF ANOTHER ROLL-UP.
  //
  // Measured 2026-09-30: with #4920 ("roll up 2 open PRs into one merge") open, this script offered
  // `#4922 + #4920 + #4921` — a roll-up nested inside a roll-up, carrying #4918 and #4919 two levels
  // down. The duplicate guard does not catch it, and correctly so: that one asks whether an open
  // roll-up CARRIES something we want, and here the roll-up IS what we want, so there is no overlap
  // to find. Two shapes of one mistake, needing two rules.
  //
  // Nesting merges cleanly, which is why nothing objected to it. What it breaks is accountability:
  // AGENTS.md §6 says a roll-up's members must not be merged separately, and nesting makes that rule
  // TRANSITIVE with nothing tracking it — the inner roll-up stays independently mergeable while the
  // outer one claims to replace it, and whichever merges first leaves the other carrying content
  // already on main. The reported saving is double-counted too: the outer counts the inner as one
  // merge replaced, when the inner was already replacing several.
  if (isRollupBranch(pr.headRefName)) {
    pr.blockers.push('it is itself a roll-up (' + pr.headRefName + ') — a roll-up is never a member of another roll-up');
  }
}

// ---------------------------------------------------------------------------- classify

/**
 * SUBSUMED: every file this PR touches is also touched by another open PR that changes MORE files.
 *
 * The case this is built for: dependabot bumps a dependency in `pnpm-lock.yaml`, and a hand-written PR
 * then does the real migration across `package.json` + the lockfile + a test. Merging both means doing
 * the same upgrade twice, and the second one conflicts. The lockfile PR is not small-and-mergeable, it
 * is redundant.
 */
function subsumedBy(pr, others) {
  return others.find(
    (o) =>
      o.number !== pr.number
      && pr.paths.length > 0
      && pr.paths.every((p) => o.paths.includes(p))
      && o.paths.length > pr.paths.length,
  );
}

/**
 * ALREADY CARRIED: every file this PR touches is already on `main` — byte-identical, or its own
 * delta for that path already applied there (rollup-carried.mjs `pathDeltaLanded`).
 *
 * A squash merge does NOT make the branch's commits ancestors of `main`, so ancestry answers "no" for
 * a PR whose work has fully landed — which is how a roll-up's members look the moment it merges. On
 * 2026-09-30 this script proposed rolling #4817 up a second time, minutes after roll-up #4821 had
 * carried all seven of its files into `main` verbatim: a whole CI run to ship nothing.
 *
 * Blobs are the instrument, not ancestry. A PR with no files, or one whose paths no longer exist on
 * `main`, is NOT carried — `git rev-parse` answering nothing must never read as "identical".
 */
function alreadyCarried(pr) {
  if (!pr.paths.length) return false;
  // In fixture mode the blob comparison has no repository to ask, so the fixture states the answer.
  // What the test then exercises is the CLASSIFICATION — that `carried` outranks `rollable` and keeps
  // a landed PR out of a roll-up — while the two `git rev-parse` calls below are exercised live.
  if (fixturePath) return pr.carriedFixture === true;
  return pr.paths.every((p) => {
    // 🔴 ONE PATH CAN NEVER STAY BYTE-IDENTICAL, AND IT IS NOT EVIDENCE WHEN IT DIFFERS. The suite
    // registry is appended to by every PR that adds a test, so the moment ANY other PR registers a
    // suite, a carried PR's copy differs for reasons that have nothing to do with its own work.
    // Measured 2026-09-30: after roll-up #4937 merged, `--settle` closed #4930 and left #4936 open
    // although all of #4936's work was on `main` — two of three files byte-identical and its registry
    // lines present. The bytes were right; the question was wrong for that file.
    //
    // NARROWED, never loosened: every line the PR ADDED to the registry must be on `main`. A missing
    // registry line still means NOT carried, and every other path still has to match byte for byte.
    if (p === SHARED_REGISTRY_PATH) return registryLandedOnMain(pr);
    const mine = git(['rev-parse', `${pr.headRefOid}:${p}`], { allowFail: true });
    const main = git(['rev-parse', `origin/main:${p}`], { allowFail: true });
    const blobsEqual = Boolean(mine) && Boolean(main) && mine === main;
    // 🔴 BYTE-IDENTITY IS A PROOF, NOT THE QUESTION (owner, 2026-10-02, after #5096). It holds only
    // while nothing else has touched the file, which a roll-up of several members routinely breaks.
    // When the bytes disagree, ask whether this PR's OWN delta for this path is already applied on
    // `main` — rollup-carried.mjs carries the measurement and why a patch-id cannot answer it alone.
    return pathDeltaLanded({ blobsEqual, ...pathDeltaReadings(pr, p, blobsEqual) });
  });
}

/**
 * The two readings `pathDeltaLanded` needs when the bytes disagree: does this PR have a delta of its
 * own for the path, and does that delta reverse-apply against `main`'s tree.
 *
 * `git apply --check --reverse` succeeds only when every line the delta ADDS is present on `main` and
 * every line it REMOVES is gone — which is exactly "already applied", and is what patch-id is a means
 * to. It is asked with `--cached` against a THROWAWAY INDEX loaded from `origin/main`, so no file and
 * no real index is touched: this runs inside whatever worktree called the script.
 *
 * Every failure answers NOT landed. Unreadable base, empty delta, a patch that will not apply, a git
 * error: the PR stays open. One avoidable CI run is the cost of being wrong this way; the other way
 * closes somebody's unlanded work.
 */
function pathDeltaReadings(pr, p, blobsEqual) {
  if (blobsEqual) return { hasDelta: false, reverseApplies: false };
  const base = git(['merge-base', 'origin/main', pr.headRefOid], { allowFail: true });
  if (!base) return { hasDelta: false, reverseApplies: false };
  const patch = git(['diff', '--binary', base, pr.headRefOid, '--', p], { allowFail: true, raw: true });
  if (!patch || !patch.trim()) return { hasDelta: false, reverseApplies: false };
  const indexFile = join(mkdtempSync(join(tmpdir(), 'phx-settle-')), 'index');
  try {
    if (git(['read-tree', 'origin/main'], { allowFail: true, env: { GIT_INDEX_FILE: indexFile } }) === null) {
      return { hasDelta: true, reverseApplies: false };
    }
    const applied = git(['apply', '--cached', '--check', '--reverse', '-'], {
      allowFail: true,
      env: { GIT_INDEX_FILE: indexFile },
      input: patch,
    });
    return { hasDelta: true, reverseApplies: applied !== null };
  } finally {
    rmSync(dirname(indexFile), { force: true, recursive: true });
  }
}

/**
 * Whether this PR's own additions to the suite registry are present on `main`.
 *
 * The delta is taken against the MERGE BASE, not against `main` — a two-dot diff to `main` would show
 * other people's registrations as though this PR had removed them. Anything unreadable answers FALSE,
 * which keeps the failing-closed direction: a PR we cannot prove landed is left open.
 */
function registryLandedOnMain(pr) {
  const base = git(['merge-base', 'origin/main', pr.headRefOid], { allowFail: true });
  if (!base) return false;
  const diff = git(['diff', '--unified=0', base, pr.headRefOid, '--', SHARED_REGISTRY_PATH], { allowFail: true });
  if (diff === null) return false;
  const added = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  // No additions at all: nothing of this PR's is waiting in the registry, so it cannot be the reason to
  // hold the PR open. Fall back to byte-identity for it like any other file.
  if (added.length === 0) {
    const mine = git(['rev-parse', `${pr.headRefOid}:${SHARED_REGISTRY_PATH}`], { allowFail: true });
    const main = git(['rev-parse', `origin/main:${SHARED_REGISTRY_PATH}`], { allowFail: true });
    return Boolean(mine) && Boolean(main) && mine === main;
  }
  const mainSource = git(['show', `origin/main:${SHARED_REGISTRY_PATH}`], { allowFail: true });
  if (mainSource === null) return false;
  return registryAddedLinesLanded(added, mainSource).landed;
}

/** Any other open PR sharing at least one path. Sharing one file means they cannot be grouped. */
function collidesWith(pr, others) {
  return others
    .filter((o) => o.number !== pr.number && o.paths.some((p) => pr.paths.includes(p)))
    .map((o) => o.number);
}

// TWO PASSES, and the order is the point. A superseded PR is one that should be CLOSED, so it must not
// disqualify the PR that supersedes it: in the first run of this script #4814 was reported SEPARATE for
// "shares a file with #4805" when #4805 was, on the line above, already marked as redundant to #4814
// itself. A collision only matters against a PR that is actually going to be merged.
// The content check needs the PR heads and `origin/main` present locally. Best effort: a fetch that
// fails leaves alreadyCarried() answering false, which is the SAFE direction — it proposes a roll-up
// that is merely redundant, rather than hiding a PR that still needs to ship.
if (!fixturePath) {
  git(['fetch', '--quiet', 'origin', 'main'], { allowFail: true });
  for (const pr of open) git(['fetch', '--quiet', 'origin', pr.headRefName], { allowFail: true });
}

for (const pr of open) {
  const sub = subsumedBy(pr, open);
  if (pr.isDraft) pr.verdict = { kind: 'skip', why: 'draft' };
  else if (alreadyCarried(pr)) pr.verdict = { kind: 'carried', why: 'every file it touches is already on main, by bytes or by its own delta — close it, do not merge it' };
  else if (sub) pr.verdict = { kind: 'superseded', why: `every file it touches is in #${sub.number}, which changes more`, by: sub.number };
  // 🔴 FIRST PASS, exactly where `isDraft` sits, and for the same reason: a PR that cannot merge today
  // must not reach the second pass at all. It is not enough to drop it from `rollable`, because `group`
  // unions `rollable` with `ownMerge` unconditionally — a red WIDE PR would ride along and redden the
  // roll-up just the same. Keeping it out of `contenders` also keeps it out of `collidesWith`, which is
  // the settled rule here: a collision only matters against a PR that is actually going to be merged.
  // It sits AFTER `carried`/`superseded` so a PR that only needs closing is still reported as such.
  else if (pr.redRequired) {
    pr.verdict = {
      kind: 'red',
      why: `required check(s) failing: ${pr.redChecks.join(', ')} — a roll-up carrying this could never `
        + 'go green, so the owner\'s one approval would be stuck behind somebody else\'s fix',
    };
  }
}
const contenders = open.filter((p) => !p.verdict);
for (const pr of contenders) {
  pr.collides = collidesWith(pr, contenders);
  if (pr.blockers.length) pr.verdict = { kind: 'separate', why: pr.blockers.join('; ') };
  else if (pr.collides.length) pr.verdict = { kind: 'separate', why: `shares a file with ${pr.collides.map((n) => `#${n}`).join(', ')}` };
  else if (pr.changedFiles > maxFiles) pr.verdict = { kind: 'own-merge', why: `${pr.changedFiles} files — wide enough to carry its own merge` };
  else pr.verdict = { kind: 'rollable', why: `${pr.changedFiles} file(s), no overlap with any other open PR` };
}

const rollable = open.filter((p) => p.verdict.kind === 'rollable');
const ownMerge = open.filter((p) => p.verdict.kind === 'own-merge');

// The saving comes from the NUMBER OF MERGES, so any two disjoint PRs riding together save one run
// pair — a wide one costs nothing extra to carry. But the problem being solved is the small PR that has
// nowhere to go, so a roll-up must contain at least one of those; otherwise this would propose welding
// two unrelated finished features together for no reason other than arithmetic.
const group = rollable.length >= 1 && rollable.length + ownMerge.length >= 2 ? [...rollable, ...ownMerge] : [];
const saving = group.length >= 2 ? (group.length - 1) * BILLABLE_MINUTES_PER_MERGE : 0;

// ---------------------------------------------------------------------------- report

if (asJson) {
  console.log(JSON.stringify({
    maxFiles,
    requiredChecks: requiredContexts ? [...requiredContexts] : null,
    protectionNote: protectionNote || null,
    open,
    group: group.map((p) => p.number),
    saving,
  }, null, 2));
} else {
  console.log(`[rollup] ${open.length} open PR(s); "small" is <= ${maxFiles} changed files`);
  // Say WHICH checks the red verdicts were judged against, so a reader never has to assume the list.
  console.log(requiredContexts
    ? `[rollup] branch protection requires ${requiredContexts.size}: ${[...requiredContexts].join(', ')} — a red check outside that list does not disqualify anything`
    : `[rollup] could not read the required list (${protectionNote})`);
  console.log('');
  const label = { rollable: 'ROLL UP  ', carried: 'CARRIED  ', 'own-merge': 'own merge', separate: 'SEPARATE ', superseded: 'SUPERSEDED', skip: 'skip     ', red: 'RED CHECK' };
  for (const pr of open.sort((a, b) => a.number - b.number)) {
    console.log(`  ${label[pr.verdict.kind]}  #${pr.number}  ${String(pr.changedFiles).padStart(2)} files  ${pr.mergeStateStatus.padEnd(8)}  ${pr.title.slice(0, 54)}`);
    console.log(`               ${pr.verdict.why}`);
    // Pending is not a verdict — it does not change whether the PR belongs in the group — so it is
    // reported on its own line, or a reader cannot tell a member that is PROVEN green from one that
    // merely has nothing red yet. That is the distinction #4896 was built without.
    if (pr.pendingChecks.length > 0 && !pr.redRequired) {
      console.log(`               required checks not finished yet: ${pr.pendingChecks.join(', ')}`);
    }
  }
  console.log('');
  if (group.length >= 2) {
    console.log(`[rollup] ONE branch can carry ${group.map((p) => `#${p.number}`).join(' + ')}`);
    console.log(`[rollup] that is ${group.length} merges -> 1, about ${saving} billable minutes saved`);
    const unproven = group.filter((p) => !p.checksSettled);
    if (unproven.length > 0) {
      console.log(`[rollup] ${unproven.map((p) => `#${p.number}`).join(', ')} still have required checks running — `
        + `--apply waits up to ${waitMinutes} min for them and builds only from the ones that finish green`);
    }
    console.log(apply ? '[rollup] --apply given: building it' : '[rollup] re-run with --apply to build the branch and open the PR');
  } else {
    console.log('[rollup] nothing to roll up — fewer than two disjoint small PRs. Merge them as they are.');
  }
  const redPrs = open.filter((p) => p.verdict.kind === 'red');
  if (redPrs.length > 0) {
    console.log(`[rollup] held out of the group: ${redPrs.map((p) => `#${p.number}`).join(', ')} — required checks failing. `
      + 'Fix them and re-run; nothing here is closed or merged.');
  }
}

if (apply && fixturePath) {
  console.error('[rollup] --apply is refused with PHX_ROLLUP_FIXTURE: a snapshot is not the live repository.');
  process.exit(1);
}

// ---------------------------------------------------------------------------- settle

// WHAT `carried` IS FOR. A roll-up merges and its members are left OPEN — GitHub closes only the one
// whose head the roll-up branch happened to carry verbatim. The rest read as live work whose content is
// already on `main`, and merging one of those pays a full CI run on the PR and another on `main` to ship
// nothing. It happened on 2026-09-30: roll-up #4871 merged, #4861 and #4870 stayed open, and both had to
// be closed by hand after diffing each against `main` scoped to its own files.
//
// The verdict already existed and already said "close it, do not merge it" — nothing ever acted on it,
// and `--close-superseded` reaches only BOT PRs subsumed by a wider one. This closes a `carried` PR, and
// only a `carried` one, because `alreadyCarried()` is a blob comparison over EVERY file it touches: not
// ancestry, which answers "no" for a squash-merged branch, and not a majority.
//
// It runs before the roll-up logic and needs no `--apply`, because the moment a roll-up merges there is
// usually nothing left to roll up — the members are exactly what is left.
const SETTLE_COMMENT = [
  'Superseded: every file this PR touches is already on `main` — byte-identical, or its own delta already applied there — so there is nothing left',
  'here to merge — its content landed inside a roll-up. A squash merge is why GitHub did not close this',
  'automatically: the commits never become ancestors of `main`.',
  '',
  'Closing so it cannot be merged a second time — that pays a full CI run on the PR and another on',
  '`main` to change nothing (AGENTS.md §6). Nothing is lost: reopen it if any file here is ever shown to',
  'differ from `main`.',
].join('\n');

const carriedPrs = open.filter((p) => p.verdict.kind === 'carried');
if (settle && fixturePath) {
  console.error('[rollup] --settle is refused with PHX_ROLLUP_FIXTURE: a snapshot cannot authorise closing a live PR.');
  process.exit(1);
}
if (settle) {
  if (carriedPrs.length === 0) {
    console.log('[rollup] --settle: nothing is carried; no PR to close.');
  } else {
    for (const pr of carriedPrs) {
      gh(['pr', 'close', String(pr.number), '--repo', REPO, '--comment', SETTLE_COMMENT], { allowFail: true });
      console.log(`[rollup] closed #${pr.number} — every file it touches is already on main`);
    }
  }
} else if (carriedPrs.length > 0 && !asJson) {
  console.log(`[rollup] ${carriedPrs.length} PR(s) are already on main and only need closing: re-run with `
    + `--settle to close ${carriedPrs.map((p) => `#${p.number}`).join(', ')}.`);
}

// ------------------------------------- --verify-heads: is a carried commit already superseded?
//
// 🔴 `--apply` RE-READS EVERY MEMBER'S HEAD AND THEN STOPS LOOKING, AND THE APPROVAL ARRIVES
// MINUTES LATER. The build loop below takes a last look at each sha and SKIPS a member that moved,
// so the branch is always made of commits whose checks and file sets were measured. Nothing looks
// again after the push — and that gap is where #5191 went wrong on 2026-10-02: built 20:54:51Z from
// #5188's head `4df18d572`, its author pushed the real fix at 20:58:41Z, merged 21:12:41Z carrying
// the commit already superseded. The member was then left CONFLICTING against the squash of its own
// first commit, which earns NO CI run at all, so it could not recover without a hand-built merge.
//
// This is the read that closes it, and `bash-guard` clause C13 runs the same comparison before any
// roll-up is merged. Read-only: it closes nothing, builds nothing and merges nothing — and it does
// not name the merge command either, because `tests/rollup-prs.test.ts` refuses that literal
// anywhere in this file, comments included, so the one word the owner gives cannot migrate in here.
if (verifyHeads) {
  if (fixturePath) {
    console.error('[rollup] --verify-heads is refused with PHX_ROLLUP_FIXTURE: it compares a snapshot\'s '
      + 'bodies against LIVE heads, so every answer would be about two different repositories.');
    process.exit(1);
  }
  const rollups = open.filter((pr) => isRollupBranch(pr.headRefName));
  if (rollups.length === 0) {
    console.log('[rollup] --verify-heads: no open roll-up to check.');
    process.exit(0);
  }
  let anyMoved = false;
  for (const pr of rollups) {
    const raw = gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'body'], { allowFail: true });
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw).body ?? ''; } catch { body = null; }
    }
    if (body === null) {
      console.log(`[rollup] #${pr.number} (${pr.headRefName}): body unreadable — UNKNOWN, check it by hand.`);
      continue;
    }
    const recorded = rollupMemberHeads(body);
    if (recorded.length === 0) {
      console.log(`[rollup] #${pr.number} (${pr.headRefName}): lists no members this can parse — UNKNOWN.`);
      continue;
    }
    const live = recorded.map((m) => {
      const row = gh(['pr', 'view', String(m.number), '--repo', REPO, '--json', 'number,headRefOid'], { allowFail: true });
      if (!row) return { number: m.number, headRefOid: null };
      try { return { number: m.number, headRefOid: JSON.parse(row).headRefOid ?? null }; } catch { return { number: m.number, headRefOid: null }; }
    });
    const { moved, unrecorded, unread } = staleRollupMembers({ recorded, live });
    if (moved.length === 0) {
      console.log(`[rollup] #${pr.number}: ${recorded.length - unrecorded.length - unread.length} member head(s) `
        + 'unchanged since it was built — merging it ships what was measured.');
    } else {
      anyMoved = true;
      console.log(`[rollup] #${pr.number} IS STALE — ${moved.length} member(s) moved since it was built:`);
      for (const m of moved) {
        console.log(`             #${m.number}: carried ${m.carried.slice(0, 9)}, now ${m.now.slice(0, 9)} `
          + '— merging would ship the SUPERSEDED commit and leave that PR conflicting');
      }
      console.log(`[rollup] Rebuild rather than merge: gh pr close ${pr.number} && node scripts/rollup-prs.mjs --apply`);
    }
    for (const n of unrecorded) {
      console.log(`[rollup] #${pr.number}: member #${n} records no carried sha (built before this shipped) — UNKNOWN, not stale.`);
    }
    for (const n of unread) {
      console.log(`[rollup] #${pr.number}: member #${n} could not be read — UNKNOWN, not stale.`);
    }
  }
  process.exit(anyMoved ? 3 : 0);
}

if (!apply || group.length < 2) process.exit(0);

// 🔴 A GATE THAT NAMES NOTHING CANNOT CLEAR ANYTHING, so the run stops here rather than discovering it
// one member at a time. The member-level clause in `requiredCheckState` already refuses to call anything
// green without a CONFIRMED required check, so nothing unsafe could be built either way — this exists so
// the reason is stated once, at the top, instead of appearing as N identical "not confirmed" lines.
{
  const gate = requiredGateUsable(requiredContexts);
  if (!gate.usable) {
    console.error(`[rollup] refusing to build: ${gate.why}.`);
    console.error('[rollup] Nothing is closed, merged or pushed. Fix the gate reading first — every member '
      + 'would otherwise be judged against a list that names nothing.');
    process.exit(1);
  }
}

// --------------------------------------- refuse when an open roll-up already carries this work

// scripts/rollup-duplicate-guard.mjs records the three collisions on 2026-09-30 that make this a
// GATE and not a warning. It sits before the members-wait below on purpose: a duplicate is refused
// in seconds, rather than after minutes spent waiting for checks on members another roll-up owns.
const openRollupPrs = open.filter((pr) => isRollupBranch(pr.headRefName));
if (openRollupPrs.length > 0) {
  const rollups = openRollupPrs.map((pr) => {
    const raw = gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'body'], { allowFail: true });
    // An unknown must never read as "carries nothing". Same rule as the branch-name check, for the
    // same reason: that is the single direction in which a second roll-up gets built over live work.
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw).body ?? ''; } catch { body = null; }
    }
    return { number: pr.number, headRefName: pr.headRefName, members: body === null ? [] : rollupMembers(body) };
  });
  const clash = overlappingRollup({ wanted: group.map((p) => p.number), rollups });
  if (clash) {
    console.error(`[rollup] REFUSED — #${clash.number} (${clash.headRefName}) is already open and `
      + (clash.unreadable
        ? 'its members could not be read, so it may already carry this work.'
        : `carries ${clash.shared.map((n) => '#' + n).join(', ')}.`));
    console.error('[rollup] Two roll-ups over the same pull requests turn one merge back into several '
      + 'and add their own. The open one has already paid for its CI run, so this build would '
      + 'duplicate it rather than replace it.');
    console.error(`[rollup] Let #${clash.number} merge, or close it, then run --apply again.`);
    process.exit(1);
  }
}

// -------------------------------------------------- wait for the members' required checks to finish

// WHY THIS WAIT EXISTS, AND WHY IT IS HERE RATHER THAN IN THE CLASSIFICATION.
//
// The classification answers "does this PR belong in a roll-up", and a PR whose checks are still
// running does — it is the normal case, since a roll-up is usually built minutes after a PR is opened,
// and refusing every fresh PR would leave the small ones with nowhere to go again. The BUILD answers a
// different question: "am I willing to bet one approval on this PR's checks". Those two answers diverge
// for exactly as long as the checks take, which is why the wait lives at the seam between them.
//
// Measured 2026-09-30: `--apply` built #4896 from #4895 (green) and #4894 (queued). #4894 went red
// minutes later — four TypeScript errors and two of its own tests — and the roll-up inherited a red it
// could never clear on its own. Because a roll-up's members must not be merged separately (AGENTS.md
// §6), the GREEN PR was stuck behind another session's fix; #4896 was closed and #4895 merged alone.
// One CI run spent, nothing shipped.
//
// It sits BEFORE the branch is created on purpose. Waiting after that would leave the session parked on
// a half-built local branch for the duration — which is the other half of the 2026-09-30 mess, because
// `new-session.mjs --remove` judges a worktree by whatever branch it finds checked out.
//
// 🔴 AND THE SHA IS PART OF THE EVIDENCE. The checks are re-read live, but the commit the build merges
// was captured before the wait — so a member pushed meanwhile returns GREEN CHECKS FOR A COMMIT THE
// BUILD WOULD NOT MERGE, and the roll-up carries something nothing verified. That is the original bug
// wearing a later timestamp. Measured the same day: #4907's head moved TWICE inside fifteen minutes
// while its checks ran. So every poll carries the sha it expects, and a member whose head moved — or
// which is no longer open — goes STALE and is never built from.
const memberState = new Map(group.map((p) => [
  p.number,
  { number: p.number, red: p.redChecks, pending: p.pendingChecks, stale: null, sha: p.headRefOid, headCommittedAt: p.headCommittedAt ?? null },
]));

/** Members with nothing red, nothing stale, and something still running — what a wait can resolve. */
function stillRunning() {
  return [...memberState.values()].filter((m) => m.red.length === 0 && m.stale === null && m.pending.length > 0);
}

/** A synchronous sleep, because everything else in this script is synchronous and reads in order. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One member's state, read again: its required checks, plus whether it is still the PR we measured.
 *
 * `null` means the read failed — which is NOT news: the previous reading is kept, so a flaky call can
 * never promote a pending member to green. `{ stale }` means the answer would be about something else:
 * the head moved (the checks now describe a commit the build would not merge, and the file set was
 * measured on the old one) or the PR is no longer open.
 */
function rereadCheckState(number) {
  const expected = memberState.get(number)?.sha;
  const raw = gh(['pr', 'view', String(number), '--repo', REPO, '--json', 'state,headRefOid,statusCheckRollup'], { allowFail: true });
  if (!raw) return null;
  try {
    const fresh = JSON.parse(raw);
    if (fresh.state !== 'OPEN') return { stale: `#${number} is ${String(fresh.state).toLowerCase()}, not open any more` };
    if (expected && fresh.headRefOid && fresh.headRefOid !== expected) {
      return { stale: `#${number} was pushed while we waited (${String(expected).slice(0, 9)} -> ${String(fresh.headRefOid).slice(0, 9)})` };
    }
    return requiredCheckState(fresh.statusCheckRollup, requiredContexts, memberState.get(number)?.headCommittedAt ?? null);
  } catch {
    return null;
  }
}

if (stillRunning().length === 0) {
  console.log('[rollup] every member\'s required checks have already finished green — building now.');
} else if (noWait) {
  console.log(`[rollup] --no-wait: ${stillRunning().map((m) => `#${m.number}`).join(', ')} have checks still running `
    + 'and will be left out rather than waited for.');
} else {
  console.log(`[rollup] waiting up to ${waitMinutes} min for ${stillRunning().map((m) => `#${m.number}`).join(', ')} — `
    + 'a roll-up built over an unfinished member inherits whatever its checks turn out to say.');
  const settled = waitForRequiredChecks({
    members: [...memberState.values()],
    timeoutMs: waitMinutes * 60_000,
    pollMs: WAIT_POLL_SECONDS * 1000,
    reread: rereadCheckState,
    sleep: sleepMs,
    onPoll: ({ left, msLeft }) => {
      console.log(left.length > 0
        ? `[rollup] still running: ${left.map((m) => `#${m.number} (${m.pending.join(', ')})`).join('; ')} `
          + `— ${Math.max(0, Math.round(msLeft / 60_000))} min left of the wait`
        : '[rollup] all members\' required checks have finished.');
    },
  });
  for (const member of settled) memberState.set(member.number, member);
}

const readiness = membersReadyToBuild([...memberState.values()]);
for (const dropped of readiness.dropped) console.log(`[rollup] #${dropped.number} left out — ${dropped.why}`);

if (readiness.carry.length < MIN_MEMBERS) {
  console.log(`[rollup] only ${readiness.carry.length} member(s) finished green, so there is no roll-up worth `
    + `${MIN_MEMBERS} merges. Nothing was built, nothing was pushed, nothing was closed — re-run when the `
    + 'checks have settled.');
  process.exit(0);
}

// 🔴 SAY THE READING THE BUILD IS ACTING ON, for every member, every time. Asked for by the peer session
// that investigated #4937: when this goes wrong the branch is usually deleted by the time anyone looks,
// so the run's own output has to be the evidence. It is two lines and it turns forensics into reading.
for (const member of memberState.values()) {
  console.log(`[rollup] #${member.number} at build time: settled=${member.red.length === 0 && member.stale === null && member.pending.length === 0}`
    + ` sha=${String(member.sha).slice(0, 9)} red=[${member.red.join(', ')}] pending=[${member.pending.join(', ')}]`
    + `${member.stale ? ` stale=${member.stale}` : ''}`);
}

const buildGroup = group.filter((p) => readiness.carry.includes(p.number));
if (buildGroup.length < group.length) {
  console.log(`[rollup] building from ${buildGroup.map((p) => `#${p.number}`).join(' + ')} — `
    + `${(buildGroup.length - 1) * BILLABLE_MINUTES_PER_MERGE} billable minutes saved instead of ${saving}`);
}

// ---------------------------------------------------------------------------- build it

// The name must be unique across HISTORY, not just among live branches — see rollup-branch-name.mjs
// for why a reused name turns `--head <branch> --state merged` into a lookup that returns the wrong PR.
// Anything we cannot determine counts as TAKEN: an unknown must never read as free here.
const root = git(['rev-parse', '--show-toplevel']);
const branch = rollupBranchName({
  now: new Date(),
  isTaken: (name) => {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: root, allowFail: true }) !== null) return true;
    const remote = git(['ls-remote', '--heads', 'origin', name], { cwd: root, allowFail: true });
    if (remote === null || remote.length > 0) return true;
    // ANY state, not just merged: a closed roll-up PR makes the same lookup ambiguous.
    // gh() with allowFail returns '' on FAILURE, never null, while a successful --json call always
    // returns at least '[]'. So an empty string is a failed call and counts as TAKEN — reading it as
    // '[]' would turn "GitHub was unreachable" into "the name is free", which is the one direction
    // that matters here.
    const prs = gh(['pr', 'list', '--repo', REPO, '--head', name, '--state', 'all', '--json', 'number'], { allowFail: true });
    if (!prs) return true;
    try {
      return JSON.parse(prs).length > 0;
    } catch {
      return true;
    }
  },
});

// Where we were, so the tree goes back — whether the build is ABANDONED or PUSHED. Leaving a session
// switched onto the roll-up branch is half of the 2026-09-30 failure: `new-session.mjs --remove` then
// judges the worktree by whatever branch it finds checked out, not the one the session was working
// on. Only `abandon()` restored it at first, so the runs that WORKED were the ones that stranded a
// folder; the success path now restores it too, right after the push.
const startedOn = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFail: true });

git(['fetch', '--quiet', 'origin', 'main'], { cwd: root });
git(['switch', '--quiet', '--create', branch, 'origin/main'], { cwd: root });

/** Stop without pushing, back where we started, taking the half-built branch with us. */
function abandon(lines) {
  git(['merge', '--abort'], { cwd: root, allowFail: true });
  if (startedOn && startedOn !== 'HEAD') git(['switch', '--quiet', startedOn], { cwd: root, allowFail: true });
  git(['branch', '-D', branch], { cwd: root, allowFail: true });
  for (const line of lines) console.error(`[rollup] ${line}`);
  console.error(`[rollup] nothing pushed. Back on ${startedOn ?? 'the previous branch'}, and ${branch} removed.`);
  process.exit(1);
}

const carried = [];
const skipped = [];
// `buildGroup`, never `group`: the wait above is what tells the two apart, and a member whose checks
// never finished green must not reach a `git merge` here.
for (const pr of buildGroup) {
  // THE LAST LOOK AT THE SHA, and it is not the same question the wait asked. The wait can only see a
  // push that happens while it is waiting; `--no-wait`, or a push in the seconds between the wait
  // ending and this merge, arrives after it has stopped looking. It is the roll-up's equivalent of the
  // `--match-head-commit` guard a merge gets: carry the commit whose checks and file set were
  // measured, or carry nothing. A moved head is SKIPPED rather than followed — the new commit's checks are unread
  // and its files unmeasured, so following it would carry exactly what all of this exists to refuse.
  const live = gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'headRefOid'], { allowFail: true });
  if (live) {
    let liveSha = null;
    try {
      liveSha = JSON.parse(live).headRefOid ?? null;
    } catch {
      liveSha = null; // An unreadable answer is not evidence of a move; the object check below decides.
    }
    if (liveSha && liveSha !== pr.headRefOid) {
      skipped.push(pr.number);
      console.log(`[rollup] #${pr.number} skipped — it was pushed since it was measured `
        + `(${pr.headRefOid.slice(0, 9)} -> ${liveSha.slice(0, 9)}); its new commit has not been checked here.`);
      continue;
    }
  }
  // A member can MERGE while this runs, and `delete_branch_on_merge` then deletes its branch, so this
  // fetch fails for a branch that existed seconds ago. That is not the question: the commit is usually
  // still here from the classification pass, and if we HAVE the object the merge is as correct as it
  // ever was. So the fetch is allowed to fail and the OBJECT is what decides.
  git(['fetch', '--quiet', 'origin', pr.headRefName], { cwd: root, allowFail: true });
  if (git(['cat-file', '-e', `${pr.headRefOid}^{commit}`], { cwd: root, allowFail: true }) === null) {
    skipped.push(pr.number);
    console.log(`[rollup] #${pr.number} skipped — its branch and its commit are both gone, which is what merging mid-build looks like.`);
    continue;
  }
  const merged = git(['merge', '--no-edit', '-m', `rollup: #${pr.number} — ${pr.title}`, pr.headRefOid], { cwd: root, allowFail: true });
  if (merged === null) {
    // Disjoint file sets should make this impossible; if it happens, the measurement was wrong and
    // the safe move is to stop with the tree clean rather than resolve a conflict nobody asked for.
    abandon([
      `#${pr.number} would not merge cleanly despite disjoint files.`,
      'Merge that one on its own and re-run.',
    ]);
  }
  carried.push(pr);
}

const verdict = rollupBuildVerdict({ carried: carried.length, skipped });
if (verdict.kind === 'abandon') abandon([verdict.why]);

git(['push', '--quiet', '--set-upstream', 'origin', branch], { cwd: root });

// 🔴 BACK WHERE WE STARTED, ON THE SUCCESS PATH TOO. `abandon()` restored `startedOn` and the happy
// path did not, so every run that WORKED left its folder parked on the roll-up branch — the same
// "half of the 2026-09-30 failure" the note above `startedOn` describes, only reached by succeeding
// instead of by failing. It stranded the SHARED PRIMARY CHECKOUT on `codex/rollup-20260930-1000`
// that day: clean, silent, and read by every session that used the primary afterwards, where a bare
// `git` command resolves against whatever is checked out. Three more local `codex/rollup-*` branches
// were left behind the same way.
//
// It belongs HERE, immediately after the push, rather than at the end of the file: from this line on
// nothing needs the branch checked out — `gh pr create` names it with `--head`, and `gh pr close`
// names its PRs by number — while `gh()` exits the process on a GitHub failure, which would jump
// straight past any restore written below it.
//
// Nothing is deleted, unlike `abandon()`: the branch is pushed and carries an open PR, so the local
// copy is an ordinary branch to leave alone. A restore that cannot happen (the original branch was
// deleted while we built) must not fail a roll-up that is already pushed and open — it says so
// instead, because the whole defect was a folder moving with nothing announcing it.
if (startedOn && startedOn !== 'HEAD') {
  const restored = git(['switch', '--quiet', startedOn], { cwd: root, allowFail: true });
  if (restored === null) {
    console.warn(`[rollup] could not switch ${root} back to ${startedOn} — it is left on ${branch}. `
      + `Switch it yourself before running anything else there.`);
  }
}

const body = [
  'Rolls up several open pull requests into ONE merge, so the CI bill is paid once instead of '
    // Recomputed from what SURVIVED, not from the group we set out with: a member that merged
    // mid-build is no longer a merge this replaces, and quoting the original figure would
    // overstate the saving in the one place the owner reads it.
    + `${carried.length} times (about ${(carried.length - 1) * BILLABLE_MINUTES_PER_MERGE} billable minutes).`,
  '',
  'Each is carried by merging its own head commit, so authorship and history are preserved:',
  '',
  // The carried SHA is part of the record, not decoration: `--verify-heads` and `bash-guard`'s C13
  // compare it against the live head before the merge, which is the only thing standing between an
  // approval minutes old and a commit its author has since replaced (#5191/#5188, 2026-10-02).
  ...carried.map((p) => `- #${p.number} — ${p.title} (${p.changedFiles} files) @ ${p.headRefOid}`),
  '',
  'Their file sets are disjoint, which is the condition this was built on — two PRs touching one file '
    + 'can merge cleanly and still be wrong together, `tests/run-tests.ts` being the standing example.',
  '',
  'Nothing carrying a migration, a protected file or a frozen path is in here; those keep their own '
    + 'visible approval.',
  '',
  `Built by \`node scripts/rollup-prs.mjs --apply\`. Once this merges the originals are CARRIED, not live: \`node scripts/rollup-prs.mjs --settle\` closes them, after proving every file it touches is already on \`main\`.`,
].join('\n');

gh(['pr', 'create', '--repo', REPO, '--base', 'main', '--head', branch,
    '--title', `chore: roll up ${carried.length} open PRs into one merge`, '--body', body]);

console.log(`[rollup] pushed ${branch} and opened the roll-up PR.`);
console.log('[rollup] It still needs the owner\'s approval to merge — that is the one approval replacing '
  + `${carried.length}.`);

if (closeSuperseded) {
  for (const pr of open.filter((p) => p.verdict.kind === 'superseded' && p.isBot)) {
    gh(['pr', 'close', String(pr.number), '--repo', REPO, '--comment',
        `Superseded by #${pr.verdict.by}, which makes the same change across more files.`], { allowFail: true });
    console.log(`[rollup] closed #${pr.number} (bot, superseded by #${pr.verdict.by})`);
  }
}
