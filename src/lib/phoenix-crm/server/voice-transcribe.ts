/**
 * Phoenix CRM — turning a just-recorded voice note into text, for a browser with no speech engine.
 *
 * WHICH PROBLEM THIS SOLVES, AND WHICH IT DOES NOT. The visit form's one microphone runs two halves:
 * the browser's own speech engine writes words into the comment live, and `MediaRecorder` keeps the
 * audio. Chrome, Edge, Safari and Android have the engine and never reach this module. **Firefox has no
 * speech engine at all** — no constructor to call, on any platform — so a rep on Firefox got the
 * recording and an empty comment. The owner's instruction on 2026-09-25: "un browsers must be text and
 * audio." This is the text half for those browsers, and only for those browsers.
 *
 * SO HERE, AND ONLY HERE, THE TEXT *IS* A TRANSCRIPT OF THE RECORDING. That is the opposite of the rule
 * that governs the live half, where the engine's reading and the stored audio are two independent things
 * and calling one a transcript of the other is forbidden (`../dictation.ts`, `../speak.ts`). Both
 * statements are true because they describe different mechanisms, and the copy the rep reads says which
 * one he has — `speakProcessorLine` names Google or Apple for the live engine and names this path's
 * processor for this one. Do not "unify" the two descriptions.
 *
 * IT TRANSCRIBES BY PATH, NEVER BY UPLOAD. The recording is already in the private bucket by the time
 * this is called, so the phone sends the path it was given and the server fetches the object itself. A
 * rep on a clinic's edge-of-coverage 3G does not send two megabytes twice, the request is ordinary JSON
 * with no multipart on the client, and there is no second way for audio to enter the system.
 *
 * WHAT MAY BE TRANSCRIBED IS NARROWER THAN WHAT MAY BE PLAYED. `signVoicePaths` lets anyone who can read
 * a territory hear its notes. This lets a person transcribe only a note HE recorded, within two hours of
 * recording it. That is not a privacy rule — it is a cost and abuse rule. Playback is free and reading a
 * colleague's note is the point of the feature; transcription is paid per second of audio, so widening
 * this to "anything in my scope" would turn one request into a bill for every note a district ever
 * recorded. The two-hour window is the same one a slot itself lives inside, so an old path replayed from
 * a copied payload buys nothing.
 *
 * NOTHING HERE DATES ANYTHING, for the reason the whole voice module exists to keep structural: a
 * recording can be made in a car an hour later and says nothing about when a visit happened.
 */

import {
  groqTranscriptionMessage,
  GroqTranscriptionError,
  hasGroqApiKey,
  transcribeWithGroq,
} from "@/lib/ai/groq-transcription";
import { ApiError, validationError } from "@/lib/http/api-errors";
import { correctDictatedProducts } from "@/lib/phoenix-crm/dictation-correct";
import { PRODUCT_VOCABULARY } from "@/lib/phoenix-crm/dictation-vocabulary";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import {
  downloadVoiceNote,
  voiceContentType,
  voicePathTerritory,
} from "@/lib/phoenix-crm/server/voice-notes";
import { VOICE_MAX_BYTES } from "@/lib/phoenix-crm/voice-recorder";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The same two hours a voice slot is consumable within. Longer buys a replay, shorter breaks a retry. */
const TRANSCRIBE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * The domain words the decoder is biased towards, as preceding context.
 *
 * Whisper's `prompt` is NOT an instruction — it is text the model is told came just before this audio, so
 * anything imperative written here is transcribed into the answer rather than obeyed. It is therefore a
 * bare list of the ARABIC product spellings, which is exactly the class of word a general Arabic model
 * has never heard and substitutes the nearest real word for. Latin spellings are left out deliberately:
 * seeding them makes the model answer a wholly Arabic sentence in Latin script.
 *
 * The model caps this at 224 tokens and drops the rest silently, so it stays the canonical name of each
 * product and none of the field's misspellings — those are `correctDictatedProducts`'s job, after the
 * fact, where a wrong guess can be measured against a corpus instead of biasing a decoder invisibly.
 */
export const TRANSCRIPTION_PROMPT = `زيارة طبيب. ${PRODUCT_VOCABULARY.map((entry) => entry.arabic).join("، ")}.`;

export type VoiceTranscription = { text: string };

/**
 * Whether this browser's rep can be offered the server path at all. A route that answers "not set up"
 * costs a round trip and a sentence the rep cannot act on, so the screen is told once, up front.
 */
export function isVoiceTranscriptionConfigured(): boolean {
  return hasGroqApiKey();
}

export async function transcribeVoiceNote(viewer: PhoenixCrmViewer, raw: unknown): Promise<VoiceTranscription> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const path = String(body.path ?? "").trim();
  if (!path || !voicePathTerritory(path)) {
    throw validationError("That recording could not be found. Speak again, or type the comment.");
  }
  const contentType = voiceContentType(path);
  if (!contentType) throw validationError("That recording format is not one Phoenix accepts.");

  const supabase = getSupabaseAdmin();

  // His own note, recorded within the window. Not "a note in my scope": see the header — this is the
  // difference between one request and a bill for a district's whole history of recordings.
  const since = new Date(Date.now() - TRANSCRIBE_WINDOW_MS).toISOString();
  const slot = await supabase
    .from("phoenix_crm_voice_uploads")
    .select("path")
    .eq("path", path)
    .eq("issued_to_hr_id", viewer.hrId)
    .gte("issued_at", since)
    .maybeSingle();
  throwIfError(slot.error);
  if (!slot.data) {
    throw new ApiError(403, "forbidden", "That recording is not one you just made. Speak again, or type the comment.");
  }

  // The bucket is opened by its owner, `./voice-notes.ts`, and only there — one file per bucket, pinned by
  // tests/phoenix-crm-boundary.test.ts. The ownership proof above is what earns this call; the helper
  // itself checks nothing, so it must never be moved above that check.
  const audio = await downloadVoiceNote(path);
  if (!audio) {
    throw new ApiError(404, "not_found", "The recording could not be read back. Type the comment instead.");
  }
  if (audio.byteLength === 0 || audio.byteLength > VOICE_MAX_BYTES) {
    throw validationError("That recording cannot be turned into text. Type the comment instead.");
  }

  let spoken: string;
  try {
    spoken = await transcribeWithGroq({
      audio,
      contentType,
      // The speech service reads the container from the part's filename, and the stored path's own name is
      // a UUID with the right extension — so no name is invented, and nothing about the rep, his
      // territory or the visit travels in it.
      filename: path.slice(path.lastIndexOf("/") + 1),
      prompt: TRANSCRIPTION_PROMPT,
      purpose: "crm_visit_comment",
    });
  } catch (cause) {
    // Never a 500 and never the vendor's wording: every one of these is a sentence the rep can act on,
    // and all of them end the same way, because the recording is already saved and typing was never shut.
    const status = cause instanceof GroqTranscriptionError && cause.code === "rate_limited" ? 429 : 502;
    throw new ApiError(status, "transcription_failed", groqTranscriptionMessage(cause));
  }

  // The same corrector the live engine's output goes through, for the same reason: a general Arabic model
  // has never heard "تيبوفورتين" and returns the nearest ordinary word, and the product name is the only
  // part of a visit comment anyone reads it for.
  return { text: correctDictatedProducts(spoken).text };
}
