import { GroqTranscriptionError, hasGroqApiKey, transcribeWithGroq } from "@/lib/ai/groq-transcription";

import {
  CEO_DICTATION_MAX_BYTES,
  CEO_DICTATION_MAX_SECONDS,
  dictationExtension,
  normalizeCeoDictationLanguage,
} from "./dictation-limits";

// Re-exported so the route and the server half have one import, while the client component reads
// them from ./dictation-limits directly and never pulls the speech client into the browser bundle.
export { CEO_DICTATION_MAX_BYTES, CEO_DICTATION_MAX_SECONDS, dictationExtension, normalizeCeoDictationLanguage };

/**
 * The microphone on the CEO composer's instruction box.
 *
 * Owner 2026-10-06: he may "type what he wants any language or even open the mic".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 IT DOES NOT USE THE BROWSER'S OWN SPEECH ENGINE, AND THAT IS THE WHOLE DESIGN DECISION.
 *
 * Phoenix CRM dictates through the browser (`phoenix-crm/dictation.ts`) because it is free and does
 * Egyptian Arabic well. It does that by being TOLD the language: `SpeechRecognition.lang` is
 * required, the CRM sets `ar-EG`, and a sentence in any other language decodes as mangled Arabic.
 * There is no "detect it" value in that API at all, and Firefox has no engine to ask — so the
 * browser path would need a language control AND would still leave a browser out.
 *
 * 🔴 AND THE SERVER PATH DOES NOT GET TO SKIP THE QUESTION EITHER. The obvious design — send no
 * `language` and let Whisper detect it — was built first and then abandoned on this repo's own
 * measurement: with the field left off, Whisper TRANSLATES the speech into fluent English (recorded
 * against Egyptian Arabic; it is why `groq-transcription.ts` hardcoded `ar` for the CRM). A letter he
 * dictated in Arabic arriving as an English instruction is the worst outcome available here, because
 * nothing on screen would look wrong. So the language is NAMED, and the screen names it: a one-tap
 * control beside the microphone, `CEO_DICTATION_LANGUAGES`, opening on Arabic.
 *
 * Auto-detect is not off the table for ever — it is off the table until somebody measures it against
 * a real clip with the production key, which cannot be done from a laptop that has no speech key.
 *
 * 🔴 IT IS DICTATION, NOT A RECORDING. Nothing here stores audio: the bytes arrive, are transcribed
 * and are dropped. There is no bucket, no row, no path and nothing to retain — unlike the CRM's
 * voice note, which is a stored artefact with its own columns. Do not describe either as the other.
 *
 * WHERE THE AUDIO GOES. Groq, a third party, for the same reason the CRM's fallback path does: the
 * owner's cost constraint of 2026-09-25, "I don't want it to use it open AI or find a free way to
 * use it in it". The words he dictates here are a draft of a letter he is about to send to his own
 * company, not clinical data — and the finished letter leaves through Resend regardless.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

export function isCeoDictationConfigured(): boolean {
  return hasGroqApiKey();
}

export type CeoDictationResult = { text: string } | { problem: string };

/**
 * Turns one recording into words, or says why it could not.
 *
 * It never throws for a speech failure: the box is a TEXT box with a microphone beside it, so every
 * failure has the same recovery — type it — and the sentence it hands back says so. An exception
 * here would put a 500 on a screen where nothing is actually broken.
 *
 * 🔴 NO `prompt` IS SENT. The CRM steers Whisper's dialect with one, and pays for it with
 * `stripPromptEcho`: on a quiet recording the decoder's most natural continuation of the preceding
 * text IS the preceding text, so it reads the prompt back as if it had been spoken. There is nothing
 * to steer here — he is briefing an assistant, not writing a clinical note in one dialect — so
 * sending no prompt removes that whole failure mode rather than defending against it.
 */
export async function transcribeCeoDictation(input: {
  audio: Uint8Array;
  contentType: string;
  /** An ISO-639-1 code the screen picked. Read, never trusted — see `normalizeCeoDictationLanguage`. */
  language?: unknown;
}): Promise<CeoDictationResult> {
  if (!isCeoDictationConfigured()) {
    return { problem: "Turning speech into words is not set up on this server yet. Type it instead." };
  }

  const extension = dictationExtension(input.contentType);
  if (!extension) {
    return { problem: "That recording is in a format the speech service does not read. Type it instead." };
  }
  if (input.audio.byteLength > CEO_DICTATION_MAX_BYTES) {
    return { problem: "That recording is too long to turn into words. Record a shorter one, or type it instead." };
  }

  try {
    const text = await transcribeWithGroq({
      audio: input.audio,
      contentType: input.contentType,
      filename: `dictation${extension}`,
      // 🔴 ALWAYS A REAL CODE. An unknown one from the browser becomes Arabic rather than reaching
      // the API, where it would be refused and lose a three-minute dictation. See the header.
      language: normalizeCeoDictationLanguage(input.language),
      purpose: "ceo_email_dictation",
    });
    return { text };
  } catch (error) {
    // 🔴 THIS SCREEN'S OWN WORDING, NOT `groqTranscriptionMessage`. That function is the CRM's and
    // every one of its sentences ends "the recording was still saved" — true there, where the audio
    // is already in a bucket, and a lie here, where nothing is stored at all. A refusal that tells
    // him his words were kept when they were not is worse than no refusal.
    return { problem: dictationProblem(error) };
  }
}

function dictationProblem(error: unknown): string {
  const code = error instanceof GroqTranscriptionError ? error.code : "failed";
  switch (code) {
    case "not_configured":
      return "Turning speech into words is not set up on this server yet. Type it instead.";
    case "rate_limited":
      return "The speech service is busy. Wait a moment and speak again, or type it instead.";
    case "quota_exceeded":
    case "auth_failed":
      return "The speech service is unavailable. Type it instead.";
    case "timeout":
      return "The speech service did not answer in time. Say it again, or type it instead.";
    case "empty":
      return "Nothing could be made out in that recording. Say it again, or type it instead.";
    case "too_large":
      return "That recording is too long to turn into words. Record a shorter one, or type it instead.";
    default:
      return "The words could not be written. Say it again, or type it instead.";
  }
}
