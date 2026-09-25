"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Archive,
  FileImage,
  FileText,
  Presentation,
  RefreshCcw,
  Upload,
  X,
} from "lucide-react";

import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { VISUAL_AID_MAX_BYTES, VISUAL_AID_MIME_TYPES, type VisualAidMimeType } from "@/lib/visual-aids/rules";

/**
 * Visual Aids — the library a rep opens in front of a doctor, and the shelf Marketing keeps it on.
 *
 * ── THE RULES THIS FILE IS BOUND BY ──────────────────────────────────────────
 *
 *  · NEVER A HORIZONTAL SCROLL, at desktop OR 375px. The management list is `w-full table-fixed`
 *    with a colgroup on desktop and cards below `lg`. Long titles WRAP, never an ellipsis.
 *  · SQUARE EDGES. Not one `rounded-*` class in this file.
 *  · NAMES, NEVER IDS; CAIRO DATES.
 *  · NO DOWNLOAD. Every page — a PDF page or a picture — is painted onto a <canvas> from bytes this
 *    page fetched itself: Android Chrome hands a PDF in an iframe to the download manager instead of
 *    showing it, and a canvas offers no "save" on long-press the way an <img> does. The file route
 *    answers `inline` and `no-store`; there is no download button, by owner decision.
 */

/* ────────────────────────────────── types ────────────────────────────────── */

/** Never notifies: the store below only answers "is this the browser yet?" (see the viewer mount). */
const emptySubscribe = () => () => {};

type VisualAid = {
  id: string;
  title: string;
  lineName: string;
  productName: string | null;
  mimeType: VisualAidMimeType;
  fileSizeBytes: number;
  pageCount: number | null;
  status: "active" | "retired";
  supersededById: string | null;
  supersededByTitle: string | null;
  uploadedByName: string;
  uploadedAt: string;
  retiredByName: string | null;
  retiredAt: string | null;
};

type Library = { aids: VisualAid[]; lines: string[]; canManage: boolean; allLines: string[] };

type PdfDocument = {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: { canvas: HTMLCanvasElement; viewport: unknown }) => { promise: Promise<void> };
  }>;
  destroy?: () => Promise<void>;
};

/* ─────────────────────────── shared look (siblings) ─────────────────────────── */

const INPUT =
  "h-10 w-full border border-phx-line bg-phx-paper px-3 text-phx-sm font-bold text-phx-ink outline-none transition focus:border-phx-accent focus:ring-2 focus:ring-phx-accent-soft disabled:cursor-not-allowed disabled:bg-phx-paper-2 disabled:text-phx-ink-faint";
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 border border-phx-accent bg-phx-accent px-4 py-2.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-accent-ink transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60";
const BTN_QUIET =
  "inline-flex items-center justify-center gap-2 border border-phx-line bg-phx-paper px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.10em] text-phx-ink-soft transition hover:border-phx-line-strong hover:text-phx-ink disabled:cursor-not-allowed disabled:opacity-60";
const BTN_DANGER =
  "inline-flex items-center justify-center gap-2 border border-phx-danger-line bg-phx-danger-bg px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.10em] text-phx-danger transition disabled:cursor-not-allowed disabled:opacity-60";

const TONE_CLASS = {
  good: "border-phx-ok-line bg-phx-ok-bg text-phx-ok",
  neutral: "border-phx-line bg-phx-paper-2 text-phx-ink-soft",
} as const;

function cairoDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(parsed);
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pagesLabel(aid: VisualAid): string {
  if (aid.mimeType !== "application/pdf") return "Picture";
  if (!aid.pageCount) return "PDF";
  return aid.pageCount === 1 ? "1 page" : `${aid.pageCount} pages`;
}

function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-phx-3xs font-bold uppercase tracking-[0.14em] text-phx-ink-faint">{children}</span>
  );
}

function StatusChip({ status }: { status: VisualAid["status"] }) {
  const tone = status === "active" ? TONE_CLASS.good : TONE_CLASS.neutral;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.10em] ${tone}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 bg-current" />
      {status === "active" ? "Live" : "Retired"}
    </span>
  );
}

function Panel({ children, title, kicker, action }: { children: React.ReactNode; title: string; kicker?: string; action?: React.ReactNode }) {
  return (
    <section className="relative min-w-0 border border-phx-line bg-phx-paper">
      <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[2px] bg-phx-accent" />
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 pl-5 sm:px-5 sm:pl-6">
        <div className="min-w-0">
          {kicker ? <MicroLabel>{kicker}</MicroLabel> : null}
          <h2 className="break-words text-phx-sm font-black uppercase tracking-[0.08em] text-phx-ink">{title}</h2>
        </div>
        {action}
      </header>
      <div className="min-w-0 p-4 pl-5 sm:p-5 sm:pl-6">{children}</div>
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 border border-dashed border-phx-line bg-phx-paper-2 px-4 py-10 text-center">
      <Presentation className="h-6 w-6 shrink-0 text-phx-ink-faint" />
      <p className="break-words text-phx-sm font-black text-phx-ink">{title}</p>
      <p className="max-w-md break-words text-phx-xs font-medium text-phx-ink-soft">{body}</p>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn" | "good"; children: React.ReactNode }) {
  const cls = tone === "warn" ? "border-phx-warn-line bg-phx-warn-bg text-phx-warn" : "border-phx-ok-line bg-phx-ok-bg text-phx-ok";
  return (
    <div className={`min-w-0 border px-3 py-2.5 ${cls}`} role={tone === "warn" ? "alert" : "status"}>
      <p className="min-w-0 break-words text-phx-xs font-bold">{children}</p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <div className="h-28 w-full animate-pulse border border-phx-line bg-phx-paper-2" key={index} />
      ))}
    </div>
  );
}

function Field({ children, label, hint }: { children: React.ReactNode; label: string; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block">
        <MicroLabel>{label}</MicroLabel>
      </span>
      {children}
      {hint ? <span className="mt-1.5 block break-words text-phx-3xs font-medium text-phx-ink-faint">{hint}</span> : null}
    </label>
  );
}

/* ─────────────────────────────── pdf.js loading ─────────────────────────────── */

// Hand-written rather than pdfjs-dist's own types, so nothing here is checked against the real
// library — a stale option would have type-checked green forever. That is exactly what happened to
// `isEvalSupported`, which pdf.js 6 removed: the other three call sites went red on the bump and
// this one did not. Keep this shape honest by hand when the pinned version moves.
type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (o: { data: Uint8Array; wasmUrl: string }) => { promise: Promise<PdfDocument> };
};

/**
 * pdf.js, library AND worker, as the static same-origin assets under public/pdfjs/ — the exact
 * loading the CV preview uses (src/components/recruitment/cv-preview-modal.tsx says why: the bundler
 * must not touch them, and the CSP allows only same-origin scripts). `wasmUrl` points at the
 * decoders pdf.js 6 keeps outside its JS bundle — JBIG2/CCITTFax, JPEG2000, ICC — so a scanned
 * visual aid draws instead of coming up blank.
 */
async function loadPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjsUrl = "/pdfjs/pdf.min.mjs";
  const pdfjsLib = (await import(/* webpackIgnore: true */ pdfjsUrl)) as PdfJs;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  return pdfjsLib.getDocument({ data: bytes, wasmUrl: "/pdfjs/wasm/" }).promise;
}

/* ─────────────────────────────── the viewer ─────────────────────────────── */

/**
 * Full screen, one page at a time: swipe left or right, the arrow buttons, or the keyboard's arrow
 * keys; Escape closes. A picture is one page. Everything is drawn onto a canvas sized to the screen
 * at the device's pixel ratio, so a flyer is sharp on a tablet and nothing on screen is a file.
 */
function VisualAidViewer({ aid, onClose }: { aid: VisualAid; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PdfDocument | null>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const touchStartX = useRef<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(aid.mimeType === "application/pdf" ? aid.pageCount ?? 1 : 1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the bytes once, through the permission-checked route.
  useEffect(() => {
    let active = true;
    let heldDoc: PdfDocument | null = null;
    let heldBitmap: ImageBitmap | null = null;
    (async () => {
      try {
        const response = await fetch(`/api/visual-aids/${aid.id}/file`, { cache: "no-store" });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.message ?? `This visual aid could not be opened (HTTP ${response.status}).`);
        }
        const buffer = await response.arrayBuffer();
        if (!active) return;
        if (aid.mimeType === "application/pdf") {
          const doc = await loadPdf(new Uint8Array(buffer));
          if (!active) {
            await doc.destroy?.();
            return;
          }
          heldDoc = doc;
          pdfRef.current = doc;
          setPageCount(doc.numPages);
        } else {
          const bitmap = await createImageBitmap(new Blob([buffer], { type: aid.mimeType }));
          if (!active) {
            bitmap.close();
            return;
          }
          heldBitmap = bitmap;
          bitmapRef.current = bitmap;
          setPageCount(1);
        }
        setReady(true);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "This visual aid could not be opened.");
      }
    })();
    return () => {
      active = false;
      void heldDoc?.destroy?.();
      heldBitmap?.close();
    };
  }, [aid.id, aid.mimeType]);

  // Paint the current page, fitted to the stage.
  const paint = useCallback(async () => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !ready) return;
    const ratio = window.devicePixelRatio || 1;
    const boxW = stage.clientWidth;
    const boxH = stage.clientHeight;
    if (boxW <= 0 || boxH <= 0) return;

    if (pdfRef.current) {
      const pdfPage = await pdfRef.current.getPage(page);
      const natural = pdfPage.getViewport({ scale: 1 });
      const fit = Math.min(boxW / natural.width, boxH / natural.height);
      const viewport = pdfPage.getViewport({ scale: fit * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      await pdfPage.render({ canvas, viewport }).promise;
      return;
    }
    const bitmap = bitmapRef.current;
    if (!bitmap) return;
    const fit = Math.min(boxW / bitmap.width, boxH / bitmap.height);
    const cssW = Math.floor(bitmap.width * fit);
    const cssH = Math.floor(bitmap.height * fit);
    canvas.width = Math.floor(cssW * ratio);
    canvas.height = Math.floor(cssH * ratio);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const context = canvas.getContext("2d");
    context?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }, [page, ready]);

  useEffect(() => {
    void paint().catch(() => setError("This page could not be drawn. Close the visual aid and open it again."));
    const onResize = () => void paint().catch(() => undefined);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [paint]);

  const go = useCallback(
    (delta: number) => setPage((current) => Math.min(Math.max(current + delta, 1), pageCount)),
    [pageCount],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") go(1);
      else if (event.key === "ArrowLeft" || event.key === "PageUp") go(-1);
      else if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // The lock goes on <html>, not <body>: the shell sets `html { overflow-x: clip }`, which makes the
    // VIEWPORT the scroller, so `body.style.overflow` locked nothing and the page scrolled on under
    // the flyer.
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      root.style.overflow = previousOverflow;
    };
  }, [go, onClose]);

  return (
    // Portalled to <body> by the workspace (see the mount below), so `fixed inset-0` really is the
    // SCREEN. z-[300] clears the portal header (z-30) and bottom nav (z-40); the safe-area padding
    // keeps the Close button and the page arrows clear of a notch or a home bar.
    <div
      aria-label={aid.title}
      aria-modal="true"
      className="fixed inset-0 z-[300] flex flex-col bg-black text-white"
      role="dialog"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/15 px-3 py-2 sm:px-4">
        <div className="min-w-0">
          <p className="break-words text-phx-sm font-black">{aid.title}</p>
          <p className="break-words text-phx-xs font-bold uppercase tracking-[0.12em] text-white/60">
            {aid.lineName}
            {aid.productName ? ` · ${aid.productName}` : ""}
            {` · Page ${page} of ${pageCount}`}
          </p>
        </div>
        <button
          aria-label="Close"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-white/25 text-white"
          onClick={onClose}
          type="button"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onContextMenu={(event) => event.preventDefault()}
        onTouchEnd={(event) => {
          const start = touchStartX.current;
          touchStartX.current = null;
          if (start === null) return;
          const dx = event.changedTouches[0].clientX - start;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        }}
        onTouchStart={(event) => {
          touchStartX.current = event.touches.length === 1 ? event.touches[0].clientX : null;
        }}
        ref={stageRef}
      >
        {error ? (
          <p className="max-w-md break-words px-4 text-center text-phx-sm font-bold">{error}</p>
        ) : !ready ? (
          <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-white/60">Opening</p>
        ) : null}
        <canvas
          className={`block select-none bg-white ${ready && !error ? "" : "hidden"}`}
          draggable={false}
          ref={canvasRef}
        />
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-3 border-t border-white/15 px-3 py-2 sm:px-4">
          <button
            aria-label="Previous page"
            className="inline-flex h-11 min-w-[88px] items-center justify-center gap-2 border border-white/25 text-phx-xs font-black uppercase tracking-[0.10em] disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => go(-1)}
            type="button"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <p className="text-phx-xs font-bold text-white/70">
            {page} / {pageCount}
          </p>
          <button
            aria-label="Next page"
            className="inline-flex h-11 min-w-[88px] items-center justify-center gap-2 border border-white/25 text-phx-xs font-black uppercase tracking-[0.10em] disabled:opacity-40"
            disabled={page >= pageCount}
            onClick={() => go(1)}
            type="button"
          >
            Next <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── upload form ─────────────────────────────── */

/**
 * Upload a new aid, or a newer version of one (`replacing`). Three steps, all from this browser:
 * a one-time upload URL, the file PUT straight into the private bucket, then the save call that
 * reads it back on the server. A PDF is opened with pdf.js BEFORE upload to count its pages — which
 * also proves it will render on a rep's tablet.
 */
function UploadForm({
  allLines,
  onDone,
  onCancel,
  replacing,
}: {
  allLines: string[];
  onDone: (message: string) => void;
  onCancel?: () => void;
  replacing?: VisualAid | null;
}) {
  const [title, setTitle] = useState(replacing?.title ?? "");
  const [lineName, setLineName] = useState(replacing?.lineName ?? "");
  const [productName, setProductName] = useState(replacing?.productName ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError("Choose the PDF, JPG or PNG file.");
      return;
    }
    const contentType = file.type.toLowerCase() as VisualAidMimeType;
    if (!VISUAL_AID_MIME_TYPES.includes(contentType)) {
      setError("A visual aid must be a PDF, a JPG or a PNG file.");
      return;
    }
    if (file.size > VISUAL_AID_MAX_BYTES) {
      setError("That file is larger than 50 MB. Export it at a lower resolution and upload it again.");
      return;
    }
    setBusy(true);
    try {
      let pageCount: number | null = null;
      if (contentType === "application/pdf") {
        try {
          const doc = await loadPdf(new Uint8Array(await file.arrayBuffer()));
          pageCount = doc.numPages;
          await doc.destroy?.();
        } catch {
          throw new Error("That PDF could not be opened, so a rep's tablet could not show it either. Export it again and retry.");
        }
      }

      const urlResponse = await fetch("/api/visual-aids/upload-url", {
        body: JSON.stringify({ contentType, size: file.size }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const urlPayload = await urlResponse.json().catch(() => null);
      if (!urlResponse.ok || !urlPayload?.signedUrl) {
        throw new Error(urlPayload?.message ?? `The upload could not start (HTTP ${urlResponse.status}).`);
      }
      const put = await fetch(urlPayload.signedUrl, {
        body: file,
        headers: { "content-type": contentType, "x-upsert": "false" },
        method: "PUT",
      });
      if (!put.ok) throw new Error("The file could not be uploaded. Check the connection and try again.");

      const endpoint = replacing ? `/api/visual-aids/${replacing.id}/replace` : "/api/visual-aids";
      const saveResponse = await fetch(endpoint, {
        body: JSON.stringify({ lineName, pageCount, productName, storagePath: urlPayload.path, title }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const savePayload = await saveResponse.json().catch(() => null);
      if (!saveResponse.ok) {
        throw new Error(savePayload?.message ?? `The visual aid could not be saved (HTTP ${saveResponse.status}).`);
      }
      setTitle("");
      setProductName("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onDone(
        replacing
          ? `"${title.trim() || replacing.title}" is live, and the old version is retired.`
          : `"${title.trim()}" is live for the ${lineName} line.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The visual aid could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2" onSubmit={submit}>
      {replacing ? (
        <div className="md:col-span-2">
          <Notice tone="good">
            {`Replacing "${replacing.title}". The new file goes live and the old one is retired; nothing is deleted.`}
          </Notice>
        </div>
      ) : null}
      <Field label="Title">
        <input className={INPUT} maxLength={160} onChange={(event) => setTitle(event.target.value)} required value={title} />
      </Field>
      <Field label="Line">
        <select className={INPUT} onChange={(event) => setLineName(event.target.value)} required value={lineName}>
          <option value="">Choose the line</option>
          {allLines.map((line) => (
            <option key={line} value={line}>
              {line}
            </option>
          ))}
        </select>
      </Field>
      <Field hint="Optional" label="Product">
        <input className={INPUT} maxLength={120} onChange={(event) => setProductName(event.target.value)} value={productName} />
      </Field>
      <Field hint="PDF, JPG or PNG, up to 50 MB" label="File">
        <input
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          className="block w-full min-w-0 border border-phx-line bg-phx-paper px-3 py-2 text-phx-xs font-bold text-phx-ink file:mr-3 file:border-0 file:bg-phx-paper-2 file:px-3 file:py-1.5 file:text-phx-2xs file:font-black file:uppercase"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          ref={fileRef}
          required
          type="file"
        />
      </Field>
      {error ? (
        <div className="md:col-span-2">
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 md:col-span-2">
        <button className={BTN_PRIMARY} disabled={busy} type="submit">
          <Upload className="h-4 w-4" />
          {busy ? "Uploading" : replacing ? "Upload new version" : "Upload"}
        </button>
        {onCancel ? (
          <button className={BTN_QUIET} disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/* ─────────────────────────────── the workspace ─────────────────────────────── */

function AidCard({ aid, onOpen }: { aid: VisualAid; onOpen: (aid: VisualAid) => void }) {
  const Icon = aid.mimeType === "application/pdf" ? FileText : FileImage;
  return (
    <button
      className="flex min-h-[112px] min-w-0 flex-col items-start gap-2 border border-phx-line bg-phx-paper p-4 text-left transition hover:border-phx-accent"
      onClick={() => onOpen(aid)}
      type="button"
    >
      <span className="flex w-full min-w-0 items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-phx-accent" />
        <span className="min-w-0 break-words text-phx-sm font-black text-phx-ink">{aid.title}</span>
      </span>
      <span className="break-words text-phx-xs font-bold uppercase tracking-[0.12em] text-phx-ink-faint">
        {aid.lineName}
        {aid.productName ? ` · ${aid.productName}` : ""}
        {` · ${pagesLabel(aid)}`}
      </span>
      <span className="text-phx-xs font-medium text-phx-ink-faint">Added {cairoDate(aid.uploadedAt)}</span>
    </button>
  );
}

export function VisualAidsWorkspace() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<VisualAid | null>(null);
  const [replacing, setReplacing] = useState<VisualAid | null>(null);
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lineFilter, setLineFilter] = useState<string>("all");
  // The viewer is portalled to <body>, and only once this is the browser. It used to render INLINE,
  // inside the page-transition wrapper, whose `transform` and `filter` make it the containing block
  // for anything `position: fixed` beneath it — so the "full screen" flyer filled only the page
  // column, sat under the header and the bottom nav, and put its Close button above the screen if the
  // rep had scrolled down to a card. Same trap and same fix as plans-workspace.tsx.
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/visual-aids", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? `The visual aids could not be loaded (HTTP ${response.status}).`);
      setLibrary(payload as Library);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The visual aids could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer out of the synchronous effect body to satisfy react-hooks/set-state-in-effect.
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const retire = async (aid: VisualAid) => {
    setBusyId(aid.id);
    setError(null);
    try {
      const response = await fetch(`/api/visual-aids/${aid.id}/retire`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? `That visual aid could not be retired (HTTP ${response.status}).`);
      setNotice(`"${aid.title}" is retired. Reps no longer see it; the file is kept.`);
      setConfirmRetire(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That visual aid could not be retired.");
    } finally {
      setBusyId(null);
    }
  };

  const active = useMemo(
    () => (library?.aids ?? []).filter((aid) => aid.status === "active" && (lineFilter === "all" || aid.lineName === lineFilter)),
    [library, lineFilter],
  );

  const onUploaded = (message: string) => {
    setNotice(message);
    setReplacing(null);
    void load();
  };

  return (
    <div className="min-w-0 space-y-6">
      {notice ? <Notice tone="good">{notice}</Notice> : null}
      {error ? <Notice tone="warn">{error}</Notice> : null}

      <Panel
        action={
          library && library.lines.length > 1 ? (
            <select
              aria-label="Line"
              className={`${INPUT} h-9 w-auto`}
              onChange={(event) => setLineFilter(event.target.value)}
              value={lineFilter}
            >
              <option value="all">All lines</option>
              {library.lines.map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </select>
          ) : (
            <button className={BTN_QUIET} onClick={() => void load()} type="button">
              <RefreshCcw className="h-3.5 w-3.5" /> Refresh
            </button>
          )
        }
        kicker={library && library.lines.length === 1 ? `${library.lines[0]} line` : "Library"}
        title="Visual aids"
      >
        {loading && !library ? (
          <SkeletonRows />
        ) : library && library.lines.length === 0 ? (
          <EmptyState
            body="Your line could not be worked out from your employee record, so no visual aids can be shown. Ask HR to check the line on your record."
            title="No line on your record"
          />
        ) : active.length === 0 ? (
          <EmptyState body="Marketing has not published a visual aid for this line yet." title="Nothing to show yet" />
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {active.map((aid) => (
              <AidCard aid={aid} key={aid.id} onOpen={setOpen} />
            ))}
          </div>
        )}
      </Panel>

      {library?.canManage ? (
        <>
          <Panel kicker="Marketing" title={replacing ? "Replace a visual aid" : "Upload a visual aid"}>
            <UploadForm
              allLines={library.allLines}
              key={replacing?.id ?? "new"}
              onCancel={replacing ? () => setReplacing(null) : undefined}
              onDone={onUploaded}
              replacing={replacing}
            />
          </Panel>

          <Panel kicker="Marketing" title="Every visual aid">
            {library.aids.length === 0 ? (
              <EmptyState body="Upload the first flyer above and it appears here." title="Nothing uploaded yet" />
            ) : (
              <>
                <table className="hidden w-full table-fixed border-collapse text-left lg:table">
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[20%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-phx-line">
                      {["Visual aid", "Line", "Status", "Uploaded", ""].map((heading) => (
                        <th className="px-2 py-2 align-bottom" key={heading || "actions"} scope="col">
                          <MicroLabel>{heading}</MicroLabel>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {library.aids.map((aid) => (
                      <tr className="border-b border-phx-line align-top" key={aid.id}>
                        <td className="px-2 py-3">
                          <p className="break-words text-phx-sm font-black text-phx-ink">{aid.title}</p>
                          <p className="break-words text-phx-3xs font-bold text-phx-ink-faint">
                            {[aid.productName, pagesLabel(aid), fileSize(aid.fileSizeBytes)].filter(Boolean).join(" · ")}
                          </p>
                        </td>
                        <td className="break-words px-2 py-3 text-phx-xs font-bold text-phx-ink">{aid.lineName}</td>
                        <td className="px-2 py-3">
                          <StatusChip status={aid.status} />
                          {aid.status === "retired" ? (
                            <p className="mt-1 break-words text-phx-3xs font-medium text-phx-ink-faint">
                              {aid.supersededByTitle ? `Replaced by "${aid.supersededByTitle}"` : `Retired ${cairoDate(aid.retiredAt)}`}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-2 py-3">
                          <p className="break-words text-phx-xs font-bold text-phx-ink">{aid.uploadedByName}</p>
                          <p className="text-phx-3xs font-medium text-phx-ink-faint">{cairoDate(aid.uploadedAt)}</p>
                        </td>
                        <td className="px-2 py-3">
                          <ManageActions
                            aid={aid}
                            busy={busyId === aid.id}
                            confirming={confirmRetire === aid.id}
                            onConfirm={setConfirmRetire}
                            onOpen={setOpen}
                            onReplace={setReplacing}
                            onRetire={retire}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="flex min-w-0 flex-col gap-3 lg:hidden">
                  {library.aids.map((aid) => (
                    <div className="min-w-0 border border-phx-line bg-phx-paper p-3" key={aid.id}>
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                        <p className="min-w-0 break-words text-phx-sm font-black text-phx-ink">{aid.title}</p>
                        <StatusChip status={aid.status} />
                      </div>
                      <p className="mt-1 break-words text-phx-3xs font-bold text-phx-ink-faint">
                        {[aid.lineName, aid.productName, pagesLabel(aid), fileSize(aid.fileSizeBytes)].filter(Boolean).join(" · ")}
                      </p>
                      <p className="mt-1 break-words text-phx-3xs font-medium text-phx-ink-faint">
                        {`Uploaded by ${aid.uploadedByName}, ${cairoDate(aid.uploadedAt)}`}
                        {aid.status === "retired"
                          ? aid.supersededByTitle
                            ? ` · Replaced by "${aid.supersededByTitle}"`
                            : ` · Retired ${cairoDate(aid.retiredAt)}`
                          : ""}
                      </p>
                      <div className="mt-3">
                        <ManageActions
                          aid={aid}
                          busy={busyId === aid.id}
                          confirming={confirmRetire === aid.id}
                          onConfirm={setConfirmRetire}
                          onOpen={setOpen}
                          onReplace={setReplacing}
                          onRetire={retire}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Panel>
        </>
      ) : null}

      {open && mounted ? createPortal(<VisualAidViewer aid={open} onClose={() => setOpen(null)} />, document.body) : null}
    </div>
  );
}

function ManageActions({
  aid,
  busy,
  confirming,
  onConfirm,
  onOpen,
  onReplace,
  onRetire,
}: {
  aid: VisualAid;
  busy: boolean;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  onOpen: (aid: VisualAid) => void;
  onReplace: (aid: VisualAid) => void;
  onRetire: (aid: VisualAid) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <button className={BTN_QUIET} onClick={() => onOpen(aid)} type="button">
        Open
      </button>
      {aid.status === "active" ? (
        confirming ? (
          <>
            <button className={BTN_DANGER} disabled={busy} onClick={() => onRetire(aid)} type="button">
              <Archive className="h-3.5 w-3.5" /> {busy ? "Retiring" : "Confirm retire"}
            </button>
            <button className={BTN_QUIET} disabled={busy} onClick={() => onConfirm(null)} type="button">
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              className={BTN_QUIET}
              onClick={() => {
                onReplace(aid);
                window.scrollTo({ behavior: "smooth", top: 0 });
              }}
              type="button"
            >
              Replace
            </button>
            <button className={BTN_QUIET} onClick={() => onConfirm(aid.id)} type="button">
              Retire
            </button>
          </>
        )
      ) : null}
    </div>
  );
}
