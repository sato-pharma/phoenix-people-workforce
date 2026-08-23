// Which commits in a worktree hold work that exists ONLY on this laptop.
//
// WHY THIS IS ITS OWN FILE. `repo-doctor.mjs` runs its whole report at import time, so nothing can
// import a function out of it to test. The property that matters here is a runtime one — what real
// git says about a real squash-merge topology — and the bug being fixed was a wrong git question,
// not wrong string handling. A test that re-implemented the rule and asserted on strings would
// have passed against the broken version too. So the logic lives here, the doctor imports it, and
// `tests/repo-doctor-unpushed-commits.test.ts` drives it against throwaway repos.
//
// THE BUG THIS FIXES. The old check was one command:
//
//     git rev-list HEAD --not --remotes=origin
//
// and its comment called that "squash-merge-safe", reasoning that comparing against origin/main
// would report every squashed branch as unpushed. That is right about origin/main and wrong about
// the conclusion, because it assumed the branch's OWN remote ref survives the merge. This
// repository has `delete_branch_on_merge` ON: GitHub deletes `origin/<branch>` the instant the PR
// merges. From that moment the branch's commits are on no origin ref at all, and the doctor printed
//
//     # ^^ STOP - N commit(s) exist on NO origin ref. That line strands them as
//     #    dangling objects. Push or `git branch rescue/<name> <tip>` them FIRST.
//
// for every SUCCESSFULLY MERGED worktree — precisely the ones being retired. Confirmed 2026-08-24
// against PR #2364: tip `b4331638` and its squash commit `6209cf40` share patch-id `71422830…`,
// byte-identical work, and the doctor still demanded a rescue. The remedy it printed is worse than
// the false alarm: pushing a squash-merged branch is what creates a conflicting PR, and a
// conflicted PR runs no CI at all.
//
// THE FIX, AND WHY IT TAKES TWO COMPARISONS RATHER THAN ONE. Reachability is the wrong question.
// "Is this work backed up?" is a question about CONTENT. Two comparisons answer it, and each one
// alone leaves a hole:
//
//   1. WHOLE BRANCH. A squash merge collapses N commits into one, so the squash commit's patch
//      equals the branch's CUMULATIVE diff from its merge base. Comparing those two patch-ids
//      settles any branch, whether it carried one commit or twenty.
//   2. PER COMMIT (`git cherry`). Catches the rest: a cherry-pick, a rebase, a partly-merged
//      branch — anything where an individual patch landed upstream on its own.
//
// Comparison 1 alone misses a branch only partly merged; comparison 2 alone misses every
// multi-commit squash, because the combined patch never matches any individual one. That second
// gap is not hypothetical — `repo-doctor-no-origin-ref-is-usually-squash-residue` recorded it, and
// measuring it on a three-commit fixture is what caught it here before this shipped: all three
// commits came back `+`, "not upstream", while the work sat safely on main.
//
// WHAT IS DELIBERATELY STILL COUNTED. `git cherry` skips merge commits (no patch-id), so a local
// merge commit stays counted. That is the safe direction: this number gates deletion, so every
// unknown has to read as "not backed up". Same reason the `null` returns below are never collapsed
// into 0 — not knowing must read LOUDER than clean, never quieter.

import { execFileSync } from "node:child_process";

/** 64MB: a branch's cumulative diff and a range's file list both blow past the 1MB default. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Record separator for `git log` blocks. Kept out of the source as a literal control byte. */
const SEP = String.fromCharCode(1);

function git(gitArgs, input) {
  try {
    return execFileSync("git", gitArgs, {
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      timeout: 60000,
      maxBuffer: MAX_BUFFER,
      ...(input === undefined ? {} : { input }),
    }).trim();
  } catch {
    return null;
  }
}

/** The patch-id of a diff. Stable across rebases, squashes and re-authoring. */
function patchId(diff) {
  if (!diff) return null;
  const out = git(["patch-id", "--stable"], diff);
  if (!out) return null;
  return out.split(/\s+/)[0] || null;
}

/** Sorted, newline-joined file list, so two change-sets can be compared as plain strings. */
function fileKey(names) {
  return names
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

/**
 * The commits `upstream` has gained since `mergeBase`, each with the sorted list of files it
 * touched. Read once and reused, because it is the same range for every prefix tested below.
 */
function upstreamCandidates(dir, upstream, mergeBase) {
  const log = git(["-C", dir, "log", "--format=%x01%H", "--name-only", mergeBase + ".." + upstream]);
  if (log === null) return null;
  const candidates = [];
  for (const block of log.split(SEP)) {
    const lines = block.split("\n");
    const sha = (lines.shift() || "").trim();
    if (!sha) continue;
    candidates.push({ sha, key: fileKey(lines.join("\n")), id: undefined });
  }
  return candidates;
}

/**
 * How many of this branch's commits, counted from its merge base, are already carried by a single
 * commit on `upstream` — the shape a squash merge leaves behind.
 *
 * A squash collapses N patches into one, so the squash commit's patch equals the branch's
 * CUMULATIVE diff. Testing the LONGEST prefix first, then shorter ones, matters because of a case
 * this repository actually produces (AGENTS.md section 2.1, worktrees left alive after their PR
 * merged): a branch whose earlier commits shipped and which then took on new work. Only asking
 * "is the whole branch upstream?" answers no there and blames every commit, including the merged
 * ones. Walking the prefixes down finds where the merge ended and blames only what came after.
 *
 * Candidates are narrowed by CHANGED FILE SET before any patch-id is computed. Without that,
 * proving a branch merged would mean diffing every commit upstream has gained since the branch
 * started, which on this repository is hundreds of commits for a week-old worktree.
 */
function upstreamBackedPrefix(dir, upstream) {
  const mergeBase = git(["-C", dir, "merge-base", upstream, "HEAD"]);
  if (mergeBase === null) return [];

  const revs = git(["-C", dir, "rev-list", "--reverse", mergeBase + "..HEAD"]);
  if (revs === null) return [];
  const branchCommits = revs.split("\n").filter(Boolean);
  if (branchCommits.length === 0) return [];

  const candidates = upstreamCandidates(dir, upstream, mergeBase);
  if (candidates === null) return [];
  const keys = new Set(candidates.map((candidate) => candidate.key));

  for (let size = branchCommits.length; size >= 1; size -= 1) {
    const tip = branchCommits[size - 1];
    const files = git(["-C", dir, "diff", "--name-only", mergeBase, tip]);
    if (files === null || files === "") continue;
    const key = fileKey(files);
    if (!keys.has(key)) continue; // cheap reject: nothing upstream touched this exact set

    const cumulative = patchId(git(["-C", dir, "diff", mergeBase, tip]));
    if (cumulative === null) continue;
    for (const candidate of candidates) {
      if (candidate.key !== key) continue;
      if (candidate.id === undefined) {
        candidate.id = patchId(git(["-C", dir, "show", "--format=", candidate.sha]));
      }
      if (candidate.id === cumulative) return branchCommits.slice(0, size);
    }
  }
  return [];
}

/**
 * Commits reachable from HEAD whose work exists nowhere on `upstream` — not under their own SHA,
 * and not under a squash commit's.
 *
 * @param {string} dir Worktree to inspect.
 * @param {string} [upstream] Integration branch to compare content against.
 * @returns {number | null} Count, or null when git could not answer — callers must refuse to
 *   delete anything on null rather than reading it as zero.
 */
export function countUnpushedCommits(dir, upstream = "origin/main") {
  const out = git(["-C", dir, "rev-list", "HEAD", "--not", "--remotes=origin"]);
  if (out === null) return null; // could not determine — caller must refuse
  if (out === "") return 0;
  const stranded = new Set(out.split("\n").filter(Boolean));

  // 1. Whatever run of commits a squash commit upstream already carries.
  for (const sha of upstreamBackedPrefix(dir, upstream)) stranded.delete(sha);
  if (stranded.size === 0) return 0;

  // 2. Individual commits that landed upstream on their own. A failure here (no origin/main yet,
  //    for instance) leaves the reachability answer standing, which over-reports rather than under.
  const cherry = git(["-C", dir, "cherry", upstream, "HEAD"]);
  if (cherry === null) return stranded.size;
  for (const line of cherry.split("\n")) {
    if (line.startsWith("-")) stranded.delete(line.slice(1).trim());
  }
  return stranded.size;
}
