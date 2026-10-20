"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Download, FileText, Minus, Plus, X } from "lucide-react";

import {
  adminControlDepthClassName,
  adminPanelHeaderClassName,
  adminRecessedDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { reportClientError } from "@/lib/error-monitor/report-client-error";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { buildCvPreviewFailureReport, CvPreviewNotice, type CvPreviewStage } from "@/lib/recruitment/cv-preview-failure-report";
import { hasPhoneLike, maskPhoneLike } from "@/lib/recruitment/cv-phone-redaction";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, clampZoom, cvFitZoom } from "@/components/recruitment/cv-fit-zoom";

/**
 * May the reader take a COPY of this document away?
 *
 * TRUE everywhere it has always been true — the recruitment workspace, screening, the CV database —
 * and, on the manager's portal, TRUE only for the manager holding the "I will call" reservation on
 * that CV. The owner blocked the portal download on 2026-09-09 (*"the download to be blocked of the
 * cv"*) and on 2026-10-13 asked for it back; the original file prints the phone number the
 * reservation reveals, so he chose: download only after "I will call".
 *
 * IT IS NOT WHAT ENFORCES THE RULE, and must never be mistaken for it. Hiding a link is UX. The
 * file route itself hands the real file only to the reservation holder and otherwise answers the
 * in-page base64 render — see
 * app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts. This flag
 * exists so the screen does not offer a control that the server would then refuse, which reads as a
 * broken button rather than as a decision.
 */
type CvDownloadAllowance = {
  allowDownload?: boolean;
  /**
   * Paint out every phone number PRINTED ON THE DOCUMENT.
   *
   * TRUE on a manager's portal for any CV he has not reserved, FALSE everywhere else. Hiding the
   * database field was never the whole job: a CV prints its own contact details, usually beside a
   * telephone icon in 14pt, so the number the screen had just taken away was back the instant he
   * pressed View CV. The owner, 2026-09-09, on seeing exactly that: *"when I press on view the CV
   * the number is clearly showing"*.
   *
   * It covers what CAN be covered. A PDF and a Word file carry their text as text, so the runs are
   * found and painted over. A PHOTOGRAPHED CV is pixels, with nothing to find without optical
   * character recognition, so it is not shown at all until he takes the call — 41 of the 1,188 CVs
   * on record, measured 2026-09-09. Showing those anyway would make every other redaction on this
   * screen decorative, since a manager who wants a number would simply learn to look there.
   */
  redactPhones?: boolean;
};

type CvDocumentProps = CvDownloadAllowance & {
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
  /**
   * What the fit fits. "width" (the default, every caller before 2026-10-20): a whole page across.
   * "page": the WHOLE of page 1, across and down, inside the box it is given — the recruitment
   * workspace's half-page CV (owner, 2026-10-20: "the cv 1 page is fully appearing with no need to
   * scroll"). That box must have a definite height. An old Word .doc is read as one long text page
   * with no page breaks, so it has no page 1 to fit and stays at fit width.
   */
  fit?: "width" | "page";
  /**
   * Draw the zoom controls into this element (the caller's own toolbar row) instead of a sticky bar
   * over the document, so they cost the document no height. Null or absent: the sticky bar.
   */
  toolbarTarget?: HTMLElement | null;
};

type Props = CvDownloadAllowance & {
  fileName: string;
  mimeType: string | null;
  downloadUrl: string;
  onClose: () => void;
  // Renders a second column next to the document (e.g. the candidate's currently-saved
  // fields, for comparing them against the source CV). Omitted -> unchanged single-column
  // modal, exactly as every existing caller already renders it.
  sidePanel?: ReactNode;
  // On a phone the stacked side panel normally sits BELOW the document, which is at least 60% of the
  // screen tall. A caller whose panel is something to act on (the interview's "How it went") sets this
  // so it sits above the document below `lg`; side-by-side columns are unchanged.
  sidePanelFirstOnPhone?: boolean;
  // Controls beside Download in the header — the Schedule interview button, from a caller that knows
  // which candidate the CV belongs to. Omitted -> the header is unchanged.
  headerActions?: ReactNode;
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

/** The sticky zoom bar's own height (a 32px button, 6px above and below, a 1px rule). */
const ZOOM_BAR_HEIGHT = 45;

/**
 * The CV itself, rendered in place — no dialog, no chrome, no close button.
 *
 * Split out of CvPreviewModal on 2026-08-24 so screening mode can stand the document beside the
 * candidate's facts instead of stacking a modal on top of a drawer on top of a table. Every format
 * quirk documented below was learned the hard way and none of it is duplicated: the modal now
 * renders this component too, so both paths cannot drift.
 */
export function CvDocumentView({
  allowDownload = true,
  className,
  downloadUrl,
  fileName,
  mimeType,
  redactPhones = false,
  fitToWidth = true,
  fit = "width",
  toolbarTarget = null,
}: CvDocumentProps) {
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
  // The Word 97-2003 binary .doc, read into its own lines on the server. Nothing in a browser can
  // open that format — see the legacy branch in the loader below, and legacy-doc-text.ts.
  const docTextUrl = `${downloadUrl}${separator}format=doc-text`;

  const docxContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(kind === "docx" || kind === "pdf" || kind === "image");
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  /**
   * The lines of a legacy .doc, once read. Null for every other format, and before they arrive.
   *
   * It carries the URL they came FROM, so nothing has to reset it: a reader moving from one legacy
   * .doc to another — or from one to a PDF — would otherwise see the previous candidate's words
   * under the new candidate's name for as long as the new read takes. Derived rather than cleared in
   * the loader, because clearing it there is a setState in an effect body, which this repo's lint
   * rules refuse (react-hooks/set-state-in-effect).
   */
  const [docText, setDocText] = useState<{ lines: string[]; truncated: boolean; url: string } | null>(null);
  const docLines = docText && docText.url === docTextUrl ? docText.lines : null;
  const docTruncated = Boolean(docText && docText.url === docTextUrl && docText.truncated);

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
  /** Page 1's own height, measured with the width. Null for a legacy .doc, which has no pages. */
  const [naturalHeight, setNaturalHeight] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [paneHeight, setPaneHeight] = useState<number | null>(null);
  /** null = follow the fit. A number = the reader took over with the +/- buttons. */
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  /** Which fit "follow the fit" means: the caller's, until the reader presses the other one. */
  const [fitMode, setFitMode] = useState<"width" | "page">(fit);

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
    // `canvas` is one rasterised PDF page; `.cv-text-page` is a legacy .doc read as text, which is
    // dressed at the same fixed Word width so it fits by the same mechanism as the other two. All
    // three are the real thing a reader is trying to fit.
    const pages = content.querySelectorAll<HTMLElement>(".docx, .cv-text-page, canvas");
    let measured = 0;
    for (const page of pages) measured = Math.max(measured, page.getBoundingClientRect().width);
    // Page 1's height, for "fit page": the first rasterised PDF page or the first Word page section.
    // A legacy .doc is one long `.cv-text-page` with no page breaks — nothing to fit down to.
    const first = content.querySelector<HTMLElement>(".docx, canvas");
    const firstHeight = first && !content.querySelector(".cv-text-page") ? first.getBoundingClientRect().height : 0;
    // Padding around the page, so "fit" leaves the document a margin instead of jamming it edge
    // to edge against the panel beside it.
    if (measured > 0) setNaturalWidth(measured + 32);
    if (firstHeight > 0) setNaturalHeight(firstHeight + 32);
  }, [canFit, loading, naturalWidth]);

  // And re-fit whenever the column changes size — the screening page has a collapsible facts panel
  // beside the document, so this is not only about someone resizing a window.
  useEffect(() => {
    if (!canFit) return;
    const pane = paneRef.current;
    if (!pane) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const height = entries[0]?.contentRect.height ?? 0;
      if (width > 0) setPaneWidth(width);
      if (height > 0) setPaneHeight(height);
    });
    observer.observe(pane);
    setPaneWidth(pane.clientWidth || null);
    setPaneHeight(pane.clientHeight || null);
    return () => observer.disconnect();
  }, [canFit]);

  // Fit only ever SHRINKS. Capped at 1 on purpose: a pane wider than the page would otherwise blow
  // the document up to fill it, which upscales pdf.js's raster into a blurry page and silently
  // changes the modal — where the document already fits and nobody complained — into something
  // nobody asked for. This exists to fix a document too big for its column, and that is all it does
  // by itself. Wanting it larger is a real thing to want, and it is what the + button is for.
  // Nothing to offer until the page has been measured; a zoom control that reads 100% while the
  // document is still blank invites a click that does nothing.
  const showZoomControl = canFit && naturalWidth !== null && !error;
  // "Fit page" is only on offer where there is a page 1 to fit; the bar, when it sits over the
  // document, is height the page cannot use.
  const canFitPage = naturalHeight !== null;
  const activeFit: "width" | "page" = canFitPage ? fitMode : "width";
  const barInside = showZoomControl && !toolbarTarget;
  const fitZoom = canFit
    ? cvFitZoom({
        mode: activeFit,
        pageHeight: naturalHeight,
        pageWidth: naturalWidth,
        paneHeight: paneHeight === null ? null : paneHeight - (barInside ? ZOOM_BAR_HEIGHT : 0),
        paneWidth,
      })
    : 1;
  const zoom = manualZoom ?? fitZoom;

  useEffect(() => {
    if (kind !== "docx" && kind !== "pdf" && kind !== "image") return;
    let active = true;
    let objectUrl: string | null = null;
    // Where the load had got to when it failed, for the error monitor only — see the catch below.
    let stage: CvPreviewStage = "fetch";
    let httpStatus: number | null = null;
    void (async () => {
      try {
        const res = await fetch(bytesUrl);
        httpStatus = res.status;
        if (!res.ok) throw new Error("Could not load the document.");
        stage = "decode";
        const bytes = base64ToBytes(await res.text());
        stage = "render";

        if (kind === "image") {
          // A PHOTOGRAPHED CV CANNOT BE REDACTED, so where redaction is required it is not shown.
          // There is no text to find in a photograph, and every other number on this screen is
          // hidden — leaving this one window open would just teach a manager where to look.
          if (redactPhones) {
            throw new CvPreviewNotice(
              "This CV is a photograph, so the phone number printed on it cannot be covered. "
                + "Press \"I will call\" to take this candidate, and it opens.",
            );
          }
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
          // version's LEGACY build output by `pnpm run sync:pdfjs-assets` (re-run on a version
          // bump) — never the modern build, which fails on older phone browsers with
          // "Promise.withResolvers is not a function" (tests/pdfjs-legacy-browser-assets.test.ts),
          // and must be same-origin to satisfy this app's CSP (`script-src 'self'` /
          // `worker-src 'self' blob:`, next.config.ts).
          // The type-only import gives the API types without emitting any bundled dependency.
          const pdfjsUrl = "/pdfjs/pdf.min.mjs";
          const pdfjsLib = (await import(/* webpackIgnore: true */ pdfjsUrl)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
          pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

          const container = pdfContainerRef.current;
          if (!active || !container) return;
          container.innerHTML = "";

          // ── THE WORDS ON THE PAGE CAN BE SELECTED AND COPIED ──────────────────────────────────
          //
          // A canvas is a picture, so until 2026-09-18 a recruiter could not select a single word of
          // a PDF CV — not a name to search, not an email to paste, not a university to look up. The
          // owner asked for it in both tabs in plain words: "I can select, I can copy". Word CVs
          // never had the problem (docx-preview paints real text), and a photographed CV has no text
          // to select at all.
          //
          // pdf.js's own answer is its TEXT LAYER: the page's text laid over the canvas as invisible
          // spans at the exact positions the glyphs were drawn, so a drag selects what the eye sees
          // and a copy carries the words. The ink still comes from the canvas; the spans are
          // transparent and only the selection tint shows (`.cv-text-layer` in app/globals.css).
          //
          // NEVER WHERE THE READER MAY NOT TAKE THE DOCUMENT AWAY, and never on a redacted page.
          // A manager without the reservation has no download (allowDownload=false), and copying
          // every word out is the download by another name. And a redacted page covers the phone numbers on the
          // CANVAS only — the text under a black box is still text, so a layer over it would hand
          // back, invisibly and one drag away, the exact number the box was painted to hide.
          const selectable = allowDownload && !redactPhones;

          // `isEvalSupported: false` stood here until the pdf.js 6 bump, because pdf.js 5 otherwise
          // JIT-compiled embedded font programs with eval()/new Function() and this app's
          // production CSP forbids that (`script-src` has no 'unsafe-eval' outside dev —
          // next.config.ts). pdf.js 6 REMOVED the option along with the eval it guarded, so there
          // is nothing left to switch off and the type no longer accepts it.
          //
          // `wasmUrl` is what must be right now, and it is NOT optional here. pdf.js 6 moved the
          // JBIG2 and CCITTFax decoders — which is how scanned and faxed documents are encoded,
          // i.e. a large share of the CVs this modal exists to show — out of the JS bundle and into
          // jbig2.wasm, joining the JPEG2000 and ICC modules that were already external. It fetches
          // `${wasmUrl}${filename}` and the default is null, so leaving this unset renders every
          // scanned CV blank while an ordinary one still looks perfect — a failure that would reach
          // production looking like "some CVs are broken". The files are committed under
          // public/pdfjs/wasm/ by `pnpm run sync:pdfjs-assets`, same-origin because the CSP allows
          // no other, and 'wasm-unsafe-eval' is already in script-src (it is there for Maps).
          const doc = await pdfjsLib.getDocument({ data: bytes, wasmUrl: "/pdfjs/wasm/" }).promise;
          for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            if (!active) return;
            const page = await doc.getPage(pageNumber);
            // Scaled up from the PDF's native 1:1 size for screen legibility — matches roughly
            // what browsers' own PDF viewers default to for a standard CV page.
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.className = "block bg-white shadow-sm";
            // NEVER SHRUNK BY THE SHELL. The admin shell caps every canvas at its container's width
            // (`.admin-shell :where(... canvas ...)` in app/globals.css, unlayered, so no utility
            // class can undo it — only an inline style). A capped canvas is drawn smaller than its own
            // pixels while the text layer keeps the page's true size, so every selection would land
            // beside the word it belongs to. Fitting the page to its column is the zoom's job below,
            // and the zoom shrinks the canvas and its text together.
            canvas.style.maxWidth = "none";
            await page.render({ canvas, viewport }).promise;
            if (!active) return;

            // ── PAINT OUT THE PHONE NUMBERS PRINTED ON THE PAGE ──────────────────────────────
            //
            // AFTER the render, onto the same canvas, so what the reader sees and what any copy of
            // it would contain are the one image. A redacted page never gets a text layer (see
            // `selectable` above) and there is no second copy of the page anywhere: pdf.js draws
            // pixels, and the covered pixels are simply never drawn back.
            //
            // The whole TEXT ITEM is covered rather than the matching characters inside it. An item
            // is one run in the PDF's own layout, which for a contact line is the number by itself,
            // and measuring a sub-span means re-deriving glyph advances from a font this code has
            // not loaded. Covering the run errs towards hiding, which is the safe direction here.
            //
            // AND IT FAILS TOWARDS HIDING. Reading the text can itself throw — pdf.js 6 drains its
            // text stream with `for await`, which every Safari and Chromium before 124 cannot do
            // over a ReadableStream (scripts/pdfjs-browser-polyfill.mjs now covers it, and that is
            // the fix). But a page whose text cannot be read is a page whose numbers cannot be
            // found, and the canvas beside it is already painted with them on it. So the catch
            // covers the WHOLE page rather than letting it through: the reader gets a blank sheet
            // and the monitor gets a row, never a phone number the screen was built to hide.
            if (redactPhones) {
              const context = canvas.getContext("2d");
              let content: Awaited<ReturnType<typeof page.getTextContent>> | null = null;
              try {
                content = await page.getTextContent();
              } catch (redactionError) {
                if (context) {
                  context.fillStyle = "#0f172a";
                  context.fillRect(0, 0, canvas.width, canvas.height);
                }
                const report = buildCvPreviewFailureReport({
                  caught: redactionError,
                  fileName,
                  httpStatus,
                  kind,
                  route: typeof window !== "undefined" ? window.location.pathname : null,
                  stage: "redaction",
                });
                if (report) reportClientError(report);
              }
              if (context && content) {
                context.fillStyle = "#0f172a";
                for (const item of content.items) {
                  const textItem = item as { str?: string; transform?: number[]; width?: number; height?: number };
                  if (!textItem.str || !hasPhoneLike(textItem.str) || !textItem.transform) continue;
                  // The item's own matrix through the viewport's gives its box in canvas pixels.
                  // transform[4]/[5] are the baseline origin, so the box starts one height above it.
                  const placed = pdfjsLib.Util.transform(viewport.transform, textItem.transform);
                  const height = (textItem.height ?? 0) * viewport.scale || Math.abs(placed[3]) || 12;
                  const width = (textItem.width ?? 0) * viewport.scale;
                  if (width <= 0) continue;
                  // ROUNDED OUTWARD, then bled. Both halves matter and both were measured.
                  //
                  // A text item lands on fractional device pixels, so filling at those coordinates
                  // anti-aliases the edge and can leave a readable sliver of a digit along it —
                  // caught on 2026-09-09 by counting light pixels inside the box against a version
                  // that rounded first, where the same box left none. Flooring the origin and
                  // ceiling the size guarantees whole pixels; the bleed then covers ink that sits
                  // outside its own reported box, which is ordinary for a glyph with a descender.
                  const left = Math.floor(placed[4]) - 3;
                  const top = Math.floor(placed[5] - height) - 3;
                  context.fillRect(left, top, Math.ceil(width) + 6, Math.ceil(height) + 6);
                }
              }
            }

            // One box per page, holding the canvas and — when the text may be taken — the layer
            // over it. `w-fit` makes the box exactly the canvas, which is what the layer's own
            // width and its percentage positions are measured against.
            const pageBox = document.createElement("div");
            pageBox.className = "relative mx-auto mb-3 w-fit";
            pageBox.appendChild(canvas);
            container.appendChild(pageBox);

            if (selectable) {
              // pdf.js sizes the layer and every run of text from these three custom properties.
              // The scale is the canvas's: this canvas is drawn at `viewport.scale` CSS pixels per
              // PDF unit (times the page's own user unit), and nothing else resizes it but the zoom.
              pageBox.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
              pageBox.style.setProperty("--scale-round-x", "1px");
              pageBox.style.setProperty("--scale-round-y", "1px");
              const textLayer = document.createElement("div");
              textLayer.className = "cv-text-layer";
              pageBox.appendChild(textLayer);
              try {
                await new pdfjsLib.TextLayer({
                  container: textLayer,
                  textContentSource: page.streamTextContent(),
                  viewport,
                }).render();
              } catch (layerError) {
                // A page whose text cannot be laid out is still a page that can be READ, so this
                // never takes the CV down with it: the layer goes, the picture stays, and the
                // monitor hears about it under its own stage.
                textLayer.remove();
                const report = buildCvPreviewFailureReport({
                  caught: layerError,
                  fileName,
                  httpStatus,
                  kind,
                  route: typeof window !== "undefined" ? window.location.pathname : null,
                  stage: "text-layer",
                });
                if (report) reportClientError(report);
              }
              if (!active) return;
            }
          }
          return;
        }

        // Only the modern .docx (OOXML) format is a ZIP archive ("PK\x03\x04"), and docx-preview can
        // render only that. detectCvFileKind answers "docx" for the legacy binary .doc as well — it
        // means "a Word file", not "the modern format" — so the fork is on the actual BYTES, never on
        // the label, which this corpus proves wrong in both directions (cv-file-kind.ts). Handing a
        // binary .doc to renderAsync throws an opaque unzip error; it goes down the branch below
        // instead.
        const sig = bytes.subarray(0, 4);
        const isOoxmlZip = sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04;
        if (!isOoxmlZip) {
          // ── A WORD 97-2003 .doc IS READ AS TEXT, ON THE SERVER ──────────────────────────────
          //
          // Until 2026-09-27 this was where the preview gave up: "This is an older Word (.doc)
          // format that can't be previewed here", plus a link to download it and open it in Word —
          // and for a manager, who may not download, not even that. The owner hit it on a CV that
          // arrived the same day. There are 13 such files on production and they keep coming, since
          // an applicant sending a CV he wrote in 2009 has no idea his file is a different format.
          //
          // The one reader for it runs only in Node (legacy-doc-text.ts), so the lines are fetched
          // rather than parsed here. That IS a second request for the same document — these bytes
          // cannot be re-used, because sending them back up would mean posting a CV to a route that
          // then has to be trusted to be reading the file it was handed. For a format this rare the
          // honest cost is one more GET.
          const textRes = await fetch(docTextUrl);
          httpStatus = textRes.status;
          if (!textRes.ok) throw new Error("This Word 97-2003 document could not be read.");
          const payload = (await textRes.json()) as { paragraphs?: string[]; truncated?: boolean };
          const lines = payload.paragraphs ?? [];
          // No text at all is not a failure to report: it is an OLE2 file that is not a Word
          // document, or one whose content is a single scanned picture. Either way there is nothing
          // to put on the screen, and saying so is the answer.
          if (lines.length === 0) {
            throw new CvPreviewNotice("This older Word (.doc) file holds no text that can be shown on screen.");
          }
          if (!active) return;
          setDocText({ lines, truncated: Boolean(payload.truncated), url: docTextUrl });
          return;
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

        // The Word half of the same rule. docx-preview paints real DOM, so the numbers are text
        // nodes and are rewritten in place — masked to the SAME LENGTH, so the page keeps the
        // layout the applicant gave it and the reader can see where something was taken out. Done
        // after renderAsync rather than on the source, because the source is a zip of XML and the
        // thing that has to be clean is what ends up on the screen.
        if (redactPhones) {
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
          const nodes: Text[] = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
          for (const node of nodes) {
            const masked = maskPhoneLike(node.nodeValue ?? "");
            if (masked !== node.nodeValue) node.nodeValue = masked;
          }
        }
      } catch (caught) {
        // TELL THE ERROR MONITOR, not only the reader. A caught error never reaches the global
        // window.onerror net, so before this every manager on 2026-09-14 saw "Promise.withResolvers
        // is not a function" on every PDF CV while app_error_events recorded nothing at all. Kind,
        // stage and status go with it; the file name and the candidate do not — a CV is personal
        // data (src/lib/recruitment/cv-preview-failure-report.ts). A designed notice (a photograph a
        // manager may not see, an old .doc with no text in it) returns null there and is never
        // reported — but a legacy .doc whose READ failed is a real failure and does report. Reported
        // even after unmount: the failure was real whether or not the reader waited for it.
        const report = buildCvPreviewFailureReport({
          caught,
          fileName,
          httpStatus,
          kind,
          route: typeof window !== "undefined" ? window.location.pathname : null,
          stage,
        });
        if (report) reportClientError(report);
        if (active) {
          setError(caught instanceof Error ? caught.message : "This document couldn't be previewed.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // redactPhones is a dependency because it changes what gets PAINTED, not just what is read: a
    // manager who reserves the CV while the preview is open must see the page redrawn with the
    // number, and one who releases it must see it painted out again, without a reload. It decides
    // the text layer too, and so does allowDownload: a page drawn while its text was allowed must
    // be drawn again, without the layer, the moment it is not. fileName is read only to scrub it out
    // of a failure report; it changes together with bytesUrl, and so does docTextUrl — both are the
    // same downloadUrl with a different mode on the end.
  }, [kind, bytesUrl, docTextUrl, fileName, mimeType, redactPhones, allowDownload]);


  // A failed in-page render must never be a dead end. Whatever went wrong — a document the
  // renderer cannot read, a dropped connection, or a lazily-loaded chunk that no longer exists
  // because production redeployed while this tab was open (which surfaces as the browser's own
  // bare "Failed to fetch" text) — the reader still needs to READ the CV. So the failure notice
  // always carries a direct inline link to the real file, which does not depend on any of the
  // in-page rendering that just failed.
  //
  // WHERE DOWNLOADS ARE BLOCKED THERE IS NO ESCAPE HATCH, and there cannot be one: the inline URL IS
  // the file, so offering it to a manager would hand back in a failure state exactly what the block
  // takes away in the working one. He is told what to do instead, in words, rather than being left
  // looking at a red sentence with nothing under it.
  const failureNotice = error ? (
    <div className="flex items-start gap-2.5 border border-rose-200 border-l-[3px] border-l-rose-500 bg-rose-50 px-3 py-2.5 text-sm">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
      <div className="min-w-0">
        <p className="break-words font-semibold text-rose-800">{error}</p>
        <p className="mt-1">
          {allowDownload ? (
            <a
              className="font-semibold text-slate-900 underline underline-offset-2"
              href={inlineUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open the CV in a new tab
            </a>
          ) : (
            <span className="text-slate-600">
              Ask the recruitment team to send you a readable copy of this CV.
            </span>
          )}
        </p>
      </div>
    </div>
  ) : null;

  const documentBody = kind === "pdf" ? (
      <div className="min-h-full bg-slate-100 p-4">
        {loading ? <p className="p-1 text-sm text-slate-500">Loading preview…</p> : null}
        {failureNotice}
        {/* One <canvas> per page, painted by pdfjs-dist, each in a box with its selectable text
            layer over it — see the useEffect above for why this isn't an <iframe> on the browser's
            native PDF viewer. */}
        <div ref={pdfContainerRef} />
      </div>
    ) : kind === "image" ? (
      // In "fit page" the box is the pane's own height, so the whole photograph shows at once.
      <div className={`${fit === "page" ? "h-full" : "min-h-full"} bg-slate-100 p-4`}>
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
        {docLines ? (
          // ── A WORD 97-2003 DOCUMENT, AS THE ONE THING THAT FORMAT CAN GIVE ──────────────────
          //
          // Text on a page, not a rendering of the writer's layout: the binary .doc's fonts,
          // columns and tables are not recoverable outside Word, and the alternative was a reader
          // being told to go and find another computer. So it is dressed as a page — the same 816px
          // Word width, the same paper, the same fit-to-width control through `.cv-text-page`
          // below — and it says in one quiet line what it is, so nobody reads a plain CV as a
          // broken one.
          //
          // SELECTABLE ONLY WHERE THE DOCUMENT ITSELF MAY BE TAKEN, which is the rule the PDF text
          // layer already follows: where a manager may not have a copy, he may not lift the text
          // out of the render either.
          <div
            // 816px is the Word page width docx-preview paints, and it is deliberately FIXED rather
            // than capped at the pane: capping it would reflow the text to the column and then the
            // fit-to-width zoom would shrink an already-fitted page a second time. One mechanism
            // does the fitting for all three formats, and it is the one measured above.
            className={`cv-text-page mx-auto w-[816px] bg-white px-14 py-12 shadow-[0_1px_3px_rgba(15,23,42,0.12)] ${
              allowDownload ? "" : "select-none"
            }`}
            dir="auto"
          >
            <p className="mb-6 border-b border-slate-200 pb-2 text-phx-xs font-bold uppercase tracking-wide text-slate-400">
              Word 97–2003 document — shown as text, without its original layout
            </p>
            {docLines.map((line, index) =>
              line === "" ? (
                // A blank line the writer left. A spacer rather than an empty <p>, so the gap is
                // the same height whatever the surrounding text size is.
                <div className="h-4" key={index} />
              ) : (
                // pre-wrap keeps the tab a table cell boundary became, and the indentation the
                // writer typed, while still wrapping a long line inside the page.
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-900" dir="auto" key={index}>
                  {redactPhones ? maskPhoneLike(line) : line}
                </p>
              ),
            )}
            {docTruncated ? (
              <p className="mt-6 border-t border-slate-200 pt-2 text-phx-xs font-bold text-amber-700">
                This document is longer than the preview shows. Ask the recruitment team for the file
                itself to read the rest.
              </p>
            ) : null}
          </div>
        ) : null}
        {/* docx-preview renders its own page-styled markup into this container. */}
        <div ref={docxContainerRef} />
      </div>
    ) : (
      <p className="p-5 text-sm text-slate-500">
        {allowDownload
          ? "Preview isn't available for this file type — use Download instead."
          : "Preview isn't available for this file type. Ask the recruitment team to send you a readable copy."}
      </p>
    );


  if (!canFit) return <div className={className}>{documentBody}</div>;

  const fitButton = (mode: "width" | "page", label: string, title: string) => (
    <button
      className={`flex h-8 items-center px-2.5 text-phx-xs font-bold transition ${
        manualZoom === null && activeFit === mode ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-white hover:text-slate-900"
      }`}
      onClick={() => {
        setFitMode(mode);
        setManualZoom(null);
      }}
      title={title}
      type="button"
    >
      {label}
    </button>
  );

  // The icons stay 14px — this is still meant to be quiet — but each BUTTON is 32px square. `p-1`
  // around a 14px icon measured 22px at 375px, under the 24px floor a pointer target is meant to
  // clear, and small enough that zooming a CV on a phone is a game of chance. The chrome is
  // transparent until hover, so the larger target costs nothing visually.
  const zoomControls = (
    <>
      <button
        aria-label="Zoom out"
        className="flex h-8 w-8 items-center justify-center text-slate-600 transition hover:bg-white hover:text-slate-900 disabled:opacity-40"
        disabled={zoom <= MIN_ZOOM + 0.001}
        onClick={() => setManualZoom(clampZoom(zoom - ZOOM_STEP))}
        type="button"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[3.25rem] text-center text-phx-xs font-bold tabular-nums text-slate-700">{Math.round(zoom * 100)}%</span>
      <button
        aria-label="Zoom in"
        className="flex h-8 w-8 items-center justify-center text-slate-600 transition hover:bg-white hover:text-slate-900 disabled:opacity-40"
        disabled={zoom >= MAX_ZOOM - 0.001}
        onClick={() => setManualZoom(clampZoom(zoom + ZOOM_STEP))}
        type="button"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {canFitPage ? fitButton("page", "Fit page", "Fit the whole of page 1 in this box, and keep fitting it when the box changes size") : null}
      {fitButton("width", "Fit width", "Fit a whole page to this column, and keep fitting it when the column changes size")}
    </>
  );

  return (
    <div className={className} ref={paneRef}>
      {showZoomControl && toolbarTarget ? createPortal(<div className="flex flex-wrap items-center gap-1">{zoomControls}</div>, toolbarTarget) : null}
      {barInside ? (
        // Sticky, because the reason to reach for it is usually three pages down. Small and quiet:
        // this is a reading surface, and a toolbar that competes with the CV for attention has
        // already lost the point.
        <div className="sticky top-0 z-10 flex items-center justify-end gap-1 border-b border-slate-200/70 bg-slate-100/90 px-3 py-1.5 backdrop-blur">
          {zoomControls}
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

export function CvPreviewModal({
  allowDownload = true,
  fileName,
  mimeType,
  downloadUrl,
  headerActions,
  onClose,
  redactPhones = false,
  sidePanel,
  sidePanelFirstOnPhone = false,
}: Props) {
  const dialogRef = useDialogA11y({ open: true, onClose });

  if (typeof document === "undefined") return null;

  const documentBody = (
    <CvDocumentView
      allowDownload={allowDownload}
      downloadUrl={downloadUrl}
      fileName={fileName}
      mimeType={mimeType}
      redactPhones={redactPhones}
    />
  );

  // THE LOOK (2026-10-19 premium sweep): a square viewer, lifted off a darkened page. The house's
  // dark band names the document and holds Close; under it a light, recessed strip carries the
  // caller's controls and Download, so a caller's own buttons and error text keep the light ground
  // they were drawn for. The document itself sits on a grey desk, the page lifted off it.
  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#020617]/70 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview — ${fileName}`}
        className={`flex h-[85vh] w-full flex-col overflow-hidden border border-slate-300 bg-white shadow-[0_28px_90px_rgba(15,23,42,0.35)] ${
          sidePanel ? "max-w-6xl" : "max-w-3xl"
        }`}
      >
        <header className={`flex items-start justify-between gap-4 px-4 py-3 text-white sm:px-5 ${adminPanelHeaderClassName}`}>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center border border-orange-400/40 bg-orange-500/15 text-orange-300"
            >
              <FileText className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-300">CV preview</p>
              <p className="break-all text-sm font-semibold text-white">{fileName}</p>
            </div>
          </div>
          <button
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-white/15 bg-white/5 text-slate-200 transition hover:border-white/30 hover:bg-white/15 hover:text-white"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        {headerActions || allowDownload ? (
          <div
            className={`flex flex-wrap items-center justify-end gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 sm:px-5 ${adminRecessedDepthClassName}`}
          >
            {headerActions}
            {allowDownload ? (
              <a
                className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-800 ${adminControlDepthClassName}`}
                href={downloadUrl}
                rel="noreferrer"
                target="_blank"
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                Download
              </a>
            ) : null}
          </div>
        ) : null}

        {sidePanel ? (
          // Below `lg` this stacks instead of splitting into columns — and deliberately does NOT
          // give the document pane `flex-1` + `overflow-auto` together there. Per the flexbox spec,
          // a flex item's automatic minimum size is its content size UNLESS the item's own overflow
          // is something other than "visible" — in which case it resolves to 0. That is exactly what
          // was happening: on a phone-width screen the record panel below it (36 fields, unbounded
          // height) forced the flex line to shrink, and the document pane — the only sibling allowed
          // to shrink below its flex-basis — was squeezed to `clientHeight: 0`, so the pdfjs canvas
          // never had a box to paint into. The fix is to let the document pane keep its natural,
          // content-driven height on mobile (no forced overflow there) and let the OUTER container
          // scroll instead of each column independently. The side-by-side, independently-scrolling
          // columns return unchanged at `lg` and above.
          //
          // `shrink-0` on BOTH stacked panes is load-bearing, and `min-h-[60vh]` alone is not
          // enough — it is a floor, not a size. Without it the document pane is still a shrinkable
          // flex item: measured at 375x812, it shrank to the 487px floor while its content needed
          // 527px, and because it carries no overflow of its own on mobile the extra 40px painted
          // straight over the "On record" panel below it.
          <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
            <div className="min-h-[60vh] shrink-0 bg-slate-100 lg:min-h-0 lg:flex-1 lg:overflow-auto lg:border-r lg:border-slate-200">
              {documentBody}
            </div>
            <div className={`w-full shrink-0 bg-white p-5 lg:w-[360px] lg:overflow-auto${sidePanelFirstOnPhone ? " order-first lg:order-none" : ""}`}>{sidePanel}</div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-slate-100">{documentBody}</div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
