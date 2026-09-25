"use client";

/**
 * Phoenix CRM — the recorder that keeps a visit note as the rep's own voice.
 *
 * It sits on the same form as `CrmDictate` and it is NOT the same control. Dictation sends audio to
 * Google or Apple and gives back text, which saves in the comment; this records audio, keeps it as
 * audio, and transcribes it never — no speech service, no recogniser, nothing that can mishear
 * Egyptian Arabic because nothing listens to it. The two are described differently on the screen for
 * that reason, and a change to one is not a change to the other.
 *
 * The recording is uploaded when it STOPS, not when the visit saves. Three reasons, in order of how
 * much they cost when ignored: the save then carries a path rather than two megabytes, so a visit on a
 * weak signal is not made slower by a note; the rep finds out here that the upload failed, while they
 * are still standing where they can record it again; and an abandoned form leaves an unused slot
 * rather than a half-written visit.
 *
 * Support is read with `useSyncExternalStore` rather than set in an effect, because a `setState` inside
 * `useEffect` is a lint error in this repo — the same reason dictate.tsx does it. Where MediaRecorder
 * is missing this renders nothing at all: an inert button reads as a bug, and a note was never required.
 *
 * NOTHING HERE CARRIES A TIME. The slot answer has no `issuedAt` to hold and the payload has no field
 * for one, because a recording can be made in a car an hour after the call and says nothing about when
 * the visit happened. The photo dates the visit; this does not.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Mic, Square, Trash2 } from "lucide-react";

import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { crmPost } from "@/components/phoenix-crm/api";
import {
  extensionFor,
  formatSeconds,
  isRecordingSupported,
  MAX_SECONDS,
  rejectRecording,
  startRecording,
  type Recording,
  type VoiceRecorder,
} from "@/lib/phoenix-crm/voice-recorder";

type VoiceSlot = { path: string; signedUrl: string; token: string; contentType: string };

/** What the form keeps: the stored path and the two figures that describe it. */
export type VoiceNoteValue = { path: string; seconds: number; bytes: number };

const subscribeToNothing = () => () => {};

/** False on the server, so the control never renders on the first pass and then vanishes. */
const unsupportedOnServer = () => false;

async function sendToSlot(slot: VoiceSlot, blob: Blob): Promise<void> {
  let response: Response;
  try {
    response = await fetch(slot.signedUrl, {
      body: blob,
      headers: { "content-type": slot.contentType, "x-upsert": "false" },
      method: "PUT",
    });
  } catch {
    throw new Error("No connection. Record the note again when you have internet.");
  }
  if (response.ok) return;
  // An earlier try that arrived but whose answer was lost: the slot already holds this recording.
  const body = await response.text().catch(() => "");
  if (response.status === 409 || /already exists|duplicate/i.test(body)) return;
  throw new Error("The note did not upload. Record it again.");
}

export function CrmVoiceNote({
  disabled = false,
  onChange,
  seatId,
  test,
  value,
}: {
  disabled?: boolean;
  /** The stored note, or null when there is none. The caller puts it in the visit's payload. */
  onChange: (value: VoiceNoteValue | null) => void;
  seatId: string;
  test: boolean;
  value: VoiceNoteValue | null;
}) {
  const supported = useSyncExternalStore(subscribeToNothing, isRecordingSupported, unsupportedOnServer);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);

  // The recorder holds the microphone, so leaving the screen — Cancel, a saved visit, the tab closing —
  // must hand it back. Missing this leaves the phone showing Phoenix as recording indefinitely. The
  // object URL goes with it: it pins the blob in memory for as long as the document lives.
  useEffect(() => {
    return () => {
      recorder.current?.cancel();
      recorder.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Pressing Save while the microphone is open hands it back and throws the part-recording away, which
  // is the honest outcome: half a sentence saved against a visit is worse than no note at all.
  useEffect(() => {
    if (disabled && recorder.current) {
      recorder.current.cancel();
      recorder.current = null;
    }
  }, [disabled]);

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
        setError(cause instanceof Error ? cause.message : "The note did not upload. Record it again.");
      } finally {
        setUploading(false);
      }
    },
    [onChange, seatId, test],
  );

  async function start() {
    setError(null);
    try {
      recorder.current = await startRecording(setElapsed);
    } catch {
      setError("Phoenix could not open the microphone. Allow it for this site, or type the comment instead.");
      return;
    }
    setElapsed(0);
    setRecording(true);
  }

  async function stop() {
    const handle = recorder.current;
    recorder.current = null;
    setRecording(false);
    if (!handle) return;
    await store(await handle.stop());
  }

  function remove() {
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setError(null);
    onChange(null);
  }

  if (!supported) return null;

  return (
    <div className="mt-2 grid min-w-0 gap-2">
      {recording ? (
        <div className="min-w-0 border border-rose-200 bg-rose-50/60 px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-xs font-black text-rose-700">
              <Mic aria-hidden className="h-4 w-4 shrink-0 animate-pulse" />
              Recording — {formatSeconds(elapsed)} of {formatSeconds(MAX_SECONDS)}
            </span>
            <CrmButton className="shrink-0" onClick={stop} size="sm">
              <Square aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Stop
            </CrmButton>
          </div>
        </div>
      ) : value ? (
        <div className="min-w-0 border border-slate-200 bg-slate-50/60 px-3 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-xs font-black text-slate-700">Voice note saved — {formatSeconds(value.seconds)}</span>
            <CrmButton className="shrink-0" disabled={disabled} onClick={remove} size="sm" variant="danger">
              <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Remove
            </CrmButton>
          </div>
          {previewUrl ? <audio className="mt-2 w-full" controls preload="metadata" src={previewUrl} /> : null}
        </div>
      ) : (
        <div className="min-w-0">
          <CrmButton busy={uploading} disabled={disabled || uploading} onClick={start} size="sm">
            {uploading ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> : <Mic aria-hidden className="h-4 w-4 shrink-0" />}
            {uploading ? "Saving the note" : "Record a voice note"}
          </CrmButton>
          <p className="mt-1.5 break-words text-xs font-medium leading-5 text-slate-500">
            Up to {MAX_SECONDS} seconds, in your own voice. It is kept as a recording and never turned into text.
          </p>
        </div>
      )}

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
    </div>
  );
}
