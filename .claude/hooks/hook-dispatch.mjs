#!/usr/bin/env node
// ONE node process for every PreToolUse hook of this repository, instead of one process per hook.
//
// WHY (measured 2026-10-08 on this laptop). A Bash or Edit call matched 7 project hooks, and Claude
// Code started each as its own node process. Each hook's own work is a few milliseconds; nearly all
// of its cost is node starting up (~60 ms of CPU, ~57 MB of memory) — so one call cost ~850 ms of CPU
// and ~400 MB of short-lived memory, on a 16 GB machine whose binding limit is free RAM. Run in ONE
// isolate the same seven hooks cost ~100 ms of CPU and ~60 MB. (Worker threads were measured first and
// do NOT help: a worker costs ~76 ms of CPU to start on this machine, the same as a process.)
//
// HOW. `.claude/hooks/dispatch.json` holds the hooks in exactly the shape settings.json used
// (matcher, command, timeout). This file reads the payload once, picks the hooks whose matcher fits
// the tool (Claude Code's own matcher rule), and runs each UNCHANGED hook script in this process, one
// after another, giving each exactly what it had as its own process: the payload on fd 0, its own
// path as argv[1], its own captured stdout/stderr, and a process.exit() that ends THAT hook — the
// first call's code is its exit code, and nothing it writes after that counts. process.env, the
// exit code and process-level listeners are restored after each, so no hook sees another's changes.
// Then the answers are merged the way Claude Code merges parallel hooks: a blocking exit 2 wins,
// then deny > ask > allow, every reason and every additionalContext kept.
//
// THE ONE CONTRACT A HOOK MUST KEEP TO RUN HERE: its work finishes when its module finishes loading
// (top-level code, or a top-level `await`) — never a floating `main()` promise — and a `catch` around
// code that can exit either exits too or rethrows `e?.[Symbol.for('phx.hook-exit')]`. Both are
// checked mechanically by tests/hook-dispatch.test.ts, which also runs every hook both ways over a
// corpus of tool calls and requires identical answers. A hook that cannot keep it is marked
// `"run": "worker"` (its own worker thread) or `"run": "process"` (its own process) in the table.
//
// FAILS SAFE, NOT SILENT. A hook that throws or exits non-zero is what it was as a process —
// non-blocking, reported. If the dispatcher itself fails, it falls back to running the same commands
// as separate processes, so no guard stops enforcing because of this file.
// PHX_HOOK_DISPATCH_PROCESSES=1 forces that process mode (an escape hatch and an A/B switch).
//
// TWO COPIES, ONE SOURCE. This file and hook-dispatch-worker.mjs are also copied byte-for-byte into
// ~/.claude/hooks/, where they run the USER-level PreToolUse hooks of ~/.claude/settings.json — every
// copy reads the dispatch.json beside it. Edit here, then copy; never edit the copy.
// Account: docs/hook-dispatcher.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HOOKS_DIR, '..', '..');
export const TABLE_FILE = join(HOOKS_DIR, 'dispatch.json');
export const HOOK_EXIT = Symbol.for('phx.hook-exit');
const DEFAULT_TIMEOUT_S = 60; // Claude Code's own default for a command hook
const STREAM_GRACE_MS = 250;
const PROCESS_EVENTS = ['uncaughtException', 'unhandledRejection', 'exit', 'beforeExit', 'warning'];

/**
 * Claude Code's matcher rule: a matcher of plain names and pipes is an EXACT list; anything else is
 * an unanchored regular expression; empty or `*` matches every tool.
 */
export function matcherFits(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(toolName);
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

/**
 * `node "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.mjs" arg …` or `node "C:/absolute/path/x.mjs" arg …`
 * → { script, args }, else null.
 */
const NODE_COMMAND =
  /^node\s+"(\$\{CLAUDE_PROJECT_DIR\}\/\.claude\/hooks\/[\w.-]+\.mjs|(?:[A-Za-z]:)?\/[^"]*\/[\w.-]+\.mjs)"((?:\s+[\w.-]+)*)\s*$/;
const PROJECT_PREFIX = '${CLAUDE_PROJECT_DIR}/';
export function parseCommand(command) {
  const m = NODE_COMMAND.exec(command ?? '');
  if (!m) return null;
  const script = m[1].startsWith(PROJECT_PREFIX) ? join(REPO_ROOT, m[1].slice(PROJECT_PREFIX.length)) : resolve(m[1]);
  return { script, args: m[2].trim() ? m[2].trim().split(/\s+/) : [] };
}

/**
 * settings.json also takes `"command": "node", "args": [script, …]` — the form the user-level
 * ~/.claude/settings.json uses, whose hooks a copy of this file dispatches. Fold it into the one
 * command string everything below reads; plain `[\w.-]` arguments only, as parseCommand requires.
 */
export function commandOf(hook) {
  if (!Array.isArray(hook?.args) || !hook.args.length) return hook?.command;
  const quote = (a) => (/^[\w./:-]+$/.test(a) ? a : JSON.stringify(a));
  const [first, ...rest] = hook.args.map(String);
  if (hook.command === 'node' && /\.mjs$/.test(first)) return [`node "${first}"`, ...rest.map(quote)].join(' ');
  return [hook.command, ...hook.args.map((a) => quote(String(a)))].join(' ');
}

/** Every hook of `event` whose matcher fits `toolName`, in table order. */
export function selectHooks(table, event, toolName) {
  const out = [];
  for (const group of table?.hooks?.[event] ?? []) {
    if (!matcherFits(group.matcher, toolName)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type && hook.type !== 'command') continue;
      out.push({ command: commandOf(hook), timeout: hook.timeout ?? DEFAULT_TIMEOUT_S, run: hook.run ?? 'in-process' });
    }
  }
  return out;
}

const nameOf = (command) => (/([\w.-]+)\.mjs/.exec(command ?? '') ?? [, String(command).slice(0, 40)])[1];
const text = (chunk, encoding) =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');

// ── in-process ──────────────────────────────────────────────────────────────────────────────────

let stdinPayload = '';
let stdinPatched = false;
/** Every hook reads its payload with readFileSync(0); fd 0 is already drained, so answer from memory. */
function patchStdin(payload) {
  stdinPayload = payload;
  if (stdinPatched) return;
  stdinPatched = true;
  const original = fs.readFileSync;
  fs.readFileSync = function readFileSync(target, options) {
    if (target === 0 || target === '/dev/stdin') {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? stdinPayload : Buffer.from(stdinPayload, 'utf8');
    }
    return original.apply(this, arguments);
  };
  syncBuiltinESMExports();
}

class HookExit {
  constructor(code) {
    this.code = code;
    this[HOOK_EXIT] = true;
  }
}

/** Run ONE hook in this isolate. Never two at once — they share process.stdout and friends. */
export async function runInProcess(hook, payload) {
  const parsed = parseCommand(hook.command);
  if (!parsed) return runAsProcess(hook, payload);
  patchStdin(payload);
  const saved = {
    argv: process.argv,
    env: { ...process.env },
    exitCode: process.exitCode,
    exit: process.exit,
    out: process.stdout.write,
    err: process.stderr.write,
    listeners: Object.fromEntries(PROCESS_EVENTS.map((e) => [e, process.listeners(e)])),
  };
  let stdout = '';
  let stderr = '';
  let code = null;
  const capture = (sink) =>
    function write(chunk, encoding, callback) {
      if (code === null) {
        if (sink === 'out') stdout += text(chunk, encoding);
        else stderr += text(chunk, encoding);
      }
      const cb = typeof encoding === 'function' ? encoding : callback;
      if (typeof cb === 'function') queueMicrotask(cb);
      return true;
    };
  process.stdout.write = capture('out');
  process.stderr.write = capture('err');
  process.exit = (c) => {
    if (code === null) code = Number(c ?? process.exitCode ?? 0) || 0;
    throw new HookExit(code);
  };
  process.exitCode = undefined;
  process.argv = [process.execPath, parsed.script, ...parsed.args];
  try {
    await import(pathToFileURL(parsed.script).href);
  } catch (err) {
    if (!err?.[HOOK_EXIT] && code === null) {
      stderr += `${err?.stack ?? err}\n`;
      code = 1;
    }
  }
  if (code === null) code = Number(process.exitCode ?? 0) || 0;
  // Restore everything the hook could have changed, so the next one starts as a fresh process would.
  process.stdout.write = saved.out;
  process.stderr.write = saved.err;
  process.exit = saved.exit;
  process.exitCode = saved.exitCode;
  process.argv = saved.argv;
  for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
  Object.assign(process.env, saved.env);
  for (const event of PROCESS_EVENTS) {
    for (const listener of process.listeners(event)) {
      if (!saved.listeners[event].includes(listener)) process.removeListener(event, listener);
    }
  }
  return { command: hook.command, code, stdout, stderr, timedOut: false };
}

// ── worker thread (opt-in per hook: "run": "worker") ────────────────────────────────────────────

function runInWorker(hook, payload) {
  const parsed = parseCommand(hook.command);
  if (!parsed) return runAsProcess(hook, payload);
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let worker;
    try {
      worker = new Worker(join(HOOKS_DIR, 'hook-dispatch-worker.mjs'), {
        workerData: { script: parsed.script, args: parsed.args, payload },
        stdout: true,
        stderr: true,
        env: process.env,
      });
    } catch {
      resolveRun(runAsProcess(hook, payload));
      return;
    }
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => resolveRun({ command: hook.command, code, stdout, stderr, timedOut }), 0);
    };
    let streamsOpen = 2;
    let exitCode;
    const streamEnded = () => {
      if (--streamsOpen === 0 && exitCode !== undefined) finish(exitCode);
    };
    worker.stdout.setEncoding('utf8').on('data', (d) => (stdout += d)).once('end', streamEnded);
    worker.stderr.setEncoding('utf8').on('data', (d) => (stderr += d)).once('end', streamEnded);
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(null, true);
    }, hook.timeout * 1000);
    worker.on('error', (err) => {
      stderr += `${err?.stack ?? err}\n`; // an uncaught exception: what node prints, then exit 1
    });
    worker.on('exit', (code) => {
      exitCode = code;
      if (streamsOpen === 0) finish(code);
      else setTimeout(() => finish(code), STREAM_GRACE_MS).unref();
    });
  });
}

// ── separate process (opt-in per hook: "run": "process"; and the fallback) ─────────────────────

/** The old way: one process for one hook command. The fallback, and the A/B baseline. */
export function runAsProcess(hook, payload) {
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ command: hook.command, code, stdout, stderr, timedOut });
    };
    const env = { ...process.env, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || REPO_ROOT };
    const parsed = parseCommand(hook.command);
    try {
      // A node hook runs as node directly: no shell, so `${CLAUDE_PROJECT_DIR}` never depends on
      // which shell this machine would have picked (cmd.exe does not expand it).
      child = parsed
        ? spawn(process.execPath, [parsed.script, ...parsed.args], { cwd: process.cwd(), env, windowsHide: true })
        : spawn(hook.command.replaceAll('${CLAUDE_PROJECT_DIR}', env.CLAUDE_PROJECT_DIR), {
            shell: true,
            cwd: process.cwd(),
            env,
            windowsHide: true,
          });
    } catch (err) {
      stderr = String(err?.stack ?? err);
      finish(1);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null, true);
    }, hook.timeout * 1000);
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => { stderr += String(err?.stack ?? err); finish(1); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

// ── merge ───────────────────────────────────────────────────────────────────────────────────────

const RANK = { allow: 1, ask: 2, deny: 3 };

/**
 * Merge hook results into the ONE answer Claude Code gets, as it merges parallel hooks itself.
 * Returns { code, stdout, stderr }.
 */
export function mergeHookResults(results, event = 'PreToolUse') {
  const blocking = results.filter((r) => r.code === 2);
  if (blocking.length) {
    return { code: 2, stdout: '', stderr: blocking.map((r) => r.stderr.trim()).filter(Boolean).join('\n\n') + '\n' };
  }
  let decision = null;
  const reasons = { allow: [], ask: [], deny: [] };
  const contexts = [];
  const messages = [];
  const plain = [];
  const stopReasons = [];
  let stop = false;
  let suppress = false;
  let updatedInput;
  for (const r of results) {
    if (r.timedOut || r.code !== 0) {
      const why = r.timedOut ? 'timed out' : `exited ${r.code}`;
      const detail = (r.stderr || '').trim().split('\n')[0];
      messages.push(`${event} hook ${nameOf(r.command)} ${why}${detail ? `: ${detail}` : ''}`);
      continue;
    }
    const body = (r.stdout || '').trim();
    if (!body) continue;
    let out;
    try { out = JSON.parse(body); } catch { out = null; }
    if (!out || typeof out !== 'object' || Array.isArray(out)) { plain.push(body); continue; }
    const specific = out.hookSpecificOutput ?? {};
    let d = specific.permissionDecision;
    if (!d && out.decision === 'block') d = 'deny';
    if (!d && out.decision === 'approve') d = 'allow';
    if (d && RANK[d]) {
      if (!decision || RANK[d] > RANK[decision]) decision = d;
      const why = specific.permissionDecisionReason ?? out.reason;
      if (why) reasons[d].push(why);
    }
    if (specific.additionalContext) contexts.push(specific.additionalContext);
    if (specific.updatedInput && updatedInput === undefined) updatedInput = specific.updatedInput;
    if (out.systemMessage) messages.push(out.systemMessage);
    if (out.continue === false) { stop = true; if (out.stopReason) stopReasons.push(out.stopReason); }
    if (out.suppressOutput) suppress = true;
  }
  const specific = { hookEventName: event };
  if (decision) {
    specific.permissionDecision = decision;
    if (reasons[decision].length) specific.permissionDecisionReason = reasons[decision].join('\n\n');
  }
  if (contexts.length) specific.additionalContext = contexts.join('\n\n');
  if (updatedInput !== undefined) specific.updatedInput = updatedInput;
  const merged = {};
  if (Object.keys(specific).length > 1) merged.hookSpecificOutput = specific;
  if (messages.length) merged.systemMessage = messages.join('\n');
  if (stop) { merged.continue = false; if (stopReasons.length) merged.stopReason = stopReasons.join('\n'); }
  if (suppress) merged.suppressOutput = true;
  if (Object.keys(merged).length === 0) return { code: 0, stdout: plain.join('\n'), stderr: '' };
  // Plain (non-JSON) stdout on exit 0 is transcript-only for PreToolUse; it cannot ride inside JSON.
  return { code: 0, stdout: JSON.stringify(merged), stderr: '' };
}

// ── dispatch ────────────────────────────────────────────────────────────────────────────────────

/** Run every matching hook for one call and merge. `processes` forces the old one-process-each way. */
export async function runHooks({ event, payload, table, processes = false }) {
  let toolName = '';
  try { toolName = JSON.parse(payload.replace(/^﻿/, '')).tool_name ?? ''; } catch {}
  const hooks = selectHooks(table, event, toolName);
  if (processes) return Promise.all(hooks.map((h) => runAsProcess(h, payload)));
  try {
    // Workers and processes start at once; in-process hooks run one at a time meanwhile.
    const pending = hooks.map((h) =>
      h.run === 'worker' ? runInWorker(h, payload) : h.run === 'process' ? runAsProcess(h, payload) : null,
    );
    for (const [i, h] of hooks.entries()) if (!pending[i]) pending[i] = await runInProcess(h, payload);
    return await Promise.all(pending);
  } catch {
    return Promise.all(hooks.map((h) => runAsProcess(h, payload)));
  }
}

export async function dispatch(options) {
  return mergeHookResults(await runHooks(options), options.event);
}

async function main() {
  const event = process.argv[2] || 'PreToolUse';
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const exit = process.exit.bind(process);
  // A hook's stray async error, or its exit from a callback, must never take the dispatcher down.
  process.on('uncaughtException', () => {});
  process.on('unhandledRejection', () => {});
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch {}
  let table;
  try { table = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8')); } catch { exit(0); }
  const processes = process.env.PHX_HOOK_DISPATCH_PROCESSES === '1';
  const out = await dispatch({ event, payload, table, processes });
  if (out.stderr) write.err(out.stderr);
  // Exit as soon as the answer is flushed: a hook's leftover timer or handle must not hold the call.
  write.out(out.stdout ?? '', () => exit(out.code));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0)); // fail open, like every hook here
}
