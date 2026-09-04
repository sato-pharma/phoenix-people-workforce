// A company template — what it is, what a valid one looks like, and where its artwork lives.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PURE, AND SEPARATE FROM THE STORE ON PURPOSE. Everything here is arithmetic and string checks:
// the page-size presets, the limits, and the validation that decides whether an upload becomes a
// row. None of it touches a database or storage, so the rules that refuse a bad template can be
// tested without either — and the rules are the part worth testing, because the failure they
// prevent is a template that looks fine in the list and prints nothing.
//
// THE VALIDATION MIRRORS THE TABLE'S OWN CHECKS, deliberately and with duplication. The migration
// already refuses a blank name and a non-positive page size. This exists so the refusal reaching a
// person is a sentence they can act on rather than a Postgres constraint name, and so a bad request
// costs one round trip instead of an insert that fails halfway through an upload.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { customDocumentFor, type CustomHiringPackDocument } from "@/lib/hiring-pack/types";

/** The private bucket the artwork lives in. Matches the migration's `storage.buckets` row. */
export const CUSTOM_TEMPLATE_BUCKET = "hiring-pack-templates";

/**
 * Matches `file_size_limit` on the bucket, and both exist so the failure is a message rather than
 * a storage error string. Per PAGE, not per template: a scanned A4 page at print resolution is
 * roughly 1–3MB as a PNG, so fifteen is generous for one side and still refuses a photograph
 * somebody dropped in at 48 megapixels.
 */
export const CUSTOM_TEMPLATE_MAX_PAGE_BYTES = 15 * 1024 * 1024;

/**
 * Matches `allowed_mime_types` on the bucket.
 *
 * NO PDF, and that is the whole of decision B0. A PDF is rasterised in the BROWSER before it gets
 * here — pdf.js draws each page to a canvas and the canvas is uploaded as a PNG. Rasterising on the
 * server would mean a native image dependency in the server bundle, and this repository has already
 * been taken down once by a top-level `import sharp` 500ing a whole page when its `.so` was missing.
 * The browser has canvas already.
 */
export const CUSTOM_TEMPLATE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

export type CustomTemplateContentType = (typeof CUSTOM_TEMPLATE_CONTENT_TYPES)[number];

/**
 * How many sides one template may have.
 *
 * Not a storage limit — it is a "you dropped the wrong file" limit. Every paper in this module is
 * between one and four sides; a 90-page PDF arriving here is a policy manual or a scanned personnel
 * file, and rasterising all of it in the browser would hang the tab before anyone noticed.
 */
export const CUSTOM_TEMPLATE_MAX_PAGES = 24;

/**
 * The page sizes offered, in POINTS, plus what each is called.
 *
 * Points, because that is the unit the whole field layer already speaks: every stored coordinate,
 * every compiled placement and `placedFormCss` are all in points. A template measured in pixels
 * would need a scale factor at every one of those boundaries, and a scale factor that is wrong by
 * a few percent is exactly the kind of error nobody sees until a signature box lands over a printed
 * rule.
 *
 * A4 is 210 × 297mm at 72pt to the inch. US Letter and US Legal are the two the government forms in
 * this module are NOT — Form 1 is 612.12 × 1008.12pt, which is neither — which is why "Custom" is
 * here and is not an afterthought: the real papers this company prints are frequently an odd size.
 */
export const CUSTOM_TEMPLATE_PAGE_PRESETS = [
  { heightPt: 841.89, id: "a4", label: "A4 — 210 × 297 mm", widthPt: 595.28 },
  { heightPt: 792, id: "letter", label: "US Letter — 8.5 × 11 in", widthPt: 612 },
  { heightPt: 1008, id: "legal", label: "US Legal — 8.5 × 14 in", widthPt: 612 },
] as const;

export type CustomTemplatePagePresetId = (typeof CUSTOM_TEMPLATE_PAGE_PRESETS)[number]["id"];

/**
 * The bounds a page size has to fall inside: one inch, to about thirty-three.
 *
 * THE TOP END IS SET BY REAL PAPER, NOT BY GENEROSITY. 2400pt covers every ISO size up to A1
 * (1684 × 2384pt), which is already far larger than anything this module prints. Leaving room for
 * A0 would cost the check its whole purpose: an A4 page scanned at 300dpi is 2480 × 3508 pixels,
 * and those two numbers land in a width and a height box exactly as naturally as 595 × 842 do. A
 * bound that admits an A0 poster admits that mistake too, and the result is a template whose every
 * coordinate is out by a factor of four — which reads as a broken renderer rather than as a typo.
 *
 * A bound cannot catch the mix-up on its own, though: an A4 page at 200dpi is 1654 × 2339, which is
 * a perfectly plausible sheet of paper. `looksLikePixels` below is what catches that one.
 */
export const CUSTOM_TEMPLATE_MIN_PT = 72;
export const CUSTOM_TEMPLATE_MAX_PT = 2400;

/** How long a name may be. Long enough for a real form's full title, short enough to fit a row. */
export const CUSTOM_TEMPLATE_MAX_NAME_LENGTH = 160;

/** One printed side of a template, as the client describes it before it is stored. */
export type CustomTemplatePageDraft = {
  /** Zero-based, in printing order. */
  pageIndex: number;
  contentType: CustomTemplateContentType;
  sizeBytes: number;
  /** The image's own pixel size — kept so the artwork's resolution is visible without a download. */
  widthPx: number;
  heightPx: number;
};

/** A template as the upload screen describes it. Everything the row needs except the bytes. */
export type CustomTemplateDraft = {
  name: string;
  nameAr: string | null;
  pageWidthPt: number;
  pageHeightPt: number;
  note: string | null;
  /**
   * Extra restriction ON TOP of the `employee_documents` permission. Null means no extra
   * restriction — the default, and what "anyone who can already print HR forms" looks like.
   */
  printableByRoles: string[] | null;
  pages: CustomTemplatePageDraft[];
};

export type CustomTemplateDraftInput = {
  name?: unknown;
  nameAr?: unknown;
  pageWidthPt?: unknown;
  pageHeightPt?: unknown;
  note?: unknown;
  printableByRoles?: unknown;
  pages?: unknown;
};

export type ParseResult<T> = { ok: true; value: T } | { message: string; ok: false };

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalText(value: unknown): string | null {
  const text = readText(value);
  return text === "" ? null : text;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // PostgREST returns numerics as STRINGS, and so does an HTML number input. Both reach here.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isAllowedContentType(value: unknown): value is CustomTemplateContentType {
  return (
    typeof value === "string" &&
    (CUSTOM_TEMPLATE_CONTENT_TYPES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

/**
 * Round a point measurement to the two decimals the column stores.
 *
 * `numeric(10, 2)` rounds on the way in whatever this does, so doing it here means the number the
 * screen shows back is the number that was stored. A page height that reads 841.89 in the form and
 * 841.8898 in the row is the kind of difference that makes two people disagree about whether a
 * template was saved correctly.
 */
export function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Read one page's description, or say what is wrong with it.
 *
 * The page index is taken from the ARRAY POSITION, never from the payload. A client that sends
 * `pageIndex: 0` twice would otherwise insert two rows that collide on the table's unique
 * constraint — a 23505 halfway through an upload, with the first page's object already stored.
 */
function parsePage(raw: unknown, pageIndex: number): ParseResult<CustomTemplatePageDraft> {
  if (!raw || typeof raw !== "object") {
    return { message: `Page ${pageIndex + 1} is missing its details.`, ok: false };
  }
  const page = raw as Record<string, unknown>;

  if (!isAllowedContentType(page.contentType)) {
    return {
      message: `Page ${pageIndex + 1} must be a PNG, JPG, WEBP or SVG image. A PDF is converted to images before it is uploaded.`,
      ok: false,
    };
  }

  const sizeBytes = readNumber(page.sizeBytes);
  if (sizeBytes === null || sizeBytes <= 0) {
    return { message: `Page ${pageIndex + 1} is empty. Choose the file again.`, ok: false };
  }
  if (sizeBytes > CUSTOM_TEMPLATE_MAX_PAGE_BYTES) {
    return {
      message: `Page ${pageIndex + 1} is larger than 15 MB. Scan it at a lower resolution.`,
      ok: false,
    };
  }

  const widthPx = readNumber(page.widthPx);
  const heightPx = readNumber(page.heightPx);
  if (widthPx === null || heightPx === null || widthPx <= 0 || heightPx <= 0) {
    return { message: `Page ${pageIndex + 1} has no readable image size.`, ok: false };
  }

  return {
    ok: true,
    value: {
      contentType: String(page.contentType).trim().toLowerCase() as CustomTemplateContentType,
      heightPx: Math.round(heightPx),
      pageIndex,
      sizeBytes: Math.round(sizeBytes),
      widthPx: Math.round(widthPx),
    },
  };
}

/**
 * WHETHER THE PAGE SIZE IS ACTUALLY THE IMAGE'S PIXEL SIZE — the mistake a bound cannot catch.
 *
 * A page size typed off the scan's dimensions is the commonest way a template comes out wrong,
 * and at 200dpi an A4 page is 1654 × 2339, which is a perfectly plausible sheet of paper. No range
 * check can separate that from a real large-format document. What DOES separate them is that the
 * declared size matches the artwork's pixel count, which is only true at 72dpi — screen
 * resolution, unusable as print artwork anyway. So both readings of this state are wrong, and the
 * message says both.
 *
 * Within one per cent, because a rounded page box (595.28 against 595px) is the same mistake.
 */
function looksLikePixels(page: CustomTemplatePageDraft, widthPt: number, heightPt: number): boolean {
  const near = (pt: number, px: number) => Math.abs(pt - px) <= Math.max(2, px * 0.01);
  return near(widthPt, page.widthPx) && near(heightPt, page.heightPx);
}
/**
 * Turn what the upload screen sent into a template, or say in one sentence why it is not one.
 *
 * EVERY MESSAGE IS ADDRESSED TO THE PERSON UPLOADING, not to a developer reading a log. This is the
 * only gate between a dropped file and a paper the company prints, and the person on the other side
 * of it is an HR administrator who has a scanned form and a deadline.
 */
export function parseCustomTemplateDraft(
  input: CustomTemplateDraftInput,
): ParseResult<CustomTemplateDraft> {
  const name = readText(input.name);
  if (name === "") return { message: "Give the template a name.", ok: false };
  if (name.length > CUSTOM_TEMPLATE_MAX_NAME_LENGTH) {
    return {
      message: `That name is longer than ${CUSTOM_TEMPLATE_MAX_NAME_LENGTH} characters. Shorten it.`,
      ok: false,
    };
  }

  const pageWidthPt = readNumber(input.pageWidthPt);
  const pageHeightPt = readNumber(input.pageHeightPt);
  if (pageWidthPt === null || pageHeightPt === null) {
    return { message: "Choose a page size, or type a width and a height.", ok: false };
  }
  for (const [label, measure] of [
    ["width", pageWidthPt],
    ["height", pageHeightPt],
  ] as const) {
    if (measure < CUSTOM_TEMPLATE_MIN_PT || measure > CUSTOM_TEMPLATE_MAX_PT) {
      return {
        message: `The page ${label} must be between ${CUSTOM_TEMPLATE_MIN_PT} and ${CUSTOM_TEMPLATE_MAX_PT} points — that is 1 to 33 inches, which covers every paper size up to A1. A scan's pixel dimensions land outside this.`,
        ok: false,
      };
    }
  }

  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    return { message: "A template needs at least one page.", ok: false };
  }
  if (input.pages.length > CUSTOM_TEMPLATE_MAX_PAGES) {
    return {
      message: `A template can have at most ${CUSTOM_TEMPLATE_MAX_PAGES} pages. This file has ${input.pages.length}.`,
      ok: false,
    };
  }

  const pages: CustomTemplatePageDraft[] = [];
  for (let index = 0; index < input.pages.length; index += 1) {
    const parsed = parsePage(input.pages[index], index);
    if (!parsed.ok) return parsed;
    pages.push(parsed.value);
  }

  for (const page of pages) {
    if (!looksLikePixels(page, pageWidthPt, pageHeightPt)) continue;
    return {
      message: `Page ${page.pageIndex + 1}'s page size in points is the same as its size in pixels (${page.widthPx} × ${page.heightPx}). Either the page size was typed from the image's dimensions — it should be the size of the paper, so 595 × 842 for A4 — or the artwork is at screen resolution and needs re-exporting at 200 dpi or more.`,
      ok: false,
    };
  }

  // NULL AND AN EMPTY ARRAY ARE DIFFERENT ANSWERS and both are kept. Null is "no extra restriction",
  // which is the default. An empty array is "nobody", which is a real thing to want for a template
  // being prepared before it is ready to be printed — and turning one into the other here would
  // silently publish it.
  let printableByRoles: string[] | null = null;
  if (input.printableByRoles !== undefined && input.printableByRoles !== null) {
    if (!Array.isArray(input.printableByRoles)) {
      return { message: "Who may print this must be a list of roles.", ok: false };
    }
    const roles = input.printableByRoles.map((role) => readText(role)).filter((role) => role !== "");
    printableByRoles = Array.from(new Set(roles));
  }

  return {
    ok: true,
    value: {
      name,
      nameAr: readOptionalText(input.nameAr),
      note: readOptionalText(input.note),
      pageHeightPt: roundPoints(pageHeightPt),
      pages,
      pageWidthPt: roundPoints(pageWidthPt),
      printableByRoles,
    },
  };
}

/**
 * Which preset a width and height are, or null for a size that is not one of them.
 *
 * Tolerant to half a point, because a PDF's own page box is rarely exactly 595.28 × 841.89 — a
 * document produced by Word reports 595.32 × 841.92, and calling that "Custom" in the list would
 * be technically true and useless.
 */
export function pagePresetFor(widthPt: number, heightPt: number): CustomTemplatePagePresetId | null {
  for (const preset of CUSTOM_TEMPLATE_PAGE_PRESETS) {
    if (Math.abs(preset.widthPt - widthPt) <= 0.5 && Math.abs(preset.heightPt - heightPt) <= 0.5) {
      return preset.id;
    }
  }
  return null;
}

/**
 * Where one page's artwork lives: `<template key>/v<version>/<index>-<random>.<ext>`.
 *
 * KEYED BY THE TEMPLATE'S STABLE KEY AND ITS VERSION, so replacing a template's artwork writes
 * beside the old objects rather than over them. That is the same rule the archive runs on: a
 * superseded version stays printable, and it cannot stay printable if its pages were overwritten by
 * the ones that replaced them.
 *
 * The random segment makes the path genuinely unique, which is what lets `storage_path` carry a
 * UNIQUE constraint and therefore guarantee one object belongs to exactly one row.
 */
export function buildCustomTemplatePagePath(input: {
  templateKey: string;
  version: number;
  pageIndex: number;
  contentType: CustomTemplateContentType;
  unique: string;
}): string {
  const extension =
    input.contentType === "image/jpeg"
      ? "jpg"
      : input.contentType === "image/svg+xml"
        ? "svg"
        : input.contentType === "image/webp"
          ? "webp"
          : "png";
  const safeUnique = input.unique.replace(/[^a-zA-Z0-9-]+/g, "").slice(0, 32) || "page";
  return `${input.templateKey}/v${input.version}/${String(input.pageIndex).padStart(2, "0")}-${safeUnique}.${extension}`;
}

/** The `custom:<key>` document identity for a stored template. */
export function documentForTemplateKey(templateKey: string): CustomHiringPackDocument {
  return customDocumentFor(templateKey);
}
