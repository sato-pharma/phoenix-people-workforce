// UserPromptSubmit + PreToolUse hook: point a session at a module's memory when its WORK touches
// that module but no file of it has been opened yet.
//
// WHY
// Module memory (`.claude/rules/<id>.md`, docs/module-memory.md) is loaded by Claude Code itself the
// moment a session READS a file matching the module's `paths:`. That covers most work — but not a
// question in chat, a SQL query through the Supabase MCP, a shell `cat`/`git grep`, or a Write of a
// brand-new file. This hook covers those: it matches the owner's message (keywords), shell commands
// (paths, COMMAND_MODULES words), Grep/Glob paths and SQL text (table names) against
// scripts/module-memory/modules.mjs. It never matches harness text in the prompt or a command's quoted
// strings and search patterns (lib/harness-text.mjs) — those are not the work.
//
// WHAT IT INJECTS — A POINTER AND THE RULE HEADLINES, NEVER THE WHOLE FILE. Claude Code persists any
// hook context over ~10 KB to a file and shows the model a 2 KB preview (measured 2026-10-02: a 12.5 KB
// trap cluster arrived as "Output too large … Preview (first 2KB)"). A 60 KB module pasted here would
// arrive as a truncated preview that READS complete. So it names the module, lists each rule's bold
// headline, and tells the session to Read the file — which delivers the full text.
//
// ONCE PER SESSION PER MODULE. A Read of a module's file marks it seen without injecting (Claude
// Code already loaded the rules file for that read). The state also records every module a session
// TOUCHED, which `scripts/module-memory/fold.mjs` uses to file that session's new memory notes.
//
// FAILS OPEN AND SILENT: it only ever adds context, never blocks, exits 0 on every error path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ownerText, commandForKeywords } from './lib/harness-text.mjs';

const HOME = process.env.USERPROFILE || os.homedir();
export const STATE_DIR = path.join(HOME, '.claude', 'relay', 'state');
const MAX_MODULES_PER_CALL = 2;
const MAX_HEADLINES = 40;

/** Commands that mean engineering or session work even with no path in them. */
const COMMAND_MODULES = [
  [/\bgh\s+(pr\s+(merge|checks)|run|workflow)\b|\brailway\b|healthz|verify-shipped|rollup-prs|remote-check/i, 'engineering'],
  [/new-session\.mjs|repo-doctor|repo:doctor|sync-worktree-env|module-memory\/|MEMORY\.md|\bworktree\b/i, 'sessions'],
  [/apply_migration|supabase\s+(db|migration)|supabase\/migrations/i, 'database'],
];

function findProject(start) {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'AGENTS.md'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function statePath(sessionId) {
  return path.join(STATE_DIR, `modules-${String(sessionId || 'nosession').slice(0, 36)}.json`);
}

export function readState(sessionId) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
    return { seen: new Set(s.seen || []), touched: new Set(s.touched || []) };
  } catch {
    return { seen: new Set(), touched: new Set() };
  }
}

function writeState(sessionId, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = statePath(sessionId);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seen: [...state.seen], touched: [...state.touched], at: Date.now() }), 'utf8');
    fs.renameSync(tmp, f);
  } catch {
    /* state is an optimisation, never a requirement */
  }
}

const TOP_DIRS = '(?:src|app|tests|scripts|supabase|docs|\\.claude|\\.github|infra|public|templates)';
const REPO_RELATIVE = new RegExp(`^${TOP_DIRS}/`);
const FROM_TOP_DIR = new RegExp(`(?:^|/)(${TOP_DIRS}/.*)$`);

/**
 * One path -> repo-relative with forward slashes, or null. An absolute path into ANY checkout of
 * this repo (the primary, a worktree, "F:\Phoenix Workforce\..." with its space) keeps the part
 * from the first known top-level folder, so a worktree's path matches the same globs.
 */
export function normalizePath(p, projectDir) {
  if (!p) return null;
  const t = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const root = projectDir ? projectDir.replace(/\\/g, '/').toLowerCase() : '';
  if (root && t.toLowerCase().startsWith(root + '/')) return t.slice(root.length + 1);
  if (REPO_RELATIVE.test(t)) return t;
  const m = FROM_TOP_DIR.exec(t);
  return m ? m[1] : null;
}

/** Repo-relative forms of everything path-like in free text (a command, a prompt). */
export function pathTokens(text, projectDir) {
  const out = [];
  for (const raw of String(text || '').split(/[\s"'`=,;|<>()]+/)) {
    if (!raw.includes('/') && !raw.includes('\\')) continue;
    const p = normalizePath(raw, projectDir);
    if (p) out.push(p);
  }
  return out;
}

export function tableMatches(text, mod) {
  const t = String(text || '').toLowerCase();
  return mod.tables.some((tb) => new RegExp(`(^|[^a-z0-9_])${tb.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t));
}

/** Decide which modules this event touches. Returns { touched: string[], inject: boolean }. */
export function modulesFor(input, lib, projectDir) {
  const { MODULES, mentions, modulesForPath } = lib;
  const event = input?.hook_event_name || (input?.prompt !== undefined ? 'UserPromptSubmit' : 'PreToolUse');
  const found = new Set();
  const add = (ids) => ids.forEach((id) => found.add(id));

  if (event === 'UserPromptSubmit') {
    // The owner's words only: a task notification, a system reminder or a slash-command echo rides in
    // this same field, and its text is not his work (lib/harness-text.mjs).
    const prompt = ownerText(input?.prompt);
    for (const m of MODULES) if (m.keywords.some((k) => mentions(prompt, k))) found.add(m.id);
    for (const p of pathTokens(prompt, projectDir)) add(modulesForPath(p));
    return { touched: [...found], inject: true };
  }

  const tool = String(input?.tool_name || '');
  const ti = input?.tool_input || {};
  if (/^(Read|NotebookRead)$/.test(tool)) {
    { const p = normalizePath(ti.file_path || ti.notebook_path, projectDir); if (p) add(modulesForPath(p)); }
    return { touched: [...found], inject: false }; // Claude Code loads the rules file for this read itself
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    { const p = normalizePath(ti.file_path || ti.notebook_path, projectDir); if (p) add(modulesForPath(p)); }
    return { touched: [...found], inject: true };
  }
  if (/^(Grep|Glob)$/.test(tool)) {
    // Where the search looks, never what it looks FOR: a pattern is text being hunted, not work done.
    for (const p of pathTokens([ti.path, ti.glob].filter(Boolean).join(' '), projectDir)) add(modulesForPath(p));
    return { touched: [...found], inject: true };
  }
  if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(ti.command || '');
    for (const p of pathTokens(cmd, projectDir)) add(modulesForPath(p));
    // Command words are matched on the command's own words: a quoted search pattern, commit message
    // or heredoc body is blanked first, so `git grep "railway run"` is not railway work. SQL keeps the
    // raw command — a query run from the shell is nearly always the quoted argument.
    const own = commandForKeywords(cmd);
    for (const [re, id] of COMMAND_MODULES) if (re.test(own)) found.add(id);
    if (/\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set)\b/i.test(cmd)) {
      for (const m of MODULES) if (tableMatches(cmd, m)) found.add(m.id);
    }
    return { touched: [...found], inject: true };
  }
  if (/^mcp__supabase/.test(tool)) {
    const sql = String(ti.query || ti.sql || ti.name || '');
    for (const m of MODULES) if (tableMatches(sql, m)) found.add(m.id);
    if (/apply_migration/.test(tool)) { found.add('database'); found.add('database-migrations'); }
    return { touched: [...found], inject: true };
  }
  return { touched: [], inject: false };
}

/** The bold headline of every rule bullet in a module file's Rules section. */
export function ruleHeadlines(text) {
  const a = text.indexOf('<!-- module-memory:rules:begin');
  const b = text.indexOf('<!-- module-memory:rules:end');
  const rules = a !== -1 && b > a ? text.slice(a, b) : '';
  const out = [];
  for (const line of rules.split(/\r?\n/)) {
    if (!/^- /.test(line)) continue;
    const m = /\*\*(.+?)\*\*/.exec(line);
    const head = (m ? m[1] : line.slice(2, 140)).replace(/[`*]/g, '').trim();
    if (head) out.push(head);
  }
  return out;
}

function noteCount(text) {
  const m = /## Memory notes \((\d+)\)/.exec(text);
  return m ? Number(m[1]) : 0;
}

export function renderPointer(mod, text) {
  const heads = ruleHeadlines(text);
  const shown = heads.slice(0, MAX_HEADLINES);
  return [
    `**${mod.title}** (\`${mod.id}\`) — ${heads.length} rule(s) and ${noteCount(text)} memory note(s) in \`.claude/rules/${mod.id}.md\`.`,
    ...shown.map((h) => `  - ${h}`),
    ...(heads.length > shown.length ? [`  - …and ${heads.length - shown.length} more in the file`] : []),
  ].join('\n');
}

async function main() {
  // Stand-down switch, like the repo's other hooks. scripts/module-memory/proof.mjs sets it so its
  // proof measures Claude Code's own `paths:` loading, never this hook.
  if (process.env.PHX_MODULE_MEMORY_HOOK_OFF === '1') return;
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));
  const projectDir = process.env.CLAUDE_PROJECT_DIR || findProject(input?.cwd);
  if (!projectDir) return;
  const libPath = path.join(projectDir, 'scripts', 'module-memory', 'modules.mjs');
  if (!fs.existsSync(libPath)) return;
  const lib = await import(pathToFileURL(libPath).href);

  const { touched, inject } = modulesFor(input, lib, projectDir);
  if (!touched.length) return;
  const state = readState(input?.session_id);
  touched.forEach((id) => state.touched.add(id));

  const fresh = [];
  for (const id of touched) {
    if (state.seen.has(id)) continue;
    if (!inject) { state.seen.add(id); continue; }
    if (fresh.length < MAX_MODULES_PER_CALL) fresh.push(id);
  }
  const parts = [];
  for (const id of fresh) {
    const mod = lib.MODULES.find((m) => m.id === id);
    const file = path.join(projectDir, '.claude', 'rules', `${id}.md`);
    if (!mod || !fs.existsSync(file)) continue;
    parts.push(renderPointer(mod, fs.readFileSync(file, 'utf8')));
    state.seen.add(id);
  }
  writeState(input?.session_id, state);
  if (!parts.length) return;

  const event = input?.hook_event_name === 'UserPromptSubmit' ? 'UserPromptSubmit' : 'PreToolUse';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: [
        'MODULE MEMORY — this work touches the module(s) below (delivered once per session; AGENTS.md §2.2).',
        'Each file binds like AGENTS.md. **Read the file before you change anything in that module or answer about it** — the headlines are cues, the file holds the rules and the memory notes.',
        '',
        ...parts,
      ].join('\n'),
    },
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Awaited at top level, so the work is finished when this module finishes loading — the contract
  // .claude/hooks/hook-dispatch.mjs needs to run it in-process.
  await main().catch(() => {});
  process.exit(0);
}
