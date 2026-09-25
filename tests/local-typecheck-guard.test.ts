// A local typecheck must be REFUSED at the command line, and everything that only mentions one allowed.
//
// WHY THIS EXISTS. The rule is not new — AGENTS.md §7 has said "CI is the gate, do not run a local
// full validation" since check:harden was retired — and it did not hold, for one mechanical reason:
// a reaped typecheck prints NOTHING and exits non-zero, which is indistinguishable from a command
// typed wrong. So the session tries another spelling. Measured 2026-09-25 in
// ~/.claude/scripts/mem-watchdog.log, six kills in ten minutes — 04:17, 04:19, 04:21, 04:24, 04:25,
// 04:27 — walking `--max-old-space-size=6144` -> `typescript/bin/tsc` -> `typescript/lib/tsc.js`
// -> a backslash spelling of the same, each killed with 296-483 MB of free RAM left.
//
// A markdown rule cannot close that: it loads at session start, so it never reaches the sessions
// already open. bash-guard is re-read by node on every single tool call, so a session gets C8 on its
// next command. This is also the one half of the retired heavy-job gate worth keeping — its own log
// holds 15 plain `tsc` refusals, the last at 20:44 on 2026-09-17 — minus the queue that made it
// unusable on a 16 GB box.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.
//
// The allow half is asserted as hard as the deny half, and it is the half that decides whether this
// survives. A guard that refused `git grep "--noEmit"`, a commit message describing itself, a real
// emit (`tsc -b`), `pnpm run test` or the CI script the owner opts into would be switched off within
// a day — and then the kills come back.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * The tool payload on stdin, as settings.json delivers it. The cwd is a folder that is NOT a git
 * repository, CLAUDE_PROJECT_DIR is deleted and PHX_TYPECHECK_OK is cleared out of the environment,
 * so no other clause and no ambient opt-out can be the thing that answered: every deny below is
 * C8's, and every allow is C8 standing aside.
 */
function runGuard(cwd: string, command: string, tool = "Bash"): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PHX_TYPECHECK_OK;
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

/** A heredoc body, built here so the fence never has to survive a shell of its own. */
const HEREDOC_NOTE = [
  "cat > note.md <<'EOF'",
  "Never run this by hand:",
  "node node_modules/typescript/bin/tsc --noEmit --pretty false",
  "EOF",
].join("\n");

/** A PowerShell here-string, apostrophe and all — its quote must not flip the tracking. */
const HERE_STRING_COMMIT = [
  "$msg = @'",
  "fix(hooks): tsc's 4.5 GB does not fit here",
  "node node_modules/typescript/bin/tsc --noEmit is refused now",
  "'@",
  "git commit -m $msg",
].join("\n");

/**
 * THE TRANSCRIPT. Every one of these is a command `mem-watchdog.ps1` actually killed, copied out of
 * its own `cmd:` records — every distinct spelling the log still held on 2026-09-25, deduplicated
 * and sorted, nothing invented and nothing tidied. There were 23 kills in the window it had not yet
 * rotated away, and ALL 23 were a typecheck: not one other kind of node job was reaped in that time.
 *
 * Two things they show that a hand-written case would have missed. The binary is almost always a
 * QUOTED path with a space in it (`"C:\Program Files\nodejs\node.exe"`), which a whitespace split
 * reads as `"C:\Program` and lets straight through. And `node_modules/.bin/../typescript/bin/tsc`
 * and a doubled separator appear too, because a session that has been killed four times starts
 * spelling the path by hand.
 */
const KILLED_FOR_REAL: string[] = [
  "\"C:\\Program Files\\nodejs\\node.exe\" --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit --pretty false",
  "\"C:\\Program Files\\nodejs\\node.exe\" --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" --max-old-space-size=5120 node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit --pretty false --incremental --tsBuildInfoFile C:/Users/satoh/AppData/Local/Temp/claude/F--Phoenix-Workforce-phoenix-workforce/48217375-ab76-4713-8624-338ed6a800f2/scratchpad/ts.tsbuildinfo",
  "\"C:\\Program Files\\nodejs\\node.exe\" ./node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules/.bin/../typescript/bin/tsc -p tsconfig.json --noEmit --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.json",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules/typescript/lib/tsc.js --noEmit --pretty false --incremental false",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules\\typescript\\bin\\tsc --noEmit --incremental false -p tsconfig.json",
  "\"C:\\Program Files\\nodejs\\node.exe\" node_modules\\typescript\\lib\\tsc.js --noEmit --pretty false --incremental false",
  "node   \"F:\\Phoenix Workforce\\phoenix-workforce\\node_modules\\.bin\\\\..\\typescript\\bin\\tsc\" --noEmit --pretty false",
  "node  --max-old-space-size=7168 node_modules\\typescript\\bin\\tsc --noEmit --pretty false --incremental false ",
];

/**
 * The forms the docs, AGENTS.md and package.json name — the ones a session reads before it starts
 * inventing spellings of its own — plus the wrappers it reaches for when the plain command "fails":
 * a chained cd, an echo, bash -c, cmd /c, a raised NODE_OPTIONS and a pipe into tail.
 */
const LOCAL_TYPECHECKS: Array<{ command: string; tool?: string }> = [
  // The transcript first: if any of these is ever allowed, the guard has stopped doing its job.
  ...KILLED_FOR_REAL.map((command) => ({ command, tool: "PowerShell" })),
  { command: "node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit --pretty false" },
  { command: "node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false" },
  { command: "node node_modules/typescript/lib/tsc.js --noEmit --pretty false --incremental false" },
  { command: "node node_modules\\typescript\\lib\\tsc.js --noEmit --pretty false", tool: "PowerShell" },
  { command: "node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json" },
  { command: "node --max-old-space-size=7168 node_modules/typescript/lib/tsc.js --noEmit" },
  // Every checkout here lives under a folder with a space in its name, so the leading token is
  // usually a quoted path. A whitespace split reads `"C:\Program` as the binary and lets it through.
  {
    command:
      '"C:\\Program Files\\nodejs\\node.exe" "F:\\Phoenix Workforce\\_wt-x\\node_modules\\typescript\\bin\\tsc" --noEmit --pretty false',
    tool: "PowerShell",
  },
  // The package.json script, and the other managers' spellings of it.
  { command: "pnpm run typecheck" },
  { command: "npm run typecheck" },
  { command: "yarn typecheck" },
  { command: "pnpm -s run typecheck" },
  // Straight to the binary.
  { command: "npx tsc --noEmit" },
  { command: "pnpm exec tsc --noEmit --pretty false" },
  { command: "node_modules/.bin/tsc --noEmit" },
  { command: "tsc --noEmit -p tsconfig.json" },
  { command: "node_modules\\.bin\\tsc.cmd --noEmit", tool: "PowerShell" },
  // AGENTS.md §2's own "a hand-run typecheck must start cold" line.
  { command: "npx tsc --noEmit --incremental false" },
  // Wrapped, chained, redirected — the shapes a session reaches for once the plain one "fails".
  { command: 'cd "F:/Phoenix Workforce/_wt-x" && node node_modules/typescript/bin/tsc --noEmit' },
  { command: "echo checking && tsc --noEmit" },
  { command: 'bash -c "node node_modules/typescript/bin/tsc --noEmit --pretty false"' },
  { command: "cmd.exe /c node node_modules\\typescript\\bin\\tsc --noEmit > tsc.log 2>&1", tool: "PowerShell" },
  { command: "NODE_OPTIONS=--max-old-space-size=8192 node node_modules/typescript/bin/tsc --noEmit" },
  { command: "node node_modules/typescript/bin/tsc --noEmit 2>&1 | tail -40" },
];

/**
 * Commands that only MENTION a typecheck, do something else entirely, or opt out on purpose. Each
 * one of these being refused is a reason for a session to switch the hook off, so each is a test.
 */
const NOT_A_LOCAL_TYPECHECK: Array<{ command: string; tool?: string }> = [
  // The owner's own opt-in gate. AGENTS.md §7 keeps it, and C8 must not take it away.
  { command: "pnpm run ci" },
  { command: "pnpm run test" },
  { command: "pnpm run lint" },
  { command: "pnpm run build" },
  { command: "node scripts/run-tests.mjs" },
  // A real emit is not the checking loop this refuses.
  { command: "node node_modules/typescript/bin/tsc -b mobile" },
  { command: "npx tsc --outDir dist src/index.ts" },
  { command: "node node_modules/typescript/bin/tsc --version" },
  // The synthetic one-hop script tests/pnpm-worktree-guard.test.ts writes into its own fixture.
  { command: "pnpm run typecheck:alias" },
  // Reading and writing ABOUT the rule.
  { command: 'git grep -n "tsc --noEmit" -- docs' },
  { command: 'rg -n "node_modules/typescript/bin/tsc --noEmit" docs' },
  { command: 'echo "never run tsc --noEmit on this box - push the branch"' },
  { command: "git commit -m 'docs(validation): a local tsc --noEmit is refused; CI is the gate'" },
  { command: `node -e "console.log('tsc --noEmit')"` },
  { command: "gh pr checks 4372" },
  { command: "cat tsconfig.json" },
  // A heredoc body is data. Writing down the rule this enforces must not trip it.
  { command: HEREDOC_NOTE },
  { command: HERE_STRING_COMMIT, tool: "PowerShell" },
  // The stand-down, in both dialects, with and without quotes around the 1.
  { command: "PHX_TYPECHECK_OK=1 node node_modules/typescript/bin/tsc --noEmit --pretty false" },
  { command: "PHX_TYPECHECK_OK=1 pnpm run typecheck" },
  { command: "$env:PHX_TYPECHECK_OK=1; node node_modules/typescript/bin/tsc --noEmit", tool: "PowerShell" },
  { command: "$env:PHX_TYPECHECK_OK='1'; npx tsc --noEmit", tool: "PowerShell" },
];

export function runLocalTypecheckGuardTests() {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  const cwd = mkdtempSync(join(tmpdir(), "phx-local-typecheck-"));
  try {
    for (const { command, tool } of LOCAL_TYPECHECKS) {
      const { decision, reason } = runGuard(cwd, command, tool);
      assert.equal(decision, "deny", `a local typecheck must be refused (${tool ?? "Bash"}):\n${command}`);

      // The deny has to say WHY, or the next session reads it as a policy it can argue with.
      assert.match(reason, /KILLED/, `the deny must say the run is killed, not failed.\n${reason}`);
      assert.match(reason, /4\.0-4\.5 GB/, `the deny must name the heap it needs.\n${reason}`);
      assert.match(reason, /Push the branch/, `the deny must name the answer, not just the refusal.\n${reason}`);

      // And the escape hatch it hands back must itself be allowed, in the dialect of the tool that
      // asked — `PHX_TYPECHECK_OK=1 <cmd>` is not something PowerShell can run. A deny whose own
      // advice is refused sends the session round the loop this exists to stop.
      const advice = /^ {2}(\$env:PHX_TYPECHECK_OK=1; .+|PHX_TYPECHECK_OK=1 .+)$/m.exec(reason)?.[1];
      assert.ok(advice, `the deny must put the stand-down on a line of its own.\n${reason}`);
      assert.equal(
        advice.startsWith("$env:"),
        tool === "PowerShell",
        `the stand-down must be in the dialect of the tool that asked (${tool ?? "Bash"}): ${advice}`,
      );
      assert.equal(runGuard(cwd, advice, tool).decision, "allow", `the stand-down must not be refused: ${advice}`);
    }

    for (const { command, tool } of NOT_A_LOCAL_TYPECHECK) {
      const { decision, reason } = runGuard(cwd, command, tool);
      assert.equal(
        decision,
        "allow",
        `this does not start a local typecheck and must be allowed:\n${command}\n${reason}`,
      );
    }

    // Other tools are none of this hook's business.
    assert.equal(
      runGuard(cwd, "pnpm run typecheck", "Read").decision,
      "allow",
      "the hook must return silently for any tool but Bash and PowerShell",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
