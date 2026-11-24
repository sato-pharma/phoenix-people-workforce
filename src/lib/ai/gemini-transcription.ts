/**
 * Speech to text with Google's Gemini 3.5 Flash — the engine that writes a Phoenix CRM voice note out first,
 * with Groq's Whisper (`./groq-transcription.ts`) answering when this one cannot.
 *
 * WHY GEMINI (owner, 24 Nov 2026: "Switch to Gemini"). He asked for the service that writes Egyptian Arabic
 * mixed with English words "as the same person is saying exactly", and judged a listening test of 20 real
 * visit notes from 13 reps, each written by three services. Whisper — the engine before this — wrote a
 * subtitle credit ("ترجمة نانسي قنقر") on three notes with nobody speaking, handed back its own sample
 * sentence instead of the rep's words on a fourth, and misheard names, numbers and specialties (بشويه for
 * بيشوي, 290 for 92, البطلة for الباطنة). Gemini 3.5 Flash wrote the names, the numbers and the products
 * right, and the English words in English letters where the rep said them (Royafloxacin, headache,
 * feedback). Google's own speech model, Gemini 3.5 Transcribe, was the third and lost: it dropped product
 * names and returned nothing on four notes.
 *
 * 🔴 IT NEEDS A PAID KEY. Google's free tier allows 20 requests a day per model (measured 24 Nov 2026,
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, quotaValue 20) and may use what it is sent to
 * improve Google's products — a rep's voice and a doctor's name. With no key, or a key that refuses, every
 * note still goes to Whisper exactly as before, so nothing breaks while the key is missing.
 *
 * WHY A RAW FETCH. One JSON POST does not need Google's SDK, and the same reasoning as the Groq file holds:
 * the address is written out here and nowhere else (tests/ai-one-door.test.ts), so no setting elsewhere can
 * point a rep's voice at a different service.
 */

import { GroqTranscriptionError, isHallucinatedTranscript, type GroqTranscriptionCode } from "@/lib/ai/groq-transcription";
import { closeWebmTimelineGaps, isWebmRecording } from "@/lib/ai/webm-timeline";
import { recordAiCall, type AiCallProvider } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";

/** The model the listening test chose. Not the "transcribe" model, which lost it (see the header). */
export const GEMINI_TRANSCRIPTION_MODEL = "gemini-3.5-flash";

/** Written out, never read from a setting — see the header. */
const GEMINI_TRANSCRIPTION_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIPTION_MODEL}:generateContent`;

/**
 * Longer than Whisper's 45 s on purpose. Gemini listens and then writes, and on the 20 test notes it took
 * 8 s at the quickest, 19 s at the middle and 48 s at the slowest. A timeout is not the end for the rep: the
 * same recording goes to Whisper, which answers in about a second.
 */
const TIMEOUT_MS = 55_000;

/** The largest audio sent inline. Google's own request ceiling is 20 MB; the CRM's cap is far below both. */
const GEMINI_TRANSCRIPTION_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A Gemini refusal. It IS a `GroqTranscriptionError` so the one message table every rep reads
 * (`groqTranscriptionMessage`) and every status mapping already in place answer it without a second copy.
 */
export class GeminiTranscriptionError extends GroqTranscriptionError {
  constructor(code: GroqTranscriptionCode, message: string, status: number | null = null) {
    super(code, message, status);
    this.name = "GeminiTranscriptionError";
  }
}

export function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * 🔴 THE INSTRUCTION THE LISTENING TEST MEASURED, WORD FOR WORD — change it and the test no longer speaks for
 * it. It asks for TWO fields although only `verbatim` reaches the comment: the measured answers came from
 * this shape, and the tidied half is what a manager's summary would read if he ever wants one.
 *
 * Unlike Whisper's prompt this IS an instruction, and Gemini obeys it — so there is no sample sentence to
 * echo back, and "no speech → empty string" is asked for in words rather than guessed after.
 */
export function geminiTranscriptionInstruction(productNames: readonly string[]): string {
  return `This audio is a voice note recorded in Egypt by a pharmaceutical medical representative right after visiting a doctor or a pharmacy. Return two fields.

verbatim: exactly what the speaker said, word for word, in Egyptian Arabic as it was spoken — Egyptian spelling (دلوقتي، عشان، مش، اللي، بتاع), never Modern Standard Arabic and never another dialect. Do not translate, summarise, correct grammar or add anything. Write every English word the speaker says (drug names, medical terms, English phrases) in English letters, exactly where it was said. Product names use exactly these spellings: ${productNames.join(", ")}. If a word is unclear write [غير واضح]. If there is no speech, return an empty string.

tidy: the same note made easy for a manager to read — the speaker's own words and meaning in Egyptian Arabic, with only false starts, repeated words and fillers (يعني، اه، امم) removed and punctuation added. Never add a fact, never change a name, number, product or what the doctor said. English words stay in English letters.`;
}

/**
 * Google answers 429 for a per-minute limit and for a used-up day or spend cap alike; only the body says which.
 * A bad key is a 400 `API_KEY_INVALID` as often as a 401/403, so the body decides that too.
 */
export function geminiCodeForStatus(status: number, body: string): GroqTranscriptionCode {
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|API key expired/i.test(body)) return "auth_failed";
  if (status === 413) return "too_large";
  if (status !== 429) return "failed";
  return /PerDay|billing|spend|credit|prepayment/i.test(body) ? "quota_exceeded" : "rate_limited";
}

/**
 * The `verbatim` field out of one generateContent answer, or null when the answer has no readable shape.
 * A blocked or empty candidate is null (a failure, so Whisper is asked); a readable answer whose verbatim is
 * empty is "" (nobody spoke, so nothing is asked of anyone — Whisper would only invent something).
 */
export function geminiVerbatimFrom(answer: unknown): string | null {
  const candidate = (answer as { candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] } }[] } | null)
    ?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const raw = parts
    .filter((part) => !part.thought)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { verbatim?: unknown };
    return typeof parsed.verbatim === "string" ? parsed.verbatim.replace(/\s+/g, " ").trim() : null;
  } catch {
    return null;
  }
}

export type GeminiTranscriptionRequest = {
  audio: Uint8Array;
  contentType: string;
  filename: string;
  /** The products' own Latin spellings, so a name comes back spelled as the product table spells it. */
  productNames: readonly string[];
  /** A short fixed label for the failure row, e.g. "crm_visit_comment". Never an id. */
  purpose: string;
  /**
   * The account asked next when this one fails. A failure Whisper then answers is recorded `failed_over`,
   * not `error` — but a refused key or a used-up account still pages him, because the stand-in hides it.
   */
  fallback?: AiCallProvider;
};

/** Transcribes one recording, or throws a `GeminiTranscriptionError`. An empty answer is `empty`. */
export async function transcribeWithGemini(request: GeminiTranscriptionRequest): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiTranscriptionError("not_configured", "GEMINI_API_KEY is not configured.");
  if (request.audio.byteLength > GEMINI_TRANSCRIPTION_MAX_BYTES) {
    throw new GeminiTranscriptionError("too_large", "The recording is larger than the speech service accepts.");
  }

  // The same repair Whisper's request gets (24 Nov 2026): a recording whose timestamps claim hours is read
  // as hours. Returns the original bytes whenever it is unsure.
  const audio = isWebmRecording(request.filename, request.contentType, request.audio)
    ? closeWebmTimelineGaps(request.audio).bytes
    : request.audio;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: geminiTranscriptionInstruction(request.productNames) },
          { inline_data: { mime_type: request.contentType, data: Buffer.from(audio).toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      // No sampling: sampling is what turns an unclear second into an invented sentence.
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { verbatim: { type: "STRING" }, tidy: { type: "STRING" } },
        required: ["verbatim", "tidy"],
      },
    },
  };

  const startedAt = Date.now();
  const fail = (code: GroqTranscriptionCode, status: number | null, detail: string) => {
    const rescued = Boolean(request.fallback) && code !== "empty";
    recordAiCall({
      component: "gemini_transcription",
      errorCode: code,
      latencyMs: Date.now() - startedAt,
      model: GEMINI_TRANSCRIPTION_MODEL,
      provider: "google",
      purpose: request.purpose,
      status: rescued ? "failed_over" : "error",
      ...(rescued ? { failedOverTo: request.fallback } : {}),
    });
    // No body, ever: a refused key's answer can quote the key.
    logError(`Gemini transcription failed: ${code}`, {
      labels: { event: "gemini_transcription_failed", context: request.purpose, status: status ?? null },
    });
    return new GeminiTranscriptionError(code, detail, status);
  };

  let response: Response;
  try {
    response = await fetch(GEMINI_TRANSCRIPTION_URL, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw fail(timedOut ? "timeout" : "failed", null, timedOut ? "The speech service timed out." : "The speech service could not be reached.");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw fail(geminiCodeForStatus(response.status, text), response.status, `The speech service refused the recording (${response.status}).`);
  }

  const verbatim = geminiVerbatimFrom(await response.json().catch(() => null));
  if (verbatim === null) throw fail("failed", response.status, "The speech service answered in a shape Phoenix cannot read.");
  // The subtitle credits and stuck loops are Whisper's habits, but a guard that costs nothing stays on.
  if (!verbatim || isHallucinatedTranscript(verbatim)) {
    throw fail("empty", response.status, "Nothing usable came back from the speech service.");
  }

  recordAiCall({
    component: "gemini_transcription",
    latencyMs: Date.now() - startedAt,
    model: GEMINI_TRANSCRIPTION_MODEL,
    provider: "google",
    purpose: request.purpose,
    status: "success",
  });
  return verbatim;
}
