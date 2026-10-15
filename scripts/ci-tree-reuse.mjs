#!/usr/bin/env node
// Would the PR's own checks have covered the tree a push to `main` just produced? — DRY RUN ONLY.
//
// WHY THIS EXISTS (owner, 2026-10-14, cost cuts: "build step 3 as a dry run"). A push to `main` bills
// about 12.3 minutes, of which `checks` (lint, typecheck, the unit suite) is 5.1. The PR run already
// ran exactly those on the PR's MERGE commit, so when the commit that lands on `main` has the very
// same TREE, the second run proves nothing new. Whether that happens often enough to matter is a
// measurement, not a guess: `main` moves every ~26 minutes, so a PR tested against an older `main`
// produces a different tree when it lands. This script measures it and changes NOTHING.
//
// WHAT IT DOES NOT DO — and must not be turned into without the owner's word:
//   * it never skips, shortens or reorders a step; every condition in ci.yml is untouched;
//   * it never fails the job: every path ends in a verdict, and the ci.yml step is continue-on-error;
//   * nothing reads its verdict to gate anything. tests/ci-tree-reuse-dryrun.test.ts pins that.
// The standing rule it sits beside: a step skipped because of what a diff touched is a gate with a
// list of exceptions (tests/ci-gate-parity.test.ts, two incidents). A tree comparison is not a diff
// classifier — equal trees are the same bytes — but turning it into a skip is a separate decision.
//
// HOW THE TWO RUNS MEET. The PR run records the tree it tested in the NAME of a step ("Tested tree
// <sha>", evaluated at run time), because a step name is readable from the jobs API with nothing but
// `actions: read`. The push run finds its PR from the `(#1234)` GitHub appends to a squash subject,
// takes that PR's final head, finds the green PR run for it, reads the name back, and compares it to
// `git rev-parse HEAD^{tree}`. The verdict is written as the NAME of the next step ("Tree reuse dry
// run MATCH"), so it can be counted later with `--report` without downloading a single log.
//
//   node scripts/ci-tree-reuse.mjs --dry-run      in ci.yml, on a push; writes verdict= to $GITHUB_OUTPUT
//   node scripts/ci-tree-reuse.mjs --report [n]   count the verdicts of the last n (default 40) push runs
//
// Pinned by tests/ci-tree-reuse-dryrun.test.ts.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "ci-tree-reuse",
  entry: import.meta.url,
  known: ["--dry-run", "--report"],
  hints: [
    "--dry-run is what ci.yml passes; --report [n] counts the verdicts of the last n push runs",
  ],
});

export const TESTED_TREE_PREFIX = "Tested tree ";
export const VERDICT_PREFIX = "Tree reuse dry run ";
export const VERDICTS = ["MATCH", "DIFFER", "UNKNOWN"];

const SHA_RE = /^[0-9a-f]{40}$/;

/** The PR number GitHub appends to a squash-merge subject, or `null`. */
export function prNumberFromSubject(subject) {
  const match = /\(#(\d{1,7})\)\s*$/.exec(String(subject ?? "").trim());
  return match ? Number(match[1]) : null;
}

/**
 * The tree a PR run recorded, read from the step names of its jobs, or `null`.
 * Only the `checks` job counts: it is the job a reuse would skip, and the recording step lives there.
 * Two different recorded trees in one run (a re-run attempt that re-merged) read as `null`.
 */
export function testedTreeFromJobs(jobs, jobName = "checks") {
  const found = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job?.name !== jobName) continue;
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      const name = String(step?.name ?? "");
      if (!name.startsWith(TESTED_TREE_PREFIX)) continue;
      const sha = name.slice(TESTED_TREE_PREFIX.length).trim();
      if (SHA_RE.test(sha)) found.add(sha);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * The dry-run verdict. Pure; never throws.
 * @returns {{ verdict: "MATCH" | "DIFFER" | "UNKNOWN", reason: string }}
 */
export function judge({ tree, tested, reason = "" }) {
  if (!SHA_RE.test(String(tree ?? ""))) return { verdict: "UNKNOWN", reason: reason || "this commit's tree is unreadable" };
  if (!SHA_RE.test(String(tested ?? ""))) return { verdict: "UNKNOWN", reason: reason || "the PR run recorded no tree" };
  return tree === tested
    ? { verdict: "MATCH", reason: "main's tree is byte-identical to the tree the PR's green run tested" }
    : { verdict: "DIFFER", reason: "main's tree differs from the tree the PR's green run tested (main moved, or a squash changed it)" };
}

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
}

const gh = (path) => JSON.parse(run("gh", ["api", path]));

/** Everything that can go wrong becomes UNKNOWN with the reason; nothing here may throw. */
export function dryRun({ repo = process.env.GITHUB_REPOSITORY, readGit = run, readGh = gh } = {}) {
  try {
    const tree = String(readGit("git", ["rev-parse", "HEAD^{tree}"])).trim();
    const subject = String(readGit("git", ["log", "-1", "--format=%s"])).trim();
    const pr = prNumberFromSubject(subject);
    if (!pr) return judge({ tree, tested: null, reason: "the commit subject carries no (#PR) number" });
    if (!repo) return judge({ tree, tested: null, reason: "GITHUB_REPOSITORY is not set" });

    const head = readGh(`repos/${repo}/pulls/${pr}`)?.head?.sha;
    if (!SHA_RE.test(String(head ?? ""))) return judge({ tree, tested: null, reason: `PR #${pr} has no readable head` });

    const runs = readGh(
      `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&status=success&per_page=5`,
    )?.workflow_runs;
    const prRun = Array.isArray(runs) ? runs[0] : null;
    if (!prRun?.id) return judge({ tree, tested: null, reason: `PR #${pr}'s final head has no green CI run` });

    const jobs = readGh(`repos/${repo}/actions/runs/${prRun.id}/jobs?per_page=50`)?.jobs;
    return judge({ tree, tested: testedTreeFromJobs(jobs), reason: "the green PR run recorded no tested tree (it predates the recording step)" });
  } catch (error) {
    return { verdict: "UNKNOWN", reason: `a read failed: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}` };
  }
}

/** Count the verdicts of the last `limit` push runs of ci.yml, from step names alone. */
export function report(limit = 40, { repo = process.env.GITHUB_REPOSITORY || "Gawish-1997/phoenix-people-workforce", readGh = gh } = {}) {
  const runs = readGh(`repos/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=${limit}`)?.workflow_runs ?? [];
  const counts = { MATCH: 0, DIFFER: 0, UNKNOWN: 0, "no dry run": 0 };
  for (const r of runs) {
    const jobs = readGh(`repos/${repo}/actions/runs/${r.id}/jobs?per_page=50`)?.jobs ?? [];
    let verdict = "no dry run";
    for (const job of jobs) {
      for (const step of job?.steps ?? []) {
        const name = String(step?.name ?? "");
        if (name.startsWith(VERDICT_PREFIX)) {
          const word = name.slice(VERDICT_PREFIX.length).trim();
          if (VERDICTS.includes(word)) verdict = word;
        }
      }
    }
    counts[verdict]++;
  }
  return { examined: runs.length, ...counts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes("--report")) {
      const n = Number(process.argv[process.argv.indexOf("--report") + 1]);
      const out = report(Number.isInteger(n) && n > 0 ? n : 40);
      console.log(JSON.stringify(out));
      const decided = out.MATCH + out.DIFFER;
      if (decided > 0) console.log(`match rate where decided: ${((out.MATCH / decided) * 100).toFixed(0)}% of ${decided}`);
    } else {
      const { verdict, reason } = dryRun();
      console.log(`tree-reuse dry run: ${verdict} - ${reason}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
    }
  } catch (error) {
    console.log(`tree-reuse dry run: UNKNOWN - ${String(error?.message ?? error).split("\n")[0]}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "verdict=UNKNOWN\n");
  }
  process.exit(0);
}
