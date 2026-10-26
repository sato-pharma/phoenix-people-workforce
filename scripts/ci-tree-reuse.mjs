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
//   node scripts/ci-tree-reuse.mjs --report        every push run of the owner's 14-day observation window
//                                                  (OBSERVATION_WINDOW), with a completeness status
//   node scripts/ci-tree-reuse.mjs --report <n>    the newest n push runs, any n
//   node scripts/ci-tree-reuse.mjs --replay [n]    re-classify the last n (default 20) real pushes from
//                                                  history, read-only, and check each against its own run
//
// THE REPORT IS COMPLETE OR SAYS IT IS NOT (owner, 2026-10-26: "account for EVERY relevant main push").
// GitHub's run list answers at most 1,000 results per query and, past that, an EMPTY page with
// total_count 0 — a silent truncation. So the report lists by `created` range, splits any range the API
// counts above 1,000 in half until each fits, reads every page, checks the distinct ids it got against
// the API's own count, dedupes by run id, and reconciles the runs with the repository's own push record
// (the activity list). Anything it could not read is named as a gap and the status says
// INCOMPLETE_RETRIEVAL; an open window says PARTIAL_OBSERVATION, never "missing".
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

/** The one wall-clock read: the push's own "now", and how far the report's window has run. */
const wallClock = () => Date.now();

/**
 * One read-only `gh api` GET. With `include`, it also returns the `Link: rel="next"` path, because the
 * activity list pages by cursor. A failure throws gh's own last stderr line, which carries the HTTP status.
 */
export function gh(path, { include = false } = {}) {
  let out;
  try {
    out = execFileSync("gh", ["api", ...(include ? ["-i"] : []), path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const last = String(error?.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
    throw new Error(last || oneLine(error));
  }
  if (!include) return JSON.parse(out);
  const split = /\r?\n\r?\n/.exec(out);
  return { body: JSON.parse(split ? out.slice(split.index + split[0].length) : out), next: nextLink(split ? out.slice(0, split.index) : "") };
}

/** The `rel="next"` path of a `Link` header, relative to the API root, or `null`. */
export function nextLink(headers) {
  const line = String(headers ?? "").split(/\r?\n/).find((l) => /^link:/i.test(l));
  const match = line ? /<([^>]+)>;\s*rel="next"/.exec(line) : null;
  return match ? match[1].replace(/^https:\/\/api\.github\.com\//, "") : null;
}

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
  return { repo: env.repo, eventName: env.eventName, ref: env.ref, workflowRef: env.workflowRef, event, now: wallClock(), runId: env.runId, runAttempt: env.runAttempt };
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

/**
 * One shadow evaluation, end to end. Never throws.
 * @param {{ ctx?: object, readGit?: Function, readGh?: Function, clock?: () => number }} [options]
 */
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

// ── The observation window and its clock ────────────────────────────────────────────────────────────

/**
 * The owner's 14-day shadow observation (2026-10-26): from the merge of the shadow, 26 Oct 2026 05:12
 * Cairo, to 9 Nov 2026 05:12 Cairo — start-inclusive, end-exclusive. Written as Cairo wall-clock times and
 * converted with the time-zone database, never a fixed offset: Cairo leaves summer time on 30 Oct, so the
 * window is 337 hours, not 336.
 */
export const OBSERVATION_WINDOW = Object.freeze({ zone: "Africa/Cairo", start: "2026-10-26T05:12", end: "2026-11-09T05:12" });
/** GitHub's run list answers at most this many results for one query; past it, an empty page. */
export const SEARCH_CAP = 1000;
export const PAGE_SIZE = 100;
/** Runs created in the last five minutes are not read yet: the run list can lag a push by that much. */
export const SETTLE_MS = 5 * 60000;
/** A push and its run on either side of a window edge are within this of it; they are labelled, not missing. */
export const EDGE_MS = 2 * 60000;
/** How long one rate-limit pause may be before the report stops and says INCOMPLETE_RETRIEVAL instead. */
export const MAX_RATE_WAIT_MS = 15 * 60000;
const TRANSIENT_BACKOFF_MS = [2000, 8000, 30000];
const SECONDARY_WAIT_MS = 60000;
const SECONDARY_RETRIES = 3;
const PRIMARY_RETRIES = 2;
const SECOND = 1000;
const DAY = 24 * 3600 * SECOND;
/** The floor of a newest-n walk when the repository's own creation date cannot be read. */
const ACTIONS_EPOCH = Date.UTC(2018, 9, 16);
/** The activity types that move a branch's head. */
const MOVES_BRANCH = ["push", "force_push", "pr_merge", "merge_queue_merge"];

const floorSecond = (ms) => Math.floor(ms / SECOND) * SECOND;
/** An instant as the API's query form, to the second: 2026-10-26T02:12:00Z. */
export const isoSecond = (ms) => new Date(floorSecond(ms)).toISOString().replace(".000Z", "Z");

/** The offset of `zone` from UTC at the instant `ms`, in ms, from the time-zone database. */
export function zoneOffsetMs(zone, ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - floorSecond(ms);
}

/**
 * A wall-clock time in `zone` ("2026-10-26T05:12") as the UTC instant, in ms. A time the clock skips, or
 * shows twice when it falls back, has no single answer and throws rather than guessing.
 */
export function zonedToUtc(local, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(local ?? ""));
  if (!m) throw new Error(`not a wall-clock time: ${local}`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const found = new Set();
  for (const probe of [naive - DAY, naive, naive + DAY]) {
    const offset = zoneOffsetMs(zone, probe);
    if (zoneOffsetMs(zone, naive - offset) === offset) found.add(naive - offset);
  }
  if (found.size !== 1) throw new Error(`${local} ${found.size ? "happens twice" : "does not happen"} in ${zone}`);
  return [...found][0];
}

/** An instant as a reader's time: "2026-10-26 05:12:00 Africa/Cairo (UTC+03:00)". */
export function zonedLabel(ms, zone = OBSERVATION_WINDOW.zone) {
  const offset = zoneOffsetMs(zone, ms);
  const local = new Date(floorSecond(ms) + offset).toISOString().slice(0, 19).replace("T", " ");
  const minutes = Math.abs(offset) / 60000;
  return `${local} ${zone} (UTC${offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")})`;
}

// ── Reading, with retries that never lose what was already read ────────────────────────────────────

/** A read that failed for good. `kind`: gone (404/410), rate-limit, transient, secondary, primary, fatal. */
export class ReadFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** What a failed read's message says about it. */
export function failureKind(message) {
  const text = String(message ?? "");
  if (/secondary rate limit/i.test(text)) return "secondary";
  if (/rate limit/i.test(text) || /HTTP 429\b/.test(text)) return "primary";
  if (/HTTP (?:404|410)\b/.test(text)) return "gone";
  if (/HTTP 5\d\d\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|timed? ?out|connection|socket|TLS|JSON/i.test(text)) return "transient";
  return "fatal";
}

const sleepMs = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * A GET reader that retries what is worth retrying and counts what it spent. A transient failure is
 * retried after 2 s, 8 s and 30 s; a secondary rate limit after 60 s, three times; the primary limit is
 * waited out until its reset — unless that is further away than `maxRateWaitMs`, when it stops with a
 * `rate-limit` failure. Gone data and anything else fail at once. Every failure is a {@link ReadFailure}.
 */
export function makeReader({ readGh = gh, sleep = sleepMs, clock = wallClock, maxRateWaitMs = MAX_RATE_WAIT_MS } = {}) {
  const stats = { requests: 0, retries: 0, waited_ms: 0, rate_limit_waits: 0 };
  const pause = (ms) => {
    stats.waited_ms += ms;
    sleep(ms);
  };
  const read = (path, options) => {
    let transient = 0;
    let secondary = 0;
    let primary = 0;
    for (;;) {
      stats.requests++;
      try {
        return options ? readGh(path, options) : readGh(path);
      } catch (error) {
        const message = oneLine(error);
        const kind = failureKind(message);
        if (kind === "transient" && transient < TRANSIENT_BACKOFF_MS.length) {
          stats.retries++;
          pause(TRANSIENT_BACKOFF_MS[transient++]);
          continue;
        }
        if (kind === "secondary" && secondary < SECONDARY_RETRIES) {
          secondary++;
          stats.retries++;
          stats.rate_limit_waits++;
          pause(SECONDARY_WAIT_MS);
          continue;
        }
        if (kind === "primary" && primary < PRIMARY_RETRIES) {
          primary++;
          let resetMs = NaN;
          try {
            stats.requests++;
            resetMs = Number(readGh("rate_limit")?.resources?.core?.reset) * 1000;
          } catch {
            resetMs = NaN;
          }
          const wait = Number.isFinite(resetMs) ? Math.max(SECOND, resetMs - clock() + SECOND) : SECONDARY_WAIT_MS;
          if (wait > maxRateWaitMs) {
            throw new ReadFailure("rate-limit", `the API rate limit is spent and resets at ${zonedLabel(clock() + wait)}, beyond the ${Math.round(maxRateWaitMs / 60000)} minutes this report waits`);
          }
          stats.retries++;
          stats.rate_limit_waits++;
          pause(wait);
          continue;
        }
        throw new ReadFailure(kind === "primary" || kind === "secondary" ? "rate-limit" : kind, message);
      }
    }
  };
  return { read, stats };
}

// ── Listing every push run, past the 1,000-result cap ──────────────────────────────────────────────

const slimRun = (r) => ({
  id: r.id,
  run_attempt: Number.isInteger(r.run_attempt) ? r.run_attempt : 1,
  head_sha: r.head_sha,
  created_at: r.created_at,
  run_started_at: r.run_started_at,
  updated_at: r.updated_at,
  status: r.status,
  conclusion: r.conclusion,
});
const newestFirst = (a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || (b.id ?? 0) - (a.id ?? 0);

function newListing() {
  return { byId: new Map(), gaps: [], ranges: 0, splits: 0, duplicates_merged: 0, dropped: { outside_range: 0, not_push: 0, not_main: 0, other_workflow: 0 }, halted: false };
}

const addGap = (acc, from, to, reason) => acc.gaps.push({ from_ms: from, to_ms: to, reason });

/**
 * Read every push run of ci.yml on main created in [from, to) into `acc`. A range the API counts above
 * {@link SEARCH_CAP} is split at a whole second and each half read on its own, newer half first; a single
 * second holding more than the cap is the one range that cannot be split, and is a gap. Every other range
 * reads all its pages and must return exactly as many distinct ids as the API counted — else it is read
 * once more, and a second mismatch is a gap. What was read is always kept.
 */
function collectRange(read, repo, from, to, acc, log = () => {}) {
  const stack = [[floorSecond(from), floorSecond(to)]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (b <= a) continue;
    if (acc.halted) {
      addGap(acc, a, b, "not read: the rate limit stopped the report");
      continue;
    }
    const query = (page) => `repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=${PAGE_SIZE}&page=${page}&created=${isoSecond(a)}..${isoSecond(b - SECOND)}`;
    let first;
    try {
      first = read(query(1));
    } catch (error) {
      addGap(acc, a, b, `the run list could not be read: ${oneLine(error)}`);
      if (error?.kind === "rate-limit") acc.halted = true;
      continue;
    }
    const total = first?.total_count;
    if (!Number.isInteger(total) || total < 0 || !Array.isArray(first?.workflow_runs)) {
      addGap(acc, a, b, "the run list carried no total_count, so its completeness cannot be checked");
      continue;
    }
    if (total > SEARCH_CAP && b - a > SECOND) {
      const mid = a + Math.floor((b - a) / 2 / SECOND) * SECOND;
      acc.splits++;
      stack.push([a, mid], [mid, b]);
      continue;
    }
    acc.ranges++;
    const expected = Math.min(total, SEARCH_CAP);
    const pages = Math.ceil(expected / PAGE_SIZE);
    const union = new Map();
    const take = (list, countRepeats) => {
      for (const r of Array.isArray(list) ? list : []) {
        if (r?.id == null) continue;
        const prev = union.get(r.id);
        if (prev && countRepeats) acc.duplicates_merged++;
        if (!prev || (r.run_attempt ?? 1) >= (prev.run_attempt ?? 1)) union.set(r.id, r);
      }
    };
    take(first.workflow_runs, true);
    let problem = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      problem = null;
      try {
        for (let page = attempt === 1 ? 2 : 1; page <= pages; page++) take(read(query(page))?.workflow_runs, attempt === 1);
      } catch (error) {
        problem = `a page of the run list could not be read: ${oneLine(error)}`;
        if (error?.kind === "rate-limit") {
          acc.halted = true;
          break;
        }
      }
      if (!problem && union.size === expected) break;
      problem ??= `${union.size} distinct runs were listed where the API counts ${expected}`;
    }
    if (total > SEARCH_CAP) problem = `${total} runs were created in one second and the API lists only ${SEARCH_CAP} of them`;
    if (problem) addGap(acc, a, b, problem);
    for (const r of union.values()) {
      const created = Date.parse(r.created_at);
      if (!(created >= a && created < b)) acc.dropped.outside_range++;
      else if (r.event !== "push") acc.dropped.not_push++;
      else if (r.head_branch !== "main") acc.dropped.not_main++;
      else if (r.path !== WORKFLOW_PATH) acc.dropped.other_workflow++;
      else {
        const prev = acc.byId.get(r.id);
        if (prev) acc.duplicates_merged++;
        if (!prev || (r.run_attempt ?? 1) >= prev.run_attempt) acc.byId.set(r.id, slimRun(r));
      }
    }
    log(`listed ${union.size} of ${expected} runs created ${zonedLabel(a)} .. ${zonedLabel(b)}`);
  }
  return acc;
}

/** Every push run created in [fromMs, toMs), newest first, with the listing's own account of itself. */
export function listPushRuns(read, repo, fromMs, toMs, { log } = {}) {
  const acc = collectRange(read, repo, fromMs, toMs, newListing(), log);
  return { ...acc, runs: [...acc.byId.values()].sort(newestFirst) };
}

/**
 * The newest `count` push runs created before `untilMs`, any count: windows of 1, 2, 4 ... days are read
 * backwards, each one completely, until there are enough or the repository's creation is reached.
 */
export function listNewestPushRuns(read, repo, count, { untilMs, floorMs = ACTIONS_EPOCH, log } = {}) {
  const acc = newListing();
  let to = floorSecond(untilMs);
  let span = DAY;
  while (acc.byId.size < count && to > floorMs && !acc.halted) {
    const from = Math.max(floorSecond(floorMs), to - span);
    collectRange(read, repo, from, to, acc, log);
    to = from;
    span *= 2;
  }
  return { ...acc, runs: [...acc.byId.values()].sort(newestFirst).slice(0, count), exhausted: acc.byId.size < count };
}

/**
 * Every event that moved main in [fromMs, toMs), from the repository's activity list (newest first,
 * paged by cursor), until an event older than `fromMs` proves the list reaches the window's start.
 */
export function listMainPushes(read, repo, fromMs, toMs) {
  const result = { events: [], reaches_start: false, pages: 0, error: null, error_kind: null };
  const seen = new Set();
  let path = `repos/${repo}/activity?ref=refs/heads/main&per_page=${PAGE_SIZE}`;
  try {
    while (path) {
      const page = read(path, { include: true });
      result.pages++;
      if (!Array.isArray(page?.body)) throw new ReadFailure("fatal", "the activity list is not a list");
      for (const ev of page.body) {
        if (ev?.id != null) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
        }
        const at = Date.parse(ev?.timestamp);
        if (!Number.isFinite(at)) continue;
        if (at < fromMs) {
          result.reaches_start = true;
          continue;
        }
        if (at >= toMs || !MOVES_BRANCH.includes(ev.activity_type) || !isSha(ev.after) || /^0+$/.test(ev.after)) continue;
        result.events.push({ id: ev.id, type: ev.activity_type, after: ev.after, at });
      }
      if (result.reaches_start) break;
      path = page.next;
    }
  } catch (error) {
    result.error = oneLine(error);
    result.error_kind = error?.kind ?? "fatal";
  }
  return result;
}

/** Match each push to main with the CI run of its head, and each run with its push. */
export function reconcile(events, runs, edges) {
  const heads = new Set(runs.map((r) => r.head_sha));
  const pushed = new Set(events.map((e) => e.after));
  const nearEdge = (ms) => edges.some((edge) => Math.abs(ms - edge) <= EDGE_MS);
  const lonePushes = events.filter((e) => !heads.has(e.after)).map((e) => ({ commit: e.after, type: e.type, at: zonedLabel(e.at), near_edge: nearEdge(e.at) }));
  const loneRuns = runs.filter((r) => !pushed.has(r.head_sha)).map((r) => ({ run: r.id, commit: r.head_sha, at: zonedLabel(Date.parse(r.created_at)), near_edge: nearEdge(Date.parse(r.created_at)) }));
  return {
    push_events: events.length,
    push_events_matched_to_a_run: events.length - lonePushes.length,
    pushes_without_ci_run: lonePushes.filter((x) => !x.near_edge),
    runs_without_push_event: loneRuns.filter((x) => !x.near_edge),
    near_window_edge: [...lonePushes, ...loneRuns].filter((x) => x.near_edge),
  };
}

/** A run's latest-attempt jobs, every page. `complete` is false when fewer came back than the API counts. */
function readJobs(read, repo, id) {
  const path = (page) => `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=${PAGE_SIZE}${page > 1 ? `&page=${page}` : ""}`;
  const first = read(path(1));
  if (!Array.isArray(first?.jobs)) throw new ReadFailure("fatal", "the jobs list is not a list");
  const jobs = [...first.jobs];
  const total = first.total_count;
  for (let page = 2; Number.isInteger(total) && jobs.length < total; page++) {
    const more = read(path(page))?.jobs;
    if (!Array.isArray(more) || more.length === 0) break;
    jobs.push(...more);
  }
  return { jobs, complete: Number.isInteger(total) ? jobs.length >= total : jobs.length < PAGE_SIZE };
}

/** The shadow verdict (or the 14 Oct dry run's word) a push run's step names carry, and its overhead. */
function verdictOf(jobs) {
  let seen = null;
  const overhead = [];
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
  return { seen, overhead };
}

const gapOut = (g) => ({ from: zonedLabel(g.from_ms), to: zonedLabel(g.to_ms), from_utc: isoSecond(g.from_ms), to_utc: isoSecond(g.to_ms), reason: g.reason });
const tally = (values) => values.reduce((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
const hours = (ms) => Math.round((ms / 3600000) * 100) / 100;

/**
 * THE REPORT. With no `limit` it reads the whole observation window; with a number, the newest `limit`
 * push runs. Every push run is counted from its step names, and the report says how complete it is:
 *   INCOMPLETE_RETRIEVAL   a read failed or a range could not be listed whole — the gaps are named
 *   EVIDENCE_UNAVAILABLE   everything was read, but some evidence no longer exists or does not match
 *                          (expired jobs, a push with no CI run, an activity list that ends too early)
 *   PARTIAL_OBSERVATION    complete so far, and the window is still open — the rest is not missing
 *   COMPLETE_OBSERVATION   the window has ended and every check below passed
 *   COMPLETE_RETRIEVAL     (newest-n) every one of the n runs and their jobs was read
 * Never throws for a read; what it could not read is in `retrieval` and `completeness_evidence`.
 * @param {number | null} [limit] the newest n push runs; null reads the observation window
 */
export function report(limit = null, { repo = readEnv().repo || DEFAULT_REPO, readGh = gh, sleep = sleepMs, clock = wallClock, maxRateWaitMs = MAX_RATE_WAIT_MS, window = OBSERVATION_WINDOW, log = () => {} } = {}) {
  const startedAt = clock();
  const { read, stats } = makeReader({ readGh, sleep, clock, maxRateWaitMs });
  const newest = Number.isInteger(limit) && limit > 0;
  let listing;
  let windowOut = null;
  let activity = null;
  let edges = [];
  let observationComplete = true;
  if (newest) {
    let floorMs = ACTIONS_EPOCH;
    try {
      const created = Date.parse(read(`repos/${repo}`)?.created_at);
      if (Number.isFinite(created)) floorMs = created;
    } catch {
      floorMs = ACTIONS_EPOCH;
    }
    listing = listNewestPushRuns(read, repo, limit, { untilMs: floorSecond(clock()) + SECOND, floorMs, log });
  } else {
    const startMs = zonedToUtc(window.start, window.zone);
    const endMs = zonedToUtc(window.end, window.zone);
    const readUntil = Math.max(startMs, Math.min(endMs, floorSecond(clock() - SETTLE_MS)));
    observationComplete = readUntil >= endMs;
    listing = listPushRuns(read, repo, startMs, readUntil, { log });
    activity = readUntil > startMs ? listMainPushes(read, repo, startMs, readUntil) : { events: [], reaches_start: true, pages: 0, error: null, error_kind: null };
    edges = [startMs, readUntil];
    windowOut = {
      zone: window.zone,
      bounds: "start-inclusive, end-exclusive",
      start: zonedLabel(startMs, window.zone),
      end: zonedLabel(endMs, window.zone),
      start_utc: isoSecond(startMs),
      end_utc: isoSecond(endMs),
      read_until: zonedLabel(readUntil, window.zone),
      hours_total: hours(endMs - startMs),
      hours_observed: hours(readUntil - startMs),
      hours_not_yet_observed: hours(endMs - readUntil),
      note: observationComplete
        ? "the window has ended"
        : `the window is still open: the hours not yet observed are future time, not missing data (runs from the last ${SETTLE_MS / 60000} minutes are read next time)`,
    };
  }

  const runs = listing.runs;
  const classes = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  const legacy = Object.fromEntries(LEGACY_VERDICTS.map((v) => [v, 0]));
  let none = 0;
  let noneInProgress = 0;
  let minutes = 0;
  const overhead = [];
  const falseEligible = [];
  const eligibleRunRedElsewhere = [];
  const unavailable = [];
  const unread = [];
  const partial = [];
  let halted = listing.halted;
  for (const [i, r] of runs.entries()) {
    if (halted) {
      unread.push(r.id);
      continue;
    }
    let jobs;
    try {
      const got = readJobs(read, repo, r.id);
      jobs = got.jobs;
      if (!got.complete) partial.push(r.id);
    } catch (error) {
      (error?.kind === "gone" ? unavailable : unread).push(r.id);
      if (error?.kind === "rate-limit") halted = true;
      continue;
    }
    if ((i + 1) % 50 === 0) log(`read the jobs of ${i + 1} of ${runs.length} runs`);
    const { seen, overhead: spent } = verdictOf(jobs);
    overhead.push(...spent);
    if (!seen) {
      none++;
      if (r.status !== "completed") noneInProgress++;
    } else if (seen.kind === "legacy") legacy[seen.word]++;
    else {
      classes[seen.decision]++;
      if (seen.decision === "ELIGIBLE_FOR_REUSE") {
        minutes += seen.minutes;
        if (r.status === "completed" && reusableJobsFailed(jobs)) falseEligible.push(r.id);
        else if (r.status === "completed" && r.conclusion !== "success") eligibleRunRedElsewhere.push(r.id);
      }
    }
  }

  const reconciliation = activity ? { ...reconcile(activity.events, runs, edges), reaches_start: activity.reaches_start, activity_pages: activity.pages, error: activity.error } : null;
  const withVerdict = CLASSES.reduce((s, c) => s + classes[c], 0);
  const completed = runs.filter((r) => r.status === "completed");
  const reruns = runs.filter((r) => r.run_attempt > 1);
  const activityUnread = Boolean(activity?.error) && activity.error_kind !== "gone";
  const checks = [
    { check: "every listed range returned exactly as many distinct runs as the API counts", ok: listing.gaps.length === 0, detail: listing.gaps.length ? `${listing.gaps.length} gap(s), named in retrieval.gaps` : `${listing.ranges} range(s), ${listing.splits} split(s) past the ${SEARCH_CAP}-result cap` },
    { check: "every run's jobs were read in full", ok: unread.length === 0 && partial.length === 0, detail: `${runs.length - unread.length - unavailable.length} of ${runs.length} read; ${unread.length} unread, ${partial.length} partly read` },
    { check: "no run's job evidence has expired", ok: unavailable.length === 0, detail: unavailable.length ? `${unavailable.length} run(s) no longer list their jobs` : "all present" },
  ];
  if (newest) checks.push({ check: `the newest ${limit} runs exist`, ok: true, detail: listing.exhausted ? `only ${runs.length} push runs exist in the whole history` : `${runs.length} read` });
  if (reconciliation) {
    checks.push(
      { check: "the push record was read", ok: !activity.error, detail: activity.error ?? `${activity.pages} page(s) of the activity list` },
      { check: "the push record reaches back past the window's start", ok: activity.reaches_start, detail: activity.reaches_start ? "an event older than the start was seen" : "the activity list ended before the window's start" },
      { check: "every push to main in the window has a CI run", ok: reconciliation.pushes_without_ci_run.length === 0, detail: `${reconciliation.push_events_matched_to_a_run} of ${reconciliation.push_events} matched (a [skip ci] push has none)` },
      { check: "every CI run in the window has a push to main", ok: reconciliation.runs_without_push_event.length === 0, detail: `${reconciliation.runs_without_push_event.length} without` },
    );
  }
  const retrievalIncomplete = listing.gaps.length > 0 || unread.length > 0 || partial.length > 0 || activityUnread;
  const evidenceMissing = checks.some((c) => !c.ok);
  const status = retrievalIncomplete
    ? "INCOMPLETE_RETRIEVAL"
    : evidenceMissing
      ? "EVIDENCE_UNAVAILABLE"
      : newest
        ? "COMPLETE_RETRIEVAL"
        : observationComplete
          ? "COMPLETE_OBSERVATION"
          : "PARTIAL_OBSERVATION";
  const verifiedComplete = !evidenceMissing;

  return {
    mode: newest ? `newest ${limit}` : "observation window",
    status,
    verified_complete: verifiedComplete,
    coverage: {
      observation: newest ? "not applicable (newest-n)" : observationComplete ? "complete" : "partial — the window is still open",
      retrieval: retrievalIncomplete ? "incomplete" : "complete",
      historical_evidence: unavailable.length > 0 || (reconciliation && (!activity.reaches_start || activity.error_kind === "gone")) ? "partly unavailable" : "available",
    },
    window: windowOut,
    examined: runs.length,
    classes,
    legacy,
    "no shadow": none,
    estimated_avoidable_minutes: minutes,
    false_eligible_runs: falseEligible,
    eligible_runs_red_outside_reusable_jobs: eligibleRunRedElsewhere,
    shadow_step_seconds: { n: overhead.length, median: median(overhead), max: overhead.length ? Math.max(...overhead) : null },
    pushes: {
      main_push_events: reconciliation ? reconciliation.push_events : null,
      push_runs: runs.length,
      with_shadow_verdict: withVerdict,
      without_shadow_verdict: { total: none + LEGACY_VERDICTS.reduce((s, v) => s + legacy[v], 0), legacy_dry_run_word: LEGACY_VERDICTS.reduce((s, v) => s + legacy[v], 0), no_verdict_step_finished_run: none - noneInProgress, no_verdict_step_yet_in_progress: noneInProgress },
      eligible: classes.ELIGIBLE_FOR_REUSE,
      not_eligible: classes.NOT_ELIGIBLE,
      insufficient_evidence: classes.INSUFFICIENT_EVIDENCE,
      safety_check_failed: classes.SAFETY_CHECK_FAILED,
      historical_data_unavailable_verdict: classes.HISTORICAL_DATA_UNAVAILABLE,
      missing_or_unavailable: { jobs_expired: unavailable, jobs_unread: unread, pushes_without_ci_run: reconciliation ? reconciliation.pushes_without_ci_run.length : null },
      completed_runs: completed.length,
      in_progress_runs: runs.length - completed.length,
      conclusions: tally(completed.map((r) => r.conclusion ?? "none")),
      failed_or_cancelled_runs: completed.filter((r) => ["failure", "cancelled", "timed_out", "startup_failure", "action_required"].includes(r.conclusion)).length,
      rerun_runs: reruns.length,
      extra_attempts: reruns.reduce((s, r) => s + r.run_attempt - 1, 0),
    },
    eligibility: {
      eligible: classes.ELIGIBLE_FOR_REUSE,
      judged: withVerdict,
      pct: withVerdict ? Math.round((classes.ELIGIBLE_FOR_REUSE / withVerdict) * 1000) / 10 : null,
      definitive: verifiedComplete && !retrievalIncomplete && observationComplete && !newest,
      note: "the share of push runs with a shadow verdict whose verdict was ELIGIBLE_FOR_REUSE; definitive only for a complete, finished window",
    },
    retrieval: {
      ranges_read: listing.ranges,
      range_splits: listing.splits,
      gaps: listing.gaps.map(gapOut),
      duplicates_merged: listing.duplicates_merged,
      dropped_by_local_filter: listing.dropped,
      jobs_unread: unread,
      jobs_partly_read: partial,
      stopped_by_rate_limit: halted,
    },
    historical_evidence: { jobs_expired: unavailable, activity_reaches_window_start: reconciliation ? activity.reaches_start : null },
    reconciliation,
    completeness_evidence: checks,
    api: { ...stats, elapsed_ms: Math.round(clock() - startedAt) },
  };
}

/**
 * Re-classify the last `limit` real pushes from history, read-only, and check each ELIGIBLE one against
 * what its own push run then did. `before` is the previous push's head (a push run exists for every push
 * to main); `forced` is not in the runs API and is taken as false, which the record says.
 */
export function replay(limit = 20, { repo = readEnv().repo || DEFAULT_REPO, readGit = run, readGh = gh, clock = () => performance.now(), wall = wallClock, sleep = sleepMs } = {}) {
  const { read } = makeReader({ readGh, sleep, clock: wall });
  let floorMs = ACTIONS_EPOCH;
  try {
    const created = Date.parse(read(`repos/${repo}`)?.created_at);
    if (Number.isFinite(created)) floorMs = created;
  } catch {
    floorMs = ACTIONS_EPOCH;
  }
  const listing = listNewestPushRuns(read, repo, limit + 1, { untilMs: floorSecond(wall()) + SECOND, floorMs });
  const runs = listing.runs;
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
    listing_complete: listing.gaps.length === 0,
    listing_gaps: listing.gaps.map(gapOut),
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
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const progress = (line) => process.stderr.write(`ci-tree-reuse: ${line}\n`);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = readEnv();
  try {
    if (process.argv.includes("--report")) {
      console.log(JSON.stringify(report(countArg("--report", null), { log: progress }), null, 2));
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
