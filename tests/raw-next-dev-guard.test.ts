// A raw `next dev` must be REFUSED at the command line, and the launcher that replaces it allowed.
//
// WHY THIS EXISTS. Measured 2026-09-21 on this 16 GB machine, on the start-server.js child that
// actually grows: a raw `next dev` hands that server a heap limit of 8,278 MB — Next's own default
// of half of RAM — and Next restarts it only once 80% of that is in use, so a busy server climbs to
// 7-8 GB. The memory watchdog stopped one at 8.14 GB at 09:07 Cairo that morning, and another
// reached 7.5 GB in seven minutes and left 0.6 GB free for everything else on the machine.
// scripts/dev-server.mjs caps the same child at 4,288 MB, so Next restarts it in place near 3.4 GB,
// and it is also the only thing that refuses to start a second dev server beside the first.
//
// None of that helps while sessions keep starting the server without it — and until this change
// AGENTS.md §5, .claude/launch.json and bash-guard's own advice all TOLD them to. bash-guard C7 is
// the enforcement; this file is its proof. It drives the real hook as a subprocess, exactly as
// settings.json runs it, because a test that imported the regex would pass against a hook wired to
// nothing.
//
// The allow half is asserted as hard as the deny half. A guard that refused `git grep "next dev"`,
// a commit message that mentions the command, or `next build` would be switched off within a day.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");
const LAUNCHER = "node scripts/dev-server.mjs";

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * The tool payload on stdin, as settings.json delivers it. The cwd is a folder that is NOT a git
 * repository and CLAUDE_PROJECT_DIR is deleted, so C6 (pnpm in a worktree) can never be the rule
 * that answered: every deny below is C7's, and every allow is C7 standing aside.
 */
function runGuard(cwd: string, command: string, tool = "Bash"): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }),
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

/** Every way a session has started, or plausibly would start, the server without the launcher. */
const RAW_LAUNCHES: Array<{ command: string; tool?: string; port?: string }> = [
  // AGENTS.md §5's own line until 2026-09-21, and the command .claude/launch.json named.
  { command: "node node_modules/next/dist/bin/next dev --webpack --port 3000" },
  { command: "node node_modules\\next\\dist\\bin\\next dev --webpack --port 3000", tool: "PowerShell" },
  // Every checkout here lives under a folder with a space in its name.
  {
    command:
      '"C:\\Program Files\\nodejs\\node.exe" "F:\\Phoenix Workforce\\_wt-x\\node_modules\\next\\dist\\bin\\next" dev --webpack --port 3001',
    tool: "PowerShell",
    port: "3001",
  },
  { command: 'cd "F:/Phoenix Workforce/_wt-x" && node node_modules/next/dist/bin/next dev --webpack --port 3000' },
  { command: "npx next dev --webpack" },
  { command: "pnpm exec next dev --webpack --port 3002", port: "3002" },
  { command: "pnpm next dev" },
  { command: "node_modules/.bin/next dev" },
  { command: "node_modules\\.bin\\next.cmd dev --port 3000", tool: "PowerShell" },
  { command: "echo starting && next dev --webpack" },
  { command: "node --inspect node_modules/next/dist/bin/next dev --webpack" },
  // Raising the heap by hand is exactly what C7 exists to route through the launcher.
  { command: "NODE_OPTIONS=--max-old-space-size=8192 node node_modules/next/dist/bin/next dev --webpack" },
  {
    command: "$env:NODE_OPTIONS='--max-old-space-size=8192'; node node_modules/next/dist/bin/next dev --webpack",
    tool: "PowerShell",
  },
  { command: 'bash -c "node node_modules/.bin/next dev --webpack"' },
  { command: "cmd.exe /c node node_modules\\next\\dist\\bin\\next dev --webpack --port 3000 > dev.log 2>&1", tool: "PowerShell" },
  { command: "& node node_modules/next/dist/bin/next dev --webpack", tool: "PowerShell" },
  // Start-Process takes its program and arguments in any order, usually as a quoted list.
  {
    command: "Start-Process node -ArgumentList 'node_modules/next/dist/bin/next','dev','--webpack','--port','3003' -NoNewWindow",
    tool: "PowerShell",
    port: "3003",
  },
  {
    command: 'Start-Process -NoNewWindow -FilePath node -ArgumentList "node_modules/next/dist/bin/next dev --webpack"',
    tool: "PowerShell",
  },
  {
    command:
      "$p = Start-Process -PassThru -FilePath cmd.exe -ArgumentList '/c','node node_modules\\next\\dist\\bin\\next dev --webpack'",
    tool: "PowerShell",
  },
  // The shape the dev supervisor used until this change.
  {
    command:
      "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c node node_modules\\next\\dist\\bin\\next dev --webpack --port 3000'; CurrentDirectory = 'F:\\x' }",
    tool: "PowerShell",
  },
];

/** Commands that start the launcher, run another Next command, or only MENTION `next dev`. */
const NOT_A_RAW_LAUNCH: Array<{ command: string; tool?: string }> = [
  { command: "node scripts/dev-server.mjs --port 3000" },
  { command: "node scripts/dev-server.mjs --webpack --port 3001", tool: "PowerShell" },
  { command: "PHOENIX_DEV_HEAP_MB=3072 node scripts/dev-server.mjs --port 3000" },
  { command: "pnpm run dev" },
  { command: "npm run dev" },
  { command: "node node_modules/next/dist/bin/next build --webpack" },
  { command: "npx next start --port 3000" },
  { command: "node node_modules/next/dist/bin/next --version" },
  { command: 'git grep -n "next dev" -- docs' },
  { command: 'rg -n "node_modules/next/dist/bin/next dev" docs' },
  { command: 'echo "never run node node_modules/next/dist/bin/next dev by hand"' },
  { command: "git commit -m 'docs: a raw next dev is refused; use node scripts/dev-server.mjs'" },
  { command: `node -e "console.log('next dev')"` },
  // A heredoc body is data. Writing down the rule this enforces must not trip it.
  { command: "cat > note.md <<'EOF'\nNever start it like this:\nnode node_modules/next/dist/bin/next dev --webpack\nEOF" },
  // A PowerShell here-string too — and its apostrophe must not flip the quote tracking and turn
  // the line after it into a "command".
  {
    command:
      "$msg = @'\nfix(dev): Next's default heap is half of RAM\nnode node_modules/next/dist/bin/next dev --webpack is refused now\n'@\ngit commit -m $msg",
    tool: "PowerShell",
  },
  {
    command: "Start-Process node -ArgumentList 'scripts/dev-server.mjs','--port','3000' -RedirectStandardOutput next-dev.log",
    tool: "PowerShell",
  },
  { command: "Get-NetTCPConnection -LocalPort 3000 -State Listen", tool: "PowerShell" },
];

export function runRawNextDevGuardTests() {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  const cwd = mkdtempSync(join(tmpdir(), "phx-raw-next-dev-"));
  try {
    for (const { command, tool, port } of RAW_LAUNCHES) {
      const { decision, reason } = runGuard(cwd, command, tool);
      assert.equal(decision, "deny", `a raw \`next dev\` must be refused (${tool ?? "Bash"}):\n${command}`);
      assert.ok(
        reason.includes(`${LAUNCHER} --port ${port ?? "3000"}`),
        `the deny must name the launcher with the port that was asked for.\n${command}\n${reason}`,
      );
      assert.match(reason, /4,096 MB/, `the deny must say what the launcher does about memory.\n${reason}`);

      // The command the deny hands back must itself be allowed, or it sends the session in a loop.
      const advice = /^\s+(node scripts\/dev-server\.mjs[^\n]*)$/m.exec(reason)?.[1];
      assert.ok(advice, `the deny must put the replacement on a line of its own.\n${reason}`);
      assert.equal(runGuard(cwd, advice, tool).decision, "allow", `the replacement must not be refused: ${advice}`);
    }

    for (const { command, tool } of NOT_A_RAW_LAUNCH) {
      const { decision, reason } = runGuard(cwd, command, tool);
      assert.equal(decision, "allow", `this does not start a raw \`next dev\` and must be allowed:\n${command}\n${reason}`);
    }

    // Other tools are none of this hook's business.
    assert.equal(
      runGuard(cwd, "node node_modules/next/dist/bin/next dev --webpack", "Read").decision,
      "allow",
      "the hook must return silently for any tool but Bash and PowerShell",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
