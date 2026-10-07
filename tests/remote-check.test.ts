import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

import {
  BUSY_POLL_SECONDS,
  DEFAULT_WAIT_MINUTES,
  FREE_WAIT_MINUTES,
  URGENT_WAIT_MINUTES,
  WAIT_MINUTES_ENV,
  buildBusyProbeScript,
  buildRunScript,
  decideBusyAction,
  gradeActionsRun,
  gradeActionsStages,
  isProtectedDispatchRef,
  newRunId,
  parseBusyProbe,
  parseEscalation,
  STAGE_JOBS,
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

  // 2 — the typecheck must carry the same COMPILER FLAGS CI gives it, or a PASS here does not predict
  // CI. Until 2026-10-06 the flag that mattered was `--max-old-space-size=6144`, because tsc 5 is a
  // node program that could OOM below node's default ceiling and report nothing. The gate is the
  // NATIVE compiler now (a Go binary, which does not read a node heap flag), and the flag that
  // matters is `--checkers`: TypeScript 5 refuses it, so it is also what makes a tree whose
  // `typescript-native` alias went missing fail here loudly instead of answering with the old
  // compiler. tests/typecheck-native-compiler.test.ts holds the other half — that both callers pass
  // it; this one holds that the box's command is the same SHAPE as the one `checks` runs.
  assert.ok(
    /tsc --noEmit[^"']*--checkers \d+/.test(SRC),
    "the remote typecheck no longer passes `--checkers`. A green result here is only useful because " +
      "it runs the same command the required `checks` job runs — and without that flag it can run a " +
      "DIFFERENT compiler from the one gating the merge and still report PASS.",
  );
  // Scoped to the typecheck COMMAND, not the file: the build's own note still explains why a node
  // heap flag never bounded Turbopack either, and a guard that fired on that sentence would force
  // the next reader to delete the account in order to keep the rule.
  const typecheckCmd = /^\s*typecheck:\s*\n?\s*"([^"]+)"/m.exec(SRC)?.[1] ?? "";
  assert.notEqual(typecheckCmd, "", "tests/remote-check.test.ts can no longer find the `typecheck` entry in the CHECKS table.");
  assert.ok(
    !/max-old-space-size/.test(typecheckCmd),
    "the remote typecheck carries `--max-old-space-size` again. The type gate is the native compiler, " +
      "which does not read a node heap flag — leaving one here reads as a memory guarantee that " +
      "nothing honours. Memory is bounded by `--checkers` instead (5.06 GB peak at 1, measured). " +
      "Command read: " + JSON.stringify(typecheckCmd),
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
    /flock -w \d+ (?:-E \d+ )?\/tmp\/phx-typecheck\.lock/.test(buildCmd),
    "the remote build no longer takes /tmp/phx-typecheck.lock. ci.yml's typecheck step and the " +
      "typecheck above both take it; without it a build races a typecheck on a 7.7 GB box, which " +
      "is the OOM kill (exit 137) this lock exists to prevent. Command read: " +
      JSON.stringify(buildCmd),
  );

  // 2d — AND A STAGE THAT GIVES UP WAITING FOR THAT LOCK IS NOT A FAILING CHECK. `flock -w` expiring
  // exits 1 — the same code `tsc` uses for type errors — so a box held for twenty minutes made a
  // stage that NEVER RAN print `FAIL — <sha>` and block a push. The conflict is settled by a probe in
  // front of the stage (buildRunScript), not by rewriting the command: tests/ci-typecheck-lock.test.ts
  // pins this `flock -w <seconds> <file>` prefix so this caller and ci.yml cannot drift apart.
  for (const [name, command] of [["typecheck", SRC.match(/^\s*typecheck:\s*\n?\s*"([^"]+)"/m)?.[1] ?? ""], ["build", buildCmd]]) {
    const probed = buildRunScript({
      remoteRoot: "/r",
      runId: "aaaaaaaaaaaa-rs-aaaa",
      sha: "a".repeat(40),
      install: "true",
      steps: [{ name, command }],
    });
    assert.match(
      probed,
      /STAGE_LOCK=0; flock -w \d+ -E 75 \/tmp\/phx-typecheck\.lock true \|\| STAGE_LOCK=\$\?/,
      "the box script no longer probes the lock in front of the " + name + ", so a 20-minute wait that " +
        "expires exits 1 and is graded as a failing check. Command read: " + JSON.stringify(command),
    );
    assert.match(
      probed,
      new RegExp('if \\[ "\\$STAGE_LOCK" = 75 \\]; then R=LOCK-TIMEOUT; LOCKED=1; elif ', "m"),
      "the " + name + " step does not consult the lock probe, so the probe proves nothing",
    );
  }

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
  // 🔴 THE PROBE STILL FAILS CLOSED, BUT NOT BY DYING — owner ruling, 2026-10-08: *"make an unreachable
  // box escalate to Actions too, not only a busy one"*. The invariant worth pinning was never the
  // `die(`: it is that an unreadable answer can never be read as an IDLE BOX and start a run beside
  // somebody else's build. So this asserts the probe's own `known` flag reaches the decision, and the
  // decision table in section 10b proves `probeKnown: false` can never return `run`. Pinning the old
  // `die(` would now pin the behaviour the owner replaced — which is how a guard starts arguing for a bug.
  assert.match(
    SRC,
    /parseBusyProbe\(state\)[\s\S]{0,2000}?probeKnown: busy\.known/,
    "the probe's own known flag no longer reaches decideBusyAction — an unreadable answer could read as a free box",
  );
  assert.match(
    SRC,
    /probeKnown: again\.known/,
    "the poll loop drops the probe's known flag, so a box that stopped answering mid-wait could read as free",
  );
  assert.doesNotMatch(
    SRC,
    /!busy\.known[\s\S]{0,120}?die\(/,
    "remote-check.mjs still dies on an unreadable probe instead of escalating (owner ruling, 2026-10-08)",
  );
  // 🔴 AND THE PROBE'S OWN SSH MUST SOFT-FAIL, OR THE ESCALATION IS UNREACHABLE FOR THE CASE HE NAMED.
  // `ssh()` dies on a failed connection, BEFORE any output is parsed — so without `softFail` the
  // `probeKnown: false` branch could only ever describe a box that answered and said nothing useful,
  // while a box that is genuinely DOWN still exited 2 in the transport. Measured on this branch: with
  // the flag missing, a host it cannot reach printed `ssh failed: … Permission denied` and stopped.
  // Anchored on `const state = ssh(` deliberately: `buildBusyProbeScript(REMOTE_ROOT)` appears in the
  // poll loop's own call too, so a window around the NAME alone was satisfiable by the second probe
  // while the FIRST one — the only probe a one-shot invocation ever reaches — had lost its flag.
  assert.match(
    SRC,
    /const state = ssh\([\s\S]{0,1200}?softFail: true/,
    "the FIRST busy probe's ssh no longer soft-fails, so an unreachable box dies before it can escalate",
  );
  assert.equal(
    (SRC.match(/softFail: true/g) ?? []).length,
    2,
    "softFail belongs to the TWO probe calls only — a failed ssh around the real run must still die as " +
      "the transport fault (exit 5), never be absorbed into a busy-box decision",
  );
  assert.equal(
    parseBusyProbe(null).known,
    false,
    "parseBusyProbe must read a soft-failed ssh (null) as 'could not tell', never as an idle box",
  );
  assert.deepEqual(parseBusyProbe(null).runs, []);
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
  // 🔴 AND THE REFUSAL IS GATED ON THE DECISION, NOT ON THE RUN LIST. An unreachable box has ZERO runs,
  // so the old `busy.runs.length > 0` condition skipped the refusal and FELL THROUGH TO THE PUSH once
  // `!busy.known` stopped dying — the push then failed on ssh, after sending the sha, with a message
  // about the transport rather than about the probe. `plan.action === "refuse"` is the only condition
  // that covers a busy box and an unreachable one at once.
  assert.match(
    SRC,
    /plan\.action === "refuse" && !FORCED[\s\S]{0,3600}?die\(/,
    "remote-check.mjs does not refuse on the decision itself, so an unreachable box could fall through to the push",
  );
  assert.doesNotMatch(
    SRC,
    /busy\.runs\.length > 0 && plan\.action !== "run"/,
    "the refusal is gated on the run list again — an unreachable box has zero runs and would skip it",
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
    /if \[ "\$RC" = 137 \]; then R=OOM-KILLED; KILLED=1; /,
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

  // 8c-2 — AND NEITHER A LOCK TIMEOUT, A FAILED SETUP NOR A SIGNAL IS A VERDICT ABOUT THE CODE.
  // All three arrived as the `FAIL — <sha>` line until 2026-10-06: a `flock -w 1200` that expired
  // (exit 1, the same code tsc uses for type errors), an install or `git worktree add` that could
  // not run on the box, and `exit 130` from the HUP/INT/TERM trap. Each blocks a push and tells the
  // owner his code is broken for something that never read his code. Same cry-wolf shape as the OOM
  // kill above, which is why they are pinned beside it.
  assert.match(
    script,
    /elif \[ "\$RC" = 75 \]; then R=LOCK-TIMEOUT; LOCKED=1;/,
    "a stage that waited out the box's typecheck lock is graded as a FAIL — it never ran its command at all",
  );
  assert.match(
    script,
    /if \[ "\$FAILED" = 0 \] && \[ "\$LOCKED" = 1 \]; then exit 9; fi/,
    "a lock timeout must exit 9 (NO VERDICT), and must never outrank a genuine failure",
  );
  assert.match(
    script,
    /install failed[^\n]*exit 7/,
    "a failed install on the box still exits 1, which prints FAIL for a commit nothing ever checked",
  );
  assert.match(
    script,
    /could not make a private tree[\s\S]{0,40}exit 7/,
    "a run whose private tree could not be made still exits 1 — that is the box's disk or git, not the branch",
  );
  assert.ok(
    /trap '[^']*exit 8' HUP INT TERM/.test(script) && !/exit 130/.test(script),
    "the signal trap still exits 130, which falls through to the FAIL line — a run reaped by the box's " +
      "memory watchdog or a hand `kill` then reads as a broken branch",
  );
  for (const name of ["EXIT_SETUP", "EXIT_INTERRUPTED", "EXIT_LOCK_TIMEOUT"]) {
    assert.match(
      SRC,
      new RegExp("status === " + name + "[\\s\\S]{0,1200}?NO VERDICT[\\s\\S]{0,900}?process\\.exit\\(" + name + "\\)"),
      "remote-check.mjs no longer routes " + name + " to a NO VERDICT arm of its own, so that run falls " +
        "through to the `FAIL — <sha>` line at the bottom of the file",
    );
  }
  // 🔴 AND A NO-VERDICT RUN MUST PRINT NOTHING THAT PARSES AS A VERDICT FOR THIS SHA. Other tools
  // grep `^remote-check: (PASS|FAIL) — <sha>` out of an append-only log
  // (`a-verdict-line-without-its-sha-matches-an-older-run`), so the arms must not print that line.
  for (const arm of SRC.split(/\nif \(status === /).slice(1, -1)) {
    assert.ok(
      !/remote-check: (?:PASS|FAIL) — /.test(arm.split("\n}")[0]),
      "a NO VERDICT arm prints a line that parses as a verdict for this sha:\n" + arm.split("\n}")[0],
    );
  }

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

    // --urgent escalates AT ONCE ("make --urgent escalate immediately instead of after 4 minutes",
    // 2026-10-06) — and since 2026-10-08 that is what a BARE invocation does too, so the flag survives
    // as a documented alias: every caller already passing it must keep working, and it must still mean
    // "immediately" when PHX_CHECK_WAIT_MINUTES has set a house wait (asserted in 10b).
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

    // 10b — 🔴 THE BOX WHEN FREE, GITHUB ACTIONS THE MOMENT IT IS BUSY — owner ruling, 2026-10-08:
    // *"if free use it directly but if busy use github actions"*. So the default wait is ZERO and a
    // bare invocation on a busy box DISPATCHES rather than polling: the ten-minute queue of 2026-10-06
    // was the same policy with ten minutes of a session's time in front of it.
    const bare = parseEscalation(["all"], {});
    assert.equal(bare.waitMinutes, DEFAULT_WAIT_MINUTES);
    assert.equal(DEFAULT_WAIT_MINUTES, 0, "a busy box must escalate at once, not queue for the box first");
    assert.equal(bare.actions, true, "a bare invocation must escalate, never leave the caller with nothing");
    assert.equal(
      decideBusyAction({ busyRuns: ["run-a"], waitedSeconds: 0, waitMinutes: bare.waitMinutes, actions: bare.actions })
        .action,
      "actions",
      "the default on a busy box must be a dispatch, with no poll in front of it",
    );

    // 🔴 AND THE WAIT SURVIVES EXACTLY WHERE IT IS THE ONLY ROUTE TO A VERDICT. `--free` says never
    // bill, so a zero there would turn it into an instant refusal — the old `--no-wait --no-actions`
    // behaviour under a flag that promises waiting. One shared default cannot serve both paths.
    assert.ok(FREE_WAIT_MINUTES > 0, "--free must still wait: with Actions disarmed, the poll is the only route");
    assert.equal(parseEscalation(["all", "--free"], {}).actions, false, "--free is the documented alias");
    assert.equal(parseEscalation(["all", "--free"], {}).waitMinutes, FREE_WAIT_MINUTES, "--free waits, it never pays");
    assert.equal(
      decideBusyAction({ busyRuns: ["run-a"], waitedSeconds: 0, waitMinutes: FREE_WAIT_MINUTES, actions: false }).action,
      "poll",
      "--free on a busy box must keep asking the box, never bill and never refuse at once",
    );

    // 🔴 THE HOUSE DEFAULT IS AN ENV KNOB, AND AN EXPLICIT FLAG ALWAYS WINS OVER IT. That ordering is
    // what keeps the push guard instant and free however this machine is configured.
    assert.equal(parseEscalation(["all"], { [WAIT_MINUTES_ENV]: "10" }).waitMinutes, 10, "the knob must set the wait");
    assert.equal(
      parseEscalation(["all", "--urgent"], { [WAIT_MINUTES_ENV]: "10" }).waitMinutes,
      0,
      "--urgent must still mean immediately when the house default is a wait",
    );
    assert.equal(parseEscalation(["all", "--free"], { [WAIT_MINUTES_ENV]: "0" }).waitMinutes, 0);
    // An unreadable value is REFUSED, not ignored: an ignored setting runs the other policy and reports
    // success, which is the silent-ignore defect this parser exists to refuse for flags.
    assert.deepEqual(
      parseEscalation(["all"], { [WAIT_MINUTES_ENV]: "soon" }).unknown,
      [WAIT_MINUTES_ENV + "=soon (minutes, 0-60)"],
      "a garbage house default must die loudly, never fall back to a policy nobody asked for",
    );
    assert.deepEqual(parseEscalation(["all"], { [WAIT_MINUTES_ENV]: "" }).unknown, [], "an empty knob is not set");

    // And the opt-out is what keeps a per-push hook free: `--no-wait --no-actions` is the instant
    // "no verdict". Without it, a busy box would bill ~14 Actions minutes on EVERY push for a verdict
    // the PR's own `checks` job produces anyway — and since 2026-10-08 it would do so immediately.
    const free = parseEscalation(["typecheck", "--no-wait", "--no-actions"], {});
    assert.equal(free.waitMinutes, 0, "--no-wait must mean no wait");
    assert.equal(free.actions, false, "--no-actions must mean never bill");
    assert.deepEqual(free.positional, ["typecheck"], "a negation flag must not leak into the check names");
    assert.equal(
      decideBusyAction({ busyRuns: ["run-a"], waitedSeconds: 0, waitMinutes: 0, actions: false }).action,
      "refuse",
      "the push guard's own argument list must still refuse at once, billing nothing",
    );

    // 🔴 10b-ii — AN UNREACHABLE BOX TAKES THE SAME ROUTES AS A BUSY ONE — owner ruling, 2026-10-08:
    // *"make an unreachable box escalate to Actions too, not only a busy one"*. It used to die at exit 2
    // with no verdict, on the one piece of evidence that most argues FOR Actions: the box cannot answer.
    const down = { busyRuns: [] as string[], probeKnown: false };
    assert.equal(
      decideBusyAction({ ...down, waitedSeconds: 0, waitMinutes: 0, actions: true }).action,
      "actions",
      "an unreachable box must escalate at once, not refuse with no verdict",
    );
    assert.equal(
      decideBusyAction({ ...down, waitedSeconds: 0, waitMinutes: 0, actions: true }).reason,
      "unreachable",
      "the reason must say which of the two happened — 'BUSY' about a box that is DOWN sends the reader to wait for a run that does not exist",
    );
    assert.equal(
      decideBusyAction({ ...down, waitedSeconds: 0, waitMinutes: FREE_WAIT_MINUTES, actions: false }).action,
      "poll",
      "with a budget it must retry — a dropped ssh is often a blip, and a poll costs nothing",
    );
    assert.equal(
      decideBusyAction({ ...down, waitedSeconds: 600, waitMinutes: FREE_WAIT_MINUTES, actions: false }).action,
      "refuse",
      "--free on an unreachable box must still refuse at the end of its wait, never bill",
    );
    // 🔴 THE FAIL-CLOSED INVARIANT, WHICH THIS RULING DOES NOT WEAKEN: `run` is unreachable from an
    // unreadable probe, so nothing is ever STARTED on a box that did not answer — that is what OOM-kills
    // another session's build. Every combination, not just the ones above.
    for (const actions of [true, false]) {
      for (const waitMinutes of [0, 1, 10, 60]) {
        for (const waitedSeconds of [0, 30, 600, 36_000]) {
          assert.notEqual(
            decideBusyAction({ ...down, waitedSeconds, waitMinutes, actions }).action,
            "run",
            `probeKnown:false must never run on the box (actions=${actions} wait=${waitMinutes} waited=${waitedSeconds})`,
          );
        }
      }
    }
    // A free, answering box is untouched by any of it.
    assert.equal(
      decideBusyAction({ busyRuns: [], waitedSeconds: 0, waitMinutes: 0, actions: true, probeKnown: true }).reason,
      "free",
      "an idle box that answered must still just run — the escalation may never change the free path",
    );
    // The flag DEFAULTS to true, so every caller written before the ruling keeps its old meaning rather
    // than silently escalating.
    assert.equal(
      decideBusyAction({ busyRuns: [], waitedSeconds: 0, waitMinutes: 0, actions: true }).action,
      "run",
      "probeKnown must default to true: a caller that omits it gets the busy logic, not an escalation",
    );

    const GUARD = stripComments(
      readFileSync(path.join(ROOT, ".claude", "hooks", "push-typecheck-guard.mjs"), "utf8"),
    );
    assert.match(
      GUARD,
      /spawn(?:Sync)?\([\s\S]{0,120}?'typecheck',\s*'--no-wait',\s*'--no-actions'/,
      "push-typecheck-guard must pass --no-wait --no-actions: a busy box now bills IMMEDIATELY, on EVERY push",
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

    // 10f — AND IT NEVER DISPATCHES ON `main`. ci.yml groups a non-PR run by SHA and never cancels
    // one (`CI-<sha>`, concurrency block in .github/workflows/ci.yml), so a dispatch from `main`
    // lands in the SAME group as the push run Railway's "Wait for CI" holds the production deploy
    // on — and a cancelled or failed suite there makes Railway mark that deploy SKIPPED for good
    // (AGENTS.md §2.3). It also buys nothing: main already runs the whole gate on every commit.
    for (const ref of ["main", "master", "refs/heads/main", " main "]) {
      assert.equal(isProtectedDispatchRef(ref), true, ref + " must never be dispatched onto");
    }
    for (const ref of ["codex/fix-x", "main-fix", "feat/main", "", null, undefined, "remote-check"]) {
      assert.equal(isProtectedDispatchRef(ref as string), false, String(ref) + " is an ordinary branch and must still dispatch");
    }
    const refusal = fallback.indexOf("isProtectedDispatchRef(branch)");
    assert.ok(refusal > 0, "the Actions fallback no longer refuses to dispatch on main — it would collide with the deploy gate");
    assert.ok(refusal < dispatch, "the main refusal must come BEFORE the dispatch, or it refuses after billing");
    assert.match(
      fallback.slice(refusal, dispatch),
      /NO VERDICT[\s\S]{0,200}?process\.exit\(6\)/,
      "the main refusal must end in a NO VERDICT exit (6, like the open-PR refusal), never a FAIL",
    );

    // 10g — AND IT GRADES ONLY THE STAGE THAT WAS ASKED FOR. A workflow_dispatch runs the WHOLE
    // workflow — `mobile` (which reports and never gates, AGENTS.md §7), the Build and the Playwright
    // login smoke — so grading the run's own conclusion turned `remote-check typecheck` FAIL on a
    // mobile lockfile break or a smoke flake: a verdict about somebody else's code, printed under
    // this sha, blocking this push.
    const job = (name: string, conclusion: string | null, steps: Array<[string, string | null]> = []) => ({
      name,
      status: "completed",
      conclusion,
      steps: steps.map(([n, c]) => ({ name: n, conclusion: c })),
    });
    const checksGreen = job("checks", "success", [["Lint", "success"], ["Typecheck", "success"]]);
    const validateGreen = job("validate", "success", [["Test", "success"], ["Build", "success"]]);

    // The whole point: the requested stage passed, something else in the run did not.
    const smokeFlake = job("validate", "failure", [["Test", "success"], ["Run Playwright login smoke test", "failure"]]);
    const typecheckOnMobileBreak = gradeActionsStages(["typecheck"], [checksGreen, job("mobile", "failure"), smokeFlake]);
    assert.equal(typecheckOnMobileBreak.verdict, "pass", "a red `mobile` or smoke job must not fail the typecheck that passed");
    assert.deepEqual(typecheckOnMobileBreak.otherRed, ["mobile", "validate"], "the other red jobs must still be REPORTED");
    assert.equal(gradeActionsStages(["test"], [checksGreen, smokeFlake]).verdict, "pass", "a failed smoke step must not fail the unit suite");

    // A genuine red in the requested stage is still a FAIL, and the step is what decides it.
    const typeError = job("checks", "failure", [["Lint", "success"], ["Typecheck", "failure"]]);
    assert.equal(gradeActionsStages(["typecheck"], [typeError, validateGreen]).verdict, "fail");
    assert.equal(gradeActionsStages(["lint"], [typeError, validateGreen]).verdict, "pass", "lint passed in that same job");
    assert.match(gradeActionsStages(["typecheck"], [typeError]).why, /Typecheck/);

    // A stage that never ran is NO VERDICT, never FAIL — a missing job, an unfinished one, and a
    // step skipped because an earlier step in its job died are all "nobody looked at your stage".
    assert.equal(gradeActionsStages(["typecheck"], [validateGreen]).verdict, "no-verdict", "a missing `checks` job is not a failure");
    assert.equal(
      gradeActionsStages(["typecheck"], [{ ...checksGreen, status: "in_progress", conclusion: null }]).verdict,
      "no-verdict",
    );
    assert.equal(
      gradeActionsStages(["typecheck"], [job("checks", "failure", [["Install dependencies", "failure"], ["Typecheck", "skipped"]])]).verdict,
      "no-verdict",
      "a typecheck step skipped because the install died says nothing about the code",
    );
    assert.equal(gradeActionsStages(["typecheck"], [job("checks", "cancelled", [])]).verdict, "no-verdict");
    assert.equal(gradeActionsStages(["typecheck"], null).verdict, "no-verdict", "an unreadable job list is not a verdict");
    assert.equal(gradeActionsStages(["typecheck"], []).verdict, "no-verdict");

    // A real failure still outranks an unknown, exactly as it does in the box script.
    assert.equal(
      gradeActionsStages(["lint", "typecheck", "test"], [typeError]).verdict,
      "fail",
      "a red typecheck beside a `validate` that is not in the run must stay a FAIL",
    );

    // 🔴 AND THE NAMES IT GRADES BY MUST BE ci.yml's OWN. STAGE_JOBS is a map into another file: a
    // renamed job or step would make every stage read NO VERDICT for ever, which fails open and is
    // therefore silent. Read the workflow and check both halves still exist.
    //
    // 🔴 THE STEP IS LOOKED FOR INSIDE ITS OWN JOB, AND THIS IS NOT PEDANTRY — IT IS THE WHOLE
    // ASSERTION. Until 2026-10-06 both halves were matched against the WHOLE FILE, so "ci.yml has a
    // `validate` job" and "ci.yml has a step named `Test`" could both be true while `validate` had no
    // `Test` step at all. That is exactly what happened the day the unit suite gained a second home:
    // `test` still pointed at `validate`, the step it names moved to `checks` on every non-PR event,
    // and this guard passed. Split the file into jobs first and ask the named job.
    const CI = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const ciJobs = new Map<string, string>();
    {
      const lines = CI.split("\n");
      const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
      assert.notEqual(start, -1, "ci.yml has no top-level `jobs:` block");
      let name: string | null = null;
      let body: string[] = [];
      for (const line of lines.slice(start + 1)) {
        const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (header) {
          if (name) ciJobs.set(name, body.join("\n"));
          name = header[1];
          body = [];
          continue;
        }
        if (name) body.push(line);
      }
      if (name) ciJobs.set(name, body.join("\n"));
    }
    for (const [stage, spec] of Object.entries(STAGE_JOBS) as Array<[string, { job: string; step: string }]>) {
      const jobBody = ciJobs.get(spec.job);
      assert.ok(
        jobBody !== undefined,
        "STAGE_JOBS says " + stage + " runs in the `" + spec.job + "` job, and ci.yml has no such job any more",
      );
      const stepAt = jobBody.indexOf("      - name: " + spec.step + "\n");
      assert.notEqual(
        stepAt,
        -1,
        "STAGE_JOBS grades " + stage + " by a `" + spec.step + "` step inside ci.yml's `" + spec.job + "` job, and " +
          "that job has no such step — every " + stage + " dispatch would silently read NO VERDICT",
      );

      // 🔴 AND IT MUST RUN ON THE EVENT THIS SCRIPT CAUSES. The escalation is a `workflow_dispatch`,
      // so a step gated on a pull request is SKIPPED on every run this script will ever grade, and
      // `gradeConclusion("skipped")` is no-verdict — the same silent failure, one level down. There is
      // no need to evaluate GitHub's expression language to catch it: a condition that REQUIRES a pull
      // request can never hold for a dispatch, and that is the only shape ci.yml uses.
      const ifLine = /^ {8}if: (.+)$/m.exec(jobBody.slice(stepAt, stepAt + 400));
      assert.ok(
        !ifLine || !/event_name\s*==\s*'pull_request'/.test(ifLine[1]),
        "`" + spec.job + "` / " + spec.step + " only runs on a pull request (`" + (ifLine?.[1] ?? "") + "`), but " +
          "remote-check escalates by dispatching ci.yml — so " + stage + " would be graded from a SKIPPED step and " +
          "answer NO VERDICT on every run, after a ten-minute wait and a full billed workflow",
      );
    }

    // And the script must actually USE it: the run's conclusion alone may not decide a FAIL.
    assert.match(CODE, /gradeActionsStages\(names, jobs\)/, "the Actions fallback no longer grades per stage");
    assert.match(CODE, /"run", "view", String\(runId\), "--json", "jobs"/, "it must read the run's jobs to grade a stage");
    assert.ok(
      !/graded\.verdict === "fail"/.test(CODE),
      "the fallback still fails on the RUN's conclusion — that is the mobile/smoke misreport this replaced",
    );
  }

  // 9 — BEHAVIOUR: run the generated bash for real against a throwaway bare repo. It needs bash, git
  // and a POSIX `find`, so it runs on the Linux CI runners and is skipped on the Windows laptop, where
  // `bash` may resolve to WSL. The required `validate` job is Linux, so it always runs where it gates.
  if (process.platform === "win32") return;
  if (spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).status !== 0) return;

  const tmp = mkdtempSync(path.join(os.tmpdir(), "phx-remote-check-"));
  try {
    // Exercise the configured remote test command with the real shard runner and a tiny suite.
    // No SSH, dependencies or production env: the fixture proves complete coverage and that a
    // failed or incomplete shard propagates through the shell command as a failing remote stage.
    const fixture = path.join(tmp, "sharded-suite");
    for (const dir of ["bin", "scripts", "tests"]) mkdirSync(path.join(fixture, dir), { recursive: true });
    for (const file of ["run-tests-sharded.mjs", "run-tests-sharded-plan.mjs"]) {
      writeFileSync(path.join(fixture, "scripts", file), readFileSync(path.join(ROOT, "scripts", file)));
    }
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node tests/fixture-suite.mjs" } }));
    writeFileSync(path.join(fixture, "tests", "fixture-suite.mjs"), `
const [index, total] = (process.env.PHX_TEST_SHARD || '1/1').split('/').map(Number);
let ran = 0;
for (let test = 1; test <= 6; test++) {
  if ((test - 1) % total !== index - 1) continue;
  console.log('FIXTURE_TEST ' + test);
  ran++;
}
if (process.env.FIXTURE_FAIL_SHARD === String(index)) process.exit(1);
if (process.env.FIXTURE_MISSING_MARKER !== String(index)) {
  console.log('PHX_SHARD_RESULT shard=' + index + '/' + total + ' seen=6 ran=' + ran);
}
`);
    writeFileSync(path.join(fixture, "bin", "corepack"), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const [manager, action, script] = process.argv.slice(2);
const target = { test: 'tests/fixture-suite.mjs', 'test:sharded': 'scripts/run-tests-sharded.mjs' }[script];
if (manager !== 'pnpm' || action !== 'run' || !target) process.exit(2);
const result = spawnSync(process.execPath, [target], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const testCommand = /^\s*test:\s*"([^"]+)"/m.exec(SRC)?.[1];
    assert.ok(testCommand, "the configured remote test command must be discoverable");
    const runFixture = (extra: Record<string, string> = {}) => spawnSync("bash", ["-c", testCommand], {
      cwd: fixture,
      env: { ...process.env, PATH: path.join(fixture, "bin") + path.delimiter + process.env.PATH,
        PHX_TEST_SHARDS: "2", FIXTURE_FAIL_SHARD: "", FIXTURE_MISSING_MARKER: "", ...extra },
      encoding: "utf8",
      timeout: 10_000,
    });
    const complete = runFixture();
    assert.equal(complete.status, 0, "the remote test stage failed on a complete fixture suite:\n" + complete.stderr);
    assert.match(complete.stdout, /6 test files passed .* across 2 shard\(s\)/,
      "the remote test stage must use CI's shard runner instead of repeating the serial suite");
    assert.deepEqual([...complete.stdout.matchAll(/FIXTURE_TEST (\d+)/g)].map((match) => Number(match[1])).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6], "every fixture test must execute exactly once through the remote test command");
    const failed = runFixture({ FIXTURE_FAIL_SHARD: "2" });
    assert.equal(failed.status, 1, "a failed shard must fail the remote test stage");
    assert.match(failed.stderr, /shard 2 exited 1/);
    const incomplete = runFixture({ FIXTURE_MISSING_MARKER: "2" });
    assert.equal(incomplete.status, 1, "a shard with no coverage marker must fail the remote test stage");
    assert.match(incomplete.stderr, /printed no PHX_SHARD_RESULT line/);

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

    // 9d — A LOCK TIMEOUT IS NOT A FAILING CHECK, AND THIS RUNS THE REAL `flock` TO PROVE IT. The
    // stage is shaped exactly like the typecheck — `flock -w <seconds> <file> <command>` — and another
    // process holds that file for longer than the wait. Before the probe, the expiry arrived as exit 1
    // (tsc's own code for type errors) and the run printed `FAIL — <sha>` for a stage that never read
    // a line of the code; it must be LOCK-TIMEOUT and exit 9 (NO VERDICT).
    const stageLock = path.join(tmp, "stage.lock");
    writeFileSync(stageLock, "");
    const holder = spawn("flock", [stageLock, "sleep", "6"], { stdio: "ignore" });
    await new Promise((done) => setTimeout(done, 400));
    const locked = await runBox(newRunId(withFile), withFile, "flock -w 1 " + stageLock + " true");
    holder.kill();
    assert.equal(locked.status, 9, "a stage that waited out its lock did not exit 9 (NO VERDICT):\n" + locked.out);
    assert.match(locked.out, /--- probe LOCK-TIMEOUT in/, "the stage must be reported as a lock timeout, not as a failure");
    assert.doesNotMatch(locked.out, /--- probe FAIL/, "a stage that never ran must not be reported as a failing check");

    // 9e — AND NEITHER IS AN INSTALL THAT COULD NOT RUN. Nothing is checked out-of-order here: the
    // install fails, no stage starts, and the run must say so rather than exit 1.
    const noInstall = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (status) => resolve({ status, out }));
      child.stdin.end(
        buildRunScript({
          remoteRoot,
          runId: newRunId(withFile),
          sha: withFile,
          install: "false",
          steps: [{ name: "probe", command: "true" }],
          lockFile: path.join(remoteRoot, "lock-install"),
        }),
      );
    });
    assert.equal(noInstall.status, 7, "a failed install did not exit 7 (NO VERDICT):\n" + noInstall.out);
    assert.doesNotMatch(noInstall.out, /=== probe ===/, "no stage may run after the install failed");

    // 9f — AND A SIGNAL IS NOT THE BRANCH EITHER. The box's memory watchdog, a reboot and a `kill`
    // aimed at a stranded run all arrive this way; the trap exited 130 until 2026-10-06, which fell
    // through remote-check.mjs's NO-VERDICT arms and printed the FAIL line.
    const signalled = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
      let out = "";
      let killed = false;
      const onData = (chunk: unknown) => {
        out += String(chunk);
        if (!killed && out.includes("=== probe ===")) {
          killed = true;
          // The whole group: bash defers a trap until the foreground command returns, so `sleep`
          // has to go with it — which is exactly how a reap on the box arrives.
          setTimeout(() => {
            try {
              process.kill(-(child.pid as number), "SIGTERM");
            } catch {
              /* already gone */
            }
          }, 200);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (status) => resolve({ status, out }));
      child.stdin.end(
        buildRunScript({
          remoteRoot,
          runId: newRunId(withFile),
          sha: withFile,
          install: "true",
          steps: [{ name: "probe", command: "sleep 30" }],
          lockFile: path.join(remoteRoot, "lock-signal"),
        }),
      );
    });
    assert.equal(signalled.status, 8, "an interrupted run did not exit 8 (NO VERDICT):\n" + signalled.out);
    assert.match(signalled.out, /INTERRUPTED by a signal/, "an interrupted run must say so");
    assert.doesNotMatch(signalled.out, /--- probe FAIL/, "a reaped stage must not be reported as a failing check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
