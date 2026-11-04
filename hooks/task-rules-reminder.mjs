#!/usr/bin/env node
// Sends the owner's TASK RULES (task-rules.txt beside this file) into the session's context — at the
// start of every session, after every compaction or resume, and on every 10th prompt — instead of on
// EVERY prompt.
//
// WHY (owner's choice, 2026-10-08, "first, every 10th, compaction"). The rules were re-sent word for
// word with each prompt by a bash `echo` in ~/.claude/settings.json: ~2 KB a prompt, and 51% of all
// hook-injected text across 467 sessions in three days (27.8 MB of 54.4 MB), 97% of it an exact repeat
// of a copy already in the same context. The same rules also load on every request from
// ~/.claude/CLAUDE.md, and next-step-capture.mjs still BLOCKS any reply whose Next step line is
// missing or wrong — so the per-prompt echo was a reminder, never the enforcement.
//
//   node task-rules-reminder.mjs session   SessionStart (startup, resume, compact, clear): send, count = 0
//   node task-rules-reminder.mjs prompt    UserPromptSubmit: count + 1; send when count % 10 === 0, or
//                                          when no session record exists (the SessionStart send failed)
//   node task-rules-reminder.mjs --selftest
//
// Edit the WORDS in task-rules.txt, never here. claude-config-review.mjs reads that file too.
// PHX_TASK_RULES_EVERY_PROMPT=1 restores the old every-prompt send. Fails open: any error sends the rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_FILE = path.join(HERE, 'task-rules.txt');
const STATE_DIR = path.join(os.homedir(), '.claude', 'state', 'task-rules');
export const EVERY = 10;
const KEEP_MS = 7 * 864e5;

/** Pure decision: should this prompt carry the rules? `count` is the count AFTER this prompt. */
export function shouldSend({ mode, count, hadRecord, everyPrompt = false }) {
  if (mode === 'session') return true;
  if (everyPrompt || !hadRecord) return true;
  return count % EVERY === 0;
}

const out = (event, text) =>
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));

function selftest() {
  let ran = 0, bad = 0;
  const check = (label, got, want) => { ran++; if (got !== want) { bad++; console.log(`FAIL ${label}: ${got}`); } };
  check('session always sends', shouldSend({ mode: 'session', count: 0, hadRecord: true }), true);
  check('prompt 1 after a session send is quiet', shouldSend({ mode: 'prompt', count: 1, hadRecord: true }), false);
  check('prompt 9 is quiet', shouldSend({ mode: 'prompt', count: 9, hadRecord: true }), false);
  check('prompt 10 sends', shouldSend({ mode: 'prompt', count: 10, hadRecord: true }), true);
  check('prompt 20 sends', shouldSend({ mode: 'prompt', count: 20, hadRecord: true }), true);
  check('no record (SessionStart failed) sends', shouldSend({ mode: 'prompt', count: 1, hadRecord: false }), true);
  check('escape hatch sends every prompt', shouldSend({ mode: 'prompt', count: 3, hadRecord: true, everyPrompt: true }), true);
  let text = '';
  try { text = fs.readFileSync(RULES_FILE, 'utf8'); } catch {}
  check('task-rules.txt exists and starts with TASK RULES', text.startsWith('TASK RULES:'), true);
  check('task-rules.txt still carries the Next step rule', /\*\*Next step:\*\*/.test(text), true);
  console.log(`SELFTEST task-rules-reminder: ${ran} cases, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

const mode = process.argv[2] === 'session' ? 'session' : 'prompt';
const event = mode === 'session' ? 'SessionStart' : 'UserPromptSubmit';
let text = '';
try {
  text = fs.readFileSync(RULES_FILE, 'utf8').trim();
  if (!text) process.exit(0);
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}'); } catch {}
  const sid = String(input.session_id || '').replace(/[^\w.-]/g, '');
  if (!sid) { out(event, text); process.exit(0); }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `${sid}.json`);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const count = mode === 'session' ? 0 : (state?.count ?? 0) + 1;
  fs.writeFileSync(file, JSON.stringify({ count, at: Date.now() }));
  const send = shouldSend({ mode, count, hadRecord: !!state, everyPrompt: process.env.PHX_TASK_RULES_EVERY_PROMPT === '1' });
  if (send) out(event, text);
  if (mode === 'session') {
    // Housekeeping, once per session start: drop records of sessions idle for a week.
    for (const f of fs.readdirSync(STATE_DIR)) {
      try { const p = path.join(STATE_DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch {}
    }
  }
} catch (e) {
  if (e?.[Symbol.for('phx.hook-exit')]) throw e;
  if (text) out(event, text); // fail open: when in doubt, send the rules
}
process.exit(0);
