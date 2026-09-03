// The worktree backup guard must log BEFORE the worktree is deleted, not after.
//
// WHY THIS EXISTS. `.claude/hooks/worktree-exit-guard.mjs` is the only thing that notices, at the
// moment work stops, that commits exist only on this laptop — the failure a 2026-08-01 sweep found
// 82 times across 12 branches. It originally ran on SessionEnd only, anchored to `$DIR` from
// `git rev-parse --show-toplevel || pwd`. When a session removed its own worktree and then ended,
// that path no longer resolved and the script file itself was gone with the directory, so node
// exited MODULE_NOT_FOUND into a `|| true`.
//
// The result was silence, not an error. Measured 2026-08-23: `.claude/worktree-exit.log` had ZERO
// entries that day while three worktree sessions ended, and had been frozen since 2026-08-22T02:37
// — with the hook still registered in settings.json and the script still on disk, so every "is it
// disabled?" check answered no. The net went missing precisely on the TIDY path: a session that
// merges its PR and cleans up after itself was the one that lost the check.
//
// `--pre-removal` moves the check to a moment when everything still exists. These tests drive the
// real script as a SUBPROCESS against a real throwaway git repo, because the properties that matter
// are runtime ones — does a log line actually land, and does it land while the directory is still
// there. A test that imported the matcher and asserted on strings would have passed against the
// broken version too.
//
// The clean case is asserted as hard as the dirty case. A log that only speaks up on failure cannot
// be told apart from a log that is broken, which is the entire bug being fixed here.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The hook under test, resolved from the repo root the suite runs in. */
const guardPath = resolve(".claude/hooks/worktree-exit-guard.mjs");
const bashGuardPath = resolve(".claude/hooks/bash-guard.mjs");

function git(at: string, args: string[]): string {
  return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Runs the guard exactly as the hook does: command text on stdin, cwd inside the repo. */
function runGuard(at: string, command: string): string {
  return execFileSync(process.execPath, [guardPath, "--pre-removal"], {
    cwd: at,
    input: command,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
}

/** Runs the guard in its SessionEnd mode: no --pre-removal, cwd inside the worktree itself. */
function runGuardAtExit(at: string): string {
  return execFileSync(process.execPath, [guardPath], {
    cwd: at,
    input: "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
}

/**
 * Makes `git status` fail inside `at` while every OTHER read the guard performs still succeeds.
 *
 * A linked worktree's index lives at <primary>/.git/worktrees/<name>/index. Garbage there fails
 * `status` with "index file smaller than expected" (exit 128), but `rev-parse`, `rev-list` and
 * `--git-common-dir` all read refs and objects, not the index, so they keep answering normally.
 * That is exactly the shape the guard has to survive: ONE unreadable measurement inside an
 * otherwise working repo, not a repo that is broken everywhere and obviously so.
 */
function breakStatus(at: string): void {
  const gitDir = git(at, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  writeFileSync(join(gitDir, "index"), "NOT-AN-INDEX");
  // Prove the premise instead of assuming it. If some future git rebuilt a corrupt index silently
  // rather than failing, both tests below would pass vacuously — against the very bug they exist
  // to catch, which is the one failure mode this file already documents at length.
  let failed = false;
  try {
    execFileSync("git", ["status", "--porcelain"], { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    failed = true;
  }
  assert.ok(failed, "premise broken: a corrupt index no longer makes `git status` fail, so these tests prove nothing");
}

function readLog(repo: string): string {
  const file = join(repo, ".claude", "worktree-exit.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * On Windows `join()` builds `C:\Users\...\wt-foo` while git reports the same worktree as
 * `C:/Users/.../wt-foo`. Comparing the two raw made this suite fail against a guard that was
 * behaving correctly, so path comparisons go through here.
 */
const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase();

function logNames(log: string, path: string): boolean {
  return norm(log).includes(norm(path));
}

/**
 * A throwaway repo with two worktrees whose names share a prefix (`wt-foo` / `wt-foobar`), so the
 * boundary behaviour of the folder-name match is exercised for real rather than asserted in theory.
 *
 * It gets a real bare remote, which is not decoration. The guard measures unpushed work as "commits
 * reachable from no remote ref", so in a repo with NO remote every commit is correctly unpushed and
 * the clean case could never be observed. A remote is what makes "clean" mean anything.
 */
function makeRepo(): { repo: string; foo: string; foobar: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "phx-guard-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: ["ignore", "ignore", "pipe"] });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Guard Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-m", "seed"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-u", "origin", "main"]);

  const foo = join(root, "wt-foo");
  const foobar = join(root, "wt-foobar");
  git(repo, ["worktree", "add", "-b", "feature/foo", foo]);
  git(repo, ["worktree", "add", "-b", "feature/foobar", foobar]);

  return { repo, foo, foobar, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function runWorktreeExitGuardPreRemovalTests() {
  assert.ok(existsSync(guardPath), `guard not found at ${guardPath}`);
  assert.ok(existsSync(bashGuardPath), `bash-guard not found at ${bashGuardPath}`);

  // ── A clean worktree is logged too, and logged while it still exists ────────────────────────
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      assert.equal(readLog(repo), "", "log should start empty");

      const stdout = runGuard(repo, `git worktree remove "${foo}"`);

      const log = readLog(repo);
      assert.ok(logNames(log, foo), `log should name the target worktree.\n${log}`);
      assert.ok(
        log.includes("clean, nothing unpushed"),
        `a clean worktree must still produce a log line — silence is indistinguishable from a broken logger.\n${log}`,
      );
      // The ordering property this whole change exists for: the entry is on disk while the
      // directory is still there. The guard is a logger, so it must never have removed anything.
      assert.ok(existsSync(foo), "the guard must not remove the worktree — it only reports");
      assert.ok(stdout.includes("systemMessage"), "the report should also surface to the session");
    } finally {
      cleanup();
    }
  }

  // ── Uncommitted work is called out by name ──────────────────────────────────────────────────
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      writeFileSync(join(foo, "unsaved.txt"), "work that exists only here\n");

      runGuard(repo, `git worktree remove "${foo}"`);

      const log = readLog(repo);
      assert.ok(log.includes("PRE-REMOVAL WARNING"), `dirty worktree must warn.\n${log}`);
      assert.ok(log.includes("1 uncommitted file(s)"), `the count must be stated.\n${log}`);
      assert.ok(existsSync(join(foo, "unsaved.txt")), "the guard must not touch the files it warns about");
    } finally {
      cleanup();
    }
  }

  // ── Unpushed commits are called out, with the push command ready to paste ───────────────────
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      writeFileSync(join(foo, "committed.txt"), "committed but never pushed\n");
      git(foo, ["add", "committed.txt"]);
      git(foo, ["commit", "-m", "local only"]);

      runGuard(repo, `git worktree remove "${foo}"`);

      const log = readLog(repo);
      assert.ok(log.includes("PRE-REMOVAL WARNING"), `unpushed commits must warn.\n${log}`);
      assert.ok(log.includes("NO upstream at all"), `a branch with no remote must say so.\n${log}`);
      assert.ok(log.includes("push -u origin feature/foo"), `the push command must be ready to paste.\n${log}`);
      // Exactly one: the seed commit is on origin/main and must not be counted as at-risk. This is
      // the over-reporting trap check-unbacked-branches.ts documents, asserted here too.
      assert.ok(log.includes("1 unpushed commit(s)"), `the count must be exact, not "everything".\n${log}`);
    } finally {
      cleanup();
    }
  }

  // ── A working tree git could NOT read is UNVERIFIED, never "clean" ──────────────────────────
  // `git status` FAILING and `git status` reporting nothing are different answers. The guard
  // collapsed them with `?? ""`, so an unreadable tree scored dirty === 0 and printed
  // "clean, nothing unpushed. Safe to remove." — the reassuring sentence, produced by a check that
  // never ran, at the one moment a deletion is about to happen. Not knowing must read LOUDER than
  // clean, never quieter; scripts/repo-doctor.mjs documents this same trap in four places.
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      // Real uncommitted work is present the whole time. The guard cannot see it — that is the
      // point: what it prints has to reflect that it could not look, not what it hopes is there.
      writeFileSync(join(foo, "unsaved.txt"), "work that exists only here\n");
      breakStatus(foo);

      runGuard(repo, `git worktree remove "${foo}"`);

      const log = readLog(repo);
      assert.ok(
        log.includes("UNVERIFIED, not clean"),
        `an unreadable working tree must be reported as UNVERIFIED.\n${log}`,
      );
      assert.ok(
        log.includes("could not measure uncommitted files"),
        `the warning must name WHICH measurement failed, so it can be redone by hand.\n${log}`,
      );
      assert.ok(
        !log.includes("clean, nothing unpushed"),
        `a status read that FAILED must never be rendered as a clean tree — that line sits directly above "Safe to remove".\n${log}`,
      );
      assert.ok(
        !log.includes("0 uncommitted file(s)"),
        `an unknown count must not be printed as zero.\n${log}`,
      );
      assert.ok(existsSync(join(foo, "unsaved.txt")), "the guard must not touch files it could not even measure");
    } finally {
      cleanup();
    }
  }

  // ── SessionEnd mode: an unreadable working tree must not pass in SILENCE either ─────────────
  // The retirability report is the dangerous half — it prints `git worktree remove` and
  // `git branch -D` underneath the word RETIRABLE. When a branch is not retirable the old code
  // reached `if (dirty > 0)`, which `null > 0` fails, so it said nothing about the WORKING TREE at
  // all. Measured against the pre-fix guard, the entire log for a worktree holding real uncommitted
  // work it could not see was one line about the PR lookup. Silence on the tree is the same bug as
  // calling it clean, only quieter.
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      writeFileSync(join(foo, "unsaved.txt"), "work that exists only here\n");
      breakStatus(foo);

      runGuardAtExit(foo);

      const log = readLog(repo);
      assert.ok(
        log.includes("UNVERIFIED, not clean"),
        `SessionEnd must speak up about a working tree it could not read, not exit quietly.\n${log}`,
      );
      assert.ok(
        !log.includes("RETIRABLE"),
        `RETIRABLE must never be printed off a status read that failed.\n${log}`,
      );
    } finally {
      cleanup();
    }
  }

  // ── Matching: a shared prefix must not drag in the neighbouring worktree ────────────────────
  {
    const { repo, foo, foobar, cleanup } = makeRepo();
    try {
      // Removal written with the folder name only — the relative form people actually type.
      runGuard(repo, "git worktree remove ../wt-foo");

      const log = readLog(repo);
      assert.ok(logNames(log, foo), `the named worktree must be matched by folder name.\n${log}`);
      assert.ok(
        !logNames(log, foobar),
        `wt-foobar must NOT be matched by the wt-foo token — that would report a worktree nobody is removing.\n${log}`,
      );
    } finally {
      cleanup();
    }
  }

  // ── `rm -rf` on the payload counts as a removal too, not just `git worktree remove` ─────────
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      runGuard(repo, `rm -rf "${foo}"`);
      assert.ok(logNames(readLog(repo), foo), "a raw rm -rf of a registered worktree must still be logged");
    } finally {
      cleanup();
    }
  }

  // ── An ordinary command logs nothing. The hook must stay invisible in the common case ───────
  {
    const { repo, cleanup } = makeRepo();
    try {
      runGuard(repo, "git status --porcelain");
      assert.equal(readLog(repo), "", "a command that removes nothing must not write to the log");

      // A removal-shaped command aimed at something that is not a registered worktree is also
      // silent — the guard reports on worktrees, not on every deletion.
      runGuard(repo, "rm -rf ./node_modules/.cache");
      assert.equal(readLog(repo), "", "only registered worktrees are reported on");
    } finally {
      cleanup();
    }
  }

  // ── bash-guard relays the report and never turns it into a denial ───────────────────────────
  {
    const { repo, foo, cleanup } = makeRepo();
    try {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: `git worktree remove "${foo}"` },
      });
      const stdout = execFileSync(process.execPath, [bashGuardPath], {
        cwd: repo,
        input: payload,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });

      assert.ok(
        !stdout.includes("\"permissionDecision\":\"deny\""),
        `the backup check must never block a removal — it reports, it does not gate.\n${stdout}`,
      );
      assert.ok(stdout.includes("systemMessage"), `bash-guard must relay the guard's report.\n${stdout}`);
      assert.ok(logNames(readLog(repo), foo), "the relay path must still write the log");
    } finally {
      cleanup();
    }
  }
}
