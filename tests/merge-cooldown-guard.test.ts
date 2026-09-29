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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * A `gh` on PATH that answers `pr view --json changedFiles` with a fixed number, and exits non-zero
 * for anything else — so a hook that started shelling out to gh for something new would be caught
 * here rather than in production.
 */
function ghShim(dir: string, changedFiles: number | "fail"): string {
  const binDir = mkdtempSync(join(dir, "bin-"));
  const body =
    changedFiles === "fail"
      ? { sh: "exit 1\n", cmd: "@echo off\r\nexit /b 1\r\n" }
      : {
          sh: `#!/bin/sh\ncase "$*" in\n  *"pr view"*changedFiles*) echo ${changedFiles} ;;\n  *) exit 1 ;;\nesac\n`,
          cmd: `@echo off\r\necho ${changedFiles}\r\n`,
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
