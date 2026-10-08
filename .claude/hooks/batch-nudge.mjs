// PreToolUse hook: nudge a session that is reading the codebase ONE CALL PER STEP to batch.
//
// WHY (measured 2026-10-08 from 72 hours of Phoenix transcripts, 372 build tasks). A build task took
// a median 25 steps, and 14 of them were single read-only look-arounds — one `grep`, one `cat`, one
// `sed -n`, one Read — each a full model round trip of ~10 s. Only 10% of steps sent two or more tool
// calls at once. Look-arounds were 19% of all build time, second only to the box-check waiting that
// #5500 and #5543 removed. Sending the next few reads in ONE step (parallel tool calls, or one shell
// command that prints them all) costs the same tokens and saves the round trips.
//
// HOW. It reads the tail of the session's own transcript (`transcript_path`), groups the assistant
// entries into steps by request id, and counts the steps at the end that each ran exactly ONE
// read-only look-around, stopping at an owner prompt, at any other kind of step, or at the step it
// last nudged after. At three in a row, and only when the call about to run is a look-around too, it
// adds one short reminder. Parallel calls in one step see the same history, so the step's id in the
// state file keeps it to one reminder per step; MAX_NUDGES bounds what it can ever cost a session.
//
// FAILS SILENT AND FAILS OPEN. It can only ADD context. It never blocks a tool call, never writes
// into the repository, and exits 0 on every error path. PHX_BATCH_NUDGE_OFF=1 stands it down.
// Pinned by tests/batch-nudge.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.USERPROFILE || os.homedir();
const STATE_DIR = path.join(HOME, '.claude', 'relay', 'state');
const STREAK = 3;
const MAX_NUDGES = 6;
const TAIL_BYTES = 1024 * 1024;

const READ_ONLY_SEGMENT =
  /^(?:cd|echo|pwd|ls|dir|cat|type|head|tail|less|wc|nl|sort|uniq|cut|tr|awk|jq|stat|file|tree|diff|grep|egrep|fgrep|rg|find|sed\s+-n|git\s+(?:status|log|diff|show|branch|rev-parse|rev-list|grep|ls-files|blame|worktree\s+list)|Get-Content|gc|Select-String|sls|Get-ChildItem|gci|Get-Item|Test-Path|Measure-Object|Select-Object|Format-List|Format-Table)\b/i;

/** A shell command whose every piece only reads — no write, no redirect into a file. */
function isShellLookAround(command) {
  let cmd = String(command || '').trim();
  if (!cmd || /<</.test(cmd) || /\b(?:-delete|-exec|--in-place)\b|\bsed\s+-i/.test(cmd)) return false;
  cmd = cmd.replace(/\d?>\s*&\s*\d|\d?>\s*\/dev\/null|\d?>\s*\$null/g, ' ');
  if (/>/.test(cmd)) return false;
  return cmd
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => READ_ONLY_SEGMENT.test(s));
}

/** Read, Grep, Glob, or a foreground read-only shell command. */
function isLookAround(name, input) {
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return true;
  if (name === 'Bash' || name === 'PowerShell') return input?.run_in_background !== true && isShellLookAround(input?.command);
  return false;
}

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The transcript's steps in order: { id, tools: [{ id, look }] } per request, and the string
 * 'PROMPT' for each message the owner typed (which ends any streak).
 */
function stepsOf(lines) {
  const steps = [];
  const byId = new Map();
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"tool_result"')) continue; // a tool's answer never ends a streak; skip the big lines unparsed
    const isAssistant = line.includes('"type":"assistant"');
    const isUser = line.includes('"type":"user"');
    if (!isAssistant && !isUser) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'user') {
      if (o.isMeta || o.isCompactSummary) continue;
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
      if (!text || /^\s*<(task-notification|system-reminder|command-|local-command)/.test(text) || /Stop hook feedback/.test(text)) continue;
      steps.push('PROMPT');
      continue;
    }
    if (o.type !== 'assistant') continue;
    const id = o.requestId || o.message?.id;
    if (!id) continue;
    let step = byId.get(id);
    if (!step) {
      step = { id, tools: [] };
      byId.set(id, step);
      steps.push(step);
    }
    for (const x of o.message?.content || []) {
      if (x?.type === 'tool_use') step.tools.push({ id: x.id, look: isLookAround(x.name, x.input) });
    }
  }
  return steps.filter((s) => s === 'PROMPT' || s.tools.length);
}

/**
 * Decide from the steps and the call about to run. Returns { nudge, streak, anchor } where anchor is
 * the id of the last FINISHED step (the one the state file remembers).
 */
function decide(steps, toolUseId, lastAnchor) {
  let history = steps;
  const last = steps[steps.length - 1];
  if (last && last !== 'PROMPT' && last.tools.some((t) => t.id === toolUseId)) {
    if (last.tools.length > 1) return { nudge: false, streak: 0, anchor: null }; // batching right now
    history = steps.slice(0, -1);
  }
  const anchorStep = history[history.length - 1];
  const anchor = anchorStep && anchorStep !== 'PROMPT' ? anchorStep.id : null;
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    if (s === 'PROMPT' || s.id === lastAnchor) break;
    if (s.tools.length === 1 && s.tools[0].look) streak++;
    else break;
  }
  return { nudge: streak >= STREAK && anchor !== null && anchor !== lastAnchor, streak, anchor };
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `batch-nudge-${String(sessionId || 'nosession').replace(/[^\w-]/g, '').slice(0, 36)}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch {
    return { anchor: null, count: 0 };
  }
}

function writeState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = statePath(sessionId);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, at: Date.now() }), 'utf8');
    fs.renameSync(tmp, f);
  } catch {
    /* state is an optimisation, never a requirement */
  }
}

try {
  if (process.env.PHX_BATCH_NUDGE_OFF === '1') process.exit(0);
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  if (!isLookAround(input?.tool_name, input?.tool_input)) process.exit(0);
  const transcript = input?.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) process.exit(0);

  const state = readState(input?.session_id);
  if ((state.count || 0) >= MAX_NUDGES) process.exit(0);

  const { nudge, streak, anchor } = decide(stepsOf(tailLines(transcript)), input?.tool_use_id, state.anchor);
  if (!nudge) process.exit(0);
  writeState(input?.session_id, { anchor, count: (state.count || 0) + 1 });

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `BATCH YOUR LOOK-AROUNDS — your last ${streak} steps each ran ONE read-only call. Every step is a full ` +
          'model round trip (~10 s here; on 8 Oct 2026 a build task averaged 14 such steps and only 10% of steps ' +
          'batched). When you already know the next few files, greps or status reads you need, send them as ' +
          'parallel tool calls in ONE message, or as one shell command that prints them all. A reminder only — ' +
          'nothing is blocked (AGENTS.md §2).',
      },
    }),
  );
} catch (e) {
  if (e?.[Symbol.for('phx.hook-exit')]) throw e; // an exit above ended this hook (hook-dispatch.mjs)
  /* never break a tool call over this */
}

process.exit(0);
