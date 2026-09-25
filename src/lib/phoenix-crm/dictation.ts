/**
 * Phoenix CRM — Egyptian Arabic dictation for the visit comment.
 *
 * Typing Arabic on a phone keyboard, standing at a clinic door, is the slowest part of entering a
 * visit. The browser's own speech engine does Egyptian Arabic server-side at no cost, with no account
 * and no dependency: Chrome on Android and Safari on iOS 14.1 and later have it, Firefox has none at
 * all. That is the only kind of solution available here.
 *
 * This DICTATES. Speech becomes text in the comment field, and what saves is ordinary text in the
 * `comment` column that every screen and every report already reads. This module records nothing and
 * stores no audio. The RECORDING is a separate feature with its own storage and its own columns
 * (`./voice-recorder.ts`), and since 2026-09-25 the two run from ONE button on the form
 * (`./speak.ts`): the rep speaks once and both happen. They are still two mechanisms, and the text
 * this module produces is the engine's LIVE reading of the speech — never a transcript of the stored
 * recording, which no speech service ever reads. Do not describe either half as the other.
 *
 * Recognition is NOT on the phone. Chrome sends the audio to Google's speech service and Safari to
 * Apple's, which is how the engine costs nothing — so a rep's spoken comment, which carries doctor
 * names and what was said about competitors, leaves the device to a third party. That was put to the
 * owner on 2026-09-25 and he ruled it acceptable — keep it. There is no on-device Arabic engine, free
 * or paid, to fall back to, so reopening this only removes the feature.
 *
 * Whether the REP is told is SETTLED, and settled the other way from how FTP Portal does it. FTP says
 * so on a privacy page; Phoenix says it on the microphone. Offered both on 2026-09-25, the owner chose
 * the control — "add the processor line to the dictation mic, not the privacy page" — so the line
 * lives under the button, where the rep reads it at the moment he decides to speak. It is written by
 * `speakProcessorLine` in `./speak.ts` and rendered by `src/components/phoenix-crm/speak.tsx`, which
 * is now the one control for both halves. `app/privacy` is deliberately NOT the place: it covers recruitment
 * candidates only, names no processor, says nothing about employees, and nobody opens it. Do not
 * "complete" this by moving the line there or by adding a second copy.
 *
 * It is strictly an accelerator. Every comment it fills can still be typed, and where the engine is
 * missing the control is not rendered at all rather than rendered inert — an inert microphone reads as
 * a bug.
 *
 * The pure halves live here so they can be tested without a browser: `appendDictated` (which also
 * carries the cap, because `maxLength` on the textarea constrains TYPING and does nothing to a
 * programmatic append) and the two error rules.
 */

import { correctDictatedProducts } from "@/lib/phoenix-crm/dictation-correct";

/** Egyptian Arabic. The engine still handles English product names mixed into the sentence. */
export const DICTATION_LANG = "ar-EG";

type SpeechAlternative = { transcript: string };

type SpeechResult = { isFinal: boolean; 0: SpeechAlternative; length: number };

type SpeechEvent = { resultIndex: number; results: { length: number; [index: number]: SpeechResult } };

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  // Safari and Chrome still ship only the prefixed name, so both are still required.
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isDictationSupported(): boolean {
  return recognitionConstructor() !== null;
}

/**
 * The two outcomes that are not failures: the rep pressed Stop, or said nothing. Neither deserves a
 * message — showing one for a deliberate stop teaches the rep the feature is broken.
 */
const SILENT_RECOGNITION_ERRORS = new Set(["aborted", "no-speech"]);

export function isSilentRecognitionError(code: string): boolean {
  return SILENT_RECOGNITION_ERRORS.has(code);
}

/**
 * What to show for an error that is worth showing. Every message ends by naming the way out, because
 * dictation is an accelerator and typing is always still open.
 */
export function dictationErrorMessage(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "The microphone is blocked for Phoenix. Allow it for this site in the phone's settings, or type the comment instead.";
  }
  if (code === "audio-capture") {
    return "No microphone was found on this phone. Type the comment instead.";
  }
  return "Dictation stopped. Check your connection, or type the comment instead.";
}

/**
 * The comment with one dictated phrase added to the end.
 *
 * Appends, never replaces: a rep who typed half a sentence and then decided to speak the rest keeps
 * both halves.
 *
 * `max` is the comment's own cap, which the server enforces too (`VISIT_COMMENT_MAX`). A phrase that
 * does not fit whole is cut at a word boundary where there is one inside the room left (a single word
 * longer than the whole budget is cut where it must be), and a phrase with no room at all leaves the
 * comment exactly as it was — quietly dropping a word beats pushing the field into its own error state
 * where the rep cannot see why the save is refused.
 */
export function appendDictated(existing: string, spoken: string, max: number): string {
  const phrase = spoken.replace(/\s+/g, " ").trim();
  if (!phrase) return existing;

  const head = existing.trimEnd();
  const joined = head ? `${head} ${phrase}` : phrase;
  if (joined.length <= max) return joined;

  const room = max - (head ? head.length + 1 : 0);
  if (room <= 0) return existing;

  const fitted = phrase.slice(0, room);
  const lastSpace = fitted.lastIndexOf(" ");
  const kept = (lastSpace > 0 ? fitted.slice(0, lastSpace) : fitted).trimEnd();
  if (!kept) return existing;
  return head ? `${head} ${kept}` : kept;
}

export type DictationHandle = { stop: () => void };

export type DictationCallbacks = {
  /** Fires as the engine revises its guess, for the live preview. Not appended. */
  onInterim: (text: string) => void;
  /** Fires once a phrase settles. Appended — never used to replace what is already there. */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
};

/**
 * Starts listening, or returns null when the browser cannot — so a caller treats "this browser has no
 * engine" and "it refused to start" as the same non-event.
 */
export function startDictation(callbacks: DictationCallbacks): DictationHandle | null {
  const Ctor = recognitionConstructor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = DICTATION_LANG;
  // Keep listening across pauses: a rep describing a call stops to think, and a single-phrase
  // recogniser would cut him off mid-sentence.
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result?.[0]?.transcript ?? "";
      if (result?.isFinal) {
        // Corrected on the FINAL phrase only. The interim preview is left raw on purpose: it is
        // revised several times a second and respelling a word that is about to change again makes
        // the preview flicker between two brand names while the rep is still talking.
        callbacks.onFinal(correctDictatedProducts(text.trim()).text);
      } else interim += text;
    }
    callbacks.onInterim(interim.trim());
  };

  recognition.onerror = (event) => {
    if (isSilentRecognitionError(event.error)) return;
    callbacks.onError(dictationErrorMessage(event.error));
  };

  recognition.onend = () => callbacks.onEnd();

  try {
    recognition.start();
  } catch {
    return null;
  }

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // Already stopped, or the tab went away underneath it. Nothing to recover.
      }
    },
  };
}
