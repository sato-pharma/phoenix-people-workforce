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
//
// `input.prompt` IS NOT OWNER-ONLY. What the human typed arrives there, and so does what the harness
// writes in his place: a background agent's completion notice arrives whole, as
// <task-notification>…</task-notification>, and a <system-reminder> can ride in front of his next
// message. The transcripts also record slash-command echoes (<command-message>, <command-name>,
// <command-args>), scheduled tasks (<scheduled-task>) and CI-monitor events (<ci-monitor-event>) as
// user prompts in the same envelope shape. On 2026-09-15 this armed one session twice without the
// owner ever typing the word: at 16:35 a notice — a config audit whose hooks table named
// "autorun-guard.mjs" — and at 23:23 a reminder that he had started a suggested task titled "Fix
// AUTORUN guard arming on agent reports". Every turn after was told that merging to `main` and
// production migrations were pre-approved. Two defects let it in: the prompt was read whole, and
// `/\bautorun\b/i` matched inside the file name, because `\b` treats a hyphen as a word boundary. So
// the prompt is cut down to the owner's own text first (`ownerText`), and only a standalone,
// upper-case AUTORUN arms (`ARMING`). Tool output and file contents never reach the field, and neither
// do compaction summaries: two of that session's summaries named the word, and neither moved its
// armedAt.
//
// FAILS OPEN: any parse/IO/logic error exits 0 with no output. A hook bug must never eat a prompt.

import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_AGE_DAYS = 14;

// Opens an envelope: a lower-case, hyphenated tag. Every envelope in this machine's Phoenix
// transcripts up to 2026-09-15 is named that way — task-notification, system-reminder, command-name,
// command-message, local-command-stdout, scheduled-task, ci-monitor-event — and not one of the 11,732
// prompts there that open with typed text contains such a tag. So envelopes are cut out as a CLASS:
// the next one the harness invents is dropped too, instead of arming a session. Underscore names stay
// out of the class on purpose — the owner pastes SQL with placeholders like <owner_column>, and a tag
// that never closes cuts to the end of the prompt, his own words with it.
const ENVELOPE_OPEN = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])[^>]*>/;

// The owner's word: upper-case and standalone, as §6.1 spells it and as every arming he ever typed
// spelled it. Nothing touching a letter, digit, "_", "-", "/" or "\" on either side, no "." before
// it, and no "." leading into a name after it — so "autorun-guard.mjs", ".claude/.autorun" and
// "AUTORUN.md" never arm, while "…run the whole plan. AUTORUN." does. Lower-case is how the rule gets
// talked ABOUT, and a false arming pre-approves production merges.
const ARMING = /(?<![A-Za-z0-9_./\\-])AUTORUN(?![A-Za-z0-9_/\\-]|\.[A-Za-z0-9_])/;

// Standing down is the safe direction, so any case counts — but only in the owner's own text too, so a
// notice quoting "AUTORUN OFF" cannot stop a run he armed and left unattended.
const STAND_DOWN = /(?<![A-Za-z0-9_./\\-])autorun\s*[:,–—-]?\s*(off|stop|end|done|cancel)\b/i;

// The prompt with every envelope cut out: from its opening tag to the LAST matching close, so a
// closing tag quoted inside a notice cannot hand the rest of it back as typed text — or to the end of
// the prompt when it never closes.
function ownerText(prompt) {
  let text = prompt;
  for (let open = ENVELOPE_OPEN.exec(text); open; open = ENVELOPE_OPEN.exec(text)) {
    const close = `</${open[1]}>`;
    const at = text.lastIndexOf(close);
    const end = at > open.index ? at + close.length : text.length;
    text = `${text.slice(0, open.index)} ${text.slice(end)}`;
  }
  return text;
}

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

  // Both decisions read only the owner's own text. A stand-down always wins, and is tested BEFORE
  // arming so "AUTORUN OFF" can never arm.
  const owner = ownerText(prompt);
  const standDown = STAND_DOWN.test(owner) || /^\s*(stop|halt)\s*[.!]?\s*$/i.test(owner);
  if (standDown) {
    try {
      rmSync(stateFile, { force: true });
    } catch {
      /* already gone */
    }
    process.exit(0);
  }

  // Arming: the owner's own typed word.
  if (ARMING.test(owner)) {
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
          `Park business-fact questions and ask them all at the end, in chat, as multiple choice ` +
          `(an xlsx only for a long per-item list). Stop only when every phase AND the cleanup are ` +
          `done, then give the final report listing every merge, every production change, and ` +
          `anything left undone. Stand down on "AUTORUN OFF".`,
      },
    }),
  );
  process.exit(0);
} catch {
  process.exit(0);
}
