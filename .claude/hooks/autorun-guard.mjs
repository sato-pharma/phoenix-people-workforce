#!/usr/bin/env node
// UserPromptSubmit guard — keeps AGENTS.md §6.1 AUTORUN alive across a long run.
//
// PLACE AT: <repo>/.claude/hooks/autorun-guard.mjs
//
// WHY THIS EXISTS
// AUTORUN is armed by the owner typing the word once. A run he expects to last "a day, two days,
// three days" is compacted many times, and §1.4 is explicit that a replayed summary is not a live
// instruction — so the arming word ages out of context and the session quietly reverts to stopping
// between phases, which is the exact behaviour AUTORUN exists to remove. It fails in the direction
// nobody notices: a session asking permission never reads as a bug, so nothing surfaces it. This
// hook records the arming per session id and re-states it every turn.
//
// WHAT IT DELIBERATELY CANNOT DO
// It NEVER arms AUTORUN on its own. Only the owner's typed word does that (§6.1). The hook can:
//   - notice that word in a prompt the OWNER submitted, and remember it for THIS session id;
//   - re-state an arming that already happened;
//   - forget it on an explicit stand-down.
// A hook able to arm itself would let a doc, a memory, or another session's transcript authorise a
// production merge — see §2.1, Parallel sessions: one approval reaching N sessions is N executions.
// This is why it keys on `input.prompt`, which carries only what the human typed. Tool output, file
// contents and replayed summaries never reach that field.
//
// FAILS OPEN: any parse/IO/logic error exits 0 with no output. A hook bug must never eat a prompt.

import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_AGE_DAYS = 14;

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const prompt = String(input?.prompt ?? '');
  // Session ids are uuids; sanitising keeps this safe as a filename no matter what arrives.
  const sessionId = String(input?.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!sessionId) process.exit(0);

  // fileURLToPath — NOT url.pathname. This repo lives under "F:\Phoenix Workforce\", and pathname
  // would hand back "/F:/Phoenix%20Workforce/...", so every read below would miss silently.
  const hooksDir = dirname(fileURLToPath(import.meta.url));
  const stateDir = join(hooksDir, '..', '.autorun');
  const stateFile = join(stateDir, `${sessionId}.json`);

  // Housekeeping: drop state older than MAX_AGE_DAYS so this never grows without bound.
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    for (const f of readdirSync(stateDir)) {
      const p = join(stateDir, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  } catch {
    /* dir does not exist yet — nothing to clean */
  }

  // A stand-down always wins, and is tested BEFORE arming so "AUTORUN OFF" can never arm.
  const standDown =
    /\bautorun\s*[:,-]?\s*(off|stop|end|done|cancel)\b/i.test(prompt) ||
    /^\s*(stop|halt)\s*[.!]?\s*$/i.test(prompt);
  if (standDown) {
    try {
      rmSync(stateFile, { force: true });
    } catch {
      /* already gone */
    }
    process.exit(0);
  }

  // Arming: the owner's own typed word.
  if (/\bautorun\b/i.test(prompt)) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify({ armedAt: new Date().toISOString(), sessionId }, null, 2),
      );
    } catch {
      /* if it cannot be persisted, the word is still in this turn's own context */
    }
    process.exit(0);
  }

  // Already armed? Re-state it. Not armed is the overwhelmingly common path and costs one failed
  // read.
  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    process.exit(0);
  }
  if (!state?.armedAt) process.exit(0);

  const armedMs = Date.parse(state.armedAt);
  if (!Number.isFinite(armedMs)) process.exit(0);

  // Africa/Cairo, per the standing reporting rule. Intl is used deliberately — a TZ= env var
  // silently returns UTC under MSYS on this machine (§2.1).
  const cairo = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(armedMs));
  const hours = Math.max(0, Math.round((Date.now() - armedMs) / 3_600_000));

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          `AUTORUN IS ARMED for this session — AGENTS.md §6.1. The owner armed it at ${cairo} ` +
          `Cairo, ${hours}h ago. Run the plan to completion: do NOT stop between phases, do NOT ` +
          `ask whether to proceed, do NOT pause on a red check or a merge conflict — fix it and ` +
          `carry on. Merging to \`main\` and production migrations are pre-approved for this run. ` +
          `Park business-fact questions and deliver them as ONE xlsx at the end. Stop only when ` +
          `every phase AND the cleanup are done, then give the final report listing every merge, ` +
          `every production change, and anything left undone. Stand down on "AUTORUN OFF".`,
      },
    }),
  );
  process.exit(0);
} catch {
  process.exit(0);
}
