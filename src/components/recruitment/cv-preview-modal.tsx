"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";

type Props = {
  fileName: string;
  mimeType: string | null;
  downloadUrl: string;
  previewTextUrl: string;
  onClose: () => void;
};

// PDFs render natively via an iframe pointed at the existing download route; DOCX text is
// fetched on demand from the sibling preview-text route (see the two new routes under
// app/api/recruitment/files/[id]/ and app/api/recruitment/hiring-manager/candidates/
// [candidateId]/files/[fileId]/). Unsupported kinds (scanned images) just point at Download.
export function CvPreviewModal({ fileName, mimeType, downloadUrl, previewTextUrl, onClose }: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });
  const kind = detectCvFileKind(mimeType ?? "", fileName);

  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind === "docx");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "docx") return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(previewTextUrl);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Preview failed.");
        if (active) setText(typeof data.text === "string" ? data.text : "");
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Preview failed.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [kind, previewTextUrl]);

  if (typeof document === "undefined") return null;

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview — ${fileName}`}
        className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-[#D8E0EA] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)]"
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

        <div className="flex-1 overflow-auto bg-slate-50">
          {kind === "pdf" ? (
            <iframe className="h-full w-full" src={downloadUrl} title={fileName} />
          ) : kind === "docx" ? (
            loading ? (
              <p className="p-5 text-sm text-slate-500">Loading preview…</p>
            ) : error ? (
              <p className="p-5 text-sm text-rose-600">{error}</p>
            ) : (
              <pre className="whitespace-pre-wrap p-5 text-sm text-slate-700">{text}</pre>
            )
          ) : (
            <p className="p-5 text-sm text-slate-500">
              Preview isn&apos;t available for this file type — use Download instead.
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
