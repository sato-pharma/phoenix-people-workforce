#!/usr/bin/env node
/**
 * claude-hygiene.mjs — keeps this machine's Claude Code install from silting up.
 *
 * Written 2026-09-04 after a deep audit found: 4 stale dead-PID locks (one of them
 * firing a false "another session is in this folder" alarm on every start), 2,238
 * uncleaned session-start files, 33 dead project entries in ~/.claude.json, and 40
 * permission rules in settings.local.json that could never match again — including a
 * stored `gh pr merge` approval, which AGENTS.md §6 names a protected action.
 *
 * None of that is exotic. All of it accumulates silently because nothing ever removes it.
 * This script is the thing that removes it.
 *
 *   node claude-hygiene.mjs            # report only, changes nothing (default)
 *   node claude-hygiene.mjs --fix      # apply
 *   node claude-hygiene.mjs --fix --quiet   # for the scheduled task
 *
 * SAFETY RULES this script obeys, because the audit showed why each is needed:
 *  - A lock is cleared on the rule that lock TYPE actually uses, never one uniform test:
 *      * session.lock  -> AGE ONLY (> 2h), matching .claude/hooks/session-lock.mjs. Its `pid`
 *        is process.ppid, the hook's short-lived parent shell, dead seconds after the lock is
 *        written — so a PID test condemns EVERY session lock, including one a live session
 *        wrote five minutes ago. That is not hypothetical: it did exactly that on 2026-09-05.
 *      * every other lock -> PID dead, or reused by a non-claude process, re-checked at the
 *        moment of removal.
 *  - A permission rule is dropped only if the absolute path it names no longer exists,
 *    or it is pinned to one specific PR / run / SHA. Never on a guess.
 *  - The drive-letter regex carries a lookbehind. Without it "https://" reads as drive
 *    "s:/" and 35 healthy curl rules get condemned. That happened on the first pass.
 *  - Every JSON write is validated, then written temp-and-rename.
 *  - It NEVER touches .xlsx or .pdf files, and never runs a git command.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const HOME = 'C:/Users/satoh';
const CLAUDE = `${HOME}/.claude`;
const FIX = process.argv.includes('--fix');
const QUIET = process.argv.includes('--quiet');

const SESSION_START_KEEP_DAYS = 7;
const TMP_KEEP_HOURS = 24;

const log = [];
let reclaimedBytes = 0;
let actions = 0;

const say = (s) => { log.push(s); if (!QUIET) console.log(s); };
const head = (s) => say(`\n=== ${s} ===`);
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

/** Is this PID a live process right now? Re-checked at the moment of use. */
function pidAlive(pid) {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.ProcessName}else{'DEAD'}`],
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    return out === 'DEAD' ? null : out;
  } catch {
    return null;
  }
}

/** Staleness for every lock whose `pid` really is the owning process. */
function pidVerdict(pid) {
  if (!pid || !Number.isFinite(pid)) return null;
  const name = pidAlive(pid);
  // A lock naming a live PID that is NOT claude is stale by PID REUSE.
  if (!name) return { stale: true, why: `pid ${pid} dead` };
  if (!/^claude/i.test(name)) return { stale: true, why: `pid ${pid} reused by ${name}` };
  return { stale: false, why: `pid ${pid} = ${name}` };
}

/** How long a session lock may sit before it is genuinely abandoned. */
const SESSION_LOCK_STALE_MS = 2 * 60 * 60 * 1000; // must match STALE_MS in session-lock.mjs

/**
 * Staleness for .claude/session.lock — BY AGE, never by PID.
 *
 * session-lock.mjs writes `pid: process.ppid`: the hook's parent shell, which exits within
 * seconds of the lock being written. Its own header says so, and says PID-liveness checks are
 * 'intentionally not used to decide staleness'. Ownership there is tracked by sessionId and
 * staleness by age alone.
 *
 * This function replaces the PID test because that test could not fail to condemn: every
 * session lock on the machine reads as 'pid dead' forever. On 2026-09-05 this script reported
 * a lock written FIVE MINUTES EARLIER by a live session as stale, and the weekly scheduled
 * task runs with --fix. Deleting it removes the only guard against two sessions in one folder,
 * which in this repo has meant a session git-detached by another's checkout, a branch
 * auto-deleted mid-work, and a swarm dropping a staged file.
 *
 * An unreadable or undated lock is stale, matching session-lock.mjs, which treats a
 * non-finite age the same way.
 */
function sessionLockVerdict(text) {
  let lock;
  try { lock = JSON.parse(text); } catch { return { stale: true, why: 'unparseable lock file' }; }
  // Age is measured from the LAST REFRESH, exactly as session-lock.mjs does. Since 2026-09-17 a live
  // session rewrites `refreshedAt` on its tool calls ("beat"); `startedAt` alone is the SESSION's
  // age, which would condemn every session running past two hours — and this pass runs with --fix.
  // A lock an older hook wrote has no `refreshedAt` and falls back to `startedAt`.
  const lastSeen = Date.parse(lock?.refreshedAt || lock?.startedAt || '');
  if (!Number.isFinite(lastSeen)) return { stale: true, why: 'no readable refreshedAt or startedAt' };
  // Decided in MILLISECONDS, exactly as session-lock.mjs does (`ageMs > STALE_MS`). Rounding to
  // minutes first would put the two guards up to 30s out of step with each other.
  const ageMs = Date.now() - lastSeen;
  const mins = Math.round(ageMs / 60000);
  const limit = SESSION_LOCK_STALE_MS / 60000;
  return ageMs > SESSION_LOCK_STALE_MS
    ? { stale: true, why: `age ${mins} min > ${limit} min` }
    : { stale: false, why: `age ${mins} min — a live session may hold this` };
}

// ---------------------------------------------------------------- 1. locks ---
function stalelocks(projectDirs) {
  head('stale locks');
  // Each lock is judged by the rule ITS OWN writer uses. One uniform PID test used to serve
  // all four, and for session.lock that test can never pass — see sessionLockVerdict.
  const candidates = [
    { f: `${CLAUDE}/.update.lock`, verdict: (t) => pidVerdict(Number(t.trim())) },
    { f: `${CLAUDE}/daemon.lock`, verdict: (t) => pidVerdict(Number(JSON.parse(t).pid)) },
    ...projectDirs.flatMap((d) => [
      { f: `${d}/.claude/session.lock`, verdict: sessionLockVerdict },
      { f: `${d}/.claude/scheduled_tasks.lock`, verdict: (t) => pidVerdict(Number(JSON.parse(t).pid)) },
    ]),
  ];
  let n = 0;
  for (const c of candidates) {
    if (!fs.existsSync(c.f)) continue;
    let v;
    try { v = c.verdict(fs.readFileSync(c.f, 'utf8')); } catch { continue; }
    // A verdict of null means 'cannot judge this one' — which is never a licence to delete.
    if (!v) continue;
    if (!v.stale) { say(`  held   ${c.f}  (${v.why})`); continue; }
    say(`  ${FIX ? 'CLEAR ' : 'stale '} ${c.f}  (${v.why})`);
    if (FIX) { reclaimedBytes += fs.statSync(c.f).size; fs.rmSync(c.f, { force: true }); actions++; }
    n++;
  }
  // daemon.status.json is meaningless once daemon.lock is gone
  const ds = `${CLAUDE}/daemon.status.json`;
  if (fs.existsSync(ds) && !fs.existsSync(`${CLAUDE}/daemon.lock`)) {
    say(`  ${FIX ? 'CLEAR ' : 'stale '} ${ds}  (orphan - no daemon.lock)`);
    if (FIX) { reclaimedBytes += fs.statSync(ds).size; fs.rmSync(ds, { force: true }); actions++; }
    n++;
  }
  if (!n) say('  none');
}

// ------------------------------------------------------ 2. session-starts ---
function sessionStarts() {
  head(`.session-starts (retention ${SESSION_START_KEEP_DAYS}d)`);
  const dir = `${CLAUDE}/.session-starts`;
  if (!fs.existsSync(dir)) return say('  absent');
  const cutoff = Date.now() - SESSION_START_KEEP_DAYS * 864e5;
  const files = fs.readdirSync(dir);
  let old = 0, bytes = 0;
  for (const f of files) {
    const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) {
      old++; bytes += st.size;
      if (FIX) { try { fs.rmSync(p, { force: true }); actions++; } catch {} }
    }
  }
  if (FIX) reclaimedBytes += bytes;
  say(`  ${files.length} files, ${old} older than ${SESSION_START_KEEP_DAYS}d (${mb(bytes)}) -> ${FIX ? 'REMOVED' : 'would remove'}`);
  say(`  keeping ${files.length - old}`);
}

// ----------------------------------------------------------- 3. leaked tmp ---
function leakedTmp() {
  head('leaked .tmp writes');
  const roots = [`${CLAUDE}/relay`, `${CLAUDE}/sessions`, `${CLAUDE}/tasks`];
  const cutoff = Date.now() - TMP_KEEP_HOURS * 36e5;
  let n = 0, bytes = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tmp$/i.test(e.name)) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < cutoff) {
          n++; bytes += st.size;
          if (FIX) { try { fs.rmSync(p, { force: true }); actions++; } catch {} }
        }
      }
    }
  };
  roots.forEach((r) => fs.existsSync(r) && walk(r));
  if (FIX) reclaimedBytes += bytes;
  say(`  ${n} stale .tmp files (${mb(bytes)}) -> ${FIX ? 'REMOVED' : 'would remove'}`);
}

// ------------------------------------------------------ 4. .claude.json ------
function claudeJson() {
  head('~/.claude.json dead project entries');
  const F = `${HOME}/.claude.json`;
  const s = JSON.parse(fs.readFileSync(F, 'utf8'));
  const hasState = (v) =>
    (v.history || []).length || (v.allowedTools || []).length ||
    Object.keys(v.mcpServers || {}).length || (v.ignorePatterns || []).length;
  const dead = Object.entries(s.projects || {}).filter(([p, v]) => !fs.existsSync(p) && !hasState(v));
  say(`  ${Object.keys(s.projects || {}).length} entries, ${dead.length} gone-and-empty -> ${FIX ? 'REMOVING' : 'would remove'}`);
  if (!FIX || !dead.length) return;
  const before = fs.statSync(F).size;
  const fresh = JSON.parse(fs.readFileSync(F, 'utf8')); // re-read: other sessions write this
  for (const [p] of dead) if (!fs.existsSync(p)) { delete fresh.projects[p]; actions++; }
  const out = JSON.stringify(fresh, null, 2) + '\n';
  JSON.parse(out);
  fs.writeFileSync(F + '.tmp', out); fs.renameSync(F + '.tmp', F);
  reclaimedBytes += before - fs.statSync(F).size;
  say(`  now ${Object.keys(fresh.projects).length} entries`);
}

// --------------------------------------------- 5. settings.local.json --------
// The lookbehind below is the whole reason this function is trustworthy.
const PATHRE = /(?<![A-Za-z0-9/\\:])([A-Za-z]:[\\/][^"'\s)]{3,})/g;
const ONESHOT = /\b(pr\s+(view|merge|checks|diff)\s+\d{3,}|run\s+(view|rerun|watch)\s+\d{7,}|[0-9a-f]{40})\b/i;
const MERGE = /gh\s+pr\s+merge/i;

function localAllow(projectDirs) {
  head('settings.local.json permission rules');
  for (const d of projectDirs) {
    const F = `${d}/.claude/settings.local.json`;
    if (!fs.existsSync(F)) continue;
    const s = JSON.parse(fs.readFileSync(F, 'utf8'));
    const rules = s.permissions?.allow || [];
    const keep = [], dropped = [];
    for (const r of rules) {
      const paths = (r.match(PATHRE) || []).map((p) => p.replace(/\\/g, '/').replace(/[),;"'*]+$/, ''));
      const deadPath = paths.some((p) => p.length > 14 && !fs.existsSync(p));
      if (MERGE.test(r) || deadPath || ONESHOT.test(r)) dropped.push(r); else keep.push(r);
    }
    const merges = dropped.filter((r) => MERGE.test(r)).length;
    say(`  ${path.basename(d)}: ${rules.length} rules, ${dropped.length} dead${merges ? `  [${merges} STORED MERGE APPROVAL]` : ''} -> ${FIX ? 'REMOVING' : 'would remove'}`);
    if (!FIX || !dropped.length) continue;
    const before = fs.statSync(F).size;
    s.permissions.allow = keep;
    const out = JSON.stringify(s, null, 2) + '\n';
    JSON.parse(out);
    fs.writeFileSync(F + '.tmp', out); fs.renameSync(F + '.tmp', F);
    reclaimedBytes += before - fs.statSync(F).size;
    actions += dropped.length;
    say(`    now ${keep.length} rules`);
  }
}

// ---------------------------------------------------- 6. pressure report -----
function pressure() {
  head('machine pressure');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `$o=Get-CimInstance Win32_OperatingSystem;` +
      `$s=(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object {$_.CommandLine -like '*stream-json*'}).Count;` +
      `"$([int]($o.FreePhysicalMemory/1KB))|$([int]($o.TotalVisibleMemorySize/1KB))|$([math]::Round($o.FreeVirtualMemory/1MB,1))|$s"`
    ], { encoding: 'utf8', timeout: 20000 }).trim();
    const [freeMb, totalMb, commitGb, sessions] = out.split('|');
    say(`  sessions open : ${sessions}`);
    say(`  RAM free      : ${freeMb} MB of ${totalMb} MB`);
    say(`  COMMIT free   : ${commitGb} GB`);
    if (Number(sessions) >= 7 || Number(freeMb) < 1800) {
      say(`  >> PRESSURE. See the session ceiling in AGENTS.md §5. Close sessions down to 4.`);
    }
  } catch (e) { say('  (could not read: ' + e.message + ')'); }
}

// --------------------------------------------------------------- main --------
const projectDirs = ['F:/Phoenix Workforce/phoenix-workforce'].filter((d) => fs.existsSync(d));

say(`claude-hygiene  ${new Date().toISOString()}  mode=${FIX ? 'FIX' : 'REPORT'}`);
stalelocks(projectDirs);
sessionStarts();
leakedTmp();
claudeJson();
localAllow(projectDirs);
pressure();
say(`\n${FIX ? `DONE. ${actions} actions, ${mb(reclaimedBytes)} reclaimed.` : 'REPORT ONLY. Re-run with --fix to apply.'}`);

try {
  fs.appendFileSync(`${CLAUDE}/scripts/claude-hygiene.log`, log.join('\n') + '\n\n');
} catch {}
