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
 * 🔴 THE ONE PLACE THE DIALECT IS SET. The rep speaks Egyptian Arabic and the owner read the first
 * results back on 2026-09-25: "very, very, very weak in Arabic … it dictate in Khaliji." There is NO
 * dialect field to fix that with — `ar-EG`, `arz` and `egy` are each refused with HTTP 400 "unsupported
 * language" (probed against the live API that day; only `ar` is accepted), so do not go looking for one.
 *
 * What steers it is this string, because Whisper's `prompt` is not an instruction but text the model is
 * told came IMMEDIATELY BEFORE this audio — and a decoder continuing an Egyptian sentence keeps writing
 * Egyptian. So the sample below is a plain Egyptian visit note, carrying the words that mark the dialect
 * in writing rather than in sound: دلوقتي، شويه، اللي، مش، عشان، هيكتب، المره الجايه. Nothing here is an
 * instruction, because an instruction written here is transcribed into the comment rather than obeyed.
 *
 * THE SAMPLE COMES LAST, AFTER THE PRODUCT NAMES, AND THAT ORDER IS THE POINT. The closest preceding text
 * is the strongest influence, and dialect is what was wrong; ending on a comma-separated list instead
 * biases the answer towards writing a list. The product names still come first because they are the class
 * of word a general Arabic model has never heard and silently replaces with the nearest ordinary word.
 * The 224-token cap keeps the FINAL tokens of a prompt and drops the ones at the START — the tokens
 * furthest from the audio — so over the cap it is the product names, at the head, that would be lost, not
 * the sample. The order does NOT protect them; the only thing that does is keeping the whole prompt well
 * inside the cap, which it is (pinned by tests/phoenix-crm-voice-transcribe.test.ts), so both halves
 * survive at this size and the order is a pure dialect optimisation. If the vocabulary ever grows the
 * length is what has to be watched, not the ordering. Latin spellings stay out: seeding them makes the
 * model answer a wholly Arabic sentence in Latin script.
 *
 * 🔴 AND IT MUST NEVER READ LIKE A REAL VISIT THAT HAPPENED. On a quiet recording the decoder hands this
 * text straight back instead of transcribing (`stripPromptEcho` in `@/lib/ai/groq-transcription`), so
 * every claim in it is one that can surface in a comment as something a doctor supposedly said. It names
 * no doctor, no clinic, no area, no quantity and no order — nothing that could be read as a fact about
 * anybody. Keep it that way: a vivid, specific sample is a better steer and a worse lie.
 */
const EGYPTIAN_SAMPLE =
  "زيارة دلوقتي في العيادة وقعدت معاه شويه وكلمته عن المنتجات، وقال لي إنه هيكتب للأطفال، وإن اللي عنده لسه مش خلص. المره الجايه هعدي عليه تاني عشان الطلب.";

export const TRANSCRIPTION_PROMPT = `${PRODUCT_VOCABULARY.map((entry) => entry.arabic).join("، ")}. ${EGYPTIAN_SAMPLE}`;

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

  // His own note, recorded within the window, AND not already written out. Not "a note in my scope":
  // see the header — the window is a cost rule, and so is this. A recording is transcribed at most ONCE.
  //
  // 🔴 THE UPDATE IS THE CHECK. Selecting the slot and then calling Groq left the SAME path replayable
  // without limit inside its two-hour window — every resubmission a fresh paid call — which the window was
  // supposed to prevent. So the row is CLAIMED instead: the update sets `transcribed_at` only WHERE it is
  // still null, which is a single row lock, so two requests racing for one path cannot both bill Groq, and
  // a later resubmission of a path already written out is refused below with no call at all. Total
  // transcriptions are then bounded by the slot-issuance ceiling a rep already lives under (SLOTS_PER_HOUR
  // in `./voice-notes.ts`), because each slot buys exactly one.
  const since = new Date(Date.now() - TRANSCRIBE_WINDOW_MS).toISOString();
  const claim = await supabase
    .from("phoenix_crm_voice_uploads")
    .update({ transcribed_at: new Date().toISOString() })
    .eq("path", path)
    .eq("issued_to_hr_id", viewer.hrId)
    .gte("issued_at", since)
    .is("transcribed_at", null)
    .select("path")
    .maybeSingle();
  throwIfError(claim.error);
  if (!claim.data) {
    // No row was claimed. Tell "not his, or expired" apart from "already written out" only to word the
    // refusal — both end the same way, because the recording is saved and typing was always open.
    const existing = await supabase
      .from("phoenix_crm_voice_uploads")
      .select("path")
      .eq("path", path)
      .eq("issued_to_hr_id", viewer.hrId)
      .gte("issued_at", since)
      .maybeSingle();
    throwIfError(existing.error);
    if (existing.data) {
      throw new ApiError(409, "already_transcribed", "That recording was already written out. Type the comment instead.");
    }
    throw new ApiError(403, "forbidden", "That recording is not one you just made. Speak again, or type the comment.");
  }

  // From the claim on, any failure hands the one transcription BACK. A read-back miss or a transient
  // speech-service outage must not permanently burn a recording's single shot, so the claim is released
  // and the rep — or a retry — can ask again. Only a transcript that actually came back keeps it.
  try {
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
  } catch (error) {
    // Release the single-transcription claim taken above, so nothing here that failed before a transcript
    // came back leaves the recording permanently un-writable. This never runs on success — the return
    // inside the try exits without touching it.
    await supabase
      .from("phoenix_crm_voice_uploads")
      .update({ transcribed_at: null })
      .eq("path", path)
      .eq("issued_to_hr_id", viewer.hrId);
    throw error;
  }
}
