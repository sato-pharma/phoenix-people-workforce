/**
 * Turns an approver's rough note into the sentence the employee actually reads on his submission.
 *
 * The owner's framing (2026-08-08): put the reply "as if the system auto replied, never the
 * employee — now that HR is the backend". Managers had started reading a decision as one named
 * person's verdict and arguing with that person. So the published note has to be Phoenix stating
 * an outcome: third person, no "I"/"we", and no HR anywhere in it. The approver still writes the
 * substance, in whatever language and however roughly — this only changes how it reads.
 *
 * Nothing here publishes anything. The rewritten sentence lands back in the same Reason/comment
 * field the approver was already editing, and it is saved by the same Save he was always going to
 * press. He can edit it, or put his own text back, before any of that.
 *
 * The pure half is at the top so the two rules that protect real money can be asserted without a
 * network:
 *
 *   1. the note may never carry a figure that was not put in front of the model, and
 *   2. it may never come back in first-person, HR, or AI voice.
 *
 * Both are checked on the way out and fail the call rather than being patched over. A note that
 * silently loses a digit, or that tells an employee "HR reviewed your claim", is worse than a
 * button that says "try again" — the approver is standing right there and can press it twice.
 */

import {
  createOpenAiResponseText,
  hasAiApiKey,
  PhoenixOpenAiError,
} from "@/lib/ai/openai-client";

/** Two sentences of formal prose. Long enough to give a reason, short enough to stay readable. */
export const EXPENSE_NOTE_MAX_CHARS = 320;

/** One figure or date the note is allowed to cite, already formatted for a human. */
export type ExpenseNoteFact = { label: string; value: string };

/** What the approver is recording, so the rewrite states the right outcome. */
export type ExpenseNoteOutcome = "adjusted" | "approved" | "pending" | "rejected";

export type ExpenseNoteRequest = {
  /** The approver's own rough text. Arabic, English or a mix. */
  draft: string;
  facts: readonly ExpenseNoteFact[];
  outcome: ExpenseNoteOutcome;
};

export class ExpenseNoteAssistError extends Error {
  code: "note_failed" | "note_not_configured" | "note_rate_limited";

  constructor(code: ExpenseNoteAssistError["code"], message: string) {
    super(message);
    this.name = "ExpenseNoteAssistError";
    this.code = code;
  }
}

// ── Pure: input shaping ───────────────────────────────────────────────────────

/** Facts arrive from the browser, so they are capped before they reach a prompt. */
export const MAX_NOTE_FACTS = 12;
const MAX_FACT_LABEL_CHARS = 40;
const MAX_FACT_VALUE_CHARS = 80;
/** The approver types this by hand; a couple of paragraphs is already generous. */
export const MAX_NOTE_DRAFT_CHARS = 1_200;

function clamp(value: string, max: number) {
  const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

/** Drops empty rows and trims the rest to length, so a hostile payload cannot become a prompt. */
export function normalizeExpenseNoteFacts(facts: readonly ExpenseNoteFact[]): ExpenseNoteFact[] {
  return facts
    .map((fact) => ({
      label: clamp(fact?.label ?? "", MAX_FACT_LABEL_CHARS),
      value: clamp(fact?.value ?? "", MAX_FACT_VALUE_CHARS),
    }))
    .filter((fact) => fact.label && fact.value)
    .slice(0, MAX_NOTE_FACTS);
}

const outcomeLine: Record<ExpenseNoteOutcome, string> = {
  adjusted: "The trip is approved but the payable amount has been reduced.",
  approved: "The trip is approved and paid in full.",
  pending: "No decision has been recorded yet; this note is informational.",
  rejected: "The request is rejected.",
};

/**
 * The prompt body. Also doubles as the allow-list source for the number check below — every
 * figure the model is permitted to write is, by construction, a figure that appears in here.
 */
export function buildExpenseNotePrompt(input: ExpenseNoteRequest): string {
  const facts = normalizeExpenseNoteFacts(input.facts);
  return [
    `Decision being recorded: ${outcomeLine[input.outcome] ?? outcomeLine.pending}`,
    facts.length > 0
      ? `Figures and dates you may cite (these are the ONLY ones):\n${facts
          .map((fact) => `- ${fact.label}: ${fact.value}`)
          .join("\n")}`
      : "No figures are available for this trip. Do not cite any number.",
    "Approver's rough note:",
    clamp(input.draft, MAX_NOTE_DRAFT_CHARS),
  ].join("\n\n");
}

// ── Pure: output guards ───────────────────────────────────────────────────────

/**
 * Every number in a piece of text, normalized so the same value written two ways compares equal:
 * "1,250.00", "1250.0" and "1250" all reduce to "1250".
 */
export function numericTokens(value: string): string[] {
  return Array.from(String(value ?? "").matchAll(/\d[\d,]*(?:\.\d+)?/g)).map((match) => {
    const cleaned = match[0].replace(/,/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? String(parsed) : cleaned;
  });
}

function unquote(value: string) {
  return value.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
}

const GREETING = /^(dear|hi|hello|good (morning|afternoon|evening))\b[^\n]*?[,:]\s*/i;
const SIGN_OFF = /\b(kind regards|best regards|regards|sincerely|thanks|thank you)\s*[,.]?\s*[^\n]{0,40}$/i;

/**
 * Structural cleanup only — never rewords. Strips the packaging a chat model reaches for
 * (fences, markdown, a wrapping quote, a greeting, a sign-off) so what remains is one plain
 * paragraph that can be dropped straight into a single-line input.
 */
export function sanitizeSystemNote(raw: string): string {
  let note = String(raw ?? "");
  note = note.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
  note = note.replace(/^\s*[-*•]\s+/gm, "");
  note = note.replace(/[*_`#]/g, "");
  note = note.replace(/\s+/g, " ").trim();
  // A whole-note wrapper quote, straight or curly. Inner quotes are left alone. Stripped BEFORE
  // the greeting and sign-off, both of which are anchored to the ends of the string — a leading
  // quote hides `Dear Ahmed,` from an `^`-anchored pattern — and again after, in case removing a
  // sign-off exposed one.
  note = unquote(note);
  note = note.replace(GREETING, "").trim();
  note = note.replace(SIGN_OFF, "").trim();
  note = unquote(note);

  if (note.length > EXPENSE_NOTE_MAX_CHARS) {
    const head = note.slice(0, EXPENSE_NOTE_MAX_CHARS);
    // Cut at the last complete sentence, else the last whole word. Never an ellipsis: the owner's
    // standing rule is that no text in this system is ever elided with one.
    const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    if (sentenceEnd > 0) note = head.slice(0, sentenceEnd + 1).trim();
    else {
      const wordEnd = head.lastIndexOf(" ");
      note = (wordEnd > 0 ? head.slice(0, wordEnd) : head).trim();
    }
  }

  return note;
}

const VOICE_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // The whole point of the feature: an employee must not read this as one person's verdict.
  { label: "first-person voice", pattern: /\b(i|we|my|our|us|me)\b/i },
  { label: "HR named as the decider", pattern: /\b(hr|human resources)\b/i },
  // Owner rule 2026-08-04: users never learn a model was involved.
  {
    label: "AI attribution",
    pattern: /\b(ai|a\.i\.|gpt|chatgpt|openai|llm|artificial intelligence|language model)\b/i,
  },
];

/**
 * Why a rewritten note must not be used. Empty means it is safe to hand back to the approver.
 *
 * `allowedSource` is the exact text the model was shown; any number in the note that is not in it
 * was invented. That is the one failure that could quietly change what an employee is told they are
 * owed, so it is checked against the prompt itself rather than a hand-kept list of fields.
 */
export function findExpenseNoteViolations(note: string, allowedSource: string): string[] {
  const violations: string[] = [];
  const clean = String(note ?? "").trim();
  if (!clean) return ["the rewritten note came back empty"];

  for (const rule of VOICE_RULES) {
    if (rule.pattern.test(clean)) violations.push(rule.label);
  }

  const allowed = new Set(numericTokens(allowedSource));
  const invented = Array.from(new Set(numericTokens(clean).filter((token) => !allowed.has(token))));
  if (invented.length > 0) violations.push(`figures that were never provided (${invented.join(", ")})`);

  return violations;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

const noteInstructions = [
  "You rewrite an approver's rough note into the single sentence an employee reads on their own outstation expense submission inside Phoenix Workforce, the HR system of an Egyptian pharmaceutical company.",
  [
    "VOICE — this is the entire point of the task:",
    "- The note reads as the system stating an outcome, never as a person addressing an employee.",
    '- Third person and impersonal throughout. Never write "I", "we", "my", "our", "us" or "me".',
    "- Never mention HR, Human Resources, a department, a manager, or any individual. Never say who decided.",
    "- Never mention that this text was generated, rewritten or assisted in any way.",
    "- Write about the claim, the trip and the amount. Never about the claimant's character, honesty or intent.",
  ].join("\n"),
  [
    "STYLE:",
    "- Always write the note in English, whatever language the approver used.",
    "- Formal corporate business register, plain and unambiguous.",
    `- One or two sentences, at most ${EXPENSE_NOTE_MAX_CHARS} characters. No greeting, no sign-off, no bullets, no markdown, no surrounding quotation marks.`,
    "- Lead with the outcome, then the reason.",
    "- Neutral and factual. Do not apologise, do not thank, do not pad, do not threaten.",
  ].join("\n"),
  [
    "FACTS — do not invent any:",
    "- Use only the figures and dates listed in the request, or ones the approver already wrote themselves.",
    "- Never introduce a number that was not given to you: no invented amounts, distances, dates, percentages or counts.",
    "- If the approver's reason is vague, keep it vague. Never guess a specific cause.",
    "- Preserve the approver's meaning exactly. Never add a condition, a deadline or a next step they did not write.",
  ].join("\n"),
  [
    "The required voice, for reference:",
    '- "The claimed amount exceeds the approved rate for this trip, and the payable amount has been adjusted accordingly."',
    '- "This request has been rejected because the trip could not be confirmed against the field activity recorded for that day."',
    '- "The daily allowance has been reduced to one day, as only one day of this trip qualifies."',
  ].join("\n"),
].join("\n\n");

const noteTextFormat = {
  format: {
    name: "phoenix_expense_system_note",
    schema: {
      additionalProperties: false,
      properties: {
        note: {
          description:
            "The finished note, in English, third person and impersonal. One or two sentences. Plain text only.",
          type: "string",
        },
      },
      required: ["note"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

/**
 * Local rather than shared with `email/ai-assist.ts`: the messages name the surface the approver
 * is standing on, and this module has no other reason to depend on the email domain.
 */
function noteErrorFromOpenAi(error: PhoenixOpenAiError) {
  switch (error.code) {
    case "not_configured":
      return new ExpenseNoteAssistError(
        "note_not_configured",
        "Note writing is not configured on this server yet.",
      );
    case "quota_exceeded":
      return new ExpenseNoteAssistError(
        "note_rate_limited",
        "The writing service is out of credit. Write the note by hand for now.",
      );
    case "rate_limited":
      return new ExpenseNoteAssistError(
        "note_rate_limited",
        "The writing service is busy. Wait a moment and try again.",
      );
    case "timeout":
      return new ExpenseNoteAssistError("note_failed", "The note took too long to write. Try again.");
    case "auth_failed":
    case "failed":
      return new ExpenseNoteAssistError("note_failed", "The note could not be written. Try again.");
  }
}

function parseNote(text: string): string {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const attempt = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as { note?: unknown };
      return typeof parsed?.note === "string" ? parsed.note : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(cleaned);
  if (direct !== null) return direct;

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = attempt(cleaned.slice(start, end + 1));
    if (sliced !== null) return sliced;
  }

  throw new ExpenseNoteAssistError("note_failed", "The rewritten note came back in an unreadable format.");
}

/**
 * Rewrites one approver note. Returns the polished sentence for the approver to review — this
 * never writes to the database and never decides anything.
 */
export async function polishExpenseApprovalNote(input: ExpenseNoteRequest): Promise<{ note: string }> {
  const draft = String(input.draft ?? "").trim();
  if (!draft) {
    throw new ExpenseNoteAssistError("note_failed", "Write the note in your own words first.");
  }
  if (!hasAiApiKey()) {
    throw new ExpenseNoteAssistError(
      "note_not_configured",
      "Note writing is not configured on this server yet.",
    );
  }

  const prompt = buildExpenseNotePrompt({ ...input, draft });

  let outputText: string;
  try {
    // The fast tier on purpose. This is a one-sentence register change, not the email module's
    // draft-plus-routing reasoning, and the approver is sitting in front of a half-made decision
    // waiting for it — so the default nano model at low effort is both the right fit and the only
    // latency that makes the button worth pressing.
    const response = await createOpenAiResponseText({
      input: prompt,
      instructions: noteInstructions,
      maxOutputTokens: 900,
      purpose: "outstation-expense-note",
      reasoning: { effort: "low" },
      text: noteTextFormat,
    });
    outputText = response.outputText;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) throw noteErrorFromOpenAi(error);
    throw new ExpenseNoteAssistError("note_failed", "The note could not be written. Try again.");
  }

  const note = sanitizeSystemNote(parseNote(outputText));
  // Checked against the prompt the model actually saw, plus the approver's own words — a figure he
  // typed himself is his to publish, whatever the fact list happened to carry.
  const violations = findExpenseNoteViolations(note, `${prompt} ${draft}`);
  if (violations.length > 0) {
    throw new ExpenseNoteAssistError(
      "note_failed",
      `The rewritten note was rejected (${violations.join("; ")}). Try again or write it by hand.`,
    );
  }

  return { note };
}
