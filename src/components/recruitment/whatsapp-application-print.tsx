"use client";

// Recruitment / ATS — the page a WhatsApp application is printed from.
//
// The owner, 2026-09-19: "print application ... I am redirected to be able to print the CV and another
// page with all her WhatsApp history." This draws the application PDF (the CV as it was sent, then the
// one-page sheet of every question and answer) and offers the printer.
//
// WHY THE PAGES ARE DRAWN ON CANVASES AND NOT HANDED TO THE BROWSER'S PDF VIEWER. A PDF in an iframe is
// printed by whatever PDF plug-in the reader's browser has, or none (phones cannot draw one at all), and
// a download-manager extension cancels a request that looks like a downloadable file. pdf.js draws the
// same pixels for everybody, and each canvas becomes one sheet of paper, so what is on screen is what
// comes out of the printer. The bytes arrive as base64 text for the reason written in
// src/lib/recruitment/file-response.ts. pdf.js is loaded as a same-origin static asset by a native
// import, not bundled: the reasons are in cv-preview-modal.tsx.
//
// THE PRINT DIALOG OPENS ONCE, ON ITS OWN, when the pages are drawn. That is what "redirected to be able
// to print" asks for. A second print is the button. Both are hidden on the paper itself.

import { AlertTriangle, Download, Loader2, Printer } from "lucide-react";
import * as React from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  fetchCandidateApplication,
  fetchWhatsAppApplication,
  saveBytesAsPdf,
  type FetchedApplication,
} from "@/lib/recruitment/whatsapp-application-client";
import {
  MAX_PIXELS_PER_PAGE,
  PRINT_CSS,
  PRINT_PAGE_CLASS,
  PRINT_PAGE_LANDSCAPE_CLASS,
  PRINT_SCALE,
  SCREEN_ONLY_CLASS,
} from "@/lib/recruitment/whatsapp-application-print-css";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; application: FetchedApplication; pages: number };

function problemText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "The application could not be produced right now. Try again in a minute.";
}

/**
 * The print page's body, source-agnostic. `load` fetches the bytes (from a WhatsApp conversation or from a
 * candidate), `id` keys the effect and the retry, and `title` is the one word in the toolbar. The two exports
 * below are the only callers; drawing the pages, opening the dialog once and the retry are identical either way.
 */
function ApplicationPrint({
  id,
  load,
  title,
}: {
  id: string;
  load: (signal: AbortSignal) => Promise<FetchedApplication>;
  title: string;
}) {
  const pagesRef = React.useRef<HTMLDivElement | null>(null);
  const printedOnce = React.useRef(false);
  const [phase, setPhase] = React.useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  // `load` is a fresh closure each render; kept in a ref so re-creating it never re-runs the draw. Only
  // `id` and a retry do that.
  const loadRef = React.useRef(load);
  loadRef.current = load;

  React.useEffect(() => {
    let active = true;
    const controller = new AbortController();
    printedOnce.current = false;
    void (async () => {
      try {
        const application = await loadRef.current(controller.signal);
        if (!active) return;

        // Native import of a same-origin asset, so the bundler never touches pdf.js (cv-preview-modal.tsx).
        const pdfjsUrl = "/pdfjs/pdf.min.mjs";
        const pdfjsLib = (await import(/* webpackIgnore: true */ pdfjsUrl)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        const container = pagesRef.current;
        if (!active || !container) return;
        container.innerHTML = "";

        // wasmUrl — pdf.js 6 decodes JBIG2/CCITTFax (scanned pages), JPEG2000 and ICC in wasm it
        // fetches from here; unset, a scanned application prints blank (cv-preview-modal.tsx).
        // `isEvalSupported` is gone in 6: the eval it disabled for the CSP no longer exists.
        const doc = await pdfjsLib.getDocument({ data: application.bytes.slice(), wasmUrl: "/pdfjs/wasm/" }).promise;
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          if (!active) return;
          const page = await doc.getPage(pageNumber);
          const natural = page.getViewport({ scale: 1 });
          const scale = Math.min(PRINT_SCALE, Math.sqrt(MAX_PIXELS_PER_PAGE / (natural.width * natural.height)));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvas, viewport }).promise;
          if (!active) return;

          const sheet = document.createElement("div");
          sheet.className = natural.width > natural.height ? PRINT_PAGE_LANDSCAPE_CLASS : PRINT_PAGE_CLASS;
          sheet.appendChild(canvas);
          container.appendChild(sheet);
        }
        if (!active) return;
        setPhase({ application, kind: "ready", pages: doc.numPages });
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        // Half a document is worse than none: a reader could print the pages that did draw.
        if (pagesRef.current) pagesRef.current.innerHTML = "";
        setPhase({ kind: "error", message: problemText(error) });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, attempt]);

  // The dialog opens once, after the canvases are in the document. A frame later, so the last page has
  // been laid out and the dialog does not preview a half-built sheet.
  React.useEffect(() => {
    if (phase.kind !== "ready" || printedOnce.current) return;
    printedOnce.current = true;
    const handle = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(handle);
  }, [phase]);

  const ready = phase.kind === "ready" ? phase : null;

  // Set here and not in the effect: an effect that sets state on entry renders twice for nothing, and
  // the lint rule against it is right.
  const retry = () => {
    setPhase({ kind: "loading" });
    setAttempt((count) => count + 1);
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <style>{PRINT_CSS}</style>
      <header className={`${SCREEN_ONLY_CLASS} sticky top-0 z-10 border-b border-slate-300 bg-white`}>
        <div className="mx-auto flex max-w-[297mm] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-bold text-slate-900">{title}</h1>
            <p className="text-[12px] text-slate-600" role="status">
              {phase.kind === "loading" ? "Preparing the CV and the application sheet. This takes a few seconds." : null}
              {phase.kind === "error" ? "The application did not open." : null}
              {ready ? describePages(ready.pages, ready.application) : null}
            </p>
          </div>
          {ready ? (
            <div className="flex flex-wrap items-center gap-2">
              <Action onClick={() => window.print()} size="md" tone="primary">
                <Printer aria-hidden className="h-4 w-4" /> Print
              </Action>
              <Action onClick={() => saveBytesAsPdf(ready.application.bytes, ready.application.fileName)} size="md">
                <Download aria-hidden className="h-4 w-4" /> Download
              </Action>
            </div>
          ) : null}
        </div>
      </header>

      <main className="wa-print-stage px-4 py-5">
        {phase.kind === "loading" ? (
          <p className={`${SCREEN_ONLY_CLASS} mx-auto flex max-w-xl items-center gap-2 border border-slate-200 bg-white p-4 text-sm text-slate-700`}>
            <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> Preparing the application…
          </p>
        ) : null}
        {phase.kind === "error" ? (
          <div className={`${SCREEN_ONLY_CLASS} mx-auto max-w-xl border border-slate-200 bg-white p-4`} role="alert">
            <p className="flex items-start gap-2 text-sm text-slate-800">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span className="min-w-0 break-words">{phase.message}</span>
            </p>
            <Action className="mt-3" onClick={retry} size="md" tone="primary">
              Try again
            </Action>
          </div>
        ) : null}
        {/* Always in the document: the effect draws into it, and only pages may sit inside it. */}
        <div ref={pagesRef} />
      </main>
    </div>
  );
}

/** The WhatsApp Applicants / interview-calendar print page: keyed by conversation. */
export function WhatsAppApplicationPrint({ sessionId }: { sessionId: string }) {
  return (
    <ApplicationPrint
      id={sessionId}
      load={(signal) => fetchWhatsAppApplication(sessionId, signal)}
      title="WhatsApp application"
    />
  );
}

/** The screening page's print page: keyed by candidate, so it reaches a CV that never applied on WhatsApp. */
export function CandidateApplicationPrint({ candidateId }: { candidateId: string }) {
  return (
    <ApplicationPrint id={candidateId} load={(signal) => fetchCandidateApplication(candidateId, signal)} title="Application" />
  );
}

/** "3 pages: the CV (2 pages), then the application sheet." — and says so plainly when there is no CV. */
function describePages(pages: number, application: FetchedApplication): string {
  const total = `${pages} ${pages === 1 ? "page" : "pages"}`;
  if (application.cvPages === 0) {
    return `${total}: the application sheet only. The CV could not be included, and the foot of the sheet says why.`;
  }
  if (application.cvPages === null || application.sheetPages === null) return `${total}: the CV, then the application sheet.`;
  const cv = `${application.cvPages} ${application.cvPages === 1 ? "page" : "pages"}`;
  const sheet = application.sheetPages === 1 ? "the application sheet on one page" : `the application sheet (${application.sheetPages} pages)`;
  return `${total}: the CV (${cv}), then ${sheet}.`;
}
