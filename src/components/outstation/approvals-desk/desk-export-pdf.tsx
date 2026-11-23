"use client";

import { FileDown, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type CaseExportNote, caseExportNoteOnScreen, casePdfFilenameFromHeader } from "@/lib/outstation/approvals/case-pdf-plan";

const ROUTE = "/api/admin/outstation/approvals";

const WAITING = "Preparing the PDF of this claim. It can take up to a minute; you can keep reading.";
const NO_ANSWER = "Could not reach the server, so no PDF was made. Check the connection and try again.";

/**
 * Export one claim as a PDF that looks as the reviewer looks (owner, 23 Nov 2026: "export every expense
 * trip case as a PDF, looking 100% as it is looking in the system").
 *
 * The server prints the reviewer screen itself (src/lib/outstation/approvals/case-pdf.ts), which takes
 * some seconds, so this is a press with a state, never a bare link: the button says it is preparing,
 * one export runs at a time, the file is saved under the name the server gave it, and a failure is
 * told in the server's own words. The note remembers WHICH claim it is about, because he can walk on
 * to the next claim while the PDF is prepared. It reads; it decides nothing.
 */
export function useCaseExport() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<CaseExportNote | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async (requestId: number) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNote({ message: WAITING, requestId, tone: "info" });
    let failure: string | null = null;
    try {
      const response = await fetch(`${ROUTE}/${requestId}/pdf`, { cache: "no-store" });
      if (response.ok && (response.headers.get("content-type") ?? "").includes("application/pdf")) {
        const address = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = address;
        link.download = casePdfFilenameFromHeader(response.headers.get("content-disposition"), requestId);
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Long enough for a slow phone to start the save, then the copy held in memory is let go.
        window.setTimeout(() => URL.revokeObjectURL(address), 60_000);
      } else {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        failure = body?.message || "The PDF could not be made. Try again.";
      }
    } catch {
      failure = NO_ANSWER;
    }
    running.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setNote(failure ? { message: failure, requestId, tone: "bad" } : null);
  }, []);

  const dismiss = useCallback(() => setNote(null), []);

  return { busy, dismiss, note, start };
}

/**
 * In the reviewer's bar, before Previous and Next. The words show from a tablet up; a phone gets the
 * icon. While it prepares it is `aria-disabled`, never `disabled`: a disabled button drops the
 * keyboard out of the reviewer.
 */
export function DeskExportPdfButton({ busy, onExport }: { busy: boolean; onExport: () => void }) {
  return (
    <button
      aria-disabled={busy}
      aria-label={busy ? "Preparing a PDF" : "Export this claim as a PDF"}
      className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-2 border border-white/20 px-0 text-sm font-black text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-400 aria-disabled:cursor-wait aria-disabled:opacity-60 aria-disabled:hover:bg-transparent sm:px-3"
      data-reviewer-export={busy ? "preparing" : "idle"}
      onClick={() => {
        if (!busy) onExport();
      }}
      title={busy ? "Preparing the PDF" : "Export PDF"}
      type="button"
    >
      {busy ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : <FileDown aria-hidden className="h-5 w-5" />}
      <span className="hidden sm:inline">{busy ? "Preparing" : "Export PDF"}</span>
    </button>
  );
}

/**
 * Under the bar: that a PDF is being prepared, or why it was not made. Drawn as the desk's own
 * notices are (desk-undo-bar.tsx); a failure stays until he closes it.
 */
export function DeskExportPdfNote({ note, onDismiss, requestId }: { note: CaseExportNote | null; onDismiss: () => void; requestId: number }) {
  const shown = caseExportNoteOnScreen(note, requestId);
  if (!shown) return null;
  const bad = shown.tone === "bad";
  return (
    <div
      className={`flex min-w-0 items-start justify-between gap-x-3 border-b border-l-[3px] px-3 py-2 text-sm sm:px-4 ${
        bad ? "border-rose-200 border-l-rose-500 bg-rose-50 text-rose-900" : "border-slate-200 border-l-slate-300 bg-slate-50 text-slate-800"
      }`}
      data-reviewer-export-note={shown.tone}
      role={bad ? "alert" : "status"}
    >
      <p className="min-w-0 flex-1 break-words font-semibold leading-5">{shown.message}</p>
      {bad ? (
        <button aria-label="Close the note about the PDF" className="inline-flex h-11 w-11 shrink-0 items-center justify-center hover:bg-black/5 md:h-8 md:w-8" onClick={onDismiss} type="button">
          <X aria-hidden className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
