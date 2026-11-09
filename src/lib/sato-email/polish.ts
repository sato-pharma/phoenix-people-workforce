/**
 * The Sato composer's assistant. It has THREE modes, and what separates them is where the facts are
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
 * **Document** — owner 2026-09-23: "i want to have an option to for example upload pdf and the
 * system absorb and extract the data from the pdf and make it as email", attaching the Semester 2
 * 2026 incentive policy. He uploads a paper; this writes the email that carries it. The document is
 * HIS — he chose it and uploaded it seconds ago — so its words, figures and addresses are his to
 * use, and that is the whole of what this mode may say. A figure that is in neither the document
 * nor his instruction is reported as a CHECK exactly as in write mode. When the file turns out to be
 * a picture with no text in it, the page itself goes to the model and the check list says so in one
 * line, because nothing in the draft can be compared with anything.
 *
 * 🔴 WHAT NO MODE MAY DO. This is the one screen that mails a whole distribution list at once,
 * so a minted URL — href or img src alike — is refused outright in all three: it reaches the reader
 * without a click and is the one fabrication shaped like an attack. And in no mode may the reader
 * learn a model was involved (owner rule 2026-08-04).
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
  hasAiApiKey,
  OPENAI_ROUTE_BUDGET_MS,
  PhoenixOpenAiError,
  resolveOpenAiCopilotModel,
} from "@/lib/ai/openai-client";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import type { SatoAssistSource } from "@/lib/sato-email/source-document";
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

/**
 * Where the facts come from: the sender's draft (rewrite), his instruction (write), or the document
 * he uploaded (document).
 */
export type SatoAssistMode = "rewrite" | "write" | "document";

export function parseSatoAssistMode(value: unknown): SatoAssistMode {
  if (value === "write") return "write";
  if (value === "document") return "document";
  return "rewrite";
}

export type SatoPolishRequest = {
  bodyHtml: string;
  /**
   * In rewrite mode, a nudge in the sender's own words — "shorter", "warmer", "lead with the
   * deadline". In write mode it IS the request, and it is the only place new facts may come from.
   */
  instruction?: string;
  mode?: SatoAssistMode;
  /**
   * Document mode: the file the sender uploaded, already read by `read-source-document.ts`. Its
   * words join his own writing, so every figure in it is a figure he is allowed to state.
   */
  source?: SatoAssistSource;
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
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // LAST, so `&amp;lt;` reads as the text `&lt;`, never as a second decode.
    .replace(/&amp;/gi, "&")
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

export type SatoAssistSender = {
  bodyHtml: string;
  instruction?: string;
  /** Document mode: the words read out of the file he uploaded. His document, so his facts. */
  sourceText?: string;
  subject: string;
};

/**
 * Everything the sender himself wrote, as words.
 *
 * 🔴 THE INSTRUCTION COUNTS AS HIS WRITING, IN BOTH MODES. He typed it, on this screen, seconds
 * ago. Leaving it out is what made the assistant feel like a do-nothing: "say we close at 2 PM"
 * typed into the box came back refused as a figure nobody wrote.
 */
export function senderWriting(sender: SatoAssistSender): string {
  return [
    sender.subject,
    emailPlainText(sender.bodyHtml),
    String(sender.instruction ?? ""),
    // 🔴 AND SO DOES THE DOCUMENT. He chose the file and uploaded it on this screen; refusing the
    // policy's own 21,000 as "a figure nobody wrote" would refuse every draft this mode produces.
    String(sender.sourceText ?? ""),
  ]
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

  const allowedLinks = new Set([
    ...linkTargets(sender.bodyHtml),
    ...writtenUrls(String(sender.instruction ?? "")),
    // An address printed in his document is an address he handed over, exactly like one he typed.
    ...writtenUrls(String(sender.sourceText ?? "")),
  ]);
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

  if (mode === "document") {
    const source = input.source;
    const sourceText = String(source?.text ?? "").trim();
    return [
      `The document the sender uploaded: ${source?.fileName ?? "the file"}`,
      sourceText
        ? `What the document says — this, and the sender's request below, are the ONLY facts you may state:\n${sourceText}`
        : "The document carries no text of its own — it is attached to this request as a file. Read it, and state nothing it does not say.",
      instruction
        ? `What the sender asked you to do with it:\n${instruction}`
        : "The sender did not say what to do with it — write the email that tells colleagues what this document says.",
      subject
        ? `Subject the sender has already typed (keep it unless it no longer fits):\n${subject}`
        : "Subject: the sender has not typed one — write it.",
      emailPlainText(body) ? `What is already in the body (build on it, do not throw it away):\n${body}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (mode === "write") {
    return [
      `What the sender asked you to write:\n${instruction}`,
      subject ? `Subject the sender has already typed (keep it unless they asked otherwise):\n${subject}` : "Subject: the sender has not typed one — write it.",
      emailPlainText(body)
        ? `What is already in the body (build on it, do not throw it away):\n${body}`
        : "The body is empty — this email is yours to write from the sender's request above.",
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
  "When the sender asks for one of these in their own words, do it. \"Bold the deadline\", \"put the dates in a table\", \"make it a list\", \"right-align the Arabic\" are instructions to use that tool.",
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
    "- Never add a fact. No date, no deadline, no figure, no percentage, no policy number, no department, no name, no link that the sender did not write. If their draft is vague, it stays vague.",
    "- Never keep a figure and change it, and never convert one into different units.",
    "- Never fill in anything inside [square brackets]. Those are gaps the sender fills in themselves: copy each one through exactly as it is.",
    "- Never add a next step, a condition, a consequence or a contact that the sender did not write.",
    "- Never add a greeting or a sign-off. The email design prints the company's own frame around your text, and the sender signs it in a separate field.",
    "- Never mention that this text was generated, rewritten or assisted in any way, and never refer to yourself.",
    "- Never soften or harden the decision the sender is announcing. You change how it reads, never what it says.",
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
  "You write an internal email for Sato Pharma, an Egyptian pharmaceutical company, inside its HR system. A named colleague has told you what they want the email to say, in their own words, and you write it for them. It will be emailed to employees, a candidate or a distribution list under the company's own identity, after they have read it.",
  [
    "WHAT YOU PRODUCE:",
    "- The complete email the sender asked for — subject and body — ready to read and send, not an outline and not a single thin paragraph.",
    "- The KIND of email the sender names: a job offer reads as a job offer, an announcement as an announcement, a warning letter as a warning letter, an invitation as an invitation. Use the structure that kind of letter normally has.",
    "- Formal corporate register: measured, impersonal, confident. No slang, no exclamation marks, no emoji, no hype, no marketing language.",
    "- Write in the language the sender used. If they write Arabic, the email is Arabic; if they ask for both languages, give each its own paragraph.",
    "- A subject that says what the email is about in a few words. Sentence case, never Title Case. Never a teaser, never a question, no Important or Urgent prefix.",
    "- When the sender has already typed part of the email, build on what is there rather than replacing it.",
  ].join("\n"),
  [
    "🔴 THE ONE RULE THAT MATTERS — YOU NEVER INVENT A FACT:",
    "- Every fact you state must come from what the sender wrote: their request, or the draft already in the body.",
    "- A fact the sender did NOT give you — a date, a salary, a figure, a percentage, a deadline, a name, a job title, an area, a phone number, an address, a policy number — is written as a [square bracket] gap in the place it belongs: [start date], [basic salary], [line manager]. The sender fills it in before sending. A gap they have to fill is useful; a plausible number nobody decided is dangerous.",
    "- Never mint a link or an image address. Use a URL only if the sender wrote it themselves.",
    "- Never promise anything on the company's behalf that the sender did not say — no benefit, no bonus, no allowance, no guarantee, no deadline.",
    "- Never add a greeting or a sign-off. The email design prints the company's own frame around your text, and the sender signs it in a separate field.",
    "- Never mention that this text was written, generated or assisted by anything, and never refer to yourself.",
    "- If the sender's request is too thin to write from, still write the email they asked for and leave every unknown as a [square bracket] gap. Say what is missing in the change list.",
  ].join("\n"),
  TOOLBOX_BLOCK,
  TOOLBOX_USE_BLOCK,
  [
    "Also return a short list of what you did, in plain words, at most five items. Examples of the right register:",
    "- Wrote the offer as a letter: role, terms, then what happens next.",
    "- Left [basic salary] and [start date] as gaps for you to fill.",
    "- Put the three terms in a two-column table, as you asked.",
    "- Wrote it in Arabic, right to left.",
    "Name every gap you left, so the sender knows what is still theirs to decide.",
  ].join("\n"),
].join("\n\n");

/**
 * Document mode's prompt — the assistant the owner asked for on 2026-09-23.
 *
 * The contract is write mode's with the source moved: the facts come from the PAPER, and the email
 * is what carries it to people who have not read it. Two rules do the work here — the one about not
 * reproducing the document (an email that is the document retyped is worth nothing to the reader)
 * and the one about figures, which must arrive exactly as the document prints them. This is a
 * pharmaceutical company's incentive policy: a rounded percentage is a wrong percentage.
 */
export const SATO_DOCUMENT_INSTRUCTIONS = [
  "You write an internal email for Sato Pharma, an Egyptian pharmaceutical company, inside its HR system. A named colleague has uploaded a document and wants the email that carries it to colleagues who have not read it. It will be emailed under the company's own identity, after the sender has read it.",
  [
    "WHAT YOU PRODUCE:",
    "- The complete email — subject and body — that says what this document decides and what it means for the reader.",
    "- Not the document retyped. Lead with what it decides or announces, then what the reader must do, then the detail that matters. A long document still gives a short email: the document itself is the place for everything. The one thing brevity never removes is a table of figures — see the rule below.",
    "- The figures that matter, exactly as the document states them. Never round one, never convert one into other units, never recalculate one, and never state a total the document does not state.",
    "🔴 - A TABLE IN THE DOCUMENT ARRIVES AS A TABLE. A rate card, an achievement curve, a band, a schedule, a grid of outcomes — anything the paper sets out in rows and columns is rebuilt as a table with a header row, one row per line, figure for figure, using the toolbox table markup below. Never flatten one into a list or a paragraph: the rows ARE the rule, and a reader who has to reassemble them from prose will get it wrong. Keep the document's own column headings, and leave out only a column the reader genuinely does not need.",
    "- Where the document has no table, do not invent one. Prose stays prose.",
    "- A subject taken from what the document is, in a few words. Sentence case, never Title Case, never a teaser.",
    "- Formal corporate register: measured, impersonal, confident. No slang, no exclamation marks, no emoji, no hype.",
    "🔴 - THE EMAIL IS BILINGUAL, WHATEVER LANGUAGE THE DOCUMENT IS IN — English and Arabic, every time. An English policy gives an English AND an Arabic email; so does an Arabic one. The reader is an Egyptian colleague who may read either, and a document email that arrives in one language only is half delivered. The one exception is a language the sender names in their own request — then write that one alone.",
  ].join("\n"),
  [
    "HOW THE TWO LANGUAGES SIT TOGETHER:",
    "- Paragraph by paragraph, never two halves. Each English paragraph is followed immediately by the same paragraph in Arabic, then the next English paragraph, and so on. A reader of either language then meets the email in the same order, and neither has to scroll past the other's whole letter to reach their own.",
    "- The Arabic is a translation of the paragraph above it — not a summary of it, and not extra material. Same facts, same figures, same order, and the same [square bracket] gaps in the same places.",
    "- English paragraphs carry dir=\"ltr\". Arabic paragraphs carry dir=\"rtl\", which already right-aligns them — never add text-align as well. Put the direction on every paragraph, the English ones included: one direction around the whole body renders the other language backwards.",
    "- A list is written twice the same way: the English <ul> in full, then the Arabic <ul> in full beneath it, each list carrying its own direction.",
    "- A HEADING IS WRITTEN ONCE, carrying both languages in the one line, English first, separated by a space, a middle dot and a space — English heading · العنوان بالعربية. Never the same heading twice.",
    "🔴 - A TABLE IS BUILT ONCE, NEVER TWICE. Its figures read the same in both languages, and a second copy would double the width and push the email off the side of a phone. Each header cell carries both languages inside that one cell, English first, then a <br /> and the Arabic; a body cell whose content is WORDS does the same. A cell that is a figure, a date or a percentage is written once, exactly as the document prints it.",
    "- Arabic keeps the Western digits the document uses (1, 2, 3), never Eastern Arabic numerals, so the two halves can be read against each other.",
    "- A product name, a brand, a job title the company uses in English, and any code stay in English inside the Arabic paragraph. Never transliterate one.",
    "- The subject carries both, English first, separated by a space, a middle dot and a space — English subject · الموضوع بالعربية. Sentence case in both.",
    "- Egyptian corporate Arabic: Modern Standard, formal, the register an HR circular is written in here. Never dialect, and never a machine-literal rendering of the English word order.",
  ].join("\n"),
  [
    "🔴 THE ONE RULE THAT MATTERS — EVERYTHING YOU SAY COMES FROM THE DOCUMENT:",
    "- Every fact, figure, date, name, percentage and condition must be in the document the sender uploaded or in their own request. Nothing else exists.",
    "- Something the document leaves open — who it applies to, when it starts, who to ask — is written as a [square bracket] gap in the place it belongs, never as a guess.",
    "- Never say the document is attached, enclosed or linked. The sender decides separately whether to attach it, and an email promising an attachment they did not add is wrong.",
    "- Never mint a link or an image address. Use a URL only if it is printed in the document or the sender wrote it themselves.",
    "- Never add a greeting or a sign-off. The email design prints the company's own frame around your text, and the sender signs it in a separate field.",
    "- Never carry over the document's header, footer, page numbers or the note saying who published it. Those belong to the paper, not to the email.",
    "- Never mention that this text was written, generated or assisted by anything, and never refer to yourself.",
  ].join("\n"),
  TOOLBOX_BLOCK,
  TOOLBOX_USE_BLOCK,
  [
    "Also return a short list of what you did, in plain words, at most five items. Examples of the right register:",
    "- Led with the change to the incentive, which is what the paper decides.",
    "- Kept the achievement table as it is printed, figure for figure.",
    "- Left out the worked example, which is in the document itself.",
    "- Left [who this applies to] as a gap for you to fill.",
    "Name anything important you left out, and every gap you left.",
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

/**
 * 🔴 HOW HARD THE MODEL THINKS, AND HOW LONG IT IS GIVEN — both measured, not guessed.
 *
 * Document mode was shipped on the same "medium" effort as the other two and it did not work: on
 * the owner's own 410 KB incentive policy the call took **115 seconds** against a 60-second budget,
 * so every attempt died on the timeout and he was shown "The rewrite took too long" after a minute
 * of watching a spinner (his words, 2026-09-23: "its taking hilarious long time").
 *
 * The same document at **low** effort, measured three times: 28.9 s, 37.7 s, 38.6 s — and the
 * output is not worse. Each run rebuilt all three tables, carried every one of the eight
 * achievement-curve figures (46,200 · 36,750 · 27,300 · 24,150 · 21,000 · 15,750 · 12,600 · 10,500)
 * and returned an EMPTY check list, meaning nothing in the draft was unverifiable against the
 * paper. That is the whole quality bar for this mode, and low effort clears it three times faster.
 *
 * Why low is the right effort HERE and not for the other two: the facts are already on the page.
 * Document mode transcribes and arranges what it was handed. Write mode invents the letter from one
 * line of instruction, and rewrite mode has to hold an existing email's meaning steady — those are
 * judgement, and they keep medium.
 *
 * The budget is raised anyway, because a longer or denser document is slower than this one and a
 * timeout must remain a real ceiling rather than the normal outcome. 120 s against a measured 39 s
 * is three times the worst run seen.
 */
const SATO_ASSIST_EFFORT = { document: "low", rewrite: "medium", write: "medium" } as const;
const SATO_DOCUMENT_BUDGET_MS = 120_000;

function polishErrorFromOpenAi(error: PhoenixOpenAiError, mode: SatoAssistMode) {
  // Every one of these reaches the sender verbatim, so it has to name what HE pressed. "The rewrite
  // took too long" on a document he uploaded reads as a bug in something he never touched.
  const what = mode === "document" ? "The document" : mode === "write" ? "The draft" : "The rewrite";
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
      return new SatoPolishError("polish_failed", `${what} took too long. Try again.`);
    case "auth_failed":
    case "failed":
      return new SatoPolishError("polish_failed", `${what} could not be produced. Try again.`);
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

function checkList(
  mode: SatoAssistMode,
  source: SatoAssistSource | undefined,
  candidate: { bodyHtml: string; subject: string },
  sender: SatoAssistSender,
): string[] {
  if (mode === "rewrite") return [];
  if (mode === "document" && source?.route === "picture") {
    return [
      "There are no words in that file, so the figures in this draft could not be checked against it. Read every number against the document before you send.",
    ];
  }
  return unverifiedFigures(candidate, sender).map(
    (figure) =>
      mode === "document"
        ? `${figure} — this figure is not in the document. Confirm it, or replace it with a [gap] to fill.`
        : `${figure} — you did not write this figure. Confirm it, or replace it with a [gap] to fill.`,
  );
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
  // request, document needs the document. An empty body is NORMAL in the other two — that is the
  // whole point of them.
  const source = mode === "document" ? input.source : undefined;
  if (mode === "document") {
    if (!source || (!String(source.text ?? "").trim() && !source.file)) {
      throw new SatoPolishError("polish_failed", "Upload the document first.");
    }
  } else if (mode === "write") {
    if (!instruction) throw new SatoPolishError("polish_failed", "Tell it what to write first.");
  } else if (!emailPlainText(bodyHtml)) {
    throw new SatoPolishError("polish_failed", "Write the email in your own words first, or use Write it.");
  }
  if (!hasAiApiKey()) {
    throw new SatoPolishError("polish_not_configured", "The assistant is not configured on this server yet.");
  }

  const prompt = buildPolishPrompt({ ...input, bodyHtml, instruction, mode, source, subject });

  // A document that turned out to be a picture goes to the model whole, exactly as the CV intake
  // sends a scanned CV: `input_file` for a PDF so the model renders the pages itself, `input_image`
  // for a photograph. The prompt above still travels with it — it carries the sender's request, their subject
  // and whatever is already in the body.
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
    // The strong tier, not the cheap one, and for the same reason the email module already uses it:
    // this is a whole email going to a distribution list under the company's name, pressed a handful
    // of times a day. The nano tier is the right fit for a one-sentence register change; it is not
    // the right fit for holding a multi-paragraph announcement's meaning steady while rewriting it,
    // nor for writing a job offer that has to leave the unknowns as gaps rather than fill them.
    const response = await createOpenAiResponseText({
      input: modelInput,
      instructions:
        mode === "document"
          ? SATO_DOCUMENT_INSTRUCTIONS
          : mode === "write"
            ? SATO_WRITE_INSTRUCTIONS
            : SATO_POLISH_INSTRUCTIONS,
      // Write and document modes compose a whole letter, sometimes bilingual, sometimes with a
      // table — the rewrite budget is measured against an email that already exists.
      maxOutputTokens: mode === "rewrite" ? 6_000 : 9_000,
      model: resolveOpenAiCopilotModel(),
      purpose: mode === "document" ? "sato-email-document" : mode === "write" ? "sato-email-write" : "sato-email-polish",
      reasoning: { effort: SATO_ASSIST_EFFORT[mode] },
      text: polishTextFormat,
      // The copilot model outruns the 25s nano-tier default in every mode; document mode outruns
      // the 60s route budget too, which is why it has its own. See SATO_ASSIST_EFFORT above.
      timeoutMs: mode === "document" ? SATO_DOCUMENT_BUDGET_MS : OPENAI_ROUTE_BUDGET_MS,
    });
    outputText = response.outputText;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) throw polishErrorFromOpenAi(error, mode);
    throw new SatoPolishError("polish_failed", "The draft could not be produced. Try again.");
  }

  const parsed = parsePolish(outputText);
  const candidate = {
    bodyHtml: cleanPolishedBody(parsed.bodyHtml, bodyHtml),
    // A sender who has not written a subject yet gets the one the model proposes; otherwise their own
    // subject is rewritten like everything else.
    subject: cleanPolishedSubject(parsed.subject),
  };

  const sender = { bodyHtml, instruction, sourceText: source?.text ?? "", subject };
  const violations = findPolishViolations(candidate, sender, mode);
  if (violations.length > 0) {
    throw new SatoPolishError(
      "polish_failed",
      mode === "rewrite"
        ? `The rewrite was rejected because it changed the facts, not just the wording (${violations.join("; ")}). Try again, or send your own words.`
        : `The draft was rejected (${violations.join("; ")}). Try again, or write it yourself.`,
    );
  }

  return {
    bodyHtml: candidate.bodyHtml,
    changes: parsed.changes.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean),
    // Rewrite mode refuses an invented figure outright, so by here it has none to report. The other
    // two name them instead — a bare list of digits would tell the sender nothing, so each one
    // arrives as the sentence the sender needs to act on.
    //
    // 🔴 A DOCUMENT WITH NO TEXT IN IT CANNOT BE CHECKED AT ALL. Nothing was read out of the file,
    // so every figure in the draft is unverifiable and listing them one by one would say the same
    // thing eight times. One honest line replaces the list.
    checks: checkList(mode, source, candidate, sender),
    mode,
    subject: candidate.subject,
  };
}
