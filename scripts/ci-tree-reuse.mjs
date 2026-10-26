#!/usr/bin/env node
// Could a push to `main` have reused the PR's own checks? — SHADOW MODE: it measures, it never skips.
//
// WHY THIS EXISTS. A push to `main` re-runs `static` and both `unit` jobs (~8 billed minutes) on a commit
// whose TREE the PR's own run very often already tested: equal tree ids are the same bytes, so the second
// run proves nothing new about them. The owner approved MEASURING that (2026-10-14 as a 3-way dry run,
// 2026-10-26 as this 5-class shadow mode: "observational only ... Any uncertainty means: FULL CI
// REQUIRED"). Whether a skip is ever turned on is a separate decision that is his alone.
//
// WHAT IT DOES NOT DO — and must never be turned into without the owner's word:
//   * it never skips, shortens, reorders or gates a step; nothing in ci.yml reads its output except the
//     name of the step after it (tests/ci-tree-reuse-dryrun.test.ts pins that);
//   * it never fails the job: every path ends in a class, the process always exits 0, and the ci.yml
//     step is continue-on-error with a 2-minute ceiling;
//   * it has NO enforcement mode, flag, environment switch or date that activates anything. It reads a
//     fixed allow-list of GITHUB_* variables and nothing else (the test refuses any other env read).
//
// THE FIVE CLASSES. Only ELIGIBLE_FOR_REUSE says "the PR run covered this", and only when EVERY check
// below passed. Anything unreadable, ambiguous or merely unusual lands in one of the other four; the
// fall-through default is INSUFFICIENT_EVIDENCE, never ELIGIBLE.
//   HISTORICAL_DATA_UNAVAILABLE  a git or API read failed, or the data is gone
//   SAFETY_CHECK_FAILED          the evidence contradicts itself (forced push, subject vs API PR, a job
//                                that reads SUCCESS while one of its work steps did not run, two trees)
//   NOT_ELIGIBLE                 a definite no: direct push, fork or bot PR, a red/missing/cancelled
//                                required job, a different workflow, different trees
//   INSUFFICIENT_EVIDENCE        cannot tell: no or several candidate PRs, a multi-commit push, no tree
//                                recorded, a PR run too old or from another day (tests read the date)
//   ELIGIBLE_FOR_REUSE           identical tree, same workflow, same-repo human PR, latest attempt, every
//                                required job green AND every work step of the reusable jobs green
//
// "SUCCESS IS NOT EVIDENCE." A job's conclusion is the job's, not its steps': a step skipped by an `if:`
// still leaves the job green. So the reusable jobs (static, unit (1), unit (2)) are judged step by step;
// the only steps allowed not to run are the ones that verify nothing (NON_VERIFYING_STEPS).
// `validate` is required green but is NEVER counted as reusable: on a push it runs the build, the
// standalone assembly and the Playwright smoke, which a PR run skips by design.
//
// HOW THE TWO RUNS MEET. The PR run's `static` job records the tree it tested in the NAME of a step
// ("Tested tree <sha>"): a step name is readable from the jobs API with `actions: read` alone. The push
// run finds its PR with `commits/{sha}/pulls` (squash, rebase and merge commits alike), takes the newest
// pull_request run of ci.yml on the PR's final head, reads its latest attempt's jobs, and compares. The
// class is written into the NAME of the next step ("Tree reuse shadow ELIGIBLE_FOR_REUSE ~8 min") so
// `--report` counts from step names without downloading a log, and a full machine-readable record goes
// to the log (`tree-reuse-shadow-record {json}`) and the job summary. No token, header or env is recorded.
//
//   node scripts/ci-tree-reuse.mjs --dry-run       in ci.yml, on a push; writes verdict= and minutes=
//   node scripts/ci-tree-reuse.mjs --report [n]    count the classes of the last n (default 40) push runs
//   node scripts/ci-tree-reuse.mjs --replay [n]    re-classify the last n (default 20) real pushes from
//                                                  history, read-only, and check each against its own run
//
// Pinned by tests/ci-tree-reuse-dryrun.test.ts.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "ci-tree-reuse",
  entry: import.meta.url,
  known: ["--dry-run", "--report", "--replay"],
  hints: [
    "--dry-run is what ci.yml passes; --report [n] counts the classes of the last n push runs; --replay [n] backtests the last n pushes",
  ],
});

export const TESTED_TREE_PREFIX = "Tested tree ";
export const SHADOW_PREFIX = "Tree reuse shadow ";
export const SHADOW_LOG_STEP = "Tree reuse shadow (log only)";
/** The 14 Oct dry run's step prefix and words, still counted by `--report` for older push runs. */
export const LEGACY_PREFIX = "Tree reuse dry run ";
export const LEGACY_VERDICTS = ["MATCH", "DIFFER", "UNKNOWN"];
export const RECORD_PREFIX = "tree-reuse-shadow-record ";

export const CLASSES = [
  "ELIGIBLE_FOR_REUSE",
  "NOT_ELIGIBLE",
  "INSUFFICIENT_EVIDENCE",
  "SAFETY_CHECK_FAILED",
  "HISTORICAL_DATA_UNAVAILABLE",
];

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
/** Every job a PR run must have finished with success. `checks` and `validate` are the required checks. */
export const REQUIRED_JOBS = ["validate", "static", "unit (1)", "unit (2)", "checks"];
/** The jobs a reuse could stand in for. `validate` is never one: its push-only steps never ran on the PR. */
export const REUSABLE_JOBS = ["static", "unit (1)", "unit (2)"];
/**
 * The only steps of a reusable job allowed NOT to conclude success on the PR run, because none of them
 * verifies anything: the tree recording (PR-only), this shadow (push-only), the 14 Oct dry run's names,
 * and cache SAVES (a save on `main` only stores what the install already proved). Exact names or a
 * prefix ending in a space; anything else that was skipped or cancelled is SAFETY_CHECK_FAILED.
 */
export const NON_VERIFYING_STEPS = [
  "Compute the tree this run tests",
  TESTED_TREE_PREFIX,
  SHADOW_PREFIX,
  LEGACY_PREFIX,
  "Save the pnpm store",
  "Save ESLint cache",
];
export const MAX_PR_RUN_AGE_HOURS = 12;
export const CAVEATS = [
  "the unit suite reads production credentials, so it is not hermetic: a reuse assumes that data did not change the verdict",
  "validate's push-only steps (build, standalone assembly, Playwright smoke) are never reusable",
  "avoidable minutes are an ESTIMATE from the PR run's own job durations, not a measurement of the push run",
];

const SHA_RE = /^[0-9a-f]{40}$/;
const isSha = (value) => SHA_RE.test(String(value ?? ""));
const oneLine = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 160);

/** The PR number GitHub appends to a squash-merge subject, or `null`. */
export function prNumberFromSubject(subject) {
  const match = /\(#(\d{1,7})\)\s*$/.exec(String(subject ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** Is this step allowed not to run, because it verifies nothing? */
export function isNonVerifyingStep(name) {
  const text = String(name ?? "");
  return NON_VERIFYING_STEPS.some((entry) => (entry.endsWith(" ") ? text.startsWith(entry) : text === entry));
}

/** Every distinct tree recorded in the step names of the `static` job (older runs: `checks`). */
export function recordedTrees(jobs, jobNames = ["static", "checks"]) {
  const found = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!jobNames.includes(job?.name)) continue;
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      const name = String(step?.name ?? "");
      if (!name.startsWith(TESTED_TREE_PREFIX)) continue;
      const sha = name.slice(TESTED_TREE_PREFIX.length).trim();
      if (isSha(sha)) found.add(sha);
    }
  }
  return [...found];
}

/** The one tree a PR run recorded, or `null` when it recorded none or several. */
export function testedTreeFromJobs(jobs, jobNames) {
  const trees = recordedTrees(jobs, jobNames);
  return trees.length === 1 ? trees[0] : null;
}

/** Whole minutes a job billed, from its own timestamps; 0 when they are unreadable. */
export function jobMinutes(job) {
  const ms = Date.parse(job?.completed_at) - Date.parse(job?.started_at);
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/** The calendar day of `ms` in `timeZone`, or `null` if it cannot be computed. */
export function dayIn(timeZone, ms) {
  try {
    if (!Number.isFinite(ms)) return null;
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return null;
  }
}

const verdict = (decision, reason) => ({ decision, reason });

/**
 * THE CLASSIFIER. Pure, never throws, and the ONLY path to ELIGIBLE_FOR_REUSE is the last line, reached
 * after every check passed. `e` is what {@link gather} read; a missing or malformed field fails closed.
 * @returns {{ decision: string, reason: string }}
 */
export function classify(e) {
  try {
    if (!e || typeof e !== "object") return verdict("HISTORICAL_DATA_UNAVAILABLE", "no evidence was gathered");
    if (Array.isArray(e.errors) && e.errors.length > 0) return verdict("HISTORICAL_DATA_UNAVAILABLE", `a read failed: ${e.errors[0]}`);
    if (!e.repo) return verdict("HISTORICAL_DATA_UNAVAILABLE", "GITHUB_REPOSITORY is not set");
    if (!isSha(e.sha) || !isSha(e.tree)) return verdict("HISTORICAL_DATA_UNAVAILABLE", "this commit's id or tree is unreadable");

    // The push itself.
    if (e.eventName !== "push") return verdict("NOT_ELIGIBLE", `the event is ${e.eventName || "unknown"}, not a push`);
    if (e.ref !== "refs/heads/main") return verdict("NOT_ELIGIBLE", `the push is to ${e.ref || "an unknown ref"}, not main`);
    if (e.workflowRef !== `${e.repo}/${WORKFLOW_PATH}@refs/heads/main`) return verdict("NOT_ELIGIBLE", "this run is not ci.yml on main");
    if (!e.event || typeof e.event !== "object") return verdict("HISTORICAL_DATA_UNAVAILABLE", "the push event payload is unreadable");
    if (e.event.forced === true) return verdict("SAFETY_CHECK_FAILED", "the push was forced");
    if (e.event.forced !== false) return verdict("INSUFFICIENT_EVIDENCE", "whether the push was forced is unknown");
    if (e.event.after !== e.sha) return verdict("SAFETY_CHECK_FAILED", "the push payload's head is not this commit");
    if (!isSha(e.event.before) || !isSha(e.parent)) return verdict("INSUFFICIENT_EVIDENCE", "the commit before the push is unknown");
    if (e.parent !== e.event.before) {
      return verdict("INSUFFICIENT_EVIDENCE", "the push moved main by more than one first-parent commit (a multi-commit rebase or a stacked push)");
    }

    // The PR.
    if (!Array.isArray(e.pulls)) return verdict("HISTORICAL_DATA_UNAVAILABLE", "the commit's pull requests are unreadable");
    if (e.pulls.length === 0) return verdict("NOT_ELIGIBLE", "a direct push: no pull request is associated with this commit");
    const merged = e.pulls.filter((p) => Number.isFinite(Date.parse(p?.merged_at)) && p?.base?.ref === "main" && p?.merge_commit_sha === e.sha);
    if (merged.length === 0) return verdict("INSUFFICIENT_EVIDENCE", "no pull request merged into main as exactly this commit");
    if (merged.length > 1) return verdict("INSUFFICIENT_EVIDENCE", `${merged.length} pull requests claim this commit`);
    const pr = merged[0];
    const subjectPr = prNumberFromSubject(e.subject);
    if (subjectPr !== null && subjectPr !== pr.number) {
      return verdict("SAFETY_CHECK_FAILED", `the subject names #${subjectPr} but the API names #${pr.number}`);
    }
    if (pr?.head?.repo?.full_name !== e.repo) return verdict("NOT_ELIGIBLE", "the pull request comes from a fork (different secrets and permissions)");
    const login = String(pr?.user?.login ?? "");
    if (pr?.user?.type !== "User" || /\[bot\]$/i.test(login)) return verdict("NOT_ELIGIBLE", "the pull request was opened by a bot (different secrets)");
    if (!isSha(pr?.head?.sha)) return verdict("INSUFFICIENT_EVIDENCE", "the pull request's final head is unreadable");

    // The PR's newest run of ci.yml on its final head.
    if (!Array.isArray(e.runs)) return verdict("HISTORICAL_DATA_UNAVAILABLE", "the pull request's runs are unreadable");
    const run = newestRun(e.runs);
    if (!run) return verdict("INSUFFICIENT_EVIDENCE", "the pull request's final head has no CI run");
    if (run.event !== "pull_request") return verdict("SAFETY_CHECK_FAILED", `the newest run is a ${run.event} run, not a pull_request run`);
    if (run.path !== WORKFLOW_PATH) return verdict("SAFETY_CHECK_FAILED", `the run's workflow is ${run.path}, not ${WORKFLOW_PATH}`);
    if (run.head_sha !== pr.head.sha) return verdict("SAFETY_CHECK_FAILED", "the run tested a different head than the pull request's final head");
    if (run.head_repository?.full_name !== e.repo) {
      return verdict("NOT_ELIGIBLE", "the run's head is in another repository");
    }
    if (run.status !== "completed") return verdict("NOT_ELIGIBLE", `the newest pull request run is ${run.status || "in an unknown state"}`);
    if (run.conclusion !== "success") return verdict("NOT_ELIGIBLE", `the newest pull request run concluded ${run.conclusion || "nothing"}`);

    // Its latest attempt's jobs, judged one by one.
    if (!Array.isArray(e.jobs) || e.jobs.length === 0) return verdict("HISTORICAL_DATA_UNAVAILABLE", "the pull request run's jobs are no longer listed");
    if (!Number.isInteger(run.run_attempt) || e.jobs.some((job) => job?.run_attempt !== run.run_attempt)) {
      return verdict("SAFETY_CHECK_FAILED", "the jobs read are not all from the run's latest attempt");
    }
    for (const name of REQUIRED_JOBS) {
      const found = e.jobs.filter((job) => job?.name === name);
      if (found.length === 0) return verdict("NOT_ELIGIBLE", `the required job ${name} is missing from the pull request run`);
      if (found.length > 1) return verdict("SAFETY_CHECK_FAILED", `the required job ${name} appears ${found.length} times`);
      if (found[0].status !== "completed" || found[0].conclusion !== "success") {
        return verdict("NOT_ELIGIBLE", `the required job ${name} concluded ${found[0].conclusion || found[0].status || "nothing"}`);
      }
    }
    const bad = e.jobs.find((job) => !["success", "skipped"].includes(job?.conclusion));
    if (bad) return verdict("NOT_ELIGIBLE", `the job ${bad.name} concluded ${bad.conclusion || "nothing"}`);
    for (const name of REUSABLE_JOBS) {
      const job = e.jobs.find((j) => j?.name === name);
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      if (steps.length === 0) return verdict("SAFETY_CHECK_FAILED", `the job ${name} lists no steps`);
      for (const step of steps) {
        if (isNonVerifyingStep(step?.name)) continue;
        if (step?.status !== "completed" || step?.conclusion !== "success") {
          return verdict("SAFETY_CHECK_FAILED", `the job ${name} reads success but its step "${step?.name}" concluded ${step?.conclusion || step?.status || "nothing"}`);
        }
      }
    }

    // The tree.
    const trees = recordedTrees(e.jobs);
    if (trees.length > 1) return verdict("SAFETY_CHECK_FAILED", "the pull request run recorded more than one tree");
    if (trees.length === 0) return verdict("INSUFFICIENT_EVIDENCE", "the pull request run recorded no tested tree");
    if (trees[0] !== e.tree) return verdict("NOT_ELIGIBLE", "main's tree differs from the tree the pull request run tested (main moved, or the merge changed it)");

    // Time: tests read the date, and the unit suite reads production data.
    const finished = Date.parse(run.updated_at);
    if (!Number.isFinite(finished) || !Number.isFinite(e.now)) return verdict("INSUFFICIENT_EVIDENCE", "when the pull request run finished is unknown");
    if (finished > e.now + 5 * 60000) return verdict("INSUFFICIENT_EVIDENCE", "the pull request run finished after this push started");
    if (e.now - finished > MAX_PR_RUN_AGE_HOURS * 3600000) return verdict("INSUFFICIENT_EVIDENCE", `the pull request run finished more than ${MAX_PR_RUN_AGE_HOURS} hours before the push`);
    for (const zone of ["UTC", "Africa/Cairo"]) {
      const then = dayIn(zone, finished);
      const today = dayIn(zone, e.now);
      if (!then || !today) return verdict("INSUFFICIENT_EVIDENCE", `the ${zone} calendar day cannot be computed`);
      if (then !== today) return verdict("INSUFFICIENT_EVIDENCE", `the pull request run finished on another ${zone} calendar day`);
    }

    return verdict("ELIGIBLE_FOR_REUSE", "identical tree, same workflow, same-repo pull request, and every required job and every work step of the reusable jobs succeeded");
  } catch (error) {
    return verdict("INSUFFICIENT_EVIDENCE", `the classifier could not read the evidence: ${oneLine(error)}`);
  }
}

function newestRun(runs) {
  const sorted = runs
    .filter((r) => r && typeof r === "object")
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || (b.id ?? 0) - (a.id ?? 0));
  return sorted[0] ?? null;
}

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
}

const gh = (path) => JSON.parse(run("gh", ["api", path]));

/**
 * The GITHUB_* variables this script reads — the whole list. Nothing else in the environment can reach
 * it, so no variable can switch it into anything but a measurement.
 */
export function readEnv(env = process.env) {
  return {
    repo: env.GITHUB_REPOSITORY,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    eventPath: env.GITHUB_EVENT_PATH,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    output: env.GITHUB_OUTPUT,
    summary: env.GITHUB_STEP_SUMMARY,
  };
}

/**
 * Read the evidence. Every read is a GET; the first failure stops reading and is recorded in `errors`,
 * which {@link classify} turns into HISTORICAL_DATA_UNAVAILABLE. Never throws.
 */
export function gather({ ctx, readGit = run, readGh = gh }) {
  const e = { ...ctx, errors: [], apiCalls: 0, pulls: undefined, runs: undefined, jobs: undefined };
  const api = (path) => {
    e.apiCalls++;
    return readGh(path);
  };
  try {
    const at = ctx.sha ?? "HEAD";
    if (!e.sha) e.sha = String(readGit("git", ["rev-parse", "HEAD"])).trim();
    e.tree = String(readGit("git", ["rev-parse", `${at}^{tree}`])).trim();
    e.subject = String(readGit("git", ["log", "-1", "--format=%s", at])).trim();
    e.parent = String(readGit("git", ["rev-parse", `${at}^1`])).trim();
    if (!e.repo || !isSha(e.sha)) return e;

    const pulls = api(`repos/${e.repo}/commits/${e.sha}/pulls`);
    e.pulls = Array.isArray(pulls) ? pulls : undefined;
    const merged = (e.pulls ?? []).filter((p) => Number.isFinite(Date.parse(p?.merged_at)) && p?.base?.ref === "main" && p?.merge_commit_sha === e.sha);
    if (merged.length !== 1 || !isSha(merged[0]?.head?.sha)) return e;
    e.pr = { number: merged[0].number, head: merged[0].head.sha };

    const runs = api(`repos/${e.repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${merged[0].head.sha}&per_page=10`)?.workflow_runs;
    e.runs = Array.isArray(runs) ? runs : undefined;
    const newest = e.runs ? newestRun(e.runs) : null;
    if (!newest?.id) return e;
    e.prRun = { id: newest.id, attempt: newest.run_attempt, updated_at: newest.updated_at, conclusion: newest.conclusion };

    const jobs = api(`repos/${e.repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`)?.jobs;
    e.jobs = Array.isArray(jobs) ? jobs : undefined;
  } catch (error) {
    e.errors.push(oneLine(error));
  }
  return e;
}

/** The context of the running push, from the allow-listed environment and the event file. */
export function liveContext(env = readEnv(), readEvent = (path) => JSON.parse(readFileSync(path, "utf8"))) {
  let event = null;
  try {
    const payload = env.eventPath ? readEvent(env.eventPath) : null;
    if (payload && typeof payload === "object") {
      event = { before: payload.before, after: payload.after, forced: payload.forced, commits: Array.isArray(payload.commits) ? payload.commits.length : null };
    }
  } catch {
    event = null;
  }
  return { repo: env.repo, eventName: env.eventName, ref: env.ref, workflowRef: env.workflowRef, event, now: Date.now(), runId: env.runId, runAttempt: env.runAttempt };
}

/**
 * The machine-readable record of one decision. Only named fields from the evidence are copied — never the
 * environment, a token or a header.
 */
export function buildRecord(e, result, { detectorMs = null } = {}) {
  const jobs = Array.isArray(e?.jobs) ? e.jobs : [];
  const conclusions = Object.fromEntries(REQUIRED_JOBS.map((name) => [name, jobs.find((j) => j?.name === name)?.conclusion ?? null]));
  const reusableMinutes = REUSABLE_JOBS.reduce((sum, name) => sum + jobMinutes(jobs.find((j) => j?.name === name)), 0);
  const validate = jobs.find((j) => j?.name === "validate");
  const build = (validate?.steps ?? []).find((s) => s?.name === "Build");
  const finished = Date.parse(e?.prRun?.updated_at);
  return {
    format: 1,
    decision: result.decision,
    reason: result.reason,
    run_id: e?.runId ?? null,
    run_attempt: e?.runAttempt ?? null,
    commit: e?.sha ?? null,
    tree: e?.tree ?? null,
    workflow_ref: e?.workflowRef ?? null,
    pr: e?.pr?.number ?? null,
    pr_head: e?.pr?.head ?? null,
    pr_run_id: e?.prRun?.id ?? null,
    pr_run_attempt: e?.prRun?.attempt ?? null,
    tested_tree: testedTreeFromJobs(jobs),
    check_conclusions: conclusions,
    validate_reuse: `never — push-only steps; the PR build ${build ? (build.conclusion === "success" ? "ran" : "was skipped") : "is unknown"}`,
    commits_in_push: e?.event?.commits ?? null,
    pr_run_age_minutes: Number.isFinite(finished) && Number.isFinite(e?.now) ? Math.round((e.now - finished) / 60000) : null,
    reusable_job_minutes_in_pr_run: reusableMinutes,
    estimated_avoidable_minutes: result.decision === "ELIGIBLE_FOR_REUSE" ? reusableMinutes : 0,
    caveats: CAVEATS,
    detector_ms: detectorMs,
    api_calls: e?.apiCalls ?? 0,
    skipping_active: false,
  };
}

/** The job-summary table for one record. */
export function summaryMarkdown(record) {
  const rows = [
    ["Decision", `**${record.decision}**`],
    ["Reason", record.reason],
    ["Commit / tree", `${record.commit ?? "?"} / ${record.tree ?? "?"}`],
    ["PR / head", `${record.pr ?? "none"} / ${record.pr_head ?? "?"}`],
    ["PR run / attempt", `${record.pr_run_id ?? "none"} / ${record.pr_run_attempt ?? "?"}`],
    ["Tested tree", record.tested_tree ?? "none"],
    ["Required jobs on the PR run", Object.entries(record.check_conclusions).map(([k, v]) => `${k}: ${v ?? "missing"}`).join(", ")],
    ["validate", record.validate_reuse],
    ["Estimated avoidable minutes", `${record.estimated_avoidable_minutes} (estimate)`],
    ["Detector", `${record.detector_ms ?? "?"} ms, ${record.api_calls} API calls`],
    ["Skipping", "OFF — shadow mode, nothing was skipped"],
  ];
  return [
    "### Tree reuse shadow (log only)",
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, "\\|")} |`),
    "",
    "```json",
    JSON.stringify(record),
    "```",
    "",
  ].join("\n");
}

/** One shadow evaluation, end to end. Never throws. */
export function shadow({ ctx, readGit = run, readGh = gh, clock = () => performance.now() } = {}) {
  const started = clock();
  let evidence = ctx ?? {};
  let result;
  try {
    evidence = gather({ ctx: ctx ?? liveContext(), readGit, readGh });
    result = classify(evidence);
  } catch (error) {
    result = verdict("HISTORICAL_DATA_UNAVAILABLE", `the shadow could not run: ${oneLine(error)}`);
  }
  const record = buildRecord(evidence, result, { detectorMs: Math.round(clock() - started) });
  return { result, record };
}

/** Parse a shadow step name back into its class and minutes. */
export function parseShadowStep(name) {
  const text = String(name ?? "");
  if (!text.startsWith(SHADOW_PREFIX) || text === SHADOW_LOG_STEP) return null;
  const match = /^(\S+)(?:\s+~(\d+) min)?\s*$/.exec(text.slice(SHADOW_PREFIX.length));
  if (!match || !CLASSES.includes(match[1])) return null;
  return { decision: match[1], minutes: Number(match[2] ?? 0) };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const stepSeconds = (step) => {
  const ms = Date.parse(step?.completed_at) - Date.parse(step?.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
};

const reusableJobsFailed = (jobs) =>
  REUSABLE_JOBS.some((name) => {
    const job = (jobs ?? []).find((j) => j?.name === name);
    return !job || job.conclusion !== "success";
  });

const DEFAULT_REPO = "Gawish-1997/phoenix-people-workforce";

/** Count the classes of the last `limit` push runs of ci.yml, from step names alone. */
export function report(limit = 40, { repo = readEnv().repo || DEFAULT_REPO, readGh = gh } = {}) {
  const runs = readGh(`repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=${limit}`)?.workflow_runs ?? [];
  const classes = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const legacy = Object.fromEntries(LEGACY_VERDICTS.map((v) => [v, 0]));
  let none = 0;
  let minutes = 0;
  const overhead = [];
  const falseEligible = [];
  const eligibleRunRedElsewhere = [];
  for (const r of runs) {
    const jobs = readGh(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)?.jobs ?? [];
    let seen = null;
    for (const job of jobs) {
      for (const step of job?.steps ?? []) {
        const name = String(step?.name ?? "");
        const parsed = parseShadowStep(name);
        if (parsed) seen = { kind: "shadow", ...parsed };
        else if (name.startsWith(LEGACY_PREFIX) && name !== `${LEGACY_PREFIX}(log only)`) {
          const word = name.slice(LEGACY_PREFIX.length).trim();
          if (LEGACY_VERDICTS.includes(word) && !seen) seen = { kind: "legacy", word };
        }
        if (name === SHADOW_LOG_STEP && step?.conclusion !== "skipped") {
          const s = stepSeconds(step);
          if (s !== null) overhead.push(s);
        }
      }
    }
    if (!seen) none++;
    else if (seen.kind === "legacy") legacy[seen.word]++;
    else {
      classes[seen.decision]++;
      if (seen.decision === "ELIGIBLE_FOR_REUSE") {
        minutes += seen.minutes;
        if (r.status === "completed" && reusableJobsFailed(jobs)) falseEligible.push(r.id);
        else if (r.status === "completed" && r.conclusion !== "success") eligibleRunRedElsewhere.push(r.id);
      }
    }
  }
  return {
    examined: runs.length,
    classes,
    legacy,
    "no shadow": none,
    estimated_avoidable_minutes: minutes,
    false_eligible_runs: falseEligible,
    eligible_runs_red_outside_reusable_jobs: eligibleRunRedElsewhere,
    shadow_step_seconds: { n: overhead.length, median: median(overhead), max: overhead.length ? Math.max(...overhead) : null },
  };
}

/**
 * Re-classify the last `limit` real pushes from history, read-only, and check each ELIGIBLE one against
 * what its own push run then did. `before` is the previous push's head (a push run exists for every push
 * to main); `forced` is not in the runs API and is taken as false, which the record says.
 */
export function replay(limit = 20, { repo = readEnv().repo || DEFAULT_REPO, readGit = run, readGh = gh, clock = () => performance.now() } = {}) {
  const runs = readGh(`repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=${Math.min(limit + 1, 100)}`)?.workflow_runs ?? [];
  const results = [];
  for (let i = 0; i < Math.min(limit, runs.length); i++) {
    const r = runs[i];
    const ctx = {
      repo,
      sha: r.head_sha,
      eventName: "push",
      ref: "refs/heads/main",
      workflowRef: `${repo}/${WORKFLOW_PATH}@refs/heads/main`,
      event: { before: runs[i + 1]?.head_sha, after: r.head_sha, forced: false, commits: null },
      now: Date.parse(r.run_started_at || r.created_at),
      runId: String(r.id),
      runAttempt: String(r.run_attempt ?? ""),
    };
    const { result, record } = shadow({ ctx, readGit, readGh, clock });
    let pushReusableFailed = null;
    if (result.decision === "ELIGIBLE_FOR_REUSE" && r.status === "completed") {
      try {
        pushReusableFailed = reusableJobsFailed(readGh(`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)?.jobs);
      } catch {
        pushReusableFailed = null;
      }
    }
    results.push({ ...record, push_run_conclusion: r.conclusion, push_reusable_jobs_failed: pushReusableFailed, replay: true });
  }
  const classes = Object.fromEntries(CLASSES.map((c) => [c, results.filter((x) => x.decision === c).length]));
  const ms = results.map((x) => x.detector_ms).filter(Number.isFinite);
  return {
    replayed: results.length,
    classes,
    false_eligible: results.filter((x) => x.push_reusable_jobs_failed === true).map((x) => x.run_id),
    estimated_avoidable_minutes: results.reduce((s, x) => s + x.estimated_avoidable_minutes, 0),
    reusable_job_minutes_all_pushes: results.reduce((s, x) => s + x.reusable_job_minutes_in_pr_run, 0),
    detector_ms: { median: median(ms), max: ms.length ? Math.max(...ms) : null },
    api_calls: results.reduce((s, x) => s + x.api_calls, 0),
    note: "forced is not in the runs API and is taken as false; before = the previous push run's head",
    results: results.map((x) => ({ run: x.run_id, commit: x.commit?.slice(0, 9), pr: x.pr, decision: x.decision, reason: x.reason, minutes: x.estimated_avoidable_minutes, push: x.push_run_conclusion })),
  };
}

const countArg = (flag, fallback) => {
  const n = Number(process.argv[process.argv.indexOf(flag) + 1]);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : fallback;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = readEnv();
  try {
    if (process.argv.includes("--report")) {
      console.log(JSON.stringify(report(countArg("--report", 40)), null, 2));
    } else if (process.argv.includes("--replay")) {
      console.log(JSON.stringify(replay(countArg("--replay", 20)), null, 2));
    } else {
      const { result, record } = shadow();
      console.log(`tree-reuse shadow: ${result.decision} - ${result.reason}`);
      console.log(RECORD_PREFIX + JSON.stringify(record));
      if (env.output) appendFileSync(env.output, `verdict=${result.decision}\nminutes=${record.estimated_avoidable_minutes}\n`);
      if (env.summary) appendFileSync(env.summary, summaryMarkdown(record));
    }
  } catch (error) {
    console.log(`tree-reuse shadow: HISTORICAL_DATA_UNAVAILABLE - ${oneLine(error)}`);
    try {
      if (env.output) appendFileSync(env.output, "verdict=HISTORICAL_DATA_UNAVAILABLE\nminutes=0\n");
    } catch {
      // an unwritable output file still never fails the job
    }
  }
  process.exit(0);
}
