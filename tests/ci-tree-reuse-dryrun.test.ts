import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TESTED_TREE_PREFIX,
  VERDICT_PREFIX,
  dryRun,
  judge,
  prNumberFromSubject,
  report,
  testedTreeFromJobs,
} from "../scripts/ci-tree-reuse.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The TREE-REUSE DRY RUN (owner, 2026-10-14, cost cuts: "build step 3 as a dry run").
 *
 * A push to `main` bills about 12.3 minutes and `checks` was 5.1 of them. The PR run already ran the
 * same lint, typecheck and unit suite on its merge commit, so if the commit that lands has the very
 * same TREE the second run proves nothing new. Whether that is common is a measurement: this ships
 * only the measuring, and changes what runs on `main` by exactly nothing.
 *
 * What this pins, in the order a mistake would hurt:
 *
 *  1. THE VERDICT is a pure comparison of two 40-hex tree ids, and anything unreadable is UNKNOWN,
 *     never a MATCH. A wrong MATCH is the only dangerous output, because a later change could skip on it.
 *  2. THE READ PATH finds the PR from the squash subject's `(#N)`, takes its FINAL head, and reads the
 *     tree out of the step names of the green PR run. Every failure becomes UNKNOWN with a reason and
 *     NOTHING throws: a dry run that can fail a deploy-gating job is not a dry run.
 *  3. THE WIRING: the recording steps run on a pull_request only, the dry-run steps on a push only,
 *     both continue-on-error, the dry-run steps are the LAST two in `static` so they cannot delay it,
 *     the permissions added are read-only, and NO `if:` anywhere reads the verdict to decide anything.
 *     That last one is the whole point: it must stay a measurement until the owner says otherwise.
 */

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const HEAD = "c".repeat(40);
const REPO = "owner/repo";

/** ci.yml with its `#` comment lines removed, so prose that spells a pinned string pins nothing. */
const yamlWithoutComments = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

export function runCiTreeReuseDryrunTests() {
  // 1. The verdict
  assert.equal(judge({ tree: TREE_A, tested: TREE_A }).verdict, "MATCH", "identical trees match");
  assert.equal(judge({ tree: TREE_A, tested: TREE_B }).verdict, "DIFFER", "different trees differ");
  for (const bad of [null, undefined, "", "abc", "g".repeat(40), TREE_A.toUpperCase(), TREE_A + "0"]) {
    assert.equal(judge({ tree: TREE_A, tested: bad as string }).verdict, "UNKNOWN", `a recorded tree of ${JSON.stringify(bad)} is UNKNOWN, never a match`);
    assert.equal(judge({ tree: bad as string, tested: TREE_A }).verdict, "UNKNOWN", `an unreadable local tree of ${JSON.stringify(bad)} is UNKNOWN, never a match`);
  }
  assert.equal(
    judge({ tree: null as unknown as string, tested: null as unknown as string }).verdict,
    "UNKNOWN",
    "two unreadable trees are not equal trees",
  );

  // 2. The read path
  assert.equal(prNumberFromSubject("fix(x): a thing (#5901)"), 5901);
  assert.equal(prNumberFromSubject("fix(x): a thing (#5901)  "), 5901, "trailing whitespace is tolerated");
  for (const none of ["fix(x): a thing", "fix(x): see (#12) for more", "Merge branch main", "", null, undefined]) {
    assert.equal(prNumberFromSubject(none as string), null, `${JSON.stringify(none)} carries no PR number`);
  }

  const jobs = (...steps: string[]) => [
    { name: "validate", steps: [{ name: TESTED_TREE_PREFIX + TREE_B }] },
    { name: "static", steps: steps.map((name) => ({ name })) },
  ];
  assert.equal(testedTreeFromJobs(jobs("Install", TESTED_TREE_PREFIX + TREE_A, "Lint")), TREE_A, "the tree is read from the static job's step names");
  assert.equal(
    testedTreeFromJobs([{ name: "checks", steps: [{ name: TESTED_TREE_PREFIX + TREE_A }] }]),
    TREE_A,
    "a PR run from before 2026-10-19 recorded it in `checks`, and a push can still be compared against one",
  );
  assert.equal(testedTreeFromJobs(jobs("Install")), null, "no recording step reads null");
  assert.equal(testedTreeFromJobs(jobs(TESTED_TREE_PREFIX + "not-a-sha")), null, "a malformed recording reads null");
  assert.equal(testedTreeFromJobs(jobs(TESTED_TREE_PREFIX + TREE_A, TESTED_TREE_PREFIX + TREE_B)), null, "two different recorded trees are ambiguous, so null");
  assert.equal(testedTreeFromJobs(jobs(TESTED_TREE_PREFIX + TREE_A, TESTED_TREE_PREFIX + TREE_A)), TREE_A, "the same tree recorded twice is still one tree");
  assert.equal(testedTreeFromJobs(null as never), null);
  assert.equal(testedTreeFromJobs([{ name: "validate", steps: [{ name: TESTED_TREE_PREFIX + TREE_A }] }]), null, "only the static (or older checks) job counts");

  const git = (tree: string, subject: string) => (_file: string, args: string[]) => (args[0] === "rev-parse" ? tree + "\n" : subject + "\n");
  const RUNS = `repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&status=success&per_page=5`;
  const world = (overrides: Record<string, unknown> = {}) => (path: string) => {
    const table: Record<string, unknown> = {
      [`repos/${REPO}/pulls/5901`]: { head: { sha: HEAD } },
      [RUNS]: { workflow_runs: [{ id: 77 }] },
      [`repos/${REPO}/actions/runs/77/jobs?per_page=50`]: { jobs: jobs(TESTED_TREE_PREFIX + TREE_A) },
      ...overrides,
    };
    if (!(path in table)) throw new Error("unexpected read " + path);
    const value = table[path];
    if (value instanceof Error) throw value;
    return value;
  };
  const verdict = (tree: string, subject: string, readGh = world()) =>
    dryRun({ repo: REPO, readGit: git(tree, subject), readGh: readGh as never });

  assert.equal(verdict(TREE_A, "fix(x): y (#5901)").verdict, "MATCH", "same tree as the green PR run");
  assert.equal(verdict(TREE_B, "fix(x): y (#5901)").verdict, "DIFFER", "main moved, so the trees differ");
  assert.equal(verdict(TREE_A, "fix(x): y").verdict, "UNKNOWN", "no PR number in the subject");
  assert.equal(verdict(TREE_A, "fix(x): y (#5901)", world({ [`repos/${REPO}/pulls/5901`]: {} })).verdict, "UNKNOWN", "a PR with no head");
  assert.equal(verdict(TREE_A, "fix(x): y (#5901)", world({ [RUNS]: { workflow_runs: [] } })).verdict, "UNKNOWN", "a final head with no green CI run");
  assert.equal(
    verdict(TREE_A, "fix(x): y (#5901)", world({ [`repos/${REPO}/actions/runs/77/jobs?per_page=50`]: { jobs: jobs("Install") } })).verdict,
    "UNKNOWN",
    "a green run from before the recording step",
  );
  const boom = verdict(TREE_A, "fix(x): y (#5901)", world({ [`repos/${REPO}/pulls/5901`]: new Error("HTTP 403: rate limit\nmore") }));
  assert.equal(boom.verdict, "UNKNOWN", "a failing API read is UNKNOWN");
  assert.doesNotMatch(boom.reason, /\n/, "the reason is one line");
  assert.equal(
    dryRun({
      repo: REPO,
      readGit: () => {
        throw new Error("no git");
      },
      readGh: world() as never,
    }).verdict,
    "UNKNOWN",
    "a failing git read never throws",
  );
  assert.equal(dryRun({ repo: "", readGit: git(TREE_A, "fix(x): y (#5901)"), readGh: world() as never }).verdict, "UNKNOWN", "no repository name");

  const stepsOf: Record<number, string[]> = {
    1: [VERDICT_PREFIX + "MATCH"],
    2: [VERDICT_PREFIX + "DIFFER"],
    3: [VERDICT_PREFIX + "UNKNOWN"],
    4: ["Install"],
  };
  const counted = report(4, {
    repo: REPO,
    readGh: ((path: string) =>
      path.includes("/runs?event=push")
        ? { workflow_runs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }
        : { jobs: [{ name: "static", steps: (stepsOf[Number(/runs\/(\d+)\/jobs/.exec(path)![1])] ?? []).map((name) => ({ name })) }] }) as never,
  });
  assert.deepEqual(counted, { examined: 4, MATCH: 1, DIFFER: 1, UNKNOWN: 1, "no dry run": 1 }, "the report counts verdicts from step names alone");

  // 3. The wiring
  const live = yamlWithoutComments(".github/workflows/ci.yml");
  const checks = live.split(/\n {2}(?=[A-Za-z0-9_-]+:\n)/).find((job) => /^ *static:/.test(job));
  assert.ok(checks, "ci.yml has a `static` job");

  assert.match(checks, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}pull-requests: read\n/, "static gains exactly three READ permissions");
  assert.doesNotMatch(checks, /: write\b/, "nothing in static may be granted write");

  assert.match(
    checks,
    /- name: Compute the tree this run tests\n {8}id: tree\n {8}if: github\.event_name == 'pull_request'\n {8}continue-on-error: true\n/,
    "the PR run computes the tree it tests and never fails the job doing so",
  );
  assert.match(
    checks,
    /- name: Tested tree \$\{\{ steps\.tree\.outputs\.sha \}\}\n {8}if: github\.event_name == 'pull_request' && steps\.tree\.outputs\.sha != ''\n {8}continue-on-error: true\n/,
    "the recording step carries the tree in its NAME, on a pull_request only",
  );
  assert.match(
    checks,
    /- name: Tree reuse dry run \(log only\)\n {8}id: reuse\n {8}if: github\.event_name == 'push'\n {8}continue-on-error: true\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node scripts\/ci-tree-reuse\.mjs --dry-run\n/,
    "the dry run is push-only, continue-on-error, and a plain node call",
  );
  assert.match(
    checks,
    /- name: Tree reuse dry run \$\{\{ steps\.reuse\.outputs\.verdict \}\}\n {8}if: github\.event_name == 'push' && steps\.reuse\.outputs\.verdict != ''\n {8}continue-on-error: true\n/,
    "the verdict is spoken as the next step's name",
  );

  // The dry-run pair is the tail of the job: nothing runs after it, so it cannot delay anything.
  const stepNames = [...checks.matchAll(/\n {6}- name: (.+)/g)].map((m) => m[1]);
  assert.deepEqual(
    stepNames.slice(-2),
    ["Tree reuse dry run (log only)", "Tree reuse dry run ${{ steps.reuse.outputs.verdict }}"],
    "the dry-run pair must be the last two steps of static",
  );

  // THE POINT: nothing may decide anything from it. Every mention of the two ids is a step NAME or
  // the single condition that guards the step that names them.
  const readers = live
    .split("\n")
    .filter((line) => /steps\.(?:reuse|tree)\./.test(line))
    .map((line) => line.trim())
    .sort();
  assert.deepEqual(
    readers,
    [
      "- name: Tested tree ${{ steps.tree.outputs.sha }}",
      "- name: Tree reuse dry run ${{ steps.reuse.outputs.verdict }}",
      "if: github.event_name == 'pull_request' && steps.tree.outputs.sha != ''",
      "if: github.event_name == 'push' && steps.reuse.outputs.verdict != ''",
    ].sort(),
    "the verdict and the tree may appear ONLY in step names and the guard of the step that names them, never in a condition that skips or gates real work",
  );

  // The script only ever APPENDS to $GITHUB_OUTPUT: it cannot write a file, a status or a label.
  const script = stripComments(readFileSync("scripts/ci-tree-reuse.mjs", "utf8"));
  assert.doesNotMatch(script, /writeFileSync|rmSync|unlinkSync|renameSync|--method|-X\s+(?:POST|PUT|PATCH|DELETE)/, "the dry run has no write path");
  assert.match(script, /appendFileSync\(process\.env\.GITHUB_OUTPUT/, "its only output channel is $GITHUB_OUTPUT");
}
