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
 * use it open AI or find a free way to use it in it." Groq serves both Whisper models on a free tier
 * and charges by the audio hour above it, and only the engine-less browsers ever reach this path — the
 * Chrome, Edge, Safari and Android majority keep using the browser's own free engine and never call here.
 * A minute is the recording cap, so a rep's whole day of notes is minutes of audio. **This file must
 * never be pointed at OpenAI**, however OpenAI-shaped the request below looks: the endpoint is
 * deliberately written out rather than taken from `AI_BASE_URL`, which the sales AI paths read until
 * 13 Nov 2026 (no path reads it now), because swapping THIS one to OpenAI would silently reverse the
 * owner's decision.
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
 *
 * AND IT REFUSES ITS OWN PROMPT BACK. On a quiet recording the decoder's most natural continuation of the
 * preceding text IS the preceding text, so it returns the prompt. `stripPromptEcho` takes those words out
 * before anything else looks at the answer — see its own comment for why that became mandatory the moment
 * the prompt started carrying a sample Egyptian sentence instead of a bare list of product names.
 */

import { recordAiCall } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";
import { foldArabicLetters } from "@/lib/phoenix-crm/dictation-correct";

/** Written out, never read from AI_BASE_URL — see the header. */
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * 🔴 THE FULL MODEL, NOT `whisper-large-v3-turbo`, AND THAT IS THE OWNER'S OWN FINDING — DO NOT PUT TURBO
 * BACK TO MAKE THIS FASTER OR CHEAPER.
 *
 * Turbo shipped here first, reasoning that its accuracy cost was small next to the gap between "some
 * Arabic text to correct" and "an empty comment". That reasoning held for the presence of text and was
 * wrong about the KIND of text. He recorded Egyptian Arabic on 2026-09-25 and read the result back:
 * "very, very, very weak in Arabic … it dictate in Khaliji." Turbo is the same weights with the decoder
 * distilled from 32 layers to 4, and a decoder is exactly where dialect lives — it is the half that
 * chooses which Arabic to spell the sounds as. Cutting it to an eighth costs little on English and costs
 * dialect first, so the distilled model falls back to the Arabic it saw most, which is not Egyptian.
 *
 * The full model is on the same free tier and served by the same key (verified against
 * `/openai/v1/models` on the production key, 2026-09-25: `whisper-large-v3`, active). It is slower —
 * seconds, not tens of seconds, on a recording capped at one minute — and dearer per audio hour above the
 * free tier, against a whole company's use measured in minutes of audio a day. A rep reads the words back
 * before he saves them, so speed buys nothing that being right does not buy more of.
 */
export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3";

/**
 * `ar`, NOT `ar-EG`. This is an ISO-639-1 language, not a BCP-47 locale, and a locale tag is rejected —
 * the same string `DICTATION_LANG` carries for the browser engine would fail here. Naming the language
 * stops it guessing Persian or Urdu from the first seconds and stops it silently translating to English,
 * which it does when the field is left off.
 *
 * It is the DEFAULT now rather than the only value: the CEO composer's mic names a language of its own
 * (`CEO_DICTATION_LANGUAGES`). What has not changed is that a language is always named — see the
 * `language` field on `GroqTranscriptionRequest` for why omitting it is not an option here.
 *
 * 🔴 IT IS NOT A DIALECT SELECTOR AND THERE IS NO SUCH FIELD — `ar-EG`, `arz` and `egy` are all refused,
 * so an Egyptian answer cannot be asked for here however the string is spelled. Trying is the obvious
 * first move when a rep reports Gulf Arabic back and it ends in a rejected request, not a better one.
 * Dialect is steered by the `prompt` instead — see `TRANSCRIPTION_PROMPT` in
 * `src/lib/phoenix-crm/server/voice-transcribe.ts` — because the prompt is read as text that came just
 * before this audio, and a decoder continuing an Egyptian sentence keeps writing Egyptian.
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

/**
 * The sentences of a prompt that are long enough to recognise if they come back.
 *
 * Four words is the floor because the prompt also carries a comma-separated list of product names, and a
 * rep really does say two or three product names in a row — removing a short run would delete his own
 * words. A whole four-word sentence of the prompt appearing verbatim in the answer is not that.
 */
function promptSentences(prompt: string): string[] {
  return prompt
    .split(/[.!?؟\n]+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.split(" ").filter(Boolean).length >= 4);
}

/**
 * A word reduced to what survives a re-transcription, so an answer word can be compared to a prompt word.
 *
 * The decoder rarely echoes the prompt to the character. It prints or drops the vowel marks (tashkeel),
 * flattens أ/إ/آ/ٱ to a bare ا, writes ة as ه and ى as ي, reaches for the Persian چ/ڤ/گ where Arabic has
 * no letter for the sound, and loses the comma a listed word was sitting against. None of that is a
 * different word, yet every one of it defeats an exact match — which is how an echo used to slip past.
 * Folding those differences away lets the comparison see the word, not its spelling on the day. The letter
 * folds ARE `foldArabicLetters` from `../phoenix-crm/dictation-correct` — the very function product matching
 * uses — so an echo can never be spelled in a way that matching folds but this does not, and a fold added
 * there reaches here with no second edit. Only the diacritic range and the edge-punctuation strip are this
 * guard's own: the decoder's tashkeel range is wider than a pasted word's, and a listed word arrives glued
 * to its comma.
 */
const ECHO_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ECHO_EDGE_PUNCT = /^[.,،؛:!?؟-]+|[.,،؛:!?؟-]+$/g;

function normalizeEchoWord(word: string): string {
  return foldArabicLetters(word.replace(ECHO_DIACRITICS, "").replace(ECHO_EDGE_PUNCT, ""));
}

/**
 * Remove any part of the prompt the decoder read back to us instead of transcribing.
 *
 * 🔴 THIS IS THE COST OF STEERING THE DIALECT AND IT IS NOT OPTIONAL. Whisper's `prompt` is text the model
 * believes came immediately before this audio, so on a quiet or unclear recording it does the most natural
 * thing available and simply CONTINUES it — or repeats it. That was survivable while the prompt was a bare
 * list of product names: an echo arrived looking like a list, which nobody would mistake for a comment.
 * Since the prompt carries a sample Egyptian visit sentence (which is what makes the answer Egyptian
 * rather than Gulf), an echo arrives looking exactly like a real visit note about a real doctor — a
 * fabricated clinical claim, in fluent Egyptian, in the one field managers read.
 *
 * So the same words are taken back out, and the match is on WORDS, not on an exact substring. An exact
 * match missed every echo the decoder reworded even slightly — a diacritic added, ة written as ه, a single
 * word swapped (هيكتب for بيكتب) — and left the fabricated sentence standing. Instead each prompt sentence
 * is compared word for word, after `normalizeEchoWord` folds spelling away, against every window of its own
 * length in the answer, and a window is dropped when it matches on all but a small share of its words. The
 * four-word floor (`promptSentences`) and the near-exact threshold keep this off a real comment — a rep's
 * own words do not coincidentally match all-but-one of a whole prompt sentence in order — while catching
 * the reworded echo a character diff let through. Whatever remains is judged on its own by
 * `isHallucinatedTranscript`.
 */
export function stripPromptEcho(text: string, prompt?: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!prompt) return collapsed;

  const words = collapsed.split(" ").filter(Boolean);
  for (const sentence of promptSentences(prompt)) {
    const sentenceWords = sentence.split(" ").filter(Boolean).map(normalizeEchoWord);
    const span = sentenceWords.length;
    if (span < 4) continue;
    // A fifth of a long sentence may differ (a stray word, a dropped one), but a four-word sentence still
    // allows one — a single substituted word is exactly the echo an exact match already lost.
    const allowed = Math.max(1, Math.floor(span / 5));
    for (let i = 0; i + span <= words.length; ) {
      let mismatches = 0;
      for (let j = 0; j < span && mismatches <= allowed; j++) {
        if (normalizeEchoWord(words[i + j]) !== sentenceWords[j]) mismatches++;
      }
      if (mismatches <= allowed) words.splice(i, span);
      else i++;
    }
  }

  // Punctuation the removed sentence was sitting inside would otherwise be all that is left. The LEADING
  // class strips a terminal . ! ? ؟ too, since a removed echo at the head can leave one dangling and a real
  // comment never opens on one; the TRAILING class does NOT, so a rep's own «...مهتم؟» or «...تمام.» keeps
  // its final mark. Echo removal is word-based — a terminal mark glued to the last echo word leaves with
  // that word — so there is no dangling trailing remnant to clean, only a real comment's ending to keep.
  return words.join(" ").replace(/^[\s.,،؛:!?؟-]+|[\s،؛:-]+$/g, "").trim();
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
   * Which language to decode as, as an ISO-639-1 code. Left off, it is `ar` — the CRM is this
   * module's original caller and the reason it exists.
   *
   * 🔴 A LANGUAGE IS ALWAYS NAMED, AND THERE IS DELIBERATELY NO WAY TO ASK FOR AUTO-DETECT. Leaving
   * the field off the request makes Whisper translate the speech into fluent ENGLISH, which reads as
   * a working feature — measured here on Egyptian Arabic, and the reason the CRM names `ar`. The CEO
   * composer may dictate in any of several languages (owner, 2026-10-06), and it does that by
   * NAMING the one he picked on the screen rather than by omitting this field: a named language is
   * also what stops the decoder guessing Persian or Urdu off the first seconds.
   *
   * It is NOT a dialect selector and there is no such field — `ar-EG`, `arz` and `egy` are all
   * refused. Dialect is steered by `prompt`.
   */
  language?: string;
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
  // 🔴 UNCONDITIONAL. A caller may choose WHICH language (the CEO composer's mic does), and no caller
  // can choose to send none: with the field off, Whisper translates the speech into English. `||`,
  // not `??`, so a blank or whitespace code falls back rather than reaching the API empty.
  const language = request.language?.trim() || GROQ_TRANSCRIPTION_LANGUAGE;
  form.set("language", language);
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
      provider: "groq",
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
  const answered = typeof parsed?.text === "string" ? parsed.text : "";
  // The prompt comes back out BEFORE the hallucination guard runs, in that order on purpose: an echoed
  // Egyptian sentence is fluent, unrepetitive and about a doctor, so the guard would pass it — and once it
  // has been taken out, whatever is left is judged on its own, including "nothing".
  const text = stripPromptEcho(answered, request.prompt);
  if (!text || isHallucinatedTranscript(text)) {
    // Counted as a failure on purpose. A silent note is ordinary and costs nothing, but a hallucination
    // reaching here means the guard above earned its place, and the row is the only way anyone sees it.
    throw fail("empty", response.status, "Nothing usable came back from the speech service.");
  }

  recordAiCall({
    component: "groq_transcription",
    latencyMs: Date.now() - startedAt,
    model: GROQ_TRANSCRIPTION_MODEL,
    provider: "groq",
    purpose: request.purpose,
    status: "success",
  });
  return text;
}
