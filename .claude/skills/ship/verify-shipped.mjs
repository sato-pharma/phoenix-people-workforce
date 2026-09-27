// Did this PR actually reach production? Reads the four sources that can answer, in one pass, and
// prints a verdict instead of an impression.
//
//   node .claude/skills/ship/verify-shipped.mjs <pr>
//   node .claude/skills/ship/verify-shipped.mjs <pr> --simulate-live <sha>   force the live revision
//   node .claude/skills/ship/verify-shipped.mjs <pr> --json                  machine-readable
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

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'Gawish-1997/phoenix-people-workforce';
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

const argv = process.argv.slice(2);
const pr = (argv.find((a) => /^\d+$/.test(a)) || '').trim();
const asJson = argv.includes('--json');
const simulateLive = argv.includes('--simulate-live') ? argv[argv.indexOf('--simulate-live') + 1] || null : null;

const cairo = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false }).replace(',', '') + ' Cairo'
    : '-';

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

  console.log(`\nSELFTEST verify-shipped: ${CASES.length + ANC.length} cases, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (!pr) {
  console.error('usage: node verify-shipped.mjs <pr number> [--simulate-live <sha>] [--json] [--selftest]');
  process.exit(64);
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
  try {
    const statuses = ghJson(['api', `repos/${REPO}/deployments/${d.id}/statuses`]) || [];
    state = statuses.length ? statuses[0].state : null;
    // 🔴 AN `inactive` THAT WAS NEVER `success` IS A DEPLOY THAT NEVER HAPPENED, NOT A SUPERSEDED ONE.
    // Railway calls it SKIPPED; GitHub only ever says `inactive`, which this script used to print as
    // "normal and not a failure" — so a withheld deploy read as healthy. Measured 2026-09-27: two
    // merges 86 seconds apart went `in_progress` -> `inactive` with no `success` between them, while
    // `railway deployment list` showed SKIPPED for both, and production stayed on an older commit even
    // after main's CI was re-run GREEN on the same sha. The whole status history is what distinguishes
    // the two; the newest row alone cannot.
    withheld = !!state && state === 'inactive' && !statuses.some((s) => s.state === 'success');
  } catch (e) {
    out.notes.push(`deployment ${d.id} statuses unreadable: ${String(e.message).trim()}`);
  }
  out.deployments.push({ id: d.id, sha: d.sha, short: String(d.sha).slice(0, 9), created: cairo(d.created_at), state, withheld, isThisMerge: d.sha === out.mergeSha });
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
      const label = d.withheld ? 'WITHHELD' : String(d.state || '?');
      L.push(`    ${d.short}  ${label.padEnd(11)} ${d.created}${d.isThisMerge ? '   <- this merge' : ''}${d.withheld ? '   (never succeeded — Railway SKIPPED it)' : ''}`);
    }
    L.push('    states: success = serving · in_progress/queued = building, that is a QUEUE not a revert');
    L.push('            inactive AFTER a success = superseded by a later deploy, which is normal');
    L.push('            WITHHELD = inactive having NEVER succeeded: the gate refused it and Railway');
    L.push('            marked it SKIPPED. Re-running that CI green does NOT resurrect it — the next');
    L.push('            merge carries production forward, or the owner redeploys in the dashboard.');
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
      const bad = ((suites && suites.check_suites) || []).filter((x) =>
        ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(x.conclusion),
      );
      if (bad.length) {
        const named = bad.map((x) => `${(x.app && x.app.slug) || '?'}=${x.conclusion}`).join(' · ');
        L.push(`    ${d.short} was withheld while these suites were bad: ${named}`);
        L.push('    → if that is not ci.yml, the cause is another workflow on the same commit.');
      }
    }
  }
  if (out.deployments && out.deployments.some((d) => d.withheld && d.isThisMerge)) {
    L.push('  🔴 THIS MERGE WAS WITHHELD, not queued and not superseded — it is merged, green and NOT serving.');
  }
  if (out.mainCi) L.push(`  main's CI      ${out.mainCi.status}/${out.mainCi.conclusion || '-'}  ${out.mainCi.at}`);
  for (const n of out.notes) L.push(`  note: ${n}`);
  L.push('');
  L.push(`VERDICT: ${verdict} — ${why}`);
  console.log(L.join('\n'));
  process.exit(code);
}
