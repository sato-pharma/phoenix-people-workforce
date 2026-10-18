/**
 * The CEO composer's assistant — ONE box, no modes, and it works out what was asked.
 *
 * Owner 2026-10-06: *"a more capable ai assist that the ceo can type what he wants any language or
 * even open the mic and the assist is perfectly able to understand the ceo if the ceo asked to type
 * he understand if asked to polish he understand"*.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THERE IS NO MODE BUTTON, AND WHAT REPLACES THE SAFETY THE BUTTONS USED TO CARRY.
 *
 * The Sato composer has three buttons — Write it, Rewrite what I wrote, Build it from a document —
 * and the button is what picks the guard set: Rewrite REFUSES any figure the sender did not write,
 * Write only REPORTS one. That split is the whole safety story of that screen, and it works because
 * the sender presses the button that matches what he wants.
 *
 * The owner's instruction removes the buttons. So the assistant has to decide, and the obvious
 * reading — "let the model say which mode it is, and apply that mode's guards" — is exactly the hole:
 * a model that returns `write` gets the lenient figure guard, which means the lenient guard is
 * available on demand to the one thing it is meant to protect against. A keyword list in place of the
 * button is no better: "any language" means no list of verbs can be complete, and a CEO dictating
 * Egyptian Arabic into a microphone will not phrase it the way the list expects.
 *
 * 🔴 SO THE FLOOR IS STRUCTURAL, NOT LEXICAL, AND IT IS THE ONE IDEA IN THIS FILE.
 *
 *   The lenient guard is allowed only when nothing of the sender's own was lost.
 *
 * Concretely: if a figure his body already stated is no longer in the draft, the strict guard applies
 * whatever the model called the request. That catches the dangerous shape — "polish this" answered by
 * a draft where 5% became 10% — with no dependence on language, wording, dialect or the model's own
 * honesty, because changing a figure necessarily DROPS the old one. And it leaves the useful shape
 * alone: he asks for a longer letter, every figure he wrote is still there, the new ones are listed
 * under "check these before you send" rather than thrown away.
 *
 * Four things are refused in every intent, because no amount of reading makes them safe: an empty
 * draft, a minted link or image address (it reaches a whole distribution list without a click, which
 * is the one fabrication shaped like an attack), any mention of a model (owner rule 2026-08-04), and
 * a figure the sender wrote going missing.
 *
 * TRANSLATION GETS ITS OWN INTENT, and that is not a convenience. The rewrite guard requires every
 * `[square bracket]` gap to survive VERBATIM — correct when the language is unchanged, and wrong the
 * moment the answer is Arabic, because `[start date]` legitimately becomes `[تاريخ البدء]` and the
 * guard would refuse every translation ever asked for. So `translate` compares the NUMBER of gaps
 * instead of their text: a gap the model filled in by itself still lowers the count and is still
 * caught, while a gap it translated is not. Figures stay strict in translation — a translated number
 * is the same number.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here sends anything and nothing here is saved. The draft lands in the same subject and
 * body fields the sender was already editing, the preview is invalidated so a recipient count can
 * never describe a different email, and Undo puts his own words back untouched.
 */

import {
  createOpenAiResponseText,
  hasAiApiKey,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
  resolveOpenAiCopilotModel,
} from "@/lib/ai/openai-client";
import { toolboxPromptLines } from "@/lib/email/toolbar-tools";
import {
  bracketTokens,
  cleanPolishedBody,
  cleanPolishedSubject,
  emailPlainText,
  linkTargets,
  numericTokens,
  senderWriting,
  unverifiedFigures,
  type SatoAssistSender,
} from "@/lib/sato-email/polish";
import type { SatoAssistSource } from "@/lib/sato-email/source-document";

import {
  CEO_ASSIST_MAX_BODY_CHARS,
  CEO_ASSIST_MAX_INSTRUCTION_CHARS,
  CEO_ASSIST_MAX_SUBJECT_CHARS,
} from "./assist-limits";

// Re-exported so the route has one import, while the screen reads them from ./assist-limits and
// never pulls the OpenAI client into the browser bundle.
export { CEO_ASSIST_MAX_BODY_CHARS, CEO_ASSIST_MAX_INSTRUCTION_CHARS, CEO_ASSIST_MAX_SUBJECT_CHARS };

/**
 * What the assistant worked out he was asking for. Declared by the model and shown on screen, so he
 * can see it read him correctly — never chosen by him on a button.
 */
export type CeoAssistIntent = "write" | "polish" | "translate" | "document";

export function parseCeoAssistIntent(value: unknown): CeoAssistIntent {
  if (value === "write") return "write";
  if (value === "translate") return "translate";
  if (value === "document") return "document";
  return "polish";
}

/** Which guard set a draft is judged by. See the header: this is decided, never requested. */
export type CeoAssistGuard = "strict" | "reporting";

export type CeoAssistRequest = {
  bodyHtml: string;
  /** What he typed or dictated. In every intent it is the only place a new fact may come from. */
  instruction?: string;
  /** A file he uploaded, already read by sato-email/read-source-document. His paper, his facts. */
  source?: SatoAssistSource;
  subject: string;
};

export type CeoAssistResult = {
  bodyHtml: string;
  /** One short line per change, so he can see what was done without diffing two drafts. */
  changes: string[];
  /** Figures the draft states that he cannot be shown to have written. Read, not refused. */
  checks: string[];
  /** Which guard set judged this draft — reported so the screen never has to guess. */
  guard: CeoAssistGuard;
  /** What it worked out he wanted. */
  intent: CeoAssistIntent;
  /** The language it answered in, as the model names it ("English", "Arabic"). For the screen only. */
  language: string;
  subject: string;
};

export class CeoAssistError extends Error {
  code: "assist_failed" | "assist_not_configured" | "assist_rate_limited";

  constructor(code: CeoAssistError["code"], message: string) {
    super(message);
    this.name = "CeoAssistError";
    this.code = code;
  }
}

// -- Pure: the floor --------------------------------------------------------

/**
 * Figures the sender's own BODY stated that this draft no longer states.
 *
 * 🔴 THIS IS THE FLOOR. Nothing else in this file decides whether the strict guard applies, and
 * nothing about it depends on language, wording or what the model claims it was doing. A body with
 * no figures in it can lose none, which is why an empty page is free to be written on.
 *
 * It reads the BODY only — not the instruction, not an uploaded document. Those are places new facts
 * legitimately come FROM; the body is the one place his existing facts live, and the only thing worth
 * protecting from a rewrite.
 */
export function figuresLostFromBody(
  candidate: { bodyHtml: string; subject: string },
  bodyHtml: string,
): string[] {
  const had = new Set(numericTokens(emailPlainText(bodyHtml)));
  if (had.size === 0) return [];
  const kept = new Set(numericTokens(`${candidate.subject}\n${emailPlainText(candidate.bodyHtml)}`));
  return Array.from(had).filter((token) => !kept.has(token));
}

/**
 * Which guard set judges this draft.
 *
 * Strict when he asked for his own words to be worked on, and strict ANYWAY whenever one of his
 * figures went missing — see `figuresLostFromBody`. Lenient only when neither holds.
 */
export function effectiveCeoGuard(
  intent: CeoAssistIntent,
  candidate: { bodyHtml: string; subject: string },
  sender: Pick<SatoAssistSender, "bodyHtml">,
): CeoAssistGuard {
  if (intent === "polish" || intent === "translate") return "strict";
  return figuresLostFromBody(candidate, sender.bodyHtml).length > 0 ? "strict" : "reporting";
}

// -- Pure: the guards -------------------------------------------------------

// Owner rule 2026-08-04: a reader never learns a model was involved.
const NAMED_THE_ASSISTANT = /\b(ai|a\.i\.|gpt|chatgpt|openai|llm|artificial intelligence|language model)\b/i;

/** Addresses written as plain text — a link he pasted into his instruction is still his. */
function writtenUrls(value: string): string[] {
  return Array.from(String(value ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)).map((match) =>
    match[0].toLowerCase().replace(/[.,;:]+$/, ""),
  );
}

/**
 * Why a draft must not be handed back at all. Empty means it is safe for him to look at.
 *
 * The four unconditional refusals are listed in the header. The two that depend on the guard are the
 * figure rule and the gap rule, and the gap rule depends on the intent as well — see the header's
 * note on translation.
 */
export function findCeoAssistViolations(input: {
  candidate: { bodyHtml: string; subject: string };
  guard: CeoAssistGuard;
  intent: CeoAssistIntent;
  sender: SatoAssistSender;
}): string[] {
  const { candidate, guard, intent, sender } = input;
  const violations: string[] = [];

  const bodyText = emailPlainText(candidate.bodyHtml);
  if (!bodyText) violations.push("the draft came back with an empty body");
  if (!candidate.subject.trim()) violations.push("the draft came back with no subject");

  const written = senderWriting(sender);
  const drafted = `${candidate.subject}\n${bodyText}`;

  if (NAMED_THE_ASSISTANT.test(drafted) && !NAMED_THE_ASSISTANT.test(written)) {
    violations.push("it named the assistant");
  }

  // 🔴 UNCONDITIONAL, in every intent and under either guard. A figure HE wrote going missing is a
  // fact of his that the draft silently contradicts, and it is also what proves a "write" was really
  // a rewrite — so it is a refusal here rather than a note, whatever the model called the request.
  const lost = figuresLostFromBody(candidate, sender.bodyHtml);
  if (lost.length > 0) violations.push(`figures you had written are missing (${lost.join(", ")})`);

  if (guard === "strict") {
    const allowedFigures = new Set(numericTokens(written));
    const invented = Array.from(new Set(numericTokens(drafted).filter((token) => !allowedFigures.has(token))));
    if (invented.length > 0) violations.push(`figures nobody wrote (${invented.join(", ")})`);

    const wroteGaps = bracketTokens(written);
    const keptGaps = bracketTokens(drafted);
    if (intent === "translate") {
      // The gaps are translated, so their TEXT changes and only their NUMBER is comparable. One the
      // model filled in by itself still lowers the count, which is the thing worth catching.
      if (keptGaps.length < wroteGaps.length) {
        violations.push(`it filled in ${wroteGaps.length - keptGaps.length} of the gaps you left`);
      }
    } else {
      const kept = new Set(keptGaps);
      const filled = Array.from(new Set(wroteGaps.filter((token) => !kept.has(token))));
      if (filled.length > 0) violations.push(`gaps it filled in by itself (${filled.join(", ")})`);
    }
  }

  const allowedLinks = new Set([
    ...linkTargets(sender.bodyHtml),
    ...writtenUrls(String(sender.instruction ?? "")),
    // An address printed in his document is an address he handed over, exactly like one he typed.
    ...writtenUrls(String(sender.sourceText ?? "")),
  ]);
  const minted = Array.from(new Set(linkTargets(candidate.bodyHtml).filter((href) => !allowedLinks.has(href))));
  if (minted.length > 0) violations.push(`links nobody wrote (${minted.join(", ")})`);

  return violations;
}

// -- Pure: the prompt -------------------------------------------------------

const TOOLBOX_BLOCK = [
  "THE TOOLBOX — you are pressing the same buttons the sender has:",
  "The sender writes in an editor with a Gmail-style toolbar. You cannot click it, so you press a button by writing the markup that button produces. This is the whole list, and nothing outside it survives:",
  ...toolboxPromptLines(),
  "",
  'When the sender asks for one of these in their own words — in ANY language — do it. "Bold the deadline", "put the dates in a table", "make it a list", "اعمل جدول بعمودين" are instructions to use that tool.',
].join("\n");

const TOOLBOX_USE_BLOCK = [
  "HOW TO USE THE TOOLBOX — restraint is the house style, but an instruction always wins:",
  "- Formatting carries meaning. If everything is bold, nothing is. A letter from the chief executive normally needs nothing more than paragraphs and bold on the single thing that must not be missed.",
  "- Use a heading only when the letter genuinely has two or more sections. One section needs no heading.",
  '- TABLES. When the sender names a shape — "a table with two columns", "add a column for the area", "one row per region" — build exactly that shape, whatever the current table looks like. A table may have any number of columns and rows, and never leave a cell empty: if a value is not known, put a [square bracket] gap in it so the sender fills it.',
  "- Every cell of a table you write carries the house border and padding, exactly as the Insert table tool above shows. A bare <td> with no style renders as an unruled cell.",
  "- Colour, highlight, font and font size only when the sender asks for them. Left alone, the house design supplies all of that and looks better than anything you would choose.",
  '- Arabic paragraphs take dir="rtl", which already right-aligns them — do not add text-align as well. English paragraphs need neither. In a bilingual letter set the direction per paragraph, never once around the whole body.',
  "- No <div>, no <script>, no class attribute, no markdown, no code fences. A style declaration outside the list above is dropped in silence, so writing one just loses the formatting.",
].join("\n");

/**
 * The register. This is the one block that is NOT the Sato composer's with the names changed.
 *
 * A Sato announcement is the organisation speaking: impersonal, procedural, "Human Resources will
 * confirm". This letter is one named person speaking to his own company, over his own signature.
 * The difference is first person and ownership of the decision — and the failure mode to write
 * against is the HR circular, which is what a model trained on corporate email reaches for.
 */
const CEO_VOICE_BLOCK = [
  "THE VOICE — this is a letter from the chief executive, not a circular from a department:",
  "- The sender speaks in the first person where they are the one deciding or thanking: \"I have decided\", \"I am asking each of you\", \"I want to thank\". Where the company acts rather than the person, the company is the subject.",
  "- Measured, decisive and short. A chief executive states the decision and the reason, and does not explain the procedure — the department that owns it will do that.",
  "- Formal and warm at the same time: this is addressed to colleagues, not to a regulator. No slang, no exclamation marks, no emoji, no hype, no marketing language, no motivational filler.",
  "- Never the HR register. No \"please be informed that\", no \"kindly note\", no \"as per\", no passive chain of nobody doing anything.",
  "- Lead with the point. The background, if it is needed at all, comes after it.",
  "- Sentence case everywhere, never Title Case, in the subject and in every heading. Never a teaser subject, never a question, no Important or Urgent prefix.",
  "- NEVER write a greeting or a sign-off. The letterhead prints the date, the closing line the sender chose, the sender's name, their office and the company under a signature rule. A \"Dear colleagues\" or a \"Sincerely, Anwar\" inside your text signs the letter twice.",
].join("\n");

const CEO_FACTS_BLOCK = [
  "🔴 THE ONE RULE THAT MATTERS — YOU NEVER INVENT A FACT:",
  "- Every fact you state must come from what the sender gave you: their instruction, the draft already in the body, or the document they uploaded. Nothing else exists.",
  "- A fact the sender did NOT give you — a date, a figure, a percentage, a deadline, a name, a title, a site, a policy number — is written as a [square bracket] gap in the place it belongs: [effective date], [the figure], [the regional manager]. The sender fills it in before sending. A gap they have to fill is useful; a plausible number nobody decided, sent to the whole company over that signature, is dangerous.",
  "- Never keep one of the sender's figures and change it, and never convert one into other units.",
  "- Never mint a link or an image address. Use a URL only if the sender wrote it, or it is printed in the document they uploaded.",
  "- Never promise anything on the company's behalf that the sender did not say — no bonus, no allowance, no guarantee, no date.",
  "- Never mention that this text was written, generated or assisted by anything, and never refer to yourself.",
].join("\n");

const CEO_LANGUAGE_BLOCK = [
  "🔴 LANGUAGE — ANSWER IN THE SENDER'S OWN, WHATEVER IT IS:",
  "- Write the letter in the language the sender used in their instruction. If they wrote Arabic, the letter is Arabic. English, French, German, Italian, Turkish, anything — the letter is in that language, and it reads as a native executive letter in it, not as a translation of an English one.",
  "- If the sender NAMES a language, that one wins over the language they typed in. \"اكتبها بالإنجليزي\" is an English letter; \"write it in Arabic\" is an Arabic one.",
  "- If the sender asks for both, give each paragraph in both: the paragraph in the first language, then the same paragraph immediately under it in the second, and so on — never two halves, and never a summary instead of a translation. A heading carries both languages in the one line, separated by a space, a middle dot and a space. A table is built ONCE, its figures written once, with both languages inside a header cell.",
  "- Arabic is Egyptian corporate Modern Standard — the register a company circular is written in there. Never dialect, never a machine-literal rendering of English word order. Keep Western digits (1, 2, 3), never Eastern Arabic numerals. A product name, a brand or a job title the company uses in English stays in English inside an Arabic sentence; never transliterate one.",
  "- The sender may DICTATE the instruction, so it can arrive as unpunctuated speech, with false starts, repetitions and a correction in the middle (\"...on Sunday, no, on Monday\"). Read it as speech: take the correction and drop what it replaced, and never transcribe spoken filler into the letter.",
  "- An instruction ABOUT the letter is never content IN the letter. \"Make it shorter\", \"ابعتها للمديرين\", \"two columns\" are things to do, not sentences to print.",
].join("\n");

/**
 * Exported so the test can assert the intent contract actually reaches the model. A rule that is
 * never put in the prompt would still pass every other check in this file.
 */
export const CEO_ASSIST_INSTRUCTIONS = [
  "You are the writing assistant inside Sato Pharma's HR system, working for the chief executive of the company — an Egyptian pharmaceutical manufacturer. The sender writes or dictates what they want in one box, in any language, and you produce the letter. It will be emailed to colleagues or to a distribution list over the chief executive's own name and signature, once the sender has read it.",
  [
    "🔴 FIRST, WORK OUT WHAT IS BEING ASKED FOR. The sender does not choose a mode — you decide, and you report it in `intent`:",
    '- "write" — the sender is describing a letter they want and you compose it. The body may be empty, or hold a few notes to build on. Anything from "tell the company we are moving the head office" to a full briefing.',
    '- "polish" — the letter is already in the body and the sender wants it to read better: shorter, plainer, firmer, in their own voice. You change HOW IT READS AND HOW IT LOOKS, never what it says. A bare instruction with a draft already in the body is this.',
    '- "translate" — the sender wants what is in the body in another language, or in two. Same facts, same figures, same order, same gaps — each gap translated, never filled in.',
    '- "document" — the sender has uploaded a paper and wants the letter that carries it to people who have not read it.',
    "- When two readings are possible, take the NARROWER one: a request that could be a polish is a polish. Changing more than was asked for is the failure the sender notices.",
    "- Also report in `language` the language you wrote in, in English, as one or two words (\"English\", \"Arabic\", \"English and Arabic\").",
  ].join("\n"),
  [
    "WHAT YOU PRODUCE: the complete letter — subject and body — ready to be read and sent. Not an outline, not one thin paragraph.",
    "- In \"write\": the KIND of letter the sender names. A decision reads as a decision, a thank-you as a thank-you, a message on a national occasion as one. Use the structure that kind of letter normally has.",
    "- In \"polish\": the sender's own letter, same meaning, better written. Never soften or harden the decision it announces.",
    "- In \"translate\": the same letter in the language the sender asked for. Every figure, every gap, every row of every table.",
    "- In \"document\": what the paper decides and what it means for the reader — not the paper retyped. Figures exactly as it prints them, never rounded, never recalculated. A table in the paper arrives as a table, row for row. Never say the document is attached: the sender decides that separately.",
  ].join("\n"),
  CEO_VOICE_BLOCK,
  CEO_FACTS_BLOCK,
  CEO_LANGUAGE_BLOCK,
  TOOLBOX_BLOCK,
  TOOLBOX_USE_BLOCK,
  [
    "Also return a short list of what you did, in plain words a non-writer understands, at most five items. Write them in English whatever language the letter is in — they are for the sender, not for the reader. Examples of the right register:",
    "- Wrote it as a decision: what changes, from when, and what you are asking of people.",
    "- Moved the decision into the first sentence and cut the paragraph that repeated the subject.",
    "- Translated it into Arabic, keeping every figure and both gaps.",
    "- Kept the achievement table as the paper prints it, figure for figure.",
    "- Left [effective date] as a gap for you to fill.",
    "Name every gap you left, so the sender knows what is still theirs to decide. Say nothing about tone in the abstract, and never claim you added anything.",
  ].join("\n"),
].join("\n\n");

export function buildCeoAssistPrompt(input: CeoAssistRequest): string {
  // Newlines survive: a briefing arrives as a list of points, and flattening it to one line is the
  // difference between "three decisions" and one run-on sentence. Dictation arrives this way too.
  const instruction = String(input.instruction ?? "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, CEO_ASSIST_MAX_INSTRUCTION_CHARS);
  const subject = String(input.subject ?? "").trim();
  const body = String(input.bodyHtml ?? "").slice(0, CEO_ASSIST_MAX_BODY_CHARS);
  const bodyText = emailPlainText(body);
  const source = input.source;
  const sourceText = String(source?.text ?? "").trim();

  return [
    source
      ? `The sender uploaded a document: ${source.fileName ?? "the file"}`
      : "",
    source
      ? sourceText
        ? `What the document says — this, and the sender's own words below, are the ONLY facts you may state:\n${sourceText}`
        : "The document carries no text of its own — it is attached to this request as a file. Read it, and state nothing it does not say."
      : "",
    instruction
      ? `What the sender said (typed or dictated, in their own language):\n${instruction}`
      : bodyText
        ? "The sender said nothing — they have written a letter and pressed the button. Read it as a polish: same meaning, better written."
        : "The sender said nothing and the body is empty. There is nothing to write from.",
    subject
      ? `Subject the sender has already typed (keep it unless it no longer fits):\n${subject}`
      : "Subject: the sender has not typed one — write it.",
    bodyText
      ? `What is already in the body — THESE ARE THE SENDER'S OWN WORDS AND THEIR OWN FACTS (HTML):\n${body}`
      : "The body is empty — this letter is yours to write from what the sender said above.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const assistTextFormat = {
  format: {
    name: "ceo_email_assist",
    schema: {
      additionalProperties: false,
      properties: {
        bodyHtml: {
          description: "The letter body, as email HTML built only from the toolbox markup listed in the instructions.",
          type: "string",
        },
        changes: {
          description: "At most five short plain-English lines saying what was done.",
          items: { type: "string" },
          type: "array",
        },
        intent: {
          description: "What the sender was asking for, worked out from their own words.",
          enum: ["write", "polish", "translate", "document"],
          type: "string",
        },
        language: {
          description: 'The language the letter was written in, named in English — "English", "Arabic", "English and Arabic".',
          type: "string",
        },
        subject: { description: "The subject, plain text, one line.", type: "string" },
      },
      required: ["bodyHtml", "changes", "intent", "language", "subject"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

/**
 * 🔴 EFFORT AND BUDGET, taken from what the Sato composer MEASURED rather than guessed.
 *
 * `sato-email/polish.ts` records the measurement: a 410 KB document at medium effort took 115 s
 * against a 60 s budget and died on the timeout every time, and the same document at LOW took
 * 28.9 / 37.7 / 38.6 s with output that was not worse — because the facts are already on the page
 * and that mode transcribes and arranges. Composing and rewriting are judgement and keep medium.
 *
 * This assistant also has to CLASSIFY before it writes, and the classification is the thing the
 * whole screen rests on — so it is never dropped below medium. A document still gets the raised
 * budget, three times the worst run seen on that paper.
 */
const CEO_DOCUMENT_BUDGET_MS = 120_000;

function errorFromOpenAi(error: PhoenixOpenAiError): CeoAssistError {
  switch (error.code) {
    case "not_configured":
      return new CeoAssistError("assist_not_configured", "The assistant is not configured on this server yet.");
    case "quota_exceeded":
      return new CeoAssistError(
        "assist_rate_limited",
        "The writing service is out of credit. Send the letter in your own words for now.",
      );
    case "rate_limited":
      return new CeoAssistError("assist_rate_limited", "The writing service is busy. Wait a moment and try again.");
    case "timeout":
      return new CeoAssistError("assist_failed", "The draft took too long. Try again.");
    case "auth_failed":
    case "failed":
      return new CeoAssistError("assist_failed", "The draft could not be produced. Try again.");
  }
}

function parseAssistOutput(text: string): {
  bodyHtml: string;
  changes: string[];
  intent: CeoAssistIntent;
  language: string;
  subject: string;
} {
  // 🔴 THE FENCE PATTERN IS BUILT FROM A STRING, NOT WRITTEN AS A REGEX LITERAL, AND THAT IS NOT A
  // STYLE CHOICE. tests/support/comment-strip.ts is a lexer that deliberately does not track regex
  // literals, so a backtick inside one opens a template literal it never closes — and every comment
  // BELOW it then survives the strip and is read as code. Inside a double-quoted string the same
  // backtick is lexed safely as string content. It cost this file three false offenders in
  // tests/neutral-wording.test.ts, which sweeps non-comment lines only.
  const cleaned = String(text ?? "").replace(new RegExp("```(?:json)?", "gi"), "").trim();
  const attempt = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed?.bodyHtml !== "string" || typeof parsed?.subject !== "string") return null;
      return {
        bodyHtml: parsed.bodyHtml,
        changes: Array.isArray(parsed.changes)
          ? (parsed.changes as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 5)
          : [],
        intent: parseCeoAssistIntent(parsed.intent),
        language: typeof parsed.language === "string" ? parsed.language.replace(/\s+/g, " ").trim().slice(0, 40) : "",
        subject: parsed.subject,
      };
    } catch {
      return null;
    }
  };

  const direct = attempt(cleaned);
  if (direct) return direct;

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = attempt(cleaned.slice(start, end + 1));
    if (sliced) return sliced;
  }

  throw new CeoAssistError("assist_failed", "The draft came back in an unreadable format.");
}

/** At most this many checks are listed — a longer list stops being read. */
function checkList(
  guard: CeoAssistGuard,
  source: SatoAssistSource | undefined,
  candidate: { bodyHtml: string; subject: string },
  sender: SatoAssistSender,
): string[] {
  // Under the strict guard an invented figure is a refusal, so by here there is none to report.
  if (guard === "strict") return [];
  if (source?.route === "picture") {
    return [
      "There are no words in that file, so the figures in this draft could not be checked against it. Read every number against the document before you send.",
    ];
  }
  return unverifiedFigures(candidate, sender).map(
    (figure) => `${figure} — you did not write this figure. Confirm it, or replace it with a [gap] to fill.`,
  );
}

/**
 * Writes, rewrites or translates one letter and hands it straight back to him to look at. Writes
 * nothing, sends nothing, decides nothing.
 */
export async function composeCeoEmailDraft(input: CeoAssistRequest): Promise<CeoAssistResult> {
  const subject = String(input.subject ?? "").trim();
  const bodyHtml = String(input.bodyHtml ?? "").trim();
  const instruction = String(input.instruction ?? "").trim();
  const source = input.source;
  const hasSourceText = Boolean(String(source?.text ?? "").trim());
  const hasSource = Boolean(source && (hasSourceText || source.file));

  // 🔴 THE ONE THING IT CANNOT START WITHOUT IS ANYTHING AT ALL. There is no mode to validate
  // against, so the only refusal here is a blank screen: no instruction, no body, no document. That
  // is also the only state where a model could not possibly read him, and saying so costs nothing.
  if (!instruction && !emailPlainText(bodyHtml) && !hasSource) {
    throw new CeoAssistError(
      "assist_failed",
      "Tell the assistant what you want — type it, dictate it, or upload the document it should carry.",
    );
  }
  if (!hasAiApiKey()) {
    throw new CeoAssistError("assist_not_configured", "The assistant is not configured on this server yet.");
  }

  const prompt = buildCeoAssistPrompt({ ...input, bodyHtml, instruction, subject });

  // A document that turned out to be a picture goes to the model whole, exactly as the CV intake
  // sends a scanned CV: `input_file` for a PDF so the model renders the pages itself, `input_image`
  // for a photograph. The prompt still travels with it — it carries what he said, his subject and
  // whatever is already in the body.
  const modelInput =
    source?.file && source.route === "picture"
      ? [
          {
            content: [
              { text: prompt, type: "input_text" as const },
              source.file.contentType === "application/pdf"
                ? {
                    // A filename is required alongside inline file_data, and the model picks its
                    // reader from the extension — never the empty string a typeless upload carries.
                    file_data: `data:application/pdf;base64,${source.file.data}`,
                    filename: source.fileName || "document.pdf",
                    type: "input_file" as const,
                  }
                : {
                    // "high" detail for the same reason as the scanned CV path: this is a text-dense
                    // page, and downsampling is what turns 90% into 80%.
                    detail: "high" as const,
                    image_url: `data:${source.file.contentType};base64,${source.file.data}`,
                    type: "input_image" as const,
                  },
            ],
            role: "user" as const,
          },
        ]
      : prompt;

  let outputText: string;
  try {
    const response = await createOpenAiResponseText({
      input: modelInput,
      instructions: CEO_ASSIST_INSTRUCTIONS,
      // A whole letter, sometimes bilingual, sometimes with a table, plus the classification.
      maxOutputTokens: 9_000,
      // The strong tier, never the nano one: this is a letter going to a distribution list over the
      // chief executive's signature, pressed a handful of times a day.
      model: resolveOpenAiCopilotModel(),
      purpose: "ceo-email-assist",
      reasoning: { effort: "medium" },
      text: assistTextFormat,
      timeoutMs: hasSource ? CEO_DOCUMENT_BUDGET_MS : OPENAI_ROUTE_BUDGET_MS,
    });
    outputText = response.outputText;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) throw errorFromOpenAi(error);
    throw new CeoAssistError("assist_failed", "The draft could not be produced. Try again.");
  }

  const parsed = parseAssistOutput(outputText);
  const candidate = {
    // Structural cleanup only, and the same sanitizer every other body passes — so a draft can only
    // ever carry markup the letterhead already knows how to render.
    bodyHtml: cleanPolishedBody(parsed.bodyHtml, bodyHtml),
    subject: cleanPolishedSubject(parsed.subject),
  };

  const sender: SatoAssistSender = { bodyHtml, instruction, sourceText: source?.text ?? "", subject };
  const guard = effectiveCeoGuard(parsed.intent, candidate, sender);
  const violations = findCeoAssistViolations({ candidate, guard, intent: parsed.intent, sender });
  if (violations.length > 0) {
    throw new CeoAssistError(
      "assist_failed",
      `The draft was rejected because it changed your facts, not just your wording (${violations.join("; ")}). Try again, or send your own words.`,
    );
  }

  return {
    bodyHtml: candidate.bodyHtml,
    changes: parsed.changes.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean),
    checks: checkList(guard, source, candidate, sender),
    guard,
    intent: parsed.intent,
    language: parsed.language,
    subject: candidate.subject,
  };
}
