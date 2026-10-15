#!/usr/bin/env node
// Reclaims the local repo after months of parallel-session work: stale branches,
// abandoned worktree folders, and git's own garbage.
//
// WHY THIS EXISTS. Audit 2026-07-31 found 117 local branches against 14 remotes,
// 67 `_wt-*` folders against 24 registered worktrees, and 172 MB of git-declared
// garbage (4 pack files with no .idx, left by an interrupted/concurrent git
// process). AGENTS.md caps live worktrees at 2-3; the delete-on-merge ritual it
// describes had not been keeping up, largely because this repo SQUASH-merges:
// a squash-merged branch is NOT an ancestor of main, so `git branch --merged`
// reports it as unmerged and the obvious cleanup command refuses to touch it.
// 106 of the 113 "unmerged" branches here are simply squash-merged.
//
// DRY RUN BY DEFAULT. Nothing is deleted without --apply. Run it, read the plan,
// then re-run with --apply.
//
//   node scripts/repo-cleanup.mjs              # show the plan, change nothing
//   node scripts/repo-cleanup.mjs --apply      # actually do it
//   node scripts/repo-cleanup.mjs --apply --no-gc
//
// SAFETY RULES, all enforced below rather than left to the operator:
//   1. A branch is deleted ONLY if it is an ancestor of origin/main (a real merge)
//      or GitHub confirms a MERGED pull request came from it (the squash case).
//      "Upstream is gone" alone is NOT sufficient — a branch whose remote was
//      deleted without merging looks identical, and deleting it destroys work.
//   2. Branches never pushed anywhere, or holding unpushed commits, are always
//      KEPT and reported loudly. Those exist only on this disk.
//   3. Any branch checked out in ANY worktree is protected, as is main.
//   4. Worktree folders are only removed if git does not know them AND they are
//      empty of real files. A registered worktree is never touched here — use
//      `git worktree remove` after the owner confirms.
//   5. Before removing any folder it is scanned for .xlsx/.pdf. Anything found
//      that is not byte-identical to a git-tracked copy is MOVED to xlsx/ at the
//      repo root, never deleted (AGENTS.md, hard rule).
//   6. A dirty worktree blocks PER STEP, not the whole run. Branch deletion cannot
//      race anything (rule 3 already protects every checked-out branch), so it always
//      proceeds; folder removal, prune and gc are skipped while somebody else has
//      in-flight work. A partial run says so loudly at the end rather than reading
//      like a clean one.

'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "repo-cleanup",
  entry: import.meta.url,
  known: ["--apply", "--no-gc"],
  hints: [
    "it is a dry run by default — --apply deletes; --no-gc skips the garbage collection",
  ],
});

const APPLY = process.argv.includes('--apply');
const NO_GC = process.argv.includes('--no-gc');
const TAG = '[repo-cleanup]';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}
function gitQuiet(args) {
  try {
    return { ok: true, out: git(args, { stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (err) {
    return { ok: false, out: String(err?.stdout ?? '') };
  }
}
const log = (m) => console.log(`${TAG} ${m}`);
const warn = (m) => console.warn(`${TAG} WARN  ${m}`);

const REPO_ROOT = git(['rev-parse', '--show-toplevel']);

// ---------------------------------------------------------------------------
// 0. Preconditions
// ---------------------------------------------------------------------------
const worktrees = git(['worktree', 'list', '--porcelain'])
  .split('\n\n')
  .map((block) => {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    const locked = /^locked/m.test(block);
    return dir ? { dir, branch, locked } : null;
  })
  .filter(Boolean);

let dirty = 0;
for (const wt of worktrees) {
  const st = gitQuiet(['-C', wt.dir, 'status', '--porcelain']);
  if (st.ok && st.out.trim()) {
    warn(`worktree has uncommitted changes: ${wt.dir}`);
    dirty++;
  }
}
// PER-STEP, not whole-run. This used to `process.exit(1)` on any dirty worktree —
// right in spirit, too coarse in practice. In a repo with a dozen live worktrees
// something is almost always dirty, so the whole script became unrunnable and the
// branch list grew unbounded (2026-08-01: 41 local branches, and the only way to
// make progress was to bypass the script by hand). A guard that forces people
// around it is worse than a narrower one that holds.
//
// What each step actually races:
//   - Branch deletion: NOTHING. Every branch checked out in any worktree is already
//     in `protectedBranches`, and deleting some other, provably-merged branch does
//     not touch a working tree. Uncommitted work elsewhere is irrelevant to it.
//   - Folder removal + data rescue: REAL RACE. An unregistered `_wt-*` directory can
//     be an in-flight `git worktree add` target, and a session actively creating
//     worktrees is precisely when that is likely.
//   - `worktree prune` + `gc --prune=now`: REAL RACE, and gc is the one step with no
//     undo — it destroys the reflog recovery path for whatever was just deleted.
//
// So a dirty tree blocks the second and third groups only.
const worktreesDirty = dirty > 0;
// Two different reasons a step does not run, and they must not be reported alike:
// `skipped` = BLOCKED (re-running once things are clean will finish it), `byRequest` =
// the operator asked for it, so telling them to commit their worktrees would be advice
// that cannot help.
const skipped = [];
const byRequest = [];
if (worktreesDirty && APPLY) {
  warn(
    `${dirty} worktree(s) hold uncommitted work. Folder removal, prune and gc will be SKIPPED — ` +
      `they can race a live session. Branch deletion is unaffected and proceeds.`,
  );
}

if (APPLY) {
  log('fetching + pruning remote refs');
  git(['fetch', 'origin', '--prune']);
} else {
  log('dry run — skipping fetch; merged-PR data still comes live from GitHub');
}

// ---------------------------------------------------------------------------
// 1. Branch classification
// ---------------------------------------------------------------------------
const protectedBranches = new Set(['main', 'master']);
for (const wt of worktrees) if (wt.branch) protectedBranches.add(wt.branch);

const branches = git([
  'for-each-ref',
  '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)',
  'refs/heads',
])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [name, upstream, track] = line.split('\t');
    return { name, upstream: upstream || null, track: track || '' };
  });

// One gh call for every merged PR beats one call per branch (117 branches ->
// 1 request). Branches whose PR merged are the squash-merge case rule 1 covers.
const mergedPrHeads = new Set();
let ghOk = false;
try {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'merged', '--limit', '1000', '--json', 'headRefName'],
    { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  for (const pr of JSON.parse(raw)) mergedPrHeads.add(pr.headRefName);
  ghOk = true;
  log(`GitHub reports ${mergedPrHeads.size} merged PR head branches`);
} catch {
  warn('`gh` unavailable or not authenticated — squash-merged branches cannot be');
  warn('confirmed, so they will be KEPT. Ancestor-merged branches still qualify.');
}

const deletable = [];
const keep = [];
for (const b of branches) {
  if (protectedBranches.has(b.name)) {
    keep.push({ ...b, why: 'checked out in a worktree, or is main' });
    continue;
  }
  if (!b.upstream) {
    keep.push({ ...b, why: 'NEVER PUSHED — exists only on this disk' });
    continue;
  }
  if (b.track.includes('ahead')) {
    keep.push({ ...b, why: `has UNPUSHED commits ${b.track}` });
    continue;
  }
  const isAncestor = gitQuiet(['merge-base', '--is-ancestor', b.name, 'origin/main']).ok;
  if (isAncestor) {
    deletable.push({ ...b, why: 'merged into origin/main (ancestor)' });
    continue;
  }
  if (ghOk && mergedPrHeads.has(b.name)) {
    deletable.push({ ...b, why: 'squash-merged via a merged PR' });
    continue;
  }
  keep.push({ ...b, why: 'NOT provably merged — no merged PR found' });
}

log('');
log(`BRANCHES: ${branches.length} total -> ${deletable.length} deletable, ${keep.length} kept`);
for (const k of keep.filter((k) => k.why.startsWith('NEVER') || k.why.startsWith('has UNPUSHED'))) {
  warn(`  KEEP ${k.name} — ${k.why}`);
}
if (!APPLY) for (const d of deletable.slice(0, 15)) log(`  would delete ${d.name} (${d.why})`);
if (!APPLY && deletable.length > 15) log(`  ... and ${deletable.length - 15} more`);

// ---------------------------------------------------------------------------
// 2. Orphan worktree folders
// ---------------------------------------------------------------------------
const registered = new Set(worktrees.map((w) => path.resolve(w.dir)));
const parent = path.dirname(REPO_ROOT);
const candidateDirs = [];
for (const base of [parent, REPO_ROOT]) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('_wt-')) continue;
    const full = path.resolve(base, e.name);
    if (registered.has(full)) continue;
    candidateDirs.push(full);
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(full, out, depth + 1);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const trackedDataFiles = new Map(); // basename -> sha of the tracked copy
for (const line of git(['ls-files', '-s']).split('\n')) {
  const m = /^\d+ ([0-9a-f]{40}) \d+\t(.+)$/.exec(line);
  if (!m) continue;
  if (!/\.(xlsx|pdf)$/i.test(m[2])) continue;
  trackedDataFiles.set(path.basename(m[2]).toLowerCase(), m[1]);
}

const removable = [];
const rescues = [];
for (const dir of candidateDirs) {
  const files = walk(dir);
  const data = files.filter((f) => /\.(xlsx|pdf)$/i.test(f));
  const dirRescues = [];
  for (const f of data) {
    const sha = gitQuiet(['hash-object', f]).out;
    const tracked = trackedDataFiles.get(path.basename(f).toLowerCase());
    if (!tracked || tracked !== sha) dirRescues.push(f); // rule 5
  }
  rescues.push(...dirRescues);
  // Only an EMPTY orphan is auto-removable. A folder that still holds real files
  // gets reported for a human to look at — it may contain uncommitted edits that
  // no longer have any git metadata to recover them from.
  //
  // `afterRescue` is what the decision is made on, NOT `files`: a folder whose only
  // contents are rescued .xlsx/.pdf is empty by the time deletion runs, and judging
  // it on the pre-rescue count would strand it forever.
  removable.push({ dir, files: files.length, afterRescue: files.length - dirRescues.length });
}

log('');
log(`ORPHAN FOLDERS: ${candidateDirs.length} unregistered _wt-* dir(s)`);
const empties = removable.filter((r) => r.afterRescue === 0);
const nonEmpty = removable.filter((r) => r.afterRescue > 0);
const emptiedByRescue = empties.filter((r) => r.files > 0).length;
log(
  `  ${empties.length} empty and removable` +
    (emptiedByRescue ? ` (${emptiedByRescue} of them only after their data files are rescued)` : ''),
);
for (const r of nonEmpty) {
  warn(`  ${path.basename(r.dir)} still holds ${r.afterRescue} file(s) — REVIEW BEFORE REMOVING`);
}
if (rescues.length) {
  log('');
  warn(`${rescues.length} .xlsx/.pdf file(s) are NOT identical to any tracked copy:`);
  for (const f of rescues.slice(0, 20)) warn(`  ${f}`);
  warn(`These will be MOVED to ${path.join(REPO_ROOT, 'xlsx')}, never deleted.`);
}

// ---------------------------------------------------------------------------
// 3. Execute
// ---------------------------------------------------------------------------
if (!APPLY) {
  log('');
  log('DRY RUN — nothing was changed. Re-run with --apply to execute.');
  process.exit(0);
}

// --- STEP 1: branches. Always safe — see the per-step note above. Runs FIRST so a
// --- dirty tree never costs you the one piece of cleanup that cannot race anything.
let deleted = 0;
for (const d of deletable) {
  const res = gitQuiet(['branch', '-D', d.name]);
  if (res.ok) deleted++;
  else warn(`could not delete ${d.name}`);
}
log(`deleted ${deleted} branch(es)`);
if (deleted > 0 && (worktreesDirty || NO_GC)) {
  log(`  (gc is not running, so every deleted branch stays recoverable from the reflog:`);
  log(`   git branch <name> <sha> — find the sha with: git reflog --no-abbrev)`);
}

// --- STEP 2: data rescue + folder removal + prune. Gated: an unregistered _wt-* dir
// --- can be an in-flight `git worktree add` target.
if (worktreesDirty) {
  skipped.push(
    `folder removal (${empties.length} empty orphan(s)) and worktree prune — ${dirty} worktree(s) dirty`,
  );
  if (rescues.length) skipped.push(`data-file rescue of ${rescues.length} .xlsx/.pdf file(s)`);
} else {
  if (rescues.length) {
    const dest = path.join(REPO_ROOT, 'xlsx');
    fs.mkdirSync(dest, { recursive: true });
    for (const f of rescues) {
      const target = path.join(dest, path.basename(f));
      const final = fs.existsSync(target)
        ? path.join(dest, `${Date.now()}-${path.basename(f)}`)
        : target;
      fs.renameSync(f, final);
      log(`rescued ${path.basename(f)} -> ${final}`);
    }
  }

  // Re-walk rather than reusing the counts taken before the rescue above: a folder
  // whose ONLY contents were .xlsx/.pdf is empty by now, and judging it on its
  // pre-rescue count would leave it behind forever.
  let removedDirs = 0;
  for (const r of removable) {
    const remaining = walk(r.dir);
    if (remaining.length > 0) continue; // still holds real files — a human decides
    try {
      fs.rmSync(r.dir, { recursive: true, force: true });
      removedDirs++;
    } catch (err) {
      warn(`could not remove ${r.dir}: ${err.message}`);
    }
  }
  log(`removed ${removedDirs} empty orphan folder(s)`);

  git(['worktree', 'prune']);
  log('pruned stale worktree administrative entries');
}

// --- STEP 3: gc. Gated on BOTH the flag and a clean tree — it is the only step with
// --- no undo, and it runs right after branch deletion, so it would purge exactly the
// --- objects you might still want back.
if (NO_GC) {
  byRequest.push('git gc (--no-gc given)');
} else if (worktreesDirty) {
  skipped.push(`git gc — ${dirty} worktree(s) dirty`);
} else {
  log('running git gc --prune=now (clears the orphaned packs and garbage objects)');
  git(['gc', '--prune=now'], { stdio: 'inherit' });
}

// A partial run must never read as a full one — that is the same silent-green failure
// this repo keeps getting bitten by. Say plainly what did not happen.
log('');
for (const s of byRequest) log(`not run by request: ${s}`);
if (skipped.length > 0) {
  warn('PARTIAL RUN — the following were BLOCKED and did not run:');
  for (const s of skipped) warn(`  - ${s}`);
  warn('Re-run once every worktree is committed or stashed to finish the rest.');
} else {
  log(`done — every step that was asked for ran.`);
}
