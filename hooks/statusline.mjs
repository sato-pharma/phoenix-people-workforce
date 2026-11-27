// Statusline: model + free RAM + COMMIT + live session count + this session's age + account relay.
// Node rewrite of statusline.ps1. Same output, ~12x faster:
//   powershell.exe start ~297ms + Get-CimInstance ~371ms + Get-Process/.Path ~77ms = ~1128ms
//   node start ~60ms + os.freemem() instant + cached session count            = ~90ms
// The session count is cached for 20s because counting processes is the only
// expensive part left and it does not need sub-second accuracy.
//
// Commit rides along in that SAME cached call (+66ms, no second spawn). It is here because
// free RAM does NOT predict this machine's failure mode: on 2026-08-25 the box hard-froze
// five times with RAM looking fine, because the COMMIT limit was exhausted and dwm.exe died
// with 0xC00001AD (STATUS_COMMITMENT_LIMIT). Commit % is the number that would have caught it.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = process.env.USERPROFILE || os.homedir();
// Deliberately NOT the same file as memory-guard.mjs's 'claude-statusline-sessions.json'.
// That hook shares a cache to avoid a duplicate ~480ms powershell call, but it writes only
// {at,n} — no commit. Sharing it meant that for up to CACHE_TTL_MS after every SessionStart
// the statusline read a commit-less entry and silently dropped the commit segment, so the
// number flickered out exactly when a new session made it most worth watching.
const CACHE = path.join(os.tmpdir(), 'claude-statusline-commit.json');
const CACHE_TTL_MS = 45_000; // was 20_000 (2026-10-09): the status line refreshes every 30 s, so 20 s spawned PowerShell on every refresh

// Deliberately contains NO double quotes: it is passed as a single argv entry to
// powershell.exe, and mixing JS + PS quoting here is how this breaks silently.
const PS_STATS =
  "$n=@(Get-Process claude -EA SilentlyContinue | Where-Object { $_.Path -like '*claude-code*' }).Count; " +
  "$o=Get-CimInstance Win32_OperatingSystem; " +
  "($n,[math]::Round(($o.TotalVirtualMemorySize-$o.FreeVirtualMemory)/1MB,1)," +
  "[math]::Round($o.TotalVirtualMemorySize/1MB,1)) -join '|'";

const DIM = '[90m';
const RED = '[31m';
const CYAN = '[36m';
const YELLOW = '[33m';
const OFF = '[0m';

let input = null;
try {
  // strip a UTF-8 BOM: some shells prepend one when piping, and JSON.parse throws on it
  input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
} catch {}

const model = input?.model?.display_name ?? 'Claude';

// --- session age from the SessionStart stamp
let age = '';
try {
  const sid = input?.session_id;
  if (sid) {
    const f = path.join(HOME, '.claude', '.session-starts', `${sid}.txt`);
    const h = (Date.now() - new Date(fs.readFileSync(f, 'utf8').trim()).getTime()) / 3.6e6;
    if (h >= 4) age = ` | session ${h.toFixed(0)}h - START A FRESH ONE`;
    else if (h >= 1) age = ` | session ${h.toFixed(0)}h`;
  }
} catch {}

// --- session count + commit, cached: the powershell round-trip is ~480ms and does not
// need to run every render. Old cache files hold only {at,n}; `?? null` keeps those valid
// so the first render after an upgrade degrades to "no commit yet" instead of NaN.
function stats() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - c.at < CACHE_TTL_MS) return { n: c.n, used: c.used ?? null, lim: c.lim ?? null };
  } catch {}
  // Claude CODE engines only. Claude Desktop is WindowsApps\Claude.exe and runs ~14 processes
  // of its own; counting those reports ~21 "sessions" against a 4-session rule, which is wrong.
  // tasklist was measured at 7.2s under load, so this is hard-timed-out and falls back to the
  // last known value — the statusline must never block on it.
  let n = null;
  let used = null;
  let lim = null;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_STATS],
      { encoding: 'utf8', timeout: 2500, windowsHide: true },
    );
    const [pn, pu, pl] = out.trim().split('|').map((v) => parseFloat(v));
    if (Number.isFinite(pn)) n = pn;
    if (Number.isFinite(pu)) used = pu;
    if (Number.isFinite(pl)) lim = pl;
  } catch {}
  if (n === null) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      return { n: c.n, used: c.used ?? null, lim: c.lim ?? null };
    } catch {
      return { n: '?', used: null, lim: null };
    }
  }
  try {
    fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), n, used, lim }));
  } catch {}
  return { n, used, lim };
}

// --- the recommended next step from the last reply
// Written by the Stop hook next-step-capture.mjs, which parses it out of the reply
// once. This only reads a tiny file, so the statusline stays fast no matter how big
// the transcript gets. Three distinct states, and the difference matters:
//   null -> no file yet (nothing has been answered in this session) -> print nothing
//   ''   -> the reply carried no next step -> nudge, because that breaks the rule
//   text -> show it
let nextStep = null;
try {
  const sid = input?.session_id;
  if (sid) {
    nextStep = fs
      .readFileSync(path.join(HOME, '.claude', '.next-step', `${sid}.txt`), 'utf8')
      .trim();
  }
} catch {}

// --- account relay: which of the two accounts is live, and how much of its 5h window is gone.
// Imported dynamically so that if the relay is ever removed or broken, the statusline still
// renders. Reads two small files only — never a transcript — so it stays sub-millisecond.
let acctRow = null;
let effortRow = null;
try {
  const R = await import('./relay-lib.mjs');
  const acct = R.currentAccount();
  if (acct) {
    const db = R.loadAccounts();
    const me = R.readiness(acct.uuid, db);
    const pct = R.pctOfObserved(me.win.total, db.accounts?.[acct.uuid]);
    const bits = [`acct ${R.label(acct, db)}${acct.confidence === 'low' ? ' (low confidence)' : ''}`];
    bits.push(
      me.win.open
        ? `5h ${R.tok(me.win.total)}${pct === null ? '' : ` ${pct}%`} | resets ${R.clock(me.win.end)} in ${R.dur(me.win.end - Date.now())}`
        : '5h window fresh',
    );
    // The whole point of the relay: which account to jump to when this one runs out.
    const others = Object.keys(db.accounts ?? {}).filter((u) => u !== acct.uuid);
    if (!others.length) bits.push('2nd account NOT registered - run /relay on it once');
    else {
      const alt = others
        .map((u) => ({ u, r: R.readiness(u, db) }))
        .sort((a, b) => R.READY_RANK[a.r.state] - R.READY_RANK[b.r.state])[0];
      bits.push(
        alt.r.state === 'limited'
          ? `alt ${R.labelOf(alt.u, db)} limited til ${R.clock(alt.r.until)}`
          : `alt ${R.labelOf(alt.u, db)} ${alt.r.state}`,
      );
    }
    const hot = me.state === 'hot' || me.state === 'limited';
    acctRow = `${hot ? RED : DIM}${bits.join(' | ')}${OFF}`;

    // --- what this session is actually costing per turn.
    // Effort is invisible otherwise: it is set at launch and never shown, which is exactly how
    // a session ends up sitting at `max` for weeks without anyone noticing.
    const mode = R.loadRunMode(input?.session_id);
    const effort = R.normEffort(input?.effort ?? mode?.effort);
    const mdl = R.normModel(input?.model?.id ?? mode?.model ?? model);
    if (effort) {
      const mult = R.effortCost(mdl, effort);
      const advice = R.readJSON(
        `${R.RELAY}/advice/${input?.session_id}.json`.replace(/\\/g, '/'),
        null,
      );
      const seg = [`${R.shortModel(mdl)} @ ${effort} = ${mult.toFixed(2)}x`];
      if (advice?.effort && advice.effort !== effort) {
        const want = R.effortCost(mdl, advice.effort);
        if (want < mult) seg.push(`${advice.tier} task -> /effort ${advice.effort} (${want.toFixed(2)}x)`);
      }
      // Sonnet above `high` is the expensive mistake: 2.41x at xhigh, 5.59x at max.
      const loud = mult >= 1.7 || (/sonnet/.test(mdl) && mult > 1);
      effortRow = `${loud ? RED : DIM}${seg.join('  |  ')}${OFF}`;
    }
  } else {
    // Identity could not be established from any trustworthy local source. Say so loudly
    // rather than printing whichever account ~/.claude.json happens to name: a wrong account
    // here is worse than none, because it reads as confirmation that attribution is correct.
    acctRow = `${RED}acct UNKNOWN - cannot tell which account this session is running as${OFF}`;
  }
} catch {}

const freeGB = os.freemem() / 1073741824;
const { n, used, lim } = stats();
const pct = used !== null && lim ? Math.round((used / lim) * 100) : null;

// 85% is the actionable line, not 100%: the freeze happens during an allocation SPIKE, so by
// the time it reads 100% the box is already wedged and cannot render this statusline anyway.
const commit =
  pct === null
    ? ''
    : ` | ${pct >= 85 ? RED : pct >= 70 ? YELLOW : ''}commit ${used}/${lim}GB ${pct}%${pct >= 70 ? OFF : ''}`;
// The free-RAM arm fires ONLY when commit could not be read. It used to fire whenever free RAM
// was under 2.5 GB, which on this box is most of the time — Windows keeps free RAM low through
// ordinary file caching, so it flagged SATURATED while commit sat at 50% and nothing was wrong.
// Commit is the ceiling; free RAM is a last-resort proxy. Matches memory-guard.mjs / ram-guard.ps1.
const flag =
  pct !== null && pct >= 85
    ? ' !! COMMIT CRITICAL - close sessions'
    : pct === null && freeGB < 1
      ? ' !! LOW RAM, commit unreadable - verify before acting'
      : '';

// The clock time the RAM figure was read. Added 2026-09-21 at the owner's complaint "THE RAM IS
// STALE": the desktop app re-runs this script only when a session is opened, never on a timer or
// after a reply (0 runs in 10 minutes across 6 sessions, measured that morning), so the figure can
// be many minutes old while reading as live. Cairo named explicitly, never the process TZ.
let readAt = '';
try {
  readAt = ` at ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' })}`;
} catch {}

// The Needs You row. Pre-rendered by needs-you-status.mjs at SessionStart — this file only READS
// it, spawns nothing, and never touches the network, because it runs on the critical path of
// opening a session.
//
// 🔴 A NAME, NEVER A BARE COUNT. "Needs you: 3" needs a second lookup before it can be acted on,
// and that lookup is the step nobody takes — the owner's own verdict was that a count "read 9 for
// hours and nobody acted". A PR number and its reason are actionable from the bar itself.
//
// 🔴 AND IT PRINTS NOTHING WHEN NOTHING IS WAITING. A row that says "nothing needs you" every
// session is a row he stops reading, and it is the one sentence that becomes a lie the moment a
// source fails. Its absence means "no PR was waiting as of the reading" — never "all clear".
//
// The AGE is printed rather than hidden once the reading is over ten minutes old. The desktop app
// re-runs this script only when a session opens, so a figure here can be very stale while reading
// as live — the same complaint the RAM row got on 2026-09-21, and the same fix.
let needsYouRow = '';
try {
  const s = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'phoenix-needs-you-status.json'), 'utf8'));
  if (s && typeof s.line === 'string' && s.line.trim() && typeof s.collectedAt === 'number') {
    const readClock = new Date(s.collectedAt).toLocaleTimeString('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
    });
    const mins = Math.floor((Date.now() - s.collectedAt) / 60_000);
    const stale = mins >= 10 ? ` (${mins >= 90 ? `${Math.floor(mins / 60)}h` : `${mins}m`} old)` : '';
    const tone = s.line.startsWith('UNKNOWN') ? YELLOW : CYAN;
    needsYouRow = `${tone}> Needs you:${OFF} ${s.line} ${DIM}- read ${readClock} Cairo${stale}${OFF}`;
  }
} catch {}

// Each line printed becomes its own row, rendered directly above the input box.
const rows = [`[${model}] RAM free ${freeGB.toFixed(1)}GB${readAt}${commit} | ${n} sessions${age}${flag}`];
if (needsYouRow) rows.push(needsYouRow);
if (acctRow) rows.push(acctRow);
if (effortRow) rows.push(effortRow);
// An empty file prints nothing. Until 2026-09-15 it printed a yellow "none given - ask for one",
// which told the owner to ask for another step after a finished task — half of the loop he
// reported that day.
if (nextStep) rows.push(`${CYAN}> Next step:${OFF} ${nextStep}`);

process.stdout.write(rows.join('\n'));
