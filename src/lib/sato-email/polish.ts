/**
 * Takes what the sender actually wanted to say and gives it back in the company's voice: tighter,
 * plainer, corporate — the same email, better written.
 *
 * Owner 2026-09-12: "add ai tool is the new sato composer in which i write what i want and it
 * enhance rephrase more to the point more corporate".
 *
 * 🔴 THIS REWRITES WORDING AND FORMATTING. IT NEVER ADDS FACTS.
 *
 * The Sato composer is the one screen that mails a whole distribution list at once, so the failure
 * that matters here is not a clumsy sentence — it is a polished one that says something Sato never
 * said. A model asked to make a thin note sound corporate will happily invent the effective date,
 * the policy number, the deadline and the link. So every figure, every [square-bracket] gap and
 * every address — href or img src alike — that comes back is checked against what the sender wrote,
 * and the call FAILS rather than hands back something plausible. The sender is sitting in front of
 * the button and can press it again; a fabricated date in a company-wide announcement cannot be
 * taken back.
 *
 * It may FORMAT freely within the composer's own toolbox (`src/lib/email/toolbar-tools.ts`) — bold,
 * a list, a table, an Arabic paragraph's direction — because formatting rearranges what is already
 * there. It may not use a tool to introduce anything: a table cell needs a value the draft already
 * holds, and an <img> needs an address the sender already wrote.
 *
 * Nothing here sends anything, and nothing here is saved. The rewritten wording lands in the same
 * subject and body fields the sender was already editing, the preview is invalidated so a
 * recipient count can never describe a different email, and Undo puts his own words back untouched.
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

export type SatoPolishRequest = {
  bodyHtml: string;
  /** An optional nudge in the sender's own words — "shorter", "warmer", "make the deadline stand out". */
  instruction?: string;
  subject: string;
};

export type SatoPolishResult = {
  bodyHtml: string;
  /** One short line per change, so the sender can see what was done without diffing two drafts. */
  changes: string[];
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

/**
 * Why a rewrite must not be handed back. Empty means it is safe for the sender to look at.
 *
 * Everything is measured against what the sender wrote — his subject and his body, in words, with
 * the markup stripped — because that is the whole definition of "rephrase": nothing may arrive that
 * was not already there.
 */
export function findPolishViolations(
  candidate: { bodyHtml: string; subject: string },
  sender: { bodyHtml: string; subject: string },
): string[] {
  const violations: string[] = [];

  const bodyText = emailPlainText(candidate.bodyHtml);
  if (!bodyText) violations.push("the rewritten body came back empty");
  if (!candidate.subject.trim()) violations.push("the rewritten subject came back empty");

  const written = `${sender.subject}\n${emailPlainText(sender.bodyHtml)}`;
  const rewritten = `${candidate.subject}\n${bodyText}`;

  for (const rule of VOICE_RULES) {
    if (rule.pattern.test(rewritten) && !rule.pattern.test(written)) violations.push(rule.label);
  }

  const allowedFigures = new Set(numericTokens(written));
  const invented = Array.from(new Set(numericTokens(rewritten).filter((token) => !allowedFigures.has(token))));
  if (invented.length > 0) violations.push(`figures nobody wrote (${invented.join(", ")})`);

  // A gap the sender still has to fill must survive the rewrite. One that disappeared was filled
  // in by the model, which means the email now states something as fact that nobody decided.
  const kept = new Set(bracketTokens(rewritten));
  const lost = Array.from(new Set(bracketTokens(written).filter((token) => !kept.has(token))));
  if (lost.length > 0) violations.push(`gaps it filled in by itself (${lost.join(", ")})`);

  const allowedLinks = new Set(linkTargets(sender.bodyHtml));
  const mintedLinks = Array.from(new Set(linkTargets(candidate.bodyHtml).filter((href) => !allowedLinks.has(href))));
  if (mintedLinks.length > 0) violations.push(`links nobody wrote (${mintedLinks.join(", ")})`);

  return violations;
}

// -- Pure: the prompt --------------------------------------------------------

export function buildPolishPrompt(input: SatoPolishRequest): string {
  const instruction = String(input.instruction ?? "").replace(/\s+/g, " ").trim();
  return [
    `Subject as written:\n${String(input.subject ?? "").trim() || "(the sender has not written one yet)"}`,
    `Body as written (HTML):\n${String(input.bodyHtml ?? "").slice(0, SATO_POLISH_MAX_BODY_CHARS)}`,
    instruction ? `What the sender asked for on top of the house voice:\n${instruction.slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

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
  [
    "THE TOOLBOX — you are pressing the same buttons the sender has:",
    "The sender writes in an editor with a Gmail-style toolbar. You cannot click it, so you press a button by writing the markup that button produces. This is the whole list, and nothing outside it survives:",
    ...toolboxPromptLines(),
    "",
    "When the sender asks for one of these in his own words, do it. \"Bold the deadline\", \"put the dates in a table\", \"make it a list\", \"right-align the Arabic\" are instructions to use that tool, not requests for new content — you format what is already there.",
  ].join("\n"),
  [
    "HOW TO USE THE TOOLBOX — restraint is the house style:",
    "- Formatting carries meaning. If everything is bold, nothing is. A company announcement normally needs nothing more than paragraphs, one list, and bold on the single thing that must not be missed.",
    "- Use a heading only when the announcement genuinely has two or more sections. One section needs no heading.",
    "- Use a table only when the draft already contains something with two dimensions — a date per branch, an amount per grade. Never build a table with an empty cell, and never add a column the draft cannot fill.",
    "- Colour, highlight, font and font size only when the sender asks for them. Left alone, the house design supplies all of that and looks better than anything you would choose.",
    "- Arabic paragraphs take dir=\"rtl\", which already right-aligns them — do not add text-align as well. English paragraphs need neither. In a bilingual email set the direction per paragraph, never once around the whole body.",
    "- Use <ul> when the draft lists things. One idea per item, no full stop at the end of an item.",
    "- No <div>, no <script>, no class attribute, no markdown, no code fences. A style declaration outside the list above is dropped in silence, so writing one just loses the formatting.",
  ].join("\n"),
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
 * Rewrites one draft and hands it straight back to the sender to look at. Writes nothing, sends
 * nothing, and decides nothing.
 */
export async function polishSatoEmailDraft(input: SatoPolishRequest): Promise<SatoPolishResult> {
  const subject = String(input.subject ?? "").trim();
  const bodyHtml = String(input.bodyHtml ?? "").trim();
  if (!emailPlainText(bodyHtml)) {
    throw new SatoPolishError("polish_failed", "Write the email in your own words first.");
  }
  if (!hasOpenAiApiKey()) {
    throw new SatoPolishError("polish_not_configured", "Rewriting is not configured on this server yet.");
  }

  const prompt = buildPolishPrompt({ ...input, bodyHtml, subject });

  let outputText: string;
  try {
    // The strong tier, not the cheap one, and for the same reason the email module already uses it:
    // this is a whole email going to a distribution list under the company's name, pressed a handful
    // of times a day. The nano tier is the right fit for a one-sentence register change; it is not
    // the right fit for holding a multi-paragraph announcement's meaning steady while rewriting it.
    const response = await createOpenAiResponseText({
      input: prompt,
      instructions: SATO_POLISH_INSTRUCTIONS,
      maxOutputTokens: 6_000,
      model: resolveOpenAiCopilotModel(),
      purpose: "sato-email-polish",
      reasoning: { effort: "medium" },
      text: polishTextFormat,
      // The copilot model at medium effort routinely outruns the 25s nano-tier default.
      timeoutMs: OPENAI_ROUTE_BUDGET_MS,
    });
    outputText = response.outputText;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) throw polishErrorFromOpenAi(error);
    throw new SatoPolishError("polish_failed", "The rewrite could not be produced. Try again.");
  }

  const parsed = parsePolish(outputText);
  const candidate = {
    bodyHtml: cleanPolishedBody(parsed.bodyHtml, bodyHtml),
    // A sender who has not written a subject yet gets the one the model proposes; otherwise his own
    // subject is rewritten like everything else.
    subject: cleanPolishedSubject(parsed.subject),
  };

  const violations = findPolishViolations(candidate, { bodyHtml, subject });
  if (violations.length > 0) {
    throw new SatoPolishError(
      "polish_failed",
      `The rewrite was rejected because it changed the facts, not just the wording (${violations.join("; ")}). Try again, or send your own words.`,
    );
  }

  return {
    bodyHtml: candidate.bodyHtml,
    changes: parsed.changes.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean),
    subject: candidate.subject,
  };
}
