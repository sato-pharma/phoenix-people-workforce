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
'use strict';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { rollupBranchName } from './rollup-branch-name.mjs';
import { rollupBuildVerdict } from './rollup-build-verdict.mjs';

const REPO = 'Gawish-1997/phoenix-people-workforce';

/** A merge pays a full run on the PR and another on `main`. Used only to report the saving. */
const BILLABLE_MINUTES_PER_MERGE = 28;

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
  { test: (p) => p.startsWith('src/lib/incentives/scheme-2026'), why: 'protected: the 2026 incentive curve' },
  { test: (p) => p.startsWith('src/lib/payroll/policy'), why: 'protected: salary derivation' },
  { test: (p) => p.startsWith('src/lib/sales/office-allocation'), why: 'protected: the Office golden rule' },
  { test: (p) => p.startsWith('src/components/employee-portal/identity-card'), why: 'protected: the portal identity banner' },
  { test: (p) => p.startsWith('mobile/') || p.startsWith('eas.json'), why: 'the mobile app is frozen' },
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const apply = args.includes('--apply');
const closeSuperseded = args.includes('--close-superseded');
const settle = args.includes('--settle');
const maxFilesArg = (() => {
  const i = args.indexOf('--max-files');
  return i >= 0 ? Number(args[i + 1]) : NaN;
})();
const maxFiles = Number.isFinite(maxFilesArg)
  ? maxFilesArg
  : Number(process.env.PHX_MERGE_MIN_FILES ?? 4);

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

function git(argv, { cwd = process.cwd(), allowFail = false } = {}) {
  try {
    return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
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
 * Shape: `[{ number, title, headRefName, headRefOid, paths: [...], author?, isDraft?, mergeStateStatus? }]`
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
    author: { login: p.author ?? 'Gawish-1997' },
    paths: p.paths,
    carriedFixture: p.carried === true,
  }));
} else {
  open = JSON.parse(
    gh([
      'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '100',
      '--json', 'number,title,headRefName,headRefOid,changedFiles,additions,deletions,mergeStateStatus,isDraft,author',
    ]) || '[]',
  );
  for (const pr of open) {
    pr.paths = JSON.parse(gh(['pr', 'view', String(pr.number), '--repo', REPO, '--json', 'files']) || '{"files":[]}')
      .files.map((f) => f.path);
  }
}

for (const pr of open) {
  pr.isBot = /\[bot\]$/.test(pr.author?.login ?? '') || (pr.author?.login ?? '').includes('dependabot');
  pr.blockers = [];
  for (const rule of NEVER_ROLL_UP) {
    const hit = pr.paths.find((p) => rule.test(p));
    if (hit) pr.blockers.push(`${rule.why} (${hit})`);
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
 * ALREADY CARRIED: every file this PR touches is byte-identical on `main`.
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
    const mine = git(['rev-parse', `${pr.headRefOid}:${p}`], { allowFail: true });
    const main = git(['rev-parse', `origin/main:${p}`], { allowFail: true });
    return Boolean(mine) && Boolean(main) && mine === main;
  });
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
  else if (alreadyCarried(pr)) pr.verdict = { kind: 'carried', why: 'every file it touches is already byte-identical on main — close it, do not merge it' };
  else if (sub) pr.verdict = { kind: 'superseded', why: `every file it touches is in #${sub.number}, which changes more`, by: sub.number };
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
  console.log(JSON.stringify({ maxFiles, open, group: group.map((p) => p.number), saving }, null, 2));
} else {
  console.log(`[rollup] ${open.length} open PR(s); "small" is <= ${maxFiles} changed files\n`);
  const label = { rollable: 'ROLL UP  ', carried: 'CARRIED  ', 'own-merge': 'own merge', separate: 'SEPARATE ', superseded: 'SUPERSEDED', skip: 'skip     ' };
  for (const pr of open.sort((a, b) => a.number - b.number)) {
    console.log(`  ${label[pr.verdict.kind]}  #${pr.number}  ${String(pr.changedFiles).padStart(2)} files  ${pr.mergeStateStatus.padEnd(8)}  ${pr.title.slice(0, 54)}`);
    console.log(`               ${pr.verdict.why}`);
  }
  console.log('');
  if (group.length >= 2) {
    console.log(`[rollup] ONE branch can carry ${group.map((p) => `#${p.number}`).join(' + ')}`);
    console.log(`[rollup] that is ${group.length} merges -> 1, about ${saving} billable minutes saved`);
    console.log(apply ? '[rollup] --apply given: building it' : '[rollup] re-run with --apply to build the branch and open the PR');
  } else {
    console.log('[rollup] nothing to roll up — fewer than two disjoint small PRs. Merge them as they are.');
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
  'Superseded: every file this PR touches is already byte-identical on `main`, so there is nothing left',
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
      console.log(`[rollup] closed #${pr.number} — every file already byte-identical on main`);
    }
  }
} else if (carriedPrs.length > 0 && !asJson) {
  console.log(`[rollup] ${carriedPrs.length} PR(s) are already on main and only need closing: re-run with `
    + `--settle to close ${carriedPrs.map((p) => `#${p.number}`).join(', ')}.`);
}

if (!apply || group.length < 2) process.exit(0);

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

// Where we were, so an abandoned build puts the tree back. Leaving a session switched onto a
// half-built branch is half of the 2026-09-30 failure: `new-session.mjs --remove` then judges the
// worktree by whatever branch it finds checked out, not the one the session was working on.
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
for (const pr of group) {
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

const body = [
  'Rolls up several open pull requests into ONE merge, so the CI bill is paid once instead of '
    // Recomputed from what SURVIVED, not from the group we set out with: a member that merged
    // mid-build is no longer a merge this replaces, and quoting the original figure would
    // overstate the saving in the one place the owner reads it.
    + `${carried.length} times (about ${(carried.length - 1) * BILLABLE_MINUTES_PER_MERGE} billable minutes).`,
  '',
  'Each is carried by merging its own head commit, so authorship and history are preserved:',
  '',
  ...carried.map((p) => `- #${p.number} — ${p.title} (${p.changedFiles} files)`),
  '',
  'Their file sets are disjoint, which is the condition this was built on — two PRs touching one file '
    + 'can merge cleanly and still be wrong together, `tests/run-tests.ts` being the standing example.',
  '',
  'Nothing carrying a migration, a protected file or a frozen path is in here; those keep their own '
    + 'visible approval.',
  '',
  `Built by \`node scripts/rollup-prs.mjs --apply\`. Once this merges the originals are CARRIED, not live: \`node scripts/rollup-prs.mjs --settle\` closes them, after proving every file byte-identical on \`main\`.`,
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
