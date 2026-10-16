"use client";

/**
 * Phoenix CRM — the visit recording a chosen rep makes before logging a visit (owner, 2026-10-16).
 *
 * Shown ONLY when the visit form says `recordingRequired` — the Super Admin switched this rep on. Every
 * other rep never meets this screen, and Add visit is exactly what it was.
 *
 * The rep presses Start recording before going in, keeps the phone recording through the conversation,
 * and presses Stop and send on the way out. The recording goes up at once, and only then does Add visit
 * go on to the customer and the form. A blocked microphone stops here with how to allow it (his answer 5),
 * a recording under 30 seconds is not accepted, and the recorder stops itself at 15 minutes.
 *
 * The screen is kept awake while recording (Wake Lock, where the browser has it), because a phone that
 * locks itself mid-conversation can pause the recorder. Leaving the page while recording asks first.
 *
 * NOT the voice note (`speak.tsx`): that is the rep's own optional comment, on the form, for everybody.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Send, Square } from "lucide-react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { BROWSER_PLACEHOLDER } from "@/lib/phoenix-crm/browser-name";
import {
  VISIT_RECORDING_MAX_BYTES,
  VISIT_RECORDING_MAX_SECONDS,
  VISIT_RECORDING_MIN_SECONDS,
  VISIT_RECORDING_UNSUPPORTED,
  visitRecordingMicrophoneProblem,
} from "@/lib/phoenix-crm/visit-recording-rules";
import { extensionFor, formatSeconds, isRecordingSupported, startRecording, type Recording, type VoiceRecorder } from "@/lib/phoenix-crm/voice-recorder";

type RecordingSlot = { path: string; signedUrl: string; token: string; contentType: string };

/** What Add visit keeps once the recording is stored: the path the save claims, and its length. */
export type VisitRecordingValue = { path: string; seconds: number };

type Phase = "idle" | "starting" | "recording" | "sending" | "unsent";

async function putRecording(slot: RecordingSlot, blob: Blob): Promise<void> {
  let response: Response;
  try {
    response = await fetch(slot.signedUrl, {
      body: blob,
      headers: { "content-type": slot.contentType, "x-upsert": "false" },
      method: "PUT",
    });
  } catch {
    throw new Error("No connection. The recording is kept on this phone; press Send again when there is internet.");
  }
  if (response.ok) return;
  // An earlier try that arrived but whose answer was lost: the slot already holds this recording.
  const body = await response.text().catch(() => "");
  if (response.status === 409 || /already exists|duplicate/i.test(body)) return;
  throw new Error("The recording did not upload. Press Send again.");
}

export function VisitRecordingGate({
  notice,
  onBack,
  onRecorded,
  seatId,
  test,
}: {
  /** Why the screen is back, when a save refused the recording it carried. Null on the first visit here. */
  notice: string | null;
  onBack: () => void;
  onRecorded: (value: VisitRecordingValue) => void;
  seatId: string;
  test: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const browserNamed = useBrowserNamed();

  const recorder = useRef<VoiceRecorder | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  // A finished recording that has not reached the server yet, and the slot it was going to — kept so
  // Send again re-uses both instead of making the rep record the conversation a second time.
  const unsent = useRef<{ recording: Recording; slot: RecordingSlot | null } | null>(null);
  const stopRef = useRef<() => void>(() => {});

  const releaseWakeLock = useCallback(() => {
    void wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
  }, []);

  // Leaving the screen hands the microphone back; nothing half-recorded is kept.
  useEffect(
    () => () => {
      recorder.current?.cancel();
      recorder.current = null;
      releaseWakeLock();
    },
    [releaseWakeLock],
  );

  // While recording, closing or reloading the page asks first — the conversation would be lost.
  useEffect(() => {
    if (phase !== "recording") return;
    const hold = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [phase]);

  async function send(recording: Recording) {
    setPhase("sending");
    setError(null);
    try {
      const held = unsent.current;
      const slot =
        held?.slot ??
        (await crmPost<RecordingSlot>("/api/phoenix-crm/recording/upload-slot", { extension: extensionFor(recording.mimeType), seatId, test }, "slot"));
      unsent.current = { recording, slot };
      await putRecording(slot, recording.blob);
      unsent.current = null;
      onRecorded({ path: slot.path, seconds: recording.seconds });
    } catch (failure) {
      if (!unsent.current) unsent.current = { recording, slot: null };
      setError(messageOf(failure));
      setPhase("unsent");
    }
  }

  async function stop() {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    releaseWakeLock();
    const recording = await active.stop();
    if (recording.seconds < VISIT_RECORDING_MIN_SECONDS || recording.blob.size < 1024) {
      setPhase("idle");
      setError(`A visit recording is at least ${VISIT_RECORDING_MIN_SECONDS} seconds long. Press Start recording and keep it running through the visit.`);
      return;
    }
    if (recording.blob.size > VISIT_RECORDING_MAX_BYTES) {
      setPhase("idle");
      setError("That recording is larger than Phoenix accepts. Record the visit again.");
      return;
    }
    await send(recording);
  }

  useEffect(() => {
    stopRef.current = () => {
      void stop();
    };
  });

  async function start() {
    setError(null);
    setElapsed(0);
    if (!isRecordingSupported()) {
      setError(VISIT_RECORDING_UNSUPPORTED);
      return;
    }
    setPhase("starting");
    try {
      recorder.current = await startRecording(
        (seconds) => {
          setElapsed(seconds);
          // The recorder stops itself at the cap; the blob is collected and sent from here.
          if (seconds >= VISIT_RECORDING_MAX_SECONDS) stopRef.current();
        },
        { maxSeconds: VISIT_RECORDING_MAX_SECONDS },
      );
    } catch (failure) {
      recorder.current = null;
      const name = failure instanceof DOMException || failure instanceof Error ? failure.name : null;
      setError(visitRecordingMicrophoneProblem(name, BROWSER_PLACEHOLDER));
      setPhase("idle");
      return;
    }
    setPhase("recording");
    try {
      wakeLock.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      // A browser without Wake Lock, or one that refuses it, still records — the rep keeps the screen on.
      wakeLock.current = null;
    }
  }

  function cancel() {
    recorder.current?.cancel();
    recorder.current = null;
    releaseWakeLock();
    setPhase("idle");
    setElapsed(0);
  }

  const left = Math.max(0, VISIT_RECORDING_MAX_SECONDS - elapsed);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="min-w-0">
        <p className="text-base font-black text-slate-900">Record the visit</p>
        <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
          Press Start recording before going in, and keep the phone recording through the whole conversation. Press Stop and send
          when the visit ends. Then choose the customer and log the visit as usual.
        </p>
      </div>

      {notice ? <CrmNote tone="warn">{notice}</CrmNote> : null}

      {phase === "recording" ? (
        <div className="grid min-w-0 gap-2 border border-rose-200 bg-rose-50 px-3.5 py-3">
          <p className="flex min-w-0 items-center gap-2 text-sm font-black text-rose-800">
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 animate-pulse bg-rose-600" />
            Recording · {formatSeconds(elapsed)}
          </p>
          <p className="break-words text-xs font-medium leading-5 text-rose-900">
            Keep this screen open until the visit ends. It stops by itself at {formatSeconds(VISIT_RECORDING_MAX_SECONDS)}; {formatSeconds(left)} left.
          </p>
        </div>
      ) : null}

      {phase === "sending" ? <CrmNote tone="info">Sending the recording. Keep this screen open.</CrmNote> : null}

      {error ? <CrmNote tone="bad">{browserNamed(error)}</CrmNote> : null}

      <div className="flex min-w-0 flex-wrap gap-2">
        {phase === "idle" || phase === "starting" ? (
          <CrmButton busy={phase === "starting"} onClick={() => void start()} variant="primary">
            {phase === "starting" ? null : <Mic aria-hidden className="h-4 w-4 shrink-0" />}
            Start recording
          </CrmButton>
        ) : null}
        {phase === "recording" ? (
          <>
            <CrmButton onClick={() => void stop()} variant="primary">
              <Square aria-hidden className="h-4 w-4 shrink-0" />
              Stop and send
            </CrmButton>
            <CrmButton onClick={cancel} variant="ghost">
              Discard
            </CrmButton>
          </>
        ) : null}
        {phase === "unsent" ? (
          <>
            <CrmButton
              onClick={() => {
                const held = unsent.current;
                if (held) void send(held.recording);
              }}
              variant="primary"
            >
              <Send aria-hidden className="h-4 w-4 shrink-0" />
              Send again
            </CrmButton>
            <CrmButton
              onClick={() => {
                unsent.current = null;
                setError(null);
                setPhase("idle");
              }}
              variant="ghost"
            >
              Record again
            </CrmButton>
          </>
        ) : null}
        {phase === "idle" ? (
          <CrmButton onClick={onBack} variant="secondary">
            Back
          </CrmButton>
        ) : null}
      </div>

      <p className="break-words text-xs font-medium leading-5 text-slate-500">
        At least {VISIT_RECORDING_MIN_SECONDS} seconds, at most {VISIT_RECORDING_MAX_SECONDS / 60} minutes.
      </p>
    </div>
  );
}
