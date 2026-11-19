#!/usr/bin/env node
// ONE node process for the laptop's blocking SessionStart hooks, instead of one process each.
//
// WHY (2026-10-09, owner: "combine the laptop's start hooks into one process"). After the day's hook
// fixes every start hook took about the same 0.55-0.65 s inside a real start: node starting up while
// about eight hooks launch at once. Five of those eight were the laptop's (relay-inject,
// suggestion-context, task-rules-reminder, memory-guard, session-census), each a few milliseconds of
// its own work. Run here, one after another in one process, they cost one node start-up.
//
// HOW. It reuses hook-dispatch.mjs beside this file — the byte-identical copy of phoenix-workforce's
// PreToolUse dispatcher — for the parts that already fit: running an UNCHANGED hook script in this
// process (`runInProcess`: payload on fd 0, its own argv/stdout/stderr, an exit that ends only that
// hook), the process fallback and the merge. Two things a start needs that a tool call does not, done
// here so the shared file stays byte-identical:
//   1. Matchers are matched against the start's `source` (startup|resume|clear|compact), as Claude
//      Code matches SessionStart, not against a tool name.
//   2. Plain-text stdout is session context for SessionStart, so it is folded into additionalContext
//      instead of being dropped from the merged JSON.
// Table: session-start-hooks.json beside this file. PHX_HOOK_DISPATCH_PROCESSES=1 runs each hook as
// its own process again (escape hatch and A/B baseline). If the dispatcher cannot be loaded at all,
// every hook still runs, each as its own process — a context hook must never vanish because of this.
//
// usage: node session-start-dispatch.mjs            (as the SessionStart hook)
//        node session-start-dispatch.mjs --selftest  (in-process vs process, every source, identical)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE_FILE = path.join(HERE, 'session-start-hooks.json');
const SOURCES = ['startup', 'resume', 'clear', 'compact'];

/** Claude Code's matcher rule (same as hook-dispatch.mjs), applied to the start's source. */
export function sourceFits(matcher, source) {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(source);
  try {
    return new RegExp(matcher).test(source);
  } catch {
    return false;
  }
}

/** The table cut down to the groups this source runs, with their matchers cleared for the dispatcher. */
export function tableFor(table, source) {
  const groups = (table?.hooks?.SessionStart ?? []).filter((g) => sourceFits(g.matcher, source));
  return { hooks: { SessionStart: groups.map((g) => ({ ...g, matcher: '' })) } };
}

/** Plain stdout is SessionStart context: wrap it so the merge keeps it. */
export function foldPlain(result) {
  const body = String(result.stdout ?? '').trim();
  if (!body || result.code !== 0) return result;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return result;
  } catch {
    // not JSON: plain context
  }
  return { ...result, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } }) };
}

// THE CAP (2026-11-18, desktop-app audit). Claude Code shows a hook's context inline only up to about
// 10,000 characters; past that it saves the text to a file and shows the session a 2 KB preview. After a
// compaction this runner printed 13,814 characters, so the session saw the relay's first lines and
// nothing of the history, the machine state or the rules below them. So the blocks are put in order of
// what a session cannot work without — live state, machine pressure, recent history — and the total is
// held under CONTEXT_CAP; a block that does not fit is cut, and says how much was left out.
export const CONTEXT_CAP = 9000;
const PRIORITY = ['relay-inject', 'session-census', 'phoenix-context-anywhere', 'memory-guard', 'task-rules-reminder', 'suggestion-context'];

function hookName(result) {
  const m = String(result?.command ?? '').match(/([\w.-]+)\.mjs/);
  return m ? m[1] : 'a start hook';
}

/** Results reordered by PRIORITY (unknown hooks last, table order kept), contexts held under the cap. */
export function capStartContext(results, cap = CONTEXT_CAP) {
  const rank = (r) => {
    const i = PRIORITY.indexOf(hookName(r));
    return i < 0 ? PRIORITY.length : i;
  };
  const ordered = results.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  let used = 0;
  return ordered.map((r) => {
    if (r.code !== 0) return r;
    let out;
    try { out = JSON.parse(String(r.stdout ?? '').trim()); } catch { return r; }
    const ctx = out?.hookSpecificOutput?.additionalContext;
    if (typeof ctx !== 'string' || !ctx) return r;
    const join = used ? 2 : 0;
    if (used + join + ctx.length <= cap) {
      used += join + ctx.length;
      return r;
    }
    const note = (n) => `[${hookName(r)}: ${n} more characters left out — the start-up context is held under ${cap} characters]`;
    const room = cap - used - join - note(ctx.length).length - 1;
    const kept = room > 200 ? ctx.slice(0, room).replace(/\s+\S*$/, '') : '';
    const text = kept ? `${kept}\n${note(ctx.length - kept.length)}` : note(ctx.length);
    used += join + text.length;
    return { ...r, stdout: JSON.stringify({ ...out, hookSpecificOutput: { ...out.hookSpecificOutput, additionalContext: text } }) };
  });
}

/** Last resort when hook-dispatch.mjs cannot be loaded: every hook as its own process, outputs joined. */
function runAllAsProcesses(table, payload) {
  const hooks = (table.hooks.SessionStart ?? []).flatMap((g) => g.hooks ?? []);
  return Promise.all(
    hooks.map(
      (h) =>
        new Promise((done) => {
          let out = '';
          let child;
          try {
            child = spawn(process.execPath, h.args ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
          } catch {
            done('');
            return;
          }
          const timer = setTimeout(() => { try { child.kill(); } catch {} done(''); }, (h.timeout ?? 60) * 1000);
          child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
          child.on('error', () => { clearTimeout(timer); done(''); });
          child.on('close', (code) => { clearTimeout(timer); done(code === 0 ? out : ''); });
          child.stdin.on('error', () => {});
          child.stdin.end(payload);
        }),
    ),
  ).then((outs) => {
    const contexts = [];
    const messages = [];
    for (const o of outs.map((s) => s.trim()).filter(Boolean)) {
      try {
        const j = JSON.parse(o);
        if (j?.hookSpecificOutput?.additionalContext) contexts.push(j.hookSpecificOutput.additionalContext);
        if (j?.systemMessage) messages.push(j.systemMessage);
      } catch {
        contexts.push(o);
      }
    }
    const merged = {};
    if (contexts.length) merged.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: contexts.join('\n\n').slice(0, CONTEXT_CAP) };
    if (messages.length) merged.systemMessage = messages.join('\n');
    return { code: 0, stdout: Object.keys(merged).length ? JSON.stringify(merged) : '', stderr: '' };
  });
}

/** Run every hook this source matches and merge, as Claude Code would have from separate processes. */
export async function runStart({ table, payload, processes = false }) {
  let source = 'startup';
  try {
    source = JSON.parse(String(payload).replace(/^﻿/, '')).source || 'startup';
  } catch {
    // no payload: treat as a fresh start
  }
  const cut = tableFor(table, source);
  let d;
  try {
    d = await import(pathToFileURL(path.join(HERE, 'hook-dispatch.mjs')).href);
  } catch {
    return runAllAsProcesses(cut, payload);
  }
  const results = await d.runHooks({ event: 'SessionStart', payload, table: cut, processes });
  return d.mergeHookResults(capStartContext(results.map(foldPlain)), 'SessionStart');
}

async function selftest() {
  const table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'));
  const d = await import(pathToFileURL(path.join(HERE, 'hook-dispatch.mjs')).href);
  let failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail}`}`);
    if (!ok) failed += 1;
  };
  check('a fresh-start matcher fits startup, resume and clear only', ['startup', 'resume', 'clear'].every((s) => sourceFits('startup|resume|clear', s)) && !sourceFits('startup|resume|clear', 'compact'));
  check('an empty matcher fits every source', SOURCES.every((s) => sourceFits('', s)));
  check('compact runs only the every-source hooks', tableFor(table, 'compact').hooks.SessionStart.flatMap((g) => g.hooks).length === 4);
  check('startup runs all six', tableFor(table, 'startup').hooks.SessionStart.flatMap((g) => g.hooks).length === 6);
  check('plain stdout becomes context', JSON.parse(foldPlain({ code: 0, stdout: 'hello' }).stdout).hookSpecificOutput.additionalContext === 'hello');
  {
    const ctx = (cmd, text) => ({ command: `node C:/x/${cmd}.mjs`, code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) });
    const capped = capStartContext([ctx('suggestion-context', 's'.repeat(4000)), ctx('relay-inject', 'r'.repeat(3000)), ctx('phoenix-context-anywhere', 'h '.repeat(2500))]);
    const texts = capped.map((r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext);
    check('the relay comes first, the history second, the suggestion rules last', capped.map(hookName).join() === 'relay-inject,phoenix-context-anywhere,suggestion-context');
    check('the capped total stays under CONTEXT_CAP', texts.join('\n\n').length <= CONTEXT_CAP, String(texts.join('\n\n').length));
    check('a cut block says how much was left out', /more characters left out/.test(texts[2]) && texts[0].length === 3000 && texts[1].length === 5000);
  }
  check('JSON stdout is left alone', foldPlain({ code: 0, stdout: '{"a":1}' }).stdout === '{"a":1}');
  // Each source, both ways, from a scratch session id, must give the same merged answer. The runner is
  // started fresh for each source, as Claude Code starts it: a module runs once per process, so a
  // second source in THIS process would find every hook already loaded and print nothing.
  const runnerOnce = (payload) =>
    new Promise((done) => {
      let out = '';
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
      child.on('close', (code) => done({ code: code ?? 1, stdout: out }));
      child.stdin.end(payload);
    });
  for (const source of SOURCES) {
    const payload = JSON.stringify({ session_id: `start-dispatch-selftest-${source}`, cwd: os.homedir(), hook_event_name: 'SessionStart', source });
    const inProc = await runnerOnce(payload);
    const cut = tableFor(table, source);
    const asProc = d.mergeHookResults(capStartContext((await Promise.all(cut.hooks.SessionStart.flatMap((g) => g.hooks).map((h) => d.runAsProcess({ command: d.commandOf(h), timeout: h.timeout ?? 60 }, payload)))).map(foldPlain)), 'SessionStart');
    // Live figures move between the two runs (free RAM, the relay's "2m ago"); the shape must not.
    const norm = (o) =>
      String(o.stdout).replace(/\d+ MB/g, 'N MB').replace(/\b\d+(\.\d+)?%/g, 'N%').replace(/\b\d+\s*[smhd] ago\b/g, 'N ago');
    check(`${source}: one process gives the same answer as separate processes`, norm(inProc) === norm(asProc) && inProc.code === asProc.code, `in-process: ${norm(inProc).slice(0, 300)}\n     processes:  ${norm(asProc).slice(0, 300)}`);
  }
  // Tidy the scratch session ids' reminder records.
  for (const source of SOURCES) {
    try { fs.rmSync(path.join(HERE, '..', 'state', 'task-rules', `start-dispatch-selftest-${source}.json`), { force: true }); } catch {}
  }
  console.log(failed ? `${failed} failed` : '0 failed');
  process.exit(failed ? 1 : 0);
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const write = process.stdout.write.bind(process.stdout);
  const exit = process.exit.bind(process);
  process.on('uncaughtException', () => {});
  process.on('unhandledRejection', () => {});
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch {}
  let table;
  try { table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8')); } catch { exit(0); }
  const out = await runStart({ table, payload, processes: process.env.PHX_HOOK_DISPATCH_PROCESSES === '1' });
  // Exit as soon as the answer is flushed: a hook's leftover timer or handle must not hold the start.
  write(out.stdout ?? '', () => exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(() => process.exit(0));
}
