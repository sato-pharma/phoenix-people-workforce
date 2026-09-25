/**
 * Phoenix CRM — ONE control for the spoken visit comment (owner, 2026-09-25).
 *
 * The form used to carry two buttons. `Dictate in Arabic` sent speech to Google or Apple and wrote
 * back text; `Record a voice note` kept the audio and transcribed it never. The owner asked for one:
 * "I want the only one option dictate and record in the same time. I speak once and this speaking
 * appears in the field as a text and saved as a record. Both." So the rep speaks once and BOTH happen.
 *
 * THE TWO HALVES ARE STILL TWO HALVES, and this module exists so that stays visible in the code as
 * well as on the screen. They run from one press off one microphone, but they are independent:
 *
 *   TEXT  — the browser's speech engine listens live and hands back words, which are appended to the
 *           comment as they settle. Nothing about the stored recording produces this text.
 *   AUDIO — `MediaRecorder` keeps what was said, and it is uploaded as a file. No speech service ever
 *           reads that file.
 *
 * So the text is NOT a transcription of the recording. It is a second, parallel reading of the same
 * speech, made live by an engine that can mishear Egyptian Arabic — which is exactly why the accuracy
 * line below tells the rep which of the two is the truth when they disagree. Describing the text as
 * "the transcript of the note" would be false, and it is the one thing this feature must never say.
 *
 * A BROWSER MAY HAVE ONLY ONE HALF. Firefox has `MediaRecorder` and no speech engine at all, so it
 * records and writes nothing; a browser with a speech engine and no recorder writes and keeps nothing.
 * Every sentence the control shows is chosen from the halves that actually work, because a promise of
 * "both" under a button that can only do one of them is the kind of copy a rep discovers at a clinic
 * door. The lines live here, as pure functions, so they are pinned by tests rather than by reading.
 */

import { isDictationSupported } from "@/lib/phoenix-crm/dictation";
import { formatSeconds, isRecordingSupported, MAX_SECONDS } from "@/lib/phoenix-crm/voice-recorder";

/** What the one control can actually do in the browser it is running in. */
export type SpeakHalves = { text: boolean; audio: boolean };

export const SPEAK_LABEL = "Speak the comment";
export const SPEAK_AGAIN_LABEL = "Speak again";

/** Live capability. Both are false on the server, so the control never renders and then vanishes. */
export function speakHalves(): SpeakHalves {
  return { text: isDictationSupported(), audio: isRecordingSupported() };
}

/**
 * Whether to render anything at all. With neither half the button could do nothing, and an inert
 * control reads as a bug — the comment can always be typed.
 */
export function speakSupported(halves: SpeakHalves): boolean {
  return halves.text || halves.audio;
}

/** What pressing the button will actually do, said in terms of the halves this browser has. */
export function speakPromise(halves: SpeakHalves): string {
  if (halves.text && halves.audio) {
    return "Speak once: the words are written into the comment as you talk, and the recording is kept with the visit.";
  }
  if (halves.audio) {
    return "Speak once and the recording is kept with the visit. This browser cannot turn speech into text, so type the comment as well.";
  }
  return "Speak once and the words are written into the comment as you talk. This browser cannot keep a recording.";
}

/**
 * Which of the two to believe when they disagree, said only where both halves ran.
 *
 * The engine mishears, and a misheard brand name in a clinical note is a sale that never happened.
 * The recording cannot mishear anything, so it is the record and the text is the reading of it.
 */
export function speakAccuracyLine(halves: SpeakHalves): string | null {
  if (!(halves.text && halves.audio)) return null;
  return "The text is what the speech service heard, so read it before you save — the recording is what you actually said.";
}

/**
 * Where the voice goes. The owner ruled on 2026-09-25 that this belongs on the control and NOT on a
 * privacy page — "add the processor line to the dictation mic, not the privacy page" — because the rep
 * reads it at the moment he decides to speak. Do not move it, and do not add a second copy elsewhere.
 *
 * Nothing leaves the phone for a third party when only the recorder runs, so the line is not shown
 * then: the recording goes to Phoenix's own storage and to nobody else.
 */
export function speakProcessorLine(halves: SpeakHalves): string | null {
  if (!halves.text) return null;
  const kept = halves.audio ? " The recording itself is stored by Phoenix, and no speech service ever reads it." : "";
  return `Your voice is sent to the browser's speech service — Google's on Chrome, Apple's on Safari — to be turned into text.${kept}`;
}

/** The heading on the live panel while the microphone is open. */
export function speakLiveLabel(halves: SpeakHalves, elapsed: number): string {
  const clock = `${formatSeconds(elapsed)} of ${formatSeconds(MAX_SECONDS)}`;
  if (halves.text && halves.audio) return `Listening — ${clock}`;
  if (halves.audio) return `Recording — ${clock}`;
  return "Listening — speak now";
}

/** What the live panel says is happening to the speech, under the clock. */
export function speakLiveHint(halves: SpeakHalves): string {
  if (halves.text && halves.audio) return "Writing the words and keeping the recording.";
  if (halves.audio) return "Keeping the recording. The words are not being written.";
  return "Writing the words. Nothing is being recorded.";
}

/**
 * The warning shown once a recording already exists.
 *
 * Speaking again appends to the text and REPLACES the recording, because a visit holds one note. That
 * asymmetry is real and the rep is told it rather than left to find it: he keeps every word he has
 * said, and the audio beside it is the last stretch only.
 */
export function speakAgainLine(halves: SpeakHalves): string | null {
  if (!halves.audio) return null;
  return "Speaking again keeps the words you already have and replaces the recording.";
}

/**
 * What to say when the press opened nothing.
 *
 * Both halves need the same permission, so in practice they fail together and the cause is the
 * microphone. The sentence names where to unblock it, because a rep cannot act on "permission denied",
 * and it names typing as the way out, because the comment was never required to be spoken.
 */
export function speakBlockedMessage(): string {
  return "The microphone is blocked for Phoenix. Allow it for this site in the phone's settings, or type the comment instead.";
}

/**
 * What to say when one half opened and the other did not, which is the case that would otherwise pass
 * silently: the rep sees the panel, assumes both, and saves a visit missing the half he wanted.
 */
export function speakPartialMessage(started: SpeakHalves): string | null {
  if (started.text && started.audio) return null;
  if (started.audio) return "The words are not being written — the speech service did not start. The recording is still being kept.";
  if (started.text) return "The recording did not start. The words are still being written into the comment.";
  return null;
}
