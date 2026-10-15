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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareToProtection, declaredRequiredChecks, readProtectionContexts } from './required-check-names.mjs';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-required-checks",
  entry: import.meta.url,
  known: ["--json"],
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const asJson = process.argv.includes('--json');

/**
 * 🔴 THIS TOOL PARSES THE WORKING TREE, SO A STALE CHECKOUT MAKES IT WRONG IN BOTH DIRECTIONS — and
 * the quiet direction certifies the stale file as current.
 *
 * Measured 2026-09-29, minutes after #4811 landed the corrected list: the primary checkout sat 7
 * commits behind `origin/main`, so its `AGENTS.md` still declared four names while protection required
 * two, and this script printed two ERRORs naming `mobile` and `secret-scan`. Both the gate and the
 * docs on `main` were already correct. That direction is merely noisy. **The inverse is the dangerous
 * one:** a checkout from BEFORE a protection change parses a file that still matches the OLD gate and
 * prints `OK` — so the one tool that exists to catch a rotation reports agreement with a gate that has
 * already moved. Same class as a watcher that cannot say "I did not look".
 *
 * It stays a local-file parse rather than reading `origin/main:AGENTS.md`, deliberately: the tool is
 * most useful ON a branch that is editing §2, where `origin/main` would be exactly the wrong answer.
 * So the fix is not to change what it reads — it is to refuse a bare `OK` when the checkout is behind,
 * and to print the checkout's position beside every verdict so a stale answer reads as stale.
 *
 * Never throws: a missing git, a detached HEAD or no `origin/main` ref all degrade to `{ note }`.
 */
function checkoutPosition() {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    }).trim();
  let sha;
  try {
    sha = git(['rev-parse', '--short', 'HEAD']);
  } catch (err) {
    return { note: `could not read HEAD (${String(err?.message ?? err).split('\n')[0]})` };
  }
  // Best-effort refresh: without it `origin/main` is itself a local snapshot, so `behind` would be only
  // a FLOOR. A failure here is not a failure of the check — say which, and carry on with what we have.
  let fetched = true;
  try {
    git(['fetch', '--quiet', 'origin', 'main']);
  } catch {
    fetched = false;
  }
  let behind;
  try {
    behind = Number(git(['rev-list', '--count', 'HEAD..origin/main']));
  } catch (err) {
    return { sha, note: `no comparable origin/main ref (${String(err?.message ?? err).split('\n')[0]})` };
  }
  if (!Number.isFinite(behind)) return { sha, note: 'the origin/main comparison returned no count' };
  return { sha, behind, fetched };
}

const position = checkoutPosition();

/** One line saying where the parsed file came from, printed beside every verdict. */
function positionLine() {
  if (position.note) return `[required-checks] checkout ${position.sha ?? '?'} — ${position.note}`;
  const floor = position.fetched ? '' : ' (the fetch failed, so this is a FLOOR)';
  return position.behind === 0
    ? `[required-checks] checkout ${position.sha} — up to date with origin/main${floor}`
    : `[required-checks] checkout ${position.sha} — ${position.behind} commit(s) BEHIND origin/main${floor}`;
}

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
  if (asJson) console.log(JSON.stringify({ declared, position, skipped: live.skipped }, null, 2));
  else {
    console.log(`[required-checks] SKIPPED — ${live.skipped}.`);
    console.log(positionLine());
    console.log(`  AGENTS.md §2 declares ${declared.count}: ${declared.names.join(', ')}`);
    console.log('  That is the DECLARATION, not the gate. Nothing here confirms it matches protection.');
  }
  process.exit(0);
}

const verdict = compareToProtection(declared.names, live.contexts);
const stale = Number.isFinite(position.behind) && position.behind > 0;

if (asJson) {
  console.log(JSON.stringify({ declared, position, protection: live.contexts, verdict, stale }, null, 2));
  process.exit(verdict.ok && !stale ? 0 : 1);
}

console.log(`[required-checks] protection requires ${live.contexts.length}: ${live.contexts.join(', ')}`);
console.log(`[required-checks] AGENTS.md §2 declares ${declared.count}: ${declared.names.join(', ')}`);
console.log(positionLine());

if (verdict.ok) {
  if (declared.count !== declared.names.length) {
    console.error(
      `[required-checks] ERROR: the names match protection, but §2's COUNT says ${declared.count} `
        + `while it lists ${declared.names.length}. The count is the half that has rotted every time.`,
    );
    process.exit(1);
  }
  if (stale) {
    // 🔴 The whole point of the clause. An `OK` here would be the false green: the file parsed is older
    // than `main`, so it can agree with the gate only because BOTH are behind, or by coincidence.
    console.error(
      '[required-checks] OK-BUT-STALE — the declared list matches the live gate, but this checkout is '
        + `${position.behind} commit(s) behind origin/main, so the file just parsed is not the one on `
        + '`main`. That agreement is not evidence: a checkout from before a protection change matches the '
        + 'OLD gate and prints OK. Re-run on a current tree (a fresh worktree, or `git merge --ff-only '
        + 'origin/main` where that is safe) before treating this as a pass.',
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
if (stale) {
  console.error(
    `[required-checks] BUT READ THE POSITION FIRST: this checkout is ${position.behind} commit(s) behind `
      + 'origin/main, so the mismatch above may already be FIXED on `main` and be an artefact of the stale '
      + 'file. That happened on 2026-09-29, seven commits behind, minutes after #4811 corrected the list. '
      + 'Re-run on a current tree before editing anything.',
  );
} else {
  console.error(
    '[required-checks] Fix the DOCS to match protection (protection is the authority, never a file), '
      + 'and fix every file that states the list in the same PR: AGENTS.md §2 and §7, CLAUDE.md, '
      + '.claude/skills/ship, .claude/skills/verify-context, .github/pull_request_template.md.',
  );
}
process.exit(1);
