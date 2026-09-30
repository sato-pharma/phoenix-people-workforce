import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MIN_MEMBERS, rollupBuildVerdict } from "../scripts/rollup-build-verdict.mjs";

/**
 * A member can MERGE while `rollup-prs.mjs --apply` is building, and that must not be a crash.
 *
 * The members are live pull requests other sessions are merging, and `delete_branch_on_merge` removes a
 * branch the moment its PR merges — so a fetch of a branch that existed a second ago fails. On
 * 2026-09-30 that killed a build outright with `fatal: couldn't find remote ref
 * codex/spotlight-report-it-look` when #4875 merged mid-build, leaving a half-built local branch and
 * the worktree switched onto it. That second part mattered as much as the crash: `new-session.mjs
 * --remove` judges a worktree by whatever branch it finds checked out.
 *
 * Surviving it is three things, and skipping is the LAST resort:
 *
 *   1. the failed fetch is not the question — the commit is usually still present from the
 *      classification pass, and if we HAVE the object the merge is as correct as it ever was, so the
 *      object decides and the fetch is allowed to fail;
 *   2. a member whose commit is genuinely gone is skipped and SAID, never dropped silently;
 *   3. and too few survivors abandons the build rather than opening a roll-up of one, which is a
 *      rename with a full CI run attached.
 */
export function runRollupBuildVerdictTests(): void {
  // ── 1. Enough survivors still builds ────────────────────────────────────────────────────────
  {
    assert.deepEqual(rollupBuildVerdict({ carried: 2, skipped: [] }), { kind: "build" });
    assert.deepEqual(rollupBuildVerdict({ carried: 3, skipped: [4875] }), { kind: "build" },
      "losing one of three still leaves a roll-up worth making");
  }

  // ── 2. A roll-up of one is abandoned, and it names what it lost ─────────────────────────────
  // One member is not a roll-up: it replaces no merges and costs a full CI run to say so.
  {
    const v = rollupBuildVerdict({ carried: 1, skipped: [4875] });
    assert.equal(v.kind, "abandon");
    assert.match(v.why ?? "", /#4875 merged while this ran/, "it must name the PR that vanished, not just the count");
    assert.match(v.why ?? "", /at least 2/, "and say what the threshold is");
    assert.match(v.why ?? "", /nothing is pushed/, "and that nothing was pushed");
  }

  // ── 3. Losing everything is still a clean abandon, not a crash ──────────────────────────────
  {
    const v = rollupBuildVerdict({ carried: 0, skipped: [] });
    assert.equal(v.kind, "abandon");
    assert.match(v.why ?? "", /no member survived/, "with nothing skipped and nothing carried it still explains itself");
  }

  assert.equal(MIN_MEMBERS, 2, "the threshold is two — one member is a rename, not a roll-up");

  // ── 4. The script: the fetch may fail, the OBJECT decides, and an abandon puts the tree back ─
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");

    assert.match(
      source,
      /git\(\['fetch', '--quiet', 'origin', pr\.headRefName\], \{ cwd: root, allowFail: true \}\)/,
      "the per-member fetch must be allowed to fail — a merged member's branch is deleted, and that killed a build",
    );
    assert.match(
      source,
      // `[\s\S]*` rather than `.*` with the `s` flag: this repo targets ES2017, where the dotAll flag
      // is a TS1501 typecheck error. Same match, no target dependency.
      /cat-file', '-e', `\$\{pr\.headRefOid\}\^\{commit\}`[\s\S]*allowFail: true \}\) === null/,
      "and the OBJECT decides: if the commit is still here the merge is still correct, fetch or no fetch",
    );
    assert.match(source, /skipped\.push\(pr\.number\)/, "a skipped member is recorded");
    assert.match(source, /skipped — its branch and its commit are both gone/, "and said out loud, never dropped silently");

    // The tree goes back. Both halves: off the half-built branch, and the branch deleted.
    assert.match(source, /const startedOn = git\(\['rev-parse', '--abbrev-ref', 'HEAD'\]/, "it records where it started");
    assert.match(source, /function abandon\(lines\)/, "there is one abandon path");
    assert.match(source, /git\(\['switch', '--quiet', startedOn\], \{ cwd: root, allowFail: true \}\)/, "which switches back");
    assert.match(source, /git\(\['branch', '-D', branch\], \{ cwd: root, allowFail: true \}\)/, "and removes the half-built branch");
    // The conflict path must route through it too, or that case still strands the worktree.
    assert.match(
      source,
      /abandon\(\[\s*`#\$\{pr\.number\} would not merge cleanly/,
      "the unexpected-conflict path abandons the same way rather than exiting where it stands",
    );

    // The saving quoted in the PR body is the one the SURVIVORS justify.
    assert.match(
      source,
      /\(carried\.length - 1\) \* BILLABLE_MINUTES_PER_MERGE/,
      "the saving is recomputed from what survived — a member that merged mid-build is no longer a merge this replaces",
    );
  }
}
