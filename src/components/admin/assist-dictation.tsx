"use client";

import { Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
// 🔴 ./dictation-limits, NEVER ./dictation — that one holds the speech client, so importing it here
// would pull GROQ_API_KEY, the AI metrics recorder and the server logger into the browser bundle.
import {
  CEO_DICTATION_DEFAULT_LANGUAGE,
  CEO_DICTATION_LANGUAGES,
  CEO_DICTATION_MAX_SECONDS,
} from "@/lib/ceo-email/dictation-limits";
import {
  extensionFor,
  formatSeconds,
  isRecordingSupported,
  startRecording,
  type VoiceRecorder,
} from "@/lib/phoenix-crm/voice-recorder";

/**
 * The microphone beside the assistant's instruction box.
 *
 * Owner 2026-10-06: the CEO can "type what he wants any language or even open the mic".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 IT RECORDS AND UPLOADS; IT DOES NOT USE THE BROWSER'S SPEECH ENGINE. The engine is free and the
 * CRM uses it, but it exists in no Firefox that can do Arabic, and `SpeechRecognition.lang` is
 * mandatory there with no "detect it" value.
 *
 * 🔴 AND THE LANGUAGE IS NAMED HERE RATHER THAN DETECTED, WHICH IS MEASURED AND NOT A SHORTCUT. Send
 * the speech service no language and it TRANSLATES the speech into fluent English — measured in this
 * repo on Egyptian Arabic. A letter he dictated in Arabic arriving as an English instruction is the
 * worst outcome available, because nothing on the screen would look wrong. So one small control sits
 * beside the button, opening on Arabic, and the whole reasoning is in `src/lib/ceo-email/dictation.ts`.
 * The typed box is unaffected: the assistant answers in whatever language he writes in.
 *
 * 🔴 IT APPENDS, NEVER REPLACES. He speaks a paragraph, reads it back, adds another — and he may have
 * typed half of it himself. Overwriting the box with each recording would throw away the half he
 * typed, silently, which is the one thing a dictation control must not do.
 *
 * 🔴 AND IT IS AN ACCELERATOR, NOT A CHANNEL. The box is a text box; every failure here has the same
 * recovery, which is to type it, and every sentence this renders says so. The control is not rendered
 * at all where it cannot work — `isRecordingSupported` for the browser, and the server's own answer
 * for the key — rather than rendered inert, because an inert microphone reads as a bug.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

const PALE_BUTTON =
  "inline-flex h-[34px] items-center justify-center gap-1.5 border border-phx-line bg-white px-3 text-phx-xs font-black text-phx-ink transition hover:bg-phx-paper disabled:opacity-50";
const STOP_BUTTON =
  "inline-flex h-[34px] items-center justify-center gap-1.5 border border-[#B91C1C] bg-white px-3 text-phx-xs font-black text-[#B91C1C] transition hover:bg-[#FEF2F2] disabled:opacity-50";

/** Below this the recording is a tap that opened and closed the microphone, with no speech in it. */
const MIN_BYTES = 1024;

/**
 * Whether this browser can record, read with `useSyncExternalStore` rather than set in an effect.
 *
 * A `setState` inside `useEffect` is a lint error in this repo, and reading `MediaRecorder` at render
 * would be a hydration mismatch — the server has none. The CRM's own microphone (`CrmSpeak`) solves
 * it the same way, so the two controls answer the same question by the same means. Nothing to
 * subscribe to: the answer cannot change while the screen is open. The snapshot is a boolean, so it
 * is stable by value and cannot drive the re-render loop a fresh object would.
 */
const subscribeToNothing = () => () => {};
const notSupportedOnServer = () => false;

export function AssistDictation({
  busy,
  endpoint,
  onText,
}: {
  /** True while the assistant itself is running — one thing at a time on this row. */
  busy: boolean;
  endpoint: string;
  onText: (text: string) => void;
}) {
  const supported = useSyncExternalStore(subscribeToNothing, isRecordingSupported, notSupportedOnServer);
  const [language, setLanguage] = useState<string>(CEO_DICTATION_DEFAULT_LANGUAGE);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const stopRef = useRef<() => void>(() => {});

  // 🔴 THE MICROPHONE IS HANDED BACK WHEN THIS UNMOUNTS. A live track is a microphone the operating
  // system still considers in use, and it says so in the status bar long after the screen has gone.
  useEffect(
    () => () => {
      recorder.current?.cancel();
      recorder.current = null;
    },
    [],
  );

  const stop = useCallback(async () => {
    const live = recorder.current;
    if (!live) return;
    recorder.current = null;
    setRecording(false);

    const result = await live.stop();
    if (result.blob.size < MIN_BYTES) {
      setProblem("That was too short. Hold the button a little longer, or type it instead.");
      return;
    }

    setWriting(true);
    try {
      const form = new FormData();
      form.append("audio", result.blob, `dictation${extensionFor(result.mimeType)}`);
      // The route re-reads this against its own list, so a stale value here cannot reach the API.
      form.append("language", language);
      const response = await fetch(endpoint, { body: form, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        problem?: string;
        text?: string;
      };
      if (payload.text) {
        setProblem(null);
        onText(payload.text);
        return;
      }
      // `problem` is the route's own 200 answer for "the speech service could not do it", which is
      // not a server fault and does not deserve an error banner. `message` is everything else.
      setProblem(payload.problem ?? payload.message ?? "The words could not be written. Type it instead.");
    } catch {
      setProblem("The words could not be written. Type it instead.");
    } finally {
      setWriting(false);
    }
  }, [endpoint, language, onText]);

  // A ref, not an effect that calls `stop` — the cap below fires from inside the recorder's own tick,
  // which runs outside React's render. Assigning a ref in an effect is not a `setState` in an effect.
  useEffect(() => {
    stopRef.current = () => void stop();
  }, [stop]);

  async function begin() {
    setProblem(null);
    setSeconds(0);
    try {
      recorder.current = await startRecording(
        (elapsed) => {
          setSeconds(elapsed);
          // 🔴 THE RECORDER STOPS ITSELF AT THE CAP, BUT ONLY THIS CALLER COLLECTS THE BLOB. Without
          // this the screen would sit on a dead recorder still showing "Stop" and the dictation would
          // never be written out. Ended from the tick rather than from an effect watching `seconds`,
          // which is where `react-hooks/set-state-in-effect` would bite — the CRM's microphone ends
          // its own session the same way.
          if (elapsed >= CEO_DICTATION_MAX_SECONDS) stopRef.current();
        },
        { maxSeconds: CEO_DICTATION_MAX_SECONDS },
      );
      setRecording(true);
    } catch {
      // The one failure that is not about speech at all: he declined the microphone, or the browser
      // has none. Said plainly, because "try again" is the wrong instruction for a refused permission.
      setProblem("Phoenix could not reach your microphone. Allow it in the browser, or type it instead.");
    }
  }

  if (!supported) return null;

  return (
    <span className="inline-flex flex-col items-end gap-1">
      {recording ? (
        <button className={STOP_BUTTON} onClick={() => void stop()} type="button">
          <Square className="h-3.5 w-3.5" />
          Stop · {formatSeconds(seconds)}
        </button>
      ) : (
        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
          {/* Unlabelled: the language sits against the button it belongs to, and a "Language"
              caption on one row of controls would read as a form field of its own.

              🔴 THE SKIN IS `phxSelectClassName`, NEVER WRITTEN BY HAND (owner rule, 2026-10-06 —
              one field token set, the ADR wizard is the reference). The identity the rule is about —
              square corners, the hairline border on white, the orange focus ring — is the token's,
              and the override is GEOMETRY ONLY: this control sits in a toolbar row beside two 34px
              buttons, so the token's 40px height and 12px padding would leave the row stepped.

              🔴 THROUGH `cn()`, NEVER A TEMPLATE LITERAL. A template concatenates without merging,
              so the token's own `h-10 px-3` would win and the override would render as nothing —
              the guard refuses that spelling for exactly that reason. The type size is NOT
              overridden: `text-phx-xs` is a custom named size tailwind-merge does not recognise, so
              it cannot be merged against the token's `text-sm` safely. */}
          <select
            aria-label="The language you will speak"
            className={cn(phxSelectClassName, "h-[34px] px-2")}
            disabled={busy || writing}
            onChange={(event) => setLanguage(event.target.value)}
            value={language}
          >
            {CEO_DICTATION_LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </select>
          <button className={PALE_BUTTON} disabled={busy || writing} onClick={() => void begin()} type="button">
            {writing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
            {writing ? "Writing it out" : "Dictate"}
          </button>
        </span>
      )}
      {problem ? <span className="max-w-[320px] text-right text-xs font-semibold text-[#B91C1C]">{problem}</span> : null}
    </span>
  );
}
