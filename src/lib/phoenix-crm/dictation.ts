/**
 * Phoenix CRM — Egyptian Arabic dictation for the visit comment.
 *
 * Typing Arabic on a phone keyboard, standing at a clinic door, is the slowest part of entering a
 * visit. The browser's own speech engine does Egyptian Arabic server-side at no cost, with no account
 * and no dependency: Chrome on Android and Safari on iOS 14.1 and later have it, Firefox has none at
 * all — no constructor to call, on any platform, and Firefox 157's new on-device engine does not change
 * that for Arabic (it uses NVIDIA's Parakeet, whose language list has no Arabic, so `ar-EG` answers
 * `language-not-supported`). THIS MODULE IS THEREFORE NOT THE WHOLE TEXT HALF ANY MORE: where there is
 * no engine, the finished recording is written out by Phoenix's own server instead
 * (`./server/voice-transcribe.ts`), on the owner's instruction of 2026-09-25 — "un browsers must be text
 * and audio". `speakHalves` in `./speak.ts` is what chooses between the two, and it is the only place
 * that should.
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
 * owner on 2026-09-25 and he ruled it acceptable — keep it. There is no on-device Arabic engine, free or
 * paid, to put in its place, so reopening THIS decision only removes the feature. (The server path added
 * the same day sends audio to a third party too, and says so in its own notice — it is a different
 * processor, not a way of keeping the voice on the phone.)
 *
 * Whether the REP is told on the form: NO, since 2026-09-30. On 2026-09-25 the owner put a processor
 * line under the microphone ("add the processor line to the dictation mic, not the privacy page"); on
 * 2026-09-30 he had it removed with the rest of the text under the Speak button ("remove this irrelevant
 * text"). The processing itself is unchanged and still his accepted decision above. Do not put the line
 * back on the form, and do not move it to `app/privacy` either without his word — that page covers
 * recruitment candidates only.
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
 * The engine EXISTS but cannot do this language — Firefox 157's Parakeet answers exactly this for `ar-EG`.
 *
 * Kept apart from the messages below because the caller ACTS on it rather than showing it: it says the
 * browser's own engine is out, which is a fact about the browser and not something the rep can fix. Where
 * a recording is running the caller hands it to the server path instead (`shouldWriteFromRecording` in
 * `../speak.ts`) and says nothing, so the words still arrive — a few seconds after he stops instead of
 * while he talks. Only where that handover cannot run does the sentence below reach him.
 *
 * 🔴 IT ARRIVES AFTER `start()` HAS ALREADY SUCCEEDED. Firefox 157 constructs a recogniser, accepts
 * `ar-EG`, starts, and only then fires this — so no capability check taken before speaking can see it.
 * That is why the decision to write the recording out is made from what HAPPENED, not from what the
 * browser appeared to have.
 */
export function isEngineLanguageError(code: string): boolean {
  return code === "language-not-supported";
}

/**
 * What to show for an error that is worth showing. Every message ends by naming the way out, because
 * dictation is an accelerator and typing is always still open.
 *
 * 🔴 THE `language-not-supported` SENTENCE IS THE NO-HANDOVER ONE, and it must stay that way. Where the
 * recording CAN be written out the caller shows nothing at all and lets "Writing out the words" speak for
 * itself, so the only time these words reach a rep is when nothing else is coming — which is exactly when
 * promising him words from the recording would be a lie. Do not soften it into "the words will arrive".
 */
export function dictationErrorMessage(code: string): string {
  if (isEngineLanguageError(code)) {
    return "This browser cannot write Arabic while you talk. Type the comment instead — the recording is still saved.";
  }
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
  /**
   * The rep-facing sentence AND the engine's own code.
   *
   * The code is passed because one of them is not a failure to report but a branch to take:
   * `language-not-supported` means this engine is out and the recording must be written out instead
   * (`isEngineLanguageError`). Handing back only the message forced the caller to match on English
   * prose to find that out, which is how a wording change becomes a silent regression.
   */
  onError: (message: string, code: string) => void;
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
    callbacks.onError(dictationErrorMessage(event.error), event.error);
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
