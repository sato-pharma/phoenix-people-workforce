// Recruitment / Medical Rep hiring — the spoken words turned into a professional comment, in the speaker's own language.
//
// The owner, 8 Nov 2026: "when I talk first, it fix, it understand me and it fix the spelling and the grammar
// … like ChatGPT. It take what I want and then it rephrase it into professional corporate language." The
// microphone (`MrDictate`) writes the words as they are said — Egyptian Arabic with English mixed in, and the
// speech engine's own mishearings — and when the speaker presses Stop, those words come here and go back as
// clear professional wording in the language that was spoken (Egyptian Arabic as clean written Arabic with the
// English work terms in English letters; English as corporate English), in the same box, before anything is saved. The speaker reads it, edits it or puts
// his own words back ("Keep my own words"); nothing here saves, sends or decides anything.
//
// TWO GUARDS on the way out, each failing the call rather than patching it — the box then keeps the words as
// spoken, which is never worse than before this existed:
//   1. no number that was not said: a salary, a rating or a date the model invented would be read as the
//      speaker's own on the candidate's record;
//   2. no word that the text was generated (owner rule 2026-08-04: users never learn a model was involved).
//
// The candidate is never named to the model — it is given the spoken words and the kind of box, nothing else.

import { ANTHROPIC_STRONG_MODEL } from "@/lib/ai/anthropic-fallback";
import { createOpenAiResponseText, hasAiApiKey, OPENAI_STRONG_MODEL, PhoenixOpenAiError } from "@/lib/ai/openai-client";
import { logAppError } from "@/lib/error-monitor/service";
import { MR_BOOKING_NOTES_LIMIT, MR_COMMENT_LIMIT } from "@/lib/recruitment/mr-hiring/vocabulary";

/** Which box the words were spoken into — it decides the register of the rewrite and its cap. */
export const MR_POLISH_KINDS = ["result", "recommendation", "booking"] as const;
export type MrPolishKind = (typeof MR_POLISH_KINDS)[number];

export function isMrPolishKind(value: unknown): value is MrPolishKind {
  return typeof value === "string" && (MR_POLISH_KINDS as readonly string[]).includes(value);
}

/** The box's own cap: the rewrite has to fit where the spoken words were. */
export function mrPolishLimit(kind: MrPolishKind): number {
  return kind === "booking" ? MR_BOOKING_NOTES_LIMIT : MR_COMMENT_LIMIT;
}

/** Sonnet answers a few sentences in seconds; past this the speaker is better served by the words as said. */
export const MR_POLISH_TIMEOUT_MS = 45_000;

export class MrPolishError extends Error {
  code: "polish_failed" | "polish_not_configured" | "polish_rate_limited";

  constructor(code: MrPolishError["code"], message: string) {
    super(message);
    this.name = "MrPolishError";
    this.code = code;
  }
}

// ── Pure ──────────────────────────────────────────────────────────────────────

/** Arabic-Indic and Persian digits read as the same numbers as 0–9, so "١٥٠٠٠" said is "15000" written. */
export function westernDigits(value: string): string {
  return String(value ?? "")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/** Every number in a text, normalised so "15,000", "15000.00" and "١٥٠٠٠" compare equal. */
export function mrNumberTokens(value: string): string[] {
  return Array.from(westernDigits(value).matchAll(/\d[\d,]*(?:\.\d+)?/g)).map((match) => {
    const cleaned = match[0].replace(/,/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? String(parsed) : cleaned;
  });
}

/** The spoken words, whitespace folded and cut to the box's cap — the browser is their only source. */
export function normalizeSpoken(spoken: string, kind: MrPolishKind): string {
  const folded = String(spoken ?? "").replace(/\s+/g, " ").trim();
  return folded.slice(0, mrPolishLimit(kind)).trim();
}

const kindLine: Record<MrPolishKind, string> = {
  booking: "These are HR's notes for the interviewer about an interview being booked with a Medical Representative candidate.",
  recommendation: "This is the National Sales Manager's note on the recommendation after the final interview of a Medical Representative candidate.",
  result: "This is an interviewer's evaluation of a Medical Representative candidate, kept on the candidate's record.",
};

export function buildMrPolishPrompt(spoken: string, kind: MrPolishKind): string {
  return [`Box: ${kindLine[kind]}`, "What the speaker said (speech-to-text):", normalizeSpoken(spoken, kind)].join("\n\n");
}

// "AI" is also how a manager says the Anti Infective line, so a word the SPEAKER said is his to keep.
const AI_WORDS = ["ai", "gpt", "chatgpt", "openai", "llm", "artificial intelligence", "language model"];

function wordsIn(text: string): string {
  return ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

/** Packaging a chat model reaches for — fences, markdown, a wrapping quote, a greeting — never the words. */
export function sanitizeMrPolished(raw: string, kind: MrPolishKind): string {
  let text = String(raw ?? "");
  text = text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
  text = text.replace(/^\s*[-*•]\s+/gm, "");
  text = text.replace(/[*_`#]/g, "");
  text = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
  text = text.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  const limit = mrPolishLimit(kind);
  if (text.length > limit) {
    const head = text.slice(0, limit);
    // The last whole sentence, else the last whole word. Never an ellipsis (owner rule).
    const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    if (sentenceEnd > 0) text = head.slice(0, sentenceEnd + 1).trim();
    else {
      const wordEnd = head.lastIndexOf(" ");
      text = (wordEnd > 0 ? head.slice(0, wordEnd) : head).trim();
    }
  }
  return text;
}

/**
 * The numbers the speaker may be quoted as saying. A small number (0–12: a rating, years, months) is said as an
 * Arabic word far more often than in digits — "خمسة" written "5" is the speaker's own number, and refusing it
 * threw whole rewrites away (owner, 8 Nov 2026: "it doesn't change anything"). A number said with ألف or
 * مليون ("15 ألف") is that many thousands or millions. Anything else must have been said in digits.
 */
export function mrSaidNumbers(spoken: string): Set<string> {
  const said = new Set<string>();
  for (let small = 0; small <= 12; small += 1) said.add(String(small));
  for (const token of mrNumberTokens(spoken)) {
    said.add(token);
    const value = Number(token);
    if (Number.isFinite(value)) {
      said.add(String(value * 1_000));
      said.add(String(value * 1_000_000));
    }
  }
  if (/[أا]لف/.test(spoken)) said.add("1000");
  if (/[أا]لفين/.test(spoken)) said.add("2000");
  return said;
}

/** Why a rewrite must not replace the spoken words. Empty means it may. */
export function findMrPolishViolations(polished: string, spoken: string): string[] {
  const clean = String(polished ?? "").trim();
  if (!clean) return ["it came back empty"];
  const violations: string[] = [];
  const written = wordsIn(clean);
  const said = wordsIn(spoken);
  if (AI_WORDS.some((word) => written.includes(` ${word} `) && !said.includes(` ${word} `))) violations.push("it mentions how it was written");
  const saidNumbers = mrSaidNumbers(spoken);
  const invented = Array.from(new Set(mrNumberTokens(clean).filter((token) => !saidNumbers.has(token))));
  if (invented.length > 0) violations.push(`numbers that were never said (${invented.join(", ")})`);
  return violations;
}

// ── I/O ───────────────────────────────────────────────────────────────────────

const instructions = [
  "You turn what a manager said into a microphone into the professional text of a comment box inside Phoenix Workforce, the HR system of an Egyptian pharmaceutical company that is hiring Medical Representatives.",
  [
    "THE INPUT:",
    "- It is speech-to-text, without punctuation. The speaker talks Egyptian Arabic and mixes English work terms into it, and the speech engine writes those English terms in Arabic letters: الاتيتيود is attitude, اللانجوج is language, الاكسنت is accent, الكومينكيشن is communication, البريزنتيشن is presentation, الكونفيدنس is confidence, الانترفيو is interview, الفيدباك is feedback.",
    "- The speech engine mishears: words may be misspelt, split, merged or replaced by a similar-sounding word. Work out what the speaker meant.",
    "- It often glues short spoken words into one made-up word: نهيبنت is \"هي بنت\" (she is a girl), هوولد is \"هو ولد\", هيكويسة is \"هي كويسة\", دهكويس is \"ده كويس\". A word that is not a real Arabic word is glued words, never a name: split it and write what was meant, and never carry it into the text. Use a name only when it is clearly a real person's or company's name.",
  ].join("\n"),
  [
    "THE LANGUAGE — the speaker's own:",
    "- Spoken mainly in Arabic → write it in clear, professional written Arabic: simple Modern Standard Arabic that any Egyptian manager reads at a glance, never street slang and never heavy classical style. Write every English work term the speaker used in English letters inside the Arabic sentence (\"الـ attitude لديها جيد\"), as Egyptian HR people write them.",
    "- Spoken mainly in English → write it in professional English.",
    "- Never translate the whole comment into the other language.",
  ].join("\n"),
  [
    "THE OUTPUT — a real rewrite, never a light touch-up:",
    "- Write it the way a senior HR professional writes an evaluation for a company file: polished, complete, well-organised sentences with correct spelling, grammar and punctuation.",
    "- Do not follow the speaker's word order, repetitions, filler words (يعني، فاهمني، بقى، أه) or broken phrasing. Put the points in a logical order (overall impression, strengths, concerns, then the verdict or next step) and merge repeated points.",
    "- Plain prose: no greeting, no sign-off, no headings, no bullets, no markdown, no surrounding quotation marks.",
    "- Write about the candidate as \"the candidate\" (in Arabic المرشح / المرشحة, following the gender the speaker used; in English never assuming a gender). Keep the speaker's own view in the first person where the speaker gave one, and keep an instruction to someone as an instruction.",
  ].join("\n"),
  [
    "EXAMPLES",
    "Said: \"هي كويسة جدا الاتيتيود بتاعها كويس بتعرف تتكلم اللانجوج بتاعتها و الاكسنت كويسين فاهمني\"",
    "Written: \"المرشحة جيدة جدًا، والـ attitude لديها جيد، وتتمتع بقدرة جيدة على التحدث، كما أن مستوى الـ language والـ accent لديها جيد.\"",
    "Said: \"هو كويس بس متوتر شوية و الكومينكيشن بتاعه حلو و عنده خبره سنتين في نوفارتس بس الانجلش ضعيف شويه انا شايف انه ينفع للمرحله الجايه\"",
    "Written: \"انطباعي العام عن المرشح جيد، ويتمتع بمهارات communication جيدة، رغم أنه بدا متوترًا بعض الشيء خلال المقابلة. لديه خبرة 2 سنة في Novartis، إلا أن مستوى اللغة الإنجليزية لديه ضعيف نسبيًا. وأرى أنه مناسب للانتقال إلى المرحلة التالية.\"",
  ].join("\n"),
  // The words of Egyptian pharma hiring a general model gets wrong (owner's screenshot, 8 Nov 2026: "امتياز"
  // came back as "franchise", "التكليف" as "assignment" with no meaning).
  [
    "EGYPTIAN PHARMA HIRING WORDS — what they mean (keep the Arabic word in an Arabic comment; use the English meaning in an English one):",
    "- امتياز (imtiyaz): the pharmacy or medical internship year a graduate completes before practising — \"internship year\", never \"franchise\" or \"distinction\".",
    "- تكليف (takleef): the compulsory government service posting after graduation — \"government assignment\".",
    "- دعاية / مجال الدعاية: medical promotion, the Medical Representative's work — \"medical promotion\".",
    "- مندوب / مندوب دعاية: Medical Representative. خط: a product line. منطقة: an area or territory. تارجت: the sales target.",
    "- صيدلي / خريج صيدلة: pharmacist / pharmacy graduate. بيطري: veterinary. علوم: science graduate.",
    "- اسيب / يسيب: to leave. يكمل: to stay on or continue. مرتب / مرتب متوقع: salary / expected salary.",
  ].join("\n"),
  [
    "MEANING — keep it exactly:",
    "- Keep every fact, opinion, judgement, concern and instruction the speaker gave, and nothing else. Never soften or strengthen a verdict.",
    "- Never add a fact, a reason, a condition, a recommendation or a next step the speaker did not say.",
    "- Keep every number exactly as said, written in digits (amounts, ratings, years, dates, times). Never add a number that was not said.",
    "- Keep names of people, places, companies and products as said.",
    "- If a part cannot be understood, leave it out rather than guess.",
    "- Never mention that the text was rewritten, translated or generated.",
  ].join("\n"),
].join("\n\n");

const textFormat = {
  format: {
    name: "phoenix_mr_hiring_comment",
    schema: {
      additionalProperties: false,
      properties: {
        text: { description: "The finished comment, in the speaker's own language, professionally written. Plain text only.", type: "string" },
      },
      required: ["text"],
      type: "object",
    },
    strict: true,
    type: "json_schema",
  },
} as const;

function polishErrorFromOpenAi(error: PhoenixOpenAiError): MrPolishError {
  switch (error.code) {
    case "not_configured":
      return new MrPolishError("polish_not_configured", "Your words were kept as you said them.");
    case "quota_exceeded":
    case "rate_limited":
      return new MrPolishError("polish_rate_limited", "Your words were kept as you said them — the wording service is busy.");
    default:
      return new MrPolishError("polish_failed", "Your words were kept as you said them.");
  }
}

function parsePolished(text: string): string {
  const cleaned = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const attempt = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as { text?: unknown };
      return typeof parsed?.text === "string" ? parsed.text : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(cleaned);
  if (direct !== null) return direct;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const sliced = start >= 0 && end > start ? attempt(cleaned.slice(start, end + 1)) : null;
  if (sliced !== null) return sliced;
  throw new MrPolishError("polish_failed", "Your words were kept as you said them.");
}

/**
 * The spoken words professionally written, in the speaker's own language, for the speaker to read in the box. Never saves anything.
 * The caller has already decided the speaker may write on this candidate (`assertMayPolishMrWords`).
 */
export async function polishMrSpokenWords(input: { kind: MrPolishKind; spoken: string }): Promise<{ text: string }> {
  const spoken = normalizeSpoken(input.spoken, input.kind);
  if (!spoken) throw new MrPolishError("polish_failed", "Nothing was said.");
  if (!hasAiApiKey()) throw new MrPolishError("polish_not_configured", "Your words were kept as you said them.");

  let outputText: string;
  let model = "";
  try {
    // THE STRONG TIER, CLAUDE SONNET FIRST (owner, 8 Nov 2026: "put an Anthropic Sonnet agent … the agent you
    // added is very weak. It doesn't change anything"). It shipped on the cheap nano tier, which touched the
    // words up and left them. OpenAI's strong model answers only when Claude's account is dead.
    const response = await createOpenAiResponseText({
      anthropicModel: ANTHROPIC_STRONG_MODEL,
      input: buildMrPolishPrompt(spoken, input.kind),
      instructions,
      maxOutputTokens: 3000,
      maxRetries: 0,
      model: OPENAI_STRONG_MODEL,
      preferProvider: "anthropic",
      purpose: "recruitment-mr-hiring-dictation-polish",
      reasoning: { effort: "low" },
      text: textFormat,
      timeoutMs: MR_POLISH_TIMEOUT_MS,
    });
    outputText = response.outputText;
    model = response.model;
  } catch (error) {
    if (error instanceof PhoenixOpenAiError) throw polishErrorFromOpenAi(error);
    throw new MrPolishError("polish_failed", "Your words were kept as you said them.");
  }

  const text = sanitizeMrPolished(parsePolished(outputText), input.kind);
  const violations = findMrPolishViolations(text, spoken);
  if (violations.length > 0) {
    // A refused rewrite used to vanish without a trace, so "it doesn't change anything" could not be told apart
    // from a weak model. The row names the reason, the model and the box — never the words, which are about a
    // candidate.
    await logAppError({
      message: `Medical Rep hiring: a spoken comment's rewrite was refused (${violations.join("; ")}) — model ${model || "unknown"}, box ${input.kind}`,
      moduleKey: "recruitment",
      moduleLabel: "Recruitment",
      route: "/ai/recruitment/mr-hiring-dictation-polish/refused",
      source: "server",
    }).catch(() => null);
    throw new MrPolishError("polish_failed", "Your words were kept as you said them.");
  }
  return { text };
}
