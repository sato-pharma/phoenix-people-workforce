import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAVEATS,
  CLASSES,
  NON_VERIFYING_STEPS,
  RECORD_PREFIX,
  REQUIRED_JOBS,
  REUSABLE_JOBS,
  SHADOW_LOG_STEP,
  SHADOW_PREFIX,
  TESTED_TREE_PREFIX,
  buildRecord,
  classify,
  dayIn,
  isNonVerifyingStep,
  parseShadowStep,
  prNumberFromSubject,
  readEnv,
  replay,
  report,
  shadow,
  summaryMarkdown,
  testedTreeFromJobs,
} from "../scripts/ci-tree-reuse.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE TREE-REUSE SHADOW (owner: dry run 2026-10-14; shadow mode 2026-10-26, "observational only ...
 * Any uncertainty means: FULL CI REQUIRED").
 *
 * A push to `main` re-runs `static` and both `unit` jobs on a commit whose tree the PR run very often
 * already tested. This measures how often a reuse WOULD have been safe, in five classes, and changes
 * what runs on `main` by exactly nothing. What this pins, in the order a mistake would hurt:
 *
 *  1. THE CLASSIFIER. ELIGIBLE_FOR_REUSE is the only dangerous output, because a later change could skip
 *     on it. His 14 cases each land in the class he asked for, and a PROPERTY test corrupts or removes
 *     every evidence field of an ELIGIBLE fixture in turn and requires that none of them stays ELIGIBLE:
 *     uncertainty never produces a definitive yes. "SUCCESS is not evidence": a green job whose work
 *     step was skipped or cancelled is SAFETY_CHECK_FAILED.
 *  2. THE READ PATH. `gather` finds the PR through `commits/{sha}/pulls` (squash, rebase and merge
 *     commits alike), reads only with GET, never throws, and a failed read is HISTORICAL_DATA_UNAVAILABLE.
 *  3. THE RECORD. Machine-readable, in the log and the job summary, and never carries a token or the env.
 *  4. NO SWITCH. The script reads a fixed allow-list of GITHUB_* variables and nothing else, has no write
 *     path, no enforcement flag, and always exits 0 — so nothing can turn the measurement into a skip.
 *  5. THE WIRING. The shadow pair is push-only, continue-on-error, the LAST two steps of `static`, its
 *     permissions are read-only, and NO `if:` anywhere reads the class or the tree to decide anything.
 *
 * THE BREAK DIRECTION (2026-10-26): let a skipped work step pass and case 5's step fixture plus the
 * property test fail; drop the Cairo-day check and case 13's Cairo fixture fails; read a new env name
 * and the allow-list assertion names it; add an `if:` on steps.reuse and the reader allow-list fails.
 */

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const SHA = "c".repeat(40);
const PARENT = "d".repeat(40);
const PR_HEAD = "e".repeat(40);
const REPO = "owner/repo";
const FINISHED = "2026-10-26T10:00:00Z";
const NOW = Date.parse("2026-10-26T10:30:00Z");

// Fixtures mirror untyped API JSON and are corrupted leaf by leaf below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const ok = (name: string) => ({ name, status: "completed", conclusion: "success" });
const skipped = (name: string) => ({ name, status: "completed", conclusion: "skipped" });

/** A PR run's jobs as the jobs API returns them for a green run of today's ci.yml. */
function prJobs(): Json[] {
  const timed = (name: string, minutes: number, steps: Json[]) => ({
    name,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    started_at: "2026-10-26T09:50:00Z",
    completed_at: new Date(Date.parse("2026-10-26T09:50:00Z") + minutes * 60000 - 1000).toISOString(),
    steps,
  });
  return [
    timed("validate", 6, [ok("Set up job"), ok("Check out repository"), skipped("Build"), ok("Complete job")]),
    timed("static", 3, [
      ok("Set up job"),
      ok("Check out repository"),
      ok("Compute the tree this run tests"),
      ok(TESTED_TREE_PREFIX + TREE_A),
      ok("Install dependencies"),
      ok("Lint"),
      ok("Typecheck"),
      skipped(SHADOW_LOG_STEP),
      skipped(SHADOW_PREFIX + "${{ steps.reuse.outputs.verdict }}"),
      skipped("Tree reuse dry run (log only)"),
      skipped("Save the pnpm store"),
      skipped("Save ESLint cache"),
      ok("Complete job"),
    ]),
    timed("unit (1)", 3, [ok("Set up job"), ok("Install dependencies"), ok("Test"), ok("Complete job")]),
    timed("unit (2)", 3, [ok("Set up job"), ok("Install dependencies"), ok("Test"), ok("Complete job")]),
    timed("checks", 1, [ok("Set up job"), ok("Complete job")]),
    { name: "mobile", status: "completed", conclusion: "skipped", run_attempt: 1, steps: [] },
  ];
}

/** Evidence {@link classify} must call ELIGIBLE_FOR_REUSE: a squash merge of a same-repo human PR. */
function eligible(): Json {
  return {
    errors: [],
    repo: REPO,
    sha: SHA,
    tree: TREE_A,
    subject: "fix(x): a thing (#6491)",
    parent: PARENT,
    eventName: "push",
    ref: "refs/heads/main",
    workflowRef: `${REPO}/.github/workflows/ci.yml@refs/heads/main`,
    event: { before: PARENT, after: SHA, forced: false },
    now: NOW,
    pulls: [
      {
        number: 6491,
        merged_at: "2026-10-26T10:29:00Z",
        merge_commit_sha: SHA,
        base: { ref: "main" },
        head: { sha: PR_HEAD, repo: { full_name: REPO } },
        user: { login: "Gawish-1997", type: "User" },
      },
    ],
    runs: [
      {
        id: 77,
        event: "pull_request",
        path: ".github/workflows/ci.yml",
        head_sha: PR_HEAD,
        head_repository: { full_name: REPO },
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        created_at: "2026-10-26T09:49:00Z",
        updated_at: FINISHED,
      },
    ],
    jobs: prJobs(),
  };
}

const job = (e: Json, name: string) => e.jobs.find((j: Json) => j.name === name);
const step = (e: Json, jobName: string, stepName: string) => job(e, jobName).steps.find((s: Json) => s.name === stepName);
const decide = (mutate: (e: Json) => void) => {
  const e = eligible();
  mutate(e);
  return classify(e).decision;
};

/** ci.yml with its `#` comment lines removed, so prose that spells a pinned string pins nothing. */
const yamlWithoutComments = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** Every leaf of a JSON value, as a path of keys. */
function leaves(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== "object") return [path];
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value);
  if (entries.length === 0) return [path];
  return entries.flatMap(([k, v]) => leaves(v, [...path, k]));
}

export function runCiTreeReuseDryrunTests() {
  // ── 1. The classifier: his 14 cases ─────────────────────────────────────────────────────────
  assert.deepEqual(CLASSES, ["ELIGIBLE_FOR_REUSE", "NOT_ELIGIBLE", "INSUFFICIENT_EVIDENCE", "SAFETY_CHECK_FAILED", "HISTORICAL_DATA_UNAVAILABLE"]);
  assert.deepEqual(REQUIRED_JOBS, ["validate", "static", "unit (1)", "unit (2)", "checks"]);
  assert.deepEqual(REUSABLE_JOBS, ["static", "unit (1)", "unit (2)"], "validate is required green but is NEVER reusable");

  // 1 · identical trees, every job and work step green (non-verifying steps skipped)
  assert.equal(classify(eligible()).decision, "ELIGIBLE_FOR_REUSE", "case 1: identical tree, green checks");

  // 2 · different trees
  assert.equal(decide((e) => (e.tree = TREE_B)), "NOT_ELIGIBLE", "case 2: main's tree differs from the tested tree");

  // 3 · failed PR checks
  assert.equal(decide((e) => (e.runs[0].conclusion = "failure")), "NOT_ELIGIBLE", "case 3: the PR run failed");
  assert.equal(decide((e) => (job(e, "unit (1)").conclusion = "failure")), "NOT_ELIGIBLE", "case 3: a required job failed under a green run");
  assert.equal(decide((e) => (job(e, "mobile").conclusion = "failure")), "NOT_ELIGIBLE", "case 3: any other job failed");

  // 4 · missing PR checks
  assert.equal(decide((e) => (e.jobs = e.jobs.filter((j: Json) => j.name !== "checks"))), "NOT_ELIGIBLE", "case 4: a required job is missing");
  assert.equal(decide((e) => (job(e, "validate").conclusion = "skipped")), "NOT_ELIGIBLE", "case 4: a skipped required job is not a pass");
  assert.equal(decide((e) => (e.runs = [])), "INSUFFICIENT_EVIDENCE", "case 4: the final head has no CI run at all");
  assert.equal(decide((e) => (e.runs[0].status = "in_progress")), "NOT_ELIGIBLE", "case 4: the PR run has not finished");

  // 5 · cancelled PR checks — and "SUCCESS is not evidence"
  assert.equal(decide((e) => (e.runs[0].conclusion = "cancelled")), "NOT_ELIGIBLE", "case 5: the PR run was cancelled");
  assert.equal(decide((e) => (job(e, "unit (2)").conclusion = "cancelled")), "NOT_ELIGIBLE", "case 5: a required job was cancelled");
  assert.equal(decide((e) => (step(e, "unit (2)", "Test").conclusion = "cancelled")), "SAFETY_CHECK_FAILED", "case 5: a cancelled work step under a green job");
  assert.equal(decide((e) => (step(e, "unit (1)", "Test").conclusion = "skipped")), "SAFETY_CHECK_FAILED", "a skipped work step under a green job: SUCCESS is not evidence");
  assert.equal(decide((e) => (step(e, "static", "Lint").status = "in_progress")), "SAFETY_CHECK_FAILED", "an unfinished work step");
  assert.equal(decide((e) => (job(e, "static").steps = [])), "SAFETY_CHECK_FAILED", "a reusable job that lists no steps");
  assert.equal(decide((e) => (step(e, "validate", "Build").conclusion = "skipped")), "ELIGIBLE_FOR_REUSE", "validate's skipped Build does not matter: validate is never reused");

  // 6 · unavailable data
  assert.equal(decide((e) => (e.errors = ["HTTP 403: rate limit"])), "HISTORICAL_DATA_UNAVAILABLE", "case 6: a failed read");
  assert.equal(decide((e) => (e.jobs = [])), "HISTORICAL_DATA_UNAVAILABLE", "case 6: the jobs are no longer listed");
  assert.equal(decide((e) => (e.pulls = undefined)), "HISTORICAL_DATA_UNAVAILABLE", "case 6: the pull requests are unreadable");
  assert.equal(decide((e) => (e.runs = undefined)), "HISTORICAL_DATA_UNAVAILABLE", "case 6: the runs are unreadable");
  assert.equal(decide((e) => (e.tree = "")), "HISTORICAL_DATA_UNAVAILABLE", "case 6: the local tree is unreadable");
  assert.equal(decide((e) => (e.repo = "")), "HISTORICAL_DATA_UNAVAILABLE");
  assert.equal(decide((e) => (e.event = null)), "HISTORICAL_DATA_UNAVAILABLE", "the push payload is unreadable");
  assert.equal(classify(null).decision, "HISTORICAL_DATA_UNAVAILABLE");

  // 7 · squash merge: the subject's (#N) is a cross-check, never the source
  assert.equal(decide((e) => (e.subject = "fix(x): a thing (#6000)")), "SAFETY_CHECK_FAILED", "case 7: the subject names another PR than the API");
  assert.equal(prNumberFromSubject("fix(x): a thing (#5901)  "), 5901);
  for (const none of ["fix(x): a thing", "fix(x): see (#12) for more", "Merge branch main", "", null, undefined]) {
    assert.equal(prNumberFromSubject(none as string), null, `${JSON.stringify(none)} carries no PR number`);
  }

  // 8 · rebase merge
  assert.equal(decide((e) => (e.subject = "fix(x): the last rebased commit")), "ELIGIBLE_FOR_REUSE", "case 8: a one-commit rebase is decided normally");
  assert.equal(decide((e) => (e.event.before = "f".repeat(40))), "INSUFFICIENT_EVIDENCE", "case 8: a multi-commit rebase moved main by more than one commit");

  // 9 · merge commit: found through the API, not the subject
  assert.equal(decide((e) => (e.subject = "Merge pull request #6491 from owner/codex/x")), "ELIGIBLE_FOR_REUSE", "case 9: a merge commit is decided normally");

  // 10 · direct push
  assert.equal(decide((e) => (e.pulls = [])), "NOT_ELIGIBLE", "case 10: a direct push");

  // 11 · several candidate PRs
  assert.equal(decide((e) => e.pulls.push({ ...e.pulls[0], number: 6492 })), "INSUFFICIENT_EVIDENCE", "case 11: two PRs claim this commit");
  assert.equal(decide((e) => (e.pulls[0].merged_at = null)), "INSUFFICIENT_EVIDENCE", "case 11: only an unmerged PR");
  assert.equal(decide((e) => (e.pulls[0].merge_commit_sha = PARENT)), "INSUFFICIENT_EVIDENCE", "case 11: the PR merged as another commit");

  // 12 · workflow change
  assert.equal(decide((e) => (e.workflowRef = `${REPO}/.github/workflows/other.yml@refs/heads/main`)), "NOT_ELIGIBLE", "case 12: another workflow");
  assert.equal(decide((e) => (e.runs[0].path = ".github/workflows/other.yml")), "SAFETY_CHECK_FAILED", "case 12: the PR run was another workflow");
  assert.equal(decide((e) => (e.tree = TREE_B)), "NOT_ELIGIBLE", "case 12: a workflow edit on main changes the tree");

  // 13 · external state
  assert.ok(CAVEATS.some((c) => /production credentials/.test(c)), "case 13: the non-hermetic unit suite is always a recorded caveat");
  assert.equal(decide((e) => (e.pulls[0].head.repo.full_name = "fork/repo")), "NOT_ELIGIBLE", "case 13: a fork PR");
  assert.equal(decide((e) => (e.pulls[0].user = { login: "dependabot[bot]", type: "Bot" })), "NOT_ELIGIBLE", "case 13: a bot PR");
  assert.equal(decide((e) => (e.pulls[0].user.login = "renovate[bot]")), "NOT_ELIGIBLE", "case 13: a [bot] login");
  assert.equal(decide((e) => (e.now = Date.parse("2026-10-26T22:30:00Z"))), "INSUFFICIENT_EVIDENCE", "case 13: a PR run more than 12 hours old");
  assert.equal(
    decide((e) => {
      e.runs[0].updated_at = "2026-10-26T20:50:00Z"; // Cairo 23:50 on the 26th
      e.now = Date.parse("2026-10-26T21:10:00Z"); //     Cairo 00:10 on the 27th, same UTC day
    }),
    "INSUFFICIENT_EVIDENCE",
    "case 13: the PR run finished on another Cairo day",
  );
  assert.equal(
    decide((e) => {
      e.runs[0].updated_at = "2026-10-26T23:50:00Z";
      e.now = Date.parse("2026-10-27T00:10:00Z"); // same Cairo day, another UTC day
    }),
    "INSUFFICIENT_EVIDENCE",
    "case 13: the PR run finished on another UTC day",
  );
  assert.equal(decide((e) => (e.runs[0].updated_at = "2026-10-26T11:00:00Z")), "INSUFFICIENT_EVIDENCE", "a PR run that finished after the push started");
  assert.equal(dayIn("Africa/Cairo", Date.parse("2026-10-26T21:10:00Z")), "2026-10-27");
  assert.equal(dayIn("Not/AZone", NOW), null, "an unknown zone is null, never a day");

  // 14 · ambiguous evidence
  assert.equal(decide((e) => job(e, "static").steps.push(ok(TESTED_TREE_PREFIX + TREE_B))), "SAFETY_CHECK_FAILED", "case 14: two trees recorded");
  assert.equal(decide((e) => (job(e, "static").steps = job(e, "static").steps.filter((s: Json) => !s.name.startsWith(TESTED_TREE_PREFIX)))), "INSUFFICIENT_EVIDENCE", "case 14: no tree recorded");
  assert.equal(decide((e) => e.jobs.push(prJobs()[2])), "SAFETY_CHECK_FAILED", "case 14: a required job listed twice");
  assert.equal(decide((e) => (job(e, "unit (1)").run_attempt = 2)), "SAFETY_CHECK_FAILED", "case 14: jobs from two attempts");
  assert.equal(decide((e) => delete e.event.forced), "INSUFFICIENT_EVIDENCE", "case 14: whether the push was forced is unknown");
  assert.equal(decide((e) => (e.event.forced = true)), "SAFETY_CHECK_FAILED", "a forced push");
  assert.equal(decide((e) => (e.event.after = PARENT)), "SAFETY_CHECK_FAILED", "the payload's head is not this commit");
  assert.equal(decide((e) => (e.eventName = "pull_request")), "NOT_ELIGIBLE", "not a push");
  assert.equal(decide((e) => (e.ref = "refs/heads/codex/x")), "NOT_ELIGIBLE", "not main");
  assert.equal(decide((e) => (e.runs[0].event = "push")), "SAFETY_CHECK_FAILED", "the newest run on the head is not a PR run");
  assert.equal(decide((e) => (e.runs[0].head_sha = TREE_B)), "SAFETY_CHECK_FAILED", "the run tested another head");
  assert.equal(
    decide((e) => e.runs.push({ ...e.runs[0], id: 78, created_at: "2026-10-26T09:59:00Z", conclusion: "failure" })),
    "NOT_ELIGIBLE",
    "the NEWEST run on the head decides: a later red re-run beats an earlier green one",
  );

  // THE PROPERTY: corrupt or remove any one evidence field of the ELIGIBLE fixture and it is never
  // ELIGIBLE. The only fields allowed not to matter are named here, with why.
  const irrelevant = [
    /^subject$/, //                              a cross-check only; a merge or rebase subject has no (#N)
    /^errors$/, //                               gather always writes an array; a non-array is not an error list
    /^pulls\.0\.user\.login$/, //                only the [bot] suffix matters; type "User" is checked first
    /^runs\.0\.(?:id|created_at)$/, //           ordering between runs only
    /^jobs\.\d+\.(?:started_at|completed_at)$/, // minutes for the estimate, not evidence
    /^jobs\.\d+\.steps\.\d+\.name$/, //          a renamed work step still ran (the tree step is checked below)
    /^jobs\.5\.(?:name|status|steps)$/, //       the skipped `mobile` job: only its conclusion is evidence
    /^jobs\.[04]\.steps\./, //                  validate and checks are judged by their job conclusion: never reused
  ];
  let corrupted = 0;
  for (const path of leaves(eligible())) {
    const key = path.join(".");
    if (irrelevant.some((re) => re.test(key))) continue;
    // A non-verifying step's outcome is not evidence by definition (that list is pinned below).
    const stepAt = /^jobs\.(\d+)\.steps\.(\d+)\.(?:status|conclusion)$/.exec(key);
    if (stepAt && isNonVerifyingStep(eligible().jobs[Number(stepAt[1])].steps[Number(stepAt[2])].name)) continue;
    for (const variant of ["delete", "null", "garbage"] as const) {
      const e = eligible();
      const parent = path.slice(0, -1).reduce((o: Json, k) => o[k], e);
      const last = path[path.length - 1];
      if (variant === "delete") delete parent[last];
      else parent[last] = variant === "null" ? null : "corrupt";
      const { decision } = classify(e);
      assert.notEqual(decision, "ELIGIBLE_FOR_REUSE", `corrupting ${key} (${variant}) must never leave the decision ELIGIBLE`);
      corrupted++;
    }
  }
  assert.ok(corrupted > 150, `the property test must actually corrupt the fixture (${corrupted} variants)`);
  // The tree step's name IS evidence even though other step names are not.
  assert.notEqual(decide((e) => (step(e, "static", TESTED_TREE_PREFIX + TREE_A).name = "corrupt")), "ELIGIBLE_FOR_REUSE");

  // Non-verifying steps: exact names, or a prefix ending in a space — nothing broader.
  assert.ok(NON_VERIFYING_STEPS.includes("Save the pnpm store") && NON_VERIFYING_STEPS.includes("Save ESLint cache"));
  for (const name of ["Compute the tree this run tests", TESTED_TREE_PREFIX + TREE_A, SHADOW_LOG_STEP, "Tree reuse dry run MATCH", "Save the pnpm store"]) {
    assert.equal(isNonVerifyingStep(name), true, `${name} verifies nothing`);
  }
  for (const name of ["Test", "Lint", "Typecheck", "Install dependencies", "Save the pnpm store and run tests", "Tested", "Set up job", ""]) {
    assert.equal(isNonVerifyingStep(name), false, `${name} is a work step`);
  }

  // Tree reading (also from a pre-2026-10-19 run that recorded it in `checks`)
  assert.equal(testedTreeFromJobs([{ name: "checks", steps: [{ name: TESTED_TREE_PREFIX + TREE_A }] }]), TREE_A);
  assert.equal(testedTreeFromJobs([{ name: "validate", steps: [{ name: TESTED_TREE_PREFIX + TREE_A }] }]), null, "only static (or older checks) counts");
  assert.equal(testedTreeFromJobs([{ name: "static", steps: [{ name: TESTED_TREE_PREFIX + "not-a-sha" }] }]), null);
  assert.equal(testedTreeFromJobs(null as never), null);

  // ── 2. The read path ─────────────────────────────────────────────────────────────────────────
  const git = (tree: string, subject: string) => (_file: string, args: string[]) => {
    if (args[0] === "log") return subject + "\n";
    if (String(args[1]).endsWith("^{tree}")) return tree + "\n";
    if (String(args[1]).endsWith("^1")) return PARENT + "\n";
    return SHA + "\n";
  };
  const fixture = eligible();
  const PULLS = `repos/${REPO}/commits/${SHA}/pulls`;
  const RUNS = `repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${PR_HEAD}&per_page=10`;
  const JOBS = `repos/${REPO}/actions/runs/77/jobs?filter=latest&per_page=100`;
  const seen: string[] = [];
  const world = (overrides: Record<string, unknown> = {}) => (path: string) => {
    seen.push(path);
    const table: Record<string, unknown> = { [PULLS]: fixture.pulls, [RUNS]: { workflow_runs: fixture.runs }, [JOBS]: { jobs: fixture.jobs }, ...overrides };
    if (!(path in table)) throw new Error("unexpected read " + path);
    const value = table[path];
    if (value instanceof Error) throw value;
    return value;
  };
  const ctx = { repo: REPO, sha: SHA, eventName: "push", ref: "refs/heads/main", workflowRef: fixture.workflowRef, event: fixture.event, now: NOW, runId: "900", runAttempt: "1" };
  const live = (subject: string, readGh = world(), tree = TREE_A) => shadow({ ctx, readGit: git(tree, subject) as never, readGh: readGh as never });

  const squash = live("fix(x): a thing (#6491)");
  assert.equal(squash.result.decision, "ELIGIBLE_FOR_REUSE", "end to end: a squash merge with an identical tree");
  assert.equal(squash.record.api_calls, 3, "three GET reads, the same count as the 14 Oct dry run");
  assert.equal(squash.record.estimated_avoidable_minutes, 9, "static 3 + unit 3 + unit 3, an estimate from the PR run");
  assert.equal(live("Merge pull request #6491 from owner/codex/x").result.decision, "ELIGIBLE_FOR_REUSE", "end to end: a merge commit");
  assert.equal(live("fix(x)", world(), TREE_B).record.estimated_avoidable_minutes, 0, "minutes are counted only when ELIGIBLE");
  assert.equal(live("fix(x)", world({ [PULLS]: [] })).result.decision, "NOT_ELIGIBLE", "end to end: a direct push");
  const boom = live("fix(x)", world({ [PULLS]: new Error("HTTP 403: rate limit\nmore") }));
  assert.equal(boom.result.decision, "HISTORICAL_DATA_UNAVAILABLE", "a failed API read");
  assert.doesNotMatch(boom.result.reason, /\n/, "the reason is one line");
  assert.equal(
    shadow({ ctx, readGit: (() => { throw new Error("no git"); }) as never, readGh: world() as never }).result.decision,
    "HISTORICAL_DATA_UNAVAILABLE",
    "a failing git read never throws",
  );
  assert.equal(live("fix(x)", world({ [JOBS]: { jobs: [] } })).result.decision, "HISTORICAL_DATA_UNAVAILABLE", "expired jobs");
  assert.ok(seen.every((p) => !/[?&]method=|\/dispatches|\/rerun|\/cancel/.test(p)), "every read is a plain GET path");

  // ── 3. The record ────────────────────────────────────────────────────────────────────────────
  const rec = squash.record;
  for (const key of ["run_id", "run_attempt", "commit", "tree", "workflow_ref", "pr", "pr_head", "pr_run_id", "pr_run_attempt", "tested_tree", "check_conclusions", "validate_reuse", "decision", "reason", "caveats", "detector_ms", "api_calls", "estimated_avoidable_minutes"]) {
    assert.ok(key in rec, `the record carries ${key}`);
  }
  assert.equal(rec.skipping_active, false, "the record says skipping is off");
  assert.match(rec.validate_reuse, /^never/, "validate is reported separately and never reused");
  const text = JSON.stringify(rec) + summaryMarkdown(rec);
  assert.doesNotMatch(text, /token|GH_TOKEN|ghp_|ghs_|authorization|PATH=/i, "the record and summary carry no token, header or env");
  assert.match(summaryMarkdown(rec), /OFF — shadow mode, nothing was skipped/);
  assert.equal(RECORD_PREFIX, "tree-reuse-shadow-record ");
  assert.equal(buildRecord({}, { decision: "HISTORICAL_DATA_UNAVAILABLE", reason: "x" }).estimated_avoidable_minutes, 0, "an empty record still builds");

  // ── 4. No switch ─────────────────────────────────────────────────────────────────────────────
  const script = stripComments(readFileSync("scripts/ci-tree-reuse.mjs", "utf8"));
  assert.equal((script.match(/process\.env/g) ?? []).length, 1, "process.env is read in exactly one place: readEnv's default");
  const ALLOWED = ["GITHUB_REPOSITORY", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_WORKFLOW_REF", "GITHUB_EVENT_PATH", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"];
  const read = [...script.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(read)].filter((name) => !ALLOWED.includes(name)), [], "the script reads only the GITHUB_* allow-list");
  assert.deepEqual(Object.keys(readEnv({ GITHUB_REPOSITORY: "x", TREE_REUSE_ENFORCE: "1" } as never)).sort(), ["eventName", "eventPath", "output", "ref", "repo", "runAttempt", "runId", "summary", "workflowRef"].sort());
  assert.doesNotMatch(script, /writeFileSync|rmSync|unlinkSync|renameSync|--method|-X\s+(?:POST|PUT|PATCH|DELETE)|"-f"|--field|--input/, "no write path");
  assert.doesNotMatch(script, /enforce|activate/i, "no enforcement mode of any name");
  assert.deepEqual([...script.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1]), ["0"], "it always exits 0");
  assert.equal((script.match(/Date\.now\(\)/g) ?? []).length, 1, "the only clock read is the push's own 'now' (no date that switches anything on)");
  assert.match(script, /appendFileSync\(env\.output/, "its outputs are $GITHUB_OUTPUT and the job summary");

  // ── Reporting and backtest, read-only ───────────────────────────────────────────────────────
  assert.deepEqual(parseShadowStep(SHADOW_PREFIX + "ELIGIBLE_FOR_REUSE ~8 min"), { decision: "ELIGIBLE_FOR_REUSE", minutes: 8 });
  assert.deepEqual(parseShadowStep(SHADOW_PREFIX + "NOT_ELIGIBLE ~0 min"), { decision: "NOT_ELIGIBLE", minutes: 0 });
  assert.equal(parseShadowStep(SHADOW_LOG_STEP), null);
  assert.equal(parseShadowStep(SHADOW_PREFIX + "MAYBE ~3 min"), null, "an unknown word is not a class");

  const pushJobs: Record<number, Json[]> = {
    1: [{ name: "static", conclusion: "success", steps: [{ name: SHADOW_LOG_STEP, conclusion: "success", started_at: "2026-10-26T10:00:00Z", completed_at: "2026-10-26T10:00:02Z" }, { name: SHADOW_PREFIX + "ELIGIBLE_FOR_REUSE ~8 min" }] }, { name: "unit (1)", conclusion: "success" }, { name: "unit (2)", conclusion: "success" }],
    2: [{ name: "static", conclusion: "success", steps: [{ name: SHADOW_PREFIX + "ELIGIBLE_FOR_REUSE ~8 min" }] }, { name: "unit (1)", conclusion: "failure" }, { name: "unit (2)", conclusion: "success" }],
    3: [{ name: "static", steps: [{ name: SHADOW_PREFIX + "NOT_ELIGIBLE ~0 min" }] }],
    4: [{ name: "static", steps: [{ name: "Tree reuse dry run MATCH" }] }],
    5: [{ name: "static", steps: [{ name: "Install" }] }],
  };
  const counted = report(5, {
    repo: REPO,
    readGh: ((path: string) =>
      path.includes("/runs?event=push")
        ? { workflow_runs: [1, 2, 3, 4, 5].map((id) => ({ id, status: "completed", conclusion: id === 2 ? "failure" : "success" })) }
        : { jobs: pushJobs[Number(/runs\/(\d+)\/jobs/.exec(path)![1])] }) as never,
  });
  assert.equal(counted.classes.ELIGIBLE_FOR_REUSE, 2);
  assert.equal(counted.classes.NOT_ELIGIBLE, 1);
  assert.equal(counted.legacy.MATCH, 1, "the 14 Oct dry run's words are counted apart");
  assert.equal(counted["no shadow"], 1);
  assert.deepEqual(counted.false_eligible_runs, [2], "ELIGIBLE while the push run's own unit job failed is listed as false-eligible");
  assert.equal(counted.estimated_avoidable_minutes, 16);
  assert.deepEqual(counted.shadow_step_seconds, { n: 1, median: 2, max: 2 });

  const replayed = replay(1, {
    repo: REPO,
    readGit: git(TREE_A, "fix(x): a thing (#6491)") as never,
    readGh: ((path: string) => {
      if (path.includes("/runs?event=push")) return { workflow_runs: [{ id: 900, head_sha: SHA, run_started_at: "2026-10-26T10:30:00Z", status: "completed", conclusion: "success", run_attempt: 1 }, { id: 899, head_sha: PARENT }] };
      if (path === `repos/${REPO}/actions/runs/900/jobs?filter=latest&per_page=100`) return { jobs: prJobs() };
      return world()(path);
    }) as never,
  });
  assert.equal(replayed.classes.ELIGIBLE_FOR_REUSE, 1, "replay rebuilds the push context from history and classifies it");
  assert.deepEqual(replayed.false_eligible, [], "and checks each ELIGIBLE one against its own push run");

  // ── 5. The wiring ────────────────────────────────────────────────────────────────────────────
  const yaml = yamlWithoutComments(".github/workflows/ci.yml");
  const jobsOf = yaml.split(/\n {2}(?=[A-Za-z0-9_-]+:\n)/);
  const staticJob = jobsOf.find((j) => /^ *static:/.test(j));
  const unitJob = jobsOf.find((j) => /^ *unit:/.test(j));
  assert.ok(staticJob && unitJob, "ci.yml has `static` and `unit` jobs");

  assert.match(staticJob, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}pull-requests: read\n/, "static keeps exactly three READ permissions");
  assert.doesNotMatch(staticJob, /: write\b/, "nothing in static may be granted write");
  assert.match(
    staticJob,
    /- name: Compute the tree this run tests\n {8}id: tree\n {8}if: github\.event_name == 'pull_request'\n {8}continue-on-error: true\n/,
    "the PR run computes the tree it tests and never fails the job doing so",
  );
  assert.match(
    staticJob,
    /- name: Tested tree \$\{\{ steps\.tree\.outputs\.sha \}\}\n {8}if: github\.event_name == 'pull_request' && steps\.tree\.outputs\.sha != ''\n {8}continue-on-error: true\n/,
    "the recording step carries the tree in its NAME, on a pull_request only",
  );
  assert.match(
    staticJob,
    /- name: Tree reuse shadow \(log only\)\n {8}id: reuse\n {8}if: github\.event_name == 'push'\n {8}continue-on-error: true\n {8}timeout-minutes: 2\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node scripts\/ci-tree-reuse\.mjs --dry-run\n/,
    "the shadow is push-only, continue-on-error, capped at two minutes, and a plain node call",
  );
  const NAME_STEP = "Tree reuse shadow ${{ steps.reuse.outputs.verdict }} ~${{ steps.reuse.outputs.minutes }} min";
  assert.ok(
    staticJob.includes(`- name: ${NAME_STEP}\n        if: github.event_name == 'push' && steps.reuse.outputs.verdict != ''\n        continue-on-error: true\n`),
    "the class is spoken as the next step's name",
  );
  const stepNames = [...staticJob.matchAll(/\n {6}- name: (.+)/g)].map((m) => m[1]);
  assert.deepEqual(stepNames.slice(-2), ["Tree reuse shadow (log only)", NAME_STEP], "the shadow pair must be the last two steps of static");

  // THE POINT: nothing may decide anything from it.
  const readers = yaml
    .split("\n")
    .filter((line) => /steps\.(?:reuse|tree)\./.test(line))
    .map((line) => line.trim())
    .sort();
  assert.deepEqual(
    readers,
    [
      "- name: Tested tree ${{ steps.tree.outputs.sha }}",
      `- name: ${NAME_STEP}`,
      "if: github.event_name == 'pull_request' && steps.tree.outputs.sha != ''",
      "if: github.event_name == 'push' && steps.reuse.outputs.verdict != ''",
    ].sort(),
    "the class and the tree may appear ONLY in step names and the guard of the step that names them, never in a condition that skips or gates real work",
  );

  // A PR run of a reusable job must run every work step a push runs: the only event conditions allowed
  // in static and unit are the recording and shadow steps and cache SAVES named as non-verifying.
  const SHADOW_STEPS = ["Compute the tree this run tests", "Tested tree ${{ steps.tree.outputs.sha }}", "Tree reuse shadow (log only)", NAME_STEP];
  for (const [label, body] of [["static", staticJob], ["unit", unitJob]] as const) {
    for (const block of body.split(/\n {6}- (?=name: )/).slice(1)) {
      if (!/github\.event_name/.test(block)) continue;
      const name = /^name: (.+)/.exec(block)![1];
      const allowed = SHADOW_STEPS.includes(name) || (/uses: actions\/cache\/save@/.test(block) && isNonVerifyingStep(name));
      assert.ok(allowed, `${label}'s step "${name}" depends on the event, so a PR run of a reusable job would not prove what a push run does — the shadow would call a partial run complete`);
    }
  }
}
