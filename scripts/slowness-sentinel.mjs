#!/usr/bin/env node
// slowness-sentinel.mjs — once a day, measure yesterday's Claude Code sessions against the slowness
// limits and write ONE line saying whether any was crossed.
//
// WHY THIS EXISTS (2026-10-09). Every slowdown of the week of 2–9 Oct ran for days before a manual
// audit caught it: a push-time typecheck hook froze commands for 6.1 hours over six days, a reminder
// re-injected 440k tokens in 28 hours, and the project hooks took a Phoenix Read from 45 to 210–260
// ms. Each was visible in the session transcripts the whole time; nothing was reading them. This
// reads them every morning and reaches the owner's phone through the Telegram alert he already gets
// for the backups.
//
// WHAT IT DOES
//   1. Fetches origin/main into the primary checkout (bounded retries: the 21:00 jobs have lost the
//      `.git` lock to each other before) and copies `scripts/slow-audit.mjs` out of origin/main into
//      the temp folder — the primary checkout can lag main by days, the measuring tool must not.
//   2. Runs its own selftest against that copy: a synthetic over-limit record must raise alarms, a
//      clean one must raise none, one just under a minimum sample must stay quiet. A selftest that
//      fails is itself a FAIL line — a sentinel that cannot alarm must not report OK.
//   3. Runs `slow-audit.mjs --transcripts --since <day> --until <today> --check` on Cairo days and
//      reads the alarms it wrote to ~/.claude/logs/slow-audit-alarms.json.
//   4. Adds `~/.claude/logs/compact-summary-length.jsonl`: any compaction summary past its
//      10,000-character ceiling in the window.
//   5. Appends ONE entry to ~/.claude/scripts/slowness-sentinel.log:
//        [<ISO time>] OK window 2026-10-09..2026-10-10 — no limit crossed (…)
//        [<ISO time>] FAIL window … PROBLEMS: <plain sentence>; <plain sentence>
//      slowness-sentinel-watch.ps1 (Task Scheduler, 30 minutes later) reads that line and sends the
//      PROBLEMS text on Telegram.
//
// IT ONLY REPORTS. It changes no hook, setting or file outside its own log and the temp folder; the
// fix waits for the owner's word.
//
// EXIT CODES. 0 for every line it manages to write, FAIL included — the watcher judges the task's exit
// code BEFORE it reads the log, and an exit 1 would replace the plain-words PROBLEMS with "it exited
// 1". A crash (nothing written) exits non-zero, which the watcher reports as "did not finish".
//
// CATCH-UP. A laptop asleep at 06:15 runs the task on wake (StartWhenAvailable), and a day it never
// ran is measured the next time: the window starts where the last measured window ended, at most 7
// days back.
//
// UNTIL `--check` IS ON MAIN (PR 5633), origin/main's slow-audit has no limits; the sentinel
// then logs "OK — limits arrive with PR …" and alarms nothing, so it never nags anyone to merge. The
// first run that finds them only sets the baseline (`switchingOn`): the days before ran the old hooks.
//
// usage:  node slowness-sentinel.mjs              the daily run
//         node slowness-sentinel.mjs --dry-run    everything except appending the log line (prints it)
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIMITS_PR = '5633';
const PRIMARY = 'F:/Phoenix Workforce/phoenix-workforce';
// Which ref's slow-audit.mjs to trust. Always origin/main in the daily run; PHX_SENTINEL_REF lets a
// test point it at an unmerged branch (with a sandboxed USERPROFILE, so no real log is touched).
const REF = process.env.PHX_SENTINEL_REF || 'origin/main';
const HOME = os.homedir();
const LOG = path.join(HOME, '.claude', 'scripts', 'slowness-sentinel.log');
const ALARMS = path.join(HOME, '.claude', 'logs', 'slow-audit-alarms.json');
const SUMMARIES = path.join(HOME, '.claude', 'logs', 'compact-summary-length.jsonl');
const WORK = path.join(os.tmpdir(), 'phx-slowness-sentinel');
const DRY = process.argv.includes('--dry-run');
const MAX_CATCH_UP_DAYS = 7;
const MIN_FREE_MB = 1800;

const cairoDay = (ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function writeEntry(line) {
  const entry = `[${new Date().toISOString()}] ${line.replace(/\s*\r?\n\s*/g, ' ')}`;
  if (DRY) {
    console.log(`(dry run, not logged) ${entry}`);
    return;
  }
  mkdirSync(path.dirname(LOG), { recursive: true });
  appendFileSync(LOG, entry + '\n');
  console.log(entry);
}

/** The window to measure: from where the last measured window ended (≤ 7 days back) to today, Cairo days. */
export function windowFor(logText, today) {
  let since = addDays(today, -1);
  // A FAIL that says the day "was not judged" (the tool, the records or the result failed) does not
  // count as measured: the next run takes that day again.
  const entries = String(logText ?? '')
    .split(/\r?\n/)
    .filter((l) => /^\[\S+\]\s+(OK|FAIL)\b/.test(l) && !/was not judged/.test(l));
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = /window (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(entries[i]);
    if (!m) continue;
    const lastUntil = m[2];
    const gap = daysBetween(lastUntil, today);
    if (gap <= 0) return null; // today is already measured
    since = gap > MAX_CATCH_UP_DAYS ? addDays(today, -MAX_CATCH_UP_DAYS) : lastUntil;
    break;
  }
  return { since, until: today };
}

/**
 * True when the last measured entry is a "limits arrive" line: this is the first run with `--check`
 * on main. The days before it ran the hooks that PR fixes, so judging them would send a stale alarm
 * the morning after the merge; that run only sets the baseline, and the next one judges a full day.
 */
export function switchingOn(logText) {
  const entries = String(logText ?? '')
    .split(/\r?\n/)
    .filter((l) => /^\[\S+\]\s+(OK|FAIL)\b/.test(l));
  return entries.length > 0 && /limits arrive with PR/.test(entries[entries.length - 1]);
}

/** Compaction summaries past their ceiling among the log lines whose time `keep(ms)` accepts. Pure. */
export function summariesOverCeiling(jsonlText, keep) {
  let n = 0;
  const over = [];
  for (const line of String(jsonlText ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!keep(Date.parse(o?.at ?? ""))) continue;
    n += 1;
    const chars = Number(o.summaryChars ?? o.chars);
    const ceiling = Number(o.ceilingChars ?? 10_000);
    if (Number.isFinite(chars) && chars > ceiling) over.push(chars);
  }
  return { n, over };
}

/** The sentinel's own selftest against the slow-audit module it is about to trust. Returns problems. */
export function selftest(audit, today = '2026-10-10') {
  const problems = [];
  const keys = (rec) => audit.transcriptAlarms(rec).map((a) => a.key);
  const read = audit.TRANSCRIPT_LIMITS?.phoenixReadP50Ms;
  if (!read) return ['the measuring tool has no Phoenix Read limit'];
  const over = keys({
    toolWall: { phoenix: { Read: { n: read.minSample + 50, p50Ms: read.limit * 5, p90Ms: read.limit * 9 } } },
    compactSummaries: { n: 3, p50Chars: 30_000, maxChars: 40_000, defaultNine: 1 },
    hooks: [],
  });
  for (const k of ['phoenixReadP50Ms', 'compactSummaryP50Chars', 'compactDefaultNine']) {
    if (!over.includes(k)) problems.push(`a record over the ${k} limit raised no alarm`);
  }
  if (keys({}).length) problems.push('an empty record raised an alarm');
  const under = keys({ toolWall: { phoenix: { Read: { n: read.minSample - 1, p50Ms: read.limit * 5, p90Ms: read.limit * 9 } } }, hooks: [] });
  if (under.length) problems.push('a sample under the minimum raised an alarm');
  // The sentinel's own pure parts.
  const w = windowFor(`[x] OK window 2026-10-08..2026-10-09 — fine`, today);
  if (!w || w.since !== '2026-10-09' || w.until !== today) problems.push(`the catch-up window is wrong: ${JSON.stringify(w)}`);
  if (windowFor(`[x] OK window 2026-10-09..${today} — fine`, today) !== null) problems.push('a day already measured would be measured again');
  const retry = windowFor(`[x] OK window 2026-10-08..2026-10-09 — fine\n[y] FAIL window 2026-10-09..${today} PROBLEMS: the tool broke, so yesterday was not judged`, today);
  if (!retry || retry.since !== '2026-10-09') problems.push('a day that was not judged would never be measured');
  const before = `[x] OK window 2026-10-08..2026-10-09 — limits arrive with PR ${LIMITS_PR}; nothing was measured`;
  if (!switchingOn(before)) problems.push('the first run with limits would judge the days before the merge');
  if (switchingOn(`${before}\n[y] OK window ${today}..${today} — limits switched on`)) problems.push('the baseline would be set twice');
  const next = windowFor(`${before}\n[y] OK window ${today}..${today} — limits switched on`, addDays(today, 1));
  if (!next || next.since !== today) problems.push(`the first full day after the switch-on would not be judged: ${JSON.stringify(next)}`);
  const s = summariesOverCeiling(
    '{"at":"2026-10-09T10:00:00Z","summaryChars":12000,"ceilingChars":10000}\n{"at":"2026-10-09T11:00:00Z","summaryChars":7000}\n{"at":"2026-10-11T11:00:00Z","summaryChars":99000}',
    (ms) => cairoDay(ms) === '2026-10-09',
  );
  if (s.n !== 2 || s.over.length !== 1) problems.push('a summary over its ceiling, or outside the window, was miscounted');
  return problems;
}

function git(args, timeout = 60_000) {
  return execFileSync('git', ['-C', PRIMARY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, windowsHide: true }).trim();
}

function fetchMain() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      git(['fetch', '--quiet', 'origin', 'main'], 120_000);
      return null;
    } catch (err) {
      const text = String(err?.stderr ?? err?.message ?? err);
      if (attempt < 3 && /lock|unable to|cannot lock/i.test(text)) {
        const until = Date.now() + 20_000;
        while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        continue;
      }
      return text.split(/\r?\n/).find(Boolean) ?? 'unknown error';
    }
  }
  return 'the fetch kept losing the git lock';
}

async function main() {
  const startedMs = Date.now();
  const today = cairoDay(startedMs);
  const prior = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
  const window = windowFor(prior, today);
  if (!window) {
    console.log(`already measured up to ${today}; nothing to do`);
    return;
  }
  const label = `window ${window.since}..${window.until}`;

  const freeMb = Math.round(os.freemem() / 1_048_576);
  if (freeMb < MIN_FREE_MB) {
    writeEntry(`SKIP ${label} — free RAM ${freeMb} MB is under ${MIN_FREE_MB} MB, so the day was not measured; the next run measures it`);
    return;
  }

  const fetchNote = fetchMain();
  mkdirSync(WORK, { recursive: true });
  const sha = git(['rev-parse', REF]);
  // `scripts/slow-audit.mjs` has imported `./lib/refuse-arguments.mjs` since 1dd182a0c
  // (2026-10-15 22:56, #5959), so the lone flat copy this used to write could not be imported at
  // all: the relative specifier resolved inside the temp folder, `await import` threw
  // ERR_MODULE_NOT_FOUND, main() rejected before it could write a line, and `conhost.exe
  // --headless` reported 0 to Task Scheduler - so the sentinel went silent from 16 to 23 Oct 2026
  // with the task green every morning, and 8 days of alarms were lost. Stage `scripts/lib/`
  // beside it so ANY relative import under `scripts/` resolves, not just the one file needed
  // today. Measured 2026-10-23: scripts/lib holds 13 files and none of them imports a sibling.
  const LF = String.fromCharCode(10);
  const stage = path.join(WORK, sha.slice(0, 10), 'scripts');
  const auditFile = path.join(stage, 'slow-audit.mjs');
  if (!existsSync(auditFile)) {
    mkdirSync(path.join(stage, 'lib'), { recursive: true });
    writeFileSync(auditFile, git(['show', `${REF}:scripts/slow-audit.mjs`], 30_000) + LF);
    const libFiles = git(['ls-tree', '-r', '--name-only', REF, '--', 'scripts/lib'], 30_000)
      .split(LF)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const rel of libFiles) {
      writeFileSync(path.join(stage, 'lib', path.posix.basename(rel)), git(['show', `${REF}:${rel}`], 30_000) + LF);
    }
  }
  const audit = await import(pathToFileURL(auditFile).href);

  if (typeof audit.transcriptAlarms !== 'function' || !audit.TRANSCRIPT_LIMITS) {
    writeEntry(`OK ${label} — limits arrive with PR ${LIMITS_PR}; ${REF} ${sha.slice(0, 10)} has no --check yet, so nothing was measured`);
    return;
  }

  const selfProblems = selftest(audit);
  if (selfProblems.length) {
    writeEntry(`FAIL ${label} PROBLEMS: the daily slowness check could not trust its own measuring tool (${selfProblems.join('; ')}), so yesterday was not judged`);
    return;
  }

  if (switchingOn(prior)) {
    writeEntry(`OK window ${today}..${today} — limits switched on (main ${sha.slice(0, 10)}); the days before ran the old hooks, so the first day judged is ${today}, in the next run`);
    return;
  }

  const run = spawnSync(
    process.execPath,
    [auditFile, '--transcripts', '--since', window.since, '--until', window.until, '--check'],
    { cwd: WORK, encoding: 'utf8', timeout: 20 * 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    const why = run.error ? String(run.error.message) : (String(run.stderr || '').split(/\r?\n/).find(Boolean) ?? `exit ${run.status}`);
    writeEntry(`FAIL ${label} PROBLEMS: the daily slowness check could not read the session records (${why.slice(0, 200)})`);
    return;
  }
  // Fresh = written by THIS run. Judged by the file's own modified time: the record's `at` is a Cairo
  // wall-clock string ("2026-10-09 08:43"), not an instant Date.parse can read.
  let result = null;
  try {
    if (statSync(ALARMS).mtimeMs >= startedMs - 2000) result = JSON.parse(readFileSync(ALARMS, 'utf8'));
  } catch {
    result = null;
  }
  if (!result || !Array.isArray(result.alarms)) {
    writeEntry(`FAIL ${label} PROBLEMS: the daily slowness check ran but wrote no fresh result, so yesterday was not judged`);
    return;
  }

  const problems = result.alarms.map((a) => String(a.say).trim()).filter(Boolean);
  const inWindow = (ms) => Number.isFinite(ms) && cairoDay(ms) >= window.since && cairoDay(ms) < window.until;
  const exactSummaries = summariesOverCeiling(existsSync(SUMMARIES) ? readFileSync(SUMMARIES, 'utf8') : '', inWindow);
  if (exactSummaries.over.length) {
    const longest = Math.max(...exactSummaries.over).toLocaleString('en-US');
    problems.push(
      `${exactSummaries.over.length} of ${exactSummaries.n} session summaries ran past the 10,000-character ceiling you set (longest ${longest}), and a longer summary keeps the session frozen longer while it is written`,
    );
  }

  const note = fetchNote ? `; main could not be fetched (${fetchNote.slice(0, 120)}), so the last fetched copy was used` : '';
  if (problems.length) {
    writeEntry(`FAIL ${label} PROBLEMS: ${problems.join(' ')}${note}`);
  } else {
    writeEntry(`OK ${label} — no limit crossed (main ${sha.slice(0, 10)}, ${exactSummaries.n} summaries)${note}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    statSync(PRIMARY);
  } catch {
    writeEntry('FAIL window unknown PROBLEMS: the daily slowness check could not find the Phoenix checkout on this laptop');
    process.exit(0);
  }
  try {
    await main();
  } catch (err) {
    // A throw used to end the run with NOTHING written: node exited non-zero, and because the task
    // runs `conhost.exe --headless node ...`, Task Scheduler recorded CONHOST's 0 - so the failure
    // watcher, which reads THIS log, saw neither a new line nor a bad exit code, and the silence
    // ran for 8 days. Every crash now writes its own FAIL line. The words 'was not judged' are
    // load-bearing: windowFor excludes such a line from the measured set, so the day it could not
    // judge is measured again on the next run instead of being skipped for good.
    const firstLine = String(err && err.message ? err.message : err)
      .split(String.fromCharCode(10))[0]
      .trim()
      .slice(0, 200);
    writeEntry(
      'FAIL window unknown PROBLEMS: the daily slowness check crashed before it could judge the ' +
        `day (${firstLine}), so the day was not judged`,
    );
    process.exit(0);
  }
}
