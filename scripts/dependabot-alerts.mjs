#!/usr/bin/env node
// THE ONE READ OF DEPENDABOT'S OPEN ALERTS, AND THE ONE JUDGEMENT OF WHICH OF THEM WILL FREEZE CI.
//
// WHY THIS EXISTS. `validate`'s dependency-audit step runs `pnpm audit --audit-level=high --prod`, so a
// HIGH-or-worse advisory against a package in the PRODUCTION tree fails every pull request the moment
// the audit's data source learns about it — and by AGENTS.md §2.3 a red check suite on a `main` commit
// makes Railway mark that production deploy SKIPPED. Measured 2026-09-30: `next` passed that step at
// 16:11 and failed it at 16:29 with nothing in the repository having changed. Between those two runs
// every PR in the repo went red and production deploys froze.
//
// So the expensive part is never the bump — it is finding out from a red PR rather than in advance. An
// alert is visible in the API from the moment the advisory is published, which is HOURS before the
// audit feed picks it up. This turns that window into warning instead of surprise.
//
// WHY NOT AUTO-MERGE, since that is the obvious-looking answer and it was asked for on 2026-09-30:
// Dependabot auto-merge is `gh pr merge --auto`, which AGENTS.md §2 bans outright, and it would
// delegate merges to `main` — which ship to production within minutes — to a bot permanently. It also
// would not have helped that day: Dependabot never opened a PR at all, its own update job FAILED twice
// and withheld three deploys, and auto-merge cannot merge a PR that does not exist. The owner chose
// early warning over auto-merge with that in front of him.
//
// WHY IT IS A SCRIPT AND NOT A REQUIRED CHECK. Same reasoning as `check-required-checks.mjs`: CI has no
// `gh` auth for `dependabot/alerts`, and a required check that needs network and auth has to fail open.
// A check that fails open is not something to rely on. The PURE half below is unit-tested; the live
// read is exercised by running it.
'use strict';

import { execFileSync } from 'node:child_process';

const REPO = 'Gawish-1997/phoenix-people-workforce';

/**
 * Severities that fail `--audit-level=high`. `moderate` and `low` do NOT fail the audit, so they are
 * reported but never treated as urgent — calling them urgent would train a reader to ignore the report.
 */
export const AUDIT_FAILING_SEVERITIES = new Set(['high', 'critical']);

/**
 * Every severity GitHub actually issues. Anything outside this set is not a quieter alert — it is an
 * alert whose severity could not be read, and those are treated as URGENT below.
 */
export const KNOWN_SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);

/**
 * Open alerts, or `{ skipped: <why> }`. Never throws and never guesses.
 *
 * A reason is not a failure, and naming WHICH one keeps the next reader off the wrong trail: an empty
 * array and "alerts are switched off" are the same shape from the outside, so the caller is told which
 * it got. `repos/<repo>/vulnerability-alerts` answers 204 when they are enabled, which is how an
 * honest zero is told from a blind one.
 */
export function readOpenAlerts() {
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${REPO}/dependabot/alerts?state=open&per_page=100`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    );
    const alerts = JSON.parse(raw);
    if (!Array.isArray(alerts)) return { skipped: 'the alerts endpoint returned no array' };
    return { alerts };
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    if (err?.code === 'ENOENT') return { skipped: 'the `gh` CLI is not on PATH here' };
    if (/gh auth login|authentication|not logged/i.test(stderr)) return { skipped: '`gh` is not authenticated here' };
    if (/403/.test(stderr)) return { skipped: 'the alerts endpoint returned 403 — the token lacks `security_events` or `repo`' };
    if (/404/.test(stderr)) return { skipped: 'the alerts endpoint returned 404 — Dependabot alerts may be disabled for this repo' };
    return { skipped: `could not read the alerts (${String(err?.message ?? err).split('\n')[0]})` };
  }
}

/**
 * Whether Dependabot alerts are switched ON, so a zero can be told from a blind spot.
 *
 * 🔴 AN EMPTY ALERT LIST IS NOT EVIDENCE BY ITSELF. It reads identically whether nothing is vulnerable
 * or nobody is looking, and that is the same absent-answer-as-negative-answer shape that cost four
 * separate defects in the roll-up tool on 2026-09-30. `vulnerability-alerts` answers 204 when enabled
 * and 404 when not, so it separates the two.
 */
export function alertsEnabled() {
  try {
    execFileSync('gh', ['api', `repos/${REPO}/vulnerability-alerts`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { enabled: true };
  } catch (err) {
    if (/404/.test(String(err?.stderr ?? ''))) return { enabled: false };
    return { unknown: `could not tell (${String(err?.message ?? err).split('\n')[0]})` };
  }
}

/**
 * One graded alert. Named rather than `object`, because a caller doing `rows.map((r) => r.package)`
 * against `Array<object>` is a typecheck error — which is how CI caught the first version of this.
 *
 * @typedef {{
 *   severity: string,
 *   ghsa: string,
 *   package: string,
 *   manifest: string,
 *   vulnerableRange: string,
 *   patchedVersion: string | null,
 * }} AlertRow
 */

/**
 * Sort the open alerts into the ones that will fail the audit and the ones that will not.
 *
 * PURE, so the judgement that matters is testable without network or `gh` auth — the live read above
 * cannot be, which is exactly why the split is here.
 *
 * `manifest_path` is reported because it is the one field that says whether a finding is in the app's
 * own dependency tree or in a workspace the audit never walks. It is NOT used to decide urgency: the
 * audit's `--prod` filter is about prod-vs-dev, which the alert payload does not state, so guessing it
 * here would produce a confident wrong answer. Naming the package and letting the reader trace it is
 * better than inventing the tree.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} alerts raw `dependabot/alerts` entries.
 * @returns {{ failing: AlertRow[], other: AlertRow[] }}
 */
export function classifyAlerts(alerts) {
  const failing = [];
  const other = [];
  for (const alert of alerts ?? []) {
    const severity = String(alert?.security_advisory?.severity ?? '').toLowerCase();
    const row = {
      severity,
      ghsa: alert?.security_advisory?.ghsa_id ?? '(no id)',
      package: alert?.dependency?.package?.name ?? '(unnamed)',
      manifest: alert?.dependency?.manifest_path ?? '(unknown manifest)',
      vulnerableRange: alert?.security_vulnerability?.vulnerable_version_range ?? '(unstated)',
      patchedVersion: alert?.security_vulnerability?.first_patched_version?.identifier ?? null,
    };
    // 🔴 AN UNREADABLE SEVERITY IS TREATED AS URGENT, NOT AS QUIET. A missing or unrecognised
    // `severity` is an absent answer, and routing it to `other` would make it read as "not urgent" on
    // no evidence at all — the same shape as the zero-alerts-but-nobody-looking case above, and as the
    // four roll-up defects of 2026-09-30. Being noisy about an alert nobody can grade is recoverable;
    // filing it as harmless is not.
    if (AUDIT_FAILING_SEVERITIES.has(severity) || !KNOWN_SEVERITIES.has(severity)) failing.push(row);
    else other.push(row);
  }
  // Critical before high, then by package, so the same set always prints in the same order — a report
  // whose order moves between runs cannot be diffed by a reader.
  const rank = (s) => (s === 'critical' ? 0 : s === 'high' ? 1 : s === 'moderate' ? 2 : s === 'low' ? 3 : 4);
  const order = (a, b) => rank(a.severity) - rank(b.severity) || a.package.localeCompare(b.package);
  return { failing: failing.sort(order), other: other.sort(order) };
}

/**
 * One line per alert, in the form a session can act on: what to bump and to what.
 *
 * An alert with NO patched version is called out as such rather than left looking actionable — there
 * is nothing to bump to, so the answer is an override, a replacement or a risk decision, and saying
 * "bump to null" would send a reader hunting for a version that does not exist.
 *
 * @param {AlertRow} row
 * @returns {string}
 */
export function describeAlert(row) {
  const fix = row.patchedVersion
    ? `bump to ${row.patchedVersion}`
    : 'NO patched version exists yet — needs an override, a replacement, or a recorded risk decision';
  const severity = KNOWN_SEVERITIES.has(row.severity)
    ? row.severity.toUpperCase()
    // Says WHY it is in the urgent list, so a reader does not go hunting for a HIGH advisory that the
    // payload never stated.
    : `UNREADABLE-SEVERITY(${row.severity || 'absent'}) — graded urgent because it could not be graded`;
  return `${severity} ${row.package} ${row.vulnerableRange} — ${fix} [${row.ghsa}] (${row.manifest})`;
}

/**
 * THE WHOLE EXIT DECISION, PURE — given a reading, what does this tool say and what does it exit with.
 *
 * WHY IT LIVES HERE rather than inside the CLI. The CLI's branches are the part that can be wrong in a
 * way nobody notices: a skip that exits 1 makes the check unrunnable offline, and a blind zero that
 * exits 0 is a false clean bill. Neither can be rehearsed against the live API — the API answers
 * whatever is true today, which on 2026-09-30 was zero open alerts, so the failing paths would never
 * execute. Extracting the decision is what makes them testable, exactly as `rollup-check-state.mjs`
 * does for the roll-up's classification.
 *
 * @param {{ skipped?: string, alerts?: ReadonlyArray<object> }} read result of `readOpenAlerts()`.
 * @param {{ enabled?: boolean, unknown?: string }} enabled result of `alertsEnabled()`.
 * @returns {{ exitCode: 0|1, errors: string[], notes: string[], failing: AlertRow[], other: AlertRow[] }}
 */
export function judgeAlerts(read, enabled) {
  const errors = [];
  const notes = [];

  if (read?.skipped) {
    // Exit 0. A reason is not a verdict — see the file header. The second line matters as much as the
    // first: a bare "skipped" reads like a pass to a tired reader at 4am.
    notes.push(`skipped — ${read.skipped}`);
    notes.push('this is not a pass: nothing was read, so nothing was judged.');
    return { exitCode: 0, errors, notes, failing: [], other: [] };
  }

  const { failing, other } = classifyAlerts(read?.alerts);

  if (failing.length === 0 && other.length === 0) {
    if (enabled?.enabled === false) {
      // 🔴 The clause the whole file is built around. Zero alerts from a repo that is not looking is
      // not evidence of anything, and reporting it as OK is the false green.
      errors.push(
        'ERROR: zero open alerts, but Dependabot alerts are SWITCHED OFF for this repo, so that zero '
          + 'means nobody is looking — not that nothing is vulnerable. Turn them on in the repository\'s '
          + 'Security settings; until then `pnpm audit` in CI is the first thing that will notice a new '
          + 'advisory, which is the frozen-afternoon case this check exists to prevent.',
      );
      return { exitCode: 1, errors, notes, failing, other };
    }
    const how = enabled?.enabled === true
      ? 'and alerts are switched ON, so the zero was looked for'
      : `though ${enabled?.unknown ?? 'whether alerts are switched on could not be read'}`;
    notes.push(`OK — no open alerts (${how}).`);
    return { exitCode: 0, errors, notes, failing, other };
  }

  for (const row of failing) errors.push(`WILL FAIL CI: ${describeAlert(row)}`);
  for (const row of other) notes.push(`below the audit level: ${describeAlert(row)}`);

  if (failing.length === 0) {
    notes.push(
      `OK — ${other.length} open alert(s), none of them HIGH or CRITICAL, so none of them fails `
        + '`--audit-level=high`. Nothing is urgent; bump them with the next dependency PR.',
    );
    return { exitCode: 0, errors, notes, failing, other };
  }

  errors.push(
    `${failing.length} open HIGH+ alert(s). Each one fails \`validate\`'s `
      + '`pnpm audit --audit-level=high --prod` step as soon as the audit feed learns the advisory — '
      + 'which is AFTER the alert appears here, so there is a window and this is it. Bump them in ONE '
      + 'PR (AGENTS.md §6.1), then re-run this. A transitive one needs `pnpm update --depth Infinity '
      + '<pkg>`: `pnpm up` only touches direct dependencies and reports "Already up to date" for the rest.',
  );
  return { exitCode: 1, errors, notes, failing, other };
}
