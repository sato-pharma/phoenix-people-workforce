// bash-guard C19: a command that would land in Python's INTERACTIVE REPL is refused (2026-10-15).
//
// WHY THIS EXISTS. Three background Bash tasks launched an interactive Python — a bare `python` with
// no script, and one `python - <<'PY'` whose closing delimiter never arrived — and with no console
// attached, 3.13/3.14's _pyrepl dies inside Lib/_pyrepl/windows_console.py `getheightwidth` with
// `OSError: [WinError 123]` and reprints that traceback for ever. The harness writes a background
// task's output to `…/tasks/<id>.output`, so the loop went to disk: 12.5 GB, 5.4 GB and 2.4 GB on
// 9, 10 and 15 Oct 2026, and C: was down to 12 GB free before anyone looked. Measured on this box
// on 2026-10-15, both interpreters: 1,774,873 bytes in 3 s and 3,948,442 in 6 s — about 640 KB/s,
// 2.2 GB an hour. `PYTHON_BASIC_REPL=1` writes 176 bytes and exits.
//
// A markdown rule cannot close this: the command looks harmless, and the session that sends it has
// usually already ended its turn — nothing is watching the output grow. bash-guard is re-read by
// node on every tool call, so the refusal reaches sessions that are already open.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.
//
// The allow half is asserted as hard as the deny half, and it is the half that decides whether this
// survives. A guard that refused `python script.py`, `python -c`, `python -m`, a well-formed
// heredoc, a pipe into python, `--version`, or a doc or commit message that merely MENTIONS a bare
// python would be switched off within a day — and then the disk fills again.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * The tool payload on stdin, as settings.json delivers it. The cwd is a folder that is NOT a git
 * repository, CLAUDE_PROJECT_DIR is deleted and both stand-down variables are cleared out of the
 * environment, so no other clause and no ambient opt-out can be the thing that answered.
 */
function runGuard(cwd: string, command: string, tool = "Bash", background = false): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_PYTHON_REPL_OK;
  delete env.PYTHON_BASIC_REPL;
  const tool_input: Record<string, unknown> = { command };
  if (background) tool_input.run_in_background = true;
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: tool, cwd, tool_input }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

/** The heredoc as the 15 Oct task sent it — opened, never closed, so python got no script at all. */
const UNCLOSED_HEREDOC = [
  "python - <<'PY'",
  "import json, pathlib",
  'print(json.dumps({"rows": 3}))',
].join("\n");

/** The same body with the delimiter indented, which `<<` (no dash) does not accept as the end. */
const INDENTED_DELIMITER = ["python3 - <<PY", "print(1)", "  PY"].join("\n");

/** A well-formed one, which must pass: this is the shape the refusal tells the session to use. */
const CLOSED_HEREDOC = ["python - <<'PY'", "import os", "print(os.getcwd())", "PY"].join("\n");

/** A heredoc BODY that documents the trap. Writing the rule down must not trip it. */
const HEREDOC_NOTE = [
  "cat > note.md <<'EOF'",
  "Never send this in the background:",
  "python",
  "python - <<'PY' with no closing PY",
  "EOF",
].join("\n");

/** A PowerShell here-string, apostrophe and all — its quote must not flip the quote tracking. */
const HERE_STRING_COMMIT = [
  "$msg = @'",
  "fix(hooks): a bare python's REPL floods the task log",
  "python with no script is refused now",
  "'@",
  "git commit -m $msg",
].join("\n");

/** Commands that land in the REPL. Each carries the segment the refusal must quote back. */
const INTERACTIVE: Array<{ what: string; command: string; tool?: string; background?: boolean; quotes: string }> = [
  { what: "the bare interpreter", command: "python", quotes: "python" },
  { what: "python3", command: "python3", quotes: "python3" },
  { what: "the Windows launcher", command: "py", quotes: "py" },
  { what: "the launcher with a version flag", command: "py -3", quotes: "py -3" },
  { what: "a backgrounded bare python", command: "python", background: true, quotes: "python" },
  { what: "the PowerShell tool", command: "python", tool: "PowerShell", quotes: "python" },
  { what: "a full path with spaces in it", command: '"C:\\Program Files\\Python313\\python.exe" -u', tool: "PowerShell", quotes: "python.exe" },
  { what: "stderr folded into stdout, which is how the task log got it", command: "python 2>&1", quotes: "python 2>&1" },
  { what: "output redirected to a file — the 12.5 GB shape", command: "python > out.log 2>&1", quotes: "python > out.log" },
  { what: "an explicit stdin with nothing feeding it", command: "python -", quotes: "python -" },
  { what: "unbuffered and isolated, flags only", command: "python -u -I -E", quotes: "python -u -I -E" },
  { what: "an -X option whose value is not a script", command: "python -X faulthandler", quotes: "python -X faulthandler" },
  { what: "after a cd", command: 'cd "F:/Phoenix Workforce/_wt-x" && python', quotes: "python" },
  { what: "after a successful probe", command: "test -f data.json && python", quotes: "python" },
  { what: "behind a variable assignment", command: "LC_ALL=C python", quotes: "python" },
  { what: "wrapped in bash -c", command: 'bash -c "python"', quotes: "python" },
  { what: "the 15 Oct unclosed heredoc", command: UNCLOSED_HEREDOC, quotes: "python -" },
  { what: "an indented closing delimiter", command: INDENTED_DELIMITER, quotes: "python3 -" },
  // `-c` does not save a command whose heredoc never closes: bash takes the `<<` for itself and
  // python still ends up at the prompt (the Shell-and-tooling cluster's own warning).
  { what: "an unclosed heredoc even with -c", command: "python -c 'print(1)' <<PY\nnothing closes this", quotes: "python -c" },
];

/** Commands that run something, read something, or only talk about one. All must pass. */
const NOT_INTERACTIVE: Array<{ what: string; command: string; tool?: string; background?: boolean }> = [
  { what: "a script file", command: "python script.py" },
  { what: "a script under a folder, backgrounded", command: "python scripts/extract.py --rows 40", background: true },
  { what: "a script with flags in front of it", command: "python -u -X utf8 scripts/extract.py" },
  { what: "a one-liner", command: 'python -c "print(1)"' },
  { what: "a one-liner that mentions no script", command: "python3 -c 'import sys; print(sys.version)'" },
  { what: "a module", command: "python -m json.tool data.json" },
  { what: "pip through -m", command: "python3 -m pip install --user openpyxl" },
  { what: "venv through -m", command: "py -3 -m venv .venv" },
  { what: "--version, which reads nothing and exits", command: "python --version" },
  { what: "-V", command: "python3 -V" },
  { what: "--help", command: "python --help" },
  { what: "a well-formed heredoc", command: CLOSED_HEREDOC },
  { what: "a well-formed heredoc, backgrounded", command: CLOSED_HEREDOC, background: true },
  { what: "a here-string", command: 'python <<< "print(1)"' },
  { what: "an input redirect", command: "python < script.py" },
  { what: "a pipe into it", command: "printf 'print(1)' | python" },
  { what: "the end of a pipeline", command: "cat script.py | python -" },
  { what: "a script whose output is piped onward", command: "python extract.py | head -20" },
  { what: "another program entirely", command: "git grep -n 'python -' docs" },
  { what: "a mention inside quotes", command: 'echo "never run a bare python in the background"' },
  { what: "a commit message about the rule", command: "git commit -m 'fix(hooks): refuse a bare python REPL'" },
  { what: "a heredoc body documenting the trap", command: HEREDOC_NOTE },
  { what: "a PowerShell here-string documenting it", command: HERE_STRING_COMMIT, tool: "PowerShell" },
  { what: "asking where python is", command: "which python" },
  { what: "a bounded run, which cannot flood", command: "timeout 3 python" },
  // Both stand-downs, in both dialects, with and without quotes around the 1.
  { what: "the stand-down", command: "PHX_PYTHON_REPL_OK=1 python" },
  { what: "the stand-down in PowerShell", command: "$env:PHX_PYTHON_REPL_OK=1; python", tool: "PowerShell" },
  { what: "the fix the refusal names", command: "PYTHON_BASIC_REPL=1 python" },
  { what: "the fix, quoted", command: "PYTHON_BASIC_REPL='1' python" },
  { what: "the fix in PowerShell", command: "$env:PYTHON_BASIC_REPL=1; python", tool: "PowerShell" },
];

export function runPythonReplGuardTests(): void {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  const cwd = mkdtempSync(join(tmpdir(), "phx-python-repl-"));
  try {
    for (const { what, command, tool, background, quotes } of INTERACTIVE) {
      const { decision, reason } = runGuard(cwd, command, tool ?? "Bash", background ?? false);
      assert.equal(decision, "deny", `C19 must refuse an interactive python (${what}):\n  ${command}`);
      assert.match(reason, /^C19 /, `the refusal must name its clause (${what}):\n${reason}`);
      assert.ok(
        reason.includes(quotes),
        `the refusal must quote the python back (${what}): expected ${quotes}\n  got: ${reason}`,
      );

      // It has to say WHY, or the next session reads it as a style rule it can argue with, and it
      // has to name the two ways out, or the session goes looking for a third.
      assert.match(reason, /WinError 123/, `the refusal must name the OSError, not just the REPL.\n${reason}`);
      assert.match(reason, /1,774,873 bytes in 3 seconds/, `the refusal must carry the measured rate.\n${reason}`);
      assert.match(reason, /12\.5 GB/, `the refusal must say what it cost.\n${reason}`);
      assert.match(reason, /python -c "print\(1\)"/, `the refusal must name -c as a way out.\n${reason}`);
      assert.match(reason, /PYTHON_BASIC_REPL=1/, `the refusal must name the REPL fix.\n${reason}`);

      // The escape hatch it hands back must itself be allowed, in the dialect of the tool that
      // asked — `PHX_PYTHON_REPL_OK=1 <cmd>` is not something PowerShell can run. A deny whose own
      // advice is refused sends the session hunting for a spelling that gets through.
      const advice = /stand it down for one command: (.+)$/m.exec(reason)?.[1]?.trim();
      assert.ok(advice, `the refusal must end with its stand-down.\n${reason}`);
      assert.equal(
        advice.startsWith("$env:"),
        (tool ?? "Bash") === "PowerShell",
        `the stand-down must be in the dialect of the tool that asked (${tool ?? "Bash"}): ${advice}`,
      );
      const stood = advice.replace("<the same command>", command);
      assert.equal(
        runGuard(cwd, stood, tool ?? "Bash", background ?? false).decision,
        "allow",
        `the stand-down must not be refused: ${stood}`,
      );
    }

    for (const { what, command, tool, background } of NOT_INTERACTIVE) {
      const { decision, reason } = runGuard(cwd, command, tool ?? "Bash", background ?? false);
      assert.equal(
        decision,
        "allow",
        `C19 must allow ${what} — it runs or reads something:\n  ${command}\n  ${reason}`,
      );
    }

    // Other tools are none of this hook's business.
    assert.equal(
      runGuard(cwd, "python", "Read").decision,
      "allow",
      "the hook must return silently for any tool but Bash and PowerShell",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
