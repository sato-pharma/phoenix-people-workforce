import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAVEATS,
  CLASSES,
  NON_VERIFYING_STEPS,
  OBSERVATION_WINDOW,
  RECORD_PREFIX,
  ReadFailure,
  REQUIRED_JOBS,
  REUSABLE_JOBS,
  SEARCH_CAP,
  SHADOW_LOG_STEP,
  SHADOW_PREFIX,
  TESTED_TREE_PREFIX,
  buildRecord,
  classify,
  dayIn,
  failureKind,
  isNonVerifyingStep,
  isoSecond,
  makeReader,
  nextLink,
  parseShadowStep,
  prNumberFromSubject,
  readEnv,
  replay,
  report,
  shadow,
  summaryMarkdown,
  testedTreeFromJobs,
  zonedLabel,
  zonedToUtc,
  zoneOffsetMs,
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
  assert.equal((script.match(/Date\.now\(\)/g) ?? []).length, 1, "the only wall-clock read is wallClock: the push's own 'now' and how far the report's window has run (no date that switches anything on)");
  assert.match(script, /appendFileSync\(env\.output/, "its outputs are $GITHUB_OUTPUT and the job summary");

  // ── Reporting and backtest, read-only ───────────────────────────────────────────────────────
  assert.deepEqual(parseShadowStep(SHADOW_PREFIX + "ELIGIBLE_FOR_REUSE ~8 min"), { decision: "ELIGIBLE_FOR_REUSE", minutes: 8 });
  assert.deepEqual(parseShadowStep(SHADOW_PREFIX + "NOT_ELIGIBLE ~0 min"), { decision: "NOT_ELIGIBLE", minutes: 0 });
  assert.equal(parseShadowStep(SHADOW_LOG_STEP), null);
  assert.equal(parseShadowStep(SHADOW_PREFIX + "MAYBE ~3 min"), null, "an unknown word is not a class");

  // ── Reporting: EVERY push run of the observation window, or it says it is not complete ────────────
  // (owner, 2026-10-26: "retrieve, analyze, and account for EVERY relevant main push across the entire
  // 14-day observation period" — split around the 1,000-result cap, dedupe by id, fail closed.)
  const START = Date.parse("2026-10-26T02:12:00Z");
  const END = Date.parse("2026-11-09T03:12:00Z");
  const AFTER_END = END + 3600_000;
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  const headOf = (id: number) => id.toString(16).padStart(40, "0");
  const pushRun = (id: number, createdMs: number, extra: Json = {}): Json => ({
    id, run_attempt: 1, head_sha: headOf(id), created_at: iso(createdMs), run_started_at: iso(createdMs), status: "completed", conclusion: "success",
    event: "push", head_branch: "main", path: ".github/workflows/ci.yml", ...extra,
  });
  const spread = (n: number, from = START, to = END) => Array.from({ length: n }, (_, i) => pushRun(i + 1, from + Math.floor((((to - from) / n) * i) / 1000) * 1000));
  const verdictJobs = (word = "NOT_ELIGIBLE ~0 min"): Json[] => [{ name: "static", conclusion: "success", steps: [{ name: SHADOW_PREFIX + word }] }];
  const pushEvent = (r: Json): Json => ({ id: `e${r.id}`, activity_type: "push", after: r.head_sha, timestamp: r.created_at });
  const BEFORE_START = { id: "older", activity_type: "push", after: "f".repeat(40), timestamp: "2026-10-25T00:00:00Z" };
  const byNewest = (a: Json, b: Json) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;

  /** A fake GitHub: the run list honours `created=A..B` (inclusive, to the second) and counts distinct ids. */
  type Fake = { runs: Json[]; jobs?: (id: number) => Json[] | Error; events?: Json[]; fault?: (path: string, nth: number) => Error | null; listing?: (path: string, page: Json) => Json; resetAt?: number };
  const fakeGitHub = (o: Fake) => {
    const calls: string[] = [];
    const events = (o.events ?? [...o.runs.map(pushEvent), BEFORE_START]).slice().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const readGh = (path: string, options?: { include?: boolean }) => {
      calls.push(path);
      const failure = o.fault?.(path, calls.filter((p) => p === path).length);
      if (failure) throw failure;
      if (path === "rate_limit") return { resources: { core: { reset: Math.floor((o.resetAt ?? 0) / 1000) } } };
      if (path === `repos/${REPO}`) return { created_at: "2020-01-01T00:00:00Z" };
      const activity = /^repos\/owner\/repo\/activity\?ref=refs\/heads\/main&per_page=100(?:&after=(\d+))?$/.exec(path);
      if (activity) {
        assert.equal(options?.include, true, "the activity list is read with its headers, for the cursor");
        const from = Number(activity[1] ?? 0);
        return { body: events.slice(from, from + 100), next: from + 100 < events.length ? `repos/${REPO}/activity?ref=refs/heads/main&per_page=100&after=${from + 100}` : null };
      }
      const list = /^repos\/owner\/repo\/actions\/workflows\/ci\.yml\/runs\?event=push&branch=main&per_page=100&page=(\d+)&created=([0-9TZ:-]+)\.\.([0-9TZ:-]+)$/.exec(path);
      if (list) {
        const page = Number(list[1]);
        const [a, b] = [Date.parse(list[2]), Date.parse(list[3])];
        const hit = o.runs.filter((r) => Date.parse(r.created_at) >= a && Date.parse(r.created_at) <= b).sort(byNewest);
        const result = page > 10 ? { total_count: 0, workflow_runs: [] } : { total_count: new Set(hit.map((r) => r.id)).size, workflow_runs: hit.slice((page - 1) * 100, page * 100) };
        return o.listing ? o.listing(path, result) : result;
      }
      const jobsPath = /^repos\/owner\/repo\/actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100$/.exec(path);
      if (jobsPath) {
        const jobs = (o.jobs ?? (() => verdictJobs()))(Number(jobsPath[1]));
        if (jobs instanceof Error) throw jobs;
        return { total_count: jobs.length, jobs };
      }
      throw new Error("unexpected read " + path);
    };
    return { readGh, calls };
  };
  const slept: number[] = [];
  const windowReport = (fake: ReturnType<typeof fakeGitHub>, clock = AFTER_END): Json => {
    slept.length = 0;
    return report(null, { repo: REPO, readGh: fake.readGh as never, sleep: ((ms: number) => void slept.push(ms)) as never, clock: () => clock });
  };
  const failing = (r: Json) => r.completeness_evidence.filter((c: Json) => !c.ok);

  // The window is Cairo wall-clock time, converted by the time-zone database — Cairo leaves summer time inside it.
  assert.deepEqual(OBSERVATION_WINDOW, { zone: "Africa/Cairo", start: "2026-10-26T05:12", end: "2026-11-09T05:12" });
  assert.equal(zonedToUtc(OBSERVATION_WINDOW.start, "Africa/Cairo"), START, "05:12 Cairo on 26 Oct is 02:12 UTC (summer time, UTC+3)");
  assert.equal(zonedToUtc(OBSERVATION_WINDOW.end, "Africa/Cairo"), END, "05:12 Cairo on 9 Nov is 03:12 UTC (winter time, UTC+2) — never assume Cairo stays UTC+3");
  assert.equal((END - START) / 3600_000, 337, "the window is 337 hours: Cairo's clock goes back an hour on 30 Oct");
  assert.equal(zonedLabel(Date.parse("2026-10-29T20:59:59Z")), "2026-10-29 23:59:59 Africa/Cairo (UTC+03:00)");
  assert.equal(zonedLabel(Date.parse("2026-10-29T21:00:00Z")), "2026-10-29 23:00:00 Africa/Cairo (UTC+02:00)", "the hour before midnight on 29 Oct happens twice");
  assert.throws(() => zonedToUtc("2026-10-29T23:30", "Africa/Cairo"), /happens twice/, "an ambiguous wall-clock time is refused, never guessed");
  assert.throws(() => zonedToUtc("2026-03-08T02:30", "America/New_York"), /does not happen/, "a skipped wall-clock time is refused");
  assert.equal(zoneOffsetMs("Africa/Cairo", START), 3 * 3600_000);
  assert.equal(zoneOffsetMs("Africa/Cairo", END), 2 * 3600_000);
  assert.equal(isoSecond(START + 999), "2026-10-26T02:12:00Z");

  // Run counts 0, 1, 99, 100, 101, 500, 1,000 and past the cap: every run examined, none twice.
  for (const n of [0, 1, 99, 100, 101, 500, 1000, 1001, 2500]) {
    const r = windowReport(fakeGitHub({ runs: spread(n) }));
    assert.equal(r.mode, "observation window");
    assert.equal(r.status, "COMPLETE_OBSERVATION", `${n} runs: ${JSON.stringify(failing(r))}`);
    assert.equal(r.verified_complete, true, `${n} runs: verified complete`);
    assert.equal(r.examined, n, `${n} runs: every one is examined`);
    assert.equal(r.classes.NOT_ELIGIBLE, n, `${n} runs: every one is counted once`);
    assert.deepEqual(r.retrieval.gaps, [], `${n} runs: no gap`);
    assert.equal(r.pushes.main_push_events, n, `${n} runs: every push to main is reconciled`);
    assert.equal(r.reconciliation.push_events_matched_to_a_run, n);
    assert.equal(r.window.hours_total, 337);
    if (n > SEARCH_CAP) assert.ok(r.retrieval.range_splits > 0, `${n} runs: past the ${SEARCH_CAP}-result cap the range is split`);
    else assert.equal(r.retrieval.range_splits, 0, `${n} runs: within the cap, one range`);
  }
  {
    const fake = fakeGitHub({ runs: spread(2500) });
    const r = windowReport(fake);
    assert.equal(r.api.requests, fake.calls.length, "the report counts every request it made");
    assert.ok(r.api.requests < 2500 + 100, `2,500 runs cost one jobs read each plus the listing: ${r.api.requests}`);
    assert.ok(fake.calls.every((p) => !/[?&]page=(?:1[1-9]|[2-9]\d)\b/.test(p)), "no listing reads past page 10, where GitHub silently returns nothing");
  }

  // More than 1,000 runs in one second cannot be split: that range is a named gap, never a complete report.
  {
    const r = windowReport(fakeGitHub({ runs: Array.from({ length: 1001 }, (_, i) => pushRun(i + 1, START + 3600_000)) }));
    assert.equal(r.status, "INCOMPLETE_RETRIEVAL");
    assert.equal(r.verified_complete, false);
    assert.equal(r.examined, 1000, "what could be read is kept");
    assert.equal(r.retrieval.gaps.length, 1);
    assert.match(r.retrieval.gaps[0].reason, /one second/);
    assert.equal(r.retrieval.gaps[0].from, "2026-10-26 06:12:00 Africa/Cairo (UTC+03:00)", "a gap is named in Cairo time");
    assert.equal(r.eligibility.definitive, false);
  }

  // The window's edges: start-inclusive, end-exclusive, to the second.
  {
    const fake = fakeGitHub({ runs: [pushRun(1, START - 1000), pushRun(2, START), pushRun(3, END - 1000), pushRun(4, END)] });
    const r = windowReport(fake);
    assert.equal(r.status, "COMPLETE_OBSERVATION", JSON.stringify(failing(r)));
    assert.equal(r.examined, 2, "only the runs at the start and one second before the end");
    assert.ok(fake.calls.some((p) => p.endsWith("&created=2026-10-26T02:12:00Z..2026-11-09T03:11:59Z")), "the query asks for the start through one second before the end");
    assert.equal(r.window.start, "2026-10-26 05:12:00 Africa/Cairo (UTC+03:00)");
    assert.equal(r.window.end, "2026-11-09 05:12:00 Africa/Cairo (UTC+02:00)");
    assert.equal(r.window.bounds, "start-inclusive, end-exclusive");
  }
  {
    const r = windowReport(fakeGitHub({ runs: [pushRun(1, START), pushRun(2, START + 60_000, { event: "workflow_dispatch" }), pushRun(3, START + 120_000, { head_branch: "master" }), pushRun(4, START + 180_000, { path: ".github/workflows/other.yml" })] }));
    assert.equal(r.examined, 1, "a run the API returned that is not a ci.yml push to main is filtered out");
    assert.deepEqual(r.retrieval.dropped_by_local_filter, { outside_range: 0, not_push: 1, not_main: 1, other_workflow: 1 }, "and counted, never silently");
  }

  // A window still open: the hours not yet observed are future time, never missing data.
  {
    const r = windowReport(fakeGitHub({ runs: spread(337) }), START + 50 * 3600_000);
    assert.equal(r.status, "PARTIAL_OBSERVATION", JSON.stringify(failing(r)));
    assert.equal(r.verified_complete, true, "what has been observed so far is complete");
    assert.equal(r.coverage.observation, "partial — the window is still open");
    assert.equal(r.window.hours_not_yet_observed, Math.round((337 - r.window.hours_observed) * 100) / 100);
    assert.ok(r.window.hours_observed > 49.9 && r.window.hours_observed < 50, "it reads up to five minutes ago");
    assert.match(r.window.note, /not missing data/);
    assert.deepEqual(r.retrieval.gaps, [], "the future is not a gap");
    assert.deepEqual(r.pushes.missing_or_unavailable, { jobs_expired: [], jobs_unread: [], pushes_without_ci_run: 0 });
    assert.equal(r.eligibility.definitive, false, "no eligibility share is definitive before the window ends");
    assert.ok(r.examined > 0 && r.examined < 337);
  }
  {
    const r = windowReport(fakeGitHub({ runs: [] }), START - 3600_000);
    assert.equal(r.status, "PARTIAL_OBSERVATION", "before the window opens nothing is missing");
    assert.equal(r.window.hours_observed, 0);
  }

  // Duplicates and multiple attempts: one run, its highest attempt; reruns counted apart.
  {
    const runs = [pushRun(1, START + 60_000), pushRun(2, START + 120_000), pushRun(2, START + 120_000, { run_attempt: 3, conclusion: "failure" }), pushRun(3, START + 180_000, { run_attempt: 2 })];
    const r = windowReport(fakeGitHub({ runs, events: [pushEvent(runs[0]), pushEvent(runs[1]), pushEvent(runs[3]), BEFORE_START] }));
    assert.equal(r.status, "COMPLETE_OBSERVATION", JSON.stringify(failing(r)));
    assert.equal(r.examined, 3, "an id listed twice is one run");
    assert.equal(r.retrieval.duplicates_merged, 1);
    assert.equal(r.pushes.failed_or_cancelled_runs, 1, "the highest attempt is the one kept");
    assert.equal(r.pushes.rerun_runs, 2);
    assert.equal(r.pushes.extra_attempts, 3);
  }
  {
    let lastOfFirstPage: Json = {};
    const r = windowReport(fakeGitHub({
      runs: spread(150),
      listing: (path, page) => {
        if (/&page=1&/.test(path)) lastOfFirstPage = page.workflow_runs.at(-1);
        return /&page=2&/.test(path) ? { ...page, workflow_runs: [lastOfFirstPage, ...page.workflow_runs] } : page;
      },
    }));
    assert.equal(r.examined, 150, "a run that slides onto the next page is counted once");
    assert.equal(r.retrieval.duplicates_merged, 1);
    assert.equal(r.status, "COMPLETE_OBSERVATION");
  }
  {
    let shifted = false;
    const r = windowReport(fakeGitHub({
      runs: spread(150),
      listing: (path, page) => {
        if (!/&page=2&/.test(path) || shifted) return page;
        shifted = true;
        return { ...page, workflow_runs: page.workflow_runs.slice(1) };
      },
    }));
    assert.equal(r.examined, 150, "a run lost between pages is caught by the count and read again");
    assert.deepEqual(r.retrieval.gaps, []);
  }

  // Missing verdicts: told apart from verdicts, and an unfinished run from a finished one.
  {
    const runs = [pushRun(1, START + 60_000), pushRun(2, START + 120_000), pushRun(3, START + 180_000), pushRun(4, START + 240_000, { status: "in_progress", conclusion: null })];
    const jobs: Record<number, Json[]> = { 1: verdictJobs("ELIGIBLE_FOR_REUSE ~8 min"), 2: [{ name: "static", steps: [{ name: "Tree reuse dry run MATCH" }] }], 3: [{ name: "static", steps: [{ name: "Install" }] }], 4: [{ name: "static", steps: [] }] };
    const r = windowReport(fakeGitHub({ runs, jobs: (id) => jobs[id] }));
    assert.equal(r.pushes.push_runs, 4);
    assert.equal(r.pushes.with_shadow_verdict, 1);
    assert.deepEqual(r.pushes.without_shadow_verdict, { total: 3, legacy_dry_run_word: 1, no_verdict_step_finished_run: 1, no_verdict_step_yet_in_progress: 1 });
    assert.equal(r.pushes.eligible, 1);
    assert.equal(r.pushes.in_progress_runs, 1);
    assert.equal(r.eligibility.pct, 100);
  }

  // Pagination failures: retried, kept, named — the report never throws and never claims completeness.
  {
    const r = windowReport(fakeGitHub({ runs: spread(150), fault: (p, nth) => (/&page=2&/.test(p) && nth === 1 ? new Error("HTTP 502: Bad Gateway") : null) }));
    assert.equal(r.status, "COMPLETE_OBSERVATION", "a transient failure is retried");
    assert.deepEqual(slept, [2000]);
    assert.equal(r.api.retries, 1);
  }
  {
    const r = windowReport(fakeGitHub({ runs: spread(150), fault: (p) => (/&page=2&/.test(p) ? new Error("HTTP 422: Validation Failed") : null) }));
    assert.equal(r.status, "INCOMPLETE_RETRIEVAL");
    assert.equal(r.verified_complete, false);
    assert.equal(r.coverage.retrieval, "incomplete");
    assert.equal(r.examined, 100, "the first page is kept");
    assert.equal(r.retrieval.gaps.length, 1);
    assert.match(r.retrieval.gaps[0].reason, /could not be read: HTTP 422/);
    assert.equal(r.retrieval.gaps[0].to_utc, "2026-11-09T03:12:00Z");
  }
  {
    const r = windowReport(fakeGitHub({ runs: spread(5), listing: (_p, page) => ({ workflow_runs: page.workflow_runs }) }));
    assert.equal(r.status, "INCOMPLETE_RETRIEVAL", "a listing with no total_count cannot prove it is whole");
    assert.match(r.retrieval.gaps[0].reason, /total_count/);
  }
  {
    const r = windowReport(fakeGitHub({ runs: spread(5), jobs: (id) => (id === 3 ? new Error("HTTP 404: Not Found") : verdictJobs()) }));
    assert.equal(r.status, "EVIDENCE_UNAVAILABLE", "expired jobs are unavailable evidence, not a retrieval failure");
    assert.deepEqual(r.historical_evidence.jobs_expired, [3]);
    assert.equal(r.coverage.historical_evidence, "partly unavailable");
  }
  {
    const r = windowReport(fakeGitHub({ runs: spread(5), jobs: (id) => (id === 3 ? new Error("HTTP 422: nope") : verdictJobs()) }));
    assert.equal(r.status, "INCOMPLETE_RETRIEVAL");
    assert.deepEqual(r.retrieval.jobs_unread, [3]);
  }
  {
    const r = windowReport(fakeGitHub({ runs: spread(5), fault: (p) => (p.includes("/activity?") ? new Error("HTTP 422: nope") : null) }));
    assert.equal(r.status, "INCOMPLETE_RETRIEVAL", "an unread push record is an incomplete retrieval");
  }
  {
    const runs = spread(5);
    const r = windowReport(fakeGitHub({ runs, events: runs.map(pushEvent) }));
    assert.equal(r.status, "EVIDENCE_UNAVAILABLE", "a push record that ends before the window's start cannot prove every push was seen");
    assert.equal(r.reconciliation.reaches_start, false);
  }
  {
    const runs = spread(5);
    const lone = { id: "lone", activity_type: "pr_merge", after: "9".repeat(40), timestamp: iso(START + 100 * 3600_000) };
    const edge = { id: "edge", activity_type: "push", after: "8".repeat(40), timestamp: iso(END - 60_000) };
    const r = windowReport(fakeGitHub({ runs, events: [...runs.map(pushEvent), lone, edge, BEFORE_START] }));
    assert.equal(r.status, "EVIDENCE_UNAVAILABLE", "a push to main with no CI run is named");
    assert.equal(r.reconciliation.pushes_without_ci_run.length, 1);
    assert.equal(r.reconciliation.pushes_without_ci_run[0].type, "pr_merge");
    assert.equal(r.reconciliation.near_window_edge.length, 1, "a push a minute before the end is labelled near the edge, not missing");
    assert.equal(r.pushes.main_push_events, 7);
  }

  // Rate limits: waited out within fifteen minutes; past that the report stops, keeps what it read and says so.
  {
    const r = windowReport(fakeGitHub({ runs: spread(5), fault: (p, nth) => (p.includes("&page=1&") && nth === 1 ? new Error("HTTP 403: You have exceeded a secondary rate limit") : null) }));
    assert.equal(r.status, "COMPLETE_OBSERVATION");
    assert.deepEqual(slept, [60_000]);
    assert.equal(r.api.rate_limit_waits, 1);
  }
  {
    const r = windowReport(fakeGitHub({ runs: spread(5), resetAt: AFTER_END + 30_000, fault: (p, nth) => (p.includes("&page=1&") && nth === 1 ? new Error("HTTP 403: API rate limit exceeded for user ID 1") : null) }));
    assert.equal(r.status, "COMPLETE_OBSERVATION");
    assert.deepEqual(slept, [31_000], "it waits until the limit resets");
  }
  {
    let listings = 0;
    const r = windowReport(fakeGitHub({
      runs: spread(2500),
      resetAt: AFTER_END + 2 * 3600_000,
      fault: (p) => (p.includes("/runs?event=push") && ++listings > 6 ? new Error("HTTP 429: Too Many Requests") : null),
    }));
    assert.equal(r.status, "INCOMPLETE_RETRIEVAL");
    assert.equal(r.retrieval.stopped_by_rate_limit, true);
    assert.ok(r.examined > 0 && r.examined < 2500, `what was read before the limit is kept: ${r.examined}`);
    assert.ok(r.retrieval.gaps.some((g: Json) => /rate limit/.test(g.reason)), "every range left unread is named");
    assert.deepEqual(slept, [], "a reset two hours away is not waited for");
  }
  assert.equal(failureKind("HTTP 403: You have exceeded a secondary rate limit"), "secondary");
  assert.equal(failureKind("HTTP 403: API rate limit exceeded"), "primary");
  assert.equal(failureKind("HTTP 429: Too Many Requests"), "primary");
  assert.equal(failureKind("HTTP 404: Not Found"), "gone");
  assert.equal(failureKind("HTTP 410: Gone"), "gone");
  assert.equal(failureKind("HTTP 502: Bad Gateway"), "transient");
  assert.equal(failureKind("spawnSync gh ETIMEDOUT"), "transient");
  assert.equal(failureKind("HTTP 422: Validation Failed"), "fatal");
  assert.equal(nextLink('HTTP/2.0 200 OK\r\nLink: <https://api.github.com/repositories/1/activity?per_page=100&after=abc>; rel="next", <https://api.github.com/x>; rel="first"\r\n'), "repositories/1/activity?per_page=100&after=abc");
  assert.equal(nextLink("HTTP/2.0 200 OK\nContent-Type: application/json"), null);
  {
    const { read, stats } = makeReader({ readGh: (() => { throw new Error("HTTP 422: no"); }) as never, sleep: () => {} });
    assert.throws(() => read("x"), (e: Json) => e instanceof ReadFailure && e.kind === "fatal");
    assert.equal(stats.requests, 1, "a failure that retrying cannot fix is not retried");
  }

  // Newest-n: any n, read completely, newest first.
  {
    const fake = fakeGitHub({ runs: spread(2500) });
    const r = report(150, { repo: REPO, readGh: fake.readGh as never, sleep: (() => {}) as never, clock: () => AFTER_END });
    assert.equal(r.mode, "newest 150");
    assert.equal(r.status, "COMPLETE_RETRIEVAL", JSON.stringify(failing(r)));
    assert.equal(r.examined, 150, "past the old 100 cap");
    assert.equal(r.window, null);
    assert.equal(r.pushes.main_push_events, null, "newest-n does not reconcile a window");
    const ids = fake.calls.map((p) => /runs\/(\d+)\/jobs/.exec(p)?.[1]).filter(Boolean).map(Number);
    assert.deepEqual(ids, Array.from({ length: 150 }, (_, i) => 2500 - i), "the newest 150, each once");
    const all: Json = report(3000, { repo: REPO, readGh: fakeGitHub({ runs: spread(2500) }).readGh as never, sleep: (() => {}) as never, clock: () => AFTER_END });
    assert.equal(all.examined, 2500, "asking for more than exist reads the whole history");
    assert.match(all.completeness_evidence.find((c: Json) => /newest/.test(c.check)).detail, /only 2500/);
  }

  // The verdict counting itself is unchanged: the 14 Oct words apart, false-eligible, minutes, overhead.
  const pushJobs: Record<number, Json[]> = {
    1: [{ name: "static", conclusion: "success", steps: [{ name: SHADOW_LOG_STEP, conclusion: "success", started_at: "2026-10-26T10:00:00Z", completed_at: "2026-10-26T10:00:02Z" }, { name: SHADOW_PREFIX + "ELIGIBLE_FOR_REUSE ~8 min" }] }, { name: "unit (1)", conclusion: "success" }, { name: "unit (2)", conclusion: "success" }],
    2: [{ name: "static", conclusion: "success", steps: [{ name: SHADOW_PREFIX + "ELIGIBLE_FOR_REUSE ~8 min" }] }, { name: "unit (1)", conclusion: "failure" }, { name: "unit (2)", conclusion: "success" }],
    3: [{ name: "static", steps: [{ name: SHADOW_PREFIX + "NOT_ELIGIBLE ~0 min" }] }],
    4: [{ name: "static", steps: [{ name: "Tree reuse dry run MATCH" }] }],
    5: [{ name: "static", steps: [{ name: "Install" }] }],
  };
  const counted = report(5, {
    repo: REPO,
    readGh: fakeGitHub({ runs: [1, 2, 3, 4, 5].map((id) => pushRun(id, AFTER_END - id * 60_000, { conclusion: id === 2 ? "failure" : "success" })), jobs: (id) => pushJobs[id] }).readGh as never,
    clock: () => AFTER_END,
  });
  assert.equal(counted.classes.ELIGIBLE_FOR_REUSE, 2);
  assert.equal(counted.classes.NOT_ELIGIBLE, 1);
  assert.equal(counted.legacy.MATCH, 1, "the 14 Oct dry run's words are counted apart");
  assert.equal(counted["no shadow"], 1);
  assert.deepEqual(counted.false_eligible_runs, [2], "ELIGIBLE while the push run's own unit job failed is listed as false-eligible");
  assert.equal(counted.estimated_avoidable_minutes, 16);
  assert.deepEqual(counted.shadow_step_seconds, { n: 1, median: 2, max: 2 });

  const replayRuns = [pushRun(900, NOW, { head_sha: SHA }), pushRun(899, NOW - 3600_000, { head_sha: PARENT })];
  const replayList = fakeGitHub({ runs: replayRuns }).readGh;
  const replayed = replay(1, {
    repo: REPO,
    readGit: git(TREE_A, "fix(x): a thing (#6491)") as never,
    wall: () => NOW + 60_000,
    readGh: ((path: string, options?: Json) => {
      if (path.includes("/runs?event=push") || path === `repos/${REPO}`) return replayList(path, options as never);
      if (path === `repos/${REPO}/actions/runs/900/jobs?filter=latest&per_page=100`) return { jobs: prJobs() };
      return world()(path);
    }) as never,
  });
  assert.equal(replayed.classes.ELIGIBLE_FOR_REUSE, 1, "replay rebuilds the push context from history and classifies it");
  assert.deepEqual(replayed.false_eligible, [], "and checks each ELIGIBLE one against its own push run");
  assert.equal(replayed.listing_complete, true);

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
