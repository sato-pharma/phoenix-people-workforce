#!/usr/bin/env node
// Every session remembers the Phoenix rules and the recent history, whatever folder it starts in.
//
// WHY (2026-10-31, owner: "make the sessions remember the rules and remember the history"). Claude
// Code's memory belongs to a FOLDER, not the account: a session started in the home folder, the app's
// no-folder scratch workspace or a folder like F:\Osteosat got none of the 1,517 Phoenix notes, no
// AGENTS.md and none of the repo's agents, so it greeted him like a stranger ("deeep audit", 28 Oct).
// And no session, in any folder, knew what the other sessions had been doing.
//
// WHAT. Two blocks of SessionStart context:
//   1. RULES — only for a session whose folder has no memory of its own and is outside F:\Phoenix
//      Workforce: the Phoenix MEMORY.md index, and the files to read before any Phoenix work.
//      A Phoenix session (primary or worktree) already gets all of it from Claude Code itself.
//   2. HISTORY — every session: the latest sessions across every folder (title, folder, last active
//      in Cairo time, the last thing he typed), and how to read a past session in full.
// Runs on every source, compact included, so a compaction does not drop it. Fails open and silent.
//
// usage: node phoenix-context-anywhere.mjs              (as a SessionStart hook, payload on stdin)
//        node phoenix-context-anywhere.mjs --print <cwd> (show what a session in <cwd> would get)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const PHX_PARENT = 'f:\\phoenix workforce';
const PHX_PRIMARY = 'F:\\Phoenix Workforce\\phoenix-workforce';
const PHX_KEY = 'F--Phoenix-Workforce-phoenix-workforce';
const PHX_MEMORY = path.join(PROJECTS, PHX_KEY, 'memory');
const HISTORY_DAYS = 7;
const HISTORY_MAX = 15;
const TAIL_BYTES = 192 * 1024;

/** Claude Code's folder key: every character that is not a letter or digit becomes '-'. */
export const projectKey = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

export function isPhoenix(cwd) {
  return norm(cwd).startsWith(PHX_PARENT);
}

export function hasOwnMemory(cwd) {
  try {
    return fs.statSync(path.join(PROJECTS, projectKey(cwd), 'memory', 'MEMORY.md')).size > 0;
  } catch {
    return false;
  }
}

/** A short, human name for a project folder key. */
export function folderLabel(key) {
  if (key.startsWith(PHX_KEY)) return key === PHX_KEY ? 'Phoenix' : 'Phoenix (worktree)';
  if (key.startsWith('F--Phoenix-Workforce')) return 'Phoenix (worktree)';
  if (/scratch-workspaces/i.test(key)) return 'no folder';
  if (key === 'C--Users-satoh') return 'home folder';
  return key.replace(/^C--Users-satoh-/, '').replace(/^([A-Z])--/, '$1:\\').replace(/-/g, ' ');
}

const cairo = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

function readTail(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function lastField(text, type, field) {
  const re = new RegExp(`\\{"type":"${type}","${field}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m[1];
  if (last == null) return null;
  try {
    return JSON.parse(`"${last}"`);
  } catch {
    return last;
  }
}

const oneLine = (s, max) => {
  const t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
};

/** The latest sessions across every folder, newest first. */
export function recentSessions({ exclude = '', now = Date.now() } = {}) {
  const since = now - HISTORY_DAYS * 86400000;
  const rows = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return rows;
  }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -6);
      if (id === exclude) continue;
      const file = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < since || st.size < 2048) continue;
      rows.push({ id, key: d.name, file, size: st.size, mtime: st.mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const r of rows) {
    if (out.length >= HISTORY_MAX) break;
    let tail = '';
    try {
      tail = readTail(r.file, r.size);
    } catch {
      continue;
    }
    const title = lastField(tail, 'custom-title', 'customTitle');
    const prompt = lastField(tail, 'last-prompt', 'lastPrompt');
    if (!title && !prompt) continue;
    out.push({ ...r, title: oneLine(title || 'untitled', 70), prompt: oneLine(prompt, 90) });
  }
  return out;
}

export function rulesBlock() {
  let index = '';
  try {
    index = fs.readFileSync(path.join(PHX_MEMORY, 'MEMORY.md'), 'utf8').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    // no index: the pointers below still stand
  }
  const p = (rel) => path.join(PHX_PRIMARY, rel);
  return [
    'PHOENIX RULES AND MEMORY — this session started OUTSIDE the Phoenix folder, so Claude Code loaded none of',
    "the owner's Phoenix memory by itself. It is the same owner and the same work: treat all of it as yours.",
    `- Before ANY answer or action about Phoenix Workforce, Read ${p('AGENTS.md')} and ${p('CLAUDE.md')} — they bind as`,
    '  if loaded. Each module\'s rules and notes: ' + p('.claude\\rules\\<module>.md') + ' (Read the one you touch).',
    `- Memory notes (one fact each): ${PHX_MEMORY}\\ — Grep there before saying you do not know something. A new`,
    '  Phoenix note goes there too, its pointer under "## Inbox" in that MEMORY.md.',
    `- The repo's own agents (role-sweeper, sales-rules-review, select-auditor, ui-rules-review) are defined in`,
    `  ${p('.claude\\agents\\')} — to use one here, Read its file and give it to a general-purpose agent as the prompt.`,
    `- Code work never happens in this folder: work in ${PHX_PRIMARY} (or a worktree off it), per AGENTS.md §5.`,
    index ? `\nThe Phoenix memory index (${path.join(PHX_MEMORY, 'MEMORY.md')}):\n\n${index}` : '',
  ].join('\n');
}

export function historyBlock(sessions) {
  if (!sessions.length) return '';
  const lines = sessions.map((s) => {
    const when = cairo.format(new Date(s.mtime));
    const last = s.prompt ? ` — last typed: "${s.prompt}"` : '';
    return `- ${when} · ${folderLabel(s.key)} · ${s.title}${last}  [${s.id}]`;
  });
  return [
    `RECENT HISTORY — the owner's latest ${sessions.length} sessions across every folder (Cairo time, newest first).`,
    'When he refers to earlier work ("the audit", "what we did yesterday", "the plans"), find it here, then read',
    `that session: Grep its transcript ${PROJECTS}\\<folder>\\<id>.jsonl, or use the session-management transcript`,
    'search tool. Never tell him you have no memory of it before looking. Another session\'s next step is not yours.',
    ...lines,
  ].join('\n');
}

export function contextFor({ cwd, session_id }) {
  const parts = [];
  if (!isPhoenix(cwd) && !hasOwnMemory(cwd)) parts.push(rulesBlock());
  const h = historyBlock(recentSessions({ exclude: session_id }));
  if (h) parts.push(h);
  return parts.join('\n\n');
}

function main() {
  const i = process.argv.indexOf('--print');
  if (i !== -1) {
    process.stdout.write(contextFor({ cwd: process.argv[i + 1] || process.cwd(), session_id: '' }) + '\n');
    return;
  }
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') || '{}');
  } catch {
    // no payload: nothing to key on
  }
  const ctx = contextFor({ cwd: payload.cwd || process.cwd(), session_id: payload.session_id || '' });
  if (ctx) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
  }
}

try {
  main();
} catch {
  // fail open: a start must never break because of this hook
}
