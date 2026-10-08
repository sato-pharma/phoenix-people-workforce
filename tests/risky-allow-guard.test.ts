// RISKY "ALLOW" WILDCARDS get refused — .claude/hooks/risky-allow-guard.mjs, 2026-10-05.
//
// 2026-10-05 a sweep found blanket inline-execution allow wildcards — `Bash(python -c ' *)`,
// `Bash(node -e ' *)`, `Bash(npx *)`, `Bash(railway run *)` — sitting in several repos'
// settings.local.json. Each hands any future session the right to run arbitrary inline code (or, for
// `railway run *`, any command with the PRODUCTION Railway secrets injected) with the auto-mode
// classifier never looking at it. There is an identical guard on the laptop, but a CLOUD session has
// no ~/.claude (AGENTS.md §5), so this repo copy is what covers cloud sessions. The hook answers a
// Write/Edit/MultiEdit/NotebookEdit that adds such a wildcard to any .claude/settings*.json with
// permissionDecision "deny".
//
// Three ways that dies quietly, and this file closes each:
//   1. The hook is never wired, or wired for Write but not MultiEdit — then a MultiEdit walks past a
//      guard that looks installed. The registration is asserted for every tool it covers.
//   2. It is widened until it refuses real edits — an exact scoped command, or any non-settings file,
//      is asserted to pass silently as hard as the wildcards are asserted to be denied.
//   3. It fails CLOSED on a bug and blocks a real edit — empty and garbled input are asserted silent.
//
// It drives the real hook as a subprocess, exactly as settings.json runs it, because a test that
// imported the matcher would pass against a hook wired to nothing.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { wiredHookGroups } from "./support/hook-wiring.ts";

const guardPath = resolve(".claude/hooks/risky-allow-guard.mjs");

type Decision = { decision: "deny" | "silent"; reason: string };

function runGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: { rawInput?: string; off?: boolean } = {},
): Decision {
  const env = { ...process.env };
  delete env.PHX_RISKY_ALLOW_GUARD_OFF;
  if (opts.off) env.PHX_RISKY_ALLOW_GUARD_OFF = "1";
  const input = opts.rawInput ?? JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const raw = execFileSync(process.execPath, [guardPath], {
    input,
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!raw.trim()) return { decision: "silent", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const out = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: String(out.permissionDecisionReason ?? "") };
}

const REPO_SETTINGS = "F:/Phoenix Workforce/phoenix-workforce/.claude/settings.local.json";

/** Edits that ADD a risky wildcard to a settings file — every one must be denied. */
const DENIES: Array<{ what: string; tool: string; input: Record<string, unknown> }> = [
  {
    what: "an Edit adding an npx wildcard",
    tool: "Edit",
    input: { file_path: REPO_SETTINGS, new_string: '      "Bash(npx *)",' },
  },
  {
    what: "an Edit adding a node -e wildcard",
    tool: "Edit",
    input: { file_path: REPO_SETTINGS, new_string: '      "Bash(node -e \' *)",' },
  },
  {
    what: "an Edit adding a python -c wildcard",
    tool: "Edit",
    input: { file_path: REPO_SETTINGS, new_string: '      "Bash(python -c \' *)",' },
  },
  {
    what: "an Edit adding a railway run wildcard",
    tool: "Edit",
    input: { file_path: REPO_SETTINGS, new_string: '      "Bash(railway run *)",' },
  },
  {
    what: "a Write of a whole settings body carrying a wildcard",
    tool: "Write",
    input: {
      file_path: REPO_SETTINGS,
      content: JSON.stringify({ permissions: { allow: ["Bash(git status)", "Bash(sh -c ' *)"] } }, null, 2),
    },
  },
  {
    what: "a MultiEdit where one edit adds the wildcard",
    tool: "MultiEdit",
    input: {
      file_path: REPO_SETTINGS,
      edits: [
        { old_string: "a", new_string: '"Bash(gh pr view 1)"' },
        { old_string: "b", new_string: '"Bash(pnpm exec *)"' },
      ],
    },
  },
  {
    what: "a NotebookEdit new_source carrying the wildcard",
    tool: "NotebookEdit",
    input: { notebook_path: REPO_SETTINGS, new_source: 'allow = ["Bash(railway run *)"]' },
  },
  {
    what: "a Windows-separator settings path",
    tool: "Edit",
    input: { file_path: "F:\\Repo\\.claude\\settings.json", new_string: '      "Bash(npx *)",' },
  },
  {
    what: "a user-level settings.json",
    tool: "Edit",
    input: { file_path: "C:/Users/satoh/.claude/settings.json", new_string: '      "Bash(node -e \' *)",' },
  },
];

/** Everything that must pass silently — an exact command, a non-settings file, or a non-edit tool. */
const SILENT: Array<{ what: string; tool: string; input: Record<string, unknown> }> = [
  {
    what: "an Edit adding an exact scoped command",
    tool: "Edit",
    input: { file_path: REPO_SETTINGS, new_string: '      "Bash(python scripts/one-tool.py)",' },
  },
  {
    what: "an Edit adding a benign gh command",
    tool: "Edit",
    input: { file_path: REPO_SETTINGS, new_string: '      "Bash(gh pr view 5323)",' },
  },
  {
    what: "a Write whose allow list is all exact commands",
    tool: "Write",
    input: {
      file_path: REPO_SETTINGS,
      content: JSON.stringify({ permissions: { allow: ["Bash(git status)", "Bash(python -c 'print(1)')"] } }, null, 2),
    },
  },
  {
    what: "a wildcard in a NON-settings source file",
    tool: "Edit",
    input: { file_path: "src/config/system-settings.ts", new_string: '      "Bash(npx *)",' },
  },
  {
    what: "a settings.json NOT under .claude",
    tool: "Edit",
    input: { file_path: "F:/Repo/.vscode/settings.json", new_string: '      "Bash(npx *)",' },
  },
  {
    what: "a Read of a settings file",
    tool: "Read",
    input: { file_path: REPO_SETTINGS },
  },
  {
    what: "a Bash command (not an edit tool)",
    tool: "Bash",
    input: { command: `echo "Bash(npx *)" >> ${REPO_SETTINGS}` },
  },
];

export function runRiskyAllowGuardTests() {
  assert.ok(existsSync(guardPath), `the risky-allow guard is missing at ${guardPath}`);

  // 1. The guard itself — risky wildcards are denied with a plain reason.
  for (const { what, tool, input } of DENIES) {
    const { decision, reason } = runGuard(tool, input);
    assert.equal(decision, "deny", `${what} must be denied (${tool})`);
    assert.match(reason, /blanket "allow" wildcard/, `the refusal must say plainly why: ${reason}`);
    assert.match(reason, /exact, scoped command/, `the refusal must name the safe alternative: ${reason}`);
  }
  // 2. Everything that is not a risky-wildcard edit of a settings file passes silently.
  for (const { what, tool, input } of SILENT) {
    const { decision, reason } = runGuard(tool, input);
    assert.equal(decision, "silent", `this must pass silently — ${what}:\n${reason}`);
  }

  // 3. The escape hatch stands the guard down for a deliberate human write.
  assert.equal(
    runGuard("Edit", { file_path: REPO_SETTINGS, new_string: '      "Bash(npx *)",' }, { off: true }).decision,
    "silent",
    "PHX_RISKY_ALLOW_GUARD_OFF=1 must stand the guard down",
  );

  // 4. It FAILS OPEN — empty, garbled and non-JSON input must never block an edit.
  for (const rawInput of ["", "   ", "{not json", "null", "[]"]) {
    assert.equal(runGuard("Edit", {}, { rawInput }).decision, "silent", `fail-open on input ${JSON.stringify(rawInput)}`);
  }

  // 5. The wiring. A hook nothing runs is a comment — and a matcher missing a tool lets that route
  //    through while looking installed.
  const entries = wiredHookGroups("PreToolUse").filter((entry) =>
    (entry.hooks ?? []).some((hook) => (hook.command ?? "").includes("risky-allow-guard.mjs")),
  );
  assert.ok(entries.length > 0, "the risky-allow guard must be registered (settings.json or the dispatch table)");
  const matchers = entries.flatMap((entry) => (entry.matcher ?? "").split("|"));
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.ok(
      matchers.includes(tool),
      `the guard must be registered for ${tool} — a matcher missing it lets that route through while looking installed (matchers: ${matchers.join("|")})`,
    );
  }
}
