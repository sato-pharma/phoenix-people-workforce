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

// Every supported kind is shown as the ACTUAL document, never as extracted text: PDFs are
// rasterized page-by-page onto <canvas> elements by pdfjs-dist, images via <img>, and Word
// (.docx) rendered to its real page layout in the browser by docx-preview (fonts, tables,
// columns, embedded images) — the raw bytes come from the same download route, so no
// server-side text extraction is involved.
//
// PDFs deliberately do NOT use an <iframe> pointed at the browser's native PDF viewer, even
// though the download route already supports Content-Disposition: inline for exactly that.
// A real user hit this in production: their Chrome is configured to download PDFs instead of
// displaying them, and that setting applies to EVERY PDF navigation, including a same-origin
// iframe — so the "preview" silently force-downloaded the file with no error, no console
// warning, nothing detectable from our headers (which were already correct: inline
// disposition, frame-ancestors 'self'). That preference lives entirely in each user's own
// browser and we cannot see or override it from here. Rendering the PDF ourselves onto a
// canvas sidesteps the browser's PDF handling entirely — pdfjs-dist just draws pixels, the
// same approach Google Drive/Notion use, so it behaves identically for every user regardless
// of their browser's PDF settings, and also works on mobile (which can't render PDF iframes
// at all).
export function CvPreviewModal({ fileName, mimeType, downloadUrl, onClose, sidePanel }: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });
  const kind = detectCvFileKind(mimeType ?? "", fileName);
  // The Download link needs "attachment" (a real save-file prompt); fetch() for in-page
  // rendering doesn't care either way, but reuses the same inline URL as before for consistency.
  const inlineUrl = `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}disposition=inline`;

  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(kind === "docx" || kind === "pdf");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "docx" && kind !== "pdf") return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(inlineUrl);
        if (!res.ok) throw new Error("Could not load the document.");
        const buffer = await res.arrayBuffer();

        if (kind === "pdf") {
          // pdf.js (library AND worker) are loaded as plain static assets from public/pdfjs/
          // via a NATIVE browser dynamic import — the `webpackIgnore` comment stops the bundler
          // from touching them. This is deliberate, not incidental: pdfjs-dist ships as a
          // prebuilt ESM bundle with its own internal module system, and letting this app's
          // webpack re-bundle it throws `TypeError: Object.defineProperty called on non-object`
          // from webpack's own __webpack_require__.r during evaluation (confirmed locally with
          // BOTH the "build" and "legacy/build" entry points). A native import of a same-origin
          // URL sidesteps the bundler entirely — the same trick pdfjs-dist itself uses for its
          // Node worker (see pdf-dommatrix-polyfill.ts) and OneSignal uses for its SW. Both
          // files are committed under public/pdfjs/, copied from this exact pinned pdfjs-dist
          // version's build/ output by `pnpm run sync:pdfjs-assets` (re-run on a version bump),
          // and must be same-origin to satisfy this app's CSP (`script-src 'self'` /
          // `worker-src 'self' blob:`, next.config.ts).
          // The type-only import gives the API types without emitting any bundled dependency.
          const pdfjsUrl = "/pdfjs/pdf.min.mjs";
          const pdfjsLib = (await import(/* webpackIgnore: true */ pdfjsUrl)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
          pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

          const container = pdfContainerRef.current;
          if (!active || !container) return;
          container.innerHTML = "";

          // isEvalSupported: false — pdf.js otherwise uses eval()/new Function() to JIT-compile
          // embedded font programs for speed, which this app's production CSP forbids
          // (`script-src` has no 'unsafe-eval' outside dev — next.config.ts). pdf.js would detect
          // the blocked eval and fall back anyway, but disabling it explicitly avoids a console
          // CSP violation on every render and makes behavior identical between dev and prod.
          // Rendering correctness is unaffected; only the font-JIT optimization is skipped.
          const doc = await pdfjsLib.getDocument({ data: buffer, isEvalSupported: false }).promise;
          for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            if (!active) return;
            const page = await doc.getPage(pageNumber);
            // Scaled up from the PDF's native 1:1 size for screen legibility — matches roughly
            // what browsers' own PDF viewers default to for a standard CV page.
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.className = "mx-auto mb-3 block bg-white shadow-sm";
            await page.render({ canvas, viewport }).promise;
            if (!active) return;
            container.appendChild(canvas);
          }
          return;
        }

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
      <div className="min-h-full bg-slate-100 p-4">
        {loading ? <p className="p-1 text-sm text-slate-500">Loading preview…</p> : null}
        {error ? <p className="p-1 text-sm text-rose-600">{error}</p> : null}
        {/* One <canvas> per page, painted by pdfjs-dist — see the useEffect above for why this
            isn't an <iframe> on the browser's native PDF viewer. */}
        <div ref={pdfContainerRef} />
      </div>
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
