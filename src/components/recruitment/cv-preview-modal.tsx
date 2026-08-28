"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, X } from "lucide-react";

import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";

type CvDocumentProps = {
  fileName: string;
  mimeType: string | null;
  downloadUrl: string;
  /** Wrapper classes. The document paints its own light page background inside whatever box it gets. */
  className?: string;
  /**
   * Shrink (or grow) the document so a whole page fits the width it is given, and offer a zoom
   * control beside it.
   *
   * ON BY DEFAULT, because the alternative is what shipped on 2026-08-27 and was immediately and
   * correctly rejected: a CV rendered at its true page size in a column narrower than a page.
   * Measured on a 1366px laptop with the screening page open — the Word page is a fixed 816px and
   * the pane it was handed is 652px, so the document overflowed by 164px and the reader got a
   * sideways scrollbar and a squeezed wall of words instead of a CV. PDFs were worse: pdf.js
   * rasterises at scale 1.5, so a US-Letter page is a 918px canvas in that same 652px pane.
   *
   * The full-screen overlay never showed this because it covers the sidebar and hands the document
   * ~986px. The same component in a page, inside the shell, gets 652px. Fitting the width means the
   * document is legible at whatever width it is actually given, which is the only version of this
   * that survives someone opening it on a smaller screen.
   */
  fitToWidth?: boolean;
};

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
// The bytes arrive base64-encoded as plain text — src/lib/recruitment/file-response.ts explains
// why they cannot be sent as a PDF. atob yields a binary string; copy it out into real bytes.
// The ArrayBuffer is allocated explicitly rather than by length: `new Uint8Array(n)` is typed
// Uint8Array<ArrayBufferLike>, which BlobPart rejects because it could be a SharedArrayBuffer.
function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** How far the reader may push the zoom by hand, and the step the buttons move in. */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.15;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * The CV itself, rendered in place — no dialog, no chrome, no close button.
 *
 * Split out of CvPreviewModal on 2026-08-24 so screening mode can stand the document beside the
 * candidate's facts instead of stacking a modal on top of a drawer on top of a table. Every format
 * quirk documented below was learned the hard way and none of it is duplicated: the modal now
 * renders this component too, so both paths cannot drift.
 */
export function CvDocumentView({ className, downloadUrl, fileName, mimeType, fitToWidth = true }: CvDocumentProps) {
  const kind = detectCvFileKind(mimeType ?? "", fileName);
  const separator = downloadUrl.includes("?") ? "&" : "?";
  // The Download link needs "attachment" (a real save-file prompt); "inline" is for the
  // open-in-a-tab escape hatch and the <img> source.
  const inlineUrl = `${downloadUrl}${separator}disposition=inline`;
  // The in-page renderer deliberately does NOT fetch inlineUrl. A download-manager extension
  // CANCELS any request whose response looks like a PDF so it can take the file itself, which
  // surfaced in production as a bare "Failed to fetch" with nothing rendered while the very same
  // URL downloaded fine through the extension. base64-as-text gives it nothing to match on.
  const bytesUrl = `${downloadUrl}${separator}format=base64`;

  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(kind === "docx" || kind === "pdf" || kind === "image");
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // ── Fit to the width we were actually given ────────────────────────────────
  //
  // Only pdf and docx: both paint a page at a fixed pixel width that has nothing to do with the
  // column it lands in. An image already fits — ZoomablePhoto constrains it and opens full screen
  // on a click — and the "no preview for this type" notice is a sentence, not a page.
  const canFit = fitToWidth && (kind === "pdf" || kind === "docx");
  const paneRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** The document's own page width in CSS pixels, measured once while nothing is zoomed. */
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  /** null = follow the width. A number = the reader took over with the +/- buttons. */
  const [manualZoom, setManualZoom] = useState<number | null>(null);

  // Measure the page ONCE, the first time the document has finished painting. It has to happen at
  // zoom 1 or the reading is in already-scaled pixels and every resize would compound the last
  // one — which is why naturalWidth gates the fit below rather than being recomputed from it.
  useEffect(() => {
    if (!canFit || loading || naturalWidth !== null) return;
    const content = contentRef.current;
    if (!content) return;
    // The PAGE element, not the scroll width of the container. scrollWidth is the wrong number
    // here and misleadingly close to the right one: measured live, a 816px Word page inside a
    // 637px pane reported scrollWidth 727, because the wrapper and the page each carry their own
    // padding and the overflow is only partly counted. `.docx` is docx-preview's page section and
    // `canvas` is one rasterised PDF page; both are the real thing a reader is trying to fit.
    const pages = content.querySelectorAll<HTMLElement>(".docx, canvas");
    let measured = 0;
    for (const page of pages) measured = Math.max(measured, page.getBoundingClientRect().width);
    // Padding around the page, so "fit" leaves the document a margin instead of jamming it edge
    // to edge against the panel beside it.
    if (measured > 0) setNaturalWidth(measured + 32);
  }, [canFit, loading, naturalWidth]);

  // And re-fit whenever the column changes size — the screening page has a collapsible facts panel
  // beside the document, so this is not only about someone resizing a window.
  useEffect(() => {
    if (!canFit) return;
    const pane = paneRef.current;
    if (!pane) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setPaneWidth(width);
    });
    observer.observe(pane);
    setPaneWidth(pane.clientWidth || null);
    return () => observer.disconnect();
  }, [canFit]);

  // Fit only ever SHRINKS. Capped at 1 on purpose: a pane wider than the page would otherwise blow
  // the document up to fill it, which upscales pdf.js's raster into a blurry page and silently
  // changes the modal — where the document already fits and nobody complained — into something
  // nobody asked for. This exists to fix a document too big for its column, and that is all it does
  // by itself. Wanting it larger is a real thing to want, and it is what the + button is for.
  const fitZoom = canFit && naturalWidth && paneWidth ? clampZoom(Math.min(1, paneWidth / naturalWidth)) : 1;
  const zoom = manualZoom ?? fitZoom;
  // Nothing to offer until the page has been measured; a zoom control that reads 100% while the
  // document is still blank invites a click that does nothing.
  const showZoomControl = canFit && naturalWidth !== null && !error;

  useEffect(() => {
    if (kind !== "docx" && kind !== "pdf" && kind !== "image") return;
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(bytesUrl);
        if (!res.ok) throw new Error("Could not load the document.");
        const bytes = base64ToBytes(await res.text());

        if (kind === "image") {
          // Same reasoning as the PDF path below: the bytes are already in hand, so the <img>
          // never issues a second request that a download-manager extension could intercept.
          // Photographed CVs arrive this way over WhatsApp, so this is a real intake path.
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType ?? "image/jpeg" }));
          if (!active) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          setImageUrl(objectUrl);
          return;
        }

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
          const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
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
        const sig = bytes.subarray(0, 4);
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
        await renderAsync(new Blob([bytes]), container, undefined, {
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, bytesUrl, mimeType]);


  // A failed in-page render must never be a dead end. Whatever went wrong — a document the
  // renderer cannot read, a dropped connection, or a lazily-loaded chunk that no longer exists
  // because production redeployed while this tab was open (which surfaces as the browser's own
  // bare "Failed to fetch" text) — the reader still needs to READ the CV. So the failure notice
  // always carries a direct inline link to the real file, which does not depend on any of the
  // in-page rendering that just failed.
  const failureNotice = error ? (
    <div className="p-1 text-sm">
      <p className="text-rose-600">{error}</p>
      <p className="mt-1">
        <a
          className="font-semibold text-slate-900 underline underline-offset-2"
          href={inlineUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open the CV in a new tab
        </a>
      </p>
    </div>
  ) : null;

  const documentBody =
    kind === "pdf" ? (
      <div className="min-h-full bg-slate-100 p-4">
        {loading ? <p className="p-1 text-sm text-slate-500">Loading preview…</p> : null}
        {failureNotice}
        {/* One <canvas> per page, painted by pdfjs-dist — see the useEffect above for why this
            isn't an <iframe> on the browser's native PDF viewer. */}
        <div ref={pdfContainerRef} />
      </div>
    ) : kind === "image" ? (
      <div className="min-h-full bg-slate-100 p-4">
        {loading ? <p className="p-1 text-sm text-slate-500">Loading preview…</p> : null}
        {failureNotice}
        {imageUrl ? (
          // Photographed CVs arrive over WhatsApp at phone-camera resolution and are unreadable
          // scaled into this panel, so the image opens full screen and zooms.
          <ZoomablePhoto alt={fileName} caption={fileName} className="mx-auto max-h-full max-w-full object-contain" src={imageUrl} />
        ) : null}
      </div>
    ) : kind === "docx" ? (
      <div className="min-h-full bg-slate-100 p-4">
        {loading ? <p className="p-1 text-sm text-slate-500">Loading preview…</p> : null}
        {failureNotice}
        {/* docx-preview renders its own page-styled markup into this container. */}
        <div ref={docxContainerRef} />
      </div>
    ) : (
      <p className="p-5 text-sm text-slate-500">
        Preview isn&apos;t available for this file type — use Download instead.
      </p>
    );


  if (!canFit) return <div className={className}>{documentBody}</div>;

  return (
    <div className={className} ref={paneRef}>
      {showZoomControl ? (
        // Sticky, because the reason to reach for it is usually three pages down. Small and quiet:
        // this is a reading surface, and a toolbar that competes with the CV for attention has
        // already lost the point.
        <div className="sticky top-0 z-10 flex items-center justify-end gap-1 border-b border-slate-200/70 bg-slate-100/90 px-3 py-1.5 backdrop-blur">
          <button
            aria-label="Zoom out"
            className="rounded p-1 text-slate-600 transition hover:bg-white hover:text-slate-900 disabled:opacity-40"
            disabled={zoom <= MIN_ZOOM + 0.001}
            onClick={() => setManualZoom(clampZoom(zoom - ZOOM_STEP))}
            type="button"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[3.25rem] text-center text-[11px] font-bold tabular-nums text-slate-700">
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            className="rounded p-1 text-slate-600 transition hover:bg-white hover:text-slate-900 disabled:opacity-40"
            disabled={zoom >= MAX_ZOOM - 0.001}
            onClick={() => setManualZoom(clampZoom(zoom + ZOOM_STEP))}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            className={`ml-1 rounded px-2 py-1 text-[11px] font-bold transition ${
              manualZoom === null ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white hover:text-slate-900"
            }`}
            onClick={() => setManualZoom(null)}
            title="Fit a whole page to this column, and keep fitting it when the column changes size"
            type="button"
          >
            Fit width
          </button>
        </div>
      ) : null}
      {/*
        CSS `zoom`, not `transform: scale()`, and that is the whole reason this is three lines
        instead of thirty. `transform` does not affect layout: the scaled document keeps its
        original box, so the scroll container ends up with the height of an unscaled page and
        either clips the bottom or leaves a screen of empty grey under it, and every fix for that
        means recomputing a height by hand on every resize. `zoom` reflows, so the container is
        simply the right size and scrolling is correct with no arithmetic at all.
      */}
      <div ref={contentRef} style={{ zoom }}>
        {documentBody}
      </div>
    </div>
  );
}

export function CvPreviewModal({ fileName, mimeType, downloadUrl, onClose, sidePanel }: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });

  if (typeof document === "undefined") return null;

  const documentBody = <CvDocumentView downloadUrl={downloadUrl} fileName={fileName} mimeType={mimeType} />;

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/65 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview — ${fileName}`}
        className={`flex h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.3)] ${
          sidePanel ? "max-w-6xl" : "max-w-3xl"
        }`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-phx-line px-5 py-3">
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
              className="rounded-md p-1 text-phx-ink-soft transition hover:bg-phx-paper-2 hover:text-slate-900"
              onClick={onClose}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {sidePanel ? (
          <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
            <div className="flex-1 overflow-auto bg-slate-50 lg:border-r lg:border-phx-line">{documentBody}</div>
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
