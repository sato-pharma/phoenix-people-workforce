/**
 * The Sato composer's assistant. It has TWO modes, and what separates them is where the facts are
 * allowed to come from.
 *
 * **Rewrite** — owner 2026-09-12: "i write what i want and it enhance rephrase more to the point
 * more corporate". The sender has written the email; this gives it back in the company's voice.
 * Nothing may arrive that he did not already write, and the call FAILS rather than hand back
 * something plausible.
 *
 * **Write** — owner 2026-09-17: "i want to be able to tell it write a job offer to someone whose
 * area will be like this … i want a real assistant, a real AI assist, not a do nothing". The sender
 * writes an INSTRUCTION instead of an email and the assistant composes it. His instruction is his
 * writing, so every figure, gap and address in it is his to use. What it must never do is answer a
 * fact he never gave: a date, a salary or a name he did not state comes back as a `[square bracket]`
 * gap for him to fill, never as a guess. Anything it states that he cannot be shown to have written
 * is handed back to him as a CHECK, listed on screen beside the draft — a refusal there would make
 * the feature useless, and silence would make it dangerous.
 *
 * 🔴 WHAT NEITHER MODE MAY DO. This is the one screen that mails a whole distribution list at once,
 * so a minted URL — href or img src alike — is refused outright in both modes: it reaches the reader
 * without a click and is the one fabrication shaped like an attack. And in neither mode may the
 * reader learn a model was involved (owner rule 2026-08-04).
 *
 * Both modes FORMAT freely within the composer's own toolbox (`src/lib/email/toolbar-tools.ts`) —
 * bold, a list, an Arabic paragraph's direction, and a table of whatever shape the sender asked for.
 *
 * Nothing here sends anything, and nothing here is saved. The draft lands in the same subject and
 * body fields the sender was already editing, the preview is invalidated so a recipient count can
 * never describe a different email, and Undo puts his own words back untouched.
 *
 * The pure half sits at the top so those guards can be asserted without a network.
 */

import {
  createOpenAiResponseText,
  hasOpenAiApiKey,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
  resolveOpenAiCopilotModel,
} from "@/lib/ai/openai-client";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import { toolboxPromptLines } from "@/lib/email/toolbar-tools";

/** The composer's own subject cap, so a rewrite can never produce a draft the send route rejects. */
export const SATO_POLISH_MAX_SUBJECT_CHARS = 200;
/** A generous announcement. Longer than this and the sender is writing a document, not an email. */
export const SATO_POLISH_MAX_BODY_CHARS = 40_000;
/**
 * How much instruction the assistant reads.
 *
 * The old 600 was sized for a nudge ("shorter, warmer"). A write instruction is a briefing — the
 * role, the area, the terms, what to leave blank — and cutting it mid-sentence silently drops the
 * half of the request that carried the facts.
 */
export const SATO_ASSIST_MAX_INSTRUCTION_CHARS = 4_000;

/** Where the facts come from: the sender's draft (rewrite) or the sender's instruction (write). */
export type SatoAssistMode = "rewrite" | "write";

export function parseSatoAssistMode(value: unknown): SatoAssistMode {
  return value === "write" ? "write" : "rewrite";
}

export type SatoPolishRequest = {
  bodyHtml: string;
  /**
   * In rewrite mode, a nudge in the sender's own words — "shorter", "warmer", "lead with the
   * deadline". In write mode it IS the request, and it is the only place new facts may come from.
   */
  instruction?: string;
  mode?: SatoAssistMode;
  subject: string;
};

export type SatoPolishResult = {
  bodyHtml: string;
  /** One short line per change, so the sender can see what was done without diffing two drafts. */
  changes: string[];
  /**
   * Write mode only: figures the draft now states that the sender cannot be shown to have written.
   * Not a refusal — a list to read before sending. Empty in rewrite mode, where the same finding is
   * a refusal instead.
   */
  checks: string[];
  mode: SatoAssistMode;
  subject: string;
};

export class SatoPolishError extends Error {
  code: "polish_failed" | "polish_not_configured" | "polish_rate_limited";

  constructor(code: SatoPolishError["code"], message: string) {
    super(message);
    this.name = "SatoPolishError";
    this.code = code;
  }
}

// -- Pure: reading the draft -------------------------------------------------

/**
 * The words of an HTML body, with the markup gone.
 *
 * Written here rather than imported from the body editor: `htmlToPlainText` lives in a
 * "use client" component and this module runs on the server. It also has to be deliberately blunt
 * — a style attribute is full of numbers (`font-size:18px`, a hex colour) and every one of them
 * would otherwise count as a figure the sender "wrote", which is exactly the check this feeds.
 */
export function emailPlainText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Every number in a piece of text, normalised so the same value written two ways compares equal:
 * "1,250.00", "1250.0" and "1250" all reduce to "1250".
 */
export function numericTokens(value: string): string[] {
  return Array.from(String(value ?? "").matchAll(/\d[\d,]*(?:\.\d+)?/g)).map((match) => {
    const cleaned = match[0].replace(/,/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? String(parsed) : cleaned;
  });
}

/** The `[square bracket]` gaps a Sato template leaves for the sender, lower-cased for comparison. */
export function bracketTokens(value: string): string[] {
  return Array.from(String(value ?? "").matchAll(/\[[^\]\n]{1,80}\]/g)).map((match) =>
    match[0].toLowerCase().replace(/\s+/g, " "),
  );
}

/**
 * Every address a body points at, so a rewrite cannot mint one.
 *
 * `src` counts as much as `href`. Once the model was taught the Insert image tool it could fetch
 * a URL of its own choosing into a company-wide email, which is the same fabrication as an
 * invented link and reaches the reader without a click.
 */
export function linkTargets(html: string): string[] {
  return Array.from(String(html ?? "").matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)).map((match) =>
    match[1].trim().toLowerCase(),
  );
}

// -- Pure: cleaning what came back -------------------------------------------

const FENCE = /```[a-z]*\n?/gi;
/**
 * A sign-off the sender did not write. The composer has its own Signed field and the house frame
 * prints it, so a second one inside the body reads as the email being signed twice.
 */
const TRAILING_SIGN_OFF =
  /<p[^>]*>\s*(?:<[^>]+>\s*)*(?:kind regards|best regards|warm regards|regards|sincerely|yours (?:sincerely|faithfully)|thanks|thank you)\b[\s\S]{0,120}?<\/p>\s*$/i;

/**
 * Structural cleanup only — this never rewords. It strips the packaging a chat model reaches for
 * and runs the result through the same sanitizer every other body passes, so a rewrite can only
 * ever contain markup the email design already knows how to render.
 */
export function cleanPolishedBody(raw: string, senderBodyHtml: string): string {
  let body = String(raw ?? "").replace(FENCE, "").replace(/```/g, "").trim();
  body = sanitizeEmailTemplateHtml(body);
  // Only when the sender's own body had none. If he signed off himself, that is his wording to keep.
  if (!TRAILING_SIGN_OFF.test(sanitizeEmailTemplateHtml(senderBodyHtml))) {
    body = body.replace(TRAILING_SIGN_OFF, "").trim();
  }
  return body;
}

/** A subject is one line. A model that returns markup or a newline in one gets it taken back out. */
export function cleanPolishedSubject(raw: string): string {
  const subject = String(raw ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    // Trimmed BEFORE the quote strip, or a wrapping quote is still behind a space and the
    // end-anchored pattern never sees it.
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (subject.length <= SATO_POLISH_MAX_SUBJECT_CHARS) return subject;
  const head = subject.slice(0, SATO_POLISH_MAX_SUBJECT_CHARS);
  const wordEnd = head.lastIndexOf(" ");
  // Never an ellipsis: the owner's standing rule is that no text in this system is elided with one.
  return (wordEnd > 0 ? head.slice(0, wordEnd) : head).trim();
}

// -- Pure: the guards --------------------------------------------------------

const VOICE_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // Owner rule 2026-08-04: a user never learns a model was involved.
  {
    label: "it named the assistant",
    pattern: /\b(ai|a\.i\.|gpt|chatgpt|openai|llm|artificial intelligence|language model)\b/i,
  },
];

export type SatoAssistSender = { bodyHtml: string; instruction?: string; subject: string };

/**
 * Everything the sender himself wrote, as words.
 *
 * 🔴 THE INSTRUCTION COUNTS AS HIS WRITING, IN BOTH MODES. He typed it, on this screen, seconds
 * ago. Leaving it out is what made the assistant feel like a do-nothing: "say we close at 2 PM"
 * typed into the box came back refused as a figure nobody wrote.
 */
export function senderWriting(sender: SatoAssistSender): string {
  return [sender.subject, emailPlainText(sender.bodyHtml), String(sender.instruction ?? "")]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** Addresses written as plain text — a link the sender pasted into his instruction is still his. */
function writtenUrls(value: string): string[] {
  return Array.from(String(value ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)).map((match) =>
    match[0].toLowerCase().replace(/[.,;:]+$/, ""),
  );
}

/**
 * Why a draft must not be handed back at all. Empty means it is safe for the sender to look at.
 *
 * Three of these hold in BOTH modes — an empty draft, a draft that names the assistant, and an
 * address nobody wrote. The other two — a figure and a filled-in gap — are what "rewrite" means,
 * and they are refusals only there. In write mode the sender ASKED for content, so the same finding
 * is reported by `unverifiedFigures` instead of thrown away.
 */
export function findPolishViolations(
  candidate: { bodyHtml: string; subject: string },
  sender: SatoAssistSender,
  mode: SatoAssistMode = "rewrite",
): string[] {
  const violations: string[] = [];

  const bodyText = emailPlainText(candidate.bodyHtml);
  if (!bodyText) violations.push("the rewritten body came back empty");
  if (!candidate.subject.trim()) violations.push("the rewritten subject came back empty");

  const written = senderWriting(sender);
  const rewritten = `${candidate.subject}\n${bodyText}`;

  for (const rule of VOICE_RULES) {
    if (rule.pattern.test(rewritten) && !rule.pattern.test(written)) violations.push(rule.label);
  }

  if (mode === "rewrite") {
    const allowedFigures = new Set(numericTokens(written));
    const invented = Array.from(new Set(numericTokens(rewritten).filter((token) => !allowedFigures.has(token))));
    if (invented.length > 0) violations.push(`figures nobody wrote (${invented.join(", ")})`);

    // A gap the sender still has to fill must survive the rewrite. One that disappeared was filled
    // in by the model, which means the email now states something as fact that nobody decided.
    const kept = new Set(bracketTokens(rewritten));
    const lost = Array.from(new Set(bracketTokens(written).filter((token) => !kept.has(token))));
    if (lost.length > 0) violations.push(`gaps it filled in by itself (${lost.join(", ")})`);
  }

  const allowedLinks = new Set([...linkTargets(sender.bodyHtml), ...writtenUrls(String(sender.instruction ?? ""))]);
  const mintedLinks = Array.from(new Set(linkTargets(candidate.bodyHtml).filter((href) => !allowedLinks.has(href))));
  if (mintedLinks.length > 0) violations.push(`links nobody wrote (${mintedLinks.join(", ")})`);

  return violations;
}

/** At most this many checks are listed — a longer list stops being read. */
const MAX_CHECKS = 8;

/**
 * Write mode's honest half: the figures the draft now states that the sender cannot be shown to
 * have written, so he reads them before the email goes to a distribution list.
 *
 * It is a LIST, not a refusal. He asked it to write a job offer; refusing every draft that carries
 * a probation period he did not dictate would hand him back nothing, which is the complaint this
 * mode exists to answer. The prompt tells the model to leave a [square bracket] gap instead of
 * guessing, so a well-behaved draft produces an empty list and this panel stays shut.
 */
export function unverifiedFigures(
  candidate: { bodyHtml: string; subject: string },
  sender: SatoAssistSender,
): string[] {
  const allowed = new Set(numericTokens(senderWriting(sender)));
  const stated = `${candidate.subject}\n${emailPlainText(candidate.bodyHtml)}`;
  return Array.from(new Set(numericTokens(stated).filter((token) => !allowed.has(token)))).slice(0, MAX_CHECKS);
}

// -- Pure: the prompt --------------------------------------------------------

export function buildPolishPrompt(input: SatoPolishRequest): string {
  const mode = parseSatoAssistMode(input.mode);
  // Newlines survive in write mode on purpose: a briefing arrives as a list of points, and
  // flattening it to one line is the difference between "three terms" and one run-on sentence.
  const instruction =
    mode === "write"
      ? String(input.instruction ?? "").replace(/[ \t]+/g, " ").trim().slice(0, SATO_ASSIST_MAX_INSTRUCTION_CHARS)
      : String(input.instruction ?? "").replace(/\s+/g, " ").trim().slice(0, SATO_ASSIST_MAX_INSTRUCTION_CHARS);
  const subject = String(input.subject ?? "").trim();
  const body = String(input.bodyHtml ?? "").slice(0, SATO_POLISH_MAX_BODY_CHARS);

  if (mode === "write") {
    return [
      `What the sender asked you to write:\n${instruction}`,
      subject ? `Subject he has already typed (keep it unless he asked otherwise):\n${subject}` : "Subject: he has not typed one — write it.",
      emailPlainText(body)
        ? `What is already in the body (build on it, do not throw it away):\n${body}`
        : "The body is empty — this email is yours to write from his request above.",
    ].join("\n\n");
  }

  return [
    `Subject as written:\n${subject || "(the sender has not written one yet)"}`,
    `Body as written (HTML):\n${body}`,
    instruction ? `What the sender asked for on top of the house voice:\n${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The toolbar, written out for a model that cannot click it. Shared by both modes — an assistant
 * that can write an email but not bold a line inside it is the same do-nothing in a new shape.
 */
const TOOLBOX_BLOCK = [
  "THE TOOLBOX — you are pressing the same buttons the sender has:",
  "The sender writes in an editor with a Gmail-style toolbar. You cannot click it, so you press a button by writing the markup that button produces. This is the whole list, and nothing outside it survives:",
  ...toolboxPromptLines(),
  "",
  "When the sender asks for one of these in his own words, do it. \"Bold the deadline\", \"put the dates in a table\", \"make it a list\", \"right-align the Arabic\" are instructions to use that tool.",
].join("\n");

/**
 * 🔴 THE TABLE LINE IS THE ONE THE OWNER CHANGED (2026-09-17). It used to read "only when the draft
 * already contains something with two dimensions … never add a column the draft cannot fill", which
 * is why "make it a table of two columns" came back as a paragraph. A shape he names is an
 * instruction, not a suggestion: build exactly the table he asked for.
 */
const TOOLBOX_USE_BLOCK = [
  "HOW TO USE THE TOOLBOX — restraint is the house style, but an instruction always wins:",
  "- Formatting carries meaning. If everything is bold, nothing is. A company announcement normally needs nothing more than paragraphs, one list, and bold on the single thing that must not be missed.",
  "- Use a heading only when the email genuinely has two or more sections. One section needs no heading.",
  "- TABLES. When the sender names a shape — \"a table with two columns\", \"add a column for the area\", \"one row per branch\", \"drop the last row\" — build exactly that shape, whatever the current table looks like. A table may have any number of columns and rows. Left to your own judgement, reach for a table only when the content has two dimensions, and never leave a cell empty: if a value is not known, put a [square bracket] gap in the cell so the sender fills it.",
  "- Every cell of a table you write carries the house border and padding, exactly as the Insert table tool above shows. A bare <td> with no style renders as an unruled cell.",
  "- Colour, highlight, font and font size only when the sender asks for them. Left alone, the house design supplies all of that and looks better than anything you would choose.",
  "- Arabic paragraphs take dir=\"rtl\", which already right-aligns them — do not add text-align as well. English paragraphs need neither. In a bilingual email set the direction per paragraph, never once around the whole body.",
  "- Use <ul> when the email lists things. One idea per item, no full stop at the end of an item.",
  "- No <div>, no <script>, no class attribute, no markdown, no code fences. A style declaration outside the list above is dropped in silence, so writing one just loses the formatting.",
].join("\n");

/**
 * Exported so `tests/sato-email-toolbox.test.ts` can assert the toolbox actually reaches the
 * model. A catalogue that is never put in the prompt would still pass every other check.
 */
export const SATO_POLISH_INSTRUCTIONS = [
  "You rewrite an internal announcement for Sato Pharma, an Egyptian pharmaceutical company, inside its HR system. A named colleague has written a draft and pressed a button to have it read better. It will be emailed to a distribution list of employees under the company's own identity.",
  [
    "WHAT YOU CHANGE — how it reads and how it looks, never what it says:",
    "- Say the same thing in fewer, plainer words. Lead with the point; put the background after it.",
    "- Formal corporate register: measured, impersonal, confident. No slang, no exclamation marks, no emoji, no hype.",
    "- Fix grammar, spelling and punctuation. Break a wall of text into short paragraphs.",
    "- Keep the language the sender wrote in. Arabic stays Arabic, English stays English, and a bilingual draft stays bilingual with each language in its own paragraph.",
    "- Write a subject that says what the email is about in a few words. Never a teaser, never a question, and no Important or Urgent prefix.",
    "- Sentence case, never Title Case: capitalise the first word and proper nouns only, in the subject and in every heading.",
  ].join("\n"),
  [
    "WHAT YOU NEVER DO — this is the part that matters:",
    "- Never add a fact. No date, no deadline, no figure, no percentage, no policy number, no department, no name, no link that the sender did not write. If his draft is vague, it stays vague.",
    "- Never keep a figure and change it, and never convert one into different units.",
    "- Never fill in anything inside [square brackets]. Those are gaps the sender fills himself: copy each one through exactly as it is.",
    "- Never add a next step, a condition, a consequence or a contact that he did not write.",
    "- Never add a greeting or a sign-off. The email design prints the company's own frame around your text, and the sender signs it in a separate field.",
    "- Never mention that this text was generated, rewritten or assisted in any way, and never refer to yourself.",
    "- Never soften or harden the decision he is announcing. You change how it reads, never what it says.",
  ].join("\n"),
  TOOLBOX_BLOCK,
  TOOLBOX_USE_BLOCK,
  [
    "Also return a short list of what you changed, in plain words a non-writer understands, at most five items. Examples of the right register:",
    "- Moved the decision into the first sentence.",
    "- Cut the opening paragraph, which repeated the subject.",
    "- Turned the four requirements into a list.",
    "- Put the branch closing times in a table.",
    "- Made the Arabic paragraph read right to left.",
    "Say nothing about tone in the abstract, and never claim you added anything.",
  ].join("\n"),
].join("\n\n");

/**
 * Write mode's prompt — the assistant the owner asked for on 2026-09-17.
 *
 * The register and the toolbox are the same; the contract is the opposite way round. Here the
 * sender's REQUEST is the source of truth and the body may be empty, so the instruction that
 * carries the weight is the one about gaps: a fact he did not give comes back as a [square bracket]
 * for him to fill, never as a plausible guess. That single rule is what lets this mode write a whole
 * job offer without inventing the salary.
 */
export const SATO_WRITE_INSTRUCTIONS = [
  "You write an internal email for Sato Pharma, an Egyptian pharmaceutical company, inside its HR system. A named colleague has told you what he wants the email to say, in his own words, and you write it for him. It will be emailed to employees, a candidate or a distribution list under the company's own identity, after he has read it.",
  [
    "WHAT YOU PRODUCE:",
    "- The complete email he asked for — subject and body — ready to read and send, not an outline and not a single thin paragraph.",
    "- The KIND of email he names: a job offer reads as a job offer, an announcement as an announcement, a warning letter as a warning letter, an invitation as an invitation. Use the structure that kind of letter normally has.",
    "- Formal corporate register: measured, impersonal, confident. No slang, no exclamation marks, no emoji, no hype, no marketing language.",
    "- Write in the language he used. If he writes Arabic, the email is Arabic; if he asks for both languages, give each its own paragraph.",
    "- A subject that says what the email is about in a few words. Sentence case, never Title Case. Never a teaser, never a question, no Important or Urgent prefix.",
    "- When he has already typed part of the email, build on what is there rather than replacing it.",
  ].join("\n"),
  [
    "🔴 THE ONE RULE THAT MATTERS — YOU NEVER INVENT A FACT:",
    "- Every fact you state must come from what he wrote: his request, or the draft already in the body.",
    "- A fact he did NOT give you — a date, a salary, a figure, a percentage, a deadline, a name, a job title, an area, a phone number, an address, a policy number — is written as a [square bracket] gap in the place it belongs: [start date], [basic salary], [line manager]. He fills it in before sending. A gap he has to fill is useful; a plausible number nobody decided is dangerous.",
    "- Never mint a link or an image address. Use a URL only if he wrote it himself.",
    "- Never promise anything on the company's behalf that he did not say — no benefit, no bonus, no allowance, no guarantee, no deadline.",
    "- Never add a greeting or a sign-off. The email design prints the company's own frame around your text, and he signs it in a separate field.",
    "- Never mention that this text was written, generated or assisted by anything, and never refer to yourself.",
    "- If his request is too thin to write from, still write the email he asked for and leave every unknown as a [square bracket] gap. Say what is missing in the change list.",
  ].join("\n"),
  TOOLBOX_BLOCK,
  TOOLBOX_USE_BLOCK,
  [
    "Also return a short list of what you did, in plain words, at most five items. Examples of the right register:",
    "- Wrote the offer as a letter: role, terms, then what happens next.",
    "- Left [basic salary] and [start date] as gaps for you to fill.",
    "- Put the three terms in a two-column table, as you asked.",
    "- Wrote it in Arabic, right to left.",
    "Name every gap you left, so he knows what is still his to decide.",
  ].join("\n"),
].join("\n\n");

const polishTextFormat = {
  format: {
    name: "sato_email_polish",
    schema: {
      additionalProperties: false,
      properties: {
        bodyHtml: {
          description:
            "The rewritten body, as email HTML built only from the toolbox markup listed in the instructions.",
          type: "string",
        },
        changes: {
          description: "At most five short plain-language lines saying what was changed.",
          items: { type: "string" },
          type: "array",
        },
        subject: { description: "The rewritten subject, plain text, one line.", type: "string" },
      },
      required: ["bodyHtml", "changes", "subject"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

function polishErrorFromOpenAi(error: PhoenixOpenAiError) {
  switch (error.code) {
    case "not_configured":
      return new SatoPolishError("polish_not_configured", "Rewriting is not configured on this server yet.");
    case "quota_exceeded":
      return new SatoPolishError(
        "polish_rate_limited",
        "The writing service is out of credit. Send the email in your own words for now.",
      );
    case "rate_limited":
      return new SatoPolishError("polish_rate_limited", "The writing service is busy. Wait a moment and try again.");
    case "timeout":
      return new SatoPolishError("polish_failed", "The rewrite took too long. Try again.");
    case "auth_failed":
    case "failed":
      return new SatoPolishError("polish_failed", "The rewrite could not be produced. Try again.");
  }
}

function parsePolish(text: string): { bodyHtml: string; changes: string[]; subject: string } {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const attempt = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as { bodyHtml?: unknown; changes?: unknown; subject?: unknown };
      if (typeof parsed?.bodyHtml !== "string" || typeof parsed?.subject !== "string") return null;
      const changes = Array.isArray(parsed.changes)
        ? parsed.changes.filter((item): item is string => typeof item === "string").slice(0, 5)
        : [];
      return { bodyHtml: parsed.bodyHtml, changes, subject: parsed.subject };
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

  throw new SatoPolishError("polish_failed", "The rewrite came back in an unreadable format.");
}

/**
 * Writes or rewrites one draft and hands it straight back to the sender to look at. Writes nothing,
 * sends nothing, and decides nothing.
 */
export async function polishSatoEmailDraft(input: SatoPolishRequest): Promise<SatoPolishResult> {
  const mode = parseSatoAssistMode(input.mode);
  const subject = String(input.subject ?? "").trim();
  const bodyHtml = String(input.bodyHtml ?? "").trim();
  const instruction = String(input.instruction ?? "").trim();

  // Each mode has exactly one thing it cannot start without: rewrite needs an email, write needs a
  // request. An empty body is NORMAL in write mode — that is the whole point of it.
  if (mode === "write") {
    if (!instruction) throw new SatoPolishError("polish_failed", "Tell it what to write first.");
  } else if (!emailPlainText(bodyHtml)) {
    throw new SatoPolishError("polish_failed", "Write the email in your own words first, or use Write it.");
  }
  if (!hasOpenAiApiKey()) {
    throw new SatoPolishError("polish_not_configured", "The assistant is not configured on this server yet.");
  }

  const prompt = buildPolishPrompt({ ...input, bodyHtml, instruction, mode, subject });

  let outputText: string;
  try {
    // The strong tier, not the cheap one, and for the same reason the email module already uses it:
    // this is a whole email going to a distribution list under the company's name, pressed a handful
    // of times a day. The nano tier is the right fit for a one-sentence register change; it is not
    // the right fit for holding a multi-paragraph announcement's meaning steady while rewriting it,
    // nor for writing a job offer that has to leave the unknowns as gaps rather than fill them.
    const response = await createOpenAiResponseText({
      input: prompt,
      instructions: mode === "write" ? SATO_WRITE_INSTRUCTIONS : SATO_POLISH_INSTRUCTIONS,
      // Write mode composes a whole letter, sometimes bilingual, sometimes with a table — the
      // rewrite budget is measured against an email that already exists.
      maxOutputTokens: mode === "write" ? 9_000 : 6_000,
      model: resolveOpenAiCopilotModel(),
      purpose: mode === "write" ? "sato-email-write" : "sato-email-polish",
      reasoning: { effort: "medium" },
      text: polishTextFormat,
      // The copilot model at medium effort routinely outruns the 25s nano-tier default.
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    outputText = response.outputText;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) throw polishErrorFromOpenAi(error);
    throw new SatoPolishError("polish_failed", "The draft could not be produced. Try again.");
  }

  const parsed = parsePolish(outputText);
  const candidate = {
    bodyHtml: cleanPolishedBody(parsed.bodyHtml, bodyHtml),
    // A sender who has not written a subject yet gets the one the model proposes; otherwise his own
    // subject is rewritten like everything else.
    subject: cleanPolishedSubject(parsed.subject),
  };

  const sender = { bodyHtml, instruction, subject };
  const violations = findPolishViolations(candidate, sender, mode);
  if (violations.length > 0) {
    throw new SatoPolishError(
      "polish_failed",
      mode === "write"
        ? `The draft was rejected (${violations.join("; ")}). Try again, or write it yourself.`
        : `The rewrite was rejected because it changed the facts, not just the wording (${violations.join("; ")}). Try again, or send your own words.`,
    );
  }

  return {
    bodyHtml: candidate.bodyHtml,
    changes: parsed.changes.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean),
    // Rewrite mode refuses an invented figure outright, so by here it has none to report. Write
    // mode names them instead — a bare list of digits would tell the sender nothing, so each one
    // arrives as the sentence he needs to act on.
    checks:
      mode === "write"
        ? unverifiedFigures(candidate, sender).map(
            (figure) => `${figure} — you did not write this figure. Confirm it, or replace it with a [gap] to fill.`,
          )
        : [],
    mode,
    subject: candidate.subject,
  };
}
