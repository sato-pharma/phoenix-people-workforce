// ~/.claude/hooks/dev-server-reaper.mjs - when a Claude Code session ENDS, stop the dev server that
// session started, and never one that another session started or is still using.
//
// WHY THIS EXISTS. Physical RAM, not the session count, is what freezes and bluescreens this 16 GB laptop
// (AGENTS.md 5; the 2026-09-11 bugchecks). A Next dev server holds about 3.5 GB; a whole Claude session
// holds about 270 MB. Since 2026-09-12 mem-watchdog.ps1 exempts a dev server from every rule by the
// owner's decision - it never kills, trims or deprioritises one - and on 2026-09-17 the owner retired the
// heavy-job gate and turned the heavy queue into a passthrough, so nothing on this machine stops a dev
// server any more. (Amended 2026-09-21, the owner's choice: the watchdog stops a dev server again in two
// cases only - at or over 8 GB of commit, a runaway, and after 25 minutes with no work. One in use under
// 8 GB is still never touched.) A server therefore outlived the session that started it until someone noticed. This
// hook stops that server, and only that one. It gates nothing and refuses nothing: it is cleanup, not
// prevention, which is the half the owner kept.
//
// OWNERSHIP IS PROVEN, NEVER GUESSED. A session's commands run in shells spawned by its engine
// (claude.exe), so a server is that session's only when an unbroken parent chain leads from the server up
// to that engine - and every link was created no later than its child, so a recycled PID breaks the chain
// instead of forging one. The chain is walked while it still exists:
//   * when the session runs a dev-server command (PreToolUse on Bash and PowerShell, async so it adds no
//     latency): a detached settler waits for the port to open and records what opened it;
//   * when the session ends: a scan of every dev server still descending from the ending engine.
// A record keeps the root process's PID, creation time and full command line. A stop re-reads all three
// from a fresh process snapshot and stops nothing when any of them differs.
//
// WHEN IT STOPS ONE.
//   SessionEnd (other, logout, prompt_input_exit): a detached stopper waits PHX_REAPER_GRACE_SEC (45 s),
//     then stops every server the session owns - unless the same session reopened in another window, or
//     another open session used that port in the last 3 hours (that session then owns it; nothing stops).
//   SessionEnd (clear, resume): the window lives on, so its servers pass to the next session in it.
//   SessionStart: when records exist, a detached sweeper stops a server whose window closed with no
//     SessionEnd at all (the app was closed or crashed), after a 120 s grace and the same borrower rule.
// It never stops a process it did not record, a server that was running before this hook existed (unless
// it descends from the ending window), or a shell, cmd.exe or claude.exe, and it does nothing at all when
// a process snapshot fails. Every path exits 0.
//
// HOOKS:    PreToolUse Bash|PowerShell (async) · PostToolUse on the browser tools that name a localhost
//           port (async) · SessionStart · SessionEnd (timeout 20). No `if` filter anywhere: one was
//           measured letting 11 of 29 real commands through on 2026-09-17, so the filtering is done here.
// LOG:      ~/.claude/scripts/dev-server-reaper.log (Cairo time)
// STATE:    ~/.claude/scripts/dev-server-reaper/ (sessions, servers, borrows, handoff, intents, jobs)
// OFF:      "PHX_DEV_REAPER_OFF": "1" in the env block of ~/.claude/settings.json.
// STATUS:   node ~/.claude/hooks/dev-server-reaper.mjs status
// SELFTEST: node ~/.claude/hooks/dev-server-reaper.mjs --selftest   (no process is started or ended)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.USERPROFILE || os.homedir();
const SELF = fileURLToPath(import.meta.url);
const STATE = process.env.PHX_REAPER_STATE_DIR || path.join(HOME, '.claude', 'scripts', 'dev-server-reaper');
const LOG = process.env.PHX_REAPER_LOG || path.join(HOME, '.claude', 'scripts', 'dev-server-reaper.log');
const num = (name, dflt) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
};
const GRACE_SEC = num('PHX_REAPER_GRACE_SEC', 45);
const ORPHAN_GRACE_SEC = num('PHX_REAPER_ORPHAN_GRACE_SEC', 120);
const BORROW_TTL_SEC = num('PHX_REAPER_BORROW_TTL_SEC', 3 * 3600);
const SETTLE_SEC = num('PHX_REAPER_SETTLE_SEC', 360);
const POLL_MS = num('PHX_REAPER_POLL_MS', 2000);
const HANDOFF_TTL_MS = 10 * 60_000;
const LOG_MAX_BYTES = 300_000;
// Image names a live session's engine may carry. The end-to-end test adds node.exe for its stand-in engine.
const ENGINE_NAMES = new Set((process.env.PHX_REAPER_ENGINE_NAMES || 'claude.exe').toLowerCase().split(',').map((s) => s.trim()));
// Only one of these can be the ROOT of a recorded server - never a shell, never cmd.exe, never an engine.
const ROOT_IMAGES = new Set(['node.exe', 'pnpm.exe', 'bun.exe', 'yarn.exe', 'npm.exe']);
// Never ended, even when found inside a server's own subtree.
const NEVER_KILL = new Set(['claude.exe', 'explorer.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'system', 'msedge.exe', 'chrome.exe', 'code.exe']);
const dir = (name) => path.join(STATE, name);

// ---- small helpers ------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const safeId = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
const short = (sid) => String(sid ?? '?').slice(0, 8);
const folder = (cwd) => (cwd ? path.basename(String(cwd).replace(/[\\/]+$/, '')) : 'an unknown folder');
const cairo = (ms = Date.now()) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Africa/Cairo', hour12: false });
const ago = (ms) => `${Math.max(1, Math.round((Date.now() - ms) / 60_000))} min ago`;
const EPOCH_GAP_MS = 11644473600000n;
export const filetimeMs = (ft) => {
  try {
    return Number(BigInt(ft) / 10000n - EPOCH_GAP_MS);
  } catch {
    return NaN;
  }
};
// true when process A was created no later than process B (Windows FILETIME strings, compared exactly)
const notAfter = (a, b) => {
  try {
    return BigInt(a) <= BigInt(b);
  } catch {
    return false;
  }
};

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${cairo()} Cairo] ${line}\n`, 'utf8');
    if (fs.statSync(LOG).size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(LOG, 'utf8').split('\n');
      fs.writeFileSync(LOG, lines.slice(-1500).join('\n'), 'utf8');
    }
  } catch {}
}

function ensureDirs() {
  for (const d of ['sessions', 'servers', 'borrows', 'handoff', 'intents', 'jobs']) fs.mkdirSync(dir(d), { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 8) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {}
        throw e;
      }
      sleepSync(40);
    }
  }
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

function alive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function spawnDetached(args) {
  const child = spawn(process.execPath, [SELF, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

// ---- what counts as a dev server ----------------------------------------------------------------------
// Deliberately self-contained. This used to call classify() in ~/.claude/hooks/heavy-jobs-lib.mjs, but the
// owner retired the heavy-job gate and that library with it on 2026-09-17, while this hook was being
// built. Nothing here depends on a retired file. It recognises the shapes this machine actually launches:
// the Next dev binary and its start-server child, scripts/dev-server.mjs, a package manager running a
// `dev` script, and any of those wrapped in heavy-queue.mjs (a passthrough since 2026-09-17) or a shell.
const SEPARATORS = /&&|\|\||[;|\r\n]/;
const PM = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx']);
const PM_SCRIPT_FILES = { 'pnpm.cjs': 'pnpm', 'pnpm.js': 'pnpm', 'pnpm.mjs': 'pnpm', 'npm-cli.js': 'npm', 'yarn.js': 'yarn', 'yarn.cjs': 'yarn' };
const SHELLS = new Set(['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh']);
const DEV_SCRIPT = /^dev(?::[\w-]+)?$/i;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const QUEUE_FLAG = /^--(heavy|max-wait-min)(=\d+)?$/i;

function tokens(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  // a stray quote on an unquoted token is the seam left by splitting a compound command first:
  // bash -c "cd /f/x && node ... next dev"  ->  ... next  dev"
  while ((m = re.exec(String(s ?? '')))) out.push(m[1] ?? m[2] ?? m[3].replace(/^["']+|["']+$/g, ''));
  return out.filter((x) => x !== '');
}
const baseName = (t) => String(t).replace(/\\/g, '/').split('/').pop().toLowerCase();
const stripExe = (t) => t.replace(/\.(exe|cmd|bat|ps1)$/, '');

// heavy-queue.mjs [--max-wait-min N] [--heavy] <command ...> -> the command it was handed
function afterQueueFlags(args) {
  let k = 0;
  while (k < args.length && QUEUE_FLAG.test(args[k])) {
    const flag = args[k];
    k++;
    if (/^--max-wait-min$/i.test(flag) && k < args.length && /^\d+$/.test(args[k])) k++;
  }
  return args.slice(k);
}

function devFromTokens(t, depth) {
  if (depth > 4 || !t.length) return null;
  const head = stripExe(baseName(t[0]));
  const rest = t.slice(1);

  if (head === 'node') {
    const i = rest.findIndex((a) => !a.startsWith('-'));
    if (i < 0) return null;
    const script = baseName(rest[i]);
    const after = rest.slice(i + 1);
    if (script === 'heavy-queue.mjs') return devFromTokens(afterQueueFlags(after), depth + 1);
    if (PM_SCRIPT_FILES[script]) return devFromTokens([PM_SCRIPT_FILES[script], ...after], depth + 1);
    if (script === 'dev-server.mjs') return 'dev server (scripts/dev-server.mjs)';
    if (script === 'start-server.js') return 'next dev server';
    if (script === 'next' || script === 'next.js') return after.includes('dev') ? 'next dev' : null;
    return null;
  }

  if (PM.has(head)) {
    const args = rest.filter((x) => x !== '--');
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k++;
    if (k >= args.length) return null;
    if (/^(run|run-script|exec|dlx)$/i.test(args[k])) {
      k++;
      while (k < args.length && args[k].startsWith('-')) k++;
      if (k >= args.length) return null;
    }
    const pm = head === 'pnpx' ? 'pnpm' : head === 'bunx' ? 'bun' : head;
    if (DEV_SCRIPT.test(args[k])) return `${pm} run ${args[k].toLowerCase()}`;
    return devFromTokens(args.slice(k), depth + 1);
  }

  if (SHELLS.has(head)) {
    const i = rest.findIndex((x) => /^(-c|-command|--command|\/c|\/k|-file|-f)$/i.test(x));
    const inner = i >= 0 ? rest.slice(i + 1).join(' ') : rest.filter((x) => /\s/.test(x)).join(' ');
    return inner ? devFromCommand(inner, depth + 1) : null;
  }

  if (head === 'next') return rest.includes('dev') ? 'next dev' : null;
  return null;
}

function devFromCommand(cmd, depth = 0) {
  for (const piece of String(cmd ?? '').split(SEPARATORS)) {
    const t = tokens(piece.trim());
    while (t.length && ENV_PREFIX.test(t[0])) t.shift();
    const label = devFromTokens(t, depth);
    if (label) return label;
  }
  return null;
}

// A command a session is about to run: does it start a dev server?
export const commandLabel = (cmd) => devFromCommand(cmd, 0);

// A running process, as a snapshot shows it. Only a real dev root qualifies - never a shell or an engine.
export function processLabel(name, cmdline) {
  if (!ROOT_IMAGES.has(String(name ?? '').toLowerCase())) return null;
  return devFromCommand(cmdline, 0);
}

export function borrowPorts(text) {
  const ports = new Set();
  const re = /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})(?!\d)/gi;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    const p = Number(m[1]);
    if (p > 0 && p < 65536) ports.add(p);
  }
  return [...ports];
}

export function intendedPort(cmd) {
  const m = /(?:--port(?:\s+|=)|(?:^|\s)-p\s+|\bPORT=)(\d{2,5})(?!\d)/.exec(String(cmd ?? ''));
  return m ? Number(m[1]) : 3000;
}

// ---- process snapshot and listening ports ---------------------------------------------------------------
const PS_SNAPSHOT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$u = [string][char]31; $r = [string][char]30',
  '$sb = New-Object System.Text.StringBuilder',
  'foreach ($p in Get-CimInstance Win32_Process) {',
  '  $c = 0; if ($p.CreationDate) { $c = $p.CreationDate.ToFileTimeUtc() }',
  '  [void]$sb.Append([string]::Join($u, [string[]]@($p.ProcessId, $p.ParentProcessId, $c, $p.Name, $p.WorkingSetSize, $p.CommandLine))).Append($r)',
  '}',
  '[Console]::Out.Write($sb.ToString())',
].join('\n');

export function parseSnapshot(out) {
  const procs = new Map();
  for (const rec of String(out ?? '').replace(/^\uFEFF/, '').split('\x1e')) {
    const f = rec.split('\x1f');
    if (f.length < 6) continue;
    const pid = Number(f[0].trim());
    if (!Number.isInteger(pid) || !/^\d+$/.test(f[2].trim())) continue;
    procs.set(pid, { pid, ppid: Number(f[1]), created: f[2].trim(), name: f[3], ws: Number(f[4]) || 0, cmd: f.slice(5).join('\x1f') });
  }
  return procs;
}

function snapshot() {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_SNAPSHOT, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const procs = parseSnapshot(out);
  if (procs.size < 20) throw new Error(`the process snapshot returned only ${procs.size} processes`);
  return procs;
}

export function parseNetstat(out) {
  const res = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(\S+)\s+\S*\s*(\d+)\s*$/i.exec(line);
    if (m && /:0$/.test(m[3])) res.push({ addr: m[1], port: Number(m[2]), pid: Number(m[4]) });
  }
  return res;
}

function listeners() {
  try {
    return parseNetstat(execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    return [];
  }
}

function accepts(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Ports that still accept a connection after waiting up to waitMs (empty = every one refuses).
async function stillOpen(ports, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const open = [];
    for (const p of ports || []) if ((await accepts(p, '127.0.0.1')) || (await accepts(p, '::1'))) open.push(p);
    if (!open.length || Date.now() > deadline) return open;
    await sleep(500);
  }
}

// ---- ownership: the parent chain -------------------------------------------------------------------------
// [pid, its parent, ..., enginePid] when an unbroken chain leads there, else null. A parent created AFTER
// its child means that PID was recycled, so the chain is broken. Another claude.exe on the way means the
// process belongs to that engine, not this one.
export function chainTo(pid, enginePid, snap) {
  const chain = [];
  let cur = snap.get(pid);
  for (let hops = 0; cur && hops < 64; hops++) {
    chain.push(cur);
    if (cur.pid === enginePid) return chain;
    if (hops > 0 && String(cur.name).toLowerCase() === 'claude.exe') return null;
    const parent = snap.get(cur.ppid);
    if (!parent || parent.pid === cur.pid || !notAfter(parent.created, cur.created)) return null;
    cur = parent;
  }
  return null;
}

// The dev process nearest the engine: stopping it and everything under it stops the whole server.
export function topDev(chain) {
  for (let i = chain.length - 2; i >= 0; i--) if (processLabel(chain[i].name, chain[i].cmd)) return chain[i];
  return null;
}

export function subtree(root, snap) {
  const kids = new Map();
  for (const p of snap.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [root];
  const seen = new Set([root.pid]);
  for (let i = 0; i < out.length; i++) {
    for (const k of kids.get(out[i].pid) || []) {
      if (seen.has(k.pid) || !notAfter(out[i].created, k.created) || NEVER_KILL.has(String(k.name).toLowerCase())) continue;
      seen.add(k.pid);
      out.push(k);
    }
  }
  return out;
}

export function scanEngine(enginePid, snap) {
  const roots = new Map();
  for (const p of snap.values()) {
    if (!processLabel(p.name, p.cmd)) continue;
    const chain = chainTo(p.pid, enginePid, snap);
    const root = chain && topDev(chain);
    if (root) roots.set(root.pid, root);
  }
  return [...roots.values()];
}

export function verifyRoot(rec, snap) {
  const p = snap.get(rec?.root?.pid);
  if (!p) return { ok: false, gone: true, reason: 'its process had already exited' };
  if (p.created !== rec.root.created) return { ok: false, reason: `PID ${p.pid} now belongs to a different process (${p.name}, started ${cairo(filetimeMs(p.created))})` };
  if (p.cmd !== rec.root.cmd) return { ok: false, reason: `PID ${p.pid} runs a different command line now` };
  if (!processLabel(p.name, p.cmd)) return { ok: false, reason: `PID ${p.pid} no longer looks like a dev server` };
  return { ok: true, proc: p };
}

// ---- state: sessions, server records, borrows -----------------------------------------------------------
const sessionFile = (sid) => path.join(dir('sessions'), `${safeId(sid)}.json`);

function register(sid, enginePid, extra = {}) {
  if (!safeId(sid) || !(enginePid > 0)) return;
  const prev = readJson(sessionFile(sid)) || {};
  const next = { ...prev, ...extra, sid, enginePid, at: Date.now() };
  delete next.endedAt;
  delete next.endReason;
  writeJson(sessionFile(sid), next);
}

function markEnded(sid, enginePid, reason) {
  const prev = readJson(sessionFile(sid)) || {};
  writeJson(sessionFile(sid), { ...prev, sid, enginePid, endedAt: Date.now(), endReason: reason });
}

function records() {
  let names = [];
  try {
    names = fs.readdirSync(dir('servers')).filter((f) => f.endsWith('.json'));
  } catch {}
  return names.map((f) => ({ file: path.join(dir('servers'), f), rec: readJson(path.join(dir('servers'), f)) })).filter((x) => x.rec && x.rec.root);
}

const describe = (rec) => `${rec.label} on port ${rec.ports?.length ? rec.ports.join('+') : '(none yet)'} (PID ${rec.root.pid}, ${folder(rec.cwd)})`;

function upsertRecord(root, snap, ls, meta) {
  const pids = new Set(subtree(root, snap).map((p) => p.pid));
  const ports = ls.filter((l) => pids.has(l.pid)).map((l) => l.port);
  const id = `${root.pid}-${root.created}`;
  const file = path.join(dir('servers'), `${id}.json`);
  const rec = readJson(file) || {
    id,
    ownerSid: meta.sid,
    ownerEngine: meta.engine ? { pid: meta.engine.pid, created: meta.engine.created } : null,
    root: { pid: root.pid, created: root.created, name: root.name, cmd: root.cmd },
    label: processLabel(root.name, root.cmd),
    cwd: meta.cwd,
    startedBy: meta.intent,
    recordedAt: Date.now(),
    recordedBy: meta.by,
    ports: [],
    history: [],
  };
  rec.ports = [...new Set([...(rec.ports || []), ...ports])].sort((a, b) => a - b);
  writeJson(file, rec);
  return rec;
}

// The newest OTHER open session that used one of this server's ports since shortly before it started.
function liveBorrower(rec, snap) {
  let best = null;
  const startedMs = filetimeMs(rec.root.created) - 60_000;
  for (const port of rec.ports || []) {
    let names = [];
    try {
      names = fs.readdirSync(dir('borrows')).filter((f) => f.startsWith(`${port}-`) && f.endsWith('.json'));
    } catch {}
    for (const name of names) {
      const b = readJson(path.join(dir('borrows'), name));
      if (!b || b.sid === rec.ownerSid || !(b.at >= startedMs) || Date.now() - b.at > BORROW_TTL_SEC * 1000) continue;
      const s = readJson(sessionFile(b.sid));
      if (!s || s.endedAt) continue;
      const eng = snap.get(s.enginePid);
      if (!eng || !ENGINE_NAMES.has(String(eng.name).toLowerCase()) || filetimeMs(eng.created) > s.at + 5000) continue;
      if (!best || b.at > best.at) best = { ...b, cwd: s.cwd, engine: eng };
    }
  }
  return best;
}

// Is the session that owns this record still open in some window?
function ownerAlive(rec, snap, file) {
  const s = readJson(sessionFile(rec.ownerSid));
  if (s && !s.endedAt) {
    const eng = snap.get(s.enginePid);
    if (eng && ENGINE_NAMES.has(String(eng.name).toLowerCase()) && filetimeMs(eng.created) <= s.at + 5000) {
      if (rec.ownerEngine?.pid !== eng.pid || rec.ownerEngine?.created !== eng.created) {
        rec.ownerEngine = { pid: eng.pid, created: eng.created };
        writeJson(file, rec);
      }
      return true;
    }
  }
  const e = rec.ownerEngine && snap.get(rec.ownerEngine.pid);
  return Boolean(e && e.created === rec.ownerEngine.created && !(s && s.endedAt));
}

// Verify, then hand to a borrower or stop. Returns what happened.
async function settle(file, rec, snap, why) {
  const v = verifyRoot(rec, snap);
  if (!v.ok) {
    log(`${v.gone ? 'GONE ' : 'SKIP '} ${describe(rec)} | ${why} | nothing stopped: ${v.reason}`);
    removeFile(file);
    return v.gone ? 'gone' : 'skipped';
  }
  const b = liveBorrower(rec, snap);
  if (b) {
    rec.history = [...(rec.history || []), { at: Date.now(), event: 'moved', from: rec.ownerSid, to: b.sid, why }];
    rec.ownerSid = b.sid;
    rec.ownerEngine = { pid: b.engine.pid, created: b.engine.created };
    writeJson(file, rec);
    log(`MOVE  ${describe(rec)} | ${why}, but the open session in ${folder(b.cwd)} (${short(b.sid)}) used port ${b.port} ${ago(b.at)} - it owns the server now and nothing was stopped`);
    return 'moved';
  }
  const tree = subtree(v.proc, snap);
  const mb = Math.round(tree.reduce((sum, p) => sum + p.ws, 0) / 1048576);
  const ended = new Set();
  const failed = [];
  const end = (p) => {
    try {
      process.kill(p.pid);
      ended.add(p.pid);
    } catch (e) {
      if (alive(p.pid)) failed.push(`${p.pid} (${e.code})`);
    }
  };
  for (const p of tree) end(p); // root first, so nothing above respawns what is below
  await sleep(1500);
  try {
    // a child spawned after the snapshot still points at its (now ended) parent
    const again = snapshot();
    for (const p of again.values()) {
      if (ended.has(p.pid) || !ended.has(p.ppid)) continue;
      const parent = tree.find((t) => t.pid === p.ppid);
      if (parent && notAfter(parent.created, p.created) && !NEVER_KILL.has(String(p.name).toLowerCase())) end(p);
    }
  } catch {}
  const open = rec.ports?.length ? await stillOpen(rec.ports, 15_000) : [];
  const portText = !rec.ports?.length ? 'it had not opened a port yet' : open.length ? `port ${open.join('+')} STILL ACCEPTS CONNECTIONS` : `port ${rec.ports.join('+')} now refuses connections`;
  log(`STOP  ${describe(rec)} | ${why} | ended ${ended.size} process(es), about ${mb.toLocaleString('en-US')} MB | ${portText}${failed.length ? ` | could not end ${failed.join(', ')}` : ''}`);
  removeFile(file);
  return 'stopped';
}

// ---- entry points -------------------------------------------------------------------------------------------
// PreToolUse on Bash and PowerShell. Writes a few small files and, for a dev start, spawns the settler.
export function noteCommand(input, enginePid = process.ppid) {
  if (process.env.PHX_DEV_REAPER_OFF) return;
  try {
    const cmd = input?.tool_input?.command;
    const sid = input?.session_id;
    if (typeof cmd !== 'string' || !cmd || !safeId(sid)) return;
    const label = commandLabel(cmd);
    const ports = borrowPorts(cmd);
    if (label) ports.push(intendedPort(cmd));
    if (!label && !ports.length) return;
    ensureDirs();
    register(sid, enginePid, { cwd: input.cwd });
    for (const port of new Set(ports)) {
      writeJson(path.join(dir('borrows'), `${port}-${safeId(sid)}.json`), { port, sid, enginePid, at: Date.now(), via: input.tool_name });
    }
    if (!label) return;
    const id = safeId(input.tool_use_id) || `t${Date.now()}`;
    const file = path.join(dir('intents'), `${id}.json`);
    writeJson(file, { id, sid, enginePid, cmd: cmd.slice(0, 2000), label, cwd: input.cwd, at: Date.now() });
    spawnDetached(['settle', file]);
    log(`START ${label} requested by the session in ${folder(input.cwd)} (${short(sid)}) | watching for the port it opens`);
  } catch (e) {
    log(`ERROR noteCommand: ${e?.message || e}`);
  }
}

function launchPort(cwd, name) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'launch.json'), 'utf8'));
    const c = (j.configurations || []).find((x) => x.name === name);
    return Number(c?.port) || borrowPorts(c?.url)[0] || null;
  } catch {
    return null;
  }
}

// PostToolUse on the browser tools: using a port makes this session a borrower, never an owner.
function noteBrowser(input, enginePid) {
  const sid = input.session_id;
  if (!safeId(sid)) return;
  const ti = input.tool_input || {};
  const ports = borrowPorts(JSON.stringify(ti));
  if (/preview_start$/.test(String(input.tool_name)) && ti.name) {
    const p = launchPort(input.cwd, ti.name);
    if (p) ports.push(p);
  }
  if (!ports.length) return;
  register(sid, enginePid, { cwd: input.cwd });
  for (const port of new Set(ports)) {
    writeJson(path.join(dir('borrows'), `${port}-${safeId(sid)}.json`), { port, sid, enginePid, at: Date.now(), via: input.tool_name });
  }
}

function housekeeping() {
  const stamp = path.join(STATE, 'housekeeping.stamp');
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < 3600_000) return;
  } catch {}
  try {
    fs.writeFileSync(stamp, cairo());
    const owners = new Set(records().map((x) => x.rec.ownerSid));
    const maxAge = { sessions: 3 * 86400_000, borrows: BORROW_TTL_SEC * 1000, intents: 2 * 3600_000, jobs: 2 * 3600_000, handoff: HANDOFF_TTL_MS };
    for (const [d, age] of Object.entries(maxAge)) {
      for (const f of fs.readdirSync(dir(d))) {
        const file = path.join(dir(d), f);
        if (d === 'sessions' && owners.has(f.replace(/\.json$/, ''))) continue;
        if (Date.now() - fs.statSync(file).mtimeMs > age) removeFile(file);
      }
    }
  } catch {}
}

function onSessionStart(input, enginePid) {
  const sid = input.session_id;
  if (!safeId(sid)) return;
  register(sid, enginePid, { cwd: input.cwd, source: input.source });
  const handoff = path.join(dir('handoff'), `${enginePid}.json`);
  const h = readJson(handoff);
  if (h && h.fromSid !== sid) {
    if (Date.now() - h.at < HANDOFF_TTL_MS) {
      for (const { file, rec } of records()) {
        if (rec.ownerSid !== h.fromSid) continue;
        rec.history = [...(rec.history || []), { at: Date.now(), event: 'handoff', from: h.fromSid, to: sid, why: h.reason }];
        rec.ownerSid = sid;
        writeJson(file, rec);
        log(`PASS  ${describe(rec)} | /${h.reason} in the same window: the session that follows (${short(sid)}) owns it now`);
      }
    }
    removeFile(handoff);
  }
  housekeeping();
  if (!records().length) return;
  const stamp = path.join(STATE, 'sweep.stamp');
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < 60_000) return;
  } catch {}
  fs.writeFileSync(stamp, cairo());
  spawnDetached(['sweep']);
}

function onSessionEnd(input, enginePid) {
  const sid = input.session_id;
  if (!safeId(sid)) return;
  const reason = String(input.reason || 'other');
  if (reason === 'clear' || reason === 'resume') {
    // This session really is over - only the window survives - so it is marked ended like any other.
    // Leaving it open let its own use of the port count as a live borrower and protected the server for
    // good (caught by the end-to-end test, 2026-09-17). The handoff below re-owns the server instead, and
    // the sweeper's grace covers the second between the two hooks.
    markEnded(sid, enginePid, reason);
    writeJson(path.join(dir('handoff'), `${enginePid}.json`), { fromSid: sid, at: Date.now(), reason });
    return;
  }
  markEnded(sid, enginePid, reason);
  const owned = records().some((x) => x.rec.ownerSid === sid);
  const jobFile = path.join(dir('jobs'), `${safeId(sid)}-${Date.now()}.json`);
  const job = { sid, enginePid, reason, cwd: input.cwd, endedAt: Date.now(), scanned: [], scan: 'running' };
  writeJson(jobFile, job);
  let stopper = false;
  if (owned) {
    spawnDetached(['stop', jobFile]); // before the scan, so a slow snapshot cannot cost the records already held
    stopper = true;
  }
  try {
    const snap = snapshot();
    const eng = snap.get(enginePid);
    if (eng) {
      const ls = listeners();
      for (const root of scanEngine(enginePid, snap)) {
        job.scanned.push(upsertRecord(root, snap, ls, { sid, engine: eng, by: 'session-end scan', cwd: input.cwd }).id);
      }
    }
    job.scan = 'done';
  } catch (e) {
    job.scan = `failed: ${e?.message || e}`;
  }
  writeJson(jobFile, job);
  if (!stopper && job.scanned.length) {
    spawnDetached(['stop', jobFile]);
    stopper = true;
  }
  if (!stopper) removeFile(jobFile);
  else log(`END   the session in ${folder(input.cwd)} (${short(sid)}) ended (${reason}) | stopping what it owns in ${GRACE_SEC}s unless it reopens or another open session is using it | session-end scan: ${job.scan}, ${job.scanned.length} found`);
}

async function runSettle(intentFile) {
  const it = readJson(intentFile);
  if (!it) return;
  const deadline = it.at + SETTLE_SEC * 1000;
  const key = (l) => `${l.port}:${l.pid}`;
  const baseline = new Set(listeners().map(key));
  const rejected = new Set();
  let found = 0;
  try {
    while (Date.now() < deadline && !found) {
      const age = Date.now() - it.at;
      await sleep(age < 60_000 ? POLL_MS : age < 300_000 ? Math.max(POLL_MS, 5000) : 15_000);
      if (!alive(it.enginePid)) {
        log(`WATCH ${it.label} from ${folder(it.cwd)} (${short(it.sid)}): the window closed before a port opened - the session-end scan covers it`);
        return;
      }
      const ls = listeners();
      const fresh = [...new Set(ls.filter((l) => !baseline.has(key(l)) && !rejected.has(l.pid)).map((l) => l.pid))];
      if (!fresh.length) continue;
      const snap = snapshot();
      for (const pid of fresh) {
        const chain = chainTo(pid, it.enginePid, snap);
        const root = chain && topDev(chain);
        if (!root || filetimeMs(root.created) < it.at - 30_000) {
          rejected.add(pid);
          continue;
        }
        const rec = upsertRecord(root, snap, ls, { sid: it.sid, engine: snap.get(it.enginePid), by: 'settler', cwd: it.cwd, intent: it.cmd });
        log(`OWN   ${describe(rec)} | started by the session in ${folder(it.cwd)} (${short(it.sid)}); stops when that session ends`);
        found++;
      }
    }
    if (!found) log(`WATCH ${it.label} from ${folder(it.cwd)} (${short(it.sid)}): no new server of this session's opened a port within ${Math.round(SETTLE_SEC / 60)} min (it reused one, it failed, or it was launched outside the session's own shell)`);
  } finally {
    removeFile(intentFile);
  }
}

async function runStop(jobFile) {
  await sleep(GRACE_SEC * 1000);
  const job = readJson(jobFile);
  if (!job) return;
  try {
    const s = readJson(sessionFile(job.sid));
    if (s && !s.endedAt && s.at > job.endedAt && s.enginePid !== job.enginePid && alive(s.enginePid)) {
      log(`KEEP  the session in ${folder(job.cwd)} (${short(job.sid)}) reopened in another window within ${GRACE_SEC}s - its servers stay with it`);
      return;
    }
    const mine = records().filter(({ rec }) => rec.ownerSid === job.sid || (job.scanned || []).includes(rec.id));
    if (!mine.length) return;
    const snap = snapshot();
    for (const { file, rec } of mine) await settle(file, rec, snap, `the session in ${folder(job.cwd)} (${short(job.sid)}) ended (${job.reason})`);
  } catch (e) {
    log(`ERROR stop ${short(job.sid)}: ${e?.message || e} - nothing further stopped`);
  } finally {
    removeFile(jobFile);
  }
}

function takeLock(name, staleMs = 15 * 60_000) {
  const file = path.join(STATE, `${name}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return () => removeFile(file);
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      const l = readJson(file);
      if (l && Date.now() - l.at < staleMs && alive(l.pid)) return null;
      removeFile(file);
    }
  }
  return null;
}

function pendingJobFor(sid) {
  try {
    return fs.readdirSync(dir('jobs')).some((f) => f.startsWith(`${safeId(sid)}-`) && Date.now() - fs.statSync(path.join(dir('jobs'), f)).mtimeMs < 10 * 60_000);
  } catch {
    return false;
  }
}

async function runSweep() {
  const release = takeLock('sweep');
  if (!release) return;
  try {
    if (!records().length) return;
    let snap = snapshot();
    const orphans = new Set();
    for (const { file, rec } of records()) {
      const v = verifyRoot(rec, snap);
      if (!v.ok) {
        log(`${v.gone ? 'GONE ' : 'SKIP '} ${describe(rec)} | found by the sweep | nothing stopped: ${v.reason}`);
        removeFile(file);
        continue;
      }
      if (!ownerAlive(rec, snap, file) && !pendingJobFor(rec.ownerSid)) orphans.add(rec.id);
    }
    if (!orphans.size) return;
    log(`SWEEP ${orphans.size} server(s) whose session's window is gone with no session end; checking again in ${ORPHAN_GRACE_SEC}s`);
    await sleep(ORPHAN_GRACE_SEC * 1000);
    snap = snapshot();
    for (const { file, rec } of records()) {
      if (!orphans.has(rec.id)) continue;
      if (ownerAlive(rec, snap, file)) {
        log(`KEEP  ${describe(rec)} | its session is open again`);
        continue;
      }
      await settle(file, rec, snap, `the window of the session in ${folder(rec.cwd)} (${short(rec.ownerSid)}) closed with no session end`);
    }
  } catch (e) {
    log(`ERROR sweep: ${e?.message || e} - nothing further stopped`);
  } finally {
    release();
  }
}

// Cheap pre-filter: a command worth parsing names a dev script, a dev-server file, or a localhost port.
// It carries the `if` filter's job, because a hook `if` was measured letting 11 of 29 real commands through.
export const REAPER_HINT = /(?<![\w/.-])dev(?![\w-])|dev-server\.mjs|start-server\.js|localhost:\d|127\.0\.0\.1:\d|\[::1\]:\d|0\.0\.0\.0:\d/i;

async function hookMain() {
  if (process.env.PHX_DEV_REAPER_OFF) return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return;
  }
  const ev = input?.hook_event_name;
  const enginePid = process.ppid; // exec-form hook: the parent is the session's engine (measured 2026-09-17)
  if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    if (input.tool_name === 'Bash' || input.tool_name === 'PowerShell') {
      // the cheap path first: an ordinary command costs one regex and nothing else
      const cmd = input?.tool_input?.command;
      if (typeof cmd !== 'string' || !REAPER_HINT.test(cmd)) return;
      return noteCommand(input, enginePid);
    }
    ensureDirs();
    return noteBrowser(input, enginePid);
  }
  ensureDirs();
  if (ev === 'SessionStart') return onSessionStart(input, enginePid);
  if (ev === 'SessionEnd') return onSessionEnd(input, enginePid);
}

function status() {
  const recs = records();
  console.log(`dev-server reaper state: ${STATE}`);
  console.log(`${recs.length} recorded server(s)`);
  for (const { rec } of recs) {
    const s = readJson(sessionFile(rec.ownerSid));
    console.log(`  ${describe(rec)} | owner: session in ${folder(s?.cwd || rec.cwd)} (${short(rec.ownerSid)})${s?.endedAt ? ` ended ${cairo(s.endedAt)}` : ''} | recorded ${cairo(rec.recordedAt)} by ${rec.recordedBy}`);
  }
  for (const d of ['sessions', 'borrows', 'intents', 'jobs', 'handoff']) {
    let n = 0;
    try {
      n = fs.readdirSync(dir(d)).length;
    } catch {}
    console.log(`${d}: ${n}`);
  }
}

// ---- self-test: pure functions only, no process is started or ended -------------------------------------
function selftest() {
  let fails = 0;
  let count = 0;
  const check = (name, got, expected) => {
    count++;
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);
  };

  const cmds = [
    ['node node_modules/next/dist/bin/next dev --webpack --port 3000', 'next dev'],
    ['cd "F:/Phoenix Workforce/_wt-a" && node node_modules/next/dist/bin/next dev --webpack --port 3100', 'next dev'],
    ['pnpm run dev', 'pnpm run dev'],
    ['pnpm dev', 'pnpm run dev'],
    ['pnpm run dev:webpack', 'pnpm run dev:webpack'],
    ['npm run dev --silent', 'npm run dev'],
    ['PORT=3300 pnpm run dev', 'pnpm run dev'],
    ['npx next dev -p 3200', 'next dev'],
    ['node scripts/dev-server.mjs', 'dev server (scripts/dev-server.mjs)'],
    ['node "C:/Users/satoh/.claude/scripts/heavy-queue.mjs" pnpm run dev', 'pnpm run dev'],
    ['node C:\\Users\\satoh\\.claude\\scripts\\heavy-queue.mjs --max-wait-min 30 node node_modules/next/dist/bin/next dev --webpack', 'next dev'],
    ['bash -c "cd /f/x && node node_modules/next/dist/bin/next dev"', 'next dev'],
    ['node "C:/Users/satoh/.claude/scripts/heavy-queue.mjs" pnpm run typecheck', null],
    ['pnpm run build', null],
    ['pnpm run test', null],
    ['rg "next dev" src', null],
    ['git log --oneline -5 -- scripts/dev-server.mjs', null],
    ['curl -s http://localhost:3000/api/healthz', null],
    ['echo dev', null],
    ['cat /dev/null', null],
  ];
  for (const [cmd, label] of cmds) check(`commandLabel | ${cmd}`, commandLabel(cmd), label);

  // the hint must let every real dev start through; anything else it lets through costs one regex
  for (const [cmd, label] of cmds) if (label) check(`REAPER_HINT lets it through | ${cmd.slice(0, 46)}`, REAPER_HINT.test(cmd), true);
  check('REAPER_HINT ignores an ordinary command', REAPER_HINT.test('git status && rg TODO src'), false);
  check('REAPER_HINT ignores /dev/null', REAPER_HINT.test('cat x 2>/dev/null'), false);
  check('REAPER_HINT catches a localhost port', REAPER_HINT.test('curl -s http://localhost:3100/'), true);

  const procs = [
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" F:\\x\\node_modules\\next\\dist\\bin\\next dev --webpack --port 3000', 'next dev'],
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" "F:\\Phoenix Workforce\\phoenix-workforce\\node_modules\\next\\dist\\server\\lib\\start-server.js"', 'next dev server'],
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\satoh\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" run dev', 'pnpm run dev'],
    ['node.exe', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\satoh\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs" run build', null],
    ['node.exe', 'node "C:/Users/satoh/.claude/scripts/heavy-queue.mjs" pnpm run dev', 'pnpm run dev'],
    ['node.exe', 'node scripts/dev-server.mjs', 'dev server (scripts/dev-server.mjs)'],
    ['pnpm.exe', 'pnpm run dev', 'pnpm run dev'],
    ['bash.exe', 'bash -c "node node_modules/next/dist/bin/next dev --webpack"', null],
    ['cmd.exe', 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "node scripts/dev-server.mjs"', null],
    ['claude.exe', 'claude.exe next dev', null],
    ['powershell.exe', 'powershell -NoProfile -Command "pnpm run dev"', null],
  ];
  for (const [name, cmd, label] of procs) check(`processLabel ${name} | ${cmd.slice(0, 60)}`, processLabel(name, cmd), label);

  check('borrowPorts', borrowPorts('curl http://localhost:3000/a && curl 127.0.0.1:3100/b; echo [::1]:3200'), [3000, 3100, 3200]);
  check('borrowPorts in a browser payload', borrowPorts(JSON.stringify({ url: 'http://localhost:3999/admin' })), [3999]);
  check('borrowPorts none', borrowPorts('echo nothing:3000'), []);
  check('intendedPort --port', intendedPort('next dev --port 3100'), 3100);
  check('intendedPort --port=', intendedPort('next dev --port=3150'), 3150);
  check('intendedPort -p', intendedPort('next dev -p 3200'), 3200);
  check('intendedPort PORT=', intendedPort('PORT=3300 pnpm run dev'), 3300);
  check('intendedPort default', intendedPort('pnpm run dev'), 3000);

  const ns = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:3000         127.0.0.1:51000        ESTABLISHED     4242',
    '  TCP    [::]:3100              [::]:0                 LISTENING       5353',
    '  UDP    0.0.0.0:500            *:*                                    99',
  ].join('\r\n');
  check('parseNetstat keeps listeners only', parseNetstat(ns).map((l) => `${l.port}:${l.pid}`), ['3000:4242', '3100:5353']);

  const U = '\x1f';
  const R = '\x1e';
  const row = (pid, ppid, created, name, cmd) => [pid, ppid, created, name, 1048576, cmd].join(U) + R;
  const snapText =
    '\uFEFF' +
    row(100, 4, 1000, 'claude.exe', 'claude') +
    row(200, 100, 2000, 'bash.exe', 'bash -c x') +
    row(300, 200, 3000, 'node.exe', 'node node_modules/next/dist/bin/next dev --port 3999') +
    row(400, 300, 4000, 'node.exe', 'node F:/a/node_modules/next/dist/server/lib/start-server.js') +
    row(500, 300, 2500, 'node.exe', 'node old.js') +
    row(600, 400, 5000, 'node.exe', 'node worker.js');
  const snap = parseSnapshot(snapText);
  check('parseSnapshot reads every row, BOM included', [...snap.keys()], [100, 200, 300, 400, 500, 600]);
  check('chainTo intact chain', chainTo(400, 100, snap)?.map((p) => p.pid), [400, 300, 200, 100]);
  check('topDev picks the dev process nearest the engine', topDev(chainTo(400, 100, snap)).pid, 300);
  check('chainTo another engine', chainTo(400, 999, snap), null);
  check('subtree skips a child created before its parent (recycled PID)', subtree(snap.get(300), snap).map((p) => p.pid), [300, 400, 600]);
  check('scanEngine finds one root', scanEngine(100, snap).map((p) => p.pid), [300]);
  const recycled = new Map(snap);
  recycled.set(200, { ...snap.get(200), created: '3500' });
  check('chainTo broken by a parent younger than its child', chainTo(400, 100, recycled), null);
  const nested = new Map(snap);
  nested.set(150, { pid: 150, ppid: 100, created: '1500', name: 'claude.exe', ws: 0, cmd: 'claude' });
  nested.set(200, { ...snap.get(200), ppid: 150 });
  check('chainTo stops at a nested engine', chainTo(400, 100, nested), null);

  const rec = { root: { pid: 300, created: '3000', name: 'node.exe', cmd: snap.get(300).cmd } };
  check('verifyRoot same process', verifyRoot(rec, snap).ok, true);
  check('verifyRoot different creation time', verifyRoot({ root: { ...rec.root, created: '2999' } }, snap).ok, false);
  check('verifyRoot different command line', verifyRoot({ root: { ...rec.root, cmd: 'node other.js' } }, snap).ok, false);
  check('verifyRoot gone', verifyRoot({ root: { ...rec.root, pid: 777 } }, snap).gone, true);
  check('filetimeMs', filetimeMs('133700000000000000'), 1725526400000);

  console.log(`SELFTEST dev-server-reaper: ${count} cases, ${fails} failed`);
  return fails;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (invoked) {
  const mode = process.argv[2];
  try {
    if (mode === '--selftest') process.exitCode = selftest() ? 1 : 0;
    else if (mode === 'status') status();
    else if (mode === 'settle') await runSettle(process.argv[3]);
    else if (mode === 'stop') await runStop(process.argv[3]);
    else if (mode === 'sweep') await runSweep();
    else await hookMain();
  } catch (e) {
    log(`ERROR ${mode || 'hook'}: ${e?.stack || e}`);
  }
  if (mode !== '--selftest') process.exitCode = 0;
}
