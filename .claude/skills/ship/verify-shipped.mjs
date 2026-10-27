// Did this PR actually reach production? Reads the four sources that can answer, in one pass, and
// prints a verdict instead of an impression.
//
//   node .claude/skills/ship/verify-shipped.mjs <pr>
//   node .claude/skills/ship/verify-shipped.mjs <pr> --simulate-live <sha>   force the live revision
//   node .claude/skills/ship/verify-shipped.mjs <pr> --json                  machine-readable
//   node .claude/skills/ship/verify-shipped.mjs <pr> --wait [minutes]        re-read until it settles
//
// `--wait` (default 30 minutes, a reading every 90 s) exists because the deploy gate holds a merge
// for the length of main's CI plus the build - about ten minutes - so the first reading is nearly
// always QUEUED. Waiting by hand meant a throwaway loop script each time (three in one session on
// 2026-10-19, one of them blind because Windows quoting stripped its filter), and a poll loop typed
// into the shell is refused by bash-guard. It stops on SHIPPED, SHIPPED BUT MAIN IS RED and NOT
// MERGED, keeps going through QUEUED, NOT LIVE and CANNOT TELL, and on timeout exits with the LAST
// reading's code - so running out of patience is never reported as a pass. Run it with
// run_in_background and act on the notification. Progress lines go to stderr; stdout is the final
// reading alone, so `--json` stays parseable.
//
// Exit codes, so a background run's notification carries the answer:
//   0 SHIPPED   the live revision contains the merge, and main's CI for it is not red
//   2 QUEUED    merged, a production build for it is still in flight
//   3 NOT LIVE  merged, the live revision does not contain it and nothing is building
//   4 NOT MERGED
//   5 CANNOT TELL   a source did not answer (say which; never guess)
//   6 SHIPPED, BUT MAIN IS RED
//
// Why each source is read the way it is:
//   * The live `revision` is the running commit sha - `status: ok` only proves a container is up.
//   * Ancestry, never equality: sessions here merge every few minutes, so a live revision NEWER
//     than this merge is success. An equality test reads that as a miss.
//   * Deployment STATES, never their timestamps: Railway stamps the GitHub deployment when a build
//     goes live, so the earlier commit can carry the later created_at and serve while the newer one
//     is still in_progress. One in_progress beside one success is a queue, not a revert.
//   * main's own CI run is the only place a red main shows - it builds, ships and serves anyway.
//   * A WITHHELD deploy is NOT always a red ci.yml: the gate waits on every check suite on the
//     commit, so a scheduled workflow that merely landed on that sha can withhold it while
//     ci.yml reads fully green (measured 2026-09-27, cd9e0be03). When a deploy is withheld this
//     names the suites that were bad, because the CI line alone will look innocent.

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'it-gawish-hr/phoenix-people-workforce';
const HEALTHZ = 'https://phoenix-hr.satopharma.com/api/healthz';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Every git question below is asked in a folder. Normally that is this script's own, which sits in
// the repository - but a copy pulled out with `git show` and run from a scratchpad has no
// repository under it, so EVERY git call there fails. That used to surface as "one of the two
// commits is not in this clone", which blames the clone for a missing folder and sent a session
// hunting a fetch race that did not exist (measured 2026-09-17). So: try this script's folder, then
// the caller's, and if neither is a checkout say exactly that.
function findGitAnchor() {
  for (const dir of [HERE, process.cwd()]) {
    try {
      execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
      return dir;
    } catch {
      /* not a checkout - try the next */
    }
  }
  return null;
}
const ANCHOR = findGitAnchor();

// The PR number is the first all-digit argument - which `--wait 45` and a digits-only
// `--simulate-live` value would otherwise steal. Pure, so the selftest covers each spelling.
// `waitMinutes` is null when `--wait` is absent, 30 when it has no number, else the number.
export function parseArgs(args) {
  const waitAt = args.indexOf('--wait');
  const waitValueAt = waitAt >= 0 && /^\d+$/.test(args[waitAt + 1] || '') ? waitAt + 1 : -1;
  const simAt = args.indexOf('--simulate-live');
  const pr = (
    args.find((a, i) => /^\d+$/.test(a) && i !== waitValueAt && !(simAt >= 0 && i === simAt + 1)) || ''
  ).trim();
  const waitMinutes = waitAt < 0 ? null : waitValueAt >= 0 ? Number(args[waitValueAt]) : 30;
  return { pr, waitMinutes, waitValueAt };
}

// What each exit code means, for the one-line progress a `--wait` run prints per reading.
export const VERDICT_BY_CODE = {
  0: 'SHIPPED',
  2: 'QUEUED',
  3: 'NOT LIVE',
  4: 'NOT MERGED',
  5: 'CANNOT TELL',
  6: 'SHIPPED, BUT MAIN IS RED',
};

// Whether a `--wait` run stops after this reading. A verdict that waiting cannot change ends it
// (SHIPPED, SHIPPED BUT MAIN IS RED, NOT MERGED); QUEUED, NOT LIVE and CANNOT TELL are all states
// the next reading can improve, so they run on until the limit. The clock never overrides a settled
// verdict, and an exit code that is not one of ours is the verifier itself crashing - retried twice,
// then given up on, so a broken `gh` does not eat thirty minutes.
const WAIT_SETTLED = new Set([0, 4, 6]);
export function waitStep({ code, elapsedMs, maxMs, crashes = 0 }) {
  if (WAIT_SETTLED.has(code)) return { done: true, why: 'settled' };
  if (!(code in VERDICT_BY_CODE) && crashes >= 3)
    return { done: true, why: 'the verifier itself failed three readings in a row' };
  if (elapsedMs >= maxMs) return { done: true, why: 'timed out' };
  return { done: false, why: '' };
}

const argv = process.argv.slice(2);
const { pr, waitMinutes, waitValueAt } = parseArgs(argv);
const asJson = argv.includes('--json');
const simulateLive = argv.includes('--simulate-live') ? argv[argv.indexOf('--simulate-live') + 1] || null : null;

const cairo = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false }).replace(',', '') + ' Cairo'
    : '-';

// WHY a withheld deploy needs CLASSIFYING rather than announcing. `WITHHELD` is two causes that
// look identical in GitHub's vocabulary, and only one is a problem:
//   * a FAILED or CANCELLED suite on the commit — the gate refused it. That is the real failure, and
//     it is not always ci.yml: a SCHEDULED workflow attaches its suite to whatever commit is main
//     HEAD when it fires, so any flaky cron here can withhold a deploy (2026-09-27, cd9e0be03).
//   * every suite green — it was SUPERSEDED before its build started, because a newer merge landed
//     while it waited for CI (2026-09-28, 047a33388: one `inactive` status, no `in_progress`, and the
//     commit was inside what was serving). Benign, and needs no action.
// The four third-party app suites (sentry, claude, vercel, railway-app) sit at `queued` FOREVER on
// every commit and hold nothing — measured on two commits that deployed `success` — so `queued` must
// not count as bad or every withheld deploy would read as refused.
// Pure, and exported, so `--selftest` covers it without a network: the live refused case can age out
// of the deployment window the report reads, which is exactly how it went unverified once already.
export function classifyWithheld({ suites, hasNewerDeploy = false }) {
  if (!suites || !Array.isArray(suites.check_suites)) {
    return { refusedByGate: undefined, bad: [], why: 'its check suites could not be read, so the cause is unknown' };
  }
  const BAD = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'];
  const bad = suites.check_suites.filter((x) => BAD.includes(x.conclusion));
  if (bad.length) return { refusedByGate: true, bad, why: 'the gate refused it' };
  return {
    refusedByGate: false,
    bad: [],
    why: hasNewerDeploy
      ? 'a newer merge superseded it while it waited for CI, so this build never started'
      : 'no failing suite and no newer deploy found; read railway deployment list directly',
  };
}

// 🔴 "NEVER SUCCEEDED" IS NOT ENOUGH TO CALL A DEPLOY WITHHELD, AND THIS FUNCTION EXISTS BECAUSE
// THE ONE-LINE TEST IT REPLACES WOULD HAVE BLAMED THE GATE FOR A DEPLOY THAT SHIPPED.
// The old test was: newest status `inactive` AND no `success` anywhere. It was written from the
// 2026-09-27 pair, where that shape genuinely did mean Railway SKIPPED the build. But a deployment
// row can also simply never post a terminal status at all — measured 2026-09-28 on production
// deployment 6712985148 (merge 91774f5f3), whose ONLY status was `in_progress` while
// /api/healthz served that exact revision for the next hour; staging's twin row posted `success`
// 44 seconds after creation, so this is GitHub's row going quiet, not a build still running. The
// moment any later deploy supersedes such a row, GitHub appends `inactive` and it matches the old
// test EXACTLY — so this script would have printed WITHHELD and named the deploy gate as the cause
// on a commit that was demonstrably live. Same defect as its sibling above had: a classifier
// certain about a mechanism it never checked.
//
// The discriminator that survives is NOT in the status history at all — it is whether the commit is
// inside what production is SERVING. And it fails to UNKNOWN, never to `withheld`: a false WITHHELD
// sends a reader to `railway redeploy`, which AGENTS.md §2.3 forbids and which cannot help anyway,
// because the next green merge carries a skipped deploy forward by itself.
//
// `inLive` is deliberately THREE-VALUED: true, false, or undefined for "could not be established".
// Do not collapse it to a boolean — `git merge-base --is-ancestor` answers false both for "not an
// ancestor" and for "that commit is not in this clone", and reading the second as the first is
// exactly how a shallow or stale checkout would manufacture a production alarm out of nothing.
export function classifyDeployRow({ statuses, inLive }) {
  if (!Array.isArray(statuses)) return { state: null, withheld: false, label: '?', note: 'statuses unreadable' };
  const state = statuses.length ? statuses[0].state : null;
  const neverSucceeded = !statuses.some((s) => s.state === 'success');

  // The shape the old one-liner keyed on. Necessary, and on its own not sufficient.
  if (!!state && state === 'inactive' && neverSucceeded) {
    if (inLive === true)
      return { state, withheld: false, label: 'CARRIED',
        note: 'never deployed on its own, but its commit IS in the serving code — a later merge carried it forward; do NOT redeploy' };
    if (inLive === false)
      return { state, withheld: true, label: 'WITHHELD',
        note: 'never succeeded and NOT in the serving code — Railway SKIPPED it' };
    return { state, withheld: false, label: 'inactive?',
      note: 'never succeeded, but ancestry could not be established — NOT called withheld; read `railway deployment list` to settle it' };
  }

  // A row that is still non-terminal on a commit already serving is the 6712985148 case itself.
  // Printing a bare `in_progress` for it reads as "building, wait a minute", an hour after it went
  // live, so it is named rather than left to look in-flight.
  if (neverSucceeded && inLive === true && state && state !== 'inactive')
    return { state, withheld: false, label: state,
      note: 'already in the serving revision — this row never posted a terminal status' };

  return { state, withheld: false, label: state || '?', note: '' };
}

// The verdict is one pure function of four facts, so it can be tested without touching GitHub and
// so a change to it cannot quietly come to mean something else. `--selftest` runs the table below.
export function decide({ state, mergeSha, contains, building, mainRed }) {
  if (state !== 'MERGED' || !mergeSha)
    return { verdict: 'NOT MERGED', code: 4, why: `the PR is ${state}${mergeSha ? '' : ' and carries no merge commit'}` };
  if (contains === true)
    return mainRed
      ? { verdict: 'SHIPPED, BUT MAIN IS RED', code: 6, why: "live and serving, but main's own run for it did not conclude success - a red main ships anyway" }
      : { verdict: 'SHIPPED', code: 0, why: 'the live revision contains this merge' };
  if (contains === false && building)
    return { verdict: 'QUEUED', code: 2, why: 'merged, and a production build is still in flight - do NOT re-merge or redeploy, read it again in a minute' };
  if (contains === false)
    return { verdict: 'NOT LIVE', code: 3, why: 'merged, but the live revision does not contain it and no build is in flight' };
  return { verdict: 'CANNOT TELL', code: 5, why: 'a source did not answer - see the notes; do not act as if it shipped' };
}

// Ancestry has FOUR ways of saying "no", and they are not the same thing: there is no live
// revision, this folder is not a checkout, the fetch failed, or the commit is genuinely absent.
// Collapsing them into one note is what made a working verifier read CANNOT TELL and blame a
// missing commit. The clone is also routinely minutes behind production - so when a commit is
// missing, fetch and ASK AGAIN before giving up. Primitives are injected so `--selftest` drives
// every branch with no network and no clone.
export async function resolveContains({
  live,
  mergeSha,
  anchor,
  have,
  fetchMain,
  isAncestor,
  sleep = () => Promise.resolve(),
  attempts = 2,
}) {
  const notes = [];
  if (!live) return { contains: null, notes, fetches: 0 };
  if (live === mergeSha) return { contains: true, notes, fetches: 0 };
  if (!anchor) {
    notes.push(
      'ancestry needs a git checkout and this copy of the script is not inside one - run the copy that lives in the repository',
    );
    return { contains: null, notes, fetches: 0 };
  }

  let fetches = 0;
  let present = await have();
  for (let attempt = 1; !present && attempt <= attempts; attempt++) {
    if (!(await fetchMain())) notes.push(`\`git fetch origin main\` failed on attempt ${attempt} - this clone may be stale`);
    fetches += 1;
    present = await have();
    if (!present && attempt < attempts) await sleep();
  }

  if (!present) {
    notes.push(
      `the merge commit or the live revision is still missing from this clone after ${fetches} fetch(es) - ancestry not checked`,
    );
    return { contains: null, notes, fetches };
  }
  return { contains: await isAncestor(), notes, fetches };
}

if (argv.includes('--selftest')) {
  const CASES = [
    ['an open PR', { state: 'OPEN', mergeSha: null, contains: null, building: false, mainRed: false }, 'NOT MERGED'],
    ['merged but no merge commit', { state: 'MERGED', mergeSha: null, contains: null, building: false, mainRed: false }, 'NOT MERGED'],
    ['the live revision contains it', { state: 'MERGED', mergeSha: 'a', contains: true, building: false, mainRed: false }, 'SHIPPED'],
    ['live, and main went red', { state: 'MERGED', mergeSha: 'a', contains: true, building: false, mainRed: true }, 'SHIPPED, BUT MAIN IS RED'],
    ['not live, a build in flight', { state: 'MERGED', mergeSha: 'a', contains: false, building: true, mainRed: false }, 'QUEUED'],
    ['not live, nothing building', { state: 'MERGED', mergeSha: 'a', contains: false, building: false, mainRed: false }, 'NOT LIVE'],
    ['ancestry unknown', { state: 'MERGED', mergeSha: 'a', contains: null, building: false, mainRed: false }, 'CANNOT TELL'],
    ['ancestry unknown while building', { state: 'MERGED', mergeSha: 'a', contains: null, building: true, mainRed: false }, 'CANNOT TELL'],
    ['a build in flight never overrides a live hit', { state: 'MERGED', mergeSha: 'a', contains: true, building: true, mainRed: false }, 'SHIPPED'],
  ];
  let failed = 0;
  for (const [name, facts, want] of CASES) {
    const got = decide(facts).verdict;
    if (got !== want) failed++;
    console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name}  expected=${want} got=${got}`);
  }

  // The ancestry resolver. Its four ways of saying "no" have to stay four DIFFERENT answers - one
  // of them reading as another is the defect this table exists for - and a missing commit has to
  // survive a fetch and a re-ask before it counts. Fakes, so there is no clone and no network here.
  const seq = (values, fallback) => {
    let i = 0;
    return () => (i < values.length ? values[i++] : fallback);
  };
  const ANC = [
    ['the live revision IS the merge - no git asked at all',
      { live: 'a', mergeSha: 'a' },
      { contains: true, fetches: 0, notes: 0 }],
    ['no live revision to compare against',
      { live: null, mergeSha: 'a' },
      { contains: null, fetches: 0, notes: 0 }],
    ['not inside a git checkout - says THAT, never blames a missing commit',
      { live: 'b', mergeSha: 'a', anchor: null, have: () => false, fetchMain: () => true, isAncestor: () => true },
      { contains: null, fetches: 0, notes: 1, note: /not inside one/ }],
    ['both commits already local - no fetch at all',
      { live: 'b', mergeSha: 'a', anchor: 'x', have: () => true, fetchMain: () => true, isAncestor: () => true },
      { contains: true, fetches: 0, notes: 0 }],
    ['one fetch brings the live commit in',
      { live: 'b', mergeSha: 'a', anchor: 'x', have: seq([false], true), fetchMain: () => true, isAncestor: () => true },
      { contains: true, fetches: 1, notes: 0 }],
    ['the first fetch fails, the second works - the failure is named and the answer still lands',
      { live: 'b', mergeSha: 'a', anchor: 'x', have: seq([false, false], true), fetchMain: seq([false], true), isAncestor: () => true },
      { contains: true, fetches: 2, notes: 1, note: /failed on attempt 1/ }],
    ['still missing after the retry - unknown, and it says how many fetches it took',
      { live: 'b', mergeSha: 'a', anchor: 'x', have: () => false, fetchMain: () => true, isAncestor: () => true },
      { contains: null, fetches: 2, notes: 1, note: /still missing from this clone after 2 fetch/ }],
    ['a live revision that does NOT contain the merge reads no, not unknown',
      { live: 'b', mergeSha: 'a', anchor: 'x', have: () => true, fetchMain: () => true, isAncestor: () => false },
      { contains: false, fetches: 0, notes: 0 }],
  ];
  for (const [name, opts, want] of ANC) {
    const r = await resolveContains(opts);
    const bad = [];
    if (r.contains !== want.contains) bad.push(`contains expected=${want.contains} got=${r.contains}`);
    if (r.fetches !== want.fetches) bad.push(`fetches expected=${want.fetches} got=${r.fetches}`);
    if (r.notes.length !== want.notes) bad.push(`notes expected=${want.notes} got=${r.notes.length} [${r.notes.join(' | ')}]`);
    if (want.note && !r.notes.some((n) => want.note.test(n))) bad.push(`no note matching ${want.note}`);
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ancestry: ${name}${bad.length ? '  ->  ' + bad.join('; ') : ''}`);
  }

  // The withheld classification. Its two answers must stay two DIFFERENT answers: calling a
  // superseded deploy "refused" sends a reader hunting a failed suite that does not exist, and
  // calling a refused one "superseded" hides a commit that is merged, green and not serving.
  const suite = (slug, conclusion) => ({ app: { slug }, conclusion });
  const QUEUED_APPS = [suite('sentry', null), suite('claude', null), suite('vercel', null), suite('railway-app', null)];
  const WH = [
    ['a failing Actions suite is the gate refusing it',
      { suites: { check_suites: [...QUEUED_APPS, suite('github-actions', 'success'), suite('github-actions', 'failure')] }, hasNewerDeploy: true },
      { refusedByGate: true, bad: 1 }],
    ['a CANCELLED suite counts as refused too',
      { suites: { check_suites: [suite('github-actions', 'cancelled')] } },
      { refusedByGate: true, bad: 1 }],
    ['every suite green plus a newer deploy is SUPERSEDED, not refused',
      { suites: { check_suites: [...QUEUED_APPS, suite('github-actions', 'success')] }, hasNewerDeploy: true },
      { refusedByGate: false, bad: 0, why: /superseded it while it waited/ }],
    ['the four permanently-queued app suites alone are NOT bad',
      { suites: { check_suites: QUEUED_APPS }, hasNewerDeploy: true },
      { refusedByGate: false, bad: 0 }],
    ['green with NO newer deploy says read railway directly rather than guessing',
      { suites: { check_suites: [suite('github-actions', 'success')] }, hasNewerDeploy: false },
      { refusedByGate: false, bad: 0, why: /read railway deployment list directly/ }],
    // The DEFAULT, omitted on purpose. Without this case the `hasNewerDeploy = false` default is
    // never exercised — breaking it left the selftest green, which is the dead-assertion shape that
    // hid one in tests/next-build-cpu-cap.test.ts on 2026-09-27. Caught here by breaking it.
    ['with hasNewerDeploy OMITTED it must default to false, not assume a supersession',
      { suites: { check_suites: [suite('github-actions', 'success')] } },
      { refusedByGate: false, bad: 0, why: /read railway deployment list directly/ }],
    ['unreadable suites are UNKNOWN, never "refused" and never "superseded"',
      { suites: null },
      { refusedByGate: undefined, bad: 0, why: /could not be read/ }],
  ];
  for (const [name, input, want] of WH) {
    const r = classifyWithheld(input);
    const bad = [];
    if (r.refusedByGate !== want.refusedByGate) bad.push(`refusedByGate expected=${want.refusedByGate} got=${r.refusedByGate}`);
    if (r.bad.length !== want.bad) bad.push(`bad expected=${want.bad} got=${r.bad.length}`);
    if (want.why && !want.why.test(r.why)) bad.push(`why did not match ${want.why} (got "${r.why}")`);
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  withheld: ${name}${bad.length ? '  ->  ' + bad.join('; ') : ''}`);
  }

  // Per-deployment-row classification. The invariant worth stating plainly, because every case
  // below is one way of breaking it: WITHHELD is an accusation that a deploy never happened, so it
  // is only ever printed when BOTH halves are established — no success in the history, AND the
  // commit provably absent from what is serving. Unknown ancestry prints no accusation at all.
  const st = (state) => ({ state });
  const SKIPPED_SHAPE = [st('inactive'), st('in_progress')];
  const DR = [
    ['the real 2026-09-27 shape — never succeeded and NOT serving — is still WITHHELD',
      { statuses: SKIPPED_SHAPE, inLive: false }, { withheld: true, label: 'WITHHELD', note: /SKIPPED/ }],
    ['the SAME status history is NOT withheld when the commit IS serving',
      { statuses: SKIPPED_SHAPE, inLive: true }, { withheld: false, label: 'CARRIED', note: /do NOT redeploy/ }],
    ['ancestry UNKNOWN never prints the accusation',
      { statuses: SKIPPED_SHAPE, inLive: undefined }, { withheld: false, label: 'inactive?', note: /could not be established/ }],
    // The row that produced this whole function: deployment 6712985148, whose only status was
    // `in_progress` while healthz served that revision for an hour. Bare `in_progress` reads as
    // "building, look again in a minute", which is what sent a session to re-check a live deploy.
    ['a non-terminal row on a commit already serving says so instead of looking in-flight',
      { statuses: [st('in_progress')], inLive: true }, { withheld: false, label: 'in_progress', note: /never posted a terminal status/ }],
    ['an ordinary superseded row (success then inactive) is not withheld and carries no note',
      { statuses: [st('inactive'), st('success')], inLive: false }, { withheld: false, label: 'inactive', note: /^$/ }],
    ['a serving row is plain success',
      { statuses: [st('success')], inLive: true }, { withheld: false, label: 'success', note: /^$/ }],
    ['unreadable statuses are never an accusation',
      { statuses: null, inLive: false }, { withheld: false, label: '?', note: /unreadable/ }],
    // `inLive` must stay three-valued. If it is ever collapsed to a boolean, `undefined` becomes
    // falsy, this case starts returning WITHHELD, and the alarm is back — silently.
    ['an EMPTY status list is not withheld, whatever ancestry says',
      { statuses: [], inLive: false }, { withheld: false, label: '?', note: /^$/ }],
  ];
  for (const [name, input, want] of DR) {
    const r = classifyDeployRow(input);
    const bad = [];
    if (r.withheld !== want.withheld) bad.push(`withheld expected=${want.withheld} got=${r.withheld}`);
    if (r.label !== want.label) bad.push(`label expected=${want.label} got=${r.label}`);
    if (want.note && !want.note.test(r.note || '')) bad.push(`note did not match ${want.note} (got "${r.note}")`);
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  deploy row: ${name}${bad.length ? '  ->  ' + bad.join('; ') : ''}`);
  }

  // `--wait`. The stop rule is the whole feature: stopping on a verdict that is not final reports a
  // build still in flight as the end, and running past SHIPPED wastes the half hour this exists to
  // save. The clock must also never turn a timeout into a pass - the limit case pins the reason.
  const MAXM = 30 * 60 * 1000;
  const WAIT = [
    ['wait: a settled verdict stops at once - SHIPPED',
      () => waitStep({ code: 0, elapsedMs: 0, maxMs: MAXM }), { done: true, why: 'settled' }],
    ['wait: SHIPPED BUT MAIN IS RED also stops - waiting cannot un-red it',
      () => waitStep({ code: 6, elapsedMs: 1000, maxMs: MAXM }), { done: true, why: 'settled' }],
    ['wait: NOT MERGED stops - a PR that is not merged will not become live by waiting',
      () => waitStep({ code: 4, elapsedMs: 1000, maxMs: MAXM }), { done: true, why: 'settled' }],
    ['wait: QUEUED keeps waiting',
      () => waitStep({ code: 2, elapsedMs: 90000, maxMs: MAXM }), { done: false, why: '' }],
    ['wait: NOT LIVE keeps waiting - the build row can appear late',
      () => waitStep({ code: 3, elapsedMs: 90000, maxMs: MAXM }), { done: false, why: '' }],
    ['wait: CANNOT TELL keeps waiting - a source may answer on the next reading',
      () => waitStep({ code: 5, elapsedMs: 90000, maxMs: MAXM }), { done: false, why: '' }],
    ['wait: at the limit it stops and says TIMED OUT, never settled',
      () => waitStep({ code: 2, elapsedMs: MAXM, maxMs: MAXM }), { done: true, why: 'timed out' }],
    ['wait: a settled verdict wins over the clock',
      () => waitStep({ code: 0, elapsedMs: MAXM * 2, maxMs: MAXM }), { done: true, why: 'settled' }],
    ['wait: an exit code that is not ours is the verifier crashing - retried at first',
      () => waitStep({ code: 1, elapsedMs: 1000, maxMs: MAXM, crashes: 1 }), { done: false, why: '' }],
    ['wait: three crashes in a row stop it, naming the verifier and not the PR',
      () => waitStep({ code: 1, elapsedMs: 1000, maxMs: MAXM, crashes: 3 }), { done: true, why: /verifier itself failed/ }],
    ['args: --wait with no number waits 30 minutes and still finds the PR',
      () => parseArgs(['6098', '--wait']), { pr: '6098', waitMinutes: 30 }],
    ['args: the number after --wait is minutes, never the PR',
      () => parseArgs(['--wait', '45', '6098']), { pr: '6098', waitMinutes: 45 }],
    ['args: no --wait means no waiting at all',
      () => parseArgs(['6098']), { pr: '6098', waitMinutes: null }],
    ['args: a digits-only --simulate-live value is not the PR',
      () => parseArgs(['6098', '--simulate-live', '1234567']), { pr: '6098', waitMinutes: null }],
    ['args: --wait followed by a word is the default, and the PR is still found',
      () => parseArgs(['--wait', 'soon', '6098']), { pr: '6098', waitMinutes: 30 }],
    ['args: every exit code the verifier can return has a progress label',
      () => ({ labelled: [0, 2, 3, 4, 5, 6].every((c) => typeof VERDICT_BY_CODE[c] === 'string') }), { labelled: true }],
  ];
  for (const [name, run, want] of WAIT) {
    const got = run();
    const bad = [];
    for (const [key, expected] of Object.entries(want)) {
      const ok = expected instanceof RegExp ? expected.test(String(got[key])) : got[key] === expected;
      if (!ok) bad.push(`${key} expected=${expected} got=${got[key]}`);
    }
    if (bad.length) failed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${name}${bad.length ? '  ->  ' + bad.join('; ') : ''}`);
  }

  console.log(`\nSELFTEST verify-shipped: ${CASES.length + ANC.length + WH.length + DR.length + WAIT.length} cases, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (!pr) {
  console.error('usage: node verify-shipped.mjs <pr number> [--wait [minutes]] [--simulate-live <sha>] [--json] [--selftest]');
  process.exit(64);
}

// `--wait`: run this same script again and again as a child - each reading is a whole fresh run,
// because the script ends in process.exit() - until waitStep says stop. See the header for why.
if (waitMinutes !== null) {
  const WAIT_EVERY_MS = 90 * 1000;
  const childArgs = argv.filter((a, i) => a !== '--wait' && i !== waitValueAt);
  const clock = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour12: false });
  const started = Date.now();
  console.error(`waiting for PR #${pr} to settle - up to ${waitMinutes} min, one reading every ${WAIT_EVERY_MS / 1000} s`);
  let crashes = 0;
  let last;
  let step;
  for (;;) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180 * 1000,
    });
    const code = typeof run.status === 'number' ? run.status : 1;
    crashes = code in VERDICT_BY_CODE ? 0 : crashes + 1;
    last = { code, stdout: run.stdout || '', stderr: run.stderr || '' };
    step = waitStep({ code, elapsedMs: Date.now() - started, maxMs: waitMinutes * 60 * 1000, crashes });
    console.error(`[${clock()} Cairo] ${VERDICT_BY_CODE[code] || `exit ${code}`}`);
    if (step.done) break;
    await new Promise((r) => setTimeout(r, WAIT_EVERY_MS));
  }
  process.stdout.write(last.stdout);
  if (last.stderr) process.stderr.write(last.stderr);
  if (step.why !== 'settled') console.error(`stopped waiting: ${step.why} - the last reading above stands, and it is NOT a pass`);
  process.exit(last.code);
}

// gh may be gh.exe or a .cmd shim depending on how it was installed; try each before giving up.
function gh(args) {
  let lastErr;
  for (const bin of ['gh', 'gh.exe', 'gh.cmd']) {
    try {
      return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      lastErr = e;
      if (e.code !== 'ENOENT') throw new Error(`gh ${args.join(' ')} failed: ${String(e.stderr || e.message).trim()}`);
    }
  }
  throw new Error(`the GitHub CLI could not be run: ${String(lastErr && lastErr.message).trim()}`);
}
const ghJson = (args) => JSON.parse(gh(args) || 'null');

function git(args, { quiet = false } = {}) {
  if (!ANCHOR) {
    if (quiet) return null;
    throw new Error('no git checkout to ask in');
  }
  try {
    return execFileSync('git', ['-C', ANCHOR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] }).trim();
  } catch (e) {
    if (quiet) return null;
    throw e;
  }
}
const gitOk = (args) => git(args, { quiet: true }) !== null;

const out = { pr: Number(pr), notes: [] };

// 1 - the PR itself. `state` is the field; there is no `merged` field on `gh pr view`.
const view = ghJson(['pr', 'view', pr, '--repo', REPO, '--json', 'number,title,state,mergedAt,mergeCommit,headRefName,baseRefName']);
out.title = view.title;
out.state = view.state;
out.base = view.baseRefName;
out.head = view.headRefName;
out.mergedAt = view.mergedAt || null;
out.mergeSha = view.mergeCommit ? view.mergeCommit.oid : null;

if (out.state !== 'MERGED' || !out.mergeSha) {
  const d = decide({ state: out.state, mergeSha: out.mergeSha, contains: null, building: false, mainRed: false });
  report(d.verdict, d.code, d.why);
}

// 2 - what is actually serving production
let live = simulateLive;
if (simulateLive) out.notes.push(`live revision forced to ${simulateLive} by --simulate-live`);
else {
  try {
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
    const res = await fetch(HEALTHZ, { signal: ctl, headers: { 'cache-control': 'no-store' } });
    const body = await res.json();
    live = body.revision || null;
    out.healthz = { status: body.status, service: body.service, time: cairo(body.time) };
    if (!live) out.notes.push('healthz answered with no revision - the platform variable is missing, not the deploy');
  } catch (e) {
    out.notes.push(`the production domain did not answer: ${String(e.message || e).trim()}`);
  }
}
out.liveRevision = live || null;

// 3 - is the merge contained in what is live? ancestry, and only after a fetch, since this clone
// is usually behind by minutes.
const ancestry = await resolveContains({
  live,
  mergeSha: out.mergeSha,
  anchor: ANCHOR,
  have: () =>
    gitOk(['cat-file', '-e', `${out.mergeSha}^{commit}`]) && gitOk(['cat-file', '-e', `${live}^{commit}`]),
  fetchMain: () => git(['fetch', 'origin', 'main', '--quiet'], { quiet: true }) !== null,
  isAncestor: () => gitOk(['merge-base', '--is-ancestor', out.mergeSha, live]),
  sleep: () => new Promise((r) => setTimeout(r, 3000)),
});
const contains = ancestry.contains;
for (const n of ancestry.notes) out.notes.push(n);
out.liveContainsMerge = contains;

// 4 - deployments: the rows for production, newest first, with their real STATES
const deployments = ghJson(['api', `repos/${REPO}/deployments`, '--paginate=false']) || [];
const prod = deployments.filter((d) => String(d.environment || '').includes('production')).slice(0, 5);
out.deployments = [];
for (const d of prod) {
  let state = null;
  let withheld = false;
  let label = '?';
  let note = '';
  try {
    const statuses = ghJson(['api', `repos/${REPO}/deployments/${d.id}/statuses`]) || [];
    // 🔴 AN `inactive` THAT WAS NEVER `success` IS A DEPLOY THAT NEVER HAPPENED — *IF* ITS COMMIT IS
    // ALSO ABSENT FROM WHAT IS SERVING. Railway calls that SKIPPED; GitHub only ever says `inactive`,
    // which this script once printed as "normal and not a failure", so a withheld deploy read as
    // healthy. Measured 2026-09-27: two merges 86 seconds apart went `in_progress` -> `inactive` with
    // no `success` between them, `railway deployment list` showed SKIPPED for both, and production
    // stayed on an older commit even after main's CI was re-run GREEN on the same sha.
    // The ancestry half was added 2026-09-28 — see classifyDeployRow for the row that proved the
    // status history alone cannot carry this. Ancestry is established here and NOT inferred: a
    // commit missing from this clone must leave `inLive` undefined, never false, because gitOk
    // cannot tell "not an ancestor" from "not here" and the second must never print an alarm.
    let inLive;
    if (live && gitOk(['cat-file', '-e', `${d.sha}^{commit}`]) && gitOk(['cat-file', '-e', `${live}^{commit}`]))
      inLive = gitOk(['merge-base', '--is-ancestor', d.sha, live]);
    ({ state, withheld, label, note } = classifyDeployRow({ statuses, inLive }));
  } catch (e) {
    out.notes.push(`deployment ${d.id} statuses unreadable: ${String(e.message).trim()}`);
  }
  out.deployments.push({ id: d.id, sha: d.sha, short: String(d.sha).slice(0, 9), created: cairo(d.created_at), state, withheld, label, note, isThisMerge: d.sha === out.mergeSha });
}
const mine = out.deployments.find((d) => d.isThisMerge) || null;
const building = out.deployments.some((d) => ['in_progress', 'queued', 'pending'].includes(d.state));

// 5 - main's own CI verdict for THIS commit. Asked by sha, not by scanning `gh run list`: that list
// is eventually consistent and dropped a run that existed (measured 2026-09-17), which would have
// read as "main has no verdict" on a commit that had passed. `event: push` keeps it to main's own
// run rather than the PR's.
let mainRun = null;
try {
  const runs = ghJson(['api', `repos/${REPO}/actions/runs?head_sha=${out.mergeSha}&per_page=30`]);
  const ci = ((runs && runs.workflow_runs) || []).filter((r) => r.path === '.github/workflows/ci.yml' && r.event === 'push');
  mainRun = ci[0] || null;
  if (!mainRun) out.notes.push("GitHub lists no CI run on main for this commit yet - it starts within seconds of the merge, so read it again rather than reading main as green");
} catch (e) {
  out.notes.push(`main's CI runs unreadable: ${String(e.message).trim()}`);
}
out.mainCi = mainRun ? { status: mainRun.status, conclusion: mainRun.conclusion || null, at: cairo(mainRun.created_at), url: mainRun.html_url } : null;
const mainRed = !!(mainRun && mainRun.status === 'completed' && mainRun.conclusion && mainRun.conclusion !== 'success');

const d = decide({
  state: out.state,
  mergeSha: out.mergeSha,
  contains,
  building: building || !!(mine && ['in_progress', 'queued', 'pending'].includes(mine.state)),
  mainRed,
});
report(d.verdict, d.code, d.why);

function report(verdict, code, why) {
  out.verdict = verdict;
  out.why = why;
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(code);
  }
  const L = [];
  L.push(`PR #${out.pr} · ${out.title || '(no title)'}`);
  L.push(`  state          ${out.state}${out.mergedAt ? `  merged ${cairo(out.mergedAt)}` : ''}`);
  if (out.mergeSha) L.push(`  merge commit   ${out.mergeSha}`);
  if (out.head) L.push(`  branch         ${out.head} -> ${out.base}`);
  if (out.liveRevision !== undefined) L.push(`  live revision  ${out.liveRevision || '(unreadable)'}${out.healthz ? `  (${out.healthz.status}, ${out.healthz.time})` : ''}`);
  if (out.liveContainsMerge !== null && out.liveContainsMerge !== undefined)
    L.push(`  contains it    ${out.liveContainsMerge ? 'yes - ancestor of what is serving' : 'NO'}`);
  if (out.deployments && out.deployments.length) {
    L.push('  production deployments (newest first, STATES not timestamps):');
    for (const d of out.deployments) {
      const label = String(d.label || d.state || '?');
      L.push(`    ${d.short}  ${label.padEnd(11)} ${d.created}${d.isThisMerge ? '   <- this merge' : ''}${d.note ? `   (${d.note})` : ''}`);
    }
    L.push('    states: success = serving · in_progress/queued = building, that is a QUEUE not a revert');
    L.push('            inactive AFTER a success = superseded by a later deploy, which is normal');
    L.push('            WITHHELD = never succeeded AND its commit is NOT in the serving code: the gate');
    L.push('            refused it and Railway marked it SKIPPED. Re-running that CI green does NOT');
    L.push('            resurrect it — the next merge carries production forward, or the owner');
    L.push('            redeploys in the dashboard.');
    L.push('            CARRIED = never succeeded, but its commit IS in the serving code. Benign: a');
    L.push('            later merge carried it. NOT an incident, and never a reason to redeploy.');
    L.push('            inactive? = never succeeded and ancestry unknown. Deliberately NOT called');
    L.push('            withheld — read `railway deployment list` rather than acting on a guess.');
    L.push('            🔴 A GREEN ci.yml DOES NOT RULE THIS OUT. The gate waits on EVERY check suite');
    L.push('            on the commit, and a SCHEDULED workflow attaches its suite to whatever commit');
    L.push('            is main HEAD when it fires — so any flaky cron here can withhold a deploy.');
    L.push('            But sentry/claude/vercel/railway-app sit at queued FOREVER and do NOT hold');
    L.push('            the gate (measured on two commits that deployed) — never chase those four.');
    // Name the suites rather than leaving the reader to hunt for them. Added 2026-09-28, after
    // cd9e0be03 was withheld with checks/mobile/validate ALL green: the red suite was this repo's
    // own scheduled Deploy Drift Check, which was raising a false alarm about the very deploy it
    // thereby withheld. A reader who trusts the CI line alone concludes the tool is lying.
    //
    // Best-effort by construction — wrapped, and only concluded-bad suites are named. The app
    // suites here (sentry, vercel, claude, railway-app) sit at queued/- forever and are NOT a
    // cause, so listing every non-success suite would bury the real one in permanent noise.
    for (const d of out.deployments.filter((x) => x.withheld)) {
      let suites = null;
      try {
        suites = ghJson(['api', `repos/${REPO}/commits/${d.sha}/check-suites`]);
      } catch {
        suites = null;
      }
      const verdict = classifyWithheld({
        suites,
        hasNewerDeploy: out.deployments.some((x) => x.created && d.created && x.created > d.created),
      });
      const bad = verdict.bad;
      d.refusedByGate = verdict.refusedByGate;
      if (bad.length) {
        const named = bad.map((x) => `${(x.app && x.app.slug) || '?'}=${x.conclusion}`).join(' · ');
        L.push(`    ${d.short} was withheld while these suites were bad: ${named}`);
        L.push('    → if that is not ci.yml, the cause is another workflow on the same commit.');
      } else if (suites) {
        // THE THIRD CAUSE, and it is BENIGN — measured 2026-09-28 on 047a33388, whose every suite
        // read completed/success and whose deployment carried ONE status, `inactive`, with no
        // `in_progress` at all. A newer merge (75ef39135, twenty seconds later) superseded it while
        // it was still waiting for its own CI, so Railway never started the older build. Production
        // moved to the newer commit, which contains the older one. Saying "the gate refused it" here
        // sends a reader hunting a failed suite that does not exist.
        L.push(`    ${d.short} was NOT refused — every check suite on it concluded success.`);
        L.push(`    → ${verdict.why}.`);
      }
    }
  }
  if (out.deployments && out.deployments.some((d) => d.withheld && d.isThisMerge)) {
    const self = out.deployments.find((d) => d.withheld && d.isThisMerge);
    // This banner USED to assert "not superseded ... NOT serving" for EVERY withheld deploy. On a
    // superseded one that is false twice over, and it contradicted the classification printed
    // immediately above it — measured 2026-09-28 on 047a33388 (PR #4592), where every suite read
    // success, the deploy was superseded twenty seconds later, and the commit WAS inside what was
    // serving. Say only what has actually been established.
    if (self && self.refusedByGate === false) {
      L.push(
        '  THIS MERGE\'S OWN BUILD NEVER STARTED — a newer merge superseded it while it waited for CI.',
      );
      L.push('  That is normal on a busy night and needs no action: the `contains it` line above is what');
      L.push('  says whether production already carries this commit. Do NOT redeploy or re-merge.');
    } else if (self && self.refusedByGate === true) {
      L.push(
        '  🔴 THIS MERGE WAS REFUSED BY THE GATE, not queued and not superseded — merged, green and NOT serving.',
      );
    } else if (self) {
      L.push('  🔴 THIS MERGE WAS WITHHELD and its check suites could not be read, so the cause is unknown.');
    }
  }
  if (out.mainCi) L.push(`  main's CI      ${out.mainCi.status}/${out.mainCi.conclusion || '-'}  ${out.mainCi.at}`);
  for (const n of out.notes) L.push(`  note: ${n}`);
  L.push('');
  L.push(`VERDICT: ${verdict} — ${why}`);
  console.log(L.join('\n'));
  process.exit(code);
}
