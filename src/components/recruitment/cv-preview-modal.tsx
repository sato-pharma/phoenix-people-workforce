"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";

type Props = {
  fileName: string;
  mimeType: string | null;
  downloadUrl: string;
  onClose: () => void;
  // Renders a second column next to the document (e.g. the candidate's currently-saved
  // fields, for comparing them against the source CV). Omitted -> unchanged single-column
  // modal, exactly as every existing caller already renders it.
  sidePanel?: ReactNode;
};

// Every supported kind is shown as the ACTUAL document, never as extracted text: PDFs via an
// iframe on the download route, images via <img>, and Word (.docx) rendered to its real page
// layout in the browser by docx-preview (fonts, tables, columns, embedded images) — the raw
// bytes come from the same download route, so no server-side text extraction is involved.
export function CvPreviewModal({ fileName, mimeType, downloadUrl, onClose, sidePanel }: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });
  const kind = detectCvFileKind(mimeType ?? "", fileName);
  // The Download link needs "attachment" (a real save-file prompt); the iframe needs "inline" —
  // Chrome/Edge force-download ANY iframe navigation whose response says "attachment", which
  // would otherwise render nothing here at all.
  const inlineUrl = `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}disposition=inline`;

  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(kind === "docx");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "docx") return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(inlineUrl);
        if (!res.ok) throw new Error("Could not load the document.");
        const buffer = await res.arrayBuffer();
        // Only the modern .docx (OOXML) format is a ZIP archive ("PK\x03\x04"); docx-preview can
        // render only that. detectCvFileKind maps the legacy binary .doc (application/msword) to
        // "docx" too, so guard on the actual bytes and give those a clear "download to open"
        // message instead of letting renderAsync throw an opaque unzip error. mammoth (the old
        // text path) couldn't read legacy .doc either — this isn't a new limitation, just a
        // clearer one.
        const sig = new Uint8Array(buffer.slice(0, 4));
        const isOoxmlZip = sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04;
        if (!isOoxmlZip) {
          throw new Error("This is an older Word (.doc) format that can't be previewed here — use Download to open it.");
        }
        // docx-preview relies on browser-only APIs, so it's dynamically imported here rather than
        // at module scope (this component is "use client", but the import still must not run during
        // any server pass). renderAsync paints the real Word layout into the container element.
        const { renderAsync } = await import("docx-preview");
        const container = docxContainerRef.current;
        if (!active || !container) return;
        container.innerHTML = "";
        await renderAsync(new Blob([buffer]), container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
        });
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "This document couldn't be previewed — use Download to open it.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [kind, inlineUrl]);

  if (typeof document === "undefined") return null;

  const documentBody =
    kind === "pdf" ? (
      <iframe className="h-full w-full" src={inlineUrl} title={fileName} />
    ) : kind === "image" ? (
      // <img> fetches the resource directly rather than navigating the way an <iframe> does, so
      // it renders fine even under "attachment" — but it's pointed at the same inline URL as the
      // iframe above for consistency, and in case a browser ever changes that behavior.
      // eslint-disable-next-line @next/next/no-img-element -- Drive-hosted CV bytes behind our own API route, not a static asset next/image can optimize
      <img alt={fileName} className="mx-auto max-h-full max-w-full object-contain" src={inlineUrl} />
    ) : kind === "docx" ? (
      <div className="min-h-full bg-slate-100 p-4">
        {loading ? <p className="p-1 text-sm text-slate-500">Loading preview…</p> : null}
        {error ? <p className="p-1 text-sm text-rose-600">{error}</p> : null}
        {/* docx-preview renders its own page-styled markup into this container. */}
        <div ref={docxContainerRef} />
      </div>
    ) : (
      <p className="p-5 text-sm text-slate-500">
        Preview isn&apos;t available for this file type — use Download instead.
      </p>
    );

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview — ${fileName}`}
        className={`flex h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)] ${
          sidePanel ? "max-w-6xl" : "max-w-3xl"
        }`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-[#E2E8F0] px-5 py-3">
          <p className="truncate text-sm font-semibold text-slate-900">{fileName}</p>
          <div className="flex items-center gap-3">
            <a
              className="text-xs font-semibold text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
              href={downloadUrl}
              rel="noreferrer"
              target="_blank"
            >
              Download
            </a>
            <button
              aria-label="Close"
              className="rounded-md p-1 text-[#64748B] transition hover:bg-[#F1F5F9] hover:text-slate-900"
              onClick={onClose}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {sidePanel ? (
          <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
            <div className="flex-1 overflow-auto bg-slate-50 lg:border-r lg:border-[#E2E8F0]">{documentBody}</div>
            <div className="w-full shrink-0 overflow-auto p-5 lg:w-[360px]">{sidePanel}</div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-slate-50">{documentBody}</div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
