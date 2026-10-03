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
 *   TEXT  — words end up in the comment. HOW they get there depends on the browser; see below.
 *   AUDIO — `MediaRecorder` keeps what was said, and it is uploaded as a file.
 *
 * THE TEXT HALF HAS TWO ENGINES, AND THEY ARE NOT INTERCHANGEABLE — this is the distinction every
 * sentence below turns on, and the one a later edit will be tempted to flatten.
 *
 *   "live"   — the browser's own speech engine (Chrome, Edge, Safari, Android) listens and hands back
 *              words as they settle, free, with no account. The text is a SECOND, PARALLEL reading of
 *              the same speech, made live by an engine that can mishear Egyptian Arabic. It is NOT a
 *              transcription of the stored recording, and no speech service ever reads that file.
 *              Describing the text as "the transcript of the note" would be false here.
 *   "server" — the browser has NO speech engine at all. Firefox has none, on any platform: there is no
 *              constructor to call, so nothing can be written while he talks. Here the finished
 *              RECORDING is sent from Phoenix's own server to a speech service and what comes back is
 *              the text — so here the text IS a transcript of the recording, which is the exact
 *              opposite of the "live" case. Both statements are true because they describe different
 *              mechanisms. Never unify them, and never let one engine's sentence be shown for the other.
 *   "none"   — nothing can produce text (no engine, and no recording to send).
 *
 * 🔴 A BROWSER THAT *HAS* AN ENGINE IS NOT A BROWSER THAT CAN WRITE ARABIC, and reading the first as the
 * second is the bug the owner hit within the hour ("DIDNT WROITE", 2026-09-25). Firefox 157 ships a
 * constructor backed by NVIDIA's Parakeet, which has no Arabic at all: the engine is detected, it starts,
 * and `ar-EG` fails asynchronously with `language-not-supported` — by which time the engine choice above
 * has already ruled the recording out of being written. So the engine names below are only what the
 * control PROMISES at the moment of the press; what is actually done afterwards is decided by
 * `shouldWriteFromRecording`, from what the live engine really produced. Never re-derive that from
 * capability again.
 *
 * A BROWSER MAY HAVE ONLY ONE HALF. Every sentence the control shows is chosen from the halves that
 * actually work and from the engine it actually has, because a promise of "both" under a button that can
 * only do one of them — or a promise of words "as you talk" where they arrive after he stops — is the
 * kind of copy a rep discovers at a clinic door. The lines live here, as pure functions, so they are
 * pinned by tests rather than by reading.
 */

import { BROWSER_PLACEHOLDER } from "@/lib/phoenix-crm/browser-name";
import { isDictationSupported } from "@/lib/phoenix-crm/dictation";
import { formatSeconds, isRecordingSupported, MAX_SECONDS } from "@/lib/phoenix-crm/voice-recorder";

/** How the words get into the comment in this browser. See the header — these are not interchangeable. */
export type SpeakTextEngine = "live" | "server" | "none";

/** What the one control can actually do in the browser it is running in. */
export type SpeakHalves = { text: SpeakTextEngine; audio: boolean };

export const SPEAK_LABEL = "Speak the comment";
export const SPEAK_AGAIN_LABEL = "Speak again";

/**
 * Live capability. Both halves are dead on the server, so the control never renders and then vanishes.
 *
 * `serverTranscription` is whether Phoenix's own transcription path is configured — the screen asks the
 * server, because a browser cannot see whether the key exists and a button must not promise words that
 * nothing can write. The server engine also requires the RECORDER: it transcribes the stored recording,
 * so with nothing recording there is nothing to send.
 */
export function speakHalves(serverTranscription = false): SpeakHalves {
  const audio = isRecordingSupported();
  return { audio, text: speakTextEngine({ audio, live: isDictationSupported(), serverTranscription }) };
}

/**
 * Which engine writes the words, kept pure so every combination is pinned by a test rather than by
 * reading — the browser capabilities it decides from cannot be faked in the suite.
 *
 * Two rules, and both are load-bearing. The browser's OWN engine always wins where it exists: it is free,
 * it needs no account, it writes while he talks, and on Egyptian Arabic it is at least as good as a
 * general Whisper model. And the server engine requires the RECORDER, because what it transcribes IS the
 * recording — offering it without one promises a transcript of a file that will never exist.
 */
export function speakTextEngine(input: { audio: boolean; live: boolean; serverTranscription: boolean }): SpeakTextEngine {
  if (input.live) return "live";
  return input.serverTranscription && input.audio ? "server" : "none";
}

/**
 * Whether to write the words out of the stored recording once the microphone has closed.
 *
 * 🔴 THIS EXISTS BECAUSE `speakTextEngine` ALONE SHIPPED A HOLE, AND THE OWNER FOUND IT: "DIDNT WROITE"
 * (2026-09-25, on the day the server engine went live). A browser HAVING a speech engine is not the same
 * as that engine being able to write Egyptian Arabic, and the code treated them as one thing. Firefox 157
 * ships a constructor backed by NVIDIA's Parakeet, which has no Arabic: `isDictationSupported()` answers
 * true, the engine starts without complaint, `ar-EG` then fails ASYNCHRONOUSLY — and because the engine
 * was chosen as "live" before any of that, the finished recording was never sent anywhere. The rep got a
 * recording and an empty comment, which is exactly the state the whole feature was built to end.
 *
 * So the decision moved from "what does this browser HAVE" to WHAT ACTUALLY HAPPENED. One rule, checked
 * after the fact: there is a recording, the server path is configured, and the live engine wrote NOTHING.
 *
 * It subsumes the capability answer rather than sitting beside it — the "server" engine writes nothing
 * live by definition, so it satisfies this rule the same way a failed "live" engine does, and there is
 * one path to transcription instead of two. And it is the conservative direction: a live engine that
 * wrote even one phrase is believed and nothing is sent, so a working Chrome never pays for a second
 * reading and a rep who said nothing at all is never charged for silence (`wroteLive` false with no
 * stored path returns false).
 */
export function shouldWriteFromRecording(input: {
  storedPath: string | null;
  serverAvailable: boolean;
  wroteLive: boolean;
}): boolean {
  return Boolean(input.storedPath) && input.serverAvailable && !input.wroteLive;
}

/**
 * Whether to render anything at all. With neither half the button could do nothing, and an inert
 * control reads as a bug — the comment can always be typed.
 */
export function speakSupported(halves: SpeakHalves): boolean {
  return halves.text !== "none" || halves.audio;
}

/*
 * No sentence sits under the Speak button (owner, 2026-09-30 — "remove this irrelevant text"). The
 * promise ("Speak once: …"), the accuracy line ("The text is what the speech service heard …") and the
 * processor notice ("Your voice is sent to the browser's speech service …") were all removed from the
 * rep's form at his instruction, reversing his 2026-09-25 ruling that put the processor notice on the
 * microphone. Only what HAPPENS is said: the live panel, "Writing out the words", a half that did not
 * start, and an error. Do not put an explanation back under the button.
 */

/** The heading on the live panel while the microphone is open. */
export function speakLiveLabel(halves: SpeakHalves, elapsed: number): string {
  const clock = `${formatSeconds(elapsed)} of ${formatSeconds(MAX_SECONDS)}`;
  if (halves.text === "live" && halves.audio) return `Listening — ${clock}`;
  // The server engine is not listening to anything yet, so this is a recording and says so.
  if (halves.audio) return `Recording — ${clock}`;
  return "Listening — speak now";
}

/** What the live panel says is happening to the speech, under the clock. */
export function speakLiveHint(halves: SpeakHalves): string {
  if (halves.text === "live") return halves.audio ? "Writing the words and keeping the recording." : "Writing the words. Nothing is being recorded.";
  if (halves.text === "server") return "Keeping the recording. The words are written when you stop.";
  return "Keeping the recording. The words are not being written.";
}

/** While the finished recording is being written out, on the browsers that do it after the fact. */
export function speakTranscribingLine(): string {
  return "Writing out the words — this takes a few seconds. Do not leave the visit yet.";
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
  return `The microphone is blocked for ${BROWSER_PLACEHOLDER}. Allow it for this site in its settings, or type the comment instead.`;
}

/**
 * What to say when one half opened and the other did not, which is the case that would otherwise pass
 * silently: the rep sees the panel, assumes both, and saves a visit missing the half he wanted.
 *
 * The server engine is not a half that can "open" — it runs after the recording exists — so a running
 * recorder on that browser is everything that was ever going to run, and there is nothing to report.
 */
export function speakPartialMessage(started: SpeakHalves): string | null {
  if (started.text === "live" && started.audio) return null;
  if (started.text === "server" && started.audio) return null;
  if (started.audio) return "The words are not being written — the speech service did not start. The recording is still being kept.";
  if (started.text === "live") return "The recording did not start. The words are still being written into the comment.";
  return null;
}
