"use client";

/**
 * Phoenix CRM — the one microphone on the visit form (owner, 2026-09-25).
 *
 * It replaces the two buttons that stood here before, `CrmDictate` and `CrmVoiceNote`. The owner's
 * instruction: "I want the only one option dictate and record in the same time. I speak once and this
 * speaking appears in the field as a text and saved as a record. Both." One press opens the microphone
 * once and runs both halves off it — the speech engine writing words into the comment as they settle,
 * and `MediaRecorder` keeping the audio, which is uploaded when the rep stops.
 *
 * THE TEXT IS NOT A TRANSCRIPT OF THE RECORDING, and this file must never imply that it is. The engine
 * listens live and can mishear; the recording is what was actually said. `src/lib/phoenix-crm/speak.ts`
 * holds every sentence shown here for exactly that reason — the wording is pinned by tests rather than
 * left to whoever edits this component next.
 *
 * WHY THE APPEND GOES THROUGH A CALLBACK. The comment is a CONTROLLED React field, so assigning
 * `field.value` defeats React's own value tracker: the change event is swallowed, state never moves,
 * and the next render puts the old text back. It looks right for a moment and the dictated Arabic is
 * gone by the time the rep saves. The caller owns the state, so the caller does the appending — and
 * the caller also applies the cap, because `maxLength` constrains TYPING and does nothing to a
 * programmatic append.
 *
 * WHY THE RECORDING UPLOADS ON STOP rather than on save: the save then carries a path instead of two
 * megabytes on a weak signal; the rep learns the upload failed while still standing where he can speak
 * again; and an abandoned form leaves an unused slot rather than half a visit.
 *
 * THE ORDER OF THE TWO STARTS MATTERS. `getUserMedia` is awaited first, so the permission prompt is
 * answered once and the recorder is holding the microphone before the speech engine opens its own
 * capture. Starting the engine first put a second prompt in front of the rep on some Android builds.
 *
 * ONE HALF MAY REFUSE. Firefox has no speech engine at all; a phone can fail the recorder alone. Each
 * half is started independently and neither failure cancels the other — the rep is told which half he
 * has, because a panel that says nothing is a visit saved missing the part he wanted. Only when BOTH
 * refuse is this a failure, and then it is the microphone and the message says where to unblock it.
 *
 * NOTHING HERE CARRIES A TIME. The recording has no `issuedAt` and the payload has no field for one: a
 * note can be made in a car an hour after the call and says nothing about when the visit happened. The
 * photo dates the visit; this does not.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square, Trash2 } from "lucide-react";

import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { crmPost } from "@/components/phoenix-crm/api";
import { startDictation, type DictationHandle } from "@/lib/phoenix-crm/dictation";
import {
  speakAccuracyLine,
  speakAgainLine,
  speakBlockedMessage,
  speakHalves,
  speakLiveHint,
  speakLiveLabel,
  speakPartialMessage,
  speakProcessorLine,
  speakPromise,
  speakSupported,
  SPEAK_AGAIN_LABEL,
  SPEAK_LABEL,
  type SpeakHalves,
} from "@/lib/phoenix-crm/speak";
import {
  extensionFor,
  formatSeconds,
  MAX_SECONDS,
  rejectRecording,
  startRecording,
  type Recording,
  type VoiceRecorder,
} from "@/lib/phoenix-crm/voice-recorder";

type VoiceSlot = { path: string; signedUrl: string; token: string; contentType: string };

/** What the form keeps of the recording: the stored path and the two figures that describe it. */
export type VoiceNoteValue = { path: string; seconds: number; bytes: number };

const NO_HALVES: SpeakHalves = { text: false, audio: false };

const subscribeToNothing = () => () => {};

/** Neither half on the server, so the control never renders on the first pass and then vanishes. */
const noHalvesOnServer = () => NO_HALVES;

/**
 * Capability is read with `useSyncExternalStore` rather than set in an effect, because a `setState`
 * inside `useEffect` is a lint error in this repo. It cannot change while the screen is open, so the
 * subscribe function has nothing to subscribe to — but the snapshot must be a STABLE object or React
 * re-renders forever, so the two booleans are cached behind one identity.
 */
let halvesSnapshot: SpeakHalves | null = null;
function readHalves(): SpeakHalves {
  if (!halvesSnapshot) halvesSnapshot = speakHalves();
  return halvesSnapshot;
}

async function sendToSlot(slot: VoiceSlot, blob: Blob): Promise<void> {
  let response: Response;
  try {
    response = await fetch(slot.signedUrl, {
      body: blob,
      headers: { "content-type": slot.contentType, "x-upsert": "false" },
      method: "PUT",
    });
  } catch {
    throw new Error("No connection. Speak again when you have internet.");
  }
  if (response.ok) return;
  // An earlier try that arrived but whose answer was lost: the slot already holds this recording.
  const body = await response.text().catch(() => "");
  if (response.status === 409 || /already exists|duplicate/i.test(body)) return;
  throw new Error("The recording did not upload. Speak again.");
}

export function CrmSpeak({
  disabled = false,
  onAppend,
  onChange,
  seatId,
  test,
  value,
}: {
  disabled?: boolean;
  /** One settled phrase. The caller appends it to its own state and applies its own cap. */
  onAppend: (text: string) => void;
  /** The stored recording, or null when there is none. The caller puts it in the visit's payload. */
  onChange: (value: VoiceNoteValue | null) => void;
  seatId: string;
  test: boolean;
  value: VoiceNoteValue | null;
}) {
  const halves = useSyncExternalStore(subscribeToNothing, readHalves, noHalvesOnServer);

  const [listening, setListening] = useState(false);
  const [started, setStarted] = useState<SpeakHalves>(NO_HALVES);
  const [elapsed, setElapsed] = useState(0);
  const [interim, setInterim] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorder = useRef<VoiceRecorder | null>(null);
  const dictation = useRef<DictationHandle | null>(null);
  // The cap fires from the ticker, so `stop` must be reachable from a callback created before it.
  const stopRef = useRef<() => void>(() => {});

  /**
   * Hand the microphone back, both halves, without waiting for the upload.
   *
   * Every exit goes through here and none may skip it: a live track is a microphone the phone still
   * considers in use, and the OS says so in the status bar long after this form thinks it finished.
   */
  const release = useCallback(() => {
    dictation.current?.stop();
    dictation.current = null;
    recorder.current?.cancel();
    recorder.current = null;
  }, []);

  useEffect(() => release, [release]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  /**
   * Pressing Save while the microphone is open hands it back and throws the part-recording AWAY.
   *
   * Cancelled, never stopped: `stop` would upload what was caught so far, and half a sentence stored
   * against a visit is worse than no recording at all. The words that already settled into the comment
   * stay there — by then they are the rep's own text, no different from typing.
   */
  const abort = useCallback(() => {
    release();
    setListening(false);
    setInterim("");
  }, [release]);

  // Deferred by a microtask because a setState called SYNCHRONOUSLY inside an effect is a lint error
  // in this repo — it cascades renders. The two controls this replaced got the same deferral for free
  // by leaning on the speech engine's own `onend`; a CANCELLED recorder fires no such callback, and
  // cancelling is exactly what Save has to do. The panel is hidden from `disabled` directly below, so
  // the screen is already right before this runs.
  useEffect(() => {
    if (disabled) queueMicrotask(abort);
  }, [abort, disabled]);

  const store = useCallback(
    async (result: Recording) => {
      const refusal = rejectRecording(result);
      if (refusal) {
        setError(refusal);
        return;
      }
      setUploading(true);
      try {
        const extension = extensionFor(result.mimeType);
        const slot = await crmPost<VoiceSlot>("/api/phoenix-crm/voice/upload-slot", { extension, seatId, test }, "slot");
        await sendToSlot(slot, result.blob);
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(result.blob);
        });
        onChange({ path: slot.path, seconds: result.seconds, bytes: result.blob.size });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The recording did not upload. Speak again.");
      } finally {
        setUploading(false);
      }
    },
    [onChange, seatId, test],
  );

  const stop = useCallback(async () => {
    const speech = dictation.current;
    const handle = recorder.current;
    dictation.current = null;
    recorder.current = null;
    speech?.stop();
    setListening(false);
    setInterim("");
    if (handle) await store(await handle.stop());
  }, [store]);

  useEffect(() => {
    stopRef.current = () => {
      void stop();
    };
  }, [stop]);

  async function start() {
    setError(null);
    setElapsed(0);

    // The recorder first: it answers the permission prompt, and the speech engine then opens its own
    // capture against a microphone the rep has already allowed.
    let tape: VoiceRecorder | null = null;
    if (halves.audio) {
      try {
        tape = await startRecording((seconds) => {
          setElapsed(seconds);
          // The recorder stops itself at the cap, but only the caller collects the blob — so the whole
          // session is ended from here instead, which stops the speech engine at the same moment. What
          // the rep said is then exactly what was recorded and exactly what was written.
          if (seconds >= MAX_SECONDS) stopRef.current();
        });
      } catch {
        tape = null;
      }
    }

    let speech: DictationHandle | null = null;
    if (halves.text) {
      speech = startDictation({
        onInterim: setInterim,
        onFinal: (text) => {
          onAppend(text);
          setInterim("");
        },
        onError: (message) => {
          // A failure of the speech half never stops the recording: the rep is mid-sentence and the
          // audio is the half that cannot mishear him. The panel closes only when nothing is left open.
          dictation.current = null;
          setInterim("");
          setError(message);
          if (!recorder.current) setListening(false);
        },
        onEnd: () => {
          dictation.current = null;
          setInterim("");
          if (!recorder.current) setListening(false);
        },
      });
    }

    if (!tape && !speech) {
      setError(speakBlockedMessage());
      return;
    }

    recorder.current = tape;
    dictation.current = speech;
    setStarted({ audio: Boolean(tape), text: Boolean(speech) });
    setListening(true);
  }

  function remove() {
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setError(null);
    onChange(null);
  }

  if (!speakSupported(halves)) return null;

  // `disabled` hides the panel in the same render that Save was pressed, so the microphone is never
  // shown as open on a form that has stopped listening — the cancel above then catches up a tick later.
  const open = listening && !disabled;
  const partial = open ? speakPartialMessage(started) : null;
  const accuracy = speakAccuracyLine(halves);
  const processor = speakProcessorLine(halves);
  const again = value ? speakAgainLine(halves) : null;

  return (
    <div className="mt-2 grid min-w-0 gap-2">
      {open ? (
        <div className="min-w-0 border border-orange-200 bg-orange-50/60 px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-xs font-black text-orange-700">
              <Mic aria-hidden className="h-4 w-4 shrink-0 animate-pulse" />
              {speakLiveLabel(started, elapsed)}
            </span>
            <CrmButton className="shrink-0" onClick={() => void stop()} size="sm">
              <Square aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Stop
            </CrmButton>
          </div>
          <p className="mt-1 break-words text-phx-xs font-medium leading-4 text-orange-700/80">{speakLiveHint(started)}</p>
          {interim ? (
            <p className="mt-1.5 break-words text-xs font-medium italic leading-5 text-slate-600" dir="auto">
              {interim}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="grid min-w-0 gap-2">
          {value ? (
            <div className="min-w-0 border border-slate-200 bg-slate-50/60 px-3 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-xs font-black text-slate-700">Recording saved — {formatSeconds(value.seconds)}</span>
                <CrmButton className="shrink-0" disabled={disabled} onClick={remove} size="sm" variant="danger">
                  <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  Remove
                </CrmButton>
              </div>
              {previewUrl ? <audio className="mt-2 w-full" controls preload="metadata" src={previewUrl} /> : null}
            </div>
          ) : null}

          <div className="min-w-0">
            <CrmButton busy={uploading} disabled={disabled || uploading} onClick={() => void start()} size="sm">
              {/* While saving, the button draws its own spinner (`busy`); a second one here doubled it. */}
              {uploading ? null : <Mic aria-hidden className="h-4 w-4 shrink-0" />}
              {uploading ? "Saving the recording" : value ? SPEAK_AGAIN_LABEL : SPEAK_LABEL}
            </CrmButton>
            <p className="mt-1.5 break-words text-xs font-medium leading-5 text-slate-500">{speakPromise(halves)}</p>
            {again ? <p className="mt-1 break-words text-xs font-medium leading-5 text-slate-500">{again}</p> : null}
            {accuracy ? <p className="mt-1 break-words text-xs font-medium leading-5 text-slate-500">{accuracy}</p> : null}
            {processor ? <p className="mt-1 break-words text-phx-xs font-medium leading-4 text-slate-400">{processor}</p> : null}
          </div>
        </div>
      )}

      {partial ? <CrmNote tone="info">{partial}</CrmNote> : null}
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
    </div>
  );
}
