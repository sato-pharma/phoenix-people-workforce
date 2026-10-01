import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRunScript, newRunId, runPaths } from "../scripts/remote-check-plan.mjs";

// scripts/remote-check.mjs runs the heavy checks on the self-hosted CI box instead of this laptop.
// Its whole value is that NOTHING heavy executes locally, so the invariants worth pinning are about
// where work happens and what it touches — not about its output, which depends on a live host.
//
// 🔴 THIS TEST CANNOT REACH THE BOX AND MUST NOT TRY. A test that SSHes is a test that fails in CI,
// on a laptop with no key, and in a cloud session — and would then be "fixed" by deleting it. It
// reads the source instead, which is the right instrument for "this script never does X".
const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = readFileSync(path.join(ROOT, "scripts", "remote-check.mjs"), "utf8");
const PLAN_SRC = readFileSync(path.join(ROOT, "scripts", "remote-check-plan.mjs"), "utf8");

export async function runRemoteCheckTests(): Promise<void> {
  // 1 — it must never run a check locally. The point of the script is that `tsc` does not start on
  // a 16 GB laptop where mem-watchdog.ps1 reaps it silently (AGENTS.md §5, bash-guard C8). Every
  // check command must be inside the CHECKS table, which is only ever interpolated into the remote
  // bash script — never handed to a local spawn.
  const localRunners = SRC.match(/(?:execFileSync|spawnSync)\(\s*["'](?!ssh|git)(\w+)["']/g) ?? [];
  assert.deepEqual(
    localRunners,
    [],
    "remote-check.mjs spawns something locally other than `ssh` and `git`: " + localRunners.join(", ") +
      ". The entire purpose of this script is that heavy work runs on the box — a local spawn of " +
      "node/pnpm/tsc defeats it and reintroduces the silent OOM kill that C8 exists to prevent.",
  );

  // 2 — the typecheck must carry the same heap CI gives it, or a PASS here does not predict CI.
  assert.ok(
    /max-old-space-size=6144[\s\S]*tsc --noEmit/.test(SRC),
    "the remote typecheck no longer matches ci.yml's `--max-old-space-size=6144`. A green result " +
      "here is only useful because it runs the same command the required `checks` job runs.",
  );

  // 2b — and it must run COLD, or the PASS is a cache read rather than a check. `tsconfig.json` sets
  // `"incremental": true`, and the box KEEPS its working directory between runs, so without this flag
  // `tsc` answers from `tsconfig.tsbuildinfo`. CI checks out fresh and is therefore cold by
  // construction — which is precisely why a warm pass here does not predict it. Measured 2026-09-30:
  // `PASS in 12s` on b04b2e80a, whose required `checks` job then went RED on two TS2322 errors,
  // against the ~112s a cold run takes. This finishes what assertion 2 promises: matching CI heap
  // does not make a green here mean what a green in CI means if the run never looked at the code.
  assert.ok(
    /tsc --noEmit[^"']*--incremental false/.test(SRC),
    "the remote typecheck no longer forces `--incremental false`. tsconfig sets `incremental: true` " +
      "and the box reuses its working directory, so tsc answers from tsconfig.tsbuildinfo and reports " +
      "a PASS for code it never rechecked — a false green in the one tool that exists to replace the " +
      "local typecheck (AGENTS.md §5: a warm incremental cache lies).",
  );

  // 3 — it must not use the runner's own working directory. A CI job owns ~/actions-runner/_work
  // and cleans it between runs; sharing it makes a real CI run fail for reasons nobody can
  // reproduce, and a persistent runner already has stale-state hazards of its own.
  assert.ok(
    !/actions-runner[^"']*_work/.test(SRC),
    "remote-check.mjs points at the runner's _work directory. Use its own directory — a CI job " +
      "owns that tree, and a concurrent checkout there corrupts a required check.",
  );

  // 4 — no GitHub credential may be placed on the box. It pushes over SSH into a bare repo, so the
  // box never authenticates to GitHub and losing the box does not leak repository access.
  assert.ok(
    !/GH_TOKEN|GITHUB_TOKEN|gh auth|https:\/\/[^"'\s]*@github\.com/.test(SRC),
    "remote-check.mjs would put a GitHub credential on the CI box. It must push over SSH into a " +
      "bare repo instead: the box is shared infrastructure and holds repository-level trust already.",
  );

  // 5 — it must say what it did NOT check. It sends the committed sha, so uncommitted edits are
  // invisible; a clean PASS that silently ignored the working tree is the failure mode that makes
  // a tool like this actively dangerous.
  assert.ok(
    /status", "--porcelain/.test(SRC) && /NOT included/.test(SRC),
    "remote-check.mjs no longer warns about uncommitted changes. It checks the COMMIT, so a dirty " +
      "tree means the PASS refers to code that is not what the developer is looking at.",
  );

  // 6 — the exit code must be the check's own, or a script wrapper turns every failure green. This
  // repo has been bitten by exactly that shape before (a pipeline reporting its last stage's 0).
  assert.ok(
    /process\.exit\(status\)/.test(SRC),
    "remote-check.mjs no longer exits with the remote status. A wrapper that always exits 0 makes " +
      "a failing typecheck read as a pass.",
  );

  // 7 — every invocation gets a tree of its own. Until 2026-10-01 they all shared
  // ~/remote-check/work and one `remote-check` branch, so a second session's checkout swapped the tree
  // under a running check: 19442c382 printed its own `box head`, failed a typecheck with TS6053 on a
  // file that commit HAS, and passed a suite with the OTHER commit's file count (2,085 against CI's
  // 2,086). The shared directory, the shared branch and the `|| git checkout FETCH_HEAD` fallback
  // (which ran whatever the shared branch held when the sha was missing) must not come back.
  assert.ok(
    !/REMOTE_ROOT \+ "\/work"/.test(SRC) && !/refs\/heads\/remote-check"/.test(SRC),
    "remote-check.mjs is back on one shared directory or one shared branch for every invocation — " +
      "two sessions then check out over each other mid-run and the verdict is about the wrong commit.",
  );
  assert.ok(
    !/checkout -q -f/.test(SRC) && /worktree add -q --detach "\$RUN" "\$WANT"/.test(PLAN_SRC),
    "the box script checks a commit out in place again. Each run must `git worktree add` exactly its " +
      "own sha into its own directory.",
  );
  assert.ok(
    /sha \+ ":" \+ paths\.ref/.test(SRC) && /buildRunScript\(/.test(SRC) && /buildLockfileScript\(/.test(SRC),
    "remote-check.mjs must push to the per-run ref and run BOTH modes through remote-check-plan.mjs.",
  );
  assert.ok(
    /status === 3[\s\S]*NO VERDICT[\s\S]*process\.exit\(3\)/.test(SRC),
    "remote-check.mjs no longer turns the tree guard's exit 3 into NO VERDICT — a swapped tree would " +
      "print PASS or FAIL for a commit it never checked.",
  );

  // 8 — the generated script re-reads HEAD after EVERY check, and two runs never share a path.
  const sha = "a".repeat(40);
  const runA = newRunId(sha, 1_000, "aaaa");
  const runB = newRunId(sha, 1_000, "bbbb");
  assert.notEqual(runPaths("/r", runA).runDir, runPaths("/r", runB).runDir, "two runs of the same sha got the same directory");
  assert.notEqual(runPaths("/r", runA).ref, runPaths("/r", runB).ref, "two runs of the same sha got the same ref");
  const script = buildRunScript({
    remoteRoot: "/r",
    runId: runA,
    sha,
    install: "true",
    steps: [
      { name: "lint", command: "true" },
      { name: "typecheck", command: "true" },
      { name: "test", command: "true" },
    ],
  });
  assert.ok(
    !/FETCH_HEAD|git checkout|git fetch/.test(script),
    "the generated box script fetches or checks out in place again — a missing sha then falls back to " +
      "whatever the box holds, which is how a run reports on a commit it never named.",
  );
  for (const name of ["lint", "typecheck", "test"]) {
    const line = script.split("\n").find((l) => l.includes("=== " + name + " ===")) ?? "";
    assert.match(line, new RegExp("fi; .*same_tree " + name + ";"), "the " + name + " step does not verify the tree after it ran");
  }
  assert.throws(
    () => buildRunScript({ remoteRoot: "/r", runId: runA, sha: "19442c382", install: "true", steps: [] }),
    /40-character/,
    "a short sha must be refused, never resolved on the box to whatever it happens to match",
  );
  assert.throws(
    () => buildRunScript({ remoteRoot: "/r", runId: "x; rm -rf ~", sha, install: "true", steps: [] }),
    /unsafe run id/,
    "the run id is spliced into bash and must be refused unless it is plain",
  );

  // 9 — BEHAVIOUR: run the generated bash for real against a throwaway bare repo. It needs bash, git
  // and a POSIX `find`, so it runs on the Linux CI runners and is skipped on the Windows laptop, where
  // `bash` may resolve to WSL. The required `validate` job is Linux, so it always runs where it gates.
  if (process.platform === "win32") return;
  if (spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).status !== 0) return;

  const tmp = mkdtempSync(path.join(os.tmpdir(), "phx-remote-check-"));
  try {
    const g = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, "git " + args.join(" ") + " failed: " + r.stderr);
      return r.stdout.trim();
    };
    const remoteRoot = path.join(tmp, "box");
    mkdirSync(remoteRoot);
    g(remoteRoot, "init", "-q", "--bare", "repo.git");
    const src = path.join(tmp, "src");
    mkdirSync(src);
    g(src, "init", "-q");
    g(src, "config", "user.email", "t@t");
    g(src, "config", "user.name", "t");
    writeFileSync(path.join(src, "base.txt"), "base\n");
    g(src, "add", ".");
    g(src, "commit", "-q", "-m", "base");
    const without = g(src, "rev-parse", "HEAD");
    writeFileSync(path.join(src, "new-test.ts"), "x\n"); // the file 19442c382 added
    g(src, "add", ".");
    g(src, "commit", "-q", "-m", "with");
    const withFile = g(src, "rev-parse", "HEAD");
    const bare = path.join(remoteRoot, "repo.git");
    g(src, "push", "-q", bare, withFile + ":refs/remote-check/seed-with", without + ":refs/remote-check/seed-without");

    const runBox = (runId: string, want: string, command: string) =>
      new Promise<{ status: number | null; out: string }>((resolve) => {
        const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (status) => resolve({ status, out }));
        child.stdin.end(buildRunScript({ remoteRoot, runId, sha: want, install: "true", steps: [{ name: "probe", command }] }));
      });

    // 9a — THE 2026-10-01 SHAPE: two invocations at once on two commits, each sleeping mid-check so
    // they overlap. Each must see ITS OWN tree for the whole check. On the shared directory the second
    // checkout replaced the first's files; here neither can reach the other's.
    const [a, b] = await Promise.all([
      runBox(newRunId(withFile), withFile, "{ sleep 1; test -f new-test.ts; }"),
      runBox(newRunId(without), without, "{ sleep 1; test ! -f new-test.ts; }"),
    ]);
    assert.equal(a.status, 0, "the run on the commit WITH the file did not see it — its tree was not its own:\n" + a.out);
    assert.equal(b.status, 0, "the run on the commit WITHOUT the file saw it — its tree was not its own:\n" + b.out);
    assert.match(a.out, new RegExp("box head: " + withFile.slice(0, 7)));
    assert.match(b.out, new RegExp("box head: " + without.slice(0, 7)));

    // 9b — and it cleans up after itself: no run directory and no per-run ref survive a run.
    const leftoverRefs = g(bare, "for-each-ref", "--format=%(refname)", "refs/remote-check/")
      .split("\n")
      .filter((r) => r && !r.includes("/seed-"));
    assert.deepEqual(leftoverRefs, [], "per-run refs survived their runs: " + leftoverRefs.join(", "));
    const leftoverDirs = spawnSync("bash", ["-c", 'ls -A "$1" 2>/dev/null', "_", path.join(remoteRoot, "runs")], {
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(leftoverDirs, "", "run directories survived their runs: " + leftoverDirs);

    // 9c — THE GUARD: if the tree moves under a check anyway, the run has NO VERDICT. The probe itself
    // succeeds, so without the guard this would print PASS for a commit it never finished checking.
    const swapped = await runBox(newRunId(withFile), withFile, "git checkout -q --detach " + without);
    assert.equal(swapped.status, 3, "a tree that changed mid-run did not exit 3 (NO VERDICT):\n" + swapped.out);
    assert.match(swapped.out, /TREE CHANGED UNDER THE RUN after probe/);
    assert.doesNotMatch(swapped.out, /--- probe PASS/, "a swapped run printed a PASS line");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
