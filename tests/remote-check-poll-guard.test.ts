// bash-guard C14: a FOREGROUND loop polling remote-check is refused (2026-10-08 performance recovery,
// P0-3).
//
// Measured 4-8 Oct 2026 from the session transcripts: 1,125 calls and 17.6 session-hours spent in
// `until grep -q "remote-check: PASS" <file>; do sleep N; done`, each pinned at the 600s Bash
// ceiling and re-issued. The harness notifies a session when a background command ends (confirmed in
// the Desktop app the same day), and remote-check's exit code is the verdict, so the loop buys
// nothing but a blocked session.
//
// It drives the real hook as a subprocess, as settings.json runs it. The allow half matters as much
// as the deny half: the same loop in the BACKGROUND, a heredoc that documents the loop, a plain
// remote-check call, an unrelated sleep loop and the stand-down must all pass.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

function runGuard(cwd: string, command: string, tool = "Bash", background = false): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_POLL_OK;
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

/** The shapes actually seen in the 4-8 Oct transcripts, and their PowerShell twins. */
const POLL_LOOPS: Array<{ command: string; tool?: string }> = [
  { command: 'until grep -q "remote-check: PASS\\|remote-check: FAIL" /tmp/rc.out; do sleep 30; done; tail -5 /tmp/rc.out' },
  { command: 'until grep -qE "remote-check: (PASS|FAIL|NO VERDICT)" "$OUT"; do sleep 20; done' },
  { command: "while ! grep -q 'remote-check:' out.txt; do sleep 15; done" },
  { command: 'for i in $(seq 1 40); do grep -q "remote-check: PASS" o.txt && break; sleep 15; done' },
  { command: 'cd /f/x && until node scripts/remote-check.mjs test --no-wait; do sleep 60; done' },
  { command: 'while (-not (Select-String -Path $out -Pattern "remote-check: PASS" -Quiet)) { Start-Sleep -Seconds 20 }', tool: "PowerShell" },
  { command: 'do { Start-Sleep 30 } until (Select-String -Path $o -Pattern "remote-check:" -Quiet)', tool: "PowerShell" },
];

const ALLOWED: Array<{ what: string; command: string; tool?: string; background?: boolean }> = [
  { what: "the one call this clause points to", command: "node scripts/remote-check.mjs test" },
  { what: "the same loop launched in the background", command: POLL_LOOPS[0]!.command, background: true },
  { what: "an unrelated sleep loop", command: "until curl -fs http://localhost:3000/api/healthz; do sleep 2; done" },
  { what: "a remote-check mention with no loop", command: 'grep -c "remote-check: PASS" /tmp/rc.out; sleep 1' },
  {
    what: "a heredoc that DOCUMENTS the loop",
    command: "cat > docs/x.md <<'EOF'\nNever: until grep -q \"remote-check: PASS\" f; do sleep 30; done\nEOF",
  },
  { what: "the bash stand-down", command: `PHX_POLL_OK=1 ${POLL_LOOPS[0]!.command}` },
  { what: "the PowerShell stand-down", command: `$env:PHX_POLL_OK=1; ${POLL_LOOPS[5]!.command}`, tool: "PowerShell" },
];

export function runRemoteCheckPollGuardTests(): void {
  const cwd = mkdtempSync(join(tmpdir(), "phx-pollguard-"));
  try {
    for (const { command, tool } of POLL_LOOPS) {
      const result = runGuard(cwd, command, tool ?? "Bash");
      assert.equal(result.decision, "deny", `C14 must refuse a foreground remote-check poll loop:\n  ${command}`);
      assert.match(result.reason, /^C14 /, "the refusal must name its clause");
      assert.match(result.reason, /run_in_background: true/, "the refusal must name the background-plus-notification way");
      assert.match(result.reason, /0 PASS, 1 FAIL, 2-9 NO VERDICT/, "the refusal must say how to read the exit code");
      assert.match(
        result.reason,
        tool === "PowerShell" ? /\$env:PHX_POLL_OK=1; / : /PHX_POLL_OK=1 </,
        "the stand-down must be in the tool's own dialect",
      );
    }
    for (const { what, command, tool, background } of ALLOWED) {
      const result = runGuard(cwd, command, tool ?? "Bash", background ?? false);
      assert.equal(result.decision, "allow", `C14 must allow ${what}:\n  ${command}\n  got: ${result.reason}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
