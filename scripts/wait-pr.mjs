#!/usr/bin/env node
// Waits for ONE pull request to reach a stated condition, and says which PR it is on every line.
//
// WHY IT EXISTS. `.claude/skills/ship` tells a session to background the wait and report the real
// end. It gives it nothing to background, so every session writes its own — and the failures are not
// crashes, they are confident WRONG ANSWERS:
//
//   * On 2026-09-30 a session generated each wait by `sed`-ing the previous one. The chain drifted and
//     produced a script that called `verify-shipped.mjs 4912` while its log header said it was
//     watching #4923. A wait that reports another PR's verdict reads as an answer, not a mistake.
//   * The same session armed a SETTLE wait on a PR whose checks had already concluded red. It
//     returned the failure instantly, which reads like a verdict on a fresh run when nothing had been
//     re-run at all. Only a new push can change a concluded red.
//   * An earlier one backgrounded a COMPOUND command — `cat` of one PR's finished result plus the
//     arming of another's wait — so both wrote into one log and the SHIPPED line belonged to the
//     wrong PR.
//
// Each of those is the same shape as the false-green and inherited-red bugs AGENTS.md records: a
// signal that cannot say "I did not look at this" gets read as "I looked and it was fine".
//
//   node scripts/wait-pr.mjs 4927                # default (settle): wait for the REQUIRED checks to finish
//   node scripts/wait-pr.mjs 4927 --green        # wait for them to all PASS (keeps waiting through red)
//   node scripts/wait-pr.mjs 4927 --ship         # wait for the production deploy to leave QUEUED
//   node scripts/wait-pr.mjs 4927 --timeout 45   # minutes before giving up loudly (default 30)
//
// Exit codes, so a backgrounded run's notification is readable on its own:
//   0 the condition was reached (or the PR was already merged, for the check modes)
//   3 the checks SETTLED RED   (settle mode only; --green keeps waiting instead)
//   4 the deploy did not ship  (--ship: NOT LIVE / NOT MERGED / CANNOT TELL)
//   5 the PR is CLOSED without merging (check modes) — its checks are frozen at the sha it closed on
//   7 gave up on the timeout
//   9 could not start (bad arguments, or the gate could not be read)
'use strict';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { readProtectionContexts } from './required-check-names.mjs';

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "wait-pr",
  entry: import.meta.url,
  known: ["--ship", "--green", "--timeout"],
});

const REPO = 'Gawish-1997/phoenix-people-workforce';

/**
 * `PHX_WAIT_PR_FIXTURE=<file.json>` replays a scripted sequence of readings instead of calling `gh`.
 *
 * The loop is the whole value of this script and it has to be testable in the required `checks` job,
 * which has no network and no `gh` auth. Shape:
 *
 *   { "required": ["<a-required-check>", "<another>"],
 *     "polls": [ { "mergedAt": null, "state": "OPEN", "head": "abc123def",
 *                  "checks": [{ "name": "<a-required-check>", "bucket": "pending" }] }, … ] }
 *
 * The example uses placeholders on purpose: `tests/wait-pr.test.ts` asserts that no real check name
 * appears anywhere in this file, and a name written into a COMMENT is exactly how a stale list gets
 * copied into code later.
 *
 * Each poll is consumed in order; running out of polls is the same as the timeout expiring, so a test
 * can assert the give-up path without waiting for it. Sleeping is skipped entirely in this mode.
 */
const fixturePath = process.env.PHX_WAIT_PR_FIXTURE;

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
const mode = args.includes('--ship') ? 'ship' : args.includes('--green') ? 'green' : 'settle';
const timeoutMinutes = (() => {
  const i = args.indexOf('--timeout');
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

if (!pr) {
  console.error('[wait-pr] name the pull request: node scripts/wait-pr.mjs <number> [--green|--ship]');
  process.exit(9);
}

/** Every line carries the PR number. A drifted script must not be able to look like a right answer. */
function say(line) {
  console.log(`[wait-pr #${pr}] ${line}`);
}

function gh(argv) {
  try {
    return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------- the gate, read live

/**
 * 🔴 NEVER A LIST FROM A FILE. `main`'s required checks have rotted five times (4 -> 5 -> 6 -> 4 -> 2)
 * and `lint`/`typecheck`/`test` stopped being check NAMES on 2026-09-27 — a wait keyed on a
 * remembered name waits for something that can never report (AGENTS.md §2, §7).
 */
const required = (() => {
  if (fixturePath) return JSON.parse(readFileSync(fixturePath, 'utf8')).required ?? [];
  const live = readProtectionContexts();
  if (live.skipped) {
    console.error(`[wait-pr #${pr}] could not read the gate: ${live.skipped}`);
    process.exit(9);
  }
  return live.contexts;
})();

const polls = fixturePath ? (JSON.parse(readFileSync(fixturePath, 'utf8')).polls ?? []) : null;
let pollIndex = 0;

/** What a required check that has no row at all is shown as — it has not reported, so it is NOT done. */
const ABSENT = 'absent';

/**
 * One row per required context, in the gate's order — and a context that has not reported yet gets a
 * row of its own, bucket `absent`, instead of silently not being there.
 *
 * 🔴 THE HOLE THIS CLOSES (20 Oct 2026, #6194, head e580286fe): the required `checks` job only starts
 * after `static` and the `unit` jobs finish, so for most of a run `gh pr checks` lists NO row for
 * it. Filtering the listing down to the names that exist made "nothing pending among the rows that
 * exist" true, and the script printed GREEN on a head whose `static` was still running while
 * mergeStateStatus was BLOCKED. A name that is not in the listing is an unfinished check, not an
 * absent one. Every row of a name is kept (a re-run can list one twice), so a stale fail is never
 * collapsed away behind a pass.
 */
function requiredRows(checks) {
  return required.flatMap((name) => {
    const rows = checks.filter((c) => c.name === name);
    return rows.length > 0 ? rows : [{ name, bucket: ABSENT }];
  });
}

/** One reading: whether it is merged or closed, its head, and the bucket of each REQUIRED check. */
function read() {
  if (polls) {
    const p = polls[pollIndex++];
    if (!p) return null; // out of scripted readings — treated as the timeout
    return {
      mergedAt: p.mergedAt ?? null,
      state: p.state ?? '',
      head: p.head ?? '',
      buckets: requiredRows(p.checks ?? []),
    };
  }
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', REPO, '--json', 'mergedAt,state,headRefOid']) || '{}');
  const checks = JSON.parse(gh(['pr', 'checks', pr, '--repo', REPO, '--json', 'name,bucket']) || '[]');
  return {
    mergedAt: view.mergedAt ?? null,
    state: view.state ?? '',
    head: view.headRefOid ?? '',
    buckets: requiredRows(checks),
  };
}

function sleep(seconds) {
  if (fixturePath) return; // a test must never wait
  execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${seconds * 1000})`], { stdio: 'ignore' });
}

const summarise = (buckets) => buckets.map((c) => `${c.name}=${c.bucket}`).join(' ');

// ---------------------------------------------------------------------------- the deploy reading

/** `verify-shipped.mjs`'s exit code IS its verdict: 0 shipped · 2 queued · 3/4/5 could not confirm. */
function shipVerdict() {
  if (polls) {
    const p = polls[pollIndex++];
    return p ? (p.ship ?? 2) : null;
  }
  try {
    execFileSync(process.execPath, ['.claude/skills/ship/verify-shipped.mjs', pr], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return 0;
  } catch (err) {
    return typeof err?.status === 'number' ? err.status : 5;
  }
}

// ---------------------------------------------------------------------------- the loop

say(`mode ${mode} · required gate (live): ${required.join(', ') || '(none)'} · giving up after ${timeoutMinutes} min`);

const deadline = Math.max(1, Math.round((timeoutMinutes * 60) / 30));
let last = '';

for (let i = 0; i < deadline; i += 1) {
  if (mode === 'ship') {
    const rc = shipVerdict();
    if (rc === null) break;
    if (rc !== 2) {
      // 6 is SHIPPED-but-main-is-red: it DID ship, and the red is reported separately, so it is not
      // a failure of the wait.
      const ok = rc === 0 || rc === 6;
      say(ok ? `SHIPPED (verify-shipped exit ${rc})` : `NOT CONFIRMED (verify-shipped exit ${rc})`);
      process.exit(ok ? 0 : 4);
    }
    last = 'queued';
    sleep(30);
    continue;
  }

  const r = read();
  if (r === null) break;
  if (r.mergedAt) {
    say(`ALREADY MERGED at ${r.mergedAt}`);
    process.exit(0);
  }
  // 🔴 A CLOSED PR STILL ANSWERS LIKE AN OPEN ONE. Its branch keeps taking pushes, its headRefOid stays
  // frozen at the sha it closed on, and `gh pr checks` keeps listing that sha's finished runs — so
  // `--green` printed "GREEN on <the old sha>" for #5305 (2026-10-04), a PR that had closed unmerged
  // 20 minutes earlier, and it read exactly like a merge-ready verdict on the work just pushed. Checked
  // on EVERY poll, because a roll-up can fold the PR in and close it while the wait is running. A
  // state this script cannot read ('') is not closed: it falls through and keeps waiting.
  if (String(r.state).toUpperCase() === 'CLOSED') {
    say(
      `CLOSED without merging (frozen head ${String(r.head).slice(0, 9)}) — nothing to wait for, and its checks say nothing about any later push. ` +
        'A roll-up may have carried it: read whether main holds its files before treating the work as lost.',
    );
    process.exit(5);
  }
  const state = summarise(r.buckets);
  last = `${state || 'no reading'} on ${String(r.head).slice(0, 9)}`;
  // ALLOW-LIST `pass`, never deny-list the unfinished states (docs/testing.md, "Waiting for the
  // gate"): green is every required row literally `pass`; red is a `fail`; anything else — pending,
  // absent, skipping, cancel, a bucket this script has never heard of, or no required row at all —
  // means keep waiting. Wrong in that direction only ever costs a minute.
  const allPass = r.buckets.length > 0 && r.buckets.every((c) => c.bucket === 'pass');
  const anyFail = r.buckets.some((c) => c.bucket === 'fail');
  const anyUnfinished = r.buckets.length === 0 || r.buckets.some((c) => c.bucket !== 'pass' && c.bucket !== 'fail');

  if (allPass) {
    say(`GREEN on ${String(r.head).slice(0, 9)}: ${state}`);
    process.exit(0);
  }
  if (!anyUnfinished && anyFail && mode === 'settle') {
    // SETTLED RED. Said as its own verdict rather than as a green that happens to be false — and it
    // exits 3, not 0, so a notification reporting the shell's status cannot read as success.
    say(`SETTLED RED on ${String(r.head).slice(0, 9)}: ${state}`);
    process.exit(3);
  }
  // --green keeps waiting through a concluded red, because only a NEW PUSH can change it.
  sleep(30);
}

say(`GAVE UP after ${timeoutMinutes} min — last reading: ${last || 'none'}`);
process.exit(7);
