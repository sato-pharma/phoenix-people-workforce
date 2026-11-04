// A merge of a PR too SMALL to be worth its own two CI runs must be REFUSED, and everything else —
// including every merge of a real-sized PR — must go straight through.
//
// WHY THIS EXISTS. A merge costs two full CI runs whatever its size: one on the PR, one on `main`.
// GitHub rounds every JOB up to a whole minute, so a nine-second job bills a minute and a three-file
// change costs almost exactly what a three-hundred-file change costs. Measured 2026-09-29 on this
// repository: 110 merges in a single day, 280 ci.yml runs (185 pull_request + 95 push), 634 runs
// across all workflows, and over the preceding week 41% of merges touched 3 files or fewer. The
// owner's spend that day was $65 by his own reading of the invoice, against a previous monthly
// record of $300.88.
//
// No runner change reaches that. Where the jobs execute does not alter how many of them there are,
// which is why the self-hosted pool was stood down the same evening having carried no CI at all.
//
// 🔴 IT REFUSES SIZE, NEVER TIMING, AND THAT IS THE OWNER'S OWN NARROWING. A cooldown between
// merges was built first and he cut it the same evening: merges must go through when they are
// ready. So there is no state file, no counter and no window here — a reader who "restores" a
// cooldown is reversing his decision, not completing the clause. The allow cases below pin that:
// two merges back to back are both allowed.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing. `gh` is a shim on PATH rather
// than the real CLI, so the size half is exercised end to end — including the hook's own parsing of
// the PR number and of gh's output — without the suite depending on the network.
//
// The ALLOW half is asserted as hard as the deny half, and it is the half that decides whether this
// survives contact with a working night. A guard that refused `gh pr view`, `gh pr list`, a commit
// message describing itself, or `gh pr merge --help` would be switched off within a day — and then
// the 110 merges come back.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { GITHUB_OWNER, REPO } from "../scripts/required-check-names.mjs";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * A `gh` on PATH that answers `pr view --json changedFiles` with a fixed number, and exits non-zero
 * for anything else — so a hook that started shelling out to gh for something new would be caught
 * here rather than in production.
 */
function ghShim(
  dir: string,
  changedFiles: number | "fail",
  mergeState?: string,
  // The required checks on the head sha: what C10 falls back to when GitHub answers UNKNOWN for
  // mergeability. "absent" leaves those four calls failing, which is the world before
  // 2026-10-01 and must keep every refusal below exactly as it was.
  checks: "green" | "red" | "absent" = "absent",
): string {
  const binDir = mkdtempSync(join(dir, "bin-"));
  // A shim given no `mergeState` answers the SIZE question only and exits non-zero for the state
  // one — which is the pre-2026-10-01 world, and is why every refusal below still refuses: an
  // unreadable state must leave the size refusal exactly as it was, never fail open.
  // The state answer is the RAW JSON gh returns for `--json state,mergeStateStatus`, because the
  // hook asks without `--jq`: on Windows `shell: true` concatenates arguments unescaped, so a jq
  // expression carrying quotes and spaces reached gh as stray positional arguments and the call
  // exited 1 every time — a failure indistinguishable from "cannot read", which would have refused
  // every green PR while the tests passed. Caught 2026-10-01 by replicating the call by hand.
  const [prState = "", statusName = ""] = (mergeState ?? "").split("/");
  const stateJson = `{"state":"${prState}","mergeStateStatus":"${statusName}"}`;
  // Both required contexts, last-run-wins. "red" fails only the SECOND one, so a shim that
  // stopped at the first context would read green and the red case below would pass wrongly.
  const checkRunsJson = JSON.stringify([
    { name: "validate", status: "completed", conclusion: "success" },
    { name: "checks", status: "completed", conclusion: checks === "red" ? "failure" : "success" },
  ]);
  const body =
    changedFiles === "fail"
      ? { sh: "exit 1\n", cmd: "@echo off\r\nexit /b 1\r\n" }
      : {
          // Single-quoted in sh and bare in cmd: both pass the braces and double quotes through
          // untouched, and neither needs an escape that could drift between the two.
          // 🔴 The state branch REFUSES a `--jq`, the way real gh refuses the stray positional
          // arguments one becomes: `shell: true` on Windows concatenates arguments unescaped, so
          // `--jq '.state + "/" + .mergeStateStatus'` exits 1 every time. A stub that tolerated the
          // flag let that ship, because a failed state read looks exactly like "cannot tell". The
          // SIZE call's own `--jq .changedFiles` has no spaces and is matched first, so it still works.
          sh:
            `#!/bin/sh\ncase "$*" in\n  *"pr view"*changedFiles*) echo ${changedFiles} ;;\n` +
            `  *"pr view"*mergeStateStatus*--jq*) exit 1 ;;\n` +
            // C10 asks these four ONLY when mergeability reads UNKNOWN. Matched before the state
            // branch so a `pr view --json headRefOid` is never taken for the state query.
            (checks === "absent"
              ? ""
              : `  *nameWithOwner*) echo o/r ;;\n` +
                `  *required_status_checks*) echo '[\"validate\","checks\"]' ;;\n` +
                `  *headRefOid*) echo deadbeef ;;\n` +
                `  *check-runs*) echo '${checkRunsJson}' ;;\n`) +
            (mergeState ? `  *"pr view"*mergeStateStatus*) echo '${stateJson}' ;;\n` : "") +
            `  *) exit 1 ;;\nesac\n`,
          // cmd.exe has no case/esac: branch on whether the arguments mention mergeStateStatus.
          // 🔴 Written with `if errorlevel`, never `findstr … && (exit /b 1) || (echo …)`: in that
          // one-liner cmd runs the `||` branch after `exit /b 1` too, so the shim ANSWERED the state
          // query with the file count instead of failing — and the fail-closed assertion below then
          // passed against a guard that had been broken open (caught 2026-10-01 by breaking it).
          cmd:
            `@echo off\r\n` +
            (checks === "absent"
              ? ""
              : `echo %* | findstr /C:\"nameWithOwner\" >nul\r\nif not errorlevel 1 (echo o/r\r\n  exit /b 0\r\n)\r\n` +
                `echo %* | findstr /C:\"required_status_checks\" >nul\r\nif not errorlevel 1 (echo [\"validate\",\"checks\"]\r\n  exit /b 0\r\n)\r\n` +
                `echo %* | findstr /C:\"headRefOid\" >nul\r\nif not errorlevel 1 (echo deadbeef\r\n  exit /b 0\r\n)\r\n` +
                `echo %* | findstr /C:\"check-runs\" >nul\r\nif not errorlevel 1 (echo ${checkRunsJson}\r\n  exit /b 0\r\n)\r\n`) +
            `echo %* | findstr /C:"mergeStateStatus" >nul\r\nif errorlevel 1 (echo ${changedFiles}\r\n  exit /b 0\r\n)\r\n` +
            `echo %* | findstr /C:"--jq" >nul\r\nif not errorlevel 1 exit /b 1\r\n` +
            (mergeState ? `echo ${stateJson}\r\n` : `exit /b 1\r\n`),
        };
  const sh = join(binDir, "gh");
  writeFileSync(sh, changedFiles === "fail" ? "#!/bin/sh\nexit 1\n" : body.sh, "utf8");
  try {
    chmodSync(sh, 0o755);
  } catch {
    /* Windows has no execute bit; the .cmd below is what runs there */
  }
  writeFileSync(join(binDir, "gh.cmd"), body.cmd, "utf8");
  return binDir;
}

/**
 * A `gh` from two hand-written bodies, sh and cmd — for the `--repo` cases, whose questions the
 * fixed-answer shim above cannot tell apart.
 */
function scriptedGh(dir: string, sh: string, cmd: string): string {
  const binDir = mkdtempSync(join(dir, "bin-"));
  const shPath = join(binDir, "gh");
  writeFileSync(shPath, sh, "utf8");
  try {
    chmodSync(shPath, 0o755);
  } catch {
    /* Windows has no execute bit; the .cmd below is what runs there */
  }
  writeFileSync(join(binDir, "gh.cmd"), cmd, "utf8");
  return binDir;
}

/**
 * The tool payload on stdin, as settings.json delivers it. PHX_MERGE_OK is cleared out of the
 * environment so no ambient opt-out can be the thing that answered: every deny below is C10's, and
 * every allow is C9 standing aside.
 */
function runGuard(
  cwd: string,
  command: string,
  opts: { ghDir?: string; minFiles?: number; tool?: string } = {},
): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_MERGE_OK;
  // C21 (a merge on red checks) runs first and has its own file, merge-checks-guard.test.ts; it is
  // stood down here so every answer below is C10's or C13's, judged against these shims alone.
  env.PHX_RED_MERGE_OK = "1";
  if (opts.minFiles !== undefined) env.PHX_MERGE_MIN_FILES = String(opts.minFiles);
  if (opts.ghDir) env.PATH = opts.ghDir + delimiter + (env.PATH ?? "");

  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: opts.tool ?? "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  if (start < 0) return { decision: "allow", reason: raw };
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return {
    decision: output.permissionDecision,
    reason: String(output.permissionDecisionReason ?? ""),
  };
}


/** Same as runGuard, with arbitrary extra environment — used by C11's cases. */
function runGuardEnv(cwd: string, command: string, extra: Record<string, string>): Decision {
  const env = { ...process.env, ...extra };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_MERGE_OK;
  // C21 (a merge on red checks) runs first and has its own file, merge-checks-guard.test.ts; it is
  // stood down here so every answer below is C10's or C13's, judged against these shims alone.
  env.PHX_RED_MERGE_OK = "1";
  delete env.PHX_SMOKE_OK;
  if (/PHX_SMOKE_OK=1/.test(command)) {
    /* the inline form is the point of that case — leave the command to carry it */
  }
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  if (start < 0) return { decision: "allow", reason: raw };
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return {
    decision: output.permissionDecision,
    reason: String(output.permissionDecisionReason ?? ""),
  };
}

/** A state dir for C11's machine-wide daily counter. */
function smokeEnv(dir: string, max?: number): Record<string, string> {
  const env: Record<string, string> = { PHX_SMOKE_STATE_DIR: dir };
  if (max !== undefined) env.PHX_SMOKE_MAX_PER_DAY = String(max);
  return env;
}

/**
 * C11 — the production smoke suite may be dispatched by hand only a couple of times a day, counted
 * MACHINE-WIDE.
 *
 * WHY. `synthetic-journeys` bills ~3 minutes a run, and its cadence is a cost decision already
 * taken: hourly until 2026-08-29 (17/day), cut to 6/day to save Actions minutes at the stated price
 * of ~3h worst-case detection latency. Measured 2026-09-29 it ran 21 times — 2 scheduled and 19 by
 * hand — about 57 billable minutes of unplanned spend, three times the whole schedule.
 *
 * 🔴 THE EXISTING C9 CANNOT COVER THIS, and that is why a second clause exists rather than a wider
 * one: C9 counts per SESSION and exempts `main` entirely, while these are main dispatches spread
 * across fifteen windows. A reader who "consolidates" the two puts this case back in the blind spot.
 */
export function runSmokeDispatchGuardTests(): void {
  const dir = mkdtempSync(join(tmpdir(), "phx-smoke-guard-"));
  try {
    {
      const state = mkdtempSync(join(dir, "count-"));
      const cmd = "gh workflow run synthetic-journeys.yml --ref main";
      assert.equal(runGuardEnv(dir, cmd, smokeEnv(state)).decision, "allow", "1st of the day");
      assert.equal(runGuardEnv(dir, cmd, smokeEnv(state)).decision, "allow", "2nd of the day");
      const third = runGuardEnv(dir, cmd, smokeEnv(state));
      assert.equal(third.decision, "deny", "the 3rd manual dispatch in a day must be refused");
      assert.match(
        third.reason,
        /across all sessions/i,
        "the refusal must say the count is machine-wide — per session is exactly the blind spot " +
          "that let 19 through on 2026-09-29",
      );
      assert.match(third.reason, /PHX_SMOKE_OK=1/, "production being suspect must still have a path");
    }

    {
      const state = mkdtempSync(join(dir, "standdown-"));
      const cmd = "PHX_SMOKE_OK=1 gh workflow run synthetic-journeys.yml --ref main";
      for (let i = 0; i < 4; i += 1) {
        assert.equal(
          runGuardEnv(dir, cmd, smokeEnv(state, 0)).decision,
          "allow",
          "the stand-down must work even at a cap of zero — the suite exists for the moment " +
            "production is suspect, and a hard block would break exactly that case",
        );
      }
    }

    {
      const state = mkdtempSync(join(dir, "others-"));
      for (const cmd of [
        "gh workflow run mobile-build.yml --ref main",
        "gh workflow run ci.yml --ref main",
        'git commit -m "docs: gh workflow run synthetic-journeys.yml is capped now"',
      ]) {
        assert.equal(
          runGuardEnv(dir, cmd, smokeEnv(state, 0)).decision,
          "allow",
          `C11 must touch nothing but a real synthetic-journeys dispatch: ${cmd}`,
        );
      }
    }

    {
      const missing = join(dir, "no", "such", "dir");
      assert.equal(
        runGuardEnv(dir, "gh workflow run synthetic-journeys.yml", smokeEnv(missing)).decision,
        "allow",
        "an unwritable state directory must fail OPEN — with the default cap and nothing on record, " +
          "the dispatch goes through and the failed write is swallowed. (At a cap of ZERO the deny " +
          "fires before any write is attempted, which is correct and is covered by the case above.)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runMergeCooldownGuardTests(): void {
  const dir = mkdtempSync(join(tmpdir(), "phx-merge-guard-"));
  try {
    // ---- the size refusal --------------------------------------------------

    {
      const gh = ghShim(dir, 2);
      const small = runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh });
      assert.equal(small.decision, "deny", "a 2-file PR must be refused at the default threshold");
      assert.match(
        small.reason,
        /two full CI runs/i,
        "the refusal must say WHY — a merge costs the same two runs whatever its size, which is the " +
          "whole reason size is the thing being refused",
      );
      assert.match(
        small.reason,
        /PHX_MERGE_OK=1/,
        "every refusal must carry its own stand-down, or an urgent one-file fix has no way past it",
      );
      assert.doesNotMatch(
        small.reason,
        /cooldown|wait|minutes? (?:left|ago)/i,
        "the refusal must NOT talk about waiting. The owner cut the cooldown on 2026-09-29: merges " +
          "go when they are ready, and only size is refused",
      );
    }

    {
      const gh = ghShim(dir, 3);
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "deny",
        "3 files is still below the default threshold of 4",
      );
    }

    // ---- an already-open, already-GREEN PR goes straight through -----------
    //
    // Owner, 2026-10-01: "make the merge guard stop blocking an already-green PR". Before this, the
    // only way past the size refusal was PHX_MERGE_OK=1, which the auto-mode classifier refuses as a
    // [Safety Bypass Flag] — so the two guards deadlocked and a small PR could not be merged by a
    // session at all (measured on #4988, which the owner had to press Squash and merge on himself).
    // Once the PR is green its run is already PAID, so the refusal saves nothing.

    {
      const gh = ghShim(dir, 2, "OPEN/CLEAN");
      const green = runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh });
      assert.equal(
        green.decision,
        "allow",
        "a 2-file PR that is OPEN and CLEAN must merge with NO stand-down — its PR run is paid, and " +
          "the stand-down is the very thing the classifier refuses",
      );
      assert.equal(green.reason, "", "and it passes silently: an allow that lectures is a deny nobody reads");
    }

    {
      // BLOCKED with the check-runs UNREADABLE: nothing here can tell whether the checks passed, so
      // the size refusal stands exactly as it did. That is the case this started as — see the pair
      // below for what BLOCKED means once the checks CAN be read, which is the ordinary world.
      const gh = ghShim(dir, 2, "OPEN/BLOCKED");
      const blocked = runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh });
      assert.equal(blocked.decision, "deny", "a small PR whose checks have not passed is still refused");
      assert.match(
        blocked.reason,
        /NOT GREEN YET/i,
        "and the refusal says which of the two reasons it is, or the reader retries the stand-down the " +
          "classifier will refuse",
      );
      assert.doesNotMatch(
        blocked.reason,
        /ALREADY OPEN AND GREEN, MERGE IT WITH THE STAND-DOWN/i,
        "the old advice is gone: it sent the reader to a flag that is refused, which is the deadlock",
      );
    }

    {
      // 🔴 BLOCKED WITH BOTH REQUIRED CHECKS GREEN MUST MERGE — THE MEASURED DEFECT, 2026-10-02.
      // The comment this pair replaces read "BLOCKED is the state of a PR whose required checks have
      // not passed", and the exemption was gated on UNKNOWN alone because of it. BLOCKED is also the
      // value GitHub is still HOLDING from before the checks finished: #5125 had `validate` and
      // `checks` both `completed/success` on head `737ed27ba`, read by hand seconds earlier, and C10
      // refused the owner's approved merge anyway — then pointed at the stand-down the classifier
      // refuses as a [Safety Bypass Flag], which is the deadlock the exemption exists to end.
      const gh = ghShim(dir, 2, "OPEN/BLOCKED", "green");
      const blockedGreen = runGuard(dir, "gh pr merge 5125 --squash", { ghDir: gh });
      assert.equal(
        blockedGreen.decision,
        "allow",
        "mergeability reading BLOCKED must not refuse a PR whose required checks have all passed — " +
          "BLOCKED is as stale as UNKNOWN, and the PR's run is already paid",
      );
      assert.equal(blockedGreen.reason, "", "and it passes silently, like every other already-green merge");
    }

    {
      // And BLOCKED must not become a way past a RED check. Only the second required context fails,
      // so a fallback that stopped at the first would read green and this would pass against a guard
      // broken open.
      const gh = ghShim(dir, 2, "OPEN/BLOCKED", "red");
      assert.equal(
        runGuard(dir, "gh pr merge 5125 --squash", { ghDir: gh }).decision,
        "deny",
        "a failing required check must still refuse the merge, BLOCKED or not",
      );
    }

    {
      // UNSTABLE means mergeable, required checks green, but a NON-required check red — `mobile` and
      // `secret-scan` stopped gating here on 2026-09-29. Deliberately NOT waved through: something is
      // red and deserves a look, and the stand-down still covers it.
      const gh = ghShim(dir, 2, "OPEN/UNSTABLE");
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "deny",
        "UNSTABLE is not green: a red non-required check is a thing to read, not to merge past silently",
      );
    }

    {
      // 🔴 AND IT STAYS REFUSED WHEN THE CHECK-RUNS ARE READABLE AND GREEN — the case the BLOCKED fix
      // above could have swallowed. Widening the exemption to "any OPEN state that is not CLEAN"
      // passes every assertion in this file, because the UNSTABLE case above reads its check-runs as
      // `absent`: the policy lived in the clause's shape, not in an assertion. UNSTABLE's required
      // checks ARE green by definition — that is what distinguishes it from BLOCKED — so this is the
      // one state where green required checks are deliberately not enough.
      const gh = ghShim(dir, 2, "OPEN/UNSTABLE", "green");
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "deny",
        "UNSTABLE must be refused even with both required contexts green — the red check is non-required, " +
          "which is exactly why nothing else will show it to anyone",
      );
    }

    {
      // GitHub computes mergeability lazily and answers UNKNOWN until it has — the normal reading for
      // a minute or two after `main` moves, which is exactly when a session merges. #4991 read
      // OPEN/UNKNOWN on 2026-10-01 while genuinely waiting on nothing but that bookkeeping. The hook
      // asks a second time, so this shim answers UNKNOWN once and CLEAN after.
      const binDir = mkdtempSync(join(dir, "bin-flip-"));
      const counter = join(binDir, "asked");
      const clean = '{"state":"OPEN","mergeStateStatus":"CLEAN"}';
      const unknown = '{"state":"OPEN","mergeStateStatus":"UNKNOWN"}';
      writeFileSync(
        join(binDir, "gh"),
        `#!/bin/sh\ncase "$*" in\n  *"pr view"*changedFiles*) echo 2 ;;\n  *"pr view"*mergeStateStatus*)\n` +
          `    if [ -f '${counter}' ]; then echo '${clean}'; else : > '${counter}'; echo '${unknown}'; fi ;;\n` +
          `  *) exit 1 ;;\nesac\n`,
        "utf8",
      );
      try {
        chmodSync(join(binDir, "gh"), 0o755);
      } catch {
        /* Windows has no execute bit */
      }
      writeFileSync(
        join(binDir, "gh.cmd"),
        `@echo off\r\necho %* | findstr /C:"mergeStateStatus" >nul\r\n` +
          `if errorlevel 1 (echo 2) else (\r\n` +
          `  if exist "${counter}" (echo ${clean}) else (\r\n` +
          `    type nul > "${counter}"\r\n    echo ${unknown}\r\n  )\r\n)\r\n`,
        "utf8",
      );
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: binDir }).decision,
        "allow",
        "an UNKNOWN merge state is asked again: GitHub had not computed mergeability yet, which is not a " +
          "reason to refuse a green PR",
      );
    }

    {
      // 🔴 UNKNOWN THAT STAYS UNKNOWN, WHICH IS THE MEASURED COMMON CASE AND NOT AN EDGE. On
      // 2026-10-01 twelve merges landed on `main` inside 45 minutes and mergeability read UNKNOWN
      // for MINUTES at a time, long past the one 1.5s retry above, while `gh pr checks` showed both
      // required contexts `pass`. Two sessions were refused a green PR in that window and one of
      // them went looking for the documented stand-down, which is exactly the wrong instinct to
      // teach. `mergeStateStatus` conflates "the checks passed" with "GitHub has finished its
      // bookkeeping", and only the first decides whether this PR's run is already paid — so the
      // hook now reads the required contexts off branch protection and their check-runs on the head.
      const gh = ghShim(dir, 2, "OPEN/UNKNOWN", "green");
      assert.equal(
        runGuard(dir, "gh pr merge 5047 --squash", { ghDir: gh }).decision,
        "allow",
        "mergeability stuck at UNKNOWN must not refuse a PR whose required checks have all passed — its PR run is already paid, so refusing saves nothing and only risks the work being rebuilt",
      );
    }

    {
      // And the fallback must not become a way past a RED check. Only the second required context
      // fails here, so a fallback that stopped at the first would read green and this would pass
      // against a guard broken open.
      const gh = ghShim(dir, 2, "OPEN/UNKNOWN", "red");
      assert.equal(
        runGuard(dir, "gh pr merge 5047 --squash", { ghDir: gh }).decision,
        "deny",
        "a failing required check must still refuse the merge, however UNKNOWN the mergeability reads",
      );
    }

    {
      // Unreadable protection or check-runs keeps TODAY'S REFUSAL rather than failing open — one
      // `gh` hiccup must not retire the clause, which is the failure a guard cannot report on itself.
      const gh = ghShim(dir, 2, "OPEN/UNKNOWN", "absent");
      assert.equal(
        runGuard(dir, "gh pr merge 5047 --squash", { ghDir: gh }).decision,
        "deny",
        "an unreadable required-check list must leave the size refusal exactly as it was",
      );
    }

    {
      const gh = ghShim(dir, 2, "MERGED/CLEAN");
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "deny",
        "CLEAN alone is not the test — the PR must be OPEN, or a closed PR's stale state waves a merge through",
      );
    }

    {
      // The same requirement on the check-runs path: a PR that is no longer OPEN cannot have a run
      // that is "already paid", so green checks on a MERGED one must not promote it either. #5125
      // read MERGED/UNKNOWN minutes after it landed, with both contexts green on its old head.
      const gh = ghShim(dir, 2, "MERGED/BLOCKED", "green");
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "deny",
        "green required checks must not promote a PR that is not OPEN — the exemption is about an open PR's paid run",
      );
    }

    {
      // The size question answered, the state question NOT — one gh hiccup must not retire the clause.
      // This is the shim every refusal above uses, which is why they all still refuse.
      const gh = ghShim(dir, 2);
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "deny",
        "an unreadable merge state keeps the refusal: failing open here would switch the clause off " +
          "silently, and a guard cannot report its own silence",
      );
    }

    {
      const gh = ghShim(dir, 4);
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "allow",
        "4 files is a real change and must merge — the boundary is the thing a later edit gets wrong",
      );
    }

    {
      const gh = ghShim(dir, 40);
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "allow",
        "a large PR must never be refused",
      );
    }

    {
      // The threshold is configurable, and 0 disables the clause entirely.
      const gh = ghShim(dir, 2);
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh, minFiles: 0 }).decision,
        "allow",
        "PHX_MERGE_MIN_FILES=0 must switch the clause off rather than defaulting back on",
      );
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh, minFiles: 2 }).decision,
        "allow",
        "2 files at a threshold of 2 is not BELOW it",
      );
    }

    // ---- no timing, ever ---------------------------------------------------

    {
      const gh = ghShim(dir, 12);
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "allow",
        "first merge allowed",
      );
      assert.equal(
        runGuard(dir, "gh pr merge 4791 --squash", { ghDir: gh }).decision,
        "allow",
        "a SECOND merge immediately after must also be allowed. The owner cut the cooldown: this " +
          "clause refuses size and nothing else, and restoring a wait here reverses his decision",
      );
    }

    // ---- the stand-down ----------------------------------------------------

    for (const [label, command, tool] of [
      ["bash", "PHX_MERGE_OK=1 gh pr merge 4790 --squash", "Bash"],
      ["powershell", "$env:PHX_MERGE_OK=1; gh pr merge 4790 --squash", "PowerShell"],
    ] as const) {
      const gh = ghShim(dir, 1);
      assert.equal(
        runGuard(dir, command, { ghDir: gh, tool }).decision,
        "allow",
        `the ${label} stand-down must let a one-file merge through — without it an urgent fix has ` +
          `no path and the guard gets deleted instead of used`,
      );
    }

    // ---- fail open ---------------------------------------------------------

    {
      const gh = ghShim(dir, "fail");
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "allow",
        "if gh cannot answer, the merge must be ALLOWED — a guard that blocks a real merge on its " +
          "own blind spot costs more than the runs it saves",
      );
    }

    {
      const gh = ghShim(dir, 1);
      assert.equal(
        runGuard(dir, "gh pr merge --squash", { ghDir: gh }).decision,
        "allow",
        "a merge of the CURRENT branch carries no PR number — allow rather than guess at one",
      );
    }

    // ---- another repository's PR: `--repo` / `-R` ----------------------------
    //
    // 🔴 C10 and C13 are Phoenix's own CI-cost rules. Until 2026-10-27 both took the bare number and
    // asked `gh pr view <N>` from this folder, so `gh pr merge 49 --repo <owner>/phoenix-next` was
    // judged as PHOENIX's #49 — its size, its checks, its roll-ups — and refused on facts about a
    // different PR. ghShim(dir, 2) answers every size question with 2 files, so each command below
    // is refused unless the clause stepped aside without asking gh anything.

    const otherRepo = `${GITHUB_OWNER}/phoenix-next`;
    for (const [label, command, tool] of [
      ["--repo", `gh pr merge 49 --repo ${otherRepo} --squash`, "Bash"],
      ["-R", `gh pr merge 49 -R ${otherRepo} --squash`, "Bash"],
      ["--repo=", `gh pr merge 49 --squash --repo=${otherRepo}`, "Bash"],
      ["-R glued to its value", `gh pr merge 49 --squash -R${otherRepo}`, "Bash"],
      ["HOST/OWNER/REPO", `gh pr merge 49 --squash --repo github.com/${otherRepo}`, "Bash"],
      ["another account's repository", "gh pr merge 49 --squash --repo octo-org/octo-repo", "Bash"],
      ["PowerShell", `gh pr merge 49 --repo ${otherRepo} --squash`, "PowerShell"],
    ] as const) {
      const gh = ghShim(dir, 2);
      assert.deepEqual(
        runGuard(dir, command, { ghDir: gh, tool }),
        { decision: "allow", reason: "" },
        `a merge naming another repository with ${label} must not be judged as Phoenix's PR of the ` +
          `same number: ${command}`,
      );
    }

    {
      // The control: the very shim above refuses the same merge when no repository is named.
      const gh = ghShim(dir, 2);
      assert.equal(
        runGuard(dir, "gh pr merge 49 --squash", { ghDir: gh }).decision,
        "deny",
        "with no --repo the merge is Phoenix's and the size refusal must still fire",
      );
    }

    for (const [label, command] of [
      ["--repo", `gh pr merge 4790 --squash --repo ${REPO}`],
      ["-R in another case", `gh pr merge 4790 --squash -R ${REPO.toUpperCase()}`],
      ["--repo= as a URL", `gh pr merge 4790 --squash --repo=https://github.com/${REPO}.git`],
      // `-r` is `--rebase`, not `-R`: a rebase merge names no repository and is judged like any other.
      ["-r, which is --rebase", "gh pr merge 4790 -r"],
    ] as const) {
      const gh = ghShim(dir, 2);
      assert.equal(
        runGuard(dir, command, { ghDir: gh }).decision,
        "deny",
        `Phoenix named explicitly (${label}) is still Phoenix's PR and must still be judged: ${command}`,
      );
    }

    {
      // When Phoenix is named, the hook's own `gh` calls name it too — so the answer is Phoenix's PR
      // even from a session sitting in another repository's folder. This gh answers the size question
      // ONLY when it carries `--repo <Phoenix>`, in the constant's spelling rather than the typed one.
      const gh = scriptedGh(
        dir,
        `#!/bin/sh\ncase "$*" in\n  *"pr view"*changedFiles*"--repo ${REPO}"*) echo 2 ;;\n  *) exit 1 ;;\nesac\n`,
        `@echo off\r\n` +
          `echo %* | findstr /C:"--repo ${REPO}" >nul\r\nif errorlevel 1 exit /b 1\r\n` +
          `echo %* | findstr /C:"changedFiles" >nul\r\nif errorlevel 1 exit /b 1\r\n` +
          `echo 2\r\n`,
      );
      assert.equal(
        runGuard(dir, `gh pr merge 4790 --squash -R ${REPO.toUpperCase()}`, { ghDir: gh }).decision,
        "deny",
        "naming Phoenix must pass `--repo <Phoenix>` on to the hook's own gh calls",
      );
      assert.equal(
        runGuard(dir, "gh pr merge 4790 --squash", { ghDir: gh }).decision,
        "allow",
        "the control: with no --repo typed, this gh cannot answer and the clause fails open — so the " +
          "refusal above came from the flag being passed on",
      );
    }

    {
      // C13: a PR listed in an open roll-up's body is refused — but only Phoenix's. The list comes from
      // a file because cmd's `echo` cannot carry JSON's quotes and an em dash through untouched.
      const rollups = join(dir, "rollups.json");
      writeFileSync(
        rollups,
        JSON.stringify([
          {
            number: 51,
            headRefName: "codex/rollup-20261027-0900",
            headRefOid: "a".repeat(40),
            body: "One approval in place of several.\n\n- #50 — fix(x): a thing (4 files)\n",
          },
        ]),
        "utf8",
      );
      const gh = scriptedGh(
        dir,
        `#!/bin/sh\ncase "$*" in\n  *"pr list"*) cat '${rollups}' ;;\n  *"pr view"*changedFiles*) echo 40 ;;\n  *) exit 1 ;;\nesac\n`,
        `@echo off\r\n` +
          `echo %* | findstr /C:"pr list" >nul\r\nif not errorlevel 1 (type "${rollups}"\r\n  exit /b 0\r\n)\r\n` +
          `echo %* | findstr /C:"changedFiles" >nul\r\nif not errorlevel 1 (echo 40\r\n  exit /b 0\r\n)\r\n` +
          `exit /b 1\r\n`,
      );
      const member = runGuard(dir, "gh pr merge 50 --squash", { ghDir: gh });
      assert.equal(member.decision, "deny", "Phoenix's #50 is a member of roll-up #51 and must be refused");
      assert.match(member.reason, /roll-up #51/, "the refusal must be C13's, naming the roll-up");
      assert.equal(
        runGuard(dir, `gh pr merge 50 --squash --repo ${REPO}`, { ghDir: gh }).decision,
        "deny",
        "Phoenix named explicitly keeps the roll-up check",
      );
      assert.deepEqual(
        runGuard(dir, `gh pr merge 50 --squash --repo ${otherRepo}`, { ghDir: gh }),
        { decision: "allow", reason: "" },
        "another repository's #50 is not Phoenix's roll-up member — C13 must step aside with C10",
      );
    }

    {
      // 🔴 `--auto` stays refused for EVERY repository. The refusal is settings.json's deny, never this
      // hook, so two things must hold: the deny's glob still matches the `--repo` spellings, and the
      // hook says NOTHING about them — an explicit allow from a hook is the one thing that could
      // pre-empt a permission rule.
      const autoCommands = [
        `gh pr merge 49 --repo ${otherRepo} --auto --squash`,
        `gh pr merge 49 -R ${otherRepo} --squash --auto`,
        `gh pr merge 49 --auto --repo=${otherRepo}`,
        `gh pr merge 4790 --squash --auto --repo ${REPO}`,
      ];
      const deny: string[] =
        JSON.parse(readFileSync(resolve(".claude/settings.json"), "utf8"))?.permissions?.deny ?? [];
      for (const tool of ["Bash", "PowerShell"]) {
        const rule = deny.find((r) => r.startsWith(`${tool}(gh pr merge`) && r.includes("--auto"));
        assert.ok(rule, `settings.json must keep its ${tool} deny on \`gh pr merge --auto\``);
        const glob = rule.slice(tool.length + 1, -1);
        const pattern = new RegExp(
          "^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
        );
        for (const command of autoCommands) {
          assert.match(command, pattern, `${rule} must still refuse: ${command}`);
        }
      }
      const gh = ghShim(dir, 40);
      for (const command of autoCommands) {
        assert.deepEqual(
          runGuard(dir, command, { ghDir: gh }),
          { decision: "allow", reason: "" },
          `the hook must emit no decision on ${command} — settings.json's deny is what refuses it`,
        );
      }
    }

    // ---- the allow half: everything that merely MENTIONS a merge ------------

    for (const command of [
      "gh pr merge --help",
      "gh pr view 4791 --json state",
      "gh pr list --state merged",
      "gh pr checks 4791",
      'git commit -m "docs(ci): explain why gh pr merge refuses a 3-file PR"',
      "git merge --ff-only origin/main",
      "rg 'gh pr merge' docs/",
    ]) {
      const gh = ghShim(dir, 1);
      assert.equal(
        runGuard(dir, command, { ghDir: gh }).decision,
        "allow",
        `must never be refused: ${command}`,
      );
    }

    {
      // A heredoc body quoting the command is documentation, not a merge.
      const gh = ghShim(dir, 1);
      const heredoc = [
        "cat > note.md <<'EOF'",
        "To ship it, run:",
        "gh pr merge 4791 --squash",
        "EOF",
      ].join("\n");
      assert.equal(
        runGuard(dir, heredoc, { ghDir: gh }).decision,
        "allow",
        "a heredoc body that quotes the command must not be read as running it",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
