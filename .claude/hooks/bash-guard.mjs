#!/usr/bin/env node
// PreToolUse(Bash) guard — deterministic, zero-cost.
// Blocks the commands the memory documents as silent traps in THIS repo:
//   C1  recursive grep  — ~346k path entries make `grep -r` hang 10-40s+. Use rg / git grep.
//
// And triggers one NON-blocking side effect:
//   C5  worktree removal — hands the command to worktree-exit-guard.mjs --pre-removal so the
//       backup check is LOGGED while the directory still exists. Never denies. See that file for
//       why the SessionEnd check alone was not enough.
//
// RETIRED 2026-08-10:
//   C4  standalone jq — blocked jq because it was not installed and emitted zero output, which
//       looks identical to success. jq 1.8.2 is now installed (scoop, ~/scoop/shims/jq.exe), so
//       the guard was denying a command that works. A guard asserting something untrue is worse
//       than no guard: it costs every session a wasted round trip and teaches a false fact.
//       If jq ever disappears from PATH again, restore the check rather than reasoning around it.
// FAILS OPEN: any parse/logic error exits 0 (allow). A hook bug must never block a real command.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  // C5 — a command that looks like it removes a worktree. NOT a denial: hand the command to the
  // backup guard so the unpushed-commit check is written to .claude/worktree-exit.log while the
  // directory still exists. The SessionEnd guard cannot do this — by the time it runs, the worktree
  // (and the guard script inside it) may already be deleted, which is exactly how three weeks of
  // exits went unlogged. Measured 2026-08-23.
  //
  // The regex is only a cheap pre-filter so the common command pays nothing; the guard itself
  // decides whether a real registered worktree is actually targeted.
  const removalShaped = /worktree\s+remove|\brmdir\b|\bremove-item\b|(?:^|[\s|&;(])rm\s+-[a-zA-Z]*r/i;
  if (removalShaped.test(cmd)) {
    try {
      const guard = fileURLToPath(new URL('./worktree-exit-guard.mjs', import.meta.url));
      const report = execFileSync(process.execPath, [guard, '--pre-removal'], {
        input: cmd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 20000,
      });
      // Relay the guard's systemMessage as this hook's output so it surfaces in the session, not
      // only in the log. Empty when nothing registered was targeted.
      if (report && report.trim()) process.stdout.write(report.trim() + '\n');
    } catch {
      // A logging failure must never block a real command — same fail-open contract as the rest.
    }
  }

  process.exit(0);
} catch {
  process.exit(0); // fail open
}
