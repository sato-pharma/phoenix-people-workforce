import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { File, UploadType } from "expo-file-system";

import { ApiError, NetworkError } from "@/lib/api";
import { crmErrorMessage, crmGet, crmPost } from "@/lib/crm/client";

/**
 * Phoenix CRM — the spoken visit comment on the phone.
 *
 * The owner's instruction on 2026-09-25, first for the web and then for this app: one microphone that
 * does both halves — keep the recording AND write the words into the comment as Egyptian Arabic text.
 *
 * 🔴 THIS APP HAS NO SPEECH ENGINE AT ALL, AND THAT IS NOT A GAP TO CLOSE HERE. React Native has no Web
 * Speech API, and there is no free on-device Arabic recogniser to put in its place. So the app takes the
 * path the web already built for Firefox, which has the same problem: the finished RECORDING is written
 * out by Phoenix's own server (`/api/phoenix-crm/voice/transcribe`, Groq's Whisper on a free tier), and
 * the words arrive a few seconds after Stop. There is no "as you talk" here and the copy must never
 * promise one — a rep who was told the words appear while he speaks watches an empty box for a minute and
 * presses Stop thinking it failed. `src/lib/phoenix-crm/speak.ts` on the web calls this engine "server".
 *
 * IT ADDS NO SERVER SURFACE. The two routes it uses are the ones the browser uses, in the same order:
 * `voice/upload-slot` issues a one-time path and a signed URL, then `voice/transcribe` is asked for the
 * words BY PATH. Nothing new was written server-side for the phone.
 *
 * 🔴 AND IT PUTS THE BYTES STRAIGHT TO THE SLOT, which the photo half of this app could not do. The
 * comment in `src/lib/phoenix-crm/server/photos.ts` records why a stamped JPEG goes through the server
 * instead: this build had no `expo-file-system`, and `fetch` will not stream a `file://` body to a
 * third-party URL. `expo-file-system` is now a dependency (SDK 58's `File.upload`, `httpMethod: "PUT"`,
 * binary content), so the wall is gone for audio and this is the browser's own path. It is NOT a licence
 * to rewrite the photo upload — that route is live, proven and dates visits; changing it needs its own
 * task and its own verification.
 *
 * THE RECORDING IS THE RECORD, THE TEXT IS A READING OF IT. Groq mishears, and a misheard brand name in
 * a clinical note is a sale that never happened, so the text lands in the comment where the rep reads and
 * corrects it before saving — never straight into the saved visit without passing his eyes.
 *
 * NOTHING HERE CARRIES A TIME. A photo is taken where the camera is; a recording can be made in a car an
 * hour later and says nothing about when the visit happened. The slot answers no issue time (the header
 * of `voice-notes.ts`, rule 2), and no field here holds one.
 */

/**
 * The same 2 MB ceiling the browser recorder enforces (`VOICE_MAX_BYTES` in
 * src/lib/phoenix-crm/voice-recorder.ts) and the transcription service refuses above. Checked here so a
 * rep on a clinic's 3G learns the note is too long BEFORE spending the upload, not after.
 */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

/** The browser recorder's cap, so a note from either client is the same length of speech. */
export const VOICE_MAX_SECONDS = 60;

/** The container `RecordingPresets.HIGH_QUALITY` produces on both platforms, and one the slot accepts. */
export const VOICE_EXTENSION = ".m4a";

// Adding spoken words to a typed comment is `appendCrmDictated`, kept in its own pure module so the root
// Node test suite can import and run it (this file imports expo-audio/expo-file-system, which Node cannot
// resolve). Re-exported here so the app still imports everything about the voice comment from one place.
export { appendCrmDictated } from "./dictation";

/** The media type for that container, as `EXTENSIONS` in the server's voice-notes.ts maps it. */
const VOICE_CONTENT_TYPE = "audio/mp4";

type VoiceSlot = { path: string; signedUrl: string; token: string; contentType: string };

export type CrmMicAccess = { granted: boolean; canAskAgain: boolean };

/**
 * Ask for the microphone, and put the audio session into recording mode.
 *
 * Asked BEFORE the recorder starts, for the reason the photo path already settled for location: a system
 * dialog that lands after recording has begun eats the first seconds of what the rep said, and he cannot
 * tell that it did.
 *
 * `setAudioModeAsync({ allowsRecording: true })` is what lets iOS record at all, and is harmless on
 * Android. It is called every time rather than once at startup: the OS resets the session after an
 * interruption (a call, another app playing), and a mode set at app launch is gone by the time a rep opens
 * his tenth visit of the day.
 */
export async function prepareCrmMicrophone(): Promise<CrmMicAccess> {
  try {
    let permission = await getRecordingPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return { canAskAgain: permission.canAskAgain, granted: false };
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    return { canAskAgain: permission.canAskAgain, granted: true };
  } catch {
    return { canAskAgain: false, granted: false };
  }
}

/**
 * Why there is no recording, worded for the cause and naming the screen that fixes it.
 *
 * Split on `canAskAgain` because the two cases need different actions from the rep and neither one is
 * "try again": Android stops showing the dialog after two refusals, and telling a rep to choose Allow when
 * no dialog will ever appear again is how a person decides the feature is broken.
 */
export function describeMissingCrmMicrophone(access: CrmMicAccess): string {
  return access.canAskAgain
    ? "Speaking the comment needs the microphone, and it was not allowed. Choose Allow, then press the microphone again."
    : "Speaking the comment needs the microphone, and it is turned off for Phoenix. Turn it on in Android Settings, under Apps, then Phoenix Workforce, then Permissions — or type the comment instead.";
}

/** What the visit form keeps of a recording: the stored path and the two figures that describe it. */
export type CrmVoiceNote = { path: string; seconds: number; bytes: number };

export type CrmVoiceOutcome =
  /**
   * Stored. `text` is what the speech service made of it, empty when it could not or would not.
   * `transcriptionError` tells the two empty cases apart: null when the recording was genuinely silent,
   * and the sentence to show the rep when the speech service itself failed or could not be reached. The
   * recording is safe either way, so neither is a `failed` — but the screen must not blame silence for a
   * service that was down.
   */
  | { status: "stored"; note: CrmVoiceNote; text: string; transcriptionError: string | null }
  /** Nothing was stored. The recording is lost and the message says what to do. */
  | { status: "failed"; message: string }
  /** The server stopped accepting this session. The caller signs out. */
  | { status: "session-expired" };

/**
 * Upload one finished recording and ask for its words.
 *
 * THE ORDER IS THE DESIGN, not where the calls happened to land. The recording is stored FIRST and the
 * words are asked for second, so a speech service that refuses costs the rep the typing he would have
 * done anyway and can never cost him what he said. That is why a failed transcription returns
 * `status: "stored"` with an empty `text` — the note is safe, and the screen says so rather than
 * reporting a failure over a half that worked.
 */
export async function storeCrmVoiceNote(input: {
  uri: string;
  seconds: number;
  seatId: string;
  test: boolean;
  token: string | null;
}): Promise<CrmVoiceOutcome> {
  const { uri, seconds, seatId, test, token } = input;

  let file: File;
  let bytes: number;
  try {
    file = new File(uri);
    bytes = file.size ?? 0;
  } catch {
    return { message: "The recording could not be read from this phone. Record it again.", status: "failed" };
  }
  if (bytes === 0) return { message: "The recording came out empty. Record it again.", status: "failed" };
  if (bytes > VOICE_MAX_BYTES) {
    return { message: "The recording is larger than Phoenix accepts. Record a shorter note.", status: "failed" };
  }

  let slot: VoiceSlot;
  try {
    slot = await crmPost<VoiceSlot>("/api/phoenix-crm/voice/upload-slot", "slot", { extension: VOICE_EXTENSION, seatId, test }, token);
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return { status: "session-expired" };
    return { message: crmErrorMessage(error), status: "failed" };
  }

  try {
    const result = await file.upload(slot.signedUrl, {
      headers: { "x-upsert": "false" },
      httpMethod: "PUT",
      mimeType: slot.contentType || VOICE_CONTENT_TYPE,
      uploadType: UploadType.BINARY_CONTENT,
    });
    // A retry whose earlier answer was lost: the object already sits at the path. The browser client
    // treats the same 409 as success, and so does a save, which only needs the object to exist.
    const stored = result.status >= 200 && result.status < 300;
    if (!stored && result.status !== 409 && !/already exists|duplicate/i.test(result.body ?? "")) {
      return { message: "The recording did not upload. Record it again where the signal is better.", status: "failed" };
    }
  } catch (error) {
    if (error instanceof NetworkError) {
      return { message: "The recording did not reach Phoenix — the connection dropped. Record it again where the signal is better.", status: "failed" };
    }
    return { message: "The recording did not upload. Record it again.", status: "failed" };
  }

  const note: CrmVoiceNote = { bytes, path: slot.path, seconds };

  // From here the recording is SAFE, so every ending below keeps it. A refused transcription is not a
  // failed recording, and reporting it as one would teach the rep to record again for no reason.
  try {
    const text = await crmPost<string>("/api/phoenix-crm/voice/transcribe", "text", { path: slot.path }, token);
    return { note, status: "stored", text: typeof text === "string" ? text.trim() : "", transcriptionError: null };
  } catch (error) {
    if (error instanceof ApiError && error.isSessionExpired) return { status: "session-expired" };
    // The recording is saved; only the words failed. Carry the reason out instead of dropping it — the
    // route's own message already says whether nothing was made out or the service was unavailable, and
    // both end by naming typing as the way on. Reporting it as silence would send the rep to listen for
    // words that a downed service, not a quiet clinic, is why he never got.
    return { note, status: "stored", text: "", transcriptionError: crmErrorMessage(error) };
  }
}

/**
 * Whether the words can be written out at all, asked once when the screen opens.
 *
 * It answers one boolean and names neither the vendor nor the key. Asked OPTIMISTICALLY — a failed or
 * pending probe leaves the promise as it is — because the alternative is telling every rep "this phone
 * cannot turn speech into text" for as long as the request takes and then changing its mind in front of
 * him. Unlike the web there is no second engine to fall back to, so a definite `false` means the button
 * offers the recording only, and it says so.
 */
export async function crmVoiceTranscriptionAvailable(token: string | null): Promise<boolean> {
  try {
    // GET, not POST. The route's POST spends money at a third party and carries a save's refusals; its
    // GET is the free boolean, and asking the paid verb whether the paid verb works would cost a
    // transcription to find out. The envelope key is the route's own `transcription`.
    const answer = await crmGet<{ available: boolean }>("/api/phoenix-crm/voice/transcribe", "transcription", token);
    return answer?.available !== false;
  } catch {
    return true;
  }
}
