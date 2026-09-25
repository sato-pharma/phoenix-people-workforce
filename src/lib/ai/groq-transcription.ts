/**
 * Speech to text for a browser that has no speech engine of its own.
 *
 * WHY THIS EXISTS AT ALL. The Web Speech API is free, runs in the browser, and does Egyptian Arabic
 * well — and Firefox does not have it. Not disabled, not behind a flag a rep could turn on: there is no
 * `SpeechRecognition` constructor in Firefox on any platform, so `startDictation` returns null and a rep
 * on Firefox got a recording and an empty comment. Firefox 157 (2026-09-29) adds an on-device engine and
 * does NOT close this: Mozilla's implementation uses NVIDIA's Parakeet, whose language list is European
 * plus Vietnamese and Japanese, so `ar-EG` answers `language-not-supported`. Waiting for Firefox is not a
 * plan, and the owner's instruction on 2026-09-25 was "un browsers must be text and audio".
 *
 * WHY GROQ AND NOT OPENAI. The owner's cost constraint the same day, in his words: "I don't want it to
 * use it open AI or find a free way to use it in it." Groq serves `whisper-large-v3-turbo` on a free tier
 * and charges by the audio hour above it, and only the engine-less browsers ever reach this path — the
 * Chrome, Edge, Safari and Android majority keep using the browser's own free engine and never call here.
 * A minute is the recording cap, so a rep's whole day of notes is minutes of audio. **This file must
 * never be pointed at OpenAI**, however OpenAI-shaped the request below looks: the endpoint is
 * deliberately written out rather than taken from `AI_BASE_URL`, which the sales AI paths use to swap
 * providers, because swapping THIS one to OpenAI would silently reverse the owner's decision.
 *
 * WHY IT IS A RAW FETCH. The `openai` SDK is installed and would send this request, and using it here
 * would put the OpenAI client in the call stack of a feature that must not use OpenAI — one env var away
 * from billing him for it. Multipart with three fields does not need an SDK.
 *
 * WHAT IT REFUSES TO RETURN. Whisper does not fail loudly on silence or noise; it emits fluent text that
 * was never said. On Arabic the canned outputs are recognisable — a subtitle credit, a "subscribe to the
 * channel" line — and a stuck decoder repeats one phrase to the end of its budget. Either one lands in a
 * clinical note as something a doctor supposedly said, so `isHallucinatedTranscript` drops the whole
 * answer rather than hand back a sentence nobody spoke. Dropping it costs the rep the typing he would
 * have done anyway; keeping it puts a fabricated claim in a record no one knows to doubt.
 */

import { recordAiCall } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";

/** Written out, never read from AI_BASE_URL — see the header. */
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * The turbo model, not `whisper-large-v3`. Same weights distilled to 4 decoder layers: several times
 * faster and a fraction of the price per audio hour, for a small accuracy cost that is far below the gap
 * between "some Arabic text to correct" and "an empty comment", which is the real comparison here.
 */
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

/**
 * `ar`, NOT `ar-EG`. This is an ISO-639-1 language, not a BCP-47 locale, and a locale tag is rejected —
 * the same string `DICTATION_LANG` carries for the browser engine would fail here. Whisper has no
 * dialect selector; naming the language stops it guessing Persian or Urdu from the first seconds and
 * stops it silently translating to English, which it does when the field is left off.
 */
export const GROQ_TRANSCRIPTION_LANGUAGE = "ar";

/**
 * A minute of audio transcribes in a few seconds, but the rep is standing at a clinic door on a phone
 * network and the request carries the file. Long enough that a slow upload is not read as a failure,
 * short enough that he is not left watching a spinner with a visit still to save.
 */
const TIMEOUT_MS = 45_000;

/** `temperature` 0: no sampling. Sampling is what turns an unclear second into an invented sentence. */
const TEMPERATURE = "0";

export type GroqTranscriptionCode =
  | "auth_failed"
  | "empty"
  | "failed"
  | "not_configured"
  | "quota_exceeded"
  | "rate_limited"
  | "timeout"
  | "too_large";

export class GroqTranscriptionError extends Error {
  readonly code: GroqTranscriptionCode;
  readonly status: number | null;

  constructor(code: GroqTranscriptionCode, message: string, status: number | null = null) {
    super(message);
    this.name = "GroqTranscriptionError";
    this.code = code;
    this.status = status;
  }
}

export function hasGroqApiKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

/**
 * Canned Whisper output. Every one of these is a phrase the model emits over silence, music or noise
 * because its training data is full of subtitled video — none of them is anything a rep says on a call.
 * Matched as substrings against the whole answer: a hallucinated credit line arrives alone.
 */
const HALLUCINATION_MARKERS = [
  "اشترك في القناة",
  "ترجمة نانسي قنقر",
  "الترجمة والتعليق",
  "شكرا للمشاهدة",
  "شكراً للمشاهدة",
  "أراكم في الحلقة القادمة",
  "subtitles by",
  "amara.org",
  "thanks for watching",
  "subscribe to",
];

/**
 * Whether the answer is the decoder talking to itself rather than a transcript.
 *
 * Two independent shapes, because they fail differently. A MARKER is a phrase from subtitled video and
 * arrives whole. A LOOP is a decoder that got stuck: one short phrase repeated past any point a person
 * would repeat it. The loop threshold is deliberately high — Egyptian Arabic really does repeat a word
 * for emphasis, and a rep listing the same product to three doctors says its name three times.
 */
export function isHallucinatedTranscript(text: string): boolean {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return true;

  const lower = collapsed.toLowerCase();
  if (HALLUCINATION_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return true;

  const words = collapsed.split(" ").filter(Boolean);
  if (words.length < 8) return false;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const commonest = Math.max(...counts.values());
  // Two thirds of a sentence being one word is not emphasis, it is a stuck decoder.
  return commonest >= 8 && commonest / words.length >= 0.66;
}

function messageFor(code: GroqTranscriptionCode): string {
  if (code === "not_configured") {
    return "Turning speech into text is not set up on this browser yet. Type the comment instead.";
  }
  if (code === "rate_limited") {
    return "The speech service is busy. Wait a moment and speak again, or type the comment instead.";
  }
  if (code === "quota_exceeded" || code === "auth_failed") {
    return "The speech service is unavailable. Type the comment instead — the recording was still saved.";
  }
  if (code === "timeout") {
    return "The speech service did not answer in time. Type the comment instead — the recording was still saved.";
  }
  if (code === "empty") {
    return "Nothing could be made out in the recording. Type the comment instead — the recording was still saved.";
  }
  if (code === "too_large") {
    return "That recording is too long to turn into text. Type the comment instead — the recording was still saved.";
  }
  return "The words could not be written. Type the comment instead — the recording was still saved.";
}

/** The refusal a rep reads. Never the vendor's own wording, which names a model and an HTTP code. */
export function groqTranscriptionMessage(error: unknown): string {
  return error instanceof GroqTranscriptionError ? messageFor(error.code) : messageFor("failed");
}

/** Groq answers 429 for both a per-minute limit and an exhausted free tier; only the body says which. */
function codeForStatus(status: number, body: string): GroqTranscriptionCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 413) return "too_large";
  if (status !== 429) return "failed";
  return /quota|credit|billing|insufficient/i.test(body) ? "quota_exceeded" : "rate_limited";
}

/** The largest audio this will send. The CRM's own cap is far below it; this is the backstop. */
export const GROQ_TRANSCRIPTION_MAX_BYTES = 8 * 1024 * 1024;

export type GroqTranscriptionRequest = {
  audio: Uint8Array;
  /** A filename with a real extension: the multipart part's name is how the API reads the container. */
  filename: string;
  contentType: string;
  /**
   * Domain words to bias the decoder towards, as a plain phrase. Whisper takes this as preceding
   * context, not as a command — it cannot be instructed, and an instruction written here is transcribed
   * into the answer. Capped by the model at 224 tokens; anything past that is silently dropped.
   */
  prompt?: string;
  /** A short fixed label for the failure row, e.g. "crm_visit_comment". Never an id. */
  purpose: string;
};

/**
 * Transcribes one recording, or throws. The caller decides what a failure means to the person waiting:
 * here it is never fatal, because the audio is already stored and typing was always open.
 */
export async function transcribeWithGroq(request: GroqTranscriptionRequest): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new GroqTranscriptionError("not_configured", "GROQ_API_KEY is not configured.");
  if (request.audio.byteLength > GROQ_TRANSCRIPTION_MAX_BYTES) {
    throw new GroqTranscriptionError("too_large", "The recording is larger than the speech service accepts.");
  }

  const form = new FormData();
  form.set("file", new Blob([request.audio as unknown as BlobPart], { type: request.contentType }), request.filename);
  form.set("model", GROQ_TRANSCRIPTION_MODEL);
  form.set("language", GROQ_TRANSCRIPTION_LANGUAGE);
  form.set("temperature", TEMPERATURE);
  form.set("response_format", "json");
  if (request.prompt) form.set("prompt", request.prompt);

  const startedAt = Date.now();
  const fail = (code: GroqTranscriptionCode, status: number | null, detail: string) => {
    recordAiCall({
      component: "groq_transcription",
      errorCode: code,
      latencyMs: Date.now() - startedAt,
      model: GROQ_TRANSCRIPTION_MODEL,
      purpose: request.purpose,
      status: "error",
    });
    // No body, ever: on a 401 an OpenAI-shaped API echoes a fragment of the key back in its message.
    logError(`Groq transcription failed: ${code}`, {
      labels: { event: "groq_transcription_failed", context: request.purpose, status: status ?? null },
    });
    return new GroqTranscriptionError(code, detail, status);
  };

  let response: Response;
  try {
    response = await fetch(GROQ_TRANSCRIPTION_URL, {
      body: form,
      // No content-type header: fetch writes the multipart boundary itself, and setting one by hand
      // omits the boundary and the API reads an empty form.
      headers: { authorization: `Bearer ${apiKey}` },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    throw fail(timedOut ? "timeout" : "failed", null, timedOut ? "The speech service timed out." : "The speech service could not be reached.");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw fail(codeForStatus(response.status, body), response.status, `The speech service refused the recording (${response.status}).`);
  }

  const parsed = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof parsed?.text === "string" ? parsed.text.replace(/\s+/g, " ").trim() : "";
  if (!text || isHallucinatedTranscript(text)) {
    // Counted as a failure on purpose. A silent note is ordinary and costs nothing, but a hallucination
    // reaching here means the guard above earned its place, and the row is the only way anyone sees it.
    throw fail("empty", response.status, "Nothing usable came back from the speech service.");
  }

  recordAiCall({
    component: "groq_transcription",
    latencyMs: Date.now() - startedAt,
    model: GROQ_TRANSCRIPTION_MODEL,
    purpose: request.purpose,
    status: "success",
  });
  return text;
}
