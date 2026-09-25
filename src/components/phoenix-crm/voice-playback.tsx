"use client";

/**
 * Phoenix CRM — playing a visit's stored voice note.
 *
 * The notes sit in a private bucket, so a link has to be signed. This asks for ONE path when the
 * reader presses Play, rather than joining a batch the way photo.tsx does, and the difference is
 * deliberate: a thumbnail has to be signed because it is already on the screen, while a recording is
 * only worth a link when somebody actually wants to hear it. A day's list can hold twenty notes that
 * nobody opens, and signing all twenty would hand out twenty ten-minute URLs into a private bucket to
 * answer a question nobody asked.
 *
 * It is a separate file from voice-note.tsx so that reading a visit does not pull the recorder — and
 * with it MediaRecorder, the microphone and the upload path — into a screen that only listens.
 */

import { useState } from "react";
import { Play } from "lucide-react";

import { crmPost } from "@/components/phoenix-crm/api";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { formatSeconds } from "@/lib/phoenix-crm/voice-recorder";

export function CrmVoiceNotePlayer({ path, seconds }: { path: string; seconds: number | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open() {
    setLoading(true);
    setFailed(false);
    try {
      const urls = await crmPost<Record<string, string>>("/api/phoenix-crm/voice/sign", { paths: [path] }, "urls");
      const signed = urls[path];
      if (!signed) throw new Error("no link");
      setUrl(signed);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  const length = seconds === null ? "" : ` · ${formatSeconds(seconds)}`;

  return (
    <div className="min-w-0">
      <p className="font-black text-slate-800">Voice note{length}</p>
      {url ? (
        // autoPlay because the reader has already pressed Play once — a second press to start the
        // audio they just asked for reads as a control that did not work.
        <audio autoPlay className="mt-1 w-full" controls preload="metadata" src={url} />
      ) : (
        <div className="mt-1">
          <CrmButton busy={loading} disabled={loading} onClick={open} size="sm">
            {/* While opening, the button draws its own spinner (`busy`); a second one here doubled it. */}
            {loading ? null : <Play aria-hidden className="h-4 w-4 shrink-0" />}
            {loading ? "Opening" : "Play"}
          </CrmButton>
          {failed ? <p className="mt-1 break-words text-xs font-medium leading-5 text-rose-700">The note could not be opened. Try again.</p> : null}
        </div>
      )}
    </div>
  );
}
