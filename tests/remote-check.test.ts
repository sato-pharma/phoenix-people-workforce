import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// scripts/remote-check.mjs runs the heavy checks on the self-hosted CI box instead of this laptop.
// Its whole value is that NOTHING heavy executes locally, so the invariants worth pinning are about
// where work happens and what it touches — not about its output, which depends on a live host.
//
// 🔴 THIS TEST CANNOT REACH THE BOX AND MUST NOT TRY. A test that SSHes is a test that fails in CI,
// on a laptop with no key, and in a cloud session — and would then be "fixed" by deleting it. It
// reads the source instead, which is the right instrument for "this script never does X".
const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = readFileSync(path.join(ROOT, "scripts", "remote-check.mjs"), "utf8");

export function runRemoteCheckTests(): void {
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
}
