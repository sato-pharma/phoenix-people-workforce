#!/usr/bin/env node
// PreToolUse(Bash) guard — deterministic, zero-cost.
// Blocks the commands the memory documents as silent traps in THIS repo:
//   C1  recursive grep  — ~346k path entries make `grep -r` hang 10-40s+. Use rg / git grep.
//
// RETIRED 2026-08-10:
//   C4  standalone jq — blocked jq because it was not installed and emitted zero output, which
//       looks identical to success. jq 1.8.2 is now installed (scoop, ~/scoop/shims/jq.exe), so
//       the guard was denying a command that works. A guard asserting something untrue is worse
//       than no guard: it costs every session a wasted round trip and teaches a false fact.
//       If jq ever disappears from PATH again, restore the check rather than reasoning around it.
// FAILS OPEN: any parse/logic error exits 0 (allow). A hook bug must never block a real command.
import { readFileSync } from 'node:fs';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (input.tool_name !== 'Bash') process.exit(0);
  const cmd = String(input?.tool_input?.command ?? '');
  if (!cmd) process.exit(0);

  // C1 — recursive grep at a command position (start / after | ; & ( && ||).
  // `git grep` and `rg` are NOT matched (git grep honours .gitignore; rg isn't grep).
  const recursiveGrep =
    /(?:^|[|&;(]|&&|\|\|)\s*(?:e|f)?grep\b[^|&;\n]*?\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/;
  if (recursiveGrep.test(cmd) || /\balias\s+grep=/.test(cmd)) {
    deny(
      'Recursive grep hangs in this repo (~346k path entries get scanned; 10-40s+). ' +
        'Use `git grep` (in the shell) or the Grep tool — both honour .gitignore and stay fast. ' +
        '(`rg`/`gg` are not reliably on the shell PATH here. Never `alias grep=rg`.)',
    );
  }

  process.exit(0);
} catch {
  process.exit(0); // fail open
}
