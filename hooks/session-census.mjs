#!/usr/bin/env node
/**
 * session-census.mjs — SessionStart guard against the freeze this machine actually hits.
 *
 * WHY THIS EXISTS (2026-09-04 audit):
 *   10 sessions were open. Physical RAM available oscillated 557-1780 MB against
 *   mem-watchdog's 1800 MB floor, and the watchdog logged continuous PRESSURE while able
 *   to reclaim nothing ("no IDLE dev server"). COMMIT was fine — 54.8 of 79.8 GB free — so
 *   every commit-based check said healthy. That is the precursor AGENTS.md §5 describes:
 *   the freeze that leaves no dump, signalled by dwm.exe dying 0xC00001AD.
 *
 *   (That reading is the 2026-09-04 watchdog. It no longer reclaims nothing: rule 5,
 *   added 2026-09-09, kills extra BUSY dev servers under the floor, and rule 7, added
 *   2026-09-11, kills any node job once RAM stays under 500 MB. The messages below were
 *   reworded 2026-09-12 to match; account in the repo's
 *   docs/agents-worktree-and-machine-limits.md.)
 *
 * WHY THE FIRST VERSION OF THIS FILE WAS WRONG (retuned 2026-09-04, same night):
 *   It shipped with CEILING=4 / WARN_AT=5 / STOP_AT=7 and blamed the session COUNT. Then
 *   the owner said plainly that 10 concurrent sessions is how he works, and a re-measure
 *   settled it in his favour:
 *
 *     agent processes (1 per session)  11   2,964 MB total   mean 269 MB   (not the 330 assumed)
 *     desktop app shell (fixed cost)   26   1,760 MB total
 *     node dev servers / builds         4   1,303 MB — and 3,270 MB during the incident
 *
 *   Ten sessions are ~2.7 GB of 15.8 GB. The incident had ten sessions AND a 3.27 GB node
 *   process: ONE dev server outweighs a dozen sessions. So the count was never the binding
 *   term, and a hook firing on it would have fired on every session start at the owner's
 *   normal working level — which is precisely how a guard becomes wallpaper. AGENTS.md §2.2
 *   already records that failure once: "A count on the statusline is not a guard — it read 9
 *   for hours and nobody acted." Replacing an ignored number with a louder ignored number is
 *   not a fix.
 *
 * SO: RAM IS THE TRIGGER, THE COUNT IS ONLY CONTEXT.
 *   RAM free < 2600 MB  warn — a dev server or cold typecheck (~3.5 GB) would cross the floor
 *   RAM free < 1800 MB  stop — mem-watchdog's floor; under it the watchdog KILLS to recover
 *                       node jobs — a typecheck, build or test run — and under 500 MB any node
 *                       job, most RAM first. It never touches a dev server IN USE: exempt from
 *                       every rule since 2026-09-12 by the owner's instruction, except that since
 *                       2026-09-21 (his choice) one at or over 8 GB of commit, or unused for 25
 *                       minutes, is stopped. Otherwise a dev server is stopped by hand, or by
 *                       dev-server-reaper.mjs when its session ends.
 *   sessions >= 13/16   warn/stop — far above the owner's stated 10, so this rarely speaks
 *
 *   And when it does speak, it names the dev server FIRST. Closing one heavy job returns
 *   ~3.5 GB; closing a session returns ~269 MB. Advising the expensive remedy for the cheap
 *   problem is what the first version got backwards.
 *
 * It NEVER blocks a session, and it never kills anything. It reports. Blocking a session at
 * 4am to save memory would cost more than the memory. AGENTS.md §5 carries the rule.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The owner's stated working level, 2026-09-04: "10 sessions, retune the thresholds".
// This is context printed alongside a RAM warning, NOT a threshold in its own right.
const CEILING = 10;

// Count thresholds sit well above the working level on purpose. They exist for a runaway
// (a spawn loop, sessions never closing across days), not for a normal busy night.
const WARN_AT = 13;
const STOP_AT = 16;

const RAM_FLOOR_MB = 1800; // same floor mem-watchdog.ps1 defends - keep these two in step
const RAM_WARN_MB = 2600; // below this, one heavy job crosses the floor
const WATCHDOG_CRIT_MB = 500; // mem-watchdog.ps1 $CritRamMB (rule 7) - keep these two in step

// Shared with memory-guard.mjs, whose async `refresh` entry writes {at,n,used,lim} at SessionStart.
//
// 2026-10-09 (deep slowness audit): this file read that cache and then started powershell.exe
// ANYWAY on every session start, because RAM came out of the same call: 0.8-1.3 s on its own and a
// median 2.0 s at session start, where a dozen hooks start at once (382 starts, 2-8 Oct). RAM now
// comes from os.freemem()/os.totalmem() — the same counter as Win32_OperatingSystem's
// FreePhysicalMemory that mem-watchdog.ps1 defends (side by side on 9 Oct: within 6-14 MB, totals
// identical).
//
// 2026-10-09, later that morning (hook speed fixes): the PowerShell fallback for the COUNT went too
// — 0.6 s alone whenever the cache was over 10 minutes old. The count is only context and RAM, read
// live, is the trigger, so a cached count up to COUNT_MAX_AGE_MS old is used, and with none the
// census speaks on RAM alone. This file starts no process at all now; `selftest` proves it.
const CACHE = path.join(os.tmpdir(), 'claude-statusline-sessions.json');
const COUNT_MAX_AGE_MS = 60 * 60_000; // the same window memory-guard.mjs trusts

function cachedCount() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - c.at < COUNT_MAX_AGE_MS && typeof c.n === 'number') return c.n;
  } catch {}
  return null;
}

// The decision, PURE: every input is an argument, so `selftest` can drive each branch whatever
// this machine's RAM happens to be. Thresholds, precedence and wording are unchanged.
function buildLines({ freeMb, totalMb, n }) {
  const lines = [];
  const ramStop = freeMb !== null && freeMb < RAM_FLOOR_MB;
  const ramWarn = freeMb !== null && freeMb < RAM_WARN_MB;
  const countStop = n !== null && n >= STOP_AT;
  const countWarn = n !== null && n >= WARN_AT;

  const stop = ramStop || countStop;
  const warn = !stop && (ramWarn || countWarn);
  if (!stop && !warn) return lines;

  const state = [];
  if (freeMb !== null) state.push(`RAM free ${freeMb} MB of ${totalMb} MB`);
  if (n !== null) state.push(`${n} Claude Code sessions open (normal here is ${CEILING})`);
  const status = state.join(', ');

  if (ramStop) {
    lines.push(`RAM IS UNDER THE FLOOR - ${status}.`);
    lines.push(
      `${RAM_FLOOR_MB} MB is the floor mem-watchdog.ps1 defends, and under it the watchdog recovers RAM by KILLING node jobs - a typecheck, build or test run - and under ${WATCHDOG_CRIT_MB} MB any node job, most RAM first. It does NOT touch a dev server in use: since 2026-09-12, by the owner's instruction, a dev server is exempt from its rules, and since 2026-09-21 (his choice) the only exceptions are a runaway at or over 8 GB of commit and one unused for 25 minutes - so the 3.5 GB a working server holds is never reclaimed for you. dev-server-reaper.mjs stops one when the session that started it ends; before that, it is stopped by hand, by port. Its kills are a backstop, not a plan: past them is the no-dump freeze or a bluescreen (AGENTS.md 5; dwm.exe dying 0xC00001AD, and the 2026-09-11 bugchecks 0x9F and 0x116). The heavy-job gate that used to REFUSE a heavy job at this level was removed on 2026-09-17 (owner instruction) - nothing blocks one now, so judge it yourself.`
    );
    lines.push(
      `ACTION: stop a dev server or a build FIRST - that returns ~3.5 GB, where closing a session returns ~269 MB. Kill a dev server by PORT, not by task (AGENTS.md 5). Say the numbers to the owner in plain words; never close a session or kill a process yourself.`
    );
  } else if (countStop) {
    lines.push(`SESSION COUNT RUNAWAY - ${status}.`);
    lines.push(
      `${n} is far above the ${CEILING} this machine is tuned for, which usually means sessions are not being closed rather than that ${CEILING} is wrong. RAM is not yet under the floor.`
    );
    lines.push(`ACTION: tell the owner the count in plain words. Do not close anything yourself.`);
  } else if (ramWarn) {
    lines.push(`RAM is tight - ${status}.`);
    lines.push(
      `Under ${RAM_WARN_MB} MB, starting a dev server or a cold typecheck (~3.5 GB) would cross the ${RAM_FLOOR_MB} MB floor. The session count is NOT the cost here - one dev server outweighs a dozen sessions.`
    );
    lines.push(`Before starting heavy work, check for a dev server already running and reuse it.`);
  } else {
    lines.push(`Session count is ${n}, above the ${CEILING} this machine is tuned for - ${status}.`);
    lines.push(`RAM is still healthy, so this is a note, not a problem. AGENTS.md 5 carries the rule.`);
  }
  return lines;
}

// MODE: `node ~/.claude/hooks/session-census.mjs selftest` prints `N cases, 0 failed` and exits 0.
// Added 2026-10-09 with the change above; claude-scripts-backup.mjs runs it every hour.
if (process.argv[2] === 'selftest') {
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  let ran = 0;
  let failed = 0;
  const check = (label, cond, detail) => {
    ran++;
    if (cond) return console.log(`  pass  ${label}`);
    failed++;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  };
  console.log('SELFTEST session-census:');
  const say = (o) => buildLines({ freeMb: 8000, totalMb: 16174, n: 6, ...o }).join(' ');

  check('a healthy machine at the normal count is SILENT', say({}) === '');
  check('12 sessions with healthy RAM is still silent', say({ n: 12 }) === '');
  check('13 sessions gives the NOTE, not an alarm', /^Session count is 13/.test(say({ n: 13 })) && /a note, not a problem/.test(say({ n: 13 })));
  check('16 sessions gives the RUNAWAY alarm', /^SESSION COUNT RUNAWAY/.test(say({ n: 16 })));
  check('RAM under 2,600 MB warns that it is tight', /^RAM is tight/.test(say({ freeMb: 2599 })));
  check('RAM under 1,800 MB is the floor alarm', /^RAM IS UNDER THE FLOOR/.test(say({ freeMb: 1799 })));
  check('RAM at exactly 1,800 MB is tight, not under the floor', /^RAM is tight/.test(say({ freeMb: 1800 })));
  check('the RAM floor wins over a runaway count', /^RAM IS UNDER THE FLOOR/.test(say({ freeMb: 1500, n: 16 })));
  check('an UNKNOWN count with healthy RAM is silent', say({ n: null }) === '');
  check(
    'an UNKNOWN count still lets the RAM floor speak, without inventing a count',
    /^RAM IS UNDER THE FLOOR/.test(say({ freeMb: 1500, n: null })) && !/sessions open/.test(say({ freeMb: 1500, n: null })),
    'the count is context; RAM is the trigger',
  );

  // --- the real hook as a child, TEMP redirected to a fixture cache, every spawn recorded.
  const TMP_T = fs.mkdtempSync(path.join(os.tmpdir(), 'census-selftest-'));
  const PROBE = pathToFileURL(path.join(path.dirname(process.argv[1]), 'spawn-probe.mjs')).href;
  const CACHE_T = path.join(TMP_T, 'claude-statusline-sessions.json');
  const probed = (cache) => {
    const log = path.join(TMP_T, 'probe.jsonl');
    fs.writeFileSync(log, '');
    if (cache === null) fs.rmSync(CACHE_T, { force: true });
    else fs.writeFileSync(CACHE_T, JSON.stringify(cache));
    const stdout = execFileSync(process.execPath, ['--import', PROBE, process.argv[1]], {
      input: JSON.stringify({ session_id: 'census-probe', source: 'startup' }),
      encoding: 'utf8',
      env: { ...process.env, TEMP: TMP_T, TMP: TMP_T, SPAWN_PROBE_OUT: log },
    });
    return { stdout, spawned: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  const ago = (ms) => Date.now() - ms;
  check(
    'with NO cache it starts no process',
    probed(null).spawned.length === 0,
    'until 2026-10-09 it started powershell.exe here for the count: 0.6 s alone',
  );
  check('with a 15-minute-old cache it starts no process', probed({ at: ago(15 * 60_000), n: 6 }).spawned.length === 0);
  check(
    'a cached count of 16 under an hour old reaches the output',
    /16 Claude Code sessions open/.test(probed({ at: ago(30 * 60_000), n: 16 }).stdout),
  );
  check(
    'a cached count over an hour old is NOT used',
    !/16 Claude Code sessions open/.test(probed({ at: ago(61 * 60_000), n: 16 }).stdout),
  );
  check(
    'output, when there is any, is a valid SessionStart additionalContext envelope',
    (() => {
      const o = probed({ at: ago(60_000), n: 16 }).stdout;
      try {
        const j = JSON.parse(o);
        return j?.hookSpecificOutput?.hookEventName === 'SessionStart' && /^MACHINE PRESSURE \(session-census\): /.test(j.hookSpecificOutput.additionalContext);
      } catch {
        return false;
      }
    })(),
  );
  try {
    fs.rmSync(TMP_T, { recursive: true, force: true });
  } catch {}

  console.log(`\n${ran} cases, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const lines = buildLines({
  freeMb: Math.round(os.freemem() / 1048576),
  totalMb: Math.round(os.totalmem() / 1048576),
  n: cachedCount(),
});

if (!lines.length) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'MACHINE PRESSURE (session-census): ' + lines.join(' '),
    },
  })
);
