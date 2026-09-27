/**
 * WHY THIS EXISTS
 *
 * `.github/workflows/staging-branch-sync.yml` fast-forwards `refs/heads/staging` to the commit a
 * `CI` run on `main` just proved green, so that staging only ever deploys verified code. Everything
 * in it is a three-line script EXCEPT one guard, and that guard is the whole reason the workflow can
 * be trusted:
 *
 *     git merge-base --is-ancestor "$CUR_SHA" "$NEW_SHA"
 *
 * CI runs finish OUT OF ORDER. Commit A merges, then B; B's run can conclude before A's, so A's sync
 * fires last. Without the guard that sync moves `staging` BACKWARDS to A, and staging then serves
 * older code than it did a minute earlier — the 2026-08-13 stale-staging incident
 * (deploy-drift-check.yml's header: five merged, green PRs unshipped for hours with no signal)
 * arriving by a different route and harder to spot, because the branch looks freshly updated.
 *
 * 🔴 THE OPERAND ORDER IS THE FAILURE MODE, and it is invisible on review. `--is-ancestor A B` asks
 * "is A an ancestor of B". Swap the two and the guard inverts: it then permits exactly the backwards
 * moves it exists to refuse, and refuses every legitimate fast-forward — so `staging` either rewinds
 * silently or stops advancing entirely. Both are quiet. Neither turns a check red. A comment cannot
 * catch that; only executing the real predicate can.
 *
 * So this test LIFTS THE PREDICATE OUT OF THE LIVE YAML and runs it against a real git repository
 * with a known shape. It does not re-implement the check — a test that hard-coded its own
 * merge-base call would pass against a workflow whose operands had been swapped, which is precisely
 * the bug it is meant to catch.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = ".github/workflows/staging-branch-sync.yml";

/** The `--is-ancestor` line exactly as the live workflow spells it. */
function guardLineFromWorkflow(yml: string): string {
  const line = yml
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes("merge-base") && l.includes("--is-ancestor"));
  assert.ok(
    line,
    `${WORKFLOW} no longer contains a \`git merge-base --is-ancestor\` line. Either the ordering guard was ` +
      "removed — which lets an out-of-order CI completion rewind what staging serves — or it was rewritten " +
      "in a form this test can no longer find and verify. Do not delete this test to make it pass.",
  );
  return line as string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

/** Run the WORKFLOW'S OWN predicate, with its two shell variables bound, in a real repo. */
function guardAllows(repo: string, guardLine: string, cur: string, next: string): boolean {
  // The live line is `if ! git merge-base --is-ancestor "$CUR_SHA" "$NEW_SHA"; then`. Strip the shell
  // framing and keep the command, so the operands and their ORDER come from the workflow, not here.
  const cmd = guardLine
    .replace(/^if\s+!\s*/, "")
    .replace(/;\s*then\s*$/, "")
    .trim();
  assert.match(
    cmd,
    /^git merge-base --is-ancestor /,
    `the guard line in ${WORKFLOW} is no longer a bare \`git merge-base --is-ancestor\` invocation, so this ` +
      `test cannot execute it faithfully: ${guardLine}`,
  );
  try {
    execFileSync("bash", ["-c", cmd], {
      cwd: repo,
      env: { ...process.env, CUR_SHA: cur, NEW_SHA: next },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true; // ancestor -> the workflow proceeds to push
  } catch {
    return false; // not an ancestor -> the workflow no-ops
  }
}

export function runStagingBranchSyncGuardTests(): void {
  const yml = readFileSync(WORKFLOW, "utf8");

  // ── Structural pins: the things that make the workflow correct at all ────────────────────────

  assert.match(
    yml,
    /workflow_run:/,
    `${WORKFLOW} must trigger on \`workflow_run\`. A \`push\` trigger fires BEFORE CI has a verdict, which ` +
      "would publish unverified commits to the branch staging deploys from — the opposite of this workflow's purpose.",
  );
  assert.match(
    yml,
    /workflows:\s*\["CI"\]/,
    `${WORKFLOW} must key on the \`CI\` workflow by name; that is the run whose conclusion gates the sync.`,
  );
  assert.match(
    yml,
    /github\.event\.workflow_run\.conclusion\s*==\s*'success'/,
    `${WORKFLOW} must publish only when the CI run concluded \`success\`. Without that gate a failed or ` +
      "cancelled run would advance staging to an unverified commit.",
  );
  assert.match(
    yml,
    /github\.event\.workflow_run\.head_sha/,
    `${WORKFLOW} must push \`github.event.workflow_run.head_sha\` — the commit that run actually tested. Using ` +
      "main's current tip instead publishes a commit whose own CI has not concluded: measured 2026-09-27, four " +
      "merges landed in nine minutes while a CI run takes about five.",
  );
  assert.ok(
    /fetch-depth:\s*0/.test(yml),
    `${WORKFLOW} must check out with \`fetch-depth: 0\`. \`git merge-base\` cannot answer on a shallow clone, and ` +
      "the guard would then fail open or fail closed depending on the shape of the truncation.",
  );
  // Comments are stripped FIRST, and that is not incidental: this workflow's own comment says
  // "NEVER --force", so grepping the raw file makes the assertion fire on the very prose that
  // documents the rule. Caught by running the test — which is the point of running it.
  const commandsOnly = yml
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    // the `git fetch` refspec legitimately carries a leading `+`; it is a fetch, not a push
    .replace(/\+refs\/heads\/staging:refs\/remotes\/origin\/staging/g, "");
  assert.ok(
    !/--force|-f\b|\+refs\/heads\/staging/.test(commandsOnly),
    `${WORKFLOW} must never force-push \`staging\` (no \`--force\`, no \`+\` refspec on the push). A rejected push ` +
      "means an assumption in the guard broke, and that belongs in a red check rather than being overwritten silently.",
  );
  assert.ok(
    /^\s*runs-on:\s*ubuntu-latest\s*$/m.test(yml),
    `${WORKFLOW} must pin \`runs-on\` to a literal label, not \`vars.CI_RUNNER\`. A job whose label matches no ` +
      "ONLINE runner does not fall back — it QUEUES — and a queued sync means staging silently stops advancing. " +
      "The repository has had zero self-hosted runners registered since 2026-09-27.",
  );

  // ── The guard, executed ─────────────────────────────────────────────────────────────────────

  const guardLine = guardLineFromWorkflow(yml);

  const repo = mkdtempSync(join(tmpdir(), "phx-staging-sync-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "A");
    const a = git(repo, "rev-parse", "HEAD");
    git(repo, "commit", "-q", "--allow-empty", "-m", "B");
    const b = git(repo, "rev-parse", "HEAD");
    // A divergent commit off A: neither an ancestor nor a descendant of B.
    git(repo, "checkout", "-q", "-b", "side", a);
    git(repo, "commit", "-q", "--allow-empty", "-m", "C");
    const c = git(repo, "rev-parse", "HEAD");

    assert.equal(
      guardAllows(repo, guardLine, a, b),
      true,
      "a genuine fast-forward (staging at A, CI verified its descendant B) must be ALLOWED. If this fails the " +
        "operands are almost certainly swapped, and staging will stop advancing entirely.",
    );

    assert.equal(
      guardAllows(repo, guardLine, b, a),
      false,
      "moving staging BACKWARDS (staging at B, an out-of-order CI completion arriving for its ancestor A) must be " +
        "REFUSED. This is the case the guard exists for: allowing it makes staging serve older code than it did a " +
        "minute earlier, with the branch looking freshly updated.",
    );

    assert.equal(
      guardAllows(repo, guardLine, b, c),
      false,
      "a DIVERGENT commit (staging at B, verified commit C off a rewritten or unrelated history) must be REFUSED " +
        "rather than silently rewinding what staging serves.",
    );

    assert.equal(
      guardAllows(repo, guardLine, a, a),
      true,
      "a commit is its own ancestor, so the predicate is permissive for an identical SHA — harmless only because " +
        "the workflow short-circuits equality BEFORE reaching the guard. If that earlier `[ \"$CUR_SHA\" = \"$NEW_SHA\" ]` " +
        "check is ever removed, the sync would push a no-op on every run instead of exiting early.",
    );

    assert.match(
      yml,
      /\[\s*"\$CUR_SHA"\s*=\s*"\$NEW_SHA"\s*\]/,
      `${WORKFLOW} must short-circuit when staging is already at the verified commit, before the ancestry guard.`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
