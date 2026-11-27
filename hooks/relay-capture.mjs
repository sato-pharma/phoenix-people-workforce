// Stop hook: after EVERY reply, drop a "baton" describing exactly where this session is,
// and meter this account's token spend.
//
// The baton has to be written continuously rather than on request, because the moment it is
// most needed is the moment the account dies at its limit — and at that moment the owner
// cannot ask for anything. Whatever was captured on the last completed turn is what survives.
//
// Cost discipline (this runs after every single reply):
//   - transcripts here reach 35 MB, so usage is read INCREMENTALLY from a stored byte offset
//   - git runs with --no-optional-locks, because a parallel session is often mid-push in the
//     same checkout and a status refresh must never contend for .git/index.lock
//   - everything is wrapped; a Stop hook that throws is noise on every turn
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BATONS,
  HOME,
  STATE,
  appendUsage,
  cairo,
  currentAccount,
  effortCost,
  label,
  normEffort,
  loadAccounts,
  projectSlug,
  pruneUsage,
  readJSON,
  readUsage,
  saveRunMode,
  touchAccount,
  windowOf,
  tok,
  writeJSON,
  writeText,
} from './relay-lib.mjs';

const TAIL_BYTES = 512 * 1024;
const SEED_LOOKBACK = 4 * 1024 * 1024; // first sight of a session: how far back to backfill
const MAX_IDS = 400;
const GIT_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------- transcript reading

function tail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Read from a byte offset to EOF, returning only whole lines and the new offset. */
function readSince(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset: size }; // truncated or unchanged
    const len = size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return { lines: [], offset }; // a single partial line; wait for the rest
    return {
      lines: text.slice(0, cut).split('\n'),
      offset: offset + Buffer.byteLength(text.slice(0, cut + 1), 'utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Sum the `usage` blocks on assistant entries.
 * Sidechain entries are INCLUDED on purpose: subagent tokens bill against the same limit.
 * Deduped by message id, because a streamed message can be written more than once.
 */
function meter(lines, seen) {
  let t0 = null;
  let t = null;
  let i = 0;
  let cw = 0;
  let cr = 0;
  let o = 0;
  let n = 0;
  let model = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'assistant') continue;
    const u = e.message?.usage;
    if (!u) continue;
    const id = e.message?.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const ts = Date.parse(e.timestamp ?? '') || Date.now();
    if (t0 === null || ts < t0) t0 = ts;
    if (t === null || ts > t) t = ts;
    if (e.message?.model) model = e.message.model; // the hook input never carries the model

    i += u.input_tokens || 0;
    cw += u.cache_creation_input_tokens || 0;
    cr += u.cache_read_input_tokens || 0;
    o += u.output_tokens || 0;
    n += 1;
  }
  if (!n) return null;
  return { t0, t, i, cw, cr, o, n, model, total: i + cw + cr + o };
}

/**
 * Walk raw JSONL lines backwards for the last genuine message of one role.
 *
 * "Genuine" is the whole difficulty on the user side: a tool_result is also type "user",
 * and so are meta entries and hook injections. Only a plain string or a real text block
 * counts. On the assistant side, tool-only turns carry no text block and are skipped.
 */
function pickLast(lines, role) {
  for (let k = lines.length - 1; k >= 0; k--) {
    const raw = lines[k].trim();
    if (!raw) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (e.type !== role || e.isSidechain || e.isMeta) continue;
    const c = e.message?.content;
    const t = (
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : ''
    ).trim();
    if (!t) continue;
    if (role === 'user' && (t.startsWith('<') || /^\[Request interrupted/.test(t))) continue;
    return t;
  }
  return '';
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// ---------------------------------------------------------------- git + tasks

function git(cwd, args) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Branch, HEAD and working tree in TWO git calls, not three: `status --porcelain -b` carries the
 * branch on its `## ` header line, so `rev-parse` is redundant. This runs after every reply on a
 * 16 GB machine that is usually saturated, so each subprocess avoided is worth having.
 */
function gitState(cwd) {
  const out = git(cwd, ['status', '--porcelain', '-b']);
  if (!out) return null;
  const all = out.split('\n').filter(Boolean);
  const header = all[0]?.startsWith('## ') ? all.shift().slice(3) : '';
  // "branch...remote [ahead 1]" -> "branch";  detached prints "HEAD (no branch)"
  const branch = header.split('...')[0].split(' ')[0] || 'HEAD';
  return {
    branch,
    head: git(cwd, ['log', '-1', '--format=%h %s']),
    staged: all.filter((r) => r[0] && r[0] !== ' ' && r[0] !== '?').length,
    modified: all.filter((r) => r[1] && r[1] !== ' ' && r[1] !== '?').length,
    untracked: all.filter((r) => r.startsWith('??')).length,
    files: all.slice(0, 12).map((r) => r.trim()),
  };
}

function openTasks(sessionId) {
  const dir = path.join(HOME, '.claude', 'tasks', sessionId);
  const out = { open: [], done: 0 };
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const t = readJSON(path.join(dir, name));
      if (!t?.subject) continue;
      if (t.status === 'completed') out.done += 1;
      else if (t.status !== 'deleted')
        out.open.push({ id: t.id, subject: t.subject, status: t.status });
    }
  } catch {}
  out.open.sort((a, b) => Number(a.id) - Number(b.id));
  return out;
}

// ---------------------------------------------------------------- main

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const sessionId = input?.session_id;
  const transcript = input?.transcript_path;
  const cwd = input?.cwd || process.cwd();
  const acct = currentAccount();

  if (sessionId && transcript && fs.existsSync(transcript)) {
    // ---- 1. meter this account's spend, reading only what is new
    const stateFile = path.join(STATE, `${sessionId}.json`);
    const state = readJSON(stateFile, null) ?? { offsets: {}, ids: [], seeded: false };
    const seen = new Set(state.ids || []);
    const files = [transcript];

    // subagent transcripts live beside the session and bill against the same limit
    const subDir = path.join(path.dirname(transcript), sessionId, 'subagents');
    try {
      const stack = [subDir];
      while (stack.length) {
        const d = stack.pop();
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) stack.push(p);
          else if (ent.name.endsWith('.jsonl') && ent.name !== 'journal.jsonl') files.push(p);
        }
      }
    } catch {}

    const batch = [];
    let mainLines = [];
    for (const file of files) {
      const key = path.relative(path.dirname(transcript), file);
      let offset = state.offsets[key];
      if (offset === undefined) {
        // First sight. Do not replay the whole history: it was spent under an account we cannot
        // identify (transcripts carry no accountUuid). Backfill only the recent tail so the
        // current window is not reported as empty, and flag it as an attribution guess.
        try {
          const size = fs.statSync(file).size;
          offset = Math.max(0, size - SEED_LOOKBACK);
        } catch {
          offset = 0;
        }
      }
      let read;
      try {
        read = readSince(file, offset);
      } catch {
        continue;
      }
      state.offsets[key] = read.offset;
      if (file === transcript) mainLines = read.lines;
      const m = meter(read.lines, seen);
      if (m) batch.push(m);
    }

    // Effort reaches us only here: it is handed to tool-use-context hooks like Stop, and never
    // to session-lifecycle hooks. Record it so the router and the statusline can read it back.
    const effort = normEffort(input?.effort);
    const runModel = batch.find((m) => m.model)?.model ?? null;
    if (effort || runModel) saveRunMode(sessionId, { model: runModel, effort });

    if (batch.length && acct) {
      const merged = batch.reduce((a, m) => ({
        t0: Math.min(a.t0, m.t0),
        t: Math.max(a.t, m.t),
        i: a.i + m.i,
        cw: a.cw + m.cw,
        cr: a.cr + m.cr,
        o: a.o + m.o,
        n: a.n + m.n,
        total: a.total + m.total,
      }));
      // A seeded first batch may include turns spent before this account logged in.
      if (!state.seeded) merged.g = 1;
      merged.s = sessionId.slice(0, 8);
      if (runModel) merged.m = runModel;
      if (effort) merged.e = effort;
      // Raw tokens scaled by the effort multiplier: the same turn at `max` on Sonnet weighs 5.59x
      // what it weighs at that model's default. Raw counts alone hide the whole effect, which is
      // why effort could sit at `max` for weeks with the usage numbers looking unremarkable.
      merged.w = Math.round(merged.total * effortCost(runModel, effort));
      appendUsage(acct.uuid, merged);
    }
    // ---- 2. the last exchange
    // The request can sit megabytes back in a long session, far outside any affordable tail —
    // this transcript passed 512 KB within one hour. But it always appears in the INCREMENTAL
    // slice on the turn it was typed, so capture it there and remember it in the state file.
    const tailLines = tail(transcript).split('\n');
    const request = pickLast(mainLines, 'user') || pickLast(tailLines, 'user') || state.lastRequest || '';
    const reply = pickLast(tailLines, 'assistant');
    state.lastRequest = clip(request, 800);

    state.seeded = true;
    state.ids = [...seen].slice(-MAX_IDS);
    try {
      writeJSON(stateFile, state);
    } catch {}

    // ---- 3. write the baton
    // The next step is parsed from the reply HERE rather than read from next-step-capture.mjs's
    // file: both are Stop hooks in the same array and may run in parallel, so reading its output
    // would race and could hand over the PREVIOUS turn's recommendation. The file is only a
    // fallback for a tool-only turn that carried no text of its own.
    const nextStep =
      (() => {
        // Same rule as next-step-capture.mjs: FIRST match, on a line that STARTS with the phrase.
        // This used to keep the LAST match anywhere on a line — the pre-2026-09-08 rule — so a
        // mid-reply "the next step: is yours" or a quoted table row became the baton's next step
        // and was handed to the next session as its recommendation.
        let found = '';
        for (const line of reply.split('\n')) {
          const m = /^\s*\**\s*next step\s*\**\s*[:—-]\s*\**\s*(.+)$/i.exec(line);
          if (m) {
            found = m[1];
            break;
          }
        }
        return found
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/[`*_]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      })() ||
      (() => {
        try {
          return fs
            .readFileSync(path.join(HOME, '.claude', '.next-step', `${sessionId}.txt`), 'utf8')
            .trim();
        } catch {
          return '';
        }
      })();

    const db = touchAccount(acct) ?? loadAccounts();
    const samples = acct ? readUsage(acct.uuid) : [];
    const win = windowOf(samples);
    const slug = projectSlug(cwd);
    const now = Date.now();

    const baton = {
      version: 1,
      writtenAt: now,
      project: { cwd, slug },
      account: acct ? { ...acct, label: label(acct, db) } : null,
      session: { id: sessionId, transcript },
      git: gitState(cwd),
      tasks: openTasks(sessionId),
      lastRequest: clip(request, 800),
      lastReply: clip(reply, 1400),
      nextStep,
      spend: { window: win.total, windowStart: win.start, windowEnd: win.end, turns: win.turns },
    };
    writeJSON(path.join(BATONS, `${slug}.json`), baton);

    // A human-readable twin, so the owner can open the handoff himself without asking anyone.
    const g = baton.git;
    const md = [
      `# Handoff — ${path.basename(cwd)}`,
      '',
      `- **Written:** ${cairo(now)} Cairo`,
      `- **Account:** ${baton.account ? `${baton.account.label} (${baton.account.email})` : 'unknown'}`,
      `- **Folder:** \`${cwd}\``,
      g ? `- **Branch:** \`${g.branch}\` at \`${g.head}\`` : '- **Branch:** (not a git repo)',
      g ? `- **Working tree:** ${g.staged} staged, ${g.modified} modified, ${g.untracked} untracked` : null,
      `- **Resume this exact session:** \`claude --resume ${sessionId}\``,
      win.start ? `- **5h window:** ${tok(win.total)} tokens since ${cairo(win.start)} Cairo` : null,
      '',
      '## Last request',
      '',
      baton.lastRequest || '_(none captured)_',
      '',
      '## Where the reply left off',
      '',
      baton.lastReply || '_(none captured)_',
      '',
      nextStep ? `## Next step\n\n${nextStep}\n` : null,
      baton.tasks.open.length
        ? `## Open tasks (${baton.tasks.done} done)\n\n${baton.tasks.open
            .map((t) => `- [${t.status}] #${t.id} ${t.subject}`)
            .join('\n')}\n`
        : null,
      g?.files?.length ? `## Changed files\n\n${g.files.map((f) => `- \`${f}\``).join('\n')}\n` : null,
    ]
      // only the CONDITIONAL entries drop out; '' is a deliberate blank line and markdown needs it
      .filter((l) => l !== null)
      .join('\n');
    writeText(path.join(BATONS, `${slug}.md`), md);

    if (acct) {
      try {
        pruneUsage(acct.uuid);
      } catch {}
    }

    // Old sessions never come back; do not let the relay folders pile up. advice/ and runmode/
    // gain one file per session and batons/ two per folder (worktrees come and go daily), and
    // until 2026-09-17 only state/ was ever pruned — they had reached ~570, ~550 and ~290.
    // A baton is ignored after BATON_STALE_MS (24 h) anyway, so 14 days loses nothing.
    // state/ keeps its original 30 days: it holds a session's transcript offsets, and losing
    // them only re-seeds a resumed session, but there is no reason to shorten it.
    // Throttled to once per 6 hours through a marker file: this hook runs after every reply,
    // and reading ~2,000 directory entries each time is not free on Windows.
    try {
      const RELAY_DIR = path.dirname(STATE);
      const marker = path.join(RELAY_DIR, '.last-prune');
      let last = 0;
      try {
        last = fs.statSync(marker).mtimeMs;
      } catch {}
      if (now - last > 6 * 3_600_000) {
        fs.writeFileSync(marker, new Date(now).toISOString(), 'utf8');
        const DAY = 86_400_000;
        for (const [dir, days] of [
          [STATE, 30],
          [path.join(RELAY_DIR, 'advice'), 14],
          [path.join(RELAY_DIR, 'runmode'), 14],
          [BATONS, 14],
        ]) {
          const cutoff = now - days * DAY;
          let names = [];
          try {
            names = fs.readdirSync(dir);
          } catch {
            continue;
          }
          for (const name of names) {
            try {
              const p = path.join(dir, name);
              const st = fs.statSync(p);
              if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
            } catch {}
          }
        }
      }
    } catch {}
  }
} catch (err) {
  // Silent by default: a Stop hook that prints on failure is noise after every single reply.
  // RELAY_DEBUG=1 turns the error back on when something needs diagnosing.
  if (process.env.RELAY_DEBUG) process.stderr.write(`relay-capture: ${err?.stack || err}\n`);
}

process.exit(0);
