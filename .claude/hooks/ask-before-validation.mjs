#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) gate — never start a long validation run while the owner is
// still editing. Owner's rule, 2026-08-15. See AGENTS.md §7.
//
// WHY THIS EXISTS: `permissions.allow` used to list `pnpm run check:harden`, `run test`,
// `run lint` and `run typecheck` outright, so the single most expensive thing a session can
// do on a 16 GB machine ran with no prompt whatsoever. Those entries are gone; this hook is
// what replaced them. It does not block — it forces the one question worth asking first:
// "Have you finished editing?" Yes -> approve, it runs. No -> reject, keep editing.
//
// FAILS OPEN: any parse/logic error exits 0 (allow). A hook bug must never block a real command.
import { readFileSync } from 'node:fs';

// Each entry is [label, pattern]. Keep the label short — it names the run in the prompt.
const LONG_VALIDATION = [
  ['check:harden (all 10 gates, ends in a full next build)', /\bcheck:harden\b/],
  ['the full CI script (same 10 gates)', /\bpnpm\s+run\s+ci\b/],
  ['a production build', /\brun\s+build\b|\bnext\s+build\b/],
  ['the whole test suite', /\brun\s+test\b|\brun\s+coverage\b/],
  ['ESLint over the repo', /\brun\s+lint\b|\beslint\b/],
  ['a full typecheck', /\brun\s+typecheck\b|\bcheck:edit\b|\btsc\b[^|;&\n]*--noEmit/],
];

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') process.exit(0);
  const cmd = String(input?.tool_input?.command ?? '');
  if (!cmd) process.exit(0);

  const hit = LONG_VALIDATION.find(([, pattern]) => pattern.test(cmd));
  if (!hit) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          `Have you finished editing? This runs ${hit[0]} — minutes of a machine that ` +
          'thrashes past ~4 concurrent sessions. Approve ONLY if the work is done. If you are ' +
          'still editing, reject: re-validating code that is about to change again proves ' +
          'nothing (AGENTS.md §7). Nothing is at risk either way — CI re-runs all of it on the ' +
          'PR and blocks a red merge.',
      },
    }),
  );
  process.exit(0);
} catch {
  process.exit(0); // fail open
}
