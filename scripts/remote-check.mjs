#!/usr/bin/env node
//
// Run the heavy checks on the self-hosted CI box instead of this laptop.
//
// WHY THIS EXISTS
// ---------------
// AGENTS.md §5 and CLAUDE.md both say the same thing: a local typecheck does not FAIL on this
// machine, it gets KILLED. `tsc` over this repo needs 4.0-4.5 GB of heap against node's own ~4.1 GB
// default, and with the desktop app holding ~4.2 GB across its processes `mem-watchdog.ps1` reaps it
// as the largest node job. It prints nothing and exits non-zero, which a session cannot tell from a
// typo, so it tries the next spelling — 23 of 23 node kills in the watchdog's surviving log window
// were a typecheck. `.claude/hooks/bash-guard.mjs` clause C8 therefore refuses one outright.
//
// That left exactly one answer: push the branch and read the PR. It is the right answer for a change
// you are ready to open a PR for, and the wrong one for the fifteen times before that.
//
// This is the missing middle. It pushes the working commit straight to the CI box over SSH and runs
// the check THERE, where it takes 115s and has 7.7 GB plus 8 GB of swap to itself. Nothing heavy
// touches the laptop; no PR is opened; no Actions minutes are billed.
//
//   node scripts/remote-check.mjs typecheck
//   node scripts/remote-check.mjs lint test
//   node scripts/remote-check.mjs all          # lint, typecheck, unit suite, build (~7 min)
//   node scripts/remote-check.mjs lockfile     # regenerate pnpm-lock.yaml and bring it back
//
//   node scripts/remote-check.mjs test --wait 6    # box busy? ask again every 30s for 6 minutes
//   node scripts/remote-check.mjs all --free       # box busy? wait for it, and never bill Actions
//
// 🔴 THE BOX WHEN IT IS FREE, GITHUB ACTIONS WHEN IT IS BUSY **OR UNREACHABLE** (owner, 2026-10-08:
// *"if free use it directly but if busy use github actions"*, then *"make an unreachable box escalate
// to Actions too, not only a busy one"*). Several sessions share one 7,740 MB box, so a second run can
// never simply join it — and until 2026-10-06 the refusal was the END of the road, which left a finished
// branch retrying by hand while another session built. A bare invocation now probes the box and, on a
// busy answer OR no answer at all, dispatches ci.yml AT ONCE at ~14 billable Actions minutes against
// the box's zero. `--wait <minutes>` buys the old queue back for one call (VISIBLY — a line per poll,
// never a silent lock), `--free` waits ten minutes and never bills, `--no-wait --no-actions` refuses at
// once, and PHX_CHECK_WAIT_MINUTES=<n> sets the house default without a code change.
//
// 🔴 THE PROBE STILL FAILS CLOSED. An unreadable answer is never read as an IDLE BOX: `run` is
// unreachable from `probeKnown: false`, so nothing is ever started beside another session's build. What
// the ruling changed is the route out — the caller is handed Actions, which does not touch the box at
// all, instead of exit 2 and nothing.
//
// 🔴 WHY `lockfile` IS HERE, AND WHY IT IS NOT A CHECK. Until 2026-09-30 there was no sanctioned place
// in this setup to regenerate a lockfile at all. `.claude/hooks/bash-guard.mjs` clause C6 denies pnpm
// inside every linked worktree (node_modules there is a junction to the primary checkout's) and,
// unlike C7, C8, C10, C11 and C12, it has NO environment stand-down; the primary checkout belongs to
// whichever session is live in it; and cloud isolation was unavailable. So a branch that bumped
// package.json could not have its lockfile regenerated anywhere, and the gap was closed that night by
// an improvised SSH session — which worked, and which nothing would have caught had it gone wrong.
//
// This mode is that improvisation made repeatable. It runs `pnpm install --lockfile-only` on the box
// and returns BOTH pnpm-lock.yaml and pnpm-workspace.yaml — pnpm writes `minimumReleaseAgeExclude`
// into the second when it adopts a version younger than its release-age quarantine, and a
// --frozen-lockfile install needs those entries, so returning only the lockfile loses them silently.
// It is not a `CHECKS` entry because those are bash fragments in a pass/fail wrapper: a check can
// report a verdict and can never return a file.
//
// 🔴 IT SENDS THE COMMIT, NOT THE WORKING TREE. Uncommitted edits are not checked. Commit (or
// `git stash`-and-commit) first; the script prints the sha it actually ran so a stale result cannot
// be mistaken for a fresh one.
//
// 🔴 NO GITHUB CREDENTIAL IS PLACED ON THE BOX. It pushes over the SSH key you already use, into a
// bare repo owned by the runner user. The box never authenticates to GitHub for this, so losing the
// box does not leak repository access.
//
// 🔴 IT USES A DIRECTORY OF ITS OWN, NEVER THE RUNNER'S `_work`. A CI job owns that tree and cleans
// it between runs; sharing it would make a real CI run fail for reasons nobody could reproduce. If a
// CI job is running when you start, this warns — the box has 4 vCPU and a concurrent job will make
// both slower (see docs/ci-self-hosted-runner.md for the memory arithmetic: `tsc` alone peaks at
// 5.86 GB of 7,740 MB).
//
// 🔴 EVERY INVOCATION RUNS IN A TREE NOBODY ELSE CAN TOUCH. Until 2026-10-01 all of them shared one
// directory on the box, and a second session's checkout swapped the tree under a running check: it
// printed `box head: 19442c382` and then failed a typecheck on a file that commit has (TS6053) and
// passed a suite with the OTHER commit's file count. Each run now pushes to its own ref, works in its
// own `git worktree`, removes both on exit, and re-reads HEAD after every check — a run whose tree
// moved exits 3 with NO VERDICT. The account and the bash: scripts/remote-check-plan.mjs.
//
// 🔴 ONLY 0 AND 1 ARE VERDICTS, AND AN AUTOMATED CALLER MUST TREAT EVERYTHING ELSE AS "COULD NOT
// TELL" RATHER THAN AS A FAILURE. A FAIL blocks a push and is reported to the owner as "your code is
// broken", so a failure that is not the code's must never wear it:
//   0 PASS   1 FAIL (a check really failed)
//   2 the laptop could not start the run (no key, unreadable probe, busy box, failed dispatch)
//   3 the box's tree moved under the run      4 a stage was OOM-killed (137)
//   5 the ssh connection dropped (255)        6 nothing was dispatched / the Actions run told us nothing
//   7 the private tree or the install failed  8 the run was killed by a signal
//   9 a stage waited out the box's typecheck lock and never ran
// A NO-VERDICT run prints no `remote-check: PASS|FAIL — <sha>` line at all, because that line is what
// other tools parse (`a-verdict-line-without-its-sha-matches-an-older-run`).
//
// Host, user and key are overridable for when the box is replaced:
//   PHX_CHECK_HOST   default 46.225.184.142
//   PHX_CHECK_USER   default phx
//   PHX_CHECK_KEY    default ~/.ssh/railway_phoenix_ed25519

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUSY_POLL_SECONDS,
  EXIT_INTERRUPTED,
  EXIT_LOCK_TIMEOUT,
  EXIT_SETUP,
  FREE_WAIT_MINUTES,
  URGENT_WAIT_MINUTES,
  WAIT_MINUTES_ENV,
  buildBusyProbeScript,
  buildLockfileScript,
  buildRunScript,
  decideBusyAction,
  gradeActionsRun,
  gradeActionsStages,
  isProtectedDispatchRef,
  newRunId,
  parseBusyProbe,
  parseEscalation,
  runPaths,
  stageJobsFor,
  stagesNotRunBy,
} from "./remote-check-plan.mjs";

const HOST = process.env.PHX_CHECK_HOST || "46.225.184.142";
const USER = process.env.PHX_CHECK_USER || "phx";
const KEY = process.env.PHX_CHECK_KEY || path.join(os.homedir(), ".ssh", "railway_phoenix_ed25519");
const REMOTE_ROOT = "/home/" + USER + "/remote-check";
const BARE = REMOTE_ROOT + "/repo.git";
const PRELUDE = ["export PATH=/usr/local/lib/nodejs/node/bin:$PATH", "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0"];

// Each entry is the exact command the box runs, so a result here means the same thing a CI result
// means. It also takes ci.yml's typecheck lock (/tmp/phx-typecheck.lock), so it waits for a CI
// typecheck on the box instead of running beside it — two typechecks on this 7.7 GB box is what the
// lock exists to stop (owner, 2026-09-30).
//
// 🔴 THE TYPECHECK RUNS COLD, AND WITHOUT `--incremental false` THIS SCRIPT RETURNED A FALSE GREEN.
// `tsconfig.json` sets `"incremental": true`, and this box KEEPS its working directory between runs,
// so `tsc` reused `tsconfig.tsbuildinfo` and answered from the cache instead of rechecking. CI cannot
// do that — it checks out fresh, so it holds no build info and is cold by construction. Measured
// 2026-09-30: `PASS in 12s` here on b04b2e80a, whose required `checks` job then went RED on two
// TS2322 errors in test fixtures, and `PASS in 11s` on the commit that fixed them — against the
// ~112s a cold run takes. That is AGENTS.md §5 ("a warm incremental cache lies") arriving through the
// one tool that exists to REPLACE the local typecheck, which makes the false pass worse than no
// answer: it was trusted, and it sent a branch to CI believing it was clean.
//
// 🔴 `next typegen` RUNS FIRST, AS IT DOES IN ci.yml. Every run now gets a FRESH tree (see
// scripts/remote-check-plan.mjs), which holds no `.next/types` and no `next-env.d.ts` — so without
// typegen tsc would fail on route types CI generates. The old shared directory hid this the other way:
// it carried whatever `.next/types` an earlier run of SOME commit had left behind.
const CHECKS = {
  lint: "corepack pnpm run lint",
  // 🔴 A LOCK TIMEOUT HERE CANNOT BE TOLD FROM A TYPE ERROR BY ITS EXIT CODE — `flock -w` gives up
  // with exit 1, which is also `tsc`'s code for "there are type errors". The conflict is therefore
  // detected BEFORE the stage runs, by the lock probe buildRunScript puts in front of any stage whose
  // command starts with `flock -w <seconds> <file>` (remote-check-plan.mjs, LOCK_CONFLICT_EXIT).
  // Do not add `-E` here: tests/ci-typecheck-lock.test.ts pins this command's `flock -w <n> <lock>`
  // prefix, because the lock is shared with ci.yml's own Typecheck step and the two must not drift.
  //
  // 🔴 `--checkers 1` IS LOAD-BEARING TWICE, AND IS NOT A TUNING KNOB. `./node_modules/.bin/tsc` is
  // whichever TypeScript pnpm linked — 7 (the `typescript-native` alias, the gate since 2026-10-06)
  // or 5, which is still installed for typescript-eslint, Next and the editor. TypeScript 5 REFUSES
  // `--checkers`, so a tree where the alias went missing fails here loudly instead of quietly
  // answering with the old compiler and a PASS that does not predict `checks`. And the flag bounds
  // the memory: measured on this tree, the native compiler peaks at 6.45 GB with its default
  // checker-per-core and 5.06 GB with one — the latter is BELOW what tsc 5 already needed (5.8 GB),
  // which is what makes it safe to run beside a preview server on 7.7 GB. It costs ~20s and the run
  // is still ~5x faster than the compiler it replaced.
  //
  // NO `NODE_OPTIONS` ANY MORE: the heap flag was there because tsc 5 is a node program that could
  // OOM below node's default ceiling. The native compiler is a Go binary and does not read it;
  // leaving one would read as a memory guarantee nothing honours.
  typecheck:
    "flock -w 1200 /tmp/phx-typecheck.lock sh -c './node_modules/.bin/next typegen >/dev/null && ./node_modules/.bin/tsc --noEmit --incremental false --pretty false --checkers 1'",
  // Use CI's coverage-checked, CPU/memory-bounded shards on the box too. The stage stays `test`,
  // so callers and PASS/FAIL grading do not change; every registered test still has to run once.
  test: "corepack pnpm run test:sharded",
  // 🔴 THE BUILD TAKES THE TYPECHECK LOCK, BECAUSE CONTENTION IS WHAT KILLED IT — NOT ITS SIZE.
  //
  // It died `Killed` with exit 137 on 2026-10-04 — the kernel OOM killer, not a code error — during
  // "Collecting page data using 3 workers", AFTER `✓ Compiled successfully`, taking ~300s to die
  // where the measured figure was 112s. Exit 137 must never be read as a compile failure: the build
  // had already succeeded when it was killed.
  //
  // 🔴 THE OBVIOUS FIX WAS WRONG, AND IT IS WRITTEN DOWN HERE SO NOBODY PAYS FOR IT TWICE.
  // Capping `next build` looks like the answer and is not. Measured on the box 2026-10-05, four
  // runs, each sampled every 10s:
  //
  //     workers  heap cap   result        peak available  peak next-build RSS
  //     2        3072 MB    PASS 113s     307 MB          --
  //     2        2048 MB    PASS 118s     213 MB          --
  //     1        2048 MB    PASS 123s     215 MB          6455 MB
  //     3        none       PASS 118s     295 MB          6458 MB   <- the UNCAPPED control
  //
  // The uncapped control passes on an idle box, so neither cap was ever the fix. Both knobs are
  // inert here for the same reason: the "workers" are THREADS inside ONE `next-build` process
  // (`next-server` and `node` beside it read 5 MB and 2 MB), and its ~6.4 GB is Turbopack's native
  // Rust allocation, which `--max-old-space-size` does not bound at all and `experimental.cpus`
  // barely moves — 2 workers to 1 returned 2 MB and cost 5 seconds.
  //
  // What the numbers do say is that this build needs ~7.4 GB of a 7.7 GB box whatever you pass it.
  // It has no headroom, so it survives alone and dies beside anything substantial — which is
  // exactly the 2026-10-04 reading, ~300s to die against ~118s to finish. Three concurrent checks
  // have left this box at 250 MB available on their own.
  //
  // So the protection is the lock, not a number: the same `/tmp/phx-typecheck.lock` that ci.yml's
  // typecheck step and the typecheck above take. A build now WAITS for a typecheck instead of
  // racing it into the OOM killer. Do not "improve" this by adding PHX_BUILD_CPUS or NODE_OPTIONS
  // back — the table above is what happens, and ci.yml's `PHX_BUILD_CPUS: 4` is a different host
  // with a different failure (47 visible CPUs and a thread-spawn abort), not a precedent for this
  // one. Account: docs/ci-self-hosted-runner.md, "The build OOM was contention, not size".
  build: "flock -w 1200 /tmp/phx-typecheck.lock corepack pnpm run build",
};
// 🔴 `build` IS IN `all` BECAUSE IT IS THE ONE STAGE NOTHING ELSE EVER RUNS BEFORE `main`.
//
// A PR's CI does not build — ci.yml's Build step is gated off pull requests — so until this, the
// build first ran on the `main` commit itself, where a failure does not go red loudly: it makes
// Railway WITHHOLD the production deploy (AGENTS.md §2.3), which looks exactly like a successful
// one until `/api/healthz` `revision` is read. `all` leaving it out is how the exit-137 regression
// sat unnoticed: `all` was the thing sessions ran, and it could not see the broken stage.
//
// It goes LAST so the cheap verdicts print first; the runner does not stop at a failure, so this
// costs reading order only. Measured 2026-10-05 on the box: ~118s, taking `all` from roughly five
// minutes to seven. That is the price of the only pre-merge proof this stage has.
const ALL = ["lint", "typecheck", "test", "build"];

// 🔴 KEEPALIVES, BECAUSE A STAGE CAN BE SILENT FOR MINUTES AND A DROPPED CONNECTION LOOKS LIKE A
// FAILED BRANCH. `next build` prints nothing between "Collecting page data" and its summary, and a
// run that goes quiet is what a NAT or firewall idle timer reaps: measured 2026-10-05,
// `client_loop: send disconnect: Connection reset by peer` arrived after two stages had already
// passed, ssh exited 255, and the run was reported FAIL. ServerAliveInterval keeps the channel warm
// without any output of its own; CountMax 10 tolerates five minutes of a genuinely unreachable box
// before giving up, which is longer than any blip measured here and far short of hanging for ever.
const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=10",
  "-o", "TCPKeepAlive=yes",
  "-i", KEY,
];

// 🔴 GIT_SSH_COMMAND IS PARSED SHELL-STYLE, SO A WINDOWS KEY PATH IS DESTROYED BY IT. git splits the
// string and treats `\` as an escape, turning C:\Users\satoh\.ssh\id into `C:Userssatoh.sshid` — and
// the only symptom is `Permission denied (publickey)`, which reads as a key the server rejected
// rather than a key that was never opened. Forward slashes work on Windows git and everywhere else;
// the quotes cover a path with spaces.
const GIT_SSH_COMMAND =
  'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20 -i "' +
  KEY.replace(/\\/g, "/") +
  '"';

function die(message) {
  console.error("remote-check: " + message);
  process.exit(2);
}

/** A synchronous sleep, so the busy wait stays in this script's single straight line of control. */
function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, seconds) * 1000);
}

// ---------------------------------------------------------------------------------------------
// THE GITHUB ACTIONS FALLBACK (--actions / --urgent)
// ---------------------------------------------------------------------------------------------
// 🔴 THE OWNER'S POLICY, 2026-10-06, IN HIS OWN TERMS: "in critical situations, depend on GitHub
// Actions; in normal situations we are on the box to decrease the cost." The box is free and the
// default; this path exists for the case that kept costing real time — a finished branch parked
// behind another session's 7-minute run, with nothing to do but retry.
//
// WHAT IT COSTS, SAID OUT LOUD: a dispatch of ci.yml runs `validate` and `checks` exactly as a PR
// does, which is ~14 billable Actions minutes (GitHub rounds every job up to the whole minute), and
// on a workflow_dispatch `validate` also builds and smoke-tests the login — so it proves MORE than
// the box's `all`, not less. The box costs nothing, which is why it stays the default.
//
// 🔴 AND IT HAS TWO ROUTES, ONLY ONE OF WHICH BILLS (owner, 2026-10-08: *"make the open-PR refusal
// read that PR's checks instead of exiting 6"*). A branch with an open PR is ALREADY running these two
// jobs on this commit, already paid for, so that run is READ — `gh api`, no minutes, and a verdict
// instead of the exit 6 this arm used to end on. Only a branch with nothing running gets a dispatch.
// Both routes settle through ONE watcher (`settleActionsRun`), so there is a single allow-list of what
// counts as a verdict, and the run's own `event` picks the job map — a pull_request run puts the unit
// suite in `validate` and never builds at all.
//
// 🔴 IT DISPATCHES ON A REF AND THEREFORE VERIFIES THE SHA TWICE. `gh workflow run` takes a branch,
// not a commit, so it checks whatever origin holds for that branch: once BEFORE (refusing when the
// local commit is not what origin has) and once AFTER (`gradeActionsRun` refuses a run whose
// headSha is not this sha). Without both, a missing push turns "my code is green" into a statement
// about somebody else's commit.
//
// 🔴 PUSHING THE BRANCH IS FREE. ci.yml triggers on `pull_request` and on a push to `main` only, so
// pushing a feature branch runs nothing at all. That is why this refuses rather than pushing for
// you: the push is the session's act, and it bills nothing either way.
function runOnActions({ branch, sha, names, waitedSeconds, reason = "busy" }) {
  console.log("");
  // 🔴 THE LINE MUST NOT SAY "did not free in 0 min". Since the default wait became zero (owner,
  // 2026-10-08) the overwhelmingly common escalation has waited for nothing at all, and a report of a
  // nought-minute wait reads as a bug in the thing that just decided correctly.
  //
  // 🔴 AND IT MUST NAME WHICH OF THE TWO HAPPENED. "Busy" and "never answered" call for completely
  // different things from the reader — wait for a peer's run, or go and look at the box — and a line
  // that says BUSY about a box that is DOWN sends them to wait for a run that does not exist.
  //
  // 🔴 AND THE COST IS NOT CLAIMED HERE ANY MORE, BECAUSE THIS ROUTE DOES NOT ALWAYS BILL. Since
  // 2026-10-08 a branch with an open PR is ANSWERED BY READING that PR's run, which costs nothing, so
  // the "~14 billable minutes" line moved down to the dispatch it actually describes. A cost stated
  // before the decision that incurs it is the same defect as the nought-minute wait: a true-sounding
  // line about something that did not happen.
  const unreachable = reason === "unreachable";
  const blocked = unreachable ? "did not answer the probe (ssh failed, or no PROBE_OK)" : "is BUSY";
  console.log(
    waitedSeconds > 0
      ? "remote-check: the box " + (unreachable ? "never answered in " : "did not free in ") +
          Math.round(waitedSeconds / 60) + " min — going to GitHub Actions for this answer."
      : "remote-check: the box " + blocked + " — going to GitHub Actions for this answer at once. Pass " +
          "--wait <minutes> to queue for the box instead, or --free to wait " + FREE_WAIT_MINUTES +
          " min and never bill.",
  );
  if (unreachable) {
    console.log("remote-check: nothing was pushed to the box, and this is NOT read as an idle box — " +
      "check it with: ssh -i " + KEY + " " + USER + "@" + HOST + " true");
  }
  if (!branch || branch === "HEAD") {
    die("a detached HEAD cannot be dispatched — `gh workflow run` takes a branch. Put this commit on a branch first.");
  }

  // 🔴 AND IT IS NEVER DISPATCHED ON `main` — THAT COMMIT'S RUN IS THE PRODUCTION DEPLOY GATE.
  // ci.yml groups a non-PR run by SHA and never cancels one (`CI-<sha>`), so a dispatch from `main`
  // lands in the SAME concurrency group as the push run Railway's "Wait for CI" is holding the
  // production deploy on. There is nothing to gain either: `main` already runs the whole gate on
  // every commit — so, like the open-PR arm below, the answer is the run that exists. It is pointed
  // at rather than read: `remote-check` is invoked from a feature branch (committing on local `main`
  // is itself banned, AGENTS.md §2), and a session that lands here has a worktree to go to first.
  if (isProtectedDispatchRef(branch)) {
    console.error("remote-check: this is " + branch + ", and `main`'s own CI run is the production deploy gate.");
    console.error("    ci.yml groups a push to main by SHA and never cancels it, so a dispatch here joins that");
    console.error("    very run's concurrency group — the one Railway's \"Wait for CI\" holds the deploy on.");
    console.error("    main already runs the whole gate on this commit, so read THAT run:");
    console.error("      gh run list --workflow ci.yml --branch " + branch + " --limit 3");
    console.error("      gh run watch <id>");
    console.error("    For a check of your own, put the commit on a branch and run this from there.");
    console.error("remote-check: NO VERDICT — nothing was dispatched.");
    process.exit(6);
  }

  let remoteSha = "";
  try {
    const line = execFileSync("git", ["ls-remote", "origin", "refs/heads/" + branch], { encoding: "utf8" }).trim();
    remoteSha = line.split(/\s+/)[0] || "";
  } catch {
    die("could not read origin's copy of " + branch + " — nothing was dispatched.");
  }
  if (remoteSha !== sha) {
    console.error("remote-check: origin does not hold this commit, so a dispatch would check other code.");
    console.error("    local  " + sha.slice(0, 9) + "   (" + branch + ")");
    console.error("    origin " + (remoteSha ? remoteSha.slice(0, 9) : "absent"));
    console.error("");
    console.error("    Pushing the branch costs NO Actions minutes (ci.yml runs on a PR and on main only):");
    console.error("      git push -u origin " + branch);
    die(
      "push the branch, then re-run this — a busy box escalates on its own. Or open the PR: its " +
        "validate + checks ARE this fallback, on the same commit, for the same minutes.",
    );
  }

  // 🔴 AND IF THE BRANCH ALREADY HAS A PR, DISPATCHING WOULD PAY TWICE FOR ONE ANSWER — SO THIS READS
  // THAT PR'S OWN CHECKS INSTEAD OF STARTING A SECOND RUN. A PR runs the same two required jobs on
  // the same head commit, and that run is already billed (owner, 2026-09-27: one wide PR, every merge
  // costs ~28 billable CI minutes). Reading it costs no Actions minutes at all — it is `gh api`.
  //
  // 🔴 UNTIL 2026-10-08 THIS ARM PRINTED `gh pr checks <n> --watch` AND EXITED 6: NO VERDICT, with a
  // free, already-paid-for answer sitting on that very commit. That was survivable while the box was
  // waited out for ten minutes first, because the arm was rare — the same day's ruling made a busy box
  // escalate at ONCE, so it is now reached immediately, and by the time anything is pushed most
  // branches HAVE a PR. Owner's answer: *"make the open-PR refusal read that PR's checks instead of
  // exiting 6"*.
  //
  // 🔴 THE `try` WRAPS THE READ AND NOTHING ELSE. Putting the verdict watcher inside it would make any
  // bug in the watcher fall through its `catch` into the dispatch — billing ~14 minutes to recover
  // from an exception, which is the one outcome this whole arm exists to avoid.
  let openPr = "";
  try {
    openPr = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--jq", ".[].number"],
      { encoding: "utf8" },
    ).trim().split("\n")[0].trim();
  } catch {
    // No `gh`, no network, no permission: fall through to the dispatch rather than inventing a reason
    // to stop. A failed read is not evidence that no PR exists.
  }
  if (openPr) {
    console.log("remote-check: #" + openPr + " is already open on " + branch + ", and its `validate` and `checks`");
    console.log("    runs are the SAME two required jobs on this same commit — already billed. Reading them");
    console.log("    instead of dispatching beside them, which would pay twice for one answer.");
    console.log("      gh pr checks " + openPr + " --watch   (the same reading, by hand)");
    // Never returns: settleActionsRun exits 0, 1 or 6 on every path.
    settleActionsRun({
      find: () => findPullRequestRun(sha),
      sha,
      names,
      label: "#" + openPr + "'s own ci.yml run",
      source: "GitHub Actions — #" + openPr + "'s own run, not the box",
      hint: "    A pull request does not run the build; for that half, dispatch from a branch with no open PR.",
    });
  }

  // Nothing on GitHub holds an answer for this commit, so one has to be started — and THIS is where
  // the money is spent, which is why the cost is stated here rather than in the banner above. A
  // dispatch runs the whole workflow, so saying so keeps the output honest about what was proved: you
  // asked for a subset and you are getting lint + typecheck + the suite + a build + the login smoke.
  console.log(
    "remote-check: dispatching ci.yml — ~14 billable Actions minutes (the box is free, which is why it " +
      "is tried first; a branch with an open PR is read instead, for nothing).",
  );
  console.log(
    "remote-check: ci.yml runs its whole gate, so this proves MORE than the " +
      (names.length ? names.join(" + ") : "requested") + " you asked for, never less.",
  );

  const dispatchedAfter = new Date(Date.now() - 60_000).toISOString();
  try {
    execFileSync("gh", ["workflow", "run", "ci.yml", "--ref", branch], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").trim().split("\n").slice(-1)[0] || "";
    die("the dispatch itself failed: " + detail + " — nothing is running, so there is no verdict to wait for.");
  }
  console.log("remote-check: dispatched ci.yml on " + branch + " @ " + sha.slice(0, 9) + " — watching for its verdict");

  settleActionsRun({
    find: () => findDispatchedRun(sha, dispatchedAfter),
    sha,
    names,
    label: "the dispatched run",
    source: "GitHub Actions, not the box",
  });
}

/** How long either route waits for a run to settle, and how long between asks. */
const ACTIONS_WATCH_MINUTES = 25;
const ACTIONS_POLL_SECONDS = 20;

/**
 * 🔴 AND A RUN THAT NEVER APPEARS IS GIVEN UP ON LONG BEFORE THE SETTLE DEADLINE. A run object exists
 * the moment it is created, queued or not — a dispatch registers one immediately, and a PR's run is
 * created by the push that opened it. So "no run at all" does not become a run by waiting: it means
 * the dispatch produced nothing, or that commit's PR run was never created. Spending the full 25
 * minutes on that is 25 minutes of a session's wall clock for an answer that was already decided, and
 * the old open-PR arm's one virtue was that it ended immediately.
 */
const ACTIONS_APPEAR_MINUTES = 3;

/**
 * Watch ONE Actions run until it settles and grade the requested stages — the single allow-list BOTH
 * routes share, the dispatch and the already-open PR.
 *
 * 🔴 ONE ALLOW-LIST, BECAUSE A SECOND COPY OF A WATCHER IS HOW ONE OF THEM ROTS. The rule it encodes
 * is measured in this repository (`a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green`):
 * a loop that `continue`s on a LIST of unfinished states met a state that was on no list, fell out of
 * the loop, and printed its success line. So the only verdicts are an explicit `completed/success`
 * (pass) and an explicit `completed/failure` on the stage asked for (fail); everything else — queued,
 * cancelled, timed_out, skipped, a run that is about another sha, a job list that cannot be read, a
 * deadline reached — is NO VERDICT, which prints no `PASS|FAIL — <sha>` line for anything to parse.
 *
 * 🔴 AND A WHOLE-RUN `success` IS ONLY A PASS WHEN THE RUN ACTUALLY RAN EVERY STAGE ASKED FOR. A
 * dispatch does; a pull_request run never builds, so `stagesNotRunBy` has to be consulted before that
 * short circuit is taken, or an all-green PR would print PASS for a build that did not happen.
 *
 * It never returns: every path ends in `process.exit`.
 *
 * @param {{ find: () => { ok: boolean, run?: any }, sha: string, names: string[], label: string,
 *           source: string, hint?: string }} input
 *   `find` reads the run afresh each poll — `{ ok: false }` for a read that failed (not evidence either
 *   way), `{ ok: true, run: undefined }` for a run that has not appeared yet. `source` is the
 *   parenthetical on the verdict line, so a reader always knows which run answered.
 */
function settleActionsRun({ find, sha, names, label, source, hint }) {
  const started = Date.now();
  const deadline = started + ACTIONS_WATCH_MINUTES * 60 * 1000;
  const asked = names.length ? names.join(" + ") : "the requested stage";
  let last = "";
  let first = true;
  let sawRun = false;
  while (Date.now() < deadline) {
    // Read BEFORE the first sleep: a PR's checks are often already finished, and sleeping first would
    // spend 20 seconds not reading an answer that is sitting there.
    if (!first) sleepSeconds(ACTIONS_POLL_SECONDS);
    first = false;

    const read = find();
    if (!read.ok) {
      // A read that failed is not a verdict either way — say so and ask again.
      console.log("remote-check: could not read " + label + " this time — asking again");
      continue;
    }
    const run = read.run;
    if (run) sawRun = true;
    if (!sawRun && Date.now() - started > ACTIONS_APPEAR_MINUTES * 60 * 1000) {
      console.error("remote-check: NO VERDICT — no " + label + " exists for " + sha.slice(0, 9) + " after " +
        ACTIONS_APPEAR_MINUTES + " minutes, and a run is registered the moment it is created, queued or not.");
      if (hint) console.error(hint);
      process.exit(6);
    }
    const graded = gradeActionsRun(run, sha);
    if (!graded.settled) {
      if (graded.why !== last) {
        console.log("remote-check: " + label + " — " + graded.why + (run?.url ? "  " + run.url : ""));
        last = graded.why;
      }
      continue;
    }

    // 🔴 WHICH MAP GRADES THIS RUN IS READ OFF THE RUN'S OWN EVENT, never off the route that asked.
    // ci.yml puts the unit suite in `checks` on a dispatch and in `validate` on a pull request, and a
    // pull request never builds — so a map chosen by the caller's expectation would grade correctly
    // until the run it found was not the kind it assumed.
    const stageJobs = stageJobsFor(run?.event);
    const notRun = stagesNotRunBy(names, stageJobs);

    if (graded.verdict === "pass" && notRun.length === 0) {
      console.log("remote-check: " + label + " " + run.url + " — completed/success");
      console.log("remote-check: PASS — " + sha.slice(0, 9) + "  (" + source + ")");
      process.exit(0);
    }
    // A run about another commit is about another commit — there is nothing of ours in it to grade.
    if (run?.headSha && run.headSha !== sha) {
      console.error("remote-check: NO VERDICT — " + graded.why + (run?.url ? "  " + run.url : ""));
      process.exit(6);
    }

    // 🔴 THE RUN'S CONCLUSION IS NOT A VERDICT ABOUT THE STAGE THAT WAS ASKED FOR. ci.yml runs more
    // than this script is ever asked for — `mobile` (which reports and never gates), the Build, the
    // Playwright login smoke — so grading the run as one thing made `remote-check typecheck` FAIL on
    // a mobile lockfile break or a smoke flake, under this sha, blocking this push. Grade the job
    // (and the step) that actually runs the requested stage; a red job elsewhere is REPORTED, not
    // charged to this branch. A stage whose job did not run, or cannot be found, is NO VERDICT.
    const jobs = readRunJobs(run?.databaseId);
    const stages = gradeActionsStages(names, jobs, stageJobs);
    const elsewhere = stages.otherRed.length > 0 ? "  (red elsewhere in the run: " + stages.otherRed.join(", ") + ")" : "";
    console.log("remote-check: " + label + " " + run.url + " — completed/" + String(run.conclusion ?? "unknown"));
    if (stages.verdict === "pass") {
      console.log("remote-check: " + asked + " — " + stages.why + elsewhere);
      console.log("remote-check: PASS — " + sha.slice(0, 9) + "  (" + source + ")");
      process.exit(0);
    }
    if (stages.verdict === "fail") {
      console.error("remote-check: " + stages.why + elsewhere);
      console.error("remote-check: FAIL — " + sha.slice(0, 9) + "  (" + source + ")");
      process.exit(1);
    }
    // 🔴 A PARTIAL ANSWER SAYS WHICH HALF IT HAS. Reading a PR answers three of `all`'s four stages,
    // and a bare NO VERDICT about the build throws the other three away — which is what sends a
    // session off to bill a dispatch for work that is already green.
    if (stages.passed.length > 0) {
      console.log("remote-check: " + stages.passed.join(" + ") + " did pass on that run.");
    }
    console.error("remote-check: NO VERDICT — " + stages.why + elsewhere + (run?.url ? "  " + run.url : ""));
    if (hint) console.error(hint);
    process.exit(6);
  }
  console.error("remote-check: NO VERDICT — " + label + " had not settled after " + ACTIONS_WATCH_MINUTES + " minutes.");
  if (hint) console.error(hint);
  process.exit(6);
}

/**
 * The newest `workflow_dispatch` run of ci.yml ON THIS EXACT COMMIT that started after the dispatch.
 *
 * 🔴 ASKED BY SHA, NEVER SCANNED FROM `gh run list` — THE SAME RULE AS `findPullRequestRun`, AND IT
 * MATTERS MORE HERE, BECAUSE THIS IS THE ROUTE THAT HAS ALREADY SPENT THE MONEY. Until 2026-10-08
 * this one function still used `gh run list --branch`, the command the sibling below is explicitly
 * written against: that list is eventually consistent and has dropped a run that existed (AGENTS.md
 * §2.1, and the ship skill's phase 8). On the PR route a dropped run costs a wasted read. Here the
 * ~14 billable Actions minutes are ALREADY committed by the time the finder runs, and `sawRun` only
 * ever latches on a run the finder returned — so a list that omits the brand-new run for the first
 * three minutes of polling makes `settleActionsRun` exit 6 with the words *"no run exists for
 * <sha> after 3 minutes, and a run is registered the moment it is created, queued or not"*. That
 * sentence is true of the runs API and is what this now asks; it was never true of `gh run list`,
 * so the one message asserting the run cannot exist was produced by the one reader that can fail to
 * see it — and the dispatched run then completes, billed and unread.
 *
 * The `event` filter is load-bearing and is why this cannot simply reuse the PR finder: measured
 * 2026-10-08 on `15bacd57a`, ONE sha carried both a `pull_request` run and a `workflow_dispatch`
 * run of ci.yml, and the two are graded by different maps (`stageJobsFor`). `createdAt` still gates
 * on this invocation's own dispatch, so an EARLIER dispatch of the same sha is not mistaken for the
 * run we just started.
 *
 * `{ ok: false }` is a read that failed; `{ ok: true, run: undefined }` is "no run yet".
 */
function findDispatchedRun(sha, dispatchedAfter) {
  try {
    const json = execFileSync(
      "gh",
      ["api", "repos/{owner}/{repo}/actions/runs?head_sha=" + sha + "&per_page=30", "--jq",
        '[.workflow_runs[] | select(.path == ".github/workflows/ci.yml" and .event == "workflow_dispatch") ' +
          '| {databaseId: .id, headSha: .head_sha, status: .status, conclusion: .conclusion, ' +
          'url: .html_url, event: .event, createdAt: .created_at}]'],
      { encoding: "utf8" },
    );
    const runs = JSON.parse(json || "[]");
    const run = (Array.isArray(runs) ? runs : [])
      .filter((r) => r.createdAt >= dispatchedAfter)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return { ok: true, run };
  } catch {
    return { ok: false };
  }
}

/**
 * The newest `pull_request` run of ci.yml ON THIS EXACT COMMIT.
 *
 * 🔴 ASKED BY SHA, NEVER SCANNED FROM `gh run list`. That list is eventually consistent and has
 * dropped a run that existed in the minute another commit landed (AGENTS.md §2.1, and the ship
 * skill's phase 8 for the same reason) — which here would read as "the PR has no verdict" on a commit
 * that had already passed, and send the reader to bill a dispatch for an answer they already had. The
 * sha endpoint cannot return a run about another commit at all, which is the other half of the
 * guarantee `gradeActionsRun` makes by comparing headSha.
 *
 * `path` and `event` are both filtered: the same commit can carry a dispatched run, a push run and a
 * PR run, and only the PR run is the one that is already billed.
 */
function findPullRequestRun(sha) {
  try {
    const json = execFileSync(
      "gh",
      ["api", "repos/{owner}/{repo}/actions/runs?head_sha=" + sha + "&per_page=30", "--jq",
        '[.workflow_runs[] | select(.path == ".github/workflows/ci.yml" and .event == "pull_request") ' +
          '| {databaseId: .id, headSha: .head_sha, status: .status, conclusion: .conclusion, ' +
          'url: .html_url, event: .event, createdAt: .created_at}]'],
      { encoding: "utf8" },
    );
    const runs = JSON.parse(json || "[]");
    const run = (Array.isArray(runs) ? runs : []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return { ok: true, run };
  } catch {
    return { ok: false };
  }
}

/**
 * The jobs of one run, or null when they cannot be read.
 *
 * A failed read is NOT evidence about the code — `gradeActionsStages` turns a null into NO VERDICT
 * rather than inventing a pass or a fail from a run list that never arrived.
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

// 🔴 THE FIRST FAILURE ANYONE HITS IS A CHANGED HOST KEY, AND ITS RAW OUTPUT IS A WALL OF SHOUTING
// ABOUT A MAN-IN-THE-MIDDLE. On this box it has a dull cause: Hetzner rescue runs a DIFFERENT
// system with its own host key, so a `known_hosts` entry recorded while the box was in rescue does
// not match the installed OS afterwards — which is exactly how this one was provisioned
// (docs/ci-self-hosted-runner.md, the 2026-09-30 entry). Say so, and say how to check it is really
// that rather than assuming: compare the offered fingerprint against the key on the box's own disk.
function explainSshFailure(stderr) {
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr || "")) return null;
  return (
    "the box's SSH host key does not match ~/.ssh/known_hosts.\n" +
    "  On this host that is USUALLY a stale entry from Hetzner rescue, not an attack — rescue is a\n" +
    "  different system with its own key. VERIFY before trusting it, do not just delete the line:\n" +
    "    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i " + KEY + " " + USER + "@" + HOST + " \\\n" +
    "      'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'\n" +
    "  If that fingerprint equals the one ssh just offered, the host is genuine:\n" +
    "    ssh-keygen -R " + HOST + " && ssh-keyscan -t ed25519 " + HOST + " >> ~/.ssh/known_hosts\n" +
    "  If it does NOT match, stop and treat the host as compromised."
  );
}

// 🔴 `softFail` IS WHAT MAKES AN UNREACHABLE BOX ESCALATABLE AT ALL (owner, 2026-10-08). Without it
// this `die` fires BEFORE the probe's output is ever parsed, so `probeKnown: false` could only ever
// describe a box that ANSWERED but said nothing useful — and a box that is genuinely down, the case he
// named, still ended the invocation here at exit 2. The probe passes `softFail` and gets `null`, which
// `parseBusyProbe` reads as `known: false`; EVERY OTHER CALL still dies, because a failed ssh around
// the real run is the transport fault that must not wear a verdict (exit 5).
//
// The reason is still PRINTED on the soft path — a host-key change is the first failure anyone hits
// here and it must never be swallowed into a silent "box busy".
function ssh(script, { capture = false, softFail = false } = {}) {
  const args = [...SSH_OPTS, USER + "@" + HOST, "bash -s"];
  if (capture) {
    const run = spawnSync("ssh", args, { input: script, encoding: "utf8" });
    if (run.status !== 0) {
      const why = explainSshFailure(run.stderr) ||
        "ssh failed: " + String(run.stderr || "").trim().split("\n").slice(-3).join(" ");
      if (!softFail) die(why);
      console.error("remote-check: " + why);
      return null;
    }
    return String(run.stdout).trim();
  }
  return spawnSync("ssh", args, { input: script, stdio: ["pipe", "inherit", "inherit"] }).status ?? 1;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// 🔴 FLAGS ARE PARSED, NOT FILTERED AWAY. This line was `argv.filter((a) => !a.startsWith("-"))`,
// so `--urgnet` ran the plain behaviour and reported success — the same silent-ignore defect
// `scripts/rollup-prs.mjs` refuses by name. `parseEscalation` returns the positional arguments and
// every flag it did not recognise, and an unrecognised one dies here.
const escalation = parseEscalation(process.argv.slice(2));
if (escalation.unknown.length > 0) {
  die(
    "unknown flag(s): " + escalation.unknown.join(", ") + ". Known: --wait <minutes>, --actions, " +
      "--no-actions/--free, --no-wait, --urgent (= --wait " + URGENT_WAIT_MINUTES + " --actions, which " +
      "is also the default), and " + WAIT_MINUTES_ENV + "=<0-60>.",
  );
}
const requested = escalation.positional;

// `lockfile` is not a CHECKS entry and cannot be one: every CHECKS value is a bash fragment dropped
// into a `if <cmd>; then R=PASS; else R=FAIL` wrapper, so a check can only ever pass or fail. This
// mode has to bring two FILES back, which needs its own path. See the header.
const LOCKFILE_MODE = requested.length === 1 && requested[0] === "lockfile";

const names = LOCKFILE_MODE ? [] : requested.length === 0 || requested.includes("all") ? ALL : requested;
for (const name of names) {
  if (!CHECKS[name]) {
    die("unknown check '" + name + "'. Known: " + Object.keys(CHECKS).join(", ") + ", all, lockfile");
  }
}
if (requested.length > 1 && requested.includes("lockfile")) {
  die("`lockfile` regenerates files and cannot be combined with a check. Run it on its own, commit, then check.");
}

if (!existsSync(KEY)) die("no SSH key at " + KEY + ". Set PHX_CHECK_KEY.");

let sha;
let branch;
try {
  sha = git("rev-parse", "HEAD");
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  die("not inside a git repository");
}

// Say plainly what is NOT being checked, rather than letting a clean result imply more than it means.
const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
if (dirty.length > 0) {
  console.log("remote-check: " + dirty.length + " uncommitted change(s) are NOT included — checking " + sha.slice(0, 9) + " as committed:");
  for (const line of dirty.slice(0, 10)) console.log("    " + line);
  if (dirty.length > 10) console.log("    … and " + (dirty.length - 10) + " more");
  console.log("");
}

// 🔴 THE LOCKFILE MODE SENDS THE COMMIT, SO AN UNCOMMITTED MANIFEST WOULD REGENERATE THE WRONG
// LOCKFILE — and silently: it would come back resolving the versions package.json had at the last
// commit, not the ones you just typed, which reads as pnpm ignoring your bump. For a CHECK an
// uncommitted file only narrows what was proved (warned about above); here it corrupts the output.
if (LOCKFILE_MODE) {
  const manifests = dirty.filter((line) => /\s(package\.json|pnpm-workspace\.yaml)$/.test(line));
  if (manifests.length > 0) {
    console.error("remote-check: the manifests this would resolve FROM are uncommitted:");
    for (const line of manifests) console.error("    " + line);
    die("commit them first — this sends the commit, not the working tree, so the lockfile would be generated from the OLD manifests.");
  }
}

console.log("remote-check: " + (LOCKFILE_MODE ? "lockfile" : names.join(" + ")) + "  on " + USER + "@" + HOST);
console.log("             " + branch + " @ " + sha.slice(0, 9));

const runId = newRunId(sha);
const paths = runPaths(REMOTE_ROOT, runId);

// One round trip: create the bare repo if this is the first run, report whether CI is busy, and
// ask whether another remote-check run is already on the box.
const state = ssh(
  "set -e\n" +
    "mkdir -p " + REMOTE_ROOT + "\n" +
    "[ -d " + BARE + " ] || git init -q --bare " + BARE + "\n" +
    "if pgrep -f Runner.Worker >/dev/null 2>&1; then echo BUSY; else echo IDLE; fi\n" +
    buildBusyProbeScript(REMOTE_ROOT),
  // 🔴 THE PROBE IS THE ONE SOFT-FAILING SSH CALL — a box that is DOWN must reach the escalation rather
  // than die in the transport, which is the whole of the owner's 2026-10-08 ruling. It returns null here
  // and `parseBusyProbe` reads that as `known: false`.
  { capture: true, softFail: true },
);
if (state !== null && state.includes("BUSY")) {
  console.log("             ⚠ a CI job is running on the box — 4 vCPU shared, both will be slower");
}

// 🔴 REFUSE RATHER THAN QUEUE. The run-level lock inside the box script only binds runs launched
// from a branch that carries it, and `remote-check` runs the committed sha of whatever branch you
// invoke it from — so every session still on `main` takes no lock at all. Measured 2026-10-05: two
// unit suites on the box at once, this session's taking 1313s against 463s alone, and a build that
// wants ~7.4 GB of a 7,740 MB box was OOM-killed beside exactly that kind of company.
//
// A refusal, not a wait: a lock makes the second run sit silently for up to half an hour, which
// reads as a hang, and it cannot reach an older branch at all. Nothing has been pushed yet at this
// point, so refusing here costs the box nothing.
// 🔴 THE PROBE STILL FAILS CLOSED — WHAT CHANGED IS THE ROUTE OUT OF IT, NOT THE SAFETY (owner,
// 2026-10-08: *"make an unreachable box escalate to Actions too, not only a busy one"*). "No output" is
// an ssh that failed or a box that answered oddly, and it is NEVER read as an idle box: `decideBusyAction`
// cannot return `run` for `probeKnown: false`, so nothing is ever started beside another session's build.
// It used to `die` here at exit 2 with no verdict — on the one evidence that most argues FOR Actions,
// namely that the box cannot answer at all. Now it takes the busy routes: dispatch, or poll a budget
// (a dropped ssh is often a blip), or refuse under `--no-actions`.
const busy = parseBusyProbe(state);
// 🔴 AND SINCE 2026-10-08 A BUSY BOX IS NOT WAITED OUT EITHER — IT IS PAID FOR, IMMEDIATELY (owner:
// *"if free use it directly but if busy use github actions"*). `DEFAULT_WAIT_MINUTES` is 0, so a bare
// invocation probes, reads a busy answer and dispatches ci.yml on the spot rather than spending ten
// minutes of a session's time on the chance the box frees up — which the 2026-10-06 wait did, on an
// evening the box was three sessions deep for over 25 minutes. The old queue is still one flag away:
// `--wait <minutes>` polls VISIBLY (the objection was always to a SILENT wait, never to waiting),
// `--no-actions` (alias `--free`) polls for `FREE_WAIT_MINUTES` and never bills, `--no-wait` does not
// wait, and the last two together are the instant refusal the push guard asks for on every push.
const FORCED = process.env.PHX_CHECK_FORCE === "1";
let waitedSeconds = 0;
let plan = FORCED
  ? { action: "run", waitLeftSeconds: 0, reason: "free" }
  : decideBusyAction({
      busyRuns: busy.runs,
      waitedSeconds,
      waitMinutes: escalation.waitMinutes,
      actions: escalation.actions,
      probeKnown: busy.known,
    });
while (plan.action === "poll") {
  console.log(
    (plan.reason === "unreachable"
      ? "remote-check: box did not answer the probe (ssh failed, or no PROBE_OK)"
      : "remote-check: box busy (" + busy.runs.length + " run(s): " + busy.runs.join(", ") + ")") +
      " — asking again in " + BUSY_POLL_SECONDS + "s, " +
      Math.ceil(plan.waitLeftSeconds / 60) + " min of the wait left",
  );
  sleepSeconds(BUSY_POLL_SECONDS);
  waitedSeconds += BUSY_POLL_SECONDS;
  const again = parseBusyProbe(ssh(buildBusyProbeScript(REMOTE_ROOT), { capture: true, softFail: true }));
  busy.known = again.known;
  busy.runs = again.runs;
  plan = decideBusyAction({
    busyRuns: again.runs,
    waitedSeconds,
    waitMinutes: escalation.waitMinutes,
    actions: escalation.actions,
    probeKnown: again.known,
  });
}
if (plan.action === "actions" && !FORCED) {
  runOnActions({ branch, sha, names, waitedSeconds, reason: plan.reason });
}
// 🔴 THIS BLOCK IS GATED ON THE DECISION, NOT ON THE RUN LIST — an unreachable box has ZERO runs, so
// the old `busy.runs.length > 0` condition would have skipped the refusal entirely and FALLEN THROUGH
// TO THE PUSH on a box that never answered. The push itself would then fail, but after sending the sha
// and with a message about ssh rather than about the probe. `plan.action === "refuse"` is the only
// condition that covers both reasons, and `decideBusyAction` has exactly four actions, so a `refuse`
// that reaches here can never continue past this `die(`.
if (plan.action === "refuse" && !FORCED) {
  if (busy.runs.length > 0) {
    console.error("remote-check: the box is ALREADY running " + busy.runs.length + " remote-check run(s):");
    for (const run of busy.runs) console.error("    runs/" + run);
    console.error("");
    console.error("    A run whose ssh connection DIED keeps going on the box and keeps the lock — its");
    console.error("    sshd session stays alive, so nothing on the box can tell it is abandoned. If one of");
    console.error("    the runs above is yours and you know it was stranded, reap that one by its own");
    console.error("    directory (never a blanket pkill, which would take another session's live run):");
    console.error("");
    console.error("      ssh -i " + KEY + " " + USER + "@" + HOST + " \\");
    console.error("        'for p in /proc/[0-9]*; do d=$(readlink \"$p/cwd\" 2>/dev/null) || continue;" +
      " case \"$d\" in */runs/<RUN_ID>*) kill -KILL ${p#/proc/};; esac; done'");
  } else {
    console.error("remote-check: the box did not answer the probe — ssh failed, or it returned no PROBE_OK.");
    console.error("    Nothing was pushed, and this is NOT read as an idle box (the probe fails closed).");
    console.error("");
    console.error("    Ask it yourself:");
    console.error("      ssh -i " + KEY + " " + USER + "@" + HOST + " true");
  }
  console.error("");
  console.error("    You asked NOT to escalate, so this is the end of the road for this invocation:");
  console.error("      (default)          a box that is busy OR unreachable runs ci.yml on GitHub Actions " +
    "AT ONCE — ~14 billable minutes. You passed --no-actions/--free, which waits " + FREE_WAIT_MINUTES +
    " min and never bills.");
  console.error("      --wait <minutes>   keep asking the box, a line every " + BUSY_POLL_SECONDS + "s.");
  console.error("      " + WAIT_MINUTES_ENV + "=<n>  the same wait as the house default, for every call in this shell.");
  console.error("      PHX_CHECK_FORCE=1  start beside the other run anyway (this is what OOM-kills a build).");
  console.error("");
  die(
    plan.reason === "unreachable"
      ? "could not tell whether the box is busy — the probe did not finish. Nothing was pushed, and an " +
          "unreadable answer is never treated as an idle box. Drop --no-actions/--free to let the default " +
          "escalate to GitHub Actions, rather than hand-rolling a retry loop."
      : "not starting a second one. This box is 7,740 MB and a build alone wants ~7.4 GB of it, so a " +
          "concurrent run is how a check gets OOM-killed or reports a time that is really contention. " +
          "Drop --no-actions/--free to let the default escalate, rather than hand-rolling a retry loop.",
  );
}

try {
  execFileSync(
    "git",
    ["push", "--force", "--quiet",
      "ssh://" + USER + "@" + HOST + BARE,
      sha + ":" + paths.ref],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, GIT_SSH_COMMAND } },
  );
} catch {
  die("could not push to the box. Check SSH: ssh -i " + KEY + " " + USER + "@" + HOST);
}

// ── The lockfile mode, which returns FILES rather than a verdict ────────────────────────────────
//
// The return channel is a git ref in the box's own bare repo, deliberately, for two reasons. The
// obvious one is that `tests/remote-check.test.ts` asserts this script spawns nothing locally except
// `ssh` and `git`, so `scp` is out. The better one is that `ssh()`'s capture mode `.trim()`s what it
// reads, which would eat a YAML file's trailing newline and hand back a lockfile that differs from
// the one the box generated — a corruption nothing downstream would report.
if (LOCKFILE_MODE) {
  const outcome = ssh(buildLockfileScript({ remoteRoot: REMOTE_ROOT, runId, sha, prelude: PRELUDE }), {
    capture: true,
  });

  console.log(outcome.split("\n").filter(Boolean).map((line) => "             " + line).join("\n"));

  if (outcome.includes("NOCHANGE")) {
    console.log("\nremote-check: lockfile already matches the manifests at " + sha.slice(0, 9) + " — nothing to bring back.");
    process.exit(0);
  }
  if (!outcome.includes("REGENERATED")) {
    die("the box did not report a regenerated lockfile. Nothing was changed locally.");
  }

  try {
    execFileSync(
      "git",
      ["fetch", "--quiet", "ssh://" + USER + "@" + HOST + BARE, paths.resultRef],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, GIT_SSH_COMMAND } },
    );
    // Overwrites both files from the fetched commit. That is the intent here — but it IS the
    // "names a source AND a path" form that silently discards a local edit to those paths, which is
    // why the uncommitted-manifest refusal above runs before anything is sent.
    execFileSync("git", ["checkout", "FETCH_HEAD", "--", "pnpm-lock.yaml", "pnpm-workspace.yaml"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    die("could not bring the regenerated files back. The box has them on " + paths.resultRef + " in " + BARE + ".");
  }
  // The result ref was this run's alone; drop it so the box does not accumulate one per run.
  spawnSync("git", ["push", "--quiet", "ssh://" + USER + "@" + HOST + BARE, "--delete", paths.resultRef], {
    stdio: "ignore",
    env: { ...process.env, GIT_SSH_COMMAND },
  });

  console.log("\nremote-check: lockfile regenerated from " + sha.slice(0, 9) + " — pnpm-lock.yaml and pnpm-workspace.yaml are staged.");
  console.log("             Review the diff, commit, and let the PR's --frozen-lockfile install prove it.");
  process.exit(0);
}

const status = ssh(
  buildRunScript({
    remoteRoot: REMOTE_ROOT,
    runId,
    sha,
    prelude: PRELUDE,
    install: "corepack pnpm install --frozen-lockfile --reporter=silent",
    steps: names.map((name) => ({ name, command: CHECKS[name] })),
  }),
);

console.log("");
if (status === 3) {
  // same_tree fired: the tree under the run stopped being `sha`. Whatever the checks printed is about
  // some other commit, so this must never read as either a pass or a fail of this one.
  console.log("remote-check: NO VERDICT — the box's tree changed during the run; nothing above is about " + sha.slice(0, 9));
  process.exit(3);
}
if (status === 4) {
  // 🔴 A STAGE WAS OOM-KILLED (exit 137), AND THAT IS NOT A FAILURE OF THE CODE. The box is
  // 7,740 MB and the build alone wants about 7.4 GB of it, so a stage can be killed by whatever
  // else happens to be running there — another session's check, or the standing preview server.
  // Calling that FAIL is the cry-wolf failure: it blocks a push for a reason that is not true, and
  // a step people learn to override stops protecting anything. Nothing is claimed about this sha.
  console.log("remote-check: NO VERDICT — a stage was OOM-killed on the box (exit 137), so nothing above is a verdict on " + sha.slice(0, 9));
  console.log("             The box is shared. Run it again; this run already held the box lock, so something outside remote-check was using it.");
  process.exit(4);
}
if (status === EXIT_SETUP) {
  // 🔴 THE RUN NEVER STARTED, SO THERE IS NOTHING TO FAIL. A `git worktree add` that could not run,
  // or `pnpm install --frozen-lockfile` dying on the box, says something about the box's disk, its
  // pnpm store or its network — not about this commit. Both exited 1 until 2026-10-06 and printed
  // the `FAIL — <sha>` line, which blocked a push and sent a session looking for a type error in
  // code nothing had read. Same cry-wolf shape as the OOM kill.
  console.log("remote-check: NO VERDICT — the run could not be set up on the box (private tree or install), so nothing above is a verdict on " + sha.slice(0, 9));
  console.log("             Read the install output above: a full disk, a cold pnpm store or a registry blip are the usual causes.");
  process.exit(EXIT_SETUP);
}
if (status === EXIT_INTERRUPTED) {
  // 🔴 A SIGNAL IS NOT THE BRANCH. The box's memory watchdog, a reboot, or a `kill` aimed at a
  // stranded run all arrive as HUP/INT/TERM; the old `exit 130` fell through to the FAIL line.
  console.log("remote-check: NO VERDICT — the run on the box was interrupted by a signal, so nothing above is a verdict on " + sha.slice(0, 9));
  console.log("             Any stage that printed PASS above really did pass. Run it again when the box is quiet.");
  process.exit(EXIT_INTERRUPTED);
}
if (status === EXIT_LOCK_TIMEOUT) {
  // 🔴 A STAGE THAT WAITED OUT THE TYPECHECK LOCK NEVER RAN ITS COMMAND. `flock -w 1200` expiring
  // used to exit 1 — the same code `tsc` uses for type errors — so a box too contended to start the
  // typecheck reported the branch as broken. That is the busy box, which this script already
  // refuses to call a failure anywhere else.
  console.log("remote-check: NO VERDICT — a stage waited out the box's typecheck lock (20 min) and never ran, so nothing above is a verdict on " + sha.slice(0, 9));
  console.log("             Something else on the box holds /tmp/phx-typecheck.lock — a CI typecheck step, or another session's run.");
  process.exit(EXIT_LOCK_TIMEOUT);
}
if (status === 255) {
  // 🔴 255 IS SSH'S OWN "THE CONNECTION DIED" CODE, NOT A VERDICT ABOUT THE BRANCH. The generated
  // box script only ever exits 0, 1, 3, 4, 7, 8 or 9, so 255 can only have come from the transport — measured
  // 2026-10-05: `client_loop: send disconnect: Connection reset by peer` arrived after `lint PASS`
  // and `typecheck PASS`, and the run was reported as FAIL, which halted a push for a dropped TCP
  // connection. Same cry-wolf failure as the OOM kill, from the other end of the pipe.
  console.log("remote-check: NO VERDICT — the ssh connection to the box dropped (exit 255), so nothing above is a verdict on " + sha.slice(0, 9));
  console.log("             Any stage that printed PASS above really did pass.");
  // 🔴 THE REMOTE RUN SURVIVES THE DROP, AND SO DOES ITS LOCK. Measured 2026-10-05 on the run this
  // arm was written for: after the client died, four processes were still working under the run
  // directory with a LIVE `sshd-session` ancestor — the box had not noticed the client was gone, so
  // "the sshd is gone" is not a usable abandonment test either. A plain re-run therefore meets its
  // own predecessor and is refused by the busy probe above, which prints how to reap it.
  console.log("             The run is STILL GOING on the box and still holds the lock — a re-run will be refused");
  console.log("             by the busy probe, which prints how to reap that one run by its directory.");
  process.exit(5);
}
console.log(status === 0 ? "remote-check: PASS — " + sha.slice(0, 9) : "remote-check: FAIL — " + sha.slice(0, 9));
process.exit(status);
