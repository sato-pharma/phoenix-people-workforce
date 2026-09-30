#!/usr/bin/env node
// PreToolUse(Write|Edit|NotebookEdit|Bash|PowerShell) guard — the OWNER-LOCKED FILES.
//
// THE RULE. CLAUDE.md "Protected Files — OWNER APPROVAL REQUIRED" locks four files. The Office
// golden rule has a CI lock and a password (tests/office-golden-rule-lock.test.ts). The other three
// had NOTHING behind them: permissions.ask was emptied on 2026-08-14, and the desktop app runs every
// session with --permission-mode auto, so no dialog could fire on any path. CLAUDE.md said it
// plainly — "behavioral ONLY — no prompt backs them" — which means one session misreading one
// sentence could rewrite the salary formulas or the incentive curve with nothing to stop it.
//
// WHAT THIS DOES. An edit to one of those three files now returns permissionDecision "ask", which
// the hooks docs say raises a real prompt even in auto mode (only bypassPermissions skips it). The
// prompt is the owner's click, in the UI, on the exact tool call — never a session's reading of the
// conversation. Owner instruction for this hook: "build the protected-file ask hook", 2026-09-30.
//
//   - Write / Edit / NotebookEdit naming a locked file (relative, absolute, backslash, any worktree).
//   - A shell command that WRITES one: a redirect into it, sed -i, rm/mv/cp/touch/tee, a PowerShell
//     Set-Content/Out-File/Remove-Item…, or git checkout/restore/rm naming it.
//
// WHAT IT DELIBERATELY DOES NOT DO.
//   - It never DENIES. The owner may approve the change; a deny would leave no path to do it.
//   - It never prompts on READS (cat, git diff, git show, git grep, git log). A guard that nags on
//     reads gets switched off inside a day (bash-guard retired its jq rule for exactly that).
//   - It does not cover office-allocation.ts — that one has its own CI lock, which is stronger.
//   - It does not stall an AUTORUN plan. AGENTS.md §6.1 rules that under AUTORUN these files are
//     "announced, not awaited", so when this session is armed (autorun-guard.mjs's state file, which
//     only the owner's own typed word creates) the edit proceeds and the session is told to announce
//     it. An unreadable or expired state file reads as NOT armed, so the prompt is the default.
//
// No stand-down variable, on purpose: a Bash prefix cannot reach this process anyway, and the
// owner's click IS the way through. Fails open on any error, like every hook here.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The three behavioral locks, in the words the owner sees on the prompt. */
export const PROTECTED_FILES = [
  {
    path: 'src/lib/incentives/scheme-2026.ts',
    what: 'the 2026 incentive payout curve, achievement thresholds and semester target formula',
  },
  {
    path: 'src/lib/payroll/policy.ts',
    what: 'the 70% basic-salary rate and every salary formula (base, basic, net, gross)',
  },
  {
    path: 'src/components/employee-portal/identity-card.tsx',
    what: 'the employee portal identity banner, which must stay PhoenixSignatureCard',
  },
];

const AUTORUN_MAX_AGE_DAYS = 14; // autorun-guard.mjs deletes state older than this
const AUTORUN_STATE_VERSION = 2; // and ignores any file without it

/* ------------------------------------------------------------------ path rule */

function normalise(rawPath) {
  return String(rawPath).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

/** The locked file a path points at, or null. Matches on whole path segments, never a substring. */
export function protectedFileFor(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const p = normalise(rawPath.trim());
  if (p.split('/').includes('node_modules')) return null;
  return PROTECTED_FILES.find((f) => p === f.path || p.endsWith(`/${f.path}`)) ?? null;
}

/* ----------------------------------------------------------------- shell rule */

const WRITE_VERBS = [
  /(^|[\s;&|(])(?:rm|mv|cp|touch|tee|dd|truncate|ln|chmod)(?=\s)/i,
  /(^|[\s;&|(])sed\s+[^|;]*-i/i,
  /(^|[\s;&|(])perl\s+[^|;]*-p?i/i,
  /(^|[\s;&|(])git\s+(?:checkout|restore|rm|mv|apply)(?=\s)/i,
  /(^|[\s;&|(])(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content)(?=\s)/i,
  /\[(?:System\.)?IO\.File\]::(?:Write|Append|Delete|Copy|Move)/i,
];

function pathPattern(relPath) {
  // Either separator, any prefix, and a boundary after the file name so policy.tsx is not policy.ts.
  const body = relPath
    .split('/')
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[/\\\\]+');
  return new RegExp(`${body}(?![A-Za-z0-9_.-])`, 'i');
}

/** The locked file a shell command WRITES, or null. Reads return null. */
export function shellTarget(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  for (const file of PROTECTED_FILES) {
    const named = pathPattern(file.path);
    if (!named.test(command)) continue;
    const redirect = new RegExp(`>>?\\s*["']?[^\\s"';|&]*${named.source}`, 'i');
    if (redirect.test(command) || WRITE_VERBS.some((re) => re.test(command))) return file;
  }
  return null;
}

/* ---------------------------------------------------------------- AUTORUN state */

/** True only when autorun-guard.mjs has a current, owner-typed arming on file for this session. */
export function autorunArmed(sessionId, stateDir) {
  const id = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return false;
  try {
    const state = JSON.parse(readFileSync(join(stateDir, `${id}.json`), 'utf8'));
    if (state?.version !== AUTORUN_STATE_VERSION) return false;
    const armedMs = Date.parse(state.armedAt);
    if (!Number.isFinite(armedMs)) return false;
    return Date.now() - armedMs < AUTORUN_MAX_AGE_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ hook entry */

function emit(decision, reason, context) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
        additionalContext: context,
      },
    })}\n`,
  );
}

function main() {
  const payload = (() => {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  })();
  if (!payload.trim()) return;
  const input = JSON.parse(payload);

  const tool = input.tool_name || '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};

  let file = null;
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const raw = toolInput.file_path || toolInput.notebook_path || toolInput.path || '';
    const target = raw && !isAbsolute(raw) ? resolve(input.cwd || process.cwd(), raw) : raw;
    file = protectedFileFor(target);
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    file = shellTarget(toolInput.command);
  }
  if (!file) return;

  const stateDir =
    process.env.PHX_AUTORUN_STATE_DIR ||
    join(dirname(fileURLToPath(import.meta.url)), '..', '.autorun');

  if (autorunArmed(input.session_id, stateDir)) {
    return emit(
      'allow',
      `AUTORUN is armed: owner-locked file ${file.path} is announced, not awaited (AGENTS.md §6.1).`,
      `${file.path} is an OWNER-LOCKED file (${file.what}). AUTORUN is armed for this session, so ` +
        'AGENTS.md §6.1 lets the edit proceed — but you MUST announce it in plain words first: the ' +
        'exact change and why it is necessary. If you did not announce it before this call, say it ' +
        'now, before anything else.',
    );
  }

  return emit(
    'ask',
    `Owner-locked file: ${file.what} (${file.path}). Approve only if you already approved this ` +
      'exact change in chat.',
    `${file.path} is on CLAUDE.md's Protected Files list (${file.what}). The owner is being asked ` +
      'to approve this tool call. If he has NOT approved this specific change in the conversation, ' +
      'stop: show him the exact change and why it is necessary, and wait for his plain answer. A ' +
      'refused prompt is his answer — never retry the edit another way.',
  );
}

try {
  main();
} catch {
  process.exit(0); // fail open, always
}
