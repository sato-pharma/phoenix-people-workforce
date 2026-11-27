#!/usr/bin/env node
// Mirrors the coding done in every session on this laptop to the spare laptop's screen (owner, 2026-11-27:
// "the coding i do here in claude code desktop app appears on spares screen", shown as "Phoenix Administrator",
// never as Claude).
//
// Runs as a USER-level PreToolUse hook through hook-dispatch.mjs (dispatch.json, matcher Write|Edit|Bash|PowerShell).
// It only APPENDS a few coloured lines to ~/.claude/logs/spare-screen-mirror.log (well under a millisecond) and never
// blocks or answers; ~/.claude/scripts/spare-screen-stream.mjs (task "Phoenix Spare Screen Mirror") streams that file to
// the spare, where the viewer on its screen (tty8, Alt+F8) shows it.
//  - Secrets are hidden: password/secret/token/key assignments, Bearer tokens, JWTs, sk-/ghp_/re_ style keys.
//  - The words Claude / .claude are replaced, so the screen reads as the Phoenix Administrator.
//  - Off switch: create ~/.claude/spare-mirror/off.   Test: node spare-screen-mirror.mjs selftest
import { appendFileSync, existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const HOME = homedir();
const LOG = join(HOME, '.claude', 'logs', 'spare-screen-mirror.log');
const OFF = join(HOME, '.claude', 'spare-mirror', 'off');
const MAX_LINES = 25;
const C = { y: '\x1b[1;33m', g: '\x1b[32m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' };

export function scrub(text) {
  return String(text ?? '')
    .replace(/\x1b/g, '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1<hidden>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<hidden>')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk_(live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|re_[A-Za-z0-9_]{16,}|sbp_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g, '<hidden>')
    .replace(/(postgres(?:ql)?:\/\/[^:\s\/]+:)[^@\s]+@/gi, '$1<hidden>@')
    .replace(/(\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|service[_-]?role|psk|private[_-]?key)[\w.-]*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<hidden>')
    .replace(/\.claude\b/gi, '.admin')
    .replace(/Co-Authored-By:[^\n]*/gi, '')
    .replace(/\bclaude\b/gi, 'Phoenix');
}

function clip(text, max = MAX_LINES) {
  const lines = scrub(text).replace(/\r/g, '').split('\n');
  const out = lines.slice(0, max);
  if (lines.length > max) out.push(`${C.d}... ${lines.length - max} more line(s)${C.x}`);
  return out;
}

const short = (p) => scrub(String(p ?? '').replace(/\\/g, '/').replace(/^.*?\/phoenix-workforce\//i, ''));

export function render(payload, now = new Date()) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  const t = now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour12: false });
  const where = scrub(basename(String(payload?.cwd ?? '').replace(/[\\/]+$/, '')) || 'phoenix');
  const head = (what) => `\n${C.y}[${t}] Phoenix Administrator${C.x} ${C.d}(${where})${C.x} ${what}`;
  const out = [];
  if (tool === 'Bash' || tool === 'PowerShell') {
    out.push(head(input.description ? `- ${scrub(input.description)}` : 'runs:'));
    for (const l of clip(input.command, 15)) out.push(`  ${C.c}$${C.x} ${l}`);
  } else if (tool === 'Edit') {
    out.push(head(`edits ${C.c}${short(input.file_path)}${C.x}`));
    for (const l of clip(input.old_string, 8)) out.push(`  ${C.r}- ${l}${C.x}`);
    for (const l of clip(input.new_string)) out.push(`  ${C.g}+ ${l}${C.x}`);
  } else if (tool === 'Write') {
    const n = String(input.content ?? '').split('\n').length;
    out.push(head(`writes ${C.c}${short(input.file_path)}${C.x} (${n} lines)`));
    for (const l of clip(input.content)) out.push(`  ${C.g}+ ${l}${C.x}`);
  } else return '';
  return out.join('\n') + '\n';
}

if (process.argv[2] === 'selftest') {
  const s = render({ tool_name: 'Bash', cwd: 'F:/x/phoenix-workforce', tool_input: { command: 'SUPABASE_SERVICE_ROLE_KEY=abc123 node x; curl -H "Authorization: Bearer abc.def"; cat ~/.claude/x # Claude', description: 'run it' } });
  const e = render({ tool_name: 'Edit', tool_input: { file_path: 'F:/Phoenix Workforce/phoenix-workforce/src/a.ts', old_string: 'a', new_string: 'const password = "hunter2"\nb' } });
  const bad = [/abc123/, /abc\.def/, /hunter2/, /claude/i].filter((re) => re.test(s + e));
  const ok = bad.length === 0 && /Phoenix Administrator/.test(s) && /src\/a\.ts/.test(e) && /\.admin/.test(s);
  console.log(s + e); console.log(ok ? 'SELFTEST PASSED' : `SELFTEST FAILED ${bad}`); process.exit(ok ? 0 : 1);
}

function main() {
  if (existsSync(OFF)) return;
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const text = render(payload);
  if (!text) return;
  try { mkdirSync(join(HOME, '.claude', 'logs'), { recursive: true }); } catch {}
  try { if (statSync(LOG).size > 20e6) return; } catch {}
  appendFileSync(LOG, text);
}
try { main(); } catch { /* fail open, always */ }
