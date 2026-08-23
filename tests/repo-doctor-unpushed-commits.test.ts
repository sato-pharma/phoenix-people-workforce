// A squash-merged branch is BACKED UP. The doctor must stop calling it stranded.
//
// WHY THIS EXISTS. `repo-doctor.mjs` decides whether a worktree can be deleted, and one of its
// three conditions is "no commits that exist only on this laptop". It answered that with pure
// reachability — `git rev-list HEAD --not --remotes=origin` — and its comment claimed that was
// squash-merge-safe. It is not, because this repository has `delete_branch_on_merge` ON: GitHub
// deletes `origin/<branch>` the moment the PR merges, so from that instant every commit on a
// SUCCESSFULLY MERGED branch is on no origin ref, and the doctor printed
//
//     # ^^ STOP - N commit(s) exist on NO origin ref. ... Push or `git branch rescue/...` FIRST.
//
// Confirmed live 2026-08-24 against PR #2364: branch tip `b4331638` and its squash commit
// `6209cf40` on main share patch-id `71422830...` — the same 4 files and 327 insertions — and the
// doctor still demanded a rescue. The false alarm fires on exactly the worktrees being retired,
// and the remedy it printed is worse than the alarm: pushing a squash-merged branch is what makes
// a conflicting PR, and a conflicted PR runs no CI at all.
//
// WHY THESE TESTS DRIVE REAL GIT. The bug was a wrong git command, not wrong string handling. A
// test that re-implemented the rule and asserted on strings would have passed against the broken
// version too. So each case builds a throwaway repo with a real squash-merge topology — a commit
// whose patch reaches main under a different SHA, with the branch's own remote ref absent — and
// asks the real function.
//
// EVERY CASE ALSO PINS THE OLD ANSWER. `reachabilityOnlyCount` below is the pre-fix check,
// reproduced verbatim. Asserting that it still says 1 where the fixed function says 0 is what
// proves these tests discriminate rather than passing for free.
//
// THE DANGEROUS DIRECTION IS ONE-WAY. This number gates deletion, so every unknown must read as
// "not backed up". The null and no-upstream cases below are not decoration: a check that answers
// 0 when it cannot tell is how real work gets deleted.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countUnpushedCommits } from "../scripts/repo-doctor-unpushed.mjs";

function git(at: string, args: string[]): string {
  return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The check exactly as it was before this fix, kept so each case can show what changed. */
function reachabilityOnlyCount(at: string): number {
  const out = git(at, ["rev-list", "HEAD", "--not", "--remotes=origin"]);
  return out === "" ? 0 : out.split("\n").length;
}

function write(at: string, name: string, body: string): void {
  writeFileSync(join(at, name), body);
}

/** The `+`/`-` marks `git cherry` puts on each commit: `-` means its patch is already upstream. */
function cherryMarks(at: string): string[] {
  return git(at, ["cherry", "origin/main", "HEAD"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, 1));
}

/**
 * A repo whose `feature` branch was squash-merged into main and whose remote branch is gone —
 * the state every worktree in this repository is in the moment its PR lands.
 */
function makeSquashMergedRepo(commits = 1): { repo: string; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "phx-doctor-unpushed-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: ["ignore", "ignore", "pipe"] });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Doctor Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  write(repo, "seed.txt", "seed\n");
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-u", "origin", "main"]);

  // The branch does its work, over however many commits the case is about.
  git(repo, ["checkout", "-b", "feature"]);
  for (let i = 1; i <= commits; i += 1) {
    write(repo, `feature-${i}.txt`, `the work, part ${i}\n`);
    git(repo, ["add", `feature-${i}.txt`]);
    git(repo, ["commit", "-m", `feat: the work, part ${i}`]);
  }

  // GitHub squashes the lot onto main: same content, ONE brand new SHA, branch never
  // fast-forwarded and never merged in the ancestry sense.
  git(repo, ["checkout", "main"]);
  for (let i = 1; i <= commits; i += 1) {
    write(repo, `feature-${i}.txt`, `the work, part ${i}\n`);
    git(repo, ["add", `feature-${i}.txt`]);
  }
  git(repo, ["commit", "-m", "feat: the work (#1234)"]);
  git(repo, ["push", "origin", "main"]);

  // `delete_branch_on_merge` removes the branch's own remote ref. It never had one here, which is
  // the same end state and keeps the fixture honest about what the doctor actually sees.
  git(repo, ["checkout", "feature"]);
  return { repo, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function runRepoDoctorUnpushedCommitsTests() {
  const { repo, root, cleanup } = makeSquashMergedRepo();
  try {
    // ── The whole point: merged work is backed up, whatever SHA carries it ────────────────
    assert.equal(
      reachabilityOnlyCount(repo),
      1,
      "the OLD check saw the squashed tip as stranded — if this is 0 the fixture stopped reproducing the bug",
    );
    assert.equal(
      countUnpushedCommits(repo),
      0,
      "a squash-merged branch is not stranded work",
    );

    // ── Genuine post-merge work is still caught ───────────────────────────────────────────
    // The failure this whole check exists to prevent. A commit whose patch is nowhere upstream
    // must keep counting, and must count ON ITS OWN — not be masked by the squashed tip beside it.
    write(repo, "later.txt", "written after the merge\n");
    git(repo, ["add", "later.txt"]);
    git(repo, ["commit", "-m", "chore: written after the merge"]);
    assert.equal(
      reachabilityOnlyCount(repo),
      2,
      "the old check lumped the real commit together with the squash artifact",
    );
    assert.equal(
      countUnpushedCommits(repo),
      1,
      "work that exists nowhere upstream is still reported as stranded",
    );

    // ── A branch sitting on pushed main has nothing outstanding ───────────────────────────
    git(repo, ["checkout", "main"]);
    assert.equal(countUnpushedCommits(repo), 0, "a branch level with its remote reports nothing");

    // ── Not knowing must read LOUDER than clean, never quieter ────────────────────────────
    // git failing has to return null so the caller refuses. Returning 0 here is how real work
    // gets deleted by a check that could not actually see it.
    assert.equal(
      countUnpushedCommits(join(root, "no-such-directory")),
      null,
      "an unreadable target is unknown, never clean",
    );
  } finally {
    cleanup();
  }

  // ── A MULTI-COMMIT squash: the case per-commit comparison cannot see ────────────────────
  // A squash collapses N patches into one, so no individual commit's patch ever matches it and
  // `git cherry` marks every one of them `+`, "not upstream". Comparing the branch's CUMULATIVE
  // diff against the squash commit is what settles it. Without this case the fix would have
  // shipped working only for single-commit branches — which #2364 happened to be.
  const multi = makeSquashMergedRepo(3);
  try {
    assert.equal(reachabilityOnlyCount(multi.repo), 3, "three commits, none on any origin ref");
    assert.deepEqual(
      cherryMarks(multi.repo),
      ["+", "+", "+"],
      "per-commit comparison alone calls all three unmerged — this is the gap being closed",
    );
    assert.equal(
      countUnpushedCommits(multi.repo),
      0,
      "a multi-commit branch squashed onto main is backed up, whole",
    );

    // And a real commit added afterwards still has to surface.
    write(multi.repo, "after.txt", "written after the squash\n");
    git(multi.repo, ["add", "after.txt"]);
    git(multi.repo, ["commit", "-m", "chore: after the squash"]);
    assert.equal(
      countUnpushedCommits(multi.repo),
      1,
      "the one commit that is genuinely new is still reported, and only that one",
    );
  } finally {
    multi.cleanup();
  }

  // ── No upstream to compare against falls back to over-reporting ─────────────────────────
  // `git cherry` cannot run without origin/main. The answer must degrade to the old, noisier
  // count rather than to a silent zero.
  const lone = mkdtempSync(join(tmpdir(), "phx-doctor-lone-"));
  try {
    execFileSync("git", ["init", "-b", "main", lone], { stdio: ["ignore", "ignore", "pipe"] });
    git(lone, ["config", "user.email", "test@example.com"]);
    git(lone, ["config", "user.name", "Doctor Test"]);
    git(lone, ["config", "commit.gpgsign", "false"]);
    write(lone, "only.txt", "never pushed anywhere\n");
    git(lone, ["add", "only.txt"]);
    git(lone, ["commit", "-m", "chore: only here"]);
    assert.equal(
      countUnpushedCommits(lone),
      1,
      "with no upstream to compare against, the count stays conservative instead of collapsing to zero",
    );
  } finally {
    rmSync(lone, { recursive: true, force: true });
  }

  // ── The doctor must actually be wired to this module ─────────────────────────────────────
  // Without this, the module could pass its own tests forever while repo-doctor.mjs kept its
  // inline reachability check and kept crying wolf.
  const doctorSource = readFileSync("scripts/repo-doctor.mjs", "utf8");
  assert.ok(
    doctorSource.includes('from "./repo-doctor-unpushed.mjs"'),
    "repo-doctor.mjs imports the checked implementation",
  );
  assert.ok(
    doctorSource.includes("countUnpushedCommits(dir)"),
    "repo-doctor.mjs delegates to it rather than keeping a second copy of the rule",
  );
  assert.ok(
    !doctorSource.includes('"--not", "--remotes=origin"'),
    "no inline reachability-only check survives in the doctor",
  );
}
