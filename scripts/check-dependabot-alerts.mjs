#!/usr/bin/env node
// Surfaces OPEN Dependabot alerts that will fail the audit step behind `checks`, BEFORE a PR goes red.
//
// WHY. The `static` job runs `pnpm audit --audit-level=high --prod`. The moment the audit's data feed learns
// about a HIGH-or-worse advisory against a package in the production tree, EVERY open pull request goes
// red — and by AGENTS.md §2.3 a red check suite on a `main` commit makes Railway mark that production
// deploy SKIPPED, which does not resurrect on a re-run. Measured 2026-09-30: the same dependency passed
// that step at 16:11 and failed it at 16:29 with nothing in the repository having changed. Three
// consecutive deploys were withheld that evening, and the cause was Dependabot's own update job
// failing rather than a PR anybody could merge.
//
// The alert exists in the API as soon as the advisory is published — hours before the audit feed picks
// it up. So the difference between a deliberate bump and a frozen afternoon is only whether anyone
// looked. This is the look.
//
// IT SKIPS RATHER THAN FAILING when it cannot reach the API — no `gh`, not authenticated, no network, a
// token without `security_events`. Exit 0 and a sentence saying WHICH, exactly as
// `check-required-checks.mjs` does: this must be runnable anywhere, and a command that fails on a
// plane is one people stop running. Only a reading it actually obtained can fail it.
//
// 🔴 AND AN EMPTY LIST IS NOT A CLEAN BILL BY ITSELF. Zero alerts reads identically whether nothing is
// vulnerable or nobody is looking, so a bare zero is never reported as clean: `vulnerability-alerts`
// (204 enabled / 404 disabled) is read alongside, and a zero from a repo with alerts SWITCHED OFF
// exits 1 saying so. That absent-answer-in-the-shape-of-a-negative-one is the exact class that cost
// four separate defects in the roll-up tool the same day.
//
//   node scripts/check-dependabot-alerts.mjs          # exit 1 on an open HIGH+ alert, or a blind zero
//   node scripts/check-dependabot-alerts.mjs --json   # the whole reading
//
// 🔴 AND IT EXITS 1 ONLY FOR AN ALERT THE AUDIT CAN ACTUALLY REACH. `pnpm audit --prod` runs at the
// repository root, so an alert in `development` scope, or in a manifest that audit never reads,
// CANNOT turn `checks` red — those are printed with the reason and do not fail this check. Before
// 2026-10-04 they were graded `WILL FAIL CI`: three of them were, with no patched version to bump
// to, while the gate command itself exited 0 on "No known vulnerabilities found". The grading fails
// CLOSED — only a positively-read reason downgrades an alert, so a wrong reading can only be noisy.
// The decision and the fail-closed rule: `docs/security/open-dependency-alerts.md`.
//
// Also reported by `node scripts/repo-doctor.mjs` (which already pages a live API), so it turns up
// without being remembered. EVERY branch below is `judgeAlerts()`, which is pure and pinned by
// `tests/dependabot-alerts.test.ts` — this file only reads and prints, so there is no verdict here
// that a test cannot reach.
'use strict';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DECISIONS_DOC, alertsEnabled, judgeAlerts, readOpenAlerts, readRecordedDecisions } from './dependabot-alerts.mjs';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-dependabot-alerts",
  entry: import.meta.url,
  known: ["--json"],
});

const asJson = process.argv.includes('--json');
const read = readOpenAlerts();
const enabled = read.skipped ? { unknown: 'not read — the alerts themselves could not be read' } : alertsEnabled();
// An alert whose risk decision is already written down must not keep demanding one. Unreadable file,
// moved file, no rows: `readRecordedDecisions` returns an empty map and every alert keeps its demand,
// which is the fail-closed direction — see its header.
let decisionsDoc = '';
try {
  decisionsDoc = readFileSync(path.join(import.meta.dirname, '..', DECISIONS_DOC), 'utf8');
} catch {
  decisionsDoc = '';
}
const verdict = judgeAlerts(read, enabled, readRecordedDecisions(decisionsDoc));

if (asJson) {
  console.log(JSON.stringify({
    skipped: read.skipped ?? null,
    failing: verdict.failing,
    other: verdict.other,
    alertsEnabled: enabled,
    exitCode: verdict.exitCode,
  }, null, 2));
  process.exit(verdict.exitCode);
}

for (const line of verdict.errors) console.error(`[dependabot] ${line}`);
for (const line of verdict.notes) console.log(`[dependabot] ${line}`);
process.exit(verdict.exitCode);
