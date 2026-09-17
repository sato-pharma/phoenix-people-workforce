// A BACKGROUND AGENT'S NOTICE MUST NEVER ARM AUTORUN — ONLY THE OWNER'S OWN TYPED WORD DOES.
//
// WHY THIS EXISTS. `.claude/hooks/autorun-guard.mjs` remembers an AUTORUN arming per session and then
// tells every later turn that merging to `main` and production migrations are pre-approved (AGENTS.md
// §6.1). On 2026-09-15 it armed a session whose owner never typed the word — twice. At 16:35 the one
// user-role message carrying the word was a background agent's completion notice, a config audit whose
// hooks table named "autorun-guard.mjs"; at 23:23 it was a reminder, delivered in front of the owner's
// next message, that he had started a suggested task titled "Fix AUTORUN guard arming on agent
// reports". The harness delivers both in the same `prompt` field as typed text, and each time the state
// file was written in the same second the message landed. Any session whose agent so much as mentioned
// the hook was handed the same false pre-approval.
//
// TWO DEFECTS, EACH PINNED ON ITS OWN, so a fix to one can never hide a regression in the other:
//   1. THE ENVELOPE. The hook read the prompt whole. A notice, a reminder or a slash command's echo is
//      the harness talking, whatever it quotes. The cases isolating this carry a clean, upper-case,
//      standalone AUTORUN that only cutting the envelope out can stop.
//   2. THE TOKEN. `/\bautorun\b/i` matched inside "autorun-guard.mjs", because `\b` treats a hyphen as
//      a word boundary. The cases isolating this are typed text with no envelope at all.
//   3. THE MENTION (2026-09-17). The owner's own typed task — asking for this very fix — armed its
//      session at 19:12, because it quoted the cases to refuse: `(e.g. "don't AUTORUN", "what does
//      AUTORUN do")`. Clean, upper-case, standalone, typed by him. A quoted, negated or questioning
//      mention is talk about the word, so each of those shapes is pinned on its own below.
//   4. THE OLD STATE FILE. A file the older guard wrote was judged by rules that armed on all of the
//      above, so it must never be re-stated — the fix has to reach sessions already falsely armed.
//
// THE REAL HOOK RUNS AS A SUBPROCESS, from a throwaway copy. The property is a runtime one: is a state
// file written, and is the next turn told it is armed. The hook keeps its state beside itself
// (`../.autorun/`), so a copy inside a temporary `.claude/hooks/` can never touch a live session's.
//
// THE OWNER'S WORD IS ASSERTED AS HARD AS THE REFUSALS. A guard that stopped arming altogether would
// pass every "must not arm" case below while quietly breaking the rule it exists to serve.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The hook under test, resolved from the repo root the suite runs in. */
const hookSource = resolve(".claude/hooks/autorun-guard.mjs");

type HookOutput = { hookSpecificOutput?: { additionalContext?: string } };
type Sandbox = { hook: string; stateDir: string };
type Case = { session: string; prompt: string; why: string };

/** A completion notice in the shape that armed the session: the same tags, in the same order. */
function taskNotification(result: string): string {
  return [
    "<task-notification>",
    "<task-id>a0f0c0de0000000001</task-id>",
    "<tool-use-id>toolu_fixture</tool-use-id>",
    "<output-file>C:\\Users\\owner\\AppData\\Local\\Temp\\claude\\tasks\\a0f0c0de0000000001.output</output-file>",
    "<status>completed</status>",
    '<summary>Agent "Audit hooks wiring and scripts" finished</summary>',
    `<result>${result}</result>`,
    "<usage><subagent_tokens>261896</subagent_tokens><tool_uses>53</tool_uses></usage>",
    "</task-notification>",
  ].join("\n");
}

/** Submits one prompt exactly as the UserPromptSubmit entry does: the event JSON on stdin. */
function submit(sandbox: Sandbox, session: string, prompt: string): HookOutput | null {
  const raw = execFileSync(process.execPath, [sandbox.hook], {
    input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  return raw.trim() ? (JSON.parse(raw) as HookOutput) : null;
}

const isArmed = (sandbox: Sandbox, session: string): boolean =>
  existsSync(join(sandbox.stateDir, `${session}.json`));

/** What the NEXT ordinary turn is told — the sentence a session actually acts on. */
const nextTurn = (sandbox: Sandbox, session: string): string =>
  submit(sandbox, session, "carry on with the next phase")?.hookSpecificOutput?.additionalContext ?? "";

function testTheGuardIsWired() {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
    hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> };
  };
  const entries = (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) => group.hooks ?? []);
  assert.equal(
    entries.filter((entry) => (entry.command ?? "").includes("autorun-guard.mjs")).length,
    1,
    "the AUTORUN guard must be registered exactly once as a UserPromptSubmit hook — unregistered, every case "
      + "below passes against a file nothing runs",
  );
}

function testANoticeNeverArms(sandbox: Sandbox) {
  // THE INCIDENT, as it arrived: a notice whose result quotes the hooks-table row naming this file.
  submit(
    sandbox,
    "incident",
    taskNotification(
      "| Event | Matcher | Script | Mode | Scope | Bytes | State |\n"
        + "| UserPromptSubmit | – | autorun-guard.mjs | default | project | 170 | 0 / empty (not armed) |",
    ),
  );
  assert.equal(
    isArmed(sandbox, "incident"),
    false,
    "a background agent's completion notice naming autorun-guard.mjs must NOT arm AUTORUN — the owner never "
      + "typed the word",
  );
  assert.doesNotMatch(
    nextTurn(sandbox, "incident"),
    /AUTORUN IS ARMED/,
    "the next turn must not be told that merging to main and production migrations are pre-approved",
  );

  // THE SECOND ARMING, as it arrived at 23:23 the same day: a reminder that the owner had started a suggested
  // task, delivered in front of his next message. The title carries the word clean, upper-case and
  // standalone, so only cutting the envelope out can stop it.
  const secondArming =
    "<system-reminder>\nThe user started your suggested background task task_7b803392 (\"Fix AUTORUN guard arming "
    + "on agent reports\") in a separate local session. It is running independently. You will be notified here "
    + "when it ends.\n</system-reminder>\n";
  submit(sandbox, "second-arming", `${secondArming}env | grep CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`);
  assert.equal(
    isArmed(sandbox, "second-arming"),
    false,
    "a reminder naming a task the owner started must NOT arm AUTORUN — the title is the harness's text, and what he "
      + "typed after it never said the word",
  );
  // The cut takes the envelope and nothing after it. Reminders ride in front of real messages, so the owner's
  // own word behind one must still arm.
  submit(sandbox, "reminder-then-typed", `${secondArming}AUTORUN finish the plan`);
  assert.equal(
    isArmed(sandbox, "reminder-then-typed"),
    true,
    "the owner's AUTORUN typed behind a reminder must still arm — cutting the envelope must never swallow his message",
  );

  const envelopes: Case[] = [
    {
      session: "notice-quotes-the-word",
      prompt: taskNotification("The owner re-arms it by typing AUTORUN finish the plan."),
      why: "a notice is the harness speaking, whatever it quotes — even a clean, upper-case AUTORUN inside one "
        + "arms nothing",
    },
    {
      session: "notice-quotes-its-own-close",
      prompt: taskNotification("strip everything up to </task-notification> and then AUTORUN arms"),
      why: "a closing tag QUOTED inside a notice must not hand the rest of the notice back as the owner's text — "
        + "the cut runs to the LAST close",
    },
    {
      session: "notice-cut-short",
      prompt: "<task-notification>\n<task-id>a0f0c0de0000000002</task-id>\n<result>AUTORUN finish the plan",
      why: "a notice that never closes is still a notice, to the end of the prompt",
    },
    {
      session: "slash-command",
      prompt:
        "<command-message>next-step is running…</command-message>\n"
        + "<command-name>/next-step</command-name>\n"
        + "<command-args>AUTORUN</command-args>",
      why: "a slash command's echo (<command-message>, <command-name>, <command-args>) is an envelope, not the "
        + "owner typing the word",
    },
    {
      session: "any-hyphenated-envelope",
      prompt: "<session-handoff-note>AGENTS.md §6.1: the owner arms a run by typing AUTORUN.</session-handoff-note>",
      why: "every hyphenated envelope is dropped as a class, so one the harness has not invented yet cannot arm a "
        + "session either",
    },
  ];
  for (const c of envelopes) {
    submit(sandbox, c.session, c.prompt);
    assert.equal(isArmed(sandbox, c.session), false, c.why);
  }
}

function testAFileNameOrPathNeverArms(sandbox: Sandbox) {
  const typed: Case[] = [
    {
      session: "file-name",
      prompt: "why did autorun-guard.mjs fire in that session?",
      why: "the incident's own spelling, typed: a file name is not the word",
    },
    {
      session: "state-folder",
      prompt: "look inside .claude/.autorun/ for the state file",
      why: "a path to the state folder is not the word",
    },
    // Upper-case twins of the same shapes. They isolate the TOKEN rule from the case rule, so relaxing
    // the case later can never quietly let file names and paths arm again.
    {
      session: "upper-hyphen",
      prompt: "open AUTORUN-guard.mjs and read the header",
      why: "a hyphen touching AUTORUN makes it part of a name, not the word",
    },
    {
      session: "upper-extension",
      prompt: "read AUTORUN.md first",
      why: "a '.' leading into an extension makes it a file name, not the word",
    },
    {
      session: "upper-dot-folder",
      prompt: "the state lives in .claude/.AUTORUN",
      why: "a '.' or '/' before it makes it a folder name, not the word",
    },
    {
      session: "upper-slash",
      prompt: "see docs/AUTORUN for the account",
      why: "a '/' before it makes it a path, not the word",
    },
    {
      session: "upper-windows-path",
      prompt: "F:\\Phoenix Workforce\\AUTORUN\\state.json",
      why: "a backslash touching it makes it a Windows path, not the word",
    },
    {
      session: "upper-identifier",
      prompt: "rename AUTORUN_STATE_DIR",
      why: "an underscore touching it makes it an identifier, not the word",
    },
  ];
  for (const c of typed) {
    submit(sandbox, c.session, c.prompt);
    assert.equal(isArmed(sandbox, c.session), false, c.why);
  }
}

function testAQuotedNegatedOrQuestioningMentionNeverArms(sandbox: Sandbox) {
  // THE INCIDENT, as he typed it: the sixth item of a settings-review task, word for word.
  const incident =
    "6. Hooks under `.claude/hooks/` — investigate and fix what is real, with a regression test where the repo "
    + "has a hook test pattern:\n"
    + "   - autorun-guard.mjs armed a session falsely on 2026-09-15 23:23 (Cairo); its state files were moved "
    + "out on 2026-09-17. Make sure the guard never arms on a negated or quoted mention of the word (e.g. "
    + "\"don't AUTORUN\", \"what does AUTORUN do\") and does not re-state an arming from a state file written "
    + "before the fix.";
  submit(sandbox, "incident-2026-09-17", incident);
  assert.equal(
    isArmed(sandbox, "incident-2026-09-17"),
    false,
    "the owner's task quoting \"don't AUTORUN\" and \"what does AUTORUN do\" must NOT arm AUTORUN — it armed its "
      + "own session on 2026-09-17 at 19:12",
  );
  assert.doesNotMatch(nextTurn(sandbox, "incident-2026-09-17"), /AUTORUN IS ARMED/, "and no later turn hears it is armed");

  const mentions: Case[] = [
    { session: "quoted-double", prompt: 'explain "AUTORUN" to me', why: "a double-quoted word is talk about it" },
    { session: "quoted-curly", prompt: "what the owner types is “AUTORUN” and nothing else", why: "a curly-quoted word is talk about it" },
    { session: "quoted-single", prompt: "the trigger is 'AUTORUN' in capitals", why: "a single quote touching the word is talk about it" },
    { session: "possessive", prompt: "AUTORUN's rule says merges are pre-approved", why: "a possessive is talk about the word" },
    { session: "inline-code", prompt: "the hook matches `AUTORUN` in capitals", why: "inline code is talk about the word" },
    {
      session: "fenced-block",
      prompt: "this is what the doc says:\n```\nAUTORUN finish the plan\n```\nis that right",
      why: "a fenced block is quoted text, not the owner's instruction",
    },
    { session: "quote-line", prompt: "> AUTORUN finish the plan\nwhy did that arm", why: "a '>' quote line is quoted text" },
    { session: "negated-dont", prompt: "don't AUTORUN this one", why: "\"don't AUTORUN\" is a refusal, not an arming" },
    { session: "negated-curly", prompt: "don’t AUTORUN the payroll plan", why: "a curly apostrophe is still a negation" },
    { session: "negated-do-not", prompt: "do not use AUTORUN here", why: "a negation two words back still negates" },
    { session: "negated-no-need", prompt: "no need for AUTORUN today", why: "\"no need for AUTORUN\" negates the word" },
    { session: "negated-never", prompt: "never AUTORUN a payroll change", why: "\"never AUTORUN\" negates the word" },
    { session: "negated-stop", prompt: "stop using AUTORUN for this", why: "\"stop using AUTORUN\" is not an arming" },
    { session: "question-what", prompt: "what does AUTORUN do", why: "a question about the word, even with no '?', is not an arming" },
    { session: "question-mark", prompt: "AUTORUN still armed in the other session?", why: "a sentence ending in '?' asks, it does not arm" },
    { session: "question-is", prompt: "is AUTORUN on for this session", why: "a clause opening as a question asks, it does not arm" },
    { session: "question-how", prompt: "how does AUTORUN survive compaction", why: "a how-question asks, it does not arm" },
  ];
  for (const c of mentions) {
    submit(sandbox, c.session, c.prompt);
    assert.equal(isArmed(sandbox, c.session), false, c.why);
  }

  // The refusals must not swallow a real arming beside them — each occurrence is judged on its own, and a
  // negation in another clause is not a negation of the word.
  const stillArms: Case[] = [
    {
      session: "question-then-instruction",
      prompt: "what does AUTORUN do? never mind, AUTORUN the closing plan",
      why: "a question first does not cancel the instruction after it",
    },
    { session: "dont-stop-dash", prompt: "don't stop — AUTORUN the whole plan", why: "a dash ends the negation's clause" },
    { session: "dont-stop", prompt: "don't stop AUTORUN", why: "two negations cancel: \"don't stop\" means keep going" },
    { session: "no-questions", prompt: "No questions. AUTORUN.", why: "a negation in the previous sentence does not reach the word" },
    { session: "comma-then", prompt: "When CI is green, AUTORUN the merges", why: "a clause after a comma is an instruction" },
    { session: "imperative-do", prompt: "do AUTORUN on phases 1-5", why: "\"do AUTORUN\" is an imperative, not a question" },
    { session: "arming-then-quote", prompt: 'AUTORUN the plan named "payroll close"', why: "a quoted run after the word leaves the word itself alone" },
  ];
  for (const c of stillArms) {
    submit(sandbox, c.session, c.prompt);
    assert.equal(isArmed(sandbox, c.session), true, c.why);
  }
}

function testAnOlderStateFileIsNeverRestated(sandbox: Sandbox) {
  // Exactly what the older guard wrote at 19:12 on 2026-09-17: no version, no trigger.
  mkdirSync(sandbox.stateDir, { recursive: true });
  writeFileSync(
    join(sandbox.stateDir, "older-guard.json"),
    JSON.stringify({ armedAt: new Date(Date.now() - 600000).toISOString(), sessionId: "older-guard" }, null, 2),
  );
  assert.equal(
    nextTurn(sandbox, "older-guard"),
    "",
    "a state file the older guard wrote must NOT be re-stated — it armed on quoted and negated mentions, so its "
      + "armings cannot be trusted",
  );

  // And a file this guard writes records the owner's words, which the re-statement quotes back.
  submit(sandbox, "records-trigger", "Run the whole closing plan. AUTORUN.");
  const state = JSON.parse(readFileSync(join(sandbox.stateDir, "records-trigger.json"), "utf8")) as {
    version?: number;
    trigger?: string;
  };
  assert.equal(state.trigger, "Run the whole closing plan. AUTORUN.", "the state file records the line that armed it");
  assert.match(
    nextTurn(sandbox, "records-trigger"),
    /AUTORUN IS ARMED[\s\S]*“Run the whole closing plan\. AUTORUN\.”/,
    "the re-statement quotes the owner's words, so a session can see a false arming for itself",
  );
}

function testTheOwnersWordStillArms(sandbox: Sandbox) {
  submit(sandbox, "owner", "AUTORUN finish the plan");
  assert.equal(isArmed(sandbox, "owner"), true, "the owner's typed AUTORUN must still arm the session — §6.1's trigger");
  assert.match(
    nextTurn(sandbox, "owner"),
    /AUTORUN IS ARMED/,
    "every later turn must be told it is armed — that re-statement is what survives compaction",
  );

  const phrasings: Case[] = [
    {
      session: "first-real-arming",
      prompt: "send the AUTORUN line above and let it run untouched",
      why: "the owner's first real arming (2026-09-05) had the word mid-sentence — permissive means anywhere in "
        + "his own text",
    },
    {
      session: "sentence-end",
      prompt: "Run the whole closing plan. AUTORUN.",
      why: "a full stop after the word ends a sentence; it does not start a file extension",
    },
    {
      session: "colon",
      prompt: "AUTORUN: the attendance follow-ups",
      why: "ordinary punctuation after the word is still the word",
    },
    {
      session: "typed-then-notice",
      prompt: `AUTORUN finish the plan\n${taskNotification("done")}`,
      why: "the owner's text survives a notice delivered in the same prompt — only the envelope is cut",
    },
    {
      session: "notice-then-typed",
      prompt: `${taskNotification("done")}\nAUTORUN finish the plan`,
      why: "and it survives on the far side of one, too",
    },
  ];
  for (const c of phrasings) {
    submit(sandbox, c.session, c.prompt);
    assert.equal(isArmed(sandbox, c.session), true, c.why);
  }

  // Decided 2026-09-15: the arming word is written in capitals, as §6.1 spells it. Lower-case is how the
  // rule gets TALKED about, and a false arming pre-approves production merges.
  submit(sandbox, "lower-case", "why did autorun arm in that session?");
  assert.equal(
    isArmed(sandbox, "lower-case"),
    false,
    "lower-case autorun is talk about the rule, not an arming — a false arming pre-approves production merges",
  );
}

function testStandDown(sandbox: Sandbox) {
  submit(sandbox, "stand-down", "AUTORUN finish the plan");
  assert.equal(isArmed(sandbox, "stand-down"), true, "premise: the owner's word armed the session");
  submit(sandbox, "stand-down", "AUTORUN OFF");
  assert.equal(isArmed(sandbox, "stand-down"), false, "a typed AUTORUN OFF must stand the session down");
  assert.equal(nextTurn(sandbox, "stand-down"), "", "and the next turn must hear nothing about AUTORUN");

  submit(sandbox, "off-first", "AUTORUN OFF");
  assert.equal(
    isArmed(sandbox, "off-first"),
    false,
    "stand-down is tested BEFORE arming, so the word inside AUTORUN OFF never arms a session",
  );

  submit(sandbox, "lower-off", "AUTORUN finish the plan");
  submit(sandbox, "lower-off", "autorun off");
  assert.equal(
    isArmed(sandbox, "lower-off"),
    false,
    "standing down is the safe direction, so the owner's lower-case 'autorun off' counts",
  );

  submit(sandbox, "notice-says-off", "AUTORUN finish the plan");
  submit(sandbox, "notice-says-off", taskNotification("To stand it down, the owner types AUTORUN OFF."));
  assert.equal(
    isArmed(sandbox, "notice-says-off"),
    true,
    "a notice quoting AUTORUN OFF must not stand down a run the owner armed — it would stop the unattended run "
      + "he left going",
  );
  assert.match(nextTurn(sandbox, "notice-says-off"), /AUTORUN IS ARMED/, "the armed run must keep being re-stated");
}

export function runAutorunGuardFalseArmingTests() {
  testTheGuardIsWired();

  const root = mkdtempSync(join(tmpdir(), "phx-autorun-"));
  try {
    const hooksDir = join(root, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const sandbox: Sandbox = { hook: join(hooksDir, "autorun-guard.mjs"), stateDir: join(root, ".claude", ".autorun") };
    copyFileSync(hookSource, sandbox.hook);

    testANoticeNeverArms(sandbox);
    testAFileNameOrPathNeverArms(sandbox);
    testAQuotedNegatedOrQuestioningMentionNeverArms(sandbox);
    testAnOlderStateFileIsNeverRestated(sandbox);
    testTheOwnersWordStillArms(sandbox);
    testStandDown(sandbox);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
