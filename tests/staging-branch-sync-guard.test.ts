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
    `${WORKFLOW} must pin \`runs-on\` to a literal label, never a computed one. A job whose label matches no ` +
      "ONLINE runner does not fall back — it QUEUES — and a queued sync means staging silently stops advancing. " +
      "Self-hosted runners ARE registered here, every one carrying the identical label set " +
      "self-hosted,X64,Linux,phoenix, so this is a live hazard rather than a theoretical one. (An earlier " +
      "version of this message said zero were registered, which was already false. Do not replace that with " +
      "a number either: the count read ten and then three inside one hour on 2026-09-28.)",
  );

  // ── THE RED HALF: only a `success` conclusion may publish ───────────────────────────────────
  //
  // This is the gate that actually refuses a bad commit on staging's path, now that staging deploys
  // from `staging` rather than `main`. It cannot be proven by a live experiment: `ci.yml` runs on
  // `push` to main/master only, so a commit pushed to the `staging` branch produces NO CI run at
  // all — there is no red verdict for anything to react to, and a "test" of it would only deploy
  // broken code to an environment holding a real production clone while proving nothing. So the
  // condition is proven where it actually lives: by evaluating it against every conclusion GitHub
  // can emit.
  //
  // 🔴 THE TRAP IS BROADENING, NOT DELETING. `== 'success'` is easy to "improve" into
  // `!= 'failure'`, which reads equivalent and is not: it lets `cancelled`, `timed_out`,
  // `startup_failure`, `stale`, `neutral`, `skipped` and `action_required` through. A cancelled or
  // startup-failed run has tested NOTHING, and publishing its commit would put unverified code on
  // the branch staging deploys from — silently, because the sync would report success.
  const ifLine = yml
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("if:") && l.includes("workflow_run.conclusion"));
  assert.ok(
    ifLine,
    `${WORKFLOW} no longer gates the job on the CI run's conclusion. Without it, a FAILED run would advance ` +
      "`staging` to an unverified commit and staging would deploy it.",
  );

  // GitHub's full conclusion vocabulary. Only the first may publish.
  const CONCLUSIONS = [
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "neutral",
    "action_required",
    "stale",
    "startup_failure",
  ];
  const expr = (ifLine as string).replace(/^if:\s*/, "").replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  for (const conclusion of CONCLUSIONS) {
    // Evaluate the workflow's OWN expression with this conclusion substituted in. Lifted, not
    // re-implemented: a hard-coded `=== "success"` here would pass against a broadened workflow.
    const js = expr
      .replace(/github\.event\.workflow_run\.conclusion/g, JSON.stringify(conclusion))
      .replace(/!=/g, "!==")
      .replace(/(?<![=!<>])==(?!=)/g, "===")
      .replace(/'/g, '"');
    let publishes: boolean;
    try {
      publishes = Boolean(new Function(`return (${js});`)());
    } catch (err) {
      throw new Error(
        `${WORKFLOW}'s job condition could not be evaluated after substitution — it has grown beyond a simple ` +
          `comparison and this test can no longer verify the red half faithfully.\n  condition: ${expr}\n  as js: ${js}\n  ${String(err)}`,
      );
    }
    assert.equal(
      publishes,
      conclusion === "success",
      conclusion === "success"
        ? "a SUCCESSFUL CI run must publish to `staging`, otherwise the branch never advances and staging goes stale — the 2026-08-13 failure."
        : `a CI run concluding \`${conclusion}\` must NOT publish to \`staging\`. That run verified nothing, so advancing ` +
          "the branch would put unverified code on the branch staging deploys from, silently. Condition under test: " +
          expr,
    );
  }

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

    // ── The verify step's operand must be RESOLVABLE before merge-base is asked about it ───────
    //
    // `merge-base --is-ancestor` does not answer "false" for an object this clone has never seen —
    // it exits NON-ZERO with "fatal: Not a valid commit name", which lands in the else branch. In
    // the verify step that else branch reports a hostile writer, so an unfetched commit made the one
    // benign race the step exists to tolerate go RED. Establish the underlying git behaviour first,
    // because it is the entire reason the resolution check has to exist.
    const bogus = "0000000000000000000000000000000000000001";
    let erroredOnUnknownObject = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", a, bogus], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      erroredOnUnknownObject = true;
    }
    assert.equal(
      erroredOnUnknownObject,
      true,
      "git no longer errors on `merge-base --is-ancestor` with an unresolvable operand. If it now returns a clean " +
        "false instead, the `git cat-file -e` resolution check in the verify step is no longer load-bearing and the " +
        "comment explaining it is misleading — revisit both rather than deleting this assertion.",
    );

    // Comments stripped again, and for the second time in this file it is load-bearing rather than
    // tidiness: the verify step's own comment EXPLAINS the merge-base failure mode, so it contains
    // the string `--is-ancestor` above the `cat-file` line and an index comparison over the raw text
    // reads the prose as the call. A test that greps a file documenting itself has to ignore the
    // documentation.
    const verifyStep = yml
      .slice(yml.indexOf("Verify the remote actually moved"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    const catFileAt = verifyStep.indexOf("cat-file -e");
    const mergeBaseAt = verifyStep.indexOf("--is-ancestor");
    assert.ok(
      catFileAt !== -1,
      `${WORKFLOW}'s verify step must resolve \`$ACTUAL\` with \`git cat-file -e\` before comparing it. Without that, ` +
        "a commit pushed by a later sync — merged after this job checked out, so absent from this clone — makes the " +
        "step report `Something else is writing this branch` and fail. That is a FALSE RED on the exact race the " +
        "step was written to tolerate (found in review of #4552).",
    );
    assert.ok(
      catFileAt < mergeBaseAt,
      `${WORKFLOW}'s verify step calls \`merge-base --is-ancestor\` BEFORE resolving \`$ACTUAL\` with \`cat-file -e\`. ` +
        "The order is the fix: resolving afterwards cannot prevent the false red, because merge-base has already " +
        "exited non-zero and taken the hostile-writer branch.",
    );
    assert.match(
      verifyStep,
      /git fetch[^\n]*origin "\$ACTUAL"/,
      `${WORKFLOW}'s verify step must try to FETCH \`$ACTUAL\` before giving up on resolving it; otherwise every ` +
        "raced sync degrades to a notice instead of actually being checked.",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
