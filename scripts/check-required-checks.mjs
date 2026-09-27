#!/usr/bin/env node
// Holds AGENTS.md §2's required-check declaration against what branch protection ACTUALLY requires.
//
// WHY THIS IS A SCRIPT AND NOT A TEST. `tests/required-check-names.test.ts` holds the declaration
// against the workflows' job names, which is the half that lives in files and can run offline inside
// the required `checks` job. What it cannot do is read the gate: CI has no `gh` auth for
// `branches/main/protection`, and a REQUIRED check that needs network and auth would have to fail
// open — a check that fails open is not something to rely on, so putting the live read there would
// buy a green that means less than the one it replaced. Its green therefore proves the docs and the
// workflows agree with EACH OTHER, never with protection. This closes that, from outside the gate.
//
// WHAT IT CATCHES, and the two directions are not symmetrical:
//   * a name a DOC states that protection does NOT require -> a session waits for a check that can
//     never report. That happened on 2026-09-27: #4527 folded `lint`+`typecheck`+`test` into one
//     `checks` job, nineteen places went on saying "6 required checks", and a session following
//     `.claude/skills/ship` counted to six and sat waiting on three names that no longer exist.
//   * a name protection REQUIRES that no doc states -> a session counts passes to the wrong total and
//     can read a PR as green while a required check is still pending. Quieter and worse.
//
// The list has rotted four times: 4 -> 5 -> 6 -> 4. So the answer is never a number from a file.
//
// IT SKIPS RATHER THAN FAILING when it cannot reach the gate — no `gh`, not authenticated, no
// network, a token without `administration: read`. Exit 0 and a sentence saying WHICH, because this
// is meant to be runnable anywhere and a command that fails on a plane is one people stop running.
// Only a reading it actually obtained can fail it.
//
//   node scripts/check-required-checks.mjs            # compare, exit 1 on drift
//   node scripts/check-required-checks.mjs --json     # the whole reading
//
// Also reported by `node scripts/repo-doctor.mjs` (which already pages a live API), so it turns up
// without being remembered.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareToProtection, declaredRequiredChecks, readProtectionContexts } from './required-check-names.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json');

const agentsPath = path.join(__dirname, '..', 'AGENTS.md');
let declared;
try {
  declared = declaredRequiredChecks(fs.readFileSync(agentsPath, 'utf8'));
} catch {
  declared = { error: `AGENTS.md could not be read at ${agentsPath}` };
}

if (declared.error) {
  console.error(`[required-checks] ERROR: ${declared.error}`);
  process.exit(1);
}

const live = readProtectionContexts();

if (live.skipped) {
  if (asJson) console.log(JSON.stringify({ declared, skipped: live.skipped }, null, 2));
  else {
    console.log(`[required-checks] SKIPPED — ${live.skipped}.`);
    console.log(`  AGENTS.md §2 declares ${declared.count}: ${declared.names.join(', ')}`);
    console.log('  That is the DECLARATION, not the gate. Nothing here confirms it matches protection.');
  }
  process.exit(0);
}

const verdict = compareToProtection(declared.names, live.contexts);

if (asJson) {
  console.log(JSON.stringify({ declared, protection: live.contexts, verdict }, null, 2));
  process.exit(verdict.ok ? 0 : 1);
}

console.log(`[required-checks] protection requires ${live.contexts.length}: ${live.contexts.join(', ')}`);
console.log(`[required-checks] AGENTS.md §2 declares ${declared.count}: ${declared.names.join(', ')}`);

if (verdict.ok) {
  if (declared.count !== declared.names.length) {
    console.error(
      `[required-checks] ERROR: the names match protection, but §2's COUNT says ${declared.count} `
        + `while it lists ${declared.names.length}. The count is the half that has rotted every time.`,
    );
    process.exit(1);
  }
  console.log('[required-checks] OK — the declared list matches the live gate.');
  process.exit(0);
}

for (const name of verdict.documentedButNotRequired) {
  console.error(
    `[required-checks] ERROR: AGENTS.md states \`${name}\` but protection does NOT require it. `
      + 'A session following the docs waits for a check that will never report.',
  );
}
for (const name of verdict.requiredButNotDocumented) {
  console.error(
    `[required-checks] ERROR: protection requires \`${name}\` and AGENTS.md does not state it. `
      + 'A session counting passes to the documented total can call a PR green while that check is pending.',
  );
}
console.error(
  '[required-checks] Fix the DOCS to match protection (protection is the authority, never a file), '
    + 'and fix every file that states the list in the same PR: AGENTS.md §2 and §7, CLAUDE.md, '
    + '.claude/skills/ship, .claude/skills/verify-context, .github/pull_request_template.md.',
);
process.exit(1);
