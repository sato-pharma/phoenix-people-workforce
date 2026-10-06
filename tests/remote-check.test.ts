import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

import {
  BUSY_POLL_SECONDS,
  DEFAULT_WAIT_MINUTES,
  URGENT_WAIT_MINUTES,
  buildBusyProbeScript,
  buildRunScript,
  decideBusyAction,
  gradeActionsRun,
  newRunId,
  parseBusyProbe,
  parseEscalation,
  runPaths,
} from "../scripts/remote-check-plan.mjs";

// scripts/remote-check.mjs runs the heavy checks on the self-hosted CI box instead of this laptop.
// Its whole value is that NOTHING heavy executes locally, so the invariants worth pinning are about
// where work happens and what it touches — not about its output, which depends on a live host.
//
// 🔴 THIS TEST CANNOT REACH THE BOX AND MUST NOT TRY. A test that SSHes is a test that fails in CI,
// on a laptop with no key, and in a cloud session — and would then be "fixed" by deleting it. It
// reads the source instead, which is the right instrument for "this script never does X".
const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = readFileSync(path.join(ROOT, "scripts", "remote-check.mjs"), "utf8");
const PLAN_SRC = readFileSync(path.join(ROOT, "scripts", "remote-check-plan.mjs"), "utf8");

export async function runRemoteCheckTests(): Promise<void> {
  // 1 — it must never run a check locally. The point of the script is that `tsc` does not start on
  // a 16 GB laptop where mem-watchdog.ps1 reaps it silently (AGENTS.md §5, bash-guard C8). Every
  // check command must be inside the CHECKS table, which is only ever interpolated into the remote
  // bash script — never handed to a local spawn.
  //
  // 🔴 `gh` JOINED `ssh` AND `git` ON 2026-10-06, AND THE INVARIANT GOT STRONGER RATHER THAN WEAKER.
  // The Actions fallback (section 10) has to talk to GitHub — dispatch ci.yml, ask whether a PR is
  // already open, read a run's conclusion — and all three are API calls that cost this laptop nothing.
  // What must never appear is a HEAVY RUNNER, so that is now asserted by name as well: the allow-list
  // says what may run, and the ban below says what may not, whatever spelling it arrives in.
  const localRunners = SRC.match(/(?:execFileSync|spawnSync)\(\s*["'](?!ssh|git|gh)(\w+)["']/g) ?? [];
  assert.deepEqual(
    localRunners,
    [],
    "remote-check.mjs spawns something locally other than `ssh`, `git` and `gh`: " + localRunners.join(", ") +
      ". The entire purpose of this script is that heavy work runs on the box — a local spawn of " +
      "node/pnpm/tsc defeats it and reintroduces the silent OOM kill that C8 exists to prevent.",
  );
  const heavyRunners = SRC.match(
    new RegExp("(?:execFileSync|spawnSync)\\(\\s*[\"']?(pnpm|npm|yarn|npx|tsc|node|eslint|next|playwright)[\"']", "g"),
  ) ?? [];
  assert.deepEqual(heavyRunners, [], "a heavy runner is spawned locally: " + heavyRunners.join(", "));

  // 2 — the typecheck must carry the same heap CI gives it, or a PASS here does not predict CI.
  assert.ok(
    /max-old-space-size=6144[\s\S]*tsc --noEmit/.test(SRC),
    "the remote typecheck no longer matches ci.yml's `--max-old-space-size=6144`. A green result " +
      "here is only useful because it runs the same command the required `checks` job runs.",
  );

  // 2b — and it must run COLD, or the PASS is a cache read rather than a check. `tsconfig.json` sets
  // `"incremental": true`, and the box KEEPS its working directory between runs, so without this flag
  // `tsc` answers from `tsconfig.tsbuildinfo`. CI checks out fresh and is therefore cold by
  // construction — which is precisely why a warm pass here does not predict it. Measured 2026-09-30:
  // `PASS in 12s` on b04b2e80a, whose required `checks` job then went RED on two TS2322 errors,
  // against the ~112s a cold run takes. This finishes what assertion 2 promises: matching CI heap
  // does not make a green here mean what a green in CI means if the run never looked at the code.
  assert.ok(
    /tsc --noEmit[^"']*--incremental false/.test(SRC),
    "the remote typecheck no longer forces `--incremental false`. tsconfig sets `incremental: true` " +
      "and the box reuses its working directory, so tsc answers from tsconfig.tsbuildinfo and reports " +
      "a PASS for code it never rechecked — a false green in the one tool that exists to replace the " +
      "local typecheck (AGENTS.md §5: a warm incremental cache lies).",
  );

  // 2c — the build must take the SAME lock as the typecheck. It was killed with exit 137 on
  // 2026-10-04 during "Collecting page data", AFTER compiling successfully, and the cause was
  // CONTENTION rather than size: the uncapped build passes in ~118s on an idle box, but it needs
  // ~7.4 GB of this 7.7 GB machine to do it, so it dies beside anything substantial. Three
  // concurrent checks have left the box at 250 MB available on their own.
  //
  // 🔴 DO NOT REPLACE THIS WITH A CAP. PHX_BUILD_CPUS and --max-old-space-size were both
  // measured and both inert — the "workers" are threads inside ONE next-build process and its
  // memory is Turbopack's native allocation, so 2 workers to 1 returned 2 MB and cost 5s. The four
  // runs are tabulated above the CHECKS entry; the lock is the only thing that changed the failure
  // mode, so it is the only thing asserted.
  const buildCmd = SRC.match(/^\s*build:\s*"([^"]+)"/m)?.[1] ?? "";
  assert.ok(buildCmd !== "", "tests/remote-check.test.ts can no longer find the `build` entry in the CHECKS table.");
  assert.ok(
    /flock -w \d+ \/tmp\/phx-typecheck\.lock/.test(buildCmd),
    "the remote build no longer takes /tmp/phx-typecheck.lock. ci.yml's typecheck step and the " +
      "typecheck above both take it; without it a build races a typecheck on a 7.7 GB box, which " +
      "is the OOM kill (exit 137) this lock exists to prevent. Command read: " +
      JSON.stringify(buildCmd),
  );

  // 2e — and `all` must INCLUDE the build. This is the one stage nothing else runs before `main`:
  // ci.yml's Build step is gated off pull requests, so without it here the build first executes on
  // the `main` commit, where a failure does not go red loudly — it makes Railway WITHHOLD the
  // production deploy (AGENTS.md §2.3), which is indistinguishable from a successful one until
  // `/api/healthz` `revision` is read. `all` omitting it is how the exit-137 regression went
  // unnoticed: `all` was what sessions ran, and it could not see the broken stage.
  const allList = SRC.match(/^const ALL = \[([^\]]*)\]/m)?.[1] ?? "";
  assert.ok(
    /"build"/.test(allList),
    "`all` no longer includes the build. A PR's CI never builds, so dropping it here leaves the "
      + "stage with NO pre-merge proof at all, and a failure first appears as a withheld production "
      + "deploy rather than as a red check. ALL read: [" + allList + "]",
  );
  for (const name of ["lint", "typecheck", "test"]) {
    assert.ok(
      new RegExp('"' + name + '"').test(allList),
      "`all` no longer includes " + name + " — ALL read: [" + allList + "]",
    );
  }

  // 3 — it must not use the runner's own working directory. A CI job owns ~/actions-runner/_work
  // and cleans it between runs; sharing it makes a real CI run fail for reasons nobody can
  // reproduce, and a persistent runner already has stale-state hazards of its own.
  assert.ok(
    !/actions-runner[^"']*_work/.test(SRC),
    "remote-check.mjs points at the runner's _work directory. Use its own directory — a CI job " +
      "owns that tree, and a concurrent checkout there corrupts a required check.",
  );

  // 4 — no GitHub credential may be placed on the box. It pushes over SSH into a bare repo, so the
  // box never authenticates to GitHub and losing the box does not leak repository access.
  assert.ok(
    !/GH_TOKEN|GITHUB_TOKEN|gh auth|https:\/\/[^"'\s]*@github\.com/.test(SRC),
    "remote-check.mjs would put a GitHub credential on the CI box. It must push over SSH into a " +
      "bare repo instead: the box is shared infrastructure and holds repository-level trust already.",
  );

  // 5 — it must say what it did NOT check. It sends the committed sha, so uncommitted edits are
  // invisible; a clean PASS that silently ignored the working tree is the failure mode that makes
  // a tool like this actively dangerous.
  assert.ok(
    /status", "--porcelain/.test(SRC) && /NOT included/.test(SRC),
    "remote-check.mjs no longer warns about uncommitted changes. It checks the COMMIT, so a dirty " +
      "tree means the PASS refers to code that is not what the developer is looking at.",
  );

  // 6 — the exit code must be the check's own, or a script wrapper turns every failure green. This
  // repo has been bitten by exactly that shape before (a pipeline reporting its last stage's 0).
  assert.ok(
    /process\.exit\(status\)/.test(SRC),
    "remote-check.mjs no longer exits with the remote status. A wrapper that always exits 0 makes " +
      "a failing typecheck read as a pass.",
  );

  // 7 — every invocation gets a tree of its own. Until 2026-10-01 they all shared
  // ~/remote-check/work and one `remote-check` branch, so a second session's checkout swapped the tree
  // under a running check: 19442c382 printed its own `box head`, failed a typecheck with TS6053 on a
  // file that commit HAS, and passed a suite with the OTHER commit's file count (2,085 against CI's
  // 2,086). The shared directory, the shared branch and the `|| git checkout FETCH_HEAD` fallback
  // (which ran whatever the shared branch held when the sha was missing) must not come back.
  assert.ok(
    !/REMOTE_ROOT \+ "\/work"/.test(SRC) && !/refs\/heads\/remote-check"/.test(SRC),
    "remote-check.mjs is back on one shared directory or one shared branch for every invocation — " +
      "two sessions then check out over each other mid-run and the verdict is about the wrong commit.",
  );
  assert.ok(
    !/checkout -q -f/.test(SRC) && /worktree add -q --detach "\$RUN" "\$WANT"/.test(PLAN_SRC),
    "the box script checks a commit out in place again. Each run must `git worktree add` exactly its " +
      "own sha into its own directory.",
  );
  assert.ok(
    /sha \+ ":" \+ paths\.ref/.test(SRC) && /buildRunScript\(/.test(SRC) && /buildLockfileScript\(/.test(SRC),
    "remote-check.mjs must push to the per-run ref and run BOTH modes through remote-check-plan.mjs.",
  );
  assert.ok(
    /status === 3[\s\S]*NO VERDICT[\s\S]*process\.exit\(3\)/.test(SRC),
    "remote-check.mjs no longer turns the tree guard's exit 3 into NO VERDICT — a swapped tree would " +
      "print PASS or FAIL for a commit it never checked.",
  );

  // 7b — THE BOX IS ASKED WHETHER IT IS BUSY, AND THE ANSWER FAILS CLOSED.
  //
  // The run-level lock cannot bind a branch cut before it existed, because remote-check runs the
  // committed sha of whatever branch you invoke it from. The probe is what reaches those runs: it
  // resolves /proc/*/cwd, so it sees ANY version of this script, which all `cd` into runs/<id>.
  {
    const probe = buildBusyProbeScript("/home/phx/remote-check");
    assert.match(probe, /\/proc\/\[0-9\]\*/, "the probe must read /proc, so it sees runs older than this code");
    assert.match(probe, /\/home\/phx\/remote-check\/runs\//, "the probe must look under this box's runs directory");
    assert.match(probe, /echo PROBE_OK/, "the probe must mark its own completion, or a failed ssh reads as an idle box");
    assert.ok(
      !/pgrep|lsof|fuser/.test(probe),
      "the probe must not depend on a lock file or a process-name match — neither sees a run from an older branch",
    );

    // An idle box: the marker, no runs.
    assert.deepEqual(parseBusyProbe("PROBE_OK\n"), { known: true, runs: [] });
    // Two processes of ONE run are one run, not two.
    assert.deepEqual(
      parseBusyProbe("RUN abc12345-aaa-bbbb 100\nRUN abc12345-aaa-bbbb 220\nPROBE_OK\n"),
      { known: true, runs: ["abc12345-aaa-bbbb"] },
    );
    assert.deepEqual(
      parseBusyProbe("RUN bbb12345-aaa-bbbb 1\nRUN aaa12345-aaa-bbbb 2\nPROBE_OK\n").runs,
      ["aaa12345-aaa-bbbb", "bbb12345-aaa-bbbb"],
    );
    // 🔴 FAIL CLOSED. Every one of these is "I could not tell", never "the box is free".
    for (const [label, text] of [
      ["empty output", ""],
      ["ssh wrote nothing but an error", "ssh: connect to host ... port 22: Connection timed out"],
      ["runs listed but the probe never finished", "RUN abc12345-aaa-bbbb 100\n"],
      ["not a string at all", null],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      assert.equal(
        parseBusyProbe(text as string).known,
        false,
        label + " must read as UNKNOWN, never as an idle box",
      );
    }
  }
  assert.match(
    SRC,
    /parseBusyProbe\(state\)[\s\S]{0,600}?!busy\.known[\s\S]{0,400}?die\(/,
    "remote-check.mjs does not refuse on an unreadable probe, so a failed ssh would read as a free box",
  );
  // 🔴 THE REFUSAL MOVED BEHIND `decideBusyAction` ON 2026-10-06 AND MUST STILL END IN `die(`. The
  // escalation (section 10) added two other routes out of a busy box, and the risk it introduces is
  // precisely that the no-flag path quietly becomes "carry on anyway" — which is what OOM-kills a
  // build. So this pins the whole chain: the plan is computed from the probe, the override is read
  // once into FORCED, and the plan that is neither a wait nor an escalation reaches `die(`.
  assert.match(
    SRC,
    /const FORCED = process\.env\.PHX_CHECK_FORCE === "1"/,
    "the PHX_CHECK_FORCE override is gone — a busy box would have no escape hatch",
  );
  assert.match(
    SRC,
    /decideBusyAction\(\{[\s\S]{0,400}?busyRuns: busy\.runs/,
    "the busy decision is no longer computed from the probe's own run list",
  );
  assert.match(
    SRC,
    /busy\.runs\.length > 0 && plan\.action !== "run" && !FORCED[\s\S]{0,3000}?die\(/,
    "remote-check.mjs does not refuse when the box already has a run, or has lost its override",
  );
  assert.ok(
    SRC.indexOf("parseBusyProbe(state)") < SRC.indexOf("git\",\n    [\"push\""),
    "the busy check must run BEFORE the sha is pushed, so a refusal costs the box nothing",
  );

  // 8 — the generated script re-reads HEAD after EVERY check, and two runs never share a path.
  const sha = "a".repeat(40);
  const runA = newRunId(sha, 1_000, "aaaa");
  const runB = newRunId(sha, 1_000, "bbbb");
  assert.notEqual(runPaths("/r", runA).runDir, runPaths("/r", runB).runDir, "two runs of the same sha got the same directory");
  assert.notEqual(runPaths("/r", runA).ref, runPaths("/r", runB).ref, "two runs of the same sha got the same ref");
  const script = buildRunScript({
    remoteRoot: "/r",
    runId: runA,
    sha,
    install: "true",
    steps: [
      { name: "lint", command: "true" },
      { name: "typecheck", command: "true" },
      { name: "test", command: "true" },
    ],
  });
  assert.ok(
    !/FETCH_HEAD|git checkout|git fetch/.test(script),
    "the generated box script fetches or checks out in place again — a missing sha then falls back to " +
      "whatever the box holds, which is how a run reports on a commit it never named.",
  );
  for (const name of ["lint", "typecheck", "test"]) {
    const line = script.split("\n").find((l) => l.includes("=== " + name + " ===")) ?? "";
    assert.match(line, new RegExp("fi; .*same_tree " + name + ";"), "the " + name + " step does not verify the tree after it ran");
  }
  // 8b — ONE RUN OWNS THE BOX. Per-stage locking left `lint` and `test` taking no lock at all, and
  // a build was OOM-killed beside another session's node processes on 2026-10-05. The run-level
  // lock must be a DIFFERENT file from the per-stage one: flock(2) locks an open file description,
  // so re-taking /tmp/phx-typecheck.lock inside the typecheck would deadlock the run against itself.
  assert.match(
    script,
    /exec 9>>\/tmp\/phx-remote-check\.lock/,
    "the generated box script no longer takes a run-level lock, so two sessions' checks can collide on a 7.7 GB box",
  );
  assert.match(
    script,
    /flock -w \d+ 9 \|\| echo/,
    "the run-level lock must fall through to a warning: a lock that can fail the run teaches people to skip the check",
  );
  assert.ok(
    !/exec 9>>\/tmp\/phx-typecheck\.lock/.test(script),
    "the run-level lock uses the per-stage lock file, which deadlocks the run against its own typecheck",
  );

  // 8c — EXIT 137 IS THE OOM KILLER, NEVER A FAILURE OF THE CODE. It must report NO VERDICT (4),
  // and a real failure must still outrank it.
  assert.match(
    script,
    /if \[ "\$RC" = 137 \]; then R=OOM-KILLED; KILLED=1; else R=FAIL; FAILED=1; fi/,
    "an OOM-killed stage is being reported as FAIL, which blocks a push for a reason that is not true",
  );
  assert.match(
    script,
    /if \[ "\$FAILED" = 0 \] && \[ "\$KILLED" = 1 \]; then exit 4; fi/,
    "a killed run must exit 4 (NO VERDICT) and must never outrank a genuine failure",
  );
  assert.match(
    SRC,
    /status === 4[\s\S]{0,900}?NO VERDICT[\s\S]{0,400}?process\.exit\(4\)/,
    "remote-check.mjs does not turn the box script's exit 4 into a NO VERDICT, so a kill still reads as FAIL",
  );

  // 8b-2 — THE LOCK PATH IS AN ARGUMENT, AND ITS DEFAULT IS THE REAL ONE. A run can contain
  // another run: section 9 below launches two generated scripts while the suite itself is executing
  // inside a run that already holds the real lock. With one hard-coded path those inner scripts
  // blocked on their own parent and waited out the whole 1800s fall-through — measured 2026-10-05,
  // the `test` stage sitting at 31 minutes with `flock -w 1800 9` waiting.
  assert.match(
    buildRunScript({ remoteRoot: "/r", runId: runA, sha, install: "true", steps: [], lockFile: "/tmp/other.lock" }),
    /exec 9>>\/tmp\/other\.lock/,
    "buildRunScript ignores the lockFile argument, so a nested run cannot avoid blocking on its parent",
  );
  assert.match(
    script,
    /exec 9>>\/tmp\/phx-remote-check\.lock/,
    "the DEFAULT lock file is no longer the real one — a real run would stop excluding other runs",
  );
  assert.throws(
    () => buildRunScript({ remoteRoot: "/r", runId: runA, sha, install: "true", steps: [], lockFile: "/tmp/x; rm -rf ~" }),
    /unsafe lock file path/,
    "the lock path is spliced into bash and must be refused unless it is plain",
  );

  // 8d — A DROPPED SSH CONNECTION IS NOT A FAILED BRANCH. The box script only ever exits 0, 1, 3 or
  // 4, so 255 can only be the transport. Measured 2026-10-05: `Connection reset by peer` arrived
  // after `lint PASS` and `typecheck PASS`, and the run reported FAIL, halting a push over a dropped
  // TCP connection. Keepalives stop the common cause; the 255 arm stops the misreport either way.
  assert.ok(
    !/\bexit 255\b/.test(script),
    "the box script must never exit 255 itself — the 255 arm in remote-check.mjs reads that code as " +
      "the ssh transport dying, and a box script that could produce it would make a real failure read as a drop",
  );
  assert.match(
    SRC,
    /status === 255[\s\S]{0,900}?NO VERDICT[\s\S]{0,1500}?process\.exit\(5\)/,
    "remote-check.mjs reports a dropped ssh connection (exit 255) as FAIL — it must be NO VERDICT, " +
      "or a halted push gets blamed on the branch",
  );
  // 8e — THE 255 ARM MUST NOT CLAIM THE LOCK IS RELEASED. Measured 2026-10-05: after the client
  // died, four processes were still working under the run directory with a LIVE sshd-session
  // ancestor, so the run keeps the box lock and a plain re-run meets its own predecessor. Telling
  // someone to "just run it again" is the one wrong instruction here.
  assert.ok(
    !/lock is released when the connection dies/.test(SRC),
    "the 255 arm claims the box lock is released on a dropped connection — it is not: the remote run " +
      "survives the drop and keeps the lock, so a re-run is refused by the busy probe",
  );
  assert.match(
    SRC,
    /STILL GOING on the box and still holds the lock/,
    "the 255 arm must say the stranded run is still holding the box, not imply a re-run will just work",
  );
  assert.match(
    SRC,
    /reap that one by its own/,
    "the busy refusal must print how to reap ONE stranded run by its own directory — a blanket pkill " +
      "would take another session's live run with it",
  );

  for (const opt of ["ServerAliveInterval=30", "ServerAliveCountMax=10"]) {
    assert.ok(
      SRC.includes('"' + opt + '"'),
      "SSH_OPTS lost " + opt + " — `next build` is silent for minutes between stages, and a quiet " +
        "channel is exactly what a NAT or firewall idle timer reaps mid-run",
    );
  }

  assert.throws(
    () => buildRunScript({ remoteRoot: "/r", runId: runA, sha: "19442c382", install: "true", steps: [] }),
    /40-character/,
    "a short sha must be refused, never resolved on the box to whatever it happens to match",
  );
  assert.throws(
    () => buildRunScript({ remoteRoot: "/r", runId: "x; rm -rf ~", sha, install: "true", steps: [] }),
    /unsafe run id/,
    "the run id is spliced into bash and must be refused unless it is plain",
  );

  // 10 — THE BUSY-BOX ESCALATION (owner's policy, 2026-10-06: the box by default because it is free,
  // GitHub Actions when the work cannot wait). Several sessions share one 7,740 MB box, so a second
  // run is refused — and until that day the refusal was the whole answer, which parked finished work
  // behind another session's build while a session retried by hand. These pin the three properties
  // that make the escalation trustworthy rather than merely convenient.
  {
    // 🔴 THESE READ THE CODE, NOT THE PROSE. The comment in remote-check.mjs explaining what was
    // removed necessarily QUOTES the removed line, so a "must not appear" guard against raw source
    // fails on its own documentation — it did, on the first run of this section. `stripComments` is
    // the repo's one stripper for exactly this (tests/support/comment-strip.ts); the length check
    // beside it is the guard against the opposite failure, a strip that ate the code and left every
    // assertion passing vacuously.
    const CODE = stripComments(SRC);
    assert.ok(
      CODE.includes("parseEscalation(process.argv.slice(2))") && CODE.length > SRC.length / 3,
      "stripComments ate the code it was meant to expose — these assertions would pass on nothing",
    );

    // 10a — a flag is PARSED, never filtered away: a misspelled one used to run the plain behaviour
    // and report success, the same defect scripts/rollup-prs.mjs refuses by name.
    assert.deepEqual(parseEscalation(["--urgnet"]).unknown, ["--urgnet"], "a misspelled flag was swallowed");
    assert.deepEqual(parseEscalation(["--wait", "999"]).unknown, ["--wait 999 (minutes, 0-60)"]);
    assert.doesNotMatch(
      CODE,
      /filter\(\(a\) => !a\.startsWith\("-"\)\)/,
      "remote-check.mjs is filtering flags away again — an unknown flag must die, not be ignored",
    );

    // A flag's VALUE is positional: `--wait 3` must not leave a bare `3` to be read as a check name.
    assert.deepEqual(parseEscalation(["test", "--wait", "3"]).positional, ["test"]);
    assert.equal(parseEscalation(["test", "--wait", "3"]).waitMinutes, 3);
    assert.equal(parseEscalation(["all", "--wait=6"]).waitMinutes, 6);

    // --urgent is the owner's critical-situation switch, and since 2026-10-06 it escalates AT ONCE
    // ("make --urgent escalate immediately instead of after 4 minutes") — once the default waited ten
    // minutes, a 4-minute tier differed from it only by six minutes, which is not what urgent means.
    const urgent = parseEscalation(["all", "--urgent"]);
    assert.equal(urgent.waitMinutes, URGENT_WAIT_MINUTES);
    assert.equal(URGENT_WAIT_MINUTES, 0, "--urgent must not queue at all: it escalates immediately");
    assert.equal(urgent.actions, true, "--urgent must arm the Actions fallback, not only the wait");
    assert.deepEqual(urgent.positional, ["all"]);
    assert.equal(
      decideBusyAction({ busyRuns: ["run-a"], waitedSeconds: 0, waitMinutes: urgent.waitMinutes, actions: true }).action,
      "actions",
      "--urgent on a busy box must dispatch at once, never poll first",
    );

    // 🔴 AN EXPLICIT BUDGET STILL WINS, IN EITHER ORDER. `--urgent`'s zero must never SHORTEN a wait
    // the caller asked for, or `--wait 6 --urgent` would silently bill instead of waiting six minutes.
    assert.equal(parseEscalation(["all", "--wait", "6", "--urgent"]).waitMinutes, 6);
    assert.equal(parseEscalation(["all", "--urgent", "--wait", "6"]).waitMinutes, 6);

    // 10b — THE DEFAULT IS WAIT-THEN-ESCALATE since the owner's ruling of 2026-10-06 ("make --urgent
    // the default when the box queue is over 10 minutes"). A bare invocation must never leave the
    // caller with nothing, and it must never wait SILENTLY — the poll prints a line each time.
    const bare = parseEscalation(["all"]);
    assert.equal(bare.waitMinutes, DEFAULT_WAIT_MINUTES, "a bare invocation must wait, not refuse at once");
    assert.equal(bare.actions, true, "a bare invocation must escalate once the wait is spent");
    assert.ok(DEFAULT_WAIT_MINUTES > URGENT_WAIT_MINUTES, "--urgent must escalate SOONER than the default");

    // And the opt-out is what keeps a per-push hook free: `--no-wait --no-actions` is the old instant
    // "no verdict". Without it, push-typecheck-guard would delay EVERY push by ten minutes and bill
    // ~14 Actions minutes for a verdict the PR's own `checks` job produces anyway.
    const free = parseEscalation(["typecheck", "--no-wait", "--no-actions"]);
    assert.equal(free.waitMinutes, 0, "--no-wait must mean no wait");
    assert.equal(free.actions, false, "--no-actions must mean never bill");
    assert.deepEqual(free.positional, ["typecheck"], "a negation flag must not leak into the check names");
    assert.equal(parseEscalation(["all", "--free"]).actions, false, "--free is the documented alias");
    assert.equal(parseEscalation(["all", "--free"]).waitMinutes, DEFAULT_WAIT_MINUTES, "--free waits, it just never pays");

    const GUARD = stripComments(
      readFileSync(path.join(ROOT, ".claude", "hooks", "push-typecheck-guard.mjs"), "utf8"),
    );
    assert.match(
      GUARD,
      /spawnSync\([\s\S]{0,80}?'typecheck',\s*'--no-wait',\s*'--no-actions'/,
      "push-typecheck-guard must pass --no-wait --no-actions: the default now waits 10 min and then bills, on EVERY push",
    );

    const busy = { busyRuns: ["run-a"] };
    assert.equal(decideBusyAction({ ...busy, waitedSeconds: 0, waitMinutes: 0, actions: false }).action, "refuse");
    assert.equal(decideBusyAction({ ...busy, waitedSeconds: 0, waitMinutes: 0, actions: true }).action, "actions");
    assert.equal(decideBusyAction({ ...busy, waitedSeconds: 0, waitMinutes: 4, actions: true }).action, "poll");
    assert.equal(decideBusyAction({ ...busy, waitedSeconds: 240, waitMinutes: 4, actions: true }).action, "actions");
    assert.equal(decideBusyAction({ ...busy, waitedSeconds: 240, waitMinutes: 4, actions: false }).action, "refuse");
    assert.equal(
      decideBusyAction({ busyRuns: [], waitedSeconds: 0, waitMinutes: 0, actions: false }).action,
      "run",
      "an idle box must still just run — the escalation may never change the free path",
    );
    assert.ok(BUSY_POLL_SECONDS >= 10, "polling faster than 10s would hammer the box over ssh");

    // 10c — THE VERDICT IS ALLOW-LISTED. A watcher that skips a DENY-list of unfinished states calls
    // an unknown state green: measured in this repo when a loop skipping queued|in_progress|"" met a
    // 422 body, matched none of them and printed its success line
    // (`a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green`).
    const sha = "a".repeat(40);
    const ok = { headSha: sha, status: "completed", conclusion: "success", url: "u" };
    assert.equal(gradeActionsRun(ok, sha).verdict, "pass");
    assert.equal(gradeActionsRun({ ...ok, conclusion: "failure" }, sha).verdict, "fail");
    for (const conclusion of ["cancelled", "timed_out", "skipped", "neutral", "action_required", "startup_failure", null]) {
      const graded = gradeActionsRun({ ...ok, conclusion }, sha);
      assert.equal(graded.verdict, "no-verdict", "completed/" + String(conclusion) + " must not read as a verdict");
      assert.equal(graded.settled, true);
    }
    for (const status of ["queued", "in_progress", "waiting", "requested", undefined]) {
      const graded = gradeActionsRun({ ...ok, status }, sha);
      assert.equal(graded.settled, false, String(status) + " must stay unsettled, never fall through to a pass");
      assert.equal(graded.verdict, "pending");
    }
    assert.equal(gradeActionsRun(null, sha).verdict, "pending", "no run yet is not a pass");
    assert.equal(gradeActionsRun(undefined, sha).settled, false);

    // 10d — AND A RUN IS ONLY EVIDENCE ABOUT THE SHA IT RAN. `gh workflow run` takes a REF, so a
    // missing push would make the run about somebody else's commit. Both guards are pinned: the
    // grader refuses a foreign headSha, and the script compares origin's ref before dispatching.
    const other = gradeActionsRun({ ...ok, headSha: "b".repeat(40) }, sha);
    assert.equal(other.verdict, "no-verdict", "a run on another sha was graded as a verdict about this one");
    assert.match(other.why, /b{9}/);
    assert.match(CODE, /ls-remote", "origin", "refs\/heads\/" \+ branch/, "the dispatch no longer checks origin's sha");
    assert.match(CODE, /remoteSha !== sha/, "the pre-dispatch sha comparison is gone");
    // The escalation must never run a check locally — the whole premise of this script (section 1).
    assert.doesNotMatch(
      CODE.slice(CODE.indexOf("function runOnActions")),
      /execFileSync\(\s*"(pnpm|npx|tsc|node)"/,
      "the Actions fallback is spawning a local check",
    );
    // It dispatches ci.yml, the workflow that produces the two REQUIRED checks, never a side workflow.
    assert.match(CODE, /"workflow", "run", "ci\.yml"/, "the fallback must dispatch ci.yml itself");

    // 10e — AND IT REFUSES TO PAY TWICE. A branch that already has an open PR is already running the
    // same two required jobs on the same commit, so a dispatch beside them bills a second round for
    // one answer (owner, 2026-09-27: every merge already costs ~28 billable CI minutes). The fallback
    // sends the reader to `gh pr checks` instead, and that short circuit sits BEFORE the dispatch.
    const fallback = CODE.slice(CODE.indexOf("function runOnActions"));
    const prGate = fallback.indexOf('"pr", "list", "--head", branch');
    const dispatch = fallback.indexOf('"workflow", "run", "ci.yml"');
    assert.ok(prGate > 0, "the fallback no longer asks whether a PR is already open");
    assert.ok(dispatch > 0, "the dispatch call is gone");
    assert.ok(prGate < dispatch, "the open-PR check must come BEFORE the dispatch, or it bills before it looks");
    assert.match(fallback, /gh pr checks/, "it must name the command that reads the PR's own checks");
  }

  // 9 — BEHAVIOUR: run the generated bash for real against a throwaway bare repo. It needs bash, git
  // and a POSIX `find`, so it runs on the Linux CI runners and is skipped on the Windows laptop, where
  // `bash` may resolve to WSL. The required `validate` job is Linux, so it always runs where it gates.
  if (process.platform === "win32") return;
  if (spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).status !== 0) return;

  const tmp = mkdtempSync(path.join(os.tmpdir(), "phx-remote-check-"));
  try {
    const g = (cwd: string, ...args: string[]) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, "git " + args.join(" ") + " failed: " + r.stderr);
      return r.stdout.trim();
    };
    const remoteRoot = path.join(tmp, "box");
    mkdirSync(remoteRoot);
    g(remoteRoot, "init", "-q", "--bare", "repo.git");
    const src = path.join(tmp, "src");
    mkdirSync(src);
    g(src, "init", "-q");
    g(src, "config", "user.email", "t@t");
    g(src, "config", "user.name", "t");
    writeFileSync(path.join(src, "base.txt"), "base\n");
    g(src, "add", ".");
    g(src, "commit", "-q", "-m", "base");
    const without = g(src, "rev-parse", "HEAD");
    writeFileSync(path.join(src, "new-test.ts"), "x\n"); // the file 19442c382 added
    g(src, "add", ".");
    g(src, "commit", "-q", "-m", "with");
    const withFile = g(src, "rev-parse", "HEAD");
    const bare = path.join(remoteRoot, "repo.git");
    g(src, "push", "-q", bare, withFile + ":refs/remote-check/seed-with", without + ":refs/remote-check/seed-without");

    const runBox = (runId: string, want: string, command: string) =>
      new Promise<{ status: number | null; out: string }>((resolve) => {
        const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (status) => resolve({ status, out }));
        // Its OWN lock file. These runs are nested inside the run executing this suite, which
        // already holds the real one, so sharing it would make each wait out the full 1800s
        // fall-through against its own parent — and 9a's whole point is that they OVERLAP.
        child.stdin.end(
          buildRunScript({
            remoteRoot,
            runId,
            sha: want,
            install: "true",
            steps: [{ name: "probe", command }],
            lockFile: path.join(remoteRoot, "lock-" + runId),
          }),
        );
      });

    // 9a — THE 2026-10-01 SHAPE: two invocations at once on two commits, each sleeping mid-check so
    // they overlap. Each must see ITS OWN tree for the whole check. On the shared directory the second
    // checkout replaced the first's files; here neither can reach the other's.
    const [a, b] = await Promise.all([
      runBox(newRunId(withFile), withFile, "{ sleep 1; test -f new-test.ts; }"),
      runBox(newRunId(without), without, "{ sleep 1; test ! -f new-test.ts; }"),
    ]);
    assert.equal(a.status, 0, "the run on the commit WITH the file did not see it — its tree was not its own:\n" + a.out);
    assert.equal(b.status, 0, "the run on the commit WITHOUT the file saw it — its tree was not its own:\n" + b.out);
    assert.match(a.out, new RegExp("box head: " + withFile.slice(0, 7)));
    assert.match(b.out, new RegExp("box head: " + without.slice(0, 7)));

    // 9b — and it cleans up after itself: no run directory and no per-run ref survive a run.
    const leftoverRefs = g(bare, "for-each-ref", "--format=%(refname)", "refs/remote-check/")
      .split("\n")
      .filter((r) => r && !r.includes("/seed-"));
    assert.deepEqual(leftoverRefs, [], "per-run refs survived their runs: " + leftoverRefs.join(", "));
    const leftoverDirs = spawnSync("bash", ["-c", 'ls -A "$1" 2>/dev/null', "_", path.join(remoteRoot, "runs")], {
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(leftoverDirs, "", "run directories survived their runs: " + leftoverDirs);

    // 9c — THE GUARD: if the tree moves under a check anyway, the run has NO VERDICT. The probe itself
    // succeeds, so without the guard this would print PASS for a commit it never finished checking.
    const swapped = await runBox(newRunId(withFile), withFile, "git checkout -q --detach " + without);
    assert.equal(swapped.status, 3, "a tree that changed mid-run did not exit 3 (NO VERDICT):\n" + swapped.out);
    assert.match(swapped.out, /TREE CHANGED UNDER THE RUN after probe/);
    assert.doesNotMatch(swapped.out, /--- probe PASS/, "a swapped run printed a PASS line");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
