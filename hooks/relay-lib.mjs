// Shared library for the two-account relay.
//
// WHY THIS EXISTS
// The owner runs two Claude Code Max accounts and switches when one hits its limit.
// Two facts about this machine drive the whole design (both verified 2026-08-13):
//   1. Transcripts are keyed by PROJECT PATH, not by account. ~/.claude/projects/<slug>/
//      held 520 top-level transcripts and NOT ONE carried an accountUuid. So `claude --resume`
//      still lists them after a /login switch — the history was never actually lost.
//   2. ~/.claude.json has exactly ONE `oauthAccount` slot. Switching overwrites it. That is
//      why nothing on disk remembers the other account, its usage, or its reset time.
// So: (1) is already solved by --resume, and this library carries the WORKING STATE that a
// fresh session lacks; (2) has to be built from scratch, which is what the usage ledger is.
//
// HONEST LIMITS OF THE USAGE NUMBERS
// Claude Code does NOT persist rate-limit or reset data to disk — the only `rate_limit` string
// in ~/.claude.json is a promo-notice feature flag. So these totals are counted from the
// transcripts' own `usage` blocks, and the percentage is measured against the spend at the
// owner's OWN observed limit hits, not against any published allowance. Before the first
// recorded limit hit there is no percentage, and the code says so rather than guessing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.USERPROFILE || os.homedir();
export const RELAY = path.join(HOME, '.claude', 'relay');
export const BATONS = path.join(RELAY, 'batons');
export const USAGE = path.join(RELAY, 'usage');
export const STATE = path.join(RELAY, 'state');
export const ACCOUNTS_FILE = path.join(RELAY, 'accounts.json');

export const WINDOW_MS = 5 * 3600 * 1000; // Max plans roll on a 5-hour session window
export const WEEK_MS = 7 * 86_400_000;
export const BATON_STALE_MS = 24 * 3600 * 1000;

/**
 * Relative cost of each effort level, per model, normalised so that model's OWN default
 * (`high`) is 1.0. Read straight out of Claude Code 2.1.227's `effort_cost_index` tables on
 * 2026-08-13 — these are the app's own numbers, not an estimate.
 *
 * The one that matters here: **Sonnet at `max` costs 5.59x its own default**, versus 1.91x for
 * Opus. Running Sonnet at max effort is the single most wasteful setting available, because it
 * pays a near-6x multiplier on the model chosen for being cheap.
 */
export const EFFORT_COST = {
  'claude-opus-5': { low: 0.6, medium: 0.77, high: 1, xhigh: 1.74, max: 1.91 },
  'claude-opus-4-8': { low: 0.67, medium: 0.76, high: 1, xhigh: 1.6, max: 1.7 },
  'claude-opus-4-7': { low: 0.72, medium: 0.9, high: 1, xhigh: 1.65, max: 1.88 },
  'claude-sonnet-5': { low: 0.47, medium: 0.74, high: 1, xhigh: 2.41, max: 5.59 },
  'claude-sonnet-4-6': { low: 0.47, medium: 0.74, high: 1, xhigh: 2.41, max: 5.59 },
};
export const DEFAULT_EFFORT = 'high';
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * "high" from "high" or { level: "high" }. Hook input hands effort over as an OBJECT, so every
 * reader keyed on the bare word silently missed it (found 2026-09-15: all 468 run-mode files held
 * the object, the advisor exited on every prompt and the statusline cost read 1.00x).
 */
export function normEffort(effort) {
  const e = typeof effort === 'string' ? effort : effort?.level;
  return typeof e === 'string' && e ? e.toLowerCase() : null;
}

/** Cost multiplier for a model+effort pair, relative to that model's default. 1 when unknown. */
export function effortCost(model, effort) {
  const row = EFFORT_COST[normModel(model)];
  return row?.[normEffort(effort)] ?? 1;
}

/** "claude-opus-5" from "opus", "Opus 5", "claude-opus-5-20260101", etc. */
export function normModel(model) {
  const m = String(model || '').toLowerCase();
  if (EFFORT_COST[m]) return m;
  for (const key of Object.keys(EFFORT_COST)) if (m.startsWith(key)) return key;
  if (/opus/.test(m)) return 'claude-opus-5';
  if (/sonnet/.test(m)) return 'claude-sonnet-5';
  return m;
}

/** Short label for the bar: "opus-5", "sonnet-5". */
export function shortModel(model) {
  return normModel(model).replace(/^claude-/, '') || '?';
}

// ---------------------------------------------------------------- json + files

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/** Write via temp+rename so a concurrent reader never sees a half-written file. */
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file); // replaces on Windows
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- identity

/**
 * ACCOUNT IDENTITY — one resolver, three ranked sources.
 *
 * WHY THIS EXISTS (root-caused 2026-09-12, after a night lost to it)
 * The desktop app authenticates INDEPENDENTLY of ~/.claude.json. Signing out and back in
 * inside the app does not rewrite that file at all, so `oauthAccount` can name one account
 * while every live session runs as another. On 2026-09-11/12 the app ran as phoenixx for
 * hours while ~/.claude.json said oagaweesh — so the relay, the statusline, the baton and
 * the usage ledger all filed the secondary's work under the primary's name. The secondary's
 * usage ledger had not been written since 31 August.
 *
 * NO SECRET IS EVER READ. .credentials.json is never opened by this file. The two desktop
 * sources below carry account UUIDs, org UUIDs and session ids only — no token, cookie,
 * key or OAuth state — and nothing here writes to any authentication surface.
 *
 * THE THREE SOURCES, BEST FIRST
 *  1. desktop-session — the app writes one file per Code session at
 *       %APPDATA%/Claude/claude-code-sessions/<accountId>/<orgId>/<hostSessionId>.json
 *     The PATH is the evidence: finding this session's file tells us the account AND org
 *     that opened it. Scoped to THIS session, so it cannot go stale, and it is cross-checked
 *     against CLAUDE_CODE_SESSION_ID via the file's own `cliSessionId`.
 *  2. desktop-app — the app's log records every switch:
 *       [account] Login-state transition (loggedOut: .., uuid: <old> -> <new>)
 *     and a per-request `cacheKey=acct:<uuid>`. Newest evidence wins, by timestamp.
 *  3. claude-config-fallback — ~/.claude.json. Correct for a plain terminal session, which
 *     is the only place `claude login` writes. NEVER used inside a desktop session: if we
 *     know we are in the app and have no app evidence, the honest answer is UNKNOWN.
 */

const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const SESSIONS_ROOT = path.join(APPDATA, 'Claude', 'claude-code-sessions');
const LOG_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
  'Claude',
  'Logs',
);
const LOG_TAIL_BYTES = 400 * 1024;
/** Account evidence older than this, relative to the log's own last line, is not trusted alone. */
const LOG_EVIDENCE_STALE_MS = 6 * 60 * 60 * 1000;

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** True when this process is a hook inside the desktop app rather than a plain terminal session. */
function inDesktopApp() {
  return (
    Boolean(process.env.CLAUDE_CODE_HOST_SESSION_ID) ||
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
  );
}

/** 1. The account that opened THIS Code session. Session-scoped, so staleness cannot apply. */
function fromDesktopSession() {
  const host = process.env.CLAUDE_CODE_HOST_SESSION_ID;
  if (!host) return null;
  const hits = [];
  for (const accountId of listDirs(SESSIONS_ROOT)) {
    for (const orgId of listDirs(path.join(SESSIONS_ROOT, accountId))) {
      const file = path.join(SESSIONS_ROOT, accountId, orgId, `${host}.json`);
      try {
        hits.push({ accountId, orgId, file, at: fs.statSync(file).mtimeMs });
      } catch {
        /* not this pair */
      }
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.at - a.at);
  const top = hits[0];
  // Cross-check: the app records the CLI session id inside the file. If it matches the one
  // this process was handed, two independent identifiers agree and nothing is guessed.
  let verified = false;
  try {
    verified = readJSON(top.file)?.cliSessionId === process.env.CLAUDE_CODE_SESSION_ID;
  } catch {
    /* leave unverified */
  }
  return {
    accountId: top.accountId,
    orgId: top.orgId,
    source: 'desktop-session',
    confidence: hits.length > 1 ? 'low' : verified ? 'high' : 'medium',
    timestamp: top.at,
    evidence: `session file under ${top.accountId.slice(0, 8)}/${top.orgId.slice(0, 8)}${verified ? ', cliSessionId matches' : ''}`,
  };
}

/** 2. The app's own log. Newest account evidence wins — never "the last email ever seen". */
function fromDesktopLog() {
  for (const name of ['main.log', 'main1.log']) {
    let text;
    try {
      const file = path.join(LOG_DIR, name);
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }

    const stamp = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
    };

    // Collect every piece of account evidence with its own timestamp, then take the newest.
    const lines = text.split(/\r?\n/);
    let lastLineAt = 0;
    const found = [];
    for (const line of lines) {
      const t = stamp(line);
      if (!t) continue;
      if (t > lastLineAt) lastLineAt = t;
      const sw =
        /\[account\] Login-state transition \([^)]*uuid: [^)]*?[>→] ([0-9a-f-]{36}|<none>)\)/.exec(
          line,
        );
      if (sw) {
        found.push({ t, uuid: sw[1] === '<none>' ? null : sw[1], kind: 'transition' });
        continue;
      }
      const ck = /cacheKey=acct:([0-9a-f-]{36})\|/.exec(line);
      if (ck) found.push({ t, uuid: ck[1], kind: 'lookup' });
    }
    if (!found.length) continue;
    // Same second: a transition outranks a lookup, because the lookup may be the outgoing one.
    found.sort((a, b) => a.t - b.t || (a.kind === 'transition' ? 1 : -1));
    const newest = found[found.length - 1];
    // A transition to <none> means the app is SIGNED OUT. Say so; do not fall back to an
    // older account, which is exactly how a stale identity gets resurrected.
    if (!newest.uuid) return null;
    const stale = lastLineAt - newest.t > LOG_EVIDENCE_STALE_MS;
    return {
      accountId: newest.uuid,
      orgId: null,
      source: 'desktop-app',
      confidence: stale ? 'low' : 'medium',
      timestamp: newest.t,
      evidence: `${name} ${newest.kind}${stale ? ', stale' : ''}`,
    };
  }
  return null;
}

/** 3. ~/.claude.json. Written by `claude login`; the desktop app does NOT update it. */
function fromConfig() {
  const a = readJSON(path.join(HOME, '.claude.json'))?.oauthAccount;
  if (!a?.accountUuid) return null;
  return {
    accountId: a.accountUuid,
    orgId: a.organizationUuid || null,
    source: 'claude-config-fallback',
    confidence: 'low',
    timestamp: Date.now(),
    evidence: '~/.claude.json oauthAccount',
  };
}

const UNKNOWN = Object.freeze({
  email: null,
  name: '',
  tier: '',
  accountId: null,
  orgId: null,
  source: 'unknown',
  confidence: 'none',
  evidence: 'no trustworthy local evidence',
});

/**
 * THE resolver. Every account-aware component goes through this one function.
 * `source` and `confidence` say how much to trust the answer, and `source: 'unknown'`
 * is returned when identity cannot be established safely. It never guesses.
 */
export function resolveCurrentClaudeAccount() {
  let r = fromDesktopSession() || fromDesktopLog();
  // Inside the app the config file is not evidence — it describes a terminal login that may
  // name a completely different account. Unknown is the correct answer, not a plausible one.
  if (!r && !inDesktopApp()) r = fromConfig();
  if (!r) return { ...UNKNOWN, timestamp: Date.now() };

  // Names and plan tier come from the registry we already maintain, or from the config file
  // only when it happens to describe the SAME account we just resolved.
  const known = readJSON(ACCOUNTS_FILE)?.accounts?.[r.accountId];
  const cfg = readJSON(path.join(HOME, '.claude.json'))?.oauthAccount;
  const sameAsCfg = cfg?.accountUuid === r.accountId ? cfg : null;
  return {
    ...r,
    email: known?.email || sameAsCfg?.emailAddress || null,
    name: known?.name || sameAsCfg?.displayName || '',
    tier: known?.tier || sameAsCfg?.organizationRateLimitTier || sameAsCfg?.organizationType || '',
  };
}

/**
 * The account this session is really running as, in the shape the relay has always used.
 * Returns null when identity is UNKNOWN, so no consumer silently attributes work to the
 * wrong account — every caller already handles null.
 */
export function currentAccount() {
  const r = resolveCurrentClaudeAccount();
  if (!r.accountId) return null;
  return {
    uuid: r.accountId,
    email: r.email || '(unknown)',
    name: r.name,
    tier: r.tier,
    accountId: r.accountId,
    orgId: r.orgId,
    source: r.source,
    confidence: r.confidence,
    timestamp: r.timestamp,
    evidence: r.evidence,
  };
}

export { fromDesktopSession, fromDesktopLog, fromConfig, inDesktopApp };

/** Same slug Claude Code itself uses for ~/.claude/projects/<slug>. */
export function projectSlug(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

/** Short stable label: local-part of the email plus 4 uuid chars, so two accounts never collide. */
export function labelOf(uuid, db) {
  if (!uuid) return 'unknown';
  const e = db?.accounts?.[uuid];
  if (e?.label) return e.label;
  const local = String(e?.email || 'acct').split('@')[0];
  return `${local}#${uuid.slice(0, 4)}`;
}

export function label(acct, db) {
  if (!acct) return 'unknown';
  const saved = db?.accounts?.[acct.uuid]?.label;
  if (saved) return saved;
  return `${String(acct.email).split('@')[0] || 'acct'}#${acct.uuid.slice(0, 4)}`;
}

/** Order accounts best-to-switch-to first. */
export const READY_RANK = { fresh: 0, open: 1, hot: 2, limited: 3 };

// ---------------------------------------------------------------- time (Africa/Cairo — owner rule)

const CAIRO = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parts(ms) {
  return Object.fromEntries(CAIRO.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

export function cairo(ms) {
  try {
    const p = parts(ms);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export function clock(ms) {
  try {
    const p = parts(ms);
    return `${p.hour}:${p.minute}`;
  } catch {
    return '??:??';
  }
}

export function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function ago(ms) {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  const h = s / 3600;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${Math.round(h / 24)}d ago`;
}

export function tok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------- run mode (model + effort)

export const RUNMODE = path.join(RELAY, 'runmode');

/**
 * Remember the model and effort a session is actually running at.
 *
 * Needed because effort is only handed to hooks that fire inside a tool-use context
 * (PreToolUse/PostToolUse/Stop/SubagentStop) — session-lifecycle hooks such as
 * UserPromptSubmit never see it. So the Stop hook records it and everything else reads it back.
 */
export function saveRunMode(sessionId, mode) {
  const effort = normEffort(mode?.effort);
  if (!sessionId || !effort) return;
  try {
    writeJSON(path.join(RUNMODE, `${sessionId}.json`), { ...mode, effort, at: Date.now() });
  } catch {}
}

export function loadRunMode(sessionId) {
  const mode = sessionId ? readJSON(path.join(RUNMODE, `${sessionId}.json`)) : null;
  return mode ? { ...mode, effort: normEffort(mode.effort) } : null;
}

// ---------------------------------------------------------------- accounts ledger

export function loadAccounts() {
  return readJSON(ACCOUNTS_FILE, { version: 1, accounts: {}, lastActive: null });
}

export function saveAccounts(db) {
  writeJSON(ACCOUNTS_FILE, db);
}

/** Record that this account was seen now. Read-modify-write; last writer wins (acceptable: fields are monotonic). */
export function touchAccount(acct, at = Date.now()) {
  if (!acct) return null;
  const db = loadAccounts();
  const e = (db.accounts[acct.uuid] ||= {
    email: acct.email,
    name: acct.name,
    tier: acct.tier,
    firstSeen: at,
    limitHits: [],
  });
  e.email = acct.email;
  e.name = acct.name;
  e.tier = acct.tier;
  e.lastSeen = at;
  db.lastActive = acct.uuid;
  saveAccounts(db);
  return db;
}

// ---------------------------------------------------------------- usage ledger

/**
 * One NDJSON line per assistant turn batch, per account:
 *   {t0, t, i, cw, cr, o, n, s}  first-ts, last-ts, input, cache-write, cache-read, output, msgs, session
 * Kept per account because that is the only grain the limit actually applies at.
 */
export function appendUsage(uuid, sample) {
  if (!uuid || !sample || !sample.total) return;
  fs.mkdirSync(USAGE, { recursive: true });
  fs.appendFileSync(path.join(USAGE, `${uuid}.ndjson`), `${JSON.stringify(sample)}\n`, 'utf8');
}

/** Read an account's samples, newest-biased: only the tail of the file is ever parsed. */
export function readUsage(uuid, sinceMs = Date.now() - WEEK_MS, maxBytes = 512 * 1024) {
  const file = path.join(USAGE, `${uuid}.ndjson`);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (size > len) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (s.t0 >= sinceMs) out.push(s);
    } catch {}
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** Drop lines older than a fortnight so the ledger cannot grow without bound. */
export function pruneUsage(uuid) {
  const file = path.join(USAGE, `${uuid}.ndjson`);
  try {
    if (fs.statSync(file).size < 1_000_000) return;
    const cutoff = Date.now() - 2 * WEEK_MS;
    const kept = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => {
        if (!l.trim()) return false;
        try {
          return JSON.parse(l).t0 >= cutoff;
        } catch {
          return false;
        }
      });
    writeText(file, kept.length ? `${kept.join('\n')}\n` : '');
  } catch {}
}

/**
 * The current 5-hour window for an account.
 * A window opens at the first turn and runs 5h; the next turn after it expires opens a new one.
 * Returns spend inside the CURRENT window, whether that window is still open, and when it ends.
 */
export function windowOf(samples, now = Date.now()) {
  if (!samples.length)
    return { start: null, end: null, total: 0, weighted: 0, open: false, turns: 0 };
  let start = null;
  for (const s of samples) if (start === null || s.t0 >= start + WINDOW_MS) start = s.t0;
  const end = start + WINDOW_MS;
  const inWin = samples.filter((s) => s.t0 >= start);
  return {
    start,
    end,
    total: inWin.reduce((a, s) => a + s.total, 0),
    // Raw tokens scaled by each turn's effort multiplier, so windows run at different efforts
    // are comparable. Samples written before effort tracking carry no `w` and fall back to raw.
    weighted: inWin.reduce((a, s) => a + (s.w ?? s.total), 0),
    turns: inWin.length,
    open: now < end,
  };
}

export function weekTotal(samples, now = Date.now()) {
  const cutoff = now - WEEK_MS;
  return samples.filter((s) => s.t0 >= cutoff).reduce((a, s) => a + s.total, 0);
}

/**
 * Percentage of the account's own observed limit point — empirical, never an official number.
 * Null until the owner has recorded at least one limit hit with `/relay limit`.
 */
export function pctOfObserved(total, entry) {
  const obs = entry?.observedLimitTotal;
  if (!obs || obs <= 0) return null;
  return Math.round((total / obs) * 100);
}

/** Is this account a good one to switch TO right now? */
export function readiness(uuid, db, now = Date.now()) {
  const entry = db?.accounts?.[uuid];
  const samples = readUsage(uuid);
  const win = windowOf(samples, now);
  const lastHit = entry?.limitHits?.length ? entry.limitHits[entry.limitHits.length - 1] : null;

  // A recorded limit hit blocks the account until that window's 5h have elapsed.
  if (lastHit && now < lastHit.windowEnd) {
    return { state: 'limited', until: lastHit.windowEnd, win, entry, samples };
  }
  if (!win.open) return { state: 'fresh', until: null, win, entry, samples };
  const pct = pctOfObserved(win.total, entry);
  if (pct !== null && pct >= 85) return { state: 'hot', until: win.end, win, entry, samples };
  return { state: 'open', until: win.end, win, entry, samples };
}
