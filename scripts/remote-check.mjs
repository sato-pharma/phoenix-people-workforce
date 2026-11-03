#!/usr/bin/env node
//
// Check a commit on GitHub Actions and print one verdict line — the same jobs the pull request runs, on
// GitHub's own runners, from a session that has no PR yet (or does not want to wait for the PR page).
//
// 🔴 GITHUB ACTIONS ONLY (owner, 2026-10-19: "retire the hetzner box and do not use it ever again, it is
// the source of slowness", and "make all ci actions to be on github … checks on one or ten or even 100 at
// the same time"). This script used to push the commit over SSH to a self-hosted CI box and run the check
// THERE, falling back to Actions when the box was busy. The box is retired and every trace of it is gone:
// no SSH, no key, no lock, no queue. Nothing here can wait on another session, because nothing here is
// shared — each invocation reads, or starts, ONE run on GitHub's runners, so any number of sessions can
// check any number of branches at once. The only ceiling is GitHub's concurrent-job cap on the account.
//
// WHY IT EXISTS AT ALL. AGENTS.md §5 and CLAUDE.md both say a local typecheck does not FAIL on this
// laptop, it gets KILLED (`tsc` needs 4.0-4.5 GB of heap and `mem-watchdog.ps1` reaps it silently), and
// `.claude/hooks/bash-guard.mjs` clause C8 refuses one outright. The answer is to push the branch and
// read the PR. This is that answer as a command, with a graded verdict a session can act on instead of
// a page to open.
//
//   node scripts/remote-check.mjs typecheck
//   node scripts/remote-check.mjs lint test
//   node scripts/remote-check.mjs all            # lint, typecheck, unit suite, build
//   node scripts/remote-check.mjs test --dispatch    # no PR yet: START a ci.yml run on the branch
//
// WHAT IT DOES, in this order:
//   1. The commit must be on origin (pushing a branch is free — ci.yml runs on a pull request and on a
//      push to `main` only, so a feature-branch push starts nothing). If it is not, it says so and stops.
//   2. If the branch has an open PR, READ that PR's own ci.yml run for this exact commit. It is already
//      running and already billed, so this costs nothing (`gh api`) — and it is the authoritative gate.
//   3. Else, if this commit already has a dispatched run, read that one — never a second one beside it.
//   4. Else, with `--dispatch` (aliases `--actions`, `--urgent`), START a ci.yml run on the branch with
//      `gh workflow run` (~14 billable minutes: it runs the whole workflow) and watch it.
//      Without the flag it stops at NO VERDICT and says to open the PR, whose checks run on this very
//      commit anyway.
//
// 🔴 IT ANSWERS AS SOON AS THE STAGES YOU ASKED FOR HAVE ANSWERED, NOT WHEN THE WHOLE RUN ENDS. A step's
// conclusion never changes once it is set, so `lint` is a verdict the moment `static`'s Lint step ends,
// while the build is still compiling. Asking for `all` still waits for every stage; asking for one does not
// pay for the others. A FAIL is reported the moment any asked-for stage fails.
//
// 🔴 THE PR'S OWN CI IS THE AUTHORITATIVE GATE; THIS IS AN OPTIONAL ACCELERATOR. Run it in the background
// (`run_in_background`) and act on the completion notification — never a foreground `until grep …; sleep`
// loop (bash-guard C14 refuses those) and never a foreground run (C15). Its last line is the one
// authoritative result: `remote-check: PASS — <sha9>`, `FAIL — <sha9>` or `NO VERDICT — … <sha9>`, and a
// finished verdict is also recorded per stage in `<git-common-dir>/phx-remote-check/<sha>.json`, which
// the push guard reuses instead of running anything itself.
//
// 🔴 IT GRADES THE JOB AND STEP THAT RUN THE STAGE, NEVER THE RUN. A dispatch also runs `mobile`, the
// Build and the login smoke, and a red one of those is somebody else's code: grading the run as a whole
// made `remote-check typecheck` FAIL on a mobile lockfile break. So a stage is graded from its own steps
// (scripts/remote-check-plan.mjs, STAGE_JOBS) and a red job elsewhere is REPORTED, not charged to you.
//
// 🔴 IT SENDS THE COMMIT, NOT THE WORKING TREE. Uncommitted edits are not checked; it warns and names
// them, and prints the sha it actually answered for so a stale result cannot be mistaken for a fresh one.
//
// 🔴 ONLY 0 AND 1 ARE VERDICTS, AND AN AUTOMATED CALLER MUST TREAT EVERYTHING ELSE AS "COULD NOT TELL"
// RATHER THAN AS A FAILURE. A FAIL blocks a push and is reported to the owner as "your code is broken", so
// a failure that is not the code's must never wear it:
//   0 PASS   1 FAIL (a stage really failed)
//   2 could not start: not a git repo, a bad flag, origin does not hold the commit, a refused or failed dispatch
//   6 NO VERDICT: nothing was started, no run appeared, the run was cancelled or about another commit, a
//     stage never ran, or the run had not settled within the watch window
// A NO-VERDICT ending prints no `remote-check: PASS|FAIL — <sha>` line at all, because that line is what
// other tools parse (`a-verdict-line-without-its-sha-matches-an-older-run`).
//
// `lockfile` — regenerate pnpm-lock.yaml (and pnpm-workspace.yaml) for a branch whose manifests changed.
// C6 denies pnpm inside every linked worktree, so a session cannot do it locally; this dispatches the
// Lockfile workflow, downloads what it produced and writes it into this checkout. See the header of
// .github/workflows/lockfile.yml.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RETIRED_FLAGS,
  STAGES,
  VERDICT_DIR_NAME,
  VERDICT_KEEP_DAYS,
  gradeActionsRun,
  gradeActionsStages,
  isProtectedDispatchRef,
  mergeVerdictRecord,
  parseArgs,
  stoppedNoVerdictLine,
} from "./remote-check-plan.mjs";

const CI_WORKFLOW = ".github/workflows/ci.yml";
const LOCKFILE_WORKFLOW = ".github/workflows/lockfile.yml";

/** How long a run is watched, how long between asks, and how long to wait for one to APPEAR. */
const WATCH_MINUTES = 25;
const POLL_SECONDS = 20;
const APPEAR_MINUTES = 3;
const LOCKFILE_WATCH_MINUTES = 10;

// The commit this run answers for, once it is known — null before `git rev-parse` and in the lockfile mode,
// which regenerates files and never claims a verdict. Set by the sha block below.
let verdictSha = null;

function die(message) {
  console.error("remote-check: " + message);
  // Exit 2 is "could not start", so say so — with the commit — rather than leave the output with no closing
  // `PASS|FAIL|NO VERDICT — <sha9>` line at all. Pinned in tests/remote-check.test.ts.
  if (verdictSha) console.error(stoppedNoVerdictLine(verdictSha));
  process.exit(2);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** A synchronous sleep, so the watch stays in this script's single straight line of control. */
function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
}

/**
 * Store what a FINISHED run proved about `sha`, per stage, in `<git-common-dir>/phx-remote-check/<sha>.json`
 * (remote-check-plan.mjs, "THE VERDICT RECORD"). `.claude/hooks/push-typecheck-guard.mjs` reads it instead
 * of starting anything itself. Called only on a PASS or FAIL ending, with only the stages that really
 * passed or failed — a NO VERDICT ending records nothing. Best effort: an unwritable record only means the
 * push guard has nothing to reuse.
 *
 * @param {string} commitSha the 40-char sha the run was about.
 * @param {Record<string, "PASS"|"FAIL">} stages
 * @param {string} source where the verdict came from.
 */
function recordVerdicts(commitSha, stages, source) {
  if (!stages || Object.keys(stages).length === 0) return;
  try {
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    const dir = path.join(common, VERDICT_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, commitSha + ".json");
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // no record yet, or an unreadable one — start fresh
    }
    const next = mergeVerdictRecord(previous, { sha: commitSha, stages, source, at: new Date().toISOString() });
    const tmp = file + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, file);
    for (const name of readdirSync(dir)) {
      const old = path.join(dir, name);
      if (Date.now() - statSync(old).mtimeMs > VERDICT_KEEP_DAYS * 24 * 60 * 60 * 1000) unlinkSync(old);
    }
  } catch {
    // best effort, see above
  }
}

/**
 * The newest run of ONE workflow, for ONE event, ON THIS EXACT COMMIT.
 *
 * 🔴 ASKED BY SHA, NEVER SCANNED FROM `gh run list`. That list is eventually consistent and has dropped a
 * run that existed in the minute another commit landed (AGENTS.md §2.1, and the ship skill's phase 8) —
 * which here would read as "this commit has no verdict" and send the reader to bill a dispatch for an
 * answer already there. The sha endpoint cannot return a run about another commit at all, which is the
 * other half of the guarantee `gradeActionsRun` makes by comparing headSha.
 *
 * `path` and `event` are both filtered: the same commit can carry a dispatched run, a push run and a PR
 * run, and only the one asked for is evidence here. `after` (ISO time) keeps an EARLIER dispatch of the
 * same sha from being mistaken for the one this invocation just started.
 *
 * `{ ok: false }` is a read that failed; `{ ok: true, run: undefined }` is "no run yet".
 */
function findRun({ sha, workflow, event, after = "" }) {
  try {
    const json = execFileSync(
      "gh",
      ["api", "repos/{owner}/{repo}/actions/runs?head_sha=" + sha + "&per_page=30", "--jq",
        '[.workflow_runs[] | select(.path == "' + workflow + '" and .event == "' + event + '") ' +
          "| {databaseId: .id, headSha: .head_sha, status: .status, conclusion: .conclusion, " +
          "url: .html_url, event: .event, createdAt: .created_at}]"],
      { encoding: "utf8" },
    );
    const runs = JSON.parse(json || "[]");
    const run = (Array.isArray(runs) ? runs : [])
      .filter((r) => r.createdAt >= after)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return { ok: true, run };
  } catch {
    return { ok: false };
  }
}

/**
 * The jobs of one run, or null when they cannot be read.
 *
 * A failed read is NOT evidence about the code — `gradeActionsStages` turns a null into NO VERDICT rather
 * than inventing a pass or a fail from a job list that never arrived.
 */
function readRunJobs(runId) {
  if (!runId) return null;
  try {
    const parsed = JSON.parse(execFileSync("gh", ["run", "view", String(runId), "--json", "jobs"], { encoding: "utf8" }));
    return Array.isArray(parsed?.jobs) ? parsed.jobs : null;
  } catch {
    return null;
  }
}

/**
 * Watch ONE run until the stages asked for have answered, and grade them — the single watcher every
 * route shares (an open PR's run, a run already dispatched for this commit, and one started just now).
 *
 * 🔴 ONE ALLOW-LIST, BECAUSE A SECOND COPY OF A WATCHER IS HOW ONE OF THEM ROTS. The rule it encodes is
 * measured in this repository (`a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green`): a
 * loop that `continue`s on a LIST of unfinished states met a state that was on no list, fell out of the
 * loop, and printed its success line. So the only verdicts are a stage whose own step says `success`
 * (pass) or `failure` (fail); everything else — queued, cancelled, timed_out, skipped, a run about another
 * sha, a job list that cannot be read, a deadline reached — is NO VERDICT, which prints no
 * `PASS|FAIL — <sha>` line for anything to parse.
 *
 * It never returns: every path ends in `process.exit`.
 *
 * @param {{ find: () => { ok: boolean, run?: any }, sha: string, names: string[], label: string,
 *           source: string, hint?: string, watchMinutes?: number }} input
 *   `find` reads the run afresh each poll — `{ ok: false }` for a read that failed (not evidence either
 *   way), `{ ok: true, run: undefined }` for a run that has not appeared yet. `source` is the
 *   parenthetical on the verdict line, so a reader always knows which run answered.
 */
function settle({ find, sha, names, label, source, hint, watchMinutes = WATCH_MINUTES }) {
  const started = Date.now();
  const deadline = started + watchMinutes * 60 * 1000;
  const asked = names.length ? names.join(" + ") : "the requested stage";
  let last = "";
  let first = true;
  let sawRun = false;
  while (Date.now() < deadline) {
    // Read BEFORE the first sleep: a PR's checks are often already finished, and sleeping first would
    // spend 20 seconds not reading an answer that is sitting there.
    if (!first) sleepSeconds(POLL_SECONDS);
    first = false;

    const read = find();
    if (!read.ok) {
      // A read that failed is not a verdict either way — say so and ask again.
      console.log("remote-check: could not read " + label + " this time — asking again");
      continue;
    }
    const run = read.run;
    if (run) sawRun = true;
    // 🔴 A RUN THAT NEVER APPEARS IS GIVEN UP ON LONG BEFORE THE WATCH DEADLINE. A run object exists the
    // moment it is created, queued or not, so "no run at all" does not become a run by waiting: it means
    // the dispatch produced nothing, or that commit's PR run was never created. Spending the full window
    // on that is wall clock for an answer already decided.
    if (!sawRun && Date.now() - started > APPEAR_MINUTES * 60 * 1000) {
      console.error("remote-check: NO VERDICT — no " + label + " exists for " + sha.slice(0, 9) + " after " +
        APPEAR_MINUTES + " minutes, and a run is registered the moment it is created, queued or not.");
      if (hint) console.error(hint);
      process.exit(6);
    }
    const state = gradeActionsRun(run, sha);
    // A run about another commit is about another commit — there is nothing of ours in it to grade.
    if (run?.headSha && run.headSha !== sha) {
      console.error("remote-check: NO VERDICT — " + state.why + (run?.url ? "  " + run.url : "") + " (" + sha.slice(0, 9) + ")");
      process.exit(6);
    }
    if (!run) {
      if (state.why !== last) {
        console.log("remote-check: " + label + " — " + state.why);
        last = state.why;
      }
      continue;
    }

    // Grade the stages from the run's own jobs on EVERY poll, finished or not: a step's conclusion never
    // changes once set, so an asked-for stage can be answered while the rest of the run is still going.
    const stages = gradeActionsStages(names, readRunJobs(run.databaseId));
    const elsewhere = stages.otherRed.length > 0 ? "  (red elsewhere in the run: " + stages.otherRed.join(", ") + ")" : "";
    if (stages.verdict === "pass") {
      console.log("remote-check: " + label + " " + run.url + " — " + (state.settled ? "completed/" + String(run.conclusion ?? "unknown") : "still running"));
      console.log("remote-check: " + asked + " — " + stages.why + elsewhere);
      recordVerdicts(sha, stages.stages, source);
      console.log("remote-check: PASS — " + sha.slice(0, 9) + "  (" + source + ")");
      process.exit(0);
    }
    if (stages.verdict === "fail") {
      console.log("remote-check: " + label + " " + run.url + " — " + (state.settled ? "completed/" + String(run.conclusion ?? "unknown") : "still running"));
      console.error("remote-check: " + stages.why + elsewhere);
      recordVerdicts(sha, stages.stages, source);
      console.error("remote-check: FAIL — " + sha.slice(0, 9) + "  (" + source + ")");
      process.exit(1);
    }
    if (state.settled) {
      // The run is over and an asked-for stage still has no answer: `pending` can no longer be waited for,
      // so it is NO VERDICT. 🔴 A PARTIAL ANSWER SAYS WHICH HALF IT HAS — three green stages of four are
      // worth reporting, and a bare NO VERDICT throws them away.
      console.log("remote-check: " + label + " " + run.url + " — completed/" + String(run.conclusion ?? "unknown"));
      if (stages.passed.length > 0) console.log("remote-check: " + stages.passed.join(" + ") + " did pass on that run.");
      console.error("remote-check: NO VERDICT — " + stages.why + elsewhere + "  " + run.url + " (" + sha.slice(0, 9) + ")");
      if (hint) console.error(hint);
      process.exit(6);
    }
    const progress = "status " + String(run.status || "unknown") + (stages.passed.length ? "; " + stages.passed.join(" + ") + " already passed" : "");
    if (progress !== last) {
      console.log("remote-check: " + label + " — " + progress + (run.url ? "  " + run.url : ""));
      last = progress;
    }
  }
  console.error("remote-check: NO VERDICT — " + label + " had not settled after " + watchMinutes + " minutes (" + sha.slice(0, 9) + ")");
  if (hint) console.error(hint);
  process.exit(6);
}

/** Start a workflow on a branch with `gh workflow run`, or die with the reason. */
function dispatchWorkflow(workflowFile, branch) {
  try {
    execFileSync("gh", ["workflow", "run", workflowFile, "--ref", branch], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim().split("\n").slice(-1)[0] || "";
    die("the dispatch itself failed: " + detail + " — nothing is running, so there is no verdict to wait for.");
  }
}

/** The origin copy of a branch must be this commit, or a dispatch would check other code. */
function requireOriginHolds(branch, sha) {
  let remoteSha = "";
  try {
    const line = execFileSync("git", ["ls-remote", "origin", "refs/heads/" + branch], { encoding: "utf8" }).trim();
    remoteSha = line.split(/\s+/)[0] || "";
  } catch {
    die("could not read origin's copy of " + branch + " — nothing was started.");
  }
  if (remoteSha !== sha) {
    console.error("remote-check: origin does not hold this commit, so GitHub would check other code.");
    console.error("    local  " + sha.slice(0, 9) + "   (" + branch + ")");
    console.error("    origin " + (remoteSha ? remoteSha.slice(0, 9) : "absent"));
    console.error("");
    console.error("    Pushing the branch costs NO Actions minutes (ci.yml runs on a PR and on main only):");
    console.error("      git push -u origin " + branch);
    die("push the branch (and open the PR — its checks run on this commit and are the verdict), then run this again.");
  }
}

// ---------------------------------------------------------------------------------------------
// FLAGS AND THE COMMIT
// ---------------------------------------------------------------------------------------------

// 🔴 FLAGS ARE PARSED, NOT FILTERED AWAY. This used to be `argv.filter((a) => !a.startsWith("-"))`, so
// `--urgnet` ran the plain behaviour and reported success — the silent-ignore defect
// `scripts/rollup-prs.mjs` refuses by name. And the retired box flags are refused BY NAME, so a
// muscle-memory `--wait 6` is told the box is gone instead of being ignored.
const parsed = parseArgs(process.argv.slice(2));
if (parsed.retired.length > 0) {
  die(
    parsed.retired.join(", ") + " belonged to the retired CI box (owner, 2026-10-19) and does nothing now. " +
      "There is no queue to wait in: an open PR's run is read at once, and `--dispatch` starts a run of its own. " +
      "Retired: " + RETIRED_FLAGS.join(", ") + ".",
  );
}
if (parsed.unknown.length > 0) {
  die("unknown flag(s): " + parsed.unknown.join(", ") + ". Known: --dispatch (aliases --actions, --urgent).");
}
const requested = parsed.positional;

// `lockfile` is not a stage and cannot be one: a stage reports pass or fail, and this has to bring two
// FILES back, which needs its own path. See the header.
const LOCKFILE_MODE = requested.length === 1 && requested[0] === "lockfile";
const names = LOCKFILE_MODE ? [] : requested.length === 0 || requested.includes("all") ? STAGES : requested;
for (const name of names) {
  if (!STAGES.includes(name)) {
    die("unknown check '" + name + "'. Known: " + STAGES.join(", ") + ", all, lockfile");
  }
}
if (requested.length > 1 && requested.includes("lockfile")) {
  die("`lockfile` regenerates files and cannot be combined with a check. Run it on its own, commit, then check.");
}

let sha;
let branch;
try {
  sha = git("rev-parse", "HEAD");
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  die("not inside a git repository");
}
if (!LOCKFILE_MODE) verdictSha = sha;

// Say plainly what is NOT being checked, rather than letting a clean result imply more than it means.
const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
if (dirty.length > 0) {
  console.log("remote-check: " + dirty.length + " uncommitted change(s) are NOT included — checking " + sha.slice(0, 9) + " as committed:");
  for (const line of dirty.slice(0, 10)) console.log("    " + line);
  if (dirty.length > 10) console.log("    … and " + (dirty.length - 10) + " more");
  console.log("");
}

console.log("remote-check: " + (LOCKFILE_MODE ? "lockfile" : names.join(" + ")) + "  on GitHub Actions");
console.log("             " + branch + " @ " + sha.slice(0, 9));

if (!branch || branch === "HEAD") {
  die("a detached HEAD cannot be checked — `gh workflow run` takes a branch. Put this commit on a branch first.");
}

// ---------------------------------------------------------------------------------------------
// THE LOCKFILE ROUTE
// ---------------------------------------------------------------------------------------------
if (LOCKFILE_MODE) {
  // 🔴 THE MODE SENDS THE COMMIT, SO AN UNCOMMITTED MANIFEST WOULD REGENERATE THE WRONG LOCKFILE — and
  // silently: it would come back resolving the versions package.json had at the last commit, not the ones
  // you just typed, which reads as pnpm ignoring your bump. For a CHECK an uncommitted file only narrows
  // what was proved (warned about above); here it corrupts the output.
  const manifests = dirty.filter((line) => /\s(package\.json|pnpm-workspace\.yaml)$/.test(line));
  if (manifests.length > 0) {
    console.error("remote-check: the manifests this would resolve FROM are uncommitted:");
    for (const line of manifests) console.error("    " + line);
    die("commit and push them first — this resolves the pushed commit, not the working tree, so the lockfile would be generated from the OLD manifests.");
  }
  if (isProtectedDispatchRef(branch)) {
    die("a lockfile is regenerated on a branch, never on " + branch + ". Put the manifest change on a branch first.");
  }
  requireOriginHolds(branch, sha);
  const after = new Date(Date.now() - 60_000).toISOString();
  dispatchWorkflow("lockfile.yml", branch);
  console.log("remote-check: dispatched lockfile.yml on " + branch + " @ " + sha.slice(0, 9) + " — waiting for it");

  const deadline = Date.now() + LOCKFILE_WATCH_MINUTES * 60 * 1000;
  let run;
  let waitedOnce = false;
  while (Date.now() < deadline) {
    if (waitedOnce) sleepSeconds(POLL_SECONDS);
    waitedOnce = true;
    const read = findRun({ sha, workflow: LOCKFILE_WORKFLOW, event: "workflow_dispatch", after });
    run = read.ok ? read.run : undefined;
    if (run?.status === "completed") break;
  }
  if (run?.status !== "completed") {
    die("the Lockfile run had not finished after " + LOCKFILE_WATCH_MINUTES + " minutes" + (run?.url ? ": " + run.url : "") + ".");
  }
  if (run.conclusion !== "success") die("the Lockfile run ended " + String(run.conclusion) + ": " + run.url);

  const scratch = mkdtempSync(path.join(os.tmpdir(), "phx-lockfile-"));
  try {
    execFileSync("gh", ["run", "download", String(run.databaseId), "--name", "lockfile", "--dir", scratch], { stdio: "pipe" });
    const root = git("rev-parse", "--show-toplevel");
    const changed = [];
    // The runtime image's two pin files come back too — lockfile.yml runs sync-runtime-extras after pnpm, because a
    // lockfile that moves puppeteer-core or sharp without them is red on tests/offer-pdf-runtime.test.ts.
    for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "infra/runtime-extras/package.json", "infra/runtime-extras/package-lock.json"]) {
      const produced = path.join(scratch, file);
      if (!existsSync(produced)) continue;
      const target = path.join(root, file);
      if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(produced, "utf8")) continue;
      copyFileSync(produced, target);
      changed.push(file);
    }
    if (changed.length === 0) {
      console.log("remote-check: lockfile — NOCHANGE: the committed lockfile already matches the manifests.");
    } else {
      console.log("remote-check: lockfile — wrote " + changed.join(", ") + " into " + root + ". Review the diff, then commit them:");
      console.log("      git add " + changed.join(" ") + " && git commit -m \"chore(deps): regenerate the lockfile\"");
    }
  } catch (error) {
    die("could not download the Lockfile run's artifact: " + String(error?.stderr || error?.message || error).trim().split("\n").slice(-1)[0]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// THE CHECK ROUTES
// ---------------------------------------------------------------------------------------------

// 🔴 `main` IS READ, NEVER DISPATCHED ON — THAT COMMIT'S RUN IS THE PRODUCTION DEPLOY GATE. ci.yml groups a
// non-PR run by SHA and never cancels one (`CI-<sha>`), so a dispatch from `main` lands in the SAME
// concurrency group as the push run Railway's "Wait for CI" is holding the production deploy on. There is
// nothing to gain either: `main` already runs the whole gate on every commit, so this reads that run.
// (Committing on local `main` is itself banned, AGENTS.md §2, so a session lands here only after a pull.)
if (isProtectedDispatchRef(branch)) {
  console.log("remote-check: " + branch + " — reading main's own CI run for this commit (the production deploy gate); nothing is dispatched.");
  settle({
    find: () => findRun({ sha, workflow: CI_WORKFLOW, event: "push" }),
    sha,
    names,
    label: "the push run on " + branch,
    source: "GitHub Actions — the push run on " + branch,
    hint: "    A push run exists only for a commit that has been pushed to " + branch + ".",
  });
}

requireOriginHolds(branch, sha);

// 🔴 A BRANCH THAT ALREADY HAS A PR IS READ, NOT DISPATCHED. A PR runs the same jobs on the same head
// commit, and that run is already billed (owner, 2026-09-27: one wide PR, every merge costs ~28 billable CI
// minutes; 2026-10-08: *"do not dispatch paid Actions runs when the PR's own CI gives the same verdict"*).
// Reading it costs no Actions minutes at all — it is `gh api`.
//
// 🔴 THE `try` WRAPS THE READ AND NOTHING ELSE. Putting the watcher inside it would make any bug in the
// watcher fall through its `catch` into a dispatch — billing ~14 minutes to recover from an exception,
// which is the one outcome this whole branch exists to avoid.
let openPr = "";
try {
  // REST, never `gh pr list`: that one is GraphQL, which a Claude Code cloud session is refused (HTTP 403,
  // measured 2026-11-03 on #11 — it read "no open PR" for a PR that existed and fell through to a dispatch).
  openPr = execFileSync(
    "gh",
    ["api", "repos/{owner}/{repo}/pulls?state=open&per_page=100&head={owner}:" + encodeURIComponent(branch), "--jq", ".[].number"],
    { encoding: "utf8" },
  ).trim().split("\n")[0].trim();
} catch {
  // No `gh`, no network, no permission: fall through rather than inventing a reason to stop. A failed
  // read is not evidence that no PR exists.
}
if (openPr) {
  console.log("remote-check: #" + openPr + " is open on " + branch + " — reading its own ci.yml run for this commit");
  console.log("    (already running and already billed; a dispatch beside it would pay twice for one answer)");
  settle({
    find: () => findRun({ sha, workflow: CI_WORKFLOW, event: "pull_request" }),
    sha,
    names,
    label: "#" + openPr + "'s own ci.yml run",
    source: "GitHub Actions — #" + openPr + "'s own run",
    hint: "    A pull request builds only when its diff can change a build; for the build itself, dispatch from a branch with no open PR.",
  });
}

// No PR. A run already dispatched for this exact commit is read rather than started again.
const existing = findRun({ sha, workflow: CI_WORKFLOW, event: "workflow_dispatch" });
if (existing.ok && existing.run && !["cancelled", "startup_failure", "skipped"].includes(String(existing.run.conclusion))) {
  console.log("remote-check: " + sha.slice(0, 9) + " already has a dispatched ci.yml run — reading it instead of starting a second");
  settle({
    find: () => findRun({ sha, workflow: CI_WORKFLOW, event: "workflow_dispatch" }),
    sha,
    names,
    label: "the dispatched run",
    source: "GitHub Actions — a dispatched run",
  });
}

// 🔴 NO PR AND NO `--dispatch`: STOP HERE, BILL NOTHING. The branch is already on origin (checked above),
// so the next step is the PR itself: its checks run on this same commit and are the authoritative gate.
if (!parsed.dispatch) {
  console.error("remote-check: " + branch + " has no open PR, and nothing is dispatched without --dispatch.");
  console.error("    Open the PR — its checks run on this same commit and ARE the verdict:");
  console.error("      gh pr create --fill --head " + branch);
  console.error("    Then this command reads that run for free. Or pass --dispatch to start a ci.yml run (~14 billable min).");
  console.error("remote-check: NO VERDICT — no PR exists yet for " + sha.slice(0, 9));
  process.exit(6);
}

// Nothing on GitHub holds an answer for this commit, so one has to be started — and THIS is where the money
// is spent, which is why the cost is stated here. A dispatch runs the whole workflow, so saying so keeps the
// output honest about what was proved: you asked for a subset and you are getting every job.
console.log("remote-check: dispatching ci.yml — ~14 billable Actions minutes (a branch with an open PR is read instead, for nothing).");
console.log("remote-check: ci.yml runs its whole gate, so this proves MORE than the " + names.join(" + ") + " you asked for, never less.");
const dispatchedAfter = new Date(Date.now() - 60_000).toISOString();
dispatchWorkflow("ci.yml", branch);
console.log("remote-check: dispatched ci.yml on " + branch + " @ " + sha.slice(0, 9) + " — watching for its verdict");
settle({
  find: () => findRun({ sha, workflow: CI_WORKFLOW, event: "workflow_dispatch", after: dispatchedAfter }),
  sha,
  names,
  label: "the dispatched run",
  source: "GitHub Actions — a dispatched run",
});
