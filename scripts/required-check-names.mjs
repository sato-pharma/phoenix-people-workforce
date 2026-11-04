#!/usr/bin/env node
// The ONE parse of AGENTS.md §2's required-check declaration, and the ONE comparison of it against
// branch protection.
//
// WHY IT IS A MODULE. `tests/required-check-names.test.ts` holds the declaration against the
// workflows OFFLINE, and `scripts/check-required-checks.mjs` holds it against the LIVE gate. Those
// are two different questions and they need two different homes — a required check may not depend on
// network or auth, and a live read cannot run inside one. But if each owned its own copy of the
// parse, the two could disagree about what AGENTS.md says, which is precisely the class of drift this
// whole area exists to stop: the required-check list has rotted four times (4 -> 5 -> 6 -> 4), and
// every one of those was two places describing one fact.
//
// Same shape, and the same reason, as `repo-doctor-archive-refs.mjs`: the parsing lives in a module
// so a test can drive the REAL thing rather than a restatement of it.
'use strict';

import { execFileSync } from 'node:child_process';

/** The three names that stopped being checks on 2026-09-27 (#4527). */
export const RETIRED_CHECK_NAMES = ['lint', 'typecheck', 'test'];

/**
 * The GitHub account that owns this repository, and the repository itself — the ONE place the scripts
 * read them from (moved to a new account on 2026-10-26). `tests/github-owner-slug.test.ts` refuses any
 * other account name in code, CI, scripts, hooks and tests.
 */
export const GITHUB_OWNER = 'Omar-3-xx';
export const REPO = `${GITHUB_OWNER}/phoenix-people-workforce`;

/**
 * What branch protection ACTUALLY requires, or `{ skipped: <why> }`. Never throws and never guesses.
 *
 * It lives here rather than in `check-required-checks.mjs` because that file is a CLI that runs its
 * whole report at import time — importing a function out of it would fire the report and its
 * `process.exit` as a side effect. `repo-doctor-archive-refs.mjs` exists for the same reason.
 *
 * A reason is not a failure, and naming WHICH one keeps the next reader off the wrong trail: a 403
 * here was a real three-hour Pro-entitlement lapse on 2026-09-27, during which protection returned
 * "Upgrade to GitHub Pro" and `branches/main` read `protected: false`.
 */
export function readProtectionContexts() {
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${REPO}/branches/main/protection/required_status_checks`, '--jq', '.contexts'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    );
    const contexts = JSON.parse(raw);
    if (!Array.isArray(contexts)) return { skipped: 'protection returned no contexts array' };
    return { contexts };
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    if (err?.code === 'ENOENT') return { skipped: 'the `gh` CLI is not on PATH here' };
    if (/gh auth login|authentication|not logged/i.test(stderr)) return { skipped: '`gh` is not authenticated here' };
    if (/403/.test(stderr)) return { skipped: 'protection returned 403 — token scope, or the repo lost its Pro entitlement' };
    if (/404/.test(stderr)) return { skipped: 'protection returned 404 — main may not be protected at all (read that as an ALARM, not a skip)' };
    return { skipped: `could not read protection (${String(err?.message ?? err).split('\n')[0]})` };
  }
}

/**
 * The declaration AGENTS.md §2 carries:
 *   "branch-protected with **N required checks** — `a`, `b`, `c`, `d`; allow_auto_merge: false"
 *
 * Returns `{ count, names }`, or `{ error }` naming what could not be read. It NEVER throws and
 * never asserts: the test wants a failure with its own message, the script wants an exit code and a
 * sentence, and a module that throws would force both to catch. A `null`-shaped answer that says
 * WHICH half is missing is what lets each caller phrase it for its own reader.
 */
export function declaredRequiredChecks(agentsSource) {
  const bullet = String(agentsSource ?? '')
    .split('\n')
    .find((line) => /branch-protected with \*\*\d+ required checks\*\*/.test(line));
  if (!bullet) {
    return {
      error:
        'AGENTS.md §2 carries no bullet reading `branch-protected with **N required checks** — `a`, `b`, …`. '
        + 'That bullet is the declaration every other file is held against; without it nothing here can be checked.',
    };
  }
  const countMatch = /\*\*(\d+) required checks\*\*/.exec(bullet);
  if (!countMatch) {
    return {
      error:
        "AGENTS.md §2's required-checks bullet no longer states a count as `**N required checks**`, so the "
        + `declaration cannot be parsed:\n  ${bullet.trim().slice(0, 200)}`,
    };
  }
  // Only the names BEFORE the first semicolon: `allow_auto_merge: false` and the rot warning follow.
  const listPart = bullet.slice(bullet.indexOf('required checks**')).split(';')[0];
  const names = [...listPart.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
  return { bullet: bullet.trim(), count: Number(countMatch[1]), names };
}

/**
 * The declared list against what branch protection actually requires, as SETS — protection returns
 * its contexts in its own order and that order carries no meaning, so comparing sequences would
 * invent a failure out of a reordering.
 */
export function compareToProtection(declaredNames, protectionContexts) {
  const declared = new Set(declaredNames);
  const required = new Set(protectionContexts);
  const documentedButNotRequired = [...declared].filter((n) => !required.has(n)).sort();
  const requiredButNotDocumented = [...required].filter((n) => !declared.has(n)).sort();
  return {
    ok: documentedButNotRequired.length === 0 && requiredButNotDocumented.length === 0,
    // A name a DOC states and protection does not: a session waits for a check that will never
    // report. This is the direction that cost a real wait on 2026-09-27.
    documentedButNotRequired,
    // A name protection requires and no doc states: a session counts passes to the wrong total and
    // can call a PR green while a required check is still pending.
    requiredButNotDocumented,
  };
}
