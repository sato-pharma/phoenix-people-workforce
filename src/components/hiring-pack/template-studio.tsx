"use client";

// COMPANY TEMPLATES — upload a document, give it a name and say who it is for, and it becomes a
// paper this system prints.
//
// The owner's instruction, 2026-09-03: "I am able to upload any document and give it a name and a
// role. And after that, it's in the system. So to add another template, any other workflow, is done
// inside the system UI instead of giving it to you and you making it from the code."
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A PDF IS RASTERISED HERE, IN THE BROWSER, and that is the load-bearing decision. `renderSheet`
// puts a document's artwork in an `<img src>`, so every page has to become an image before it can be
// a template. Doing it on the server would mean a native image dependency in the server bundle, and
// this repository has already been taken down once by a top-level `import sharp` 500ing a whole page
// when its `.so` was missing. The browser has canvas already, and pdf.js is already shipped here for
// the CV preview.
//
// THE PAGE SIZE COMES FROM THE PDF ITSELF, in points, off its own page box — never guessed and never
// derived from the pixel size. Every coordinate in the field layer is in points; a page size that is
// out by a few percent is not a visible error, it is a signature box that lands slightly over a
// printed rule on four hundred documents. An image has no page box, so an image gets a size picker
// with the aspect-matched preset preselected and the number visible before it is saved.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileImage,
  FileUp,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CUSTOM_TEMPLATE_MAX_PAGES,
  CUSTOM_TEMPLATE_PAGE_PRESETS,
  pagePresetFor,
  roundPoints,
  type CustomTemplateContentType,
} from "@/lib/hiring-pack/custom-templates";

const inputClassName =
  "h-10 rounded-xl border-phx-line bg-white/95 text-sm shadow-sm focus:border-phx-accent-line focus:ring-phx-accent/15";
const labelClassName =
  "mb-1.5 block text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

/**
 * What the browser draws a PDF page at, in dots to the inch.
 *
 * TWO HUNDRED, chosen against the two failures on either side of it. Below about 150 a scanned
 * form's printed rules go soft and the paper looks photocopied; above 300 a single A4 page is
 * several megabytes and a four-page form stops fitting in one request. Two hundred puts an A4 page
 * at 1654 × 2339, which prints indistinguishably from the original at arm's length.
 */
const RASTER_DPI = 200;

/** The fallback if the whole template is too large at 200 — still legible, roughly half the bytes. */
const RASTER_DPI_FALLBACK = 140;

/** Matches the route's own cap. Both exist so the refusal is a sentence, not a 413. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Never draw a page larger than this on its long edge, whatever the dpi arithmetic asks for. */
const MAX_RASTER_EDGE_PX = 4000;

type RasterPage = {
  blob: Blob;
  contentType: CustomTemplateContentType;
  widthPx: number;
  heightPx: number;
  /** For the thumbnail. Revoked when the draft is cleared — see the effect below. */
  previewUrl: string;
};

type StoredPage = {
  id: string;
  pageIndex: number;
  contentType: string;
  sizeBytes: number;
  widthPx: number;
  heightPx: number;
};

type StoredTemplate = {
  id: string;
  key: string;
  document: string;
  name: string;
  nameAr: string | null;
  pageWidthPt: number;
  pageHeightPt: number;
  status: "current" | "archived";
  version: number;
  effectiveFrom: string;
  note: string | null;
  printableByRoles: string[] | null;
  createdAt: string;
  pages: StoredPage[];
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A page size in points, said the way somebody holding the paper would check it. */
function describePageSize(widthPt: number, heightPt: number): string {
  const preset = pagePresetFor(widthPt, heightPt);
  const named = preset ? CUSTOM_TEMPLATE_PAGE_PRESETS.find((entry) => entry.id === preset) : null;
  const mm = `${Math.round((widthPt / 72) * 25.4)} × ${Math.round((heightPt / 72) * 25.4)} mm`;
  return named ? `${named.label.split(" — ")[0]} · ${mm}` : `${widthPt} × ${heightPt} pt · ${mm}`;
}

/**
 * Draw every page of a PDF to a PNG, and read the page size off the PDF's own page box.
 *
 * pdf.js — the library AND its worker — is loaded as a plain static asset from `public/pdfjs/`
 * through a NATIVE dynamic import, with `webpackIgnore` stopping the bundler from touching it. That
 * is not incidental: `pdfjs-dist` ships as a prebuilt ESM bundle with its own internal module
 * system, and letting this app's webpack re-bundle it throws `TypeError: Object.defineProperty
 * called on non-object` during evaluation. `isEvalSupported: false` keeps it inside this app's CSP,
 * which has no `unsafe-eval`. All of this is the CV preview's hard-won configuration, reused
 * verbatim — see `cv-preview-modal.tsx` for the full account.
 */
async function rasterisePdf(
  file: File,
  dpi: number,
): Promise<{ pages: RasterPage[]; widthPt: number; heightPt: number }> {
  const pdfjsUrl = "/pdfjs/pdf.min.mjs";
  const pdfjsLib = (await import(/* webpackIgnore: true */ pdfjsUrl)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;

  if (doc.numPages > CUSTOM_TEMPLATE_MAX_PAGES) {
    throw new Error(
      `That PDF has ${doc.numPages} pages. A template can have at most ${CUSTOM_TEMPLATE_MAX_PAGES}.`,
    );
  }

  const pages: RasterPage[] = [];
  let widthPt = 0;
  let heightPt = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);

    // Scale 1 is the PDF's own units, which ARE points. This is the page box, read rather than
    // guessed — the whole reason a PDF is the better thing to upload.
    const natural = page.getViewport({ scale: 1 });
    if (pageNumber === 1) {
      widthPt = roundPoints(natural.width);
      heightPt = roundPoints(natural.height);
    }

    const wanted = dpi / 72;
    const longest = Math.max(natural.width, natural.height) * wanted;
    const scale = longest > MAX_RASTER_EDGE_PX ? (MAX_RASTER_EDGE_PX / Math.max(natural.width, natural.height)) : wanted;

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    // `intent: "print"` IS THE FIX FOR A TAB NOBODY IS LOOKING AT, and it was measured rather
    // than guessed. pdf.js schedules the continuation of a DISPLAY render through
    // `requestAnimationFrame` (`InternalRenderTask._scheduleNext`), and a browser stops calling
    // rAF entirely in a tab that is not painting. So somebody who starts a large scan uploading
    // and then switches windows — the ordinary thing to do while waiting — gets "Reading the
    // document…" forever, with no error to explain it. With rAF stubbed out in a live page, a
    // display render did not finish in 6 seconds; the same page at print intent finished in 79ms.
    // Print intent is also what this actually is: artwork for a paper the company prints.
    await page.render({ canvas, intent: "print", viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/png");
    });
    if (!blob) throw new Error(`Page ${pageNumber} could not be converted to an image.`);

    pages.push({
      blob,
      contentType: "image/png",
      heightPx: canvas.height,
      previewUrl: URL.createObjectURL(blob),
      widthPx: canvas.width,
    });
  }

  return { heightPt, pages, widthPt };
}

/** One image file as a single-page template. Its intrinsic pixel size is read, not assumed. */
async function readImageFile(file: File): Promise<RasterPage> {
  const contentType = file.type.toLowerCase();
  if (contentType !== "image/png" && contentType !== "image/jpeg" && contentType !== "image/webp") {
    throw new Error("Upload a PDF, or a PNG, JPG or WEBP image.");
  }

  const previewUrl = URL.createObjectURL(file);
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ height: image.naturalHeight, width: image.naturalWidth });
    image.onerror = () => reject(new Error("That image could not be read."));
    image.src = previewUrl;
  });

  return {
    blob: file,
    contentType: contentType as CustomTemplateContentType,
    heightPx: size.height,
    previewUrl,
    widthPx: size.width,
  };
}

/**
 * The preset an image's shape is closest to, so the picker opens on the right answer.
 *
 * By ASPECT RATIO, because that is all an image tells us. A 2480 × 3508 scan is A4 at 300dpi and a
 * 2550 × 3300 scan is US Letter at 300dpi, and the only difference visible from the pixels is the
 * ratio — 1.414 against 1.294.
 */
function presetForAspect(widthPx: number, heightPx: number) {
  if (widthPx <= 0 || heightPx <= 0) return CUSTOM_TEMPLATE_PAGE_PRESETS[0];
  const ratio = heightPx / widthPx;
  let best = CUSTOM_TEMPLATE_PAGE_PRESETS[0];
  let bestGap = Number.POSITIVE_INFINITY;
  for (const preset of CUSTOM_TEMPLATE_PAGE_PRESETS) {
    const gap = Math.abs(preset.heightPt / preset.widthPt - ratio);
    if (gap < bestGap) {
      best = preset;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * WHO MAY ADD ONE IS ANSWERED BY THE SERVER, not by a prop.
 *
 * The list request already knows — it resolves the access context to read the templates — so it
 * says so in the same reply. That keeps the one authority on "can this person change what the
 * company prints" on the server, where the POST enforces it anyway, and means the page above does
 * not have to plumb a role down through a component that is only about templates.
 */
export function TemplateStudio() {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<StoredTemplate[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [pages, setPages] = useState<RasterPage[]>([]);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [note, setNote] = useState("");
  const [widthPt, setWidthPt] = useState("");
  const [heightPt, setHeightPt] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadTemplates = useCallback(async () => {
    setListError(null);
    try {
      const response = await fetch("/api/hiring-pack/custom-templates", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as
        | { canManage?: boolean; message?: string; templates?: StoredTemplate[] }
        | null;
      if (!response.ok) throw new Error(body?.message ?? `Could not read the templates (${response.status}).`);
      setTemplates(body?.templates ?? []);
      setCanManage(body?.canManage === true);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Could not read the templates.");
    } finally {
      setLoaded(true);
    }
  }, []);

  // Loaded when the section is first opened, never on page load. This sits at the foot of a screen
  // whose real job is printing today's papers, and a list nobody has asked for is a request nobody
  // asked for.
  useEffect(() => {
    if (open && !loaded) void loadTemplates();
  }, [loadTemplates, loaded, open]);

  /**
   * Object URLs are revoked when the draft they belong to goes.
   *
   * Each preview holds a blob of a few megabytes alive until it is released, and a person trying
   * three scans before picking one would otherwise leave three whole templates in memory with
   * nothing pointing at them.
   */
  const revokeDraft = useCallback((drafts: RasterPage[]) => {
    for (const page of drafts) URL.revokeObjectURL(page.previewUrl);
  }, []);

  const clearDraft = useCallback(() => {
    setPages((current) => {
      revokeDraft(current);
      return [];
    });
    setSourceName(null);
    setName("");
    setNameAr("");
    setNote("");
    setWidthPt("");
    setHeightPt("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [revokeDraft]);

  const totalBytes = useMemo(
    () => pages.reduce((sum, page) => sum + page.blob.size, 0),
    [pages],
  );

  const onFileChosen = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setError(null);
      setNotice(null);
      setReading(true);
      try {
        setPages((current) => {
          revokeDraft(current);
          return [];
        });

        if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          let result = await rasterisePdf(file, RASTER_DPI);
          let size = result.pages.reduce((sum, page) => sum + page.blob.size, 0);

          // A second pass at a lower resolution, rather than a refusal. A ten-page scanned form is a
          // real thing to upload, and telling somebody their document is too large without doing the
          // one thing that would fix it is a worse answer than a slightly softer page.
          if (size > MAX_TOTAL_BYTES) {
            revokeDraft(result.pages);
            result = await rasterisePdf(file, RASTER_DPI_FALLBACK);
            size = result.pages.reduce((sum, page) => sum + page.blob.size, 0);
            if (size > MAX_TOTAL_BYTES) {
              revokeDraft(result.pages);
              throw new Error(
                `That document is ${formatBytes(size)} even at reduced resolution — larger than the 32 MB a template may be. Split it into two templates.`,
              );
            }
            setNotice(
              `Converted at ${RASTER_DPI_FALLBACK} dpi instead of ${RASTER_DPI} — the document was too large at full resolution.`,
            );
          }

          setPages(result.pages);
          setWidthPt(String(result.widthPt));
          setHeightPt(String(result.heightPt));
        } else {
          const page = await readImageFile(file);
          const preset = presetForAspect(page.widthPx, page.heightPx);
          setPages([page]);
          setWidthPt(String(preset.widthPt));
          setHeightPt(String(preset.heightPt));
        }

        setSourceName(file.name);
        setName((current) => current || file.name.replace(/\.[^.]+$/, ""));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That file could not be read.");
      } finally {
        setReading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [revokeDraft],
  );

  const save = useCallback(async () => {
    if (pages.length === 0) {
      setError("Choose a document first.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set(
        "template",
        JSON.stringify({
          name,
          nameAr: nameAr.trim() === "" ? null : nameAr,
          note: note.trim() === "" ? null : note,
          pageHeightPt: heightPt,
          pages: pages.map((page, index) => ({
            contentType: page.contentType,
            heightPx: page.heightPx,
            pageIndex: index,
            sizeBytes: page.blob.size,
            widthPx: page.widthPx,
          })),
          pageWidthPt: widthPt,
        }),
      );
      pages.forEach((page, index) => {
        form.append(`page-${index}`, page.blob, `page-${index}.png`);
      });

      const response = await fetch("/api/hiring-pack/custom-templates", {
        body: form,
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | { message?: string; template?: StoredTemplate }
        | null;
      if (!response.ok) throw new Error(body?.message ?? `Could not save the template (${response.status}).`);

      setNotice(`"${body?.template?.name ?? name}" is in the system.`);
      clearDraft();
      await loadTemplates();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the template.");
    } finally {
      setSaving(false);
    }
  }, [clearDraft, heightPt, loadTemplates, name, nameAr, note, pages, widthPt]);

  return (
    <AdminTableShell
      action={
        <Button
          aria-expanded={open}
          className="h-10 gap-2 rounded-xl"
          onClick={() => setOpen((current) => !current)}
          type="button"
          variant="outline"
        >
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {open ? "Hide" : loaded ? `Show ${templates.length}` : "Show"}
        </Button>
      }
      description="A document uploaded here becomes a paper this system prints — no code, no deploy. A PDF is converted to images in your browser and its page size is read from the file itself."
      title="Company templates"
    >
      {!open ? null : (
        <div className="space-y-5 px-5 py-5 sm:px-6">
          {error ? (
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </AdminCallout>
          ) : null}
          {notice ? (
            <AdminCallout tone="success">
              <FileImage className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{notice}</span>
            </AdminCallout>
          ) : null}

          {!loaded ? (
            <p className="text-sm text-phx-ink-faint">Reading the company templates…</p>
          ) : canManage ? (
            <div className="rounded-2xl border border-phx-line bg-white/70 p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  className="h-10 gap-2 rounded-xl"
                  disabled={reading || saving}
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                  variant="outline"
                >
                  {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                  {reading ? "Reading the document…" : "Choose a PDF or image"}
                </Button>
                {sourceName ? (
                  <span className="text-sm text-phx-ink-soft">
                    {sourceName} · {pages.length} page{pages.length === 1 ? "" : "s"} ·{" "}
                    {formatBytes(totalBytes)}
                  </span>
                ) : (
                  <span className="text-sm text-phx-ink-faint">Nothing chosen yet.</span>
                )}
                {pages.length > 0 ? (
                  <Button
                    className="h-10 gap-2 rounded-xl"
                    disabled={saving}
                    onClick={clearDraft}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="h-4 w-4" />
                    Discard
                  </Button>
                ) : null}
                <input
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => void onFileChosen(event.target.files?.[0] ?? null)}
                  ref={fileInputRef}
                  type="file"
                />
              </div>

              {pages.length > 0 ? (
                <>
                  {/* The pages, as they will print. Scrolls INSIDE its own strip — the page itself
                      never scrolls sideways (the fits-the-screen rule). */}
                  <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
                    {pages.map((page, index) => (
                      <figure className="shrink-0" key={page.previewUrl}>
                        {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from
                            the user's own file; next/image cannot optimise one and would refuse it. */}
                        <img
                          alt={`Page ${index + 1}`}
                          className="h-40 w-auto rounded-lg border border-phx-line bg-white shadow-sm"
                          src={page.previewUrl}
                        />
                        <figcaption className="mt-1 text-center text-xs text-phx-ink-faint">
                          {index + 1} · {page.widthPx} × {page.heightPx} px
                        </figcaption>
                      </figure>
                    ))}
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className={labelClassName} htmlFor="template-name">
                        Name
                      </label>
                      <Input
                        className={inputClassName}
                        id="template-name"
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Medical insurance enrolment form"
                        value={name}
                      />
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="template-name-ar">
                        Name in Arabic
                      </label>
                      <Input
                        className={inputClassName}
                        dir="auto"
                        id="template-name-ar"
                        onChange={(event) => setNameAr(event.target.value)}
                        placeholder="استمارة الاشتراك في التأمين الطبي"
                        value={nameAr}
                      />
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="template-width">
                        Page width (points)
                      </label>
                      <Input
                        className={inputClassName}
                        id="template-width"
                        inputMode="decimal"
                        onChange={(event) => setWidthPt(event.target.value)}
                        value={widthPt}
                      />
                    </div>
                    <div>
                      <label className={labelClassName} htmlFor="template-height">
                        Page height (points)
                      </label>
                      <Input
                        className={inputClassName}
                        id="template-height"
                        inputMode="decimal"
                        onChange={(event) => setHeightPt(event.target.value)}
                        value={heightPt}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className={labelClassName} htmlFor="template-note">
                        What this paper is, for whoever reads the list next
                      </label>
                      <Input
                        className={inputClassName}
                        id="template-note"
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Signed at enrolment and filed with the insurer."
                        value={note}
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-phx-ink-faint">
                      {widthPt && heightPt
                        ? describePageSize(Number(widthPt), Number(heightPt))
                        : "Set the page size before saving."}
                    </p>
                    <Button
                      className="h-10 gap-2 rounded-xl"
                      disabled={saving || reading || name.trim() === ""}
                      onClick={() => void save()}
                      type="button"
                    >
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      {saving ? "Saving…" : "Add to the system"}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <AdminCallout>
              <FileImage className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Company templates are listed here. Adding one is a Super Admin action, because it
                changes what the system prints for everybody.
              </span>
            </AdminCallout>
          )}

          {listError ? (
            <AdminCallout tone="warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{listError}</span>
            </AdminCallout>
          ) : templates.length === 0 && loaded ? (
            <AdminCallout>
              <FileImage className="mt-0.5 h-4 w-4 shrink-0" />
              <span>No company templates yet. The ten documents above are the ones built in.</span>
            </AdminCallout>
          ) : (
            <ul className="divide-y divide-phx-line rounded-2xl border border-phx-line bg-white/70">
              {templates.map((template) => (
                <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start" key={template.id}>
                  {template.pages[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element -- streamed from a private
                    // bucket through an authenticated route; next/image cannot fetch it.
                    <img
                      alt=""
                      className="h-24 w-auto shrink-0 rounded-lg border border-phx-line bg-white"
                      src={`/api/hiring-pack/template-artwork/${template.pages[0].id}`}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-black text-phx-ink">{template.name}</span>
                      <Badge size="sm" tone="neutral">
                        v{template.version}
                      </Badge>
                      <Badge size="sm" tone={template.status === "current" ? "success" : "neutral"}>
                        {template.status === "current" ? "Current" : "Archived"}
                      </Badge>
                    </div>
                    {template.nameAr ? (
                      <p className="mt-0.5 text-sm text-phx-ink-soft" dir="auto">
                        {template.nameAr}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-phx-ink-faint">
                      {template.pages.length} page{template.pages.length === 1 ? "" : "s"} ·{" "}
                      {describePageSize(template.pageWidthPt, template.pageHeightPt)}
                    </p>
                    {template.note ? (
                      <p className="mt-1 text-xs text-phx-ink-soft">{template.note}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </AdminTableShell>
  );
}
