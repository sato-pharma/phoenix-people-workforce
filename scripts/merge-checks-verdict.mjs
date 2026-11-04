#!/usr/bin/env node
// Whether a PR's head commit has passed the checks a merge must wait for — the ONE reading of that,
// shared by bash-guard C21 (a merge on red or pending is refused), C10's green pass-through and the
// roll-up builder.
//
// WHY IT EXISTS (2026-11-04). This repository moved to a personal account on the free plan, and on a
// private repository there `branches/main/protection` answers 403. So GitHub no longer REFUSES a merge
// whose `validate` or `checks` is red or still running — the merge button works on a red PR — and every
// reader here that asked protection for the required names got nothing back:
//   - bash-guard had no clause against merging a red PR at all; it leaned on GitHub for that.
//   - C10's `requiredChecksGreen` returned null, so its green pass-through never fired.
//   - `rollup-prs.mjs` "confirmed nothing green" and judged on every check instead.
// The release gate still holds PRODUCTION on a red `main`, but a red merge holds every LATER merge
// behind it too, silently (docs/deployment.md, "The release gate").
//
// WHERE THE NAMES COME FROM. Live protection when it answers; when it does not, the declaration in
// AGENTS.md §2 (`branch-protected with **N required checks** — `a`, `b``), parsed by
// `required-check-names.mjs` — the same bullet `tests/required-check-names.test.ts` holds against the
// workflows, so the fallback cannot name a job ci.yml does not have. Never a third copy.
//
// For ANOTHER repository with no readable protection there is no declaration to fall back on, so the
// rule is the plain one: nothing may be failing and nothing may still be running. A repository with no
// CI at all (zero check-runs, zero statuses) is allowed — there is nothing to wait for.
'use strict';

/** Conclusions that mean the check did not pass. `skipped` and `neutral` are not failures. */
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/**
 * Apps whose check-runs sit at `queued` for ever on this account and hold nothing (measured on two
 * commits that deployed — `verify-shipped.mjs` says the same). Only their never-started runs are
 * ignored; one that ran and failed still counts.
 */
const FOREVER_QUEUED_APPS = new Set(['sentry', 'claude', 'vercel', 'railway-app']);

/** The newest run per name — a re-run leaves the earlier attempt in the list. */
function latestByName(runs) {
  const byName = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || typeof run.name !== 'string') continue;
    const prev = byName.get(run.name);
    if (!prev || Number(run.id ?? 0) >= Number(prev.id ?? 0)) byName.set(run.name, run);
  }
  return byName;
}

/** One check-run or commit status, reduced to `pass`, `pending` or `fail`. */
function stateOf(entry) {
  if (entry.kind === 'status') {
    if (entry.state === 'success') return 'pass';
    if (entry.state === 'pending') return 'pending';
    return 'fail';
  }
  if (entry.status !== 'completed') return 'pending';
  if (entry.conclusion === 'success' || entry.conclusion === 'skipped' || entry.conclusion === 'neutral') {
    return entry.conclusion === 'success' ? 'pass' : 'skipped';
  }
  return FAILED.has(entry.conclusion) ? 'fail' : 'pending';
}

/**
 * The verdict for one head commit.
 *
 * @param {object} args
 * @param {string[]|null} args.required  the names that must PASS, or null when none are known
 * @param {object[]} args.runs           `commits/<sha>/check-runs` → `.check_runs`
 * @param {object[]} [args.statuses]     `commits/<sha>/status` → `.statuses`
 * @returns {{ ok: boolean, red: string[], pending: string[], missing: string[], judged: string }}
 */
export function mergeChecksVerdict({ required, runs, statuses = [] }) {
  const entries = new Map();
  for (const [name, run] of latestByName(runs)) entries.set(name, { ...run, kind: 'run' });
  for (const s of Array.isArray(statuses) ? statuses : []) {
    if (s && typeof s.context === 'string') entries.set(s.context, { name: s.context, state: s.state, kind: 'status' });
  }

  const red = [];
  const pending = [];
  const missing = [];

  if (Array.isArray(required) && required.length > 0) {
    for (const name of required) {
      const entry = entries.get(name);
      if (!entry) {
        missing.push(name);
        continue;
      }
      const s = stateOf(entry);
      // A REQUIRED check that was skipped did not pass: `checks` skips when `validate` fails.
      if (s === 'fail' || s === 'skipped') red.push(name);
      else if (s === 'pending') pending.push(name);
    }
    return {
      ok: red.length === 0 && pending.length === 0 && missing.length === 0,
      red,
      pending,
      missing,
      judged: `the required checks (${required.join(', ')})`,
    };
  }

  for (const [name, entry] of entries) {
    const s = stateOf(entry);
    if (s === 'fail') red.push(name);
    else if (s === 'pending') {
      const app = String(entry?.app?.slug ?? '');
      if (entry.kind === 'run' && entry.status === 'queued' && FOREVER_QUEUED_APPS.has(app)) continue;
      pending.push(name);
    }
  }
  return {
    ok: red.length === 0 && pending.length === 0,
    red,
    pending,
    missing,
    judged: entries.size === 0 ? 'no checks at all — this repository runs no CI on it' : 'every check on the commit',
  };
}

/** The verdict as a sentence for a refusal — names, never counts. */
export function describeVerdict(verdict) {
  const parts = [];
  if (verdict.red.length > 0) parts.push(`red: ${verdict.red.join(', ')}`);
  if (verdict.pending.length > 0) parts.push(`still running: ${verdict.pending.join(', ')}`);
  if (verdict.missing.length > 0) parts.push(`not reported on this commit yet: ${verdict.missing.join(', ')}`);
  return parts.join(' · ');
}
