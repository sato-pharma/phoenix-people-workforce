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
 * ONE HALF MAY REFUSE. A phone can fail the recorder alone. Each half is started independently and
 * neither failure cancels the other — the rep is told which half he has, because a panel that says
 * nothing is a visit saved missing the part he wanted. Only when BOTH refuse is this a failure, and then
 * it is the microphone and the message says where to unblock it.
 *
 * THE TEXT HALF HAS TWO ENGINES AND THIS FILE RUNS BOTH. Where the browser has a speech engine of its
 * own it is started with the recorder and writes words as they settle ("live"). Firefox has none at all —
 * no constructor to call, on any platform — so there the finished RECORDING is sent to Phoenix, which
 * writes the words out and hands them back a few seconds after Stop ("server", `store` below). The
 * owner's instruction on 2026-09-25: "un browsers must be text and audio." The second engine is asked for
 * by PATH, never by re-uploading the audio, so a rep on a clinic's 3G sends the recording once.
 *
 * THE SECOND ENGINE IS NEVER FATAL AND ITS FAILURE IS NEVER THE RECORDING'S. It runs after the upload has
 * already landed and the note is already on screen, so a speech service that refuses costs him the typing
 * he would have done anyway — it can never lose what he recorded. That ordering is the whole design of
 * `store`, not an accident of where the call sits.
 *
 * NOTHING HERE CARRIES A TIME. The recording has no `issuedAt` and the payload has no field for one: a
 * note can be made in a car an hour after the call and says nothing about when the visit happened. The
 * photo dates the visit; this does not.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square, Trash2 } from "lucide-react";

import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { crmPost, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { reportClientError } from "@/lib/error-monitor/report-client-error";
import { isEngineLanguageError, startDictation, type DictationHandle } from "@/lib/phoenix-crm/dictation";
import {
  shouldWriteFromRecording,
  speakAgainLine,
  speakBlockedMessage,
  speakHalves,
  speakLiveHint,
  speakLiveLabel,
  speakPartialMessage,
  speakSupported,
  speakTranscribingLine,
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

const NO_HALVES: SpeakHalves = { text: "none", audio: false };

const TRANSCRIBE_URL = "/api/phoenix-crm/voice/transcribe";

/**
 * The server's answer to "can a recording be written out here?", kept for the page's life once it is
 * known (Phoenix CRM performance audit, 2026-10-16). Every comment step mounts this control, so a visit
 * asked the same question two or three times, and the answer is the server's configuration — it does not
 * change between one visit and the next. A failed or pending probe keeps nothing, so the next mount asks.
 */
let transcriptionAnswer: boolean | null = null;

/**
 * The handover breadcrumb is throttled to at most one per window — not latched for the tab's whole life. It
 * exists because the handover makes no request of its own, so `/admin/system-audit` would otherwise have
 * nothing to show that the Firefox path is being taken. On Firefox that handover is the NORMAL path on
 * every recording, so logging each one buries real errors under a steady stream of non-errors. A
 * one-per-page-load latch went too far the other way: after the very first handover it fell permanently
 * silent, so a tab left open for hours — whose feature later broke — showed error-monitor nothing at all.
 * A time throttle keeps the volume to one heartbeat per window while proving the path is STILL live.
 */
const HANDOVER_LOG_INTERVAL_MS = 10 * 60 * 1000;
let handoverReportedAt = 0;

const subscribeToNothing = () => () => {};

/** Neither half on the server, so the control never renders on the first pass and then vanishes. */
const noHalvesOnServer = () => NO_HALVES;

/**
 * Capability is read with `useSyncExternalStore` rather than set in an effect, because a `setState`
 * inside `useEffect` is a lint error in this repo. It cannot change while the screen is open, so the
 * subscribe function has nothing to subscribe to — but the snapshot must be a STABLE object or React
 * re-renders forever, so the halves are cached behind one identity.
 *
 * Asked OPTIMISTICALLY: a browser with no engine of its own is assumed to have the server path, and the
 * probe below only ever downgrades it. Assuming the opposite would show every Firefox rep "this browser
 * cannot turn speech into text" for as long as the request takes and then change its mind in front of him.
 */
let halvesSnapshot: SpeakHalves | null = null;
function readHalves(): SpeakHalves {
  if (!halvesSnapshot) halvesSnapshot = speakHalves(true);
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
  onBusy,
  onChange,
  seatId,
  test,
  value,
}: {
  disabled?: boolean;
  /** One settled phrase. The caller appends it to its own state and applies its own cap. */
  onAppend: (text: string) => void;
  /**
   * 🔴 THE MICROPHONE IS OPEN, OR THE RECORDING IS STILL GOING UP — so the caller can hold its own
   * navigation (visit-log-form's Next and Back) while it is true.
   *
   * It exists because UNMOUNTING THIS CONTROL CANCELS THE RECORDER, by design (`release`), and the
   * visit form unmounts it the moment the rep presses Next: step 3 and step 4 are two trees, not two
   * scroll positions. Cancelled, not stopped, so what he had said was discarded with nothing said to
   * him. The control cannot refuse to be unmounted, so it reports instead and the caller decides.
   *
   * 🔴 CALLED FROM THE HANDLERS, NEVER FROM AN EFFECT. A `setState` inside `useEffect` is a lint
   * error in this repo, and this lands in the caller's state, so an effect here would push the error
   * one file along rather than remove it. Every path that opens or closes the microphone already
   * passes through `start`, `stop` or `abort`.
   */
  onBusy?: (busy: boolean) => void;
  /** The stored recording, or null when there is none. The caller puts it in the visit's payload. */
  onChange: (value: VoiceNoteValue | null) => void;
  seatId: string;
  test: boolean;
  value: VoiceNoteValue | null;
}) {
  const browser = useSyncExternalStore(subscribeToNothing, readHalves, noHalvesOnServer);

  /**
   * EVERY browser that can record asks, not only the ones with no engine of their own.
   *
   * 🔴 It used to ask only when `browser.text === "server"`, and that is half of why the owner got a
   * recording and an empty comment on Firefox ("DIDNT WROITE", 2026-09-25). A browser whose engine exists
   * but cannot write Arabic reads as "live", so it never asked, so it never knew a fallback was available
   * to hand the recording to. The answer is needed wherever a recording might have to be written out —
   * which is any browser holding a recorder.
   *
   * A definite `false` is still the only answer that changes the promise: a failed or pending probe leaves
   * the optimistic reading, so the copy never flickers between engines while it is in flight.
   */
  const probe = useCrmGet<{ available: boolean }>(browser.audio && transcriptionAnswer === null ? TRANSCRIBE_URL : null, "transcription");
  const probed = probe.data?.available;
  useEffect(() => {
    if (typeof probed === "boolean") transcriptionAnswer = probed;
  }, [probed]);
  const serverAvailable = (probed ?? transcriptionAnswer) !== false;
  const halves: SpeakHalves = browser.text === "server" && !serverAvailable ? { ...browser, text: "none" } : browser;
  /** Pulled out as a plain string so `store` can depend on it without depending on an object identity. */
  const engine = halves.text;

  const [listening, setListening] = useState(false);
  const [started, setStarted] = useState<SpeakHalves>(NO_HALVES);
  const [elapsed, setElapsed] = useState(0);
  const [interim, setInterim] = useState("");
  const [uploading, setUploading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /**
   * "The microphone is blocked for your browser" sends a rep to a setting nothing on his phone is
   * called (use-browser-name.ts) — so this screen names it, at the render, where every message it
   * shows passes through. One without the placeholder is untouched.
   */
  const browserNamed = useBrowserNamed();

  const recorder = useRef<VoiceRecorder | null>(null);
  const dictation = useRef<DictationHandle | null>(null);
  // The cap fires from the ticker, so `stop` must be reachable from a callback created before it.
  const stopRef = useRef<() => void>(() => {});
  /**
   * Whether this browser's own engine actually put a phrase in the comment during this recording.
   *
   * 🔴 THE ONE FACT THAT DECIDES WHETHER THE RECORDING IS WRITTEN OUT, and the thing that was missing when
   * the owner got a recording and an empty comment ("DIDNT WROITE", 2026-09-25). The engine's EXISTENCE was
   * being trusted instead, and Firefox 157 has one that cannot do Arabic.
   *
   * A ref, not state: `store` reads it at the instant the recording closes and must see what really
   * happened, not a value from the render that started it.
   */
  const wroteLive = useRef(false);

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
    onBusy?.(false);
  }, [onBusy, release]);

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
      let stored: string | null = null;
      try {
        const extension = extensionFor(result.mimeType);
        const slot = await crmPost<VoiceSlot>("/api/phoenix-crm/voice/upload-slot", { extension, seatId, test }, "slot");
        await sendToSlot(slot, result.blob);
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(result.blob);
        });
        onChange({ path: slot.path, seconds: result.seconds, bytes: result.blob.size });
        stored = slot.path;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The recording did not upload. Speak again.");
      } finally {
        setUploading(false);
      }

      // The words, on a browser that did not write them while he spoke. Deliberately a SECOND block
      // after the upload has landed and the note is already on screen: the recording is safe by the time
      // anything is asked of a speech service, so a refusal here costs him the typing he would have done
      // anyway and can never cost him what he recorded. `stored` null means the upload failed and its own
      // sentence is already showing — there is nothing to transcribe and nothing to add to it.
      //
      // 🔴 THE TEST IS WHAT HAPPENED, NOT WHAT THE BROWSER HAS. This read `engine !== "server"` and shipped
      // the hole the owner found: a Firefox whose engine exists but cannot write Arabic reads as "live", so
      // the recording it had just stored was never sent anywhere. `shouldWriteFromRecording` asks whether
      // words actually arrived — never re-narrow it back to a capability check.
      if (!shouldWriteFromRecording({ storedPath: stored, serverAvailable, wroteLive: wroteLive.current })) return;
      setTranscribing(true);
      try {
        const written = await crmPost<string>(TRANSCRIBE_URL, { path: stored }, "text");
        if (written.trim()) onAppend(written.trim());
      } catch (cause) {
        // Every refusal from that route is already a sentence for the rep, ending in "type the comment
        // instead — the recording was still saved", so it is shown as written.
        setError(messageOf(cause));
      } finally {
        setTranscribing(false);
      }
    },
    [onAppend, onChange, seatId, serverAvailable, test],
  );

  const stop = useCallback(async () => {
    const speech = dictation.current;
    const handle = recorder.current;
    dictation.current = null;
    recorder.current = null;
    speech?.stop();
    setListening(false);
    setInterim("");
    try {
      // Still busy across the whole of `store`: the upload and the writing-out are exactly the window
      // in which leaving loses the recording, and `store` reports its own failures to the rep.
      if (handle) await store(await handle.stop());
    } finally {
      onBusy?.(false);
    }
  }, [onBusy, store]);

  useEffect(() => {
    stopRef.current = () => {
      void stop();
    };
  }, [stop]);

  async function start() {
    setError(null);
    setElapsed(0);
    // Per recording, not per session: the rep who dictated one visit in Chrome's engine and then hit a
    // browser update that broke it must not carry the first recording's success into the second.
    wroteLive.current = false;

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
    if (engine === "live") {
      speech = startDictation({
        onInterim: setInterim,
        onFinal: (text) => {
          // Only a phrase with something in it counts as having written. An engine that settles on empty
          // string has produced nothing the rep can read, and the recording must still be written out.
          if (text.trim()) wroteLive.current = true;
          onAppend(text);
          setInterim("");
        },
        onError: (message, code) => {
          // A failure of the speech half never stops the recording: the rep is mid-sentence and the
          // audio is the half that cannot mishear him. The panel closes only when nothing is left open.
          dictation.current = null;
          setInterim("");

          // 🔴 THE HANDOVER. `language-not-supported` is not a failure to report — it is this browser
          // saying its engine is out, which Firefox 157 does a moment AFTER `start()` succeeded. Where a
          // recorder is running and the server path is there, the words are still coming, so the rep is
          // told nothing: he sees "Writing out the words" a few seconds after Stop, and `store` above does
          // it. Showing an error here is what made the owner's comment box stay empty with no explanation.
          const handingOver = isEngineLanguageError(code) && Boolean(recorder.current) && serverAvailable;
          if (handingOver) {
            // So the panel stops promising words as he talks — it said "writing as you talk" until now.
            setStarted((was) => ({ ...was, text: "server" }));
            // One breadcrumb per window: this failure is invisible from the server because the request was
            // never made, so `/admin/system-audit` needs to see it happen — but on Firefox it is the normal
            // path on every recording, so logging each one would drown real errors. Throttled, not latched:
            // a heartbeat keeps proving the path is live instead of going silent forever after the first.
            const now = Date.now();
            if (now - handoverReportedAt > HANDOVER_LOG_INTERVAL_MS) {
              handoverReportedAt = now;
              reportClientError({
                context: `speak=handover engineCode=${code} recorder=1 serverAvailable=1`,
                error: new Error("Browser speech engine has no Arabic — writing the recording out instead"),
              });
            }
          } else setError(message);

          // Nothing left open, so the caller stops holding its navigation — there is no recording to
          // lose. A recorder still running keeps it held: that half is what Next would discard.
          if (!recorder.current) {
            setListening(false);
            onBusy?.(false);
          }
        },
        onEnd: () => {
          dictation.current = null;
          setInterim("");
          if (!recorder.current) {
            setListening(false);
            onBusy?.(false);
          }
        },
      });
    }

    if (!tape && !speech) {
      setError(speakBlockedMessage());
      return;
    }

    recorder.current = tape;
    dictation.current = speech;
    // The panel reads what actually started, never what the browser merely has. The server engine cannot
    // "start" — it runs on the finished file — so it counts as the text half only where a recorder is
    // actually running to produce that file, and reads as nothing at all where one is not.
    setStarted({ audio: Boolean(tape), text: speech ? "live" : engine === "server" && tape ? "server" : "none" });
    setListening(true);
    // Only once something really opened: the early return above left nothing running, and the caller
    // must not be holding its navigation for a microphone that never started.
    onBusy?.(true);
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
              {previewUrl ? <audio className="mt-2 w-full rounded-none [&::-webkit-media-controls-enclosure]:rounded-none [&::-webkit-media-controls-panel]:rounded-none" controls preload="metadata" src={previewUrl} /> : null}
            </div>
          ) : null}

          <div className="min-w-0">
            <CrmButton busy={uploading || transcribing} disabled={disabled || uploading || transcribing} onClick={() => void start()} size="sm">
              {/* While saving, the button draws its own spinner (`busy`); a second one here doubled it. */}
              {uploading || transcribing ? null : <Mic aria-hidden className="h-4 w-4 shrink-0" />}
              {uploading ? "Saving the recording" : transcribing ? "Writing out the words" : value ? SPEAK_AGAIN_LABEL : SPEAK_LABEL}
            </CrmButton>
            {transcribing ? <p className="mt-1.5 break-words text-xs font-medium leading-5 text-orange-700">{speakTranscribingLine()}</p> : null}
            {again ? <p className="mt-1.5 break-words text-xs font-medium leading-5 text-slate-500">{again}</p> : null}
          </div>
        </div>
      )}

      {partial ? <CrmNote tone="info">{partial}</CrmNote> : null}
      {error ? <CrmNote tone="bad">{browserNamed(error)}</CrmNote> : null}
    </div>
  );
}
