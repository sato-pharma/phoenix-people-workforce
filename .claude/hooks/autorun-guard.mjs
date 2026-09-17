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
// TALK ABOUT THE WORD IS NOT THE WORD. On 2026-09-17 at 19:12 the owner's own typed task — a
// settings review asking for this very fix — armed its session, because it quoted the cases to
// refuse: `(e.g. "don't AUTORUN", "what does AUTORUN do")`. Both were clean, upper-case and
// standalone. So an occurrence arms only as an instruction (`armingLine`): never inside quotes or
// code, never negated ("don't AUTORUN", "no need for AUTORUN"), never asked about ("what does
// AUTORUN do", "is AUTORUN on?"). Each occurrence is judged on its own, so "what does AUTORUN do?
// never mind, AUTORUN the plan" still arms on the second. These rules only ever REFUSE: a refused
// real arming costs a session that asks as normal; a false one pre-approves production merges.
//
// A STATE FILE FROM AN OLDER GUARD IS NEVER RE-STATED. That guard armed on every mention above, so
// its files carry no `version` and read as not armed (`STATE_VERSION`). Each file now also records
// the owner's words that armed it, and the re-statement quotes them, so a session can see why.
//
// FAILS OPEN: any parse/IO/logic error exits 0 with no output. A hook bug must never eat a prompt.

import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_AGE_DAYS = 14;

// Written into every state file and required on read, so a file from a guard that armed on quoted,
// negated or questioning mentions (anything before 2026-09-17) is inert.
const STATE_VERSION = 2;

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
// A quote mark touching it on either side ('AUTORUN', AUTORUN's) is talk about the word too.
const ARMING = /(?<![A-Za-z0-9_./\\'"`‘’“”«»-])AUTORUN(?![A-Za-z0-9_/\\'"`‘’“”«»-]|\.[A-Za-z0-9_])/g;

// Quoted or code-marked text, blanked before the word is looked for: fenced blocks (to the end when
// never closed), inline code, double- and curly-quoted runs on one line, and "> " quote lines. Single
// quotes are left to ARMING's touching rule — apostrophes ("don't … it's") would pair up wrongly.
const QUOTED = [
  /```[\s\S]*?(?:```|$)/g,
  /`[^`\n]*`/g,
  /"[^"\n]*"/g,
  /“[^”\n]*”/g,
  /«[^»\n]*»/g,
  /^[ \t]*>.*$/gm,
];

// Where a clause starts. Commas, dashes and conjunctions count, so the negation in "don't
// stop — AUTORUN the plan" or "stop asking and AUTORUN" stays in its own clause.
const CLAUSE_BREAK = /[.!?;:,()[\]{}\n—–]|\s-\s|\b(?:and|then|so|but|or|please)\b/gi;

// Read in the last three words before the word, inside its clause. An odd count refuses ("don't
// AUTORUN", "no need for AUTORUN"); an even one cancels ("don't stop AUTORUN").
const NEGATION =
  /^(?:not|no|never|without|dont|don't|doesn't|didn't|isn't|wasn't|won't|wouldn't|shouldn't|can't|cannot|stop|disable|avoid|skip)$/i;

// A clause that opens as a question. "do" only before a pronoun, so "do AUTORUN on the plan" arms.
const QUESTION_OPENING =
  /^\s*(?:(?:what|why|how|when|where|who|which|whether)\b|(?:is|are|was|were|does|did|can|could|should|would|will|has|have|had)\s+(?:it|this|that|there|the|a|an|my|your|you|we|i|he|she|they|autorun)\b|do\s+(?:you|we|i|they)\b)/i;

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

/** Where the clause holding the occurrence at [at, at + length) starts. */
function clauseStart(text, at, length) {
  let start = 0;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    if (m.index + m[0].length <= at) start = m.index + m[0].length;
    else if (m.index >= at + length) break;
  }
  return start;
}

/** Does the sentence running on from `from` end in a question mark? */
function sentenceIsQuestion(text, from) {
  const end = /[.!?](?=\s|$)|\n/.exec(text.slice(from));
  return Boolean(end && end[0] === '?');
}

/**
 * The owner's words that armed the session, or null. Each occurrence of the word is judged on its
 * own: an instruction arms; a quoted, negated or questioning mention never does.
 */
function armingLine(owner) {
  let text = owner;
  // Blanked with spaces, not removed, so every index below still points into the owner's text.
  for (const re of QUOTED) text = text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of text.matchAll(ARMING)) {
    const start = clauseStart(text, m.index, m[0].length);
    const before = (text.slice(start, m.index).match(/[A-Za-z’']+/g) ?? []).slice(-3);
    const negations = before.filter((w) => NEGATION.test(w.replace(/’/g, "'"))).length;
    if (negations % 2 === 1) continue;
    if (QUESTION_OPENING.test(text.slice(start, m.index + m[0].length))) continue;
    if (sentenceIsQuestion(text, m.index + m[0].length)) continue;
    // The whole typed line, so the re-statement shows the owner his own words in full.
    const lineEnd = owner.indexOf('\n', m.index);
    return owner
      .slice(owner.lastIndexOf('\n', m.index) + 1, lineEnd === -1 ? owner.length : lineEnd)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }
  return null;
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

  // Arming: the owner's own typed word, as an instruction.
  const trigger = armingLine(owner);
  if (trigger) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify(
          { version: STATE_VERSION, armedAt: new Date().toISOString(), sessionId, trigger },
          null,
          2,
        ),
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
  // A file an older guard wrote is not an arming this guard would have made.
  if (state?.version !== STATE_VERSION || !state?.armedAt) process.exit(0);

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
          `Cairo, ${hours}h ago, with the words “${String(state.trigger ?? '').slice(0, 160)}”. If ` +
          `those words were not him arming a run, you are NOT armed — tell him in one line. ` +
          `Run the plan to completion: do NOT stop between phases, do NOT ` +
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
