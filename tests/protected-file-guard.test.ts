// THE OWNER-LOCKED FILES get a real prompt — .claude/hooks/protected-file-guard.mjs, 2026-09-30.
//
// CLAUDE.md locks four files. The Office golden rule has its own CI lock; the other three —
// the incentive curve, the payroll formulas and the portal identity card — had nothing behind them
// but a session's reading of one paragraph ("behavioral ONLY — no prompt backs them"). The hook
// answers an edit to any of them with permissionDecision "ask", so the owner's click in the UI is
// what lets it through.
//
// Three ways that dies quietly, and this file closes each:
//   1. The hook is never wired, or wired for Write but not Bash — then a `sed -i` walks past a
//      guard that looks installed. The registration is asserted for every tool it covers.
//   2. It is widened until it is switched off. Reads, greps, diffs and unrelated files are asserted
//      to stay silent as hard as the edits are asserted to ask.
//   3. It stalls AUTORUN, which AGENTS.md §6.1 rules is "announced, not awaited" for these files —
//      or, the dangerous direction, a stale or forged state file waves an edit through. Both are
//      driven here against a temporary state directory.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/protected-file-guard.mjs");
const settingsPath = resolve(".claude/settings.json");

type Decision = { decision: "ask" | "allow" | "silent" | "deny"; reason: string; context: string };

function runGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: { sessionId?: string; stateDir?: string } = {},
): Decision {
  const env = { ...process.env };
  delete env.PHX_AUTORUN_STATE_DIR;
  if (opts.stateDir) env.PHX_AUTORUN_STATE_DIR = opts.stateDir;
  const raw = execFileSync(process.execPath, [guardPath], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: opts.sessionId ?? "test-session" }),
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "silent", reason: "", context: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const out = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return {
    decision: out.permissionDecision,
    reason: String(out.permissionDecisionReason ?? ""),
    context: String(out.additionalContext ?? ""),
  };
}

const PAYROLL = "src/lib/payroll/policy.ts";
const INCENTIVE = "src/lib/incentives/scheme-2026.ts";
const IDENTITY = "src/components/employee-portal/identity-card.tsx";

/** Edits to a locked file — every one must raise the owner's prompt. */
const ASKS: Array<{ what: string; tool: string; input: Record<string, unknown> }> = [
  { what: "an Edit of the payroll formulas", tool: "Edit", input: { file_path: PAYROLL } },
  { what: "a Write of the incentive curve", tool: "Write", input: { file_path: INCENTIVE } },
  { what: "an Edit of the identity card", tool: "Edit", input: { file_path: IDENTITY } },
  {
    what: "an absolute path in a sibling worktree",
    tool: "Edit",
    input: { file_path: "F:/Phoenix Workforce/_wt-some-task/src/lib/payroll/policy.ts" },
  },
  {
    what: "a Windows-separator absolute path",
    tool: "Write",
    input: { file_path: "F:\\Phoenix Workforce\\phoenix-workforce\\src\\lib\\incentives\\scheme-2026.ts" },
  },
  { what: "an in-place sed", tool: "Bash", input: { command: `sed -i 's/0.7/0.75/' ${PAYROLL}` } },
  { what: "a redirect over the file", tool: "Bash", input: { command: `echo x > ${INCENTIVE}` } },
  { what: "a git checkout of an older copy", tool: "Bash", input: { command: `git checkout origin/main -- ${PAYROLL}` } },
  { what: "a git restore", tool: "Bash", input: { command: `git restore ${IDENTITY}` } },
  { what: "a delete", tool: "Bash", input: { command: `rm ${IDENTITY}` } },
  {
    what: "a PowerShell Set-Content with backslashes",
    tool: "PowerShell",
    input: { command: "Set-Content -Path src\\lib\\payroll\\policy.ts -Value 'x'" },
  },
];

/** Everything that is not an edit of a locked file — the guard must stay silent. */
const SILENT: Array<{ what: string; tool: string; input: Record<string, unknown> }> = [
  { what: "an ordinary payroll file", tool: "Edit", input: { file_path: "src/lib/payroll/service.ts" } },
  { what: "a longer name that starts the same", tool: "Write", input: { file_path: "src/lib/payroll/policy.tsx" } },
  { what: "the same name in another folder", tool: "Edit", input: { file_path: "tests/payroll/policy.ts" } },
  { what: "a test about the policy", tool: "Write", input: { file_path: "tests/payroll-policy.test.ts" } },
  { what: "a dependency", tool: "Edit", input: { file_path: "node_modules/x/src/lib/payroll/policy.ts" } },
  { what: "reading it", tool: "Bash", input: { command: `cat ${PAYROLL}` } },
  { what: "diffing it", tool: "Bash", input: { command: `git diff origin/main -- ${INCENTIVE}` } },
  { what: "showing an old copy to a scratch file", tool: "Bash", input: { command: `git show origin/main:${PAYROLL} > /tmp/policy-before.ts` } },
  { what: "grepping it", tool: "PowerShell", input: { command: `Select-String -Path ${IDENTITY} -Pattern PhoenixSignatureCard` } },
  { what: "a command that names no locked file", tool: "Bash", input: { command: "sed -i 's/a/b/' src/lib/payroll/service.ts" } },
  { what: "the Read tool", tool: "Read", input: { file_path: PAYROLL } },
];

export function runProtectedFileGuardTests() {
  assert.ok(existsSync(guardPath), `the protected-file guard is missing at ${guardPath}`);

  // 1. The guard itself.
  for (const { what, tool, input } of ASKS) {
    const { decision, reason, context } = runGuard(tool, input);
    assert.equal(decision, "ask", `${what} must raise the owner's prompt (${tool})`);
    assert.match(reason, /Owner-locked file/, `the prompt must say plainly why it is asking: ${reason}`);
    assert.match(context, /Protected Files/, `the session must be told the file is on CLAUDE.md's list: ${context}`);
    assert.match(context, /never retry the edit another way/, `a refused prompt must read as his answer: ${context}`);
  }
  for (const { what, tool, input } of SILENT) {
    const { decision, reason } = runGuard(tool, input);
    assert.equal(decision, "silent", `this is not an edit of a locked file and must pass silently — ${what}:\n${reason}`);
  }
  // It never refuses outright: the owner may approve the change, and a deny would leave no way to.
  for (const { tool, input } of ASKS) {
    assert.notEqual(runGuard(tool, input).decision, "deny", "the guard must ask, never deny");
  }

  // 2. AUTORUN: "announced, not awaited" (AGENTS.md §6.1) — and only for a real, current arming.
  const stateDir = mkdtempSync(join(tmpdir(), "phx-autorun-"));
  try {
    const armed = (id: string, body: unknown) => writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(body));
    armed("armed-now", { version: 2, armedAt: new Date().toISOString(), sessionId: "armed-now", trigger: "AUTORUN" });
    armed("old-guard", { armedAt: new Date().toISOString() });
    armed("expired", { version: 2, armedAt: new Date(Date.now() - 15 * 86_400_000).toISOString() });
    writeFileSync(join(stateDir, "garbled.json"), "{not json");

    const edit = { file_path: PAYROLL };
    const live = runGuard("Edit", edit, { sessionId: "armed-now", stateDir });
    assert.equal(live.decision, "allow", "an armed AUTORUN plan must not be stalled by the prompt");
    assert.match(live.context, /MUST announce it/, `an armed session must still be told to announce the edit: ${live.context}`);
    for (const id of ["old-guard", "expired", "garbled", "never-armed"]) {
      assert.equal(
        runGuard("Edit", edit, { sessionId: id, stateDir }).decision,
        "ask",
        `session "${id}" is not armed — its edit must still raise the prompt`,
      );
    }
    // Another session's arming never reaches this one.
    assert.equal(runGuard("Edit", edit, { sessionId: "someone-else", stateDir }).decision, "ask");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }

  // 3. The wiring. A hook nothing runs is a comment.
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
  };
  const entries = (settings.hooks?.PreToolUse ?? []).filter((entry) =>
    (entry.hooks ?? []).some((hook) => (hook.command ?? "").includes("protected-file-guard.mjs")),
  );
  assert.ok(entries.length > 0, "the protected-file guard must be registered in .claude/settings.json");
  const matchers = entries.flatMap((entry) => (entry.matcher ?? "").split("|"));
  for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell"]) {
    assert.ok(
      matchers.includes(tool),
      `the guard must be registered for ${tool} — a matcher missing it lets that route through while looking installed (matchers: ${matchers.join("|")})`,
    );
  }

  // 4. The list the hook guards is CLAUDE.md's list. A lock added there and not here is behavioral again.
  const claude = readFileSync(resolve("CLAUDE.md"), "utf8");
  for (const file of [PAYROLL, INCENTIVE, IDENTITY]) {
    assert.ok(claude.includes(`\`${file}\``), `CLAUDE.md's Protected Files table must still list ${file}`);
  }
  assert.match(
    claude,
    /protected-file-guard\.mjs/,
    "CLAUDE.md must say the three locks are now backed by protected-file-guard.mjs, not that no prompt backs them",
  );
}
