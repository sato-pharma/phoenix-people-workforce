// UserPromptSubmit hook — CLOUD-FIRST when the laptop is full (owner, 2026-11-07: "Both" — cloud-first
// routing plus the auto-cleanup, after "my laptop is only 16" ruled out the 32 GB kit).
//
// The binding cost on this 16 GB machine is the NUMBER of local Code sessions: each one keeps a
// ~600 MB private claude.exe plus its panel shell alive for as long as it is open (measured
// 2026-11-07 00:05 Cairo: 11 sessions = 6.7 GB private of a 31.8 GB commit, 1.2-1.6 GB free).
// Closing open sessions is his call and he refused it ("donot touch any fucken session"), so the
// lever is NEW work: on the FIRST prompt of a brand-new session, when the laptop is already full,
// tell the session to route its task by AGENTS.md §5's ROUTING GOLDEN RULE and move itself to the
// cloud when the task needs nothing local. It never touches another session.
//
// Fires once per session, only on a session with no assistant turn yet (a resumed session is not
// new work), only when local sessions >= LOCAL_SESSION_LIMIT or available RAM < FREE_MB_LIMIT.
// Reads memory-guard.mjs's cached session count — it starts no process. Fails open and silent.
// PHX_CLOUD_FIRST=0 stands it down.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_SESSION_LIMIT = 6;
const FREE_MB_LIMIT = 2500;
const COUNT_CACHE = path.join(os.tmpdir(), 'claude-statusline-sessions.json'); // written by memory-guard.mjs refresh
const COUNT_MAX_AGE_MS = 2 * 60 * 60_000;
const MARK_DIR = path.join(os.tmpdir(), 'claude-cloud-first');
const NEW_SESSION_MAX_BYTES = 2_000_000; // a transcript bigger than this is never a brand-new session

/** Pure decision, exported for the self-test. */
export function decide({ sessions, freeMb, isNew }) {
  if (!isNew) return null;
  const full = (sessions != null && sessions >= LOCAL_SESSION_LIMIT) || freeMb < FREE_MB_LIMIT;
  if (!full) return null;
  const count = sessions != null ? `${sessions} local Code sessions are open` : 'the session count is unknown';
  return [
    `CLOUD-FIRST (owner, 2026-11-07) — this 16 GB laptop is full: ${count}, ${freeMb.toLocaleString('en-US')} MB of RAM available.`,
    'Before ANY work, route this task by AGENTS.md §5 ROUTING GOLDEN RULE. It must stay LOCAL only if it needs one of:',
    'a browser look or dev-auth sweep, files on this disk outside the repo (xlsx, pdf, F:\\ folders), a merge or deploy',
    'decision, or the database. Everything else — code, tests, docs, a PR — goes to the cloud: call',
    'mcp__ccd_session__move_to_cloud NOW, before reading or editing anything, with a summary that specifies the change',
    'completely (a cloud session is Phoenix-blind: repo and prompt only), then end the turn with one line and the link.',
    'If the task stays local, do not mention this note. Never move, stop or archive any OTHER session.',
  ].join(' ');
}

function readSessions() {
  try {
    const c = JSON.parse(fs.readFileSync(COUNT_CACHE, 'utf8'));
    if (typeof c.n === 'number' && Date.now() - c.at < COUNT_MAX_AGE_MS) return c.n;
  } catch {}
  return null;
}

function isNewSession(transcriptPath) {
  if (!transcriptPath) return false;
  try {
    const st = fs.statSync(transcriptPath);
    if (st.size > NEW_SESSION_MAX_BYTES) return false;
    return !fs.readFileSync(transcriptPath, 'utf8').includes('"type":"assistant"');
  } catch (e) {
    return e && e.code === 'ENOENT'; // no transcript yet = the very first prompt
  }
}

function selfTest() {
  let bad = 0;
  const check = (name, got, want) => { if (got !== want) { bad++; console.log(`FAIL ${name}: got ${got}, want ${want}`); } else console.log(`ok   ${name}`); };
  check('resumed session is quiet', decide({ sessions: 12, freeMb: 900, isNew: false }), null);
  check('roomy laptop is quiet', decide({ sessions: 3, freeMb: 6000, isNew: true }), null);
  check('6 sessions fires', typeof decide({ sessions: 6, freeMb: 6000, isNew: true }), 'string');
  check('low RAM fires with few sessions', typeof decide({ sessions: 2, freeMb: 1800, isNew: true }), 'string');
  check('unknown count + roomy is quiet', decide({ sessions: null, freeMb: 6000, isNew: true }), null);
  process.exit(bad ? 1 : 0);
}

async function main() {
  if (process.argv[2] === '--self-test') return selfTest();
  if (process.env.PHX_CLOUD_FIRST === '0') return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw.replace(/^﻿/, '') || '{}');
  const sid = String(input.session_id || '').replace(/[^\w-]/g, '');
  if (!sid) return;
  const mark = path.join(MARK_DIR, sid);
  if (fs.existsSync(mark)) return; // already judged this session
  fs.mkdirSync(MARK_DIR, { recursive: true });
  fs.writeFileSync(mark, String(Date.now()));
  try { // markers older than a week are dropped, so the folder never grows without bound
    for (const f of fs.readdirSync(MARK_DIR)) {
      const p = path.join(MARK_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 24 * 60 * 60_000) fs.rmSync(p, { force: true });
    }
  } catch {}
  const text = decide({
    sessions: readSessions(),
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    isNew: isNewSession(input.transcript_path),
  });
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}

main().catch(() => {});
