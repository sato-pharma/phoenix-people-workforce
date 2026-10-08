// bash-guard C17: a BACKGROUND `cat` with nothing feeding it is refused (2026-10-08).
//
// A background command's input is a pipe that nothing ever writes to or closes, so a `cat` with no
// file, no heredoc, no `<` and no pipe into it waits on it for ever. That night a session ran
// `cd <worktree> && cat > "$TMPDIR/q.mjs" 2>/dev/null; …; cat > probe.mjs <<'EOF' … EOF` in the
// background — the heredoc sat on the SECOND cat — and the first one hung for over an hour. It held
// the worktree folder, kept its session from being archived, and the production read queued behind
// it stayed armed until the process was killed. A FOREGROUND cat exits at once (its input is closed;
// measured the same night), so it is let through.
//
// It drives the real hook as a subprocess, as settings.json runs it. The allow half matters as much
// as the deny half: every way of feeding a cat — a heredoc on it, a file, `<`, `<<<`, a pipe — the
// commit-message `$(cat <<'EOF' … )` idiom, a mention inside quotes, the foreground, the PowerShell
// tool and the stand-down must all pass.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

function runGuard(cwd: string, command: string, tool = "Bash", background = true): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_STDIN_OK;
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

/** The command that hung on 8 Oct 2026, as the session sent it (its probe body shortened). */
const INCIDENT = [
  'cd "/f/Phoenix Workforce/_wt-field-day-holidays" && cat > "$TMPDIR/q.mjs" 2>/dev/null; SCRATCH="/c/Users/x/scratchpad"; mkdir -p "$SCRATCH"; cat > scripts/field-day/_probe.tmp.mjs <<\'EOF\'',
  'import { readFileSync } from "node:fs";',
  'const env = readFileSync(".env.local", "utf8");',
  "EOF",
  "node scripts/field-day/_probe.tmp.mjs",
].join("\n");

/** Background cats with nothing to read, and the segment the refusal must quote back. */
const IDLE: Array<{ what: string; command: string; quotes: string }> = [
  { what: "the 8 Oct 2026 command", command: INCIDENT, quotes: 'cat > "$TMPDIR/q.mjs" 2>/dev/null' },
  { what: "a bare write", command: "cat > out.txt", quotes: "cat > out.txt" },
  { what: "an append", command: "cat >> log.txt; echo done", quotes: "cat >> log.txt" },
  { what: "a bare cat", command: "cat", quotes: "cat" },
  { what: "an explicit stdin", command: "cat - > out.txt", quotes: "cat - > out.txt" },
  { what: "a command substitution", command: 'x=$(cat); echo "$x"', quotes: "cat" },
  { what: "a redirect of its own errors", command: "cat > f.mjs 2>&1 && node f.mjs", quotes: "cat > f.mjs 2>&1" },
  { what: "after an OR, which is not a pipe", command: "test -f f || cat > f", quotes: "cat > f" },
  { what: "behind a variable assignment", command: "LC_ALL=C cat > f", quotes: "cat > f" },
];

const FED: Array<{ what: string; command: string; tool?: string; background?: boolean }> = [
  { what: "a heredoc on the cat", command: "cat > f.txt <<'EOF'\nhello\nEOF" },
  { what: "a heredoc before the redirect", command: 'cat <<EOF > f.txt\n$HOME\nEOF\nnode f.txt' },
  { what: "a file operand", command: "cat src.txt > f.txt" },
  { what: "an input redirect", command: "cat < src.txt > f.txt" },
  { what: "a here-string", command: 'cat <<< "text" > f.txt' },
  { what: "a pipe into it", command: "printf 'x' | cat > f.txt" },
  { what: "a pipe that includes stderr", command: "node build.mjs |& cat > build.log" },
  { what: "the end of a pipeline", command: "git log --oneline -5 | cat" },
  { what: "an option and a file", command: "cat -n notes.txt" },
  { what: "--help, which reads nothing", command: "cat --help" },
  { what: "the commit-message idiom", command: "git commit -m \"$(cat <<'EOF'\nfix(x): y\nEOF\n)\"" },
  { what: "a mention inside quotes", command: 'echo "never run cat > f in the background"' },
  { what: "process substitution", command: "diff <(cat a.txt) <(cat b.txt)" },
  { what: "a file piped onward", command: "cat out.log 2>&1 | tail -5" },
  { what: "the same idle cat in the FOREGROUND", command: "cat > out.txt", background: false },
  { what: "the PowerShell tool, where cat is Get-Content", command: "cat > out.txt", tool: "PowerShell" },
  { what: "the stand-down", command: "PHX_STDIN_OK=1 cat > out.txt" },
];

export function runBackgroundCatGuardTests(): void {
  const cwd = mkdtempSync(join(tmpdir(), "phx-catguard-"));
  try {
    for (const { what, command, quotes } of IDLE) {
      const result = runGuard(cwd, command);
      assert.equal(result.decision, "deny", `C17 must refuse a background cat with nothing feeding it (${what}):\n  ${command}`);
      assert.match(result.reason, /^C17 /, "the refusal must name its clause");
      assert.ok(result.reason.includes(quotes), `the refusal must quote the idle cat (${what}): expected ${quotes}\n  got: ${result.reason}`);
      assert.ok(result.reason.includes("cat > file <<'EOF'"), "the refusal must show the heredoc on the cat itself");
      assert.match(result.reason, /PHX_STDIN_OK=1 </, "the refusal must carry its stand-down");
    }
    for (const { what, command, tool, background } of FED) {
      const result = runGuard(cwd, command, tool ?? "Bash", background ?? true);
      assert.equal(result.decision, "allow", `C17 must allow ${what}:\n  ${command}\n  got: ${result.reason}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
