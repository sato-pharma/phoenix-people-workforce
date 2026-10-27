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

import { REPO } from './required-check-names.mjs';

/**
 * Severities that fail `--audit-level=high`. `moderate`/`medium` and `low` do NOT fail the audit, so
 * they are reported but never treated as urgent — calling them urgent would train a reader to ignore
 * the report. (The REST alerts endpoint spells it `medium`, GraphQL and `npm audit` `moderate`; see
 * KNOWN_SEVERITIES below, where listing only one of the two spellings cost a false alarm.)
 */
export const AUDIT_FAILING_SEVERITIES = new Set(['high', 'critical']);

/**
 * Every severity GitHub actually issues. Anything outside this set is not a quieter alert — it is an
 * alert whose severity could not be read, and those are treated as URGENT below.
 *
 * 🔴 `medium` AND `moderate` ARE BOTH LISTED BECAUSE THE TWO GITHUB APIS SPELL THE SAME SEVERITY
 * DIFFERENTLY. The REST endpoint this file reads — `repos/<repo>/dependabot/alerts` — answers
 * `medium`; GraphQL and `npm audit` answer `moderate`. Only `moderate` was listed, so every MEDIUM
 * alert fell out of this set and was graded URGENT by the unreadable-severity rule below, printing
 * `UNREADABLE-SEVERITY(medium) — graded urgent because it could not be graded` under a headline
 * `N open HIGH+ alert(s)` — for alerts that are not HIGH and cannot fail `--audit-level=high` at
 * all. Measured 2026-10-06 against the live endpoint: `postcss-selector-parser`
 * (GHSA-rj75-hqrm-r3gf, CVSS 5.9) and `sprintf-js` (GHSA-hp3w-g68c-fv3c, CVSS 5.3) both answered
 * `severity: "medium"`, and both were reported as gate-blocking while the gate command itself
 * passed. That is precisely the 4am failure `docs/security/open-dependency-alerts.md` exists to
 * prevent, arriving from inside the checker: it sends a session hunting a bump that blocks nothing,
 * and `sprintf-js` has no patched version to hunt.
 *
 * The parenthesised severity in that message is what gave it away — a value it could PRINT cannot
 * be a value it could not READ. Adding a spelling here adds a value GitHub is known to issue; it is
 * never a way to quieten an alert, because `AUDIT_FAILING_SEVERITIES` above is the only thing that
 * decides urgency for a severity that IS readable.
 */
export const KNOWN_SEVERITIES = new Set(['low', 'moderate', 'medium', 'high', 'critical']);

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
 *   number: number | null,
 *   ghsa: string,
 *   package: string,
 *   manifest: string,
 *   vulnerableRange: string,
 *   patchedVersion: string | null,
 *   scope: string,
 *   outOfAuditReach: string | null,
 * }} AlertRow
 */

/**
 * The manifests `pnpm audit` walks when run at the repository root. See `classifyAlerts` below for why
 * this is the root pair and nothing else, and for the fail-closed rule that governs it.
 */
export const AUDITED_MANIFESTS = new Set(['package.json', 'pnpm-lock.yaml']);

/**
 * Why this alert cannot turn `validate` red — or `null` when it can, which is deliberately also the
 * answer whenever the reason could not be positively read.
 *
 * @param {{ scope: string, manifest: string }} row
 * @returns {string | null}
 */
export function whyOutOfAuditReach(row) {
  const manifest = row.manifest;
  // An ABSENT manifest is not an out-of-tree manifest. "(unknown manifest)" and an empty string are
  // absent answers, and the fail-closed rule says an absent answer stays failing — so they are
  // excluded here rather than being allowed to satisfy "not in the audited set".
  const manifestWasRead = Boolean(manifest) && manifest !== '(unknown manifest)';
  if (manifestWasRead && !AUDITED_MANIFESTS.has(manifest)) {
    return manifest + ' is not a manifest `pnpm audit` reads at the root';
  }
  if (row.scope === 'development') {
    return 'development scope, which the audit\'s `--prod` filter excludes';
  }
  return null;
}

/**
 * Sort the open alerts into the ones that will fail the audit and the ones that will not.
 *
 * PURE, so the judgement that matters is testable without network or `gh` auth — the live read above
 * cannot be, which is exactly why the split is here.
 *
 * 🔴 A HIGH ALERT THE AUDIT CANNOT REACH IS REPORTED, NOT GRADED AS FAILING — and this corrected a
 * claim that used to stand right here. This comment previously said the `--prod` filter is about
 * prod-vs-dev "which the alert payload does not state, so guessing it here would produce a confident
 * wrong answer". The payload DOES state it: every open alert carries `dependency.scope`, which is
 * `development` or `runtime`. Grading without it is what produced the confident wrong answer —
 * measured 2026-10-04, this tool printed `WILL FAIL CI` for three alerts and exited 1 while the gate
 * command itself, `node scripts/ci-dependency-audit.mjs`, exited 0 on "No known vulnerabilities
 * found" with all three open. A pre-merge check that cries wolf before every merge is one people learn
 * to wave through, and it sends sessions hunting a bump that does not exist.
 *
 * 🔴 IT FAILS CLOSED, AND THAT IS THE WHOLE SAFETY ARGUMENT. An alert leaves `failing` only when the
 * reason it cannot reach the audit is POSITIVELY read: scope literally `development`, or a manifest
 * literally outside the audited set. An absent scope, an unrecognised scope, an absent manifest or a
 * manifest this function does not know all count as REACHABLE and stay failing. So the worst a wrong
 * reading can do is keep an alert noisy, never quiet it — the direction the 2026-09-30 incident and the
 * unreadable-severity rule below both insist on.
 *
 * AUDITED_MANIFESTS is the root manifest pair on purpose: `pnpm-workspace.yaml` declares no
 * `packages:` list ("This is a single-package repo: no `packages:` list on purpose"), so the root
 * audit walks exactly one tree. A second lockfile elsewhere in the repository — an npm or yarn one for
 * a separate application — is never read by `pnpm audit` at the root and therefore cannot turn a check
 * red. Add to this set if the repo ever gains a real workspace, or the new package's alerts go unread.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} alerts raw `dependabot/alerts` entries.
 * @returns {{ failing: AlertRow[], other: AlertRow[], unreachable: AlertRow[] }}
 */
export function classifyAlerts(alerts) {
  const failing = [];
  const other = [];
  const unreachable = [];
  for (const alert of alerts ?? []) {
    const severity = String(alert?.security_advisory?.severity ?? '').toLowerCase();
    const manifest = alert?.dependency?.manifest_path ?? '(unknown manifest)';
    const scope = String(alert?.dependency?.scope ?? '').toLowerCase() || '(unstated)';
    const row = {
      severity,
      // The alert NUMBER, which is what a recorded decision is keyed on. Never the GHSA: one advisory
      // can open several alerts, one per manifest, and `open-dependency-alerts.md` says in red that a
      // row for one of them "is not a precedent for the other open alerts". Keying on the GHSA would
      // make that precedent automatic and silent — braces GHSA-vfj7-8cjw-p6xm is open twice here.
      number: Number.isInteger(alert?.number) ? alert.number : null,
      ghsa: alert?.security_advisory?.ghsa_id ?? '(no id)',
      package: alert?.dependency?.package?.name ?? '(unnamed)',
      manifest,
      vulnerableRange: alert?.security_vulnerability?.vulnerable_version_range ?? '(unstated)',
      patchedVersion: alert?.security_vulnerability?.first_patched_version?.identifier ?? null,
      scope,
      // Computed in the literal, not assigned afterwards: a later `row.x = …` on an object whose
      // shape was already inferred is a typecheck error, and this file is checked.
      outOfAuditReach: whyOutOfAuditReach({ scope, manifest }),
    };
    // 🔴 AN UNREADABLE SEVERITY IS TREATED AS URGENT, NOT AS QUIET. A missing or unrecognised
    // `severity` is an absent answer, and routing it to `other` would make it read as "not urgent" on
    // no evidence at all — the same shape as the zero-alerts-but-nobody-looking case above, and as the
    // four roll-up defects of 2026-09-30. Being noisy about an alert nobody can grade is recoverable;
    // filing it as harmless is not.
    const urgent = AUDIT_FAILING_SEVERITIES.has(severity) || !KNOWN_SEVERITIES.has(severity);
    // An UNREADABLE severity is never parked as unreachable. Reachability answers "can this turn the
    // gate red", which is a weaker question than "is this dangerous", and an alert nobody could grade
    // must stay loud whatever tree it sits in.
    const gradable = KNOWN_SEVERITIES.has(severity);
    if (urgent && gradable && row.outOfAuditReach) unreachable.push(row);
    else if (urgent) failing.push(row);
    else other.push(row);
  }
  // Critical before high, then by package, so the same set always prints in the same order — a report
  // whose order moves between runs cannot be diffed by a reader.
  // `medium` ranks with `moderate` — the same severity in the other API's spelling.
  const rank = (s) =>
    s === 'critical' ? 0 : s === 'high' ? 1 : s === 'moderate' || s === 'medium' ? 2 : s === 'low' ? 3 : 4;
  const order = (a, b) => rank(a.severity) - rank(b.severity) || a.package.localeCompare(b.package);
  return { failing: failing.sort(order), other: other.sort(order), unreachable: unreachable.sort(order) };
}

/**
 * One line per alert, in the form a session can act on: what to bump and to what.
 *
 * An alert with NO patched version is called out as such rather than left looking actionable — there
 * is nothing to bump to, so the answer is an override, a replacement or a risk decision, and saying
 * "bump to null" would send a reader hunting for a version that does not exist.
 *
 * @param {AlertRow} row
 * @param {Map<number, { recorded: string }>} [decisions] from `readRecordedDecisions()`; absent = none recorded.
 * @returns {string}
 */
export const DECISIONS_DOC = 'docs/security/open-dependency-alerts.md';

/**
 * THE RECORDED RISK DECISIONS, READ FROM THE DOC THAT HOLDS THEM — pure, so it is testable.
 *
 * 🔴 WHY THIS EXISTS. `describeAlert` used to end every unpatched alert with "needs an override, a
 * replacement, or a recorded risk decision", including ones whose decision was already written down
 * and dated in `open-dependency-alerts.md`. The ship skill reads this check before every merge, so
 * that line is what a session sees at the moment it is deciding whether to merge: on 2026-10-05 one
 * read it, believed three alerts were unjudged, and put the already-answered question to the owner.
 * A demand that stays up after it has been satisfied is the cry-wolf failure the 2026-10-04 fix was
 * itself about, arriving from the other direction.
 *
 * 🔴 IT FAILS CLOSED, like every other grading in this file. A decision is recognised ONLY when a
 * single `###` section positively yields BOTH an alert number and a Decision cell that says
 * "Accepted". Anything else — no number, a decision worded some other way, a section that names two
 * alerts, an unreadable or absent file — records nothing, and the alert keeps its demand. The worst
 * a wrong reading can do is leave the demand up; it can never retire one that was not written.
 *
 * @param {string} markdown contents of `open-dependency-alerts.md`.
 * @returns {Map<number, { recorded: string }>} by ALERT NUMBER, never by GHSA (see `classifyAlerts`).
 */
export function readRecordedDecisions(markdown) {
  const decisions = new Map();
  if (typeof markdown !== 'string' || markdown === '') return decisions;
  for (const section of markdown.split(/^### /m).slice(1)) {
    // Stop at the next heading level so a later section's table cannot be read into this one.
    const body = section.split(/^## /m)[0];
    // Take the Alert CELL first, then every `#N` inside it. Matching `Alert |…#(\d+)` directly finds
    // only the first number, because the `| Alert |` prefix occurs once — so a cell reading
    // "#112 and #111" would look like a decision about #112 alone. Caught by its own case below.
    const cell = body.match(/\|\s*Alert\s*\|([^|\n]*)\|/);
    const numbers = cell ? [...cell[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [];
    // Exactly one, or we cannot say which alert the decision belongs to.
    if (numbers.length !== 1) continue;
    const decision = body.match(/\|\s*\*\*Decision\*\*\s*\|([^|\n]*)\|/);
    if (!decision || !/\bAccepted\b/i.test(decision[1])) continue;
    const recorded = decision[1].match(/\bRecorded\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (!recorded) continue;
    decisions.set(numbers[0], { recorded: recorded[1] });
  }
  return decisions;
}

export function describeAlert(row, decisions) {
  const decided = row.number === null ? undefined : decisions?.get(row.number);
  const fix = row.patchedVersion
    ? // 🔴 A PATCHED VERSION AND A RECORDED DECISION TOGETHER IS A REAL COMBINATION, and until
      // 2026-10-06 the bump instruction swallowed the decision whole. #113 (source-map-js, patched at
      // 1.2.2, in `mobile/package-lock.json`) printed as a bare `bump to 1.2.2` with nothing saying the
      // bump had already been judged and deliberately not taken — so the next session reads an
      // instruction the owner has answered, and the one before it reached for a path the mobile freeze
      // guard refuses. The same cry-wolf shape this file has now corrected three times. Both halves are
      // printed because both are true: the version exists AND somebody decided against taking it here.
      //
      // 🔴 ONLY FOR AN ALERT THAT CANNOT REACH THE GATE. A reachable one keeps the bare bump
      // instruction however recent its decision: a recorded acceptance must never read as a reason to
      // leave something that will turn `validate` red — and through it withhold a production deploy
      // (AGENTS.md §2.3). Fails closed in the same direction as every other grading here.
      row.outOfAuditReach && decided
      ? `bump to ${row.patchedVersion} — but risk ACCEPTED, recorded ${decided.recorded} in ${DECISIONS_DOC}`
      : `bump to ${row.patchedVersion}`
    : decided
      // Not "nothing to do" — the decision is a standing one with its own reversal conditions, and the
      // row names them. This says WHERE it is written so a reader can disagree with it on the evidence.
      ? `no patched version — risk ACCEPTED, recorded ${decided.recorded} in ${DECISIONS_DOC}`
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
 * @param {Map<number, { recorded: string }>} [decisions] recorded risk decisions, by alert number.
 * @returns {{ exitCode: 0|1, errors: string[], notes: string[], failing: AlertRow[], other: AlertRow[], unreachable: AlertRow[] }}
 */
export function judgeAlerts(read, enabled, decisions) {
  const errors = [];
  const notes = [];

  if (read?.skipped) {
    // Exit 0. A reason is not a verdict — see the file header. The second line matters as much as the
    // first: a bare "skipped" reads like a pass to a tired reader at 4am.
    notes.push(`skipped — ${read.skipped}`);
    notes.push('this is not a pass: nothing was read, so nothing was judged.');
    return { exitCode: 0, errors, notes, failing: [], other: [], unreachable: [] };
  }

  const { failing, other, unreachable } = classifyAlerts(read?.alerts);

  if (failing.length === 0 && other.length === 0 && unreachable.length === 0) {
    if (enabled?.enabled === false) {
      // 🔴 The clause the whole file is built around. Zero alerts from a repo that is not looking is
      // not evidence of anything, and reporting it as OK is the false green.
      errors.push(
        'ERROR: zero open alerts, but Dependabot alerts are SWITCHED OFF for this repo, so that zero '
          + 'means nobody is looking — not that nothing is vulnerable. Turn them on in the repository\'s '
          + 'Security settings; until then `pnpm audit` in CI is the first thing that will notice a new '
          + 'advisory, which is the frozen-afternoon case this check exists to prevent.',
      );
      return { exitCode: 1, errors, notes, failing, other, unreachable };
    }
    const how = enabled?.enabled === true
      ? 'and alerts are switched ON, so the zero was looked for'
      : `though ${enabled?.unknown ?? 'whether alerts are switched on could not be read'}`;
    notes.push(`OK — no open alerts (${how}).`);
    return { exitCode: 0, errors, notes, failing, other, unreachable };
  }

  for (const row of failing) errors.push(`WILL FAIL CI: ${describeAlert(row, decisions)}`);
  // Printed, never silent: these are real open alerts and a reader must still see them. What changed
  // is only the verdict attached — they cannot turn `validate` red, so they must not block a merge.
  for (const row of unreachable) {
    notes.push(`open, but CANNOT fail the gate — ${row.outOfAuditReach}: ${describeAlert(row, decisions)}`);
  }
  for (const row of other) notes.push(`below the audit level: ${describeAlert(row, decisions)}`);

  if (failing.length === 0) {
    // 🔴 TWO SENTENCES, BECAUSE ONE OF THEM MUST NOT BE WEAKENED. With no unreachable rows this is
    // the original all-clear, word for word: "none of them HIGH or CRITICAL" is TRUE and worth saying
    // when the only open alerts are moderate and low, and `tests/dependabot-alerts.test.ts` pins it.
    // With unreachable rows that same sentence would be printed directly beneath HIGH lines and would
    // be a lie, so that case gets its own wording and names the reason instead.
    if (unreachable.length === 0) {
      notes.push(
        `OK — ${other.length} open alert(s), none of them HIGH or CRITICAL, so none of them fails `
          + '`--audit-level=high`. Nothing is urgent; bump them with the next dependency PR.',
      );
    } else {
      const also = other.length > 0 ? `, plus ${other.length} below \`--audit-level=high\`` : '';
      notes.push(
        `OK — ${unreachable.length} open HIGH+ alert(s) that the audit cannot reach${also}. Each is `
          + 'listed above with the reason it sits outside the tree `pnpm audit --prod` walks at the '
          + 'root, so none of them can turn `validate` red and none of them blocks a merge. They are '
          + 'still real open alerts: a decision to leave recorded, not a bump to chase — see '
          + 'docs/security/open-dependency-alerts.md.',
      );
    }
    return { exitCode: 0, errors, notes, failing, other, unreachable };
  }

  errors.push(
    `${failing.length} open HIGH+ alert(s). Each one fails \`validate\`'s `
      + '`pnpm audit --audit-level=high --prod` step as soon as the audit feed learns the advisory — '
      + 'which is AFTER the alert appears here, so there is a window and this is it. Bump them in ONE '
      + 'PR (AGENTS.md §6.1), then re-run this. A transitive one needs `pnpm update --depth Infinity '
      + '<pkg>`: `pnpm up` only touches direct dependencies and reports "Already up to date" for the rest.',
  );
  return { exitCode: 1, errors, notes, failing, other, unreachable };
}
