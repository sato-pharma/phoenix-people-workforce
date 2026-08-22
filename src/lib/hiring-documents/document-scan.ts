import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { logError } from "@/lib/observability/log";
import type { HiringDocumentScanMode } from "@/lib/hiring-documents/types";

// ─────────────────────────────────────────────────────────────────────────────
// The CamScanner step for hiring paperwork.
//
// HR photographs a birth certificate on a desk with a phone: the page is slightly grey, the
// lighting falls off towards one corner, and the phone recorded the orientation in EXIF instead of
// rotating the pixels. What arrives is a dim, possibly sideways JPEG. What has to come out is
// something that looks like it went through a flatbed scanner and prints on A4.
//
// This runs on the SERVER for the same reason `prepareInvoicePhoto` does: the photograph is already
// being uploaded, so the phone does no work, nothing extra is downloaded on Egyptian mobile data,
// and no imaging library enters the browser bundle.
//
// ONE DELIBERATE DIFFERENCE FROM THE INVOICE PIPELINE. `prepareInvoicePhoto` calls `.grayscale()`,
// and it is right to: an invoice is black ink on white paper being read by a machine, and colour is
// noise. A hiring document is the opposite. The official seal on a birth certificate is coloured,
// a national ID carries a colour photograph, and a military-status card is identified by the
// colour of its stamp. Greyscale would destroy the very marks that make the document
// verifiable, so COLOUR IS THE DEFAULT HERE. Greyscale and high-contrast stay available for the
// documents that are genuinely black-on-white — a handwritten declaration, a photocopied
// certificate — where a grey paper background is the problem rather than the point.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The long edge, in pixels, that a polished page is capped at.
 *
 * An A4 sheet at 2000px on the long edge is roughly 170 dpi — enough that small Arabic print and a
 * handwritten serial number stay legible when someone zooms in, and enough that the page prints
 * without visible blocking. Higher costs bytes on every read across the Atlantic and buys nothing a
 * human eye uses at A4.
 */
export const HIRING_SCAN_MAX_EDGE_PX = 2000;

/** JPEG quality for a polished page. Colour documents need more than the invoice pipeline's grey. */
const HIRING_SCAN_JPEG_QUALITY = 88;

/** A4 in PDF points, portrait. pdf-lib works in points; 72 points to the inch. */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

/**
 * Margin around a page image, in points. ~7mm — enough that no printer's unprintable edge clips the
 * document, small enough that the scan still fills the sheet the way a flatbed scan does.
 */
const PAGE_MARGIN_PT = 20;

export const HIRING_DOCUMENT_SCAN_MODES: readonly HiringDocumentScanMode[] = [
  "colour",
  "greyscale",
  "high-contrast",
];

export function isHiringDocumentScanMode(value: unknown): value is HiringDocumentScanMode {
  return typeof value === "string" && HIRING_DOCUMENT_SCAN_MODES.includes(value as HiringDocumentScanMode);
}

export type PolishedPage = {
  bytes: Buffer;
  /** "image/jpeg" for anything this pipeline produced; only a passthrough can be another type. */
  mimeType: string;
  /** False when polishing failed and the original bytes are being carried through. */
  polished: boolean;
  originalBytes: number;
  polishedBytes: number;
};

/**
 * Polish one photographed page.
 *
 * **Enhancement failing must never lose the page.** That is the rule `prepareInvoicePhoto` follows
 * and this follows it too: HR photographing a certificate at 4pm does not care that sharp disliked
 * the colour profile, she cares that the certificate is on record. So a failed polish falls back to
 * a plain re-encode, and a failed re-encode falls back to the original bytes.
 *
 * It differs from the invoice pipeline in one place, and deliberately. `prepareInvoicePhoto` can
 * ALWAYS pass the original through, because its output is fed to a reader that will do its best
 * with anything. This output is fed to a PDF writer, and pdf-lib embeds JPEG and PNG and nothing
 * else. So when every fallback has failed AND the bytes are not already embeddable, this throws
 * rather than returning something that will fail later, in a place with less context to explain it.
 * Reaching that point takes bytes that sharp cannot decode at all — which the route's content-type
 * check has already refused before anything gets here.
 */
export async function polishDocumentPhoto(input: {
  bytes: Buffer;
  mimeType: string;
  mode?: HiringDocumentScanMode;
}): Promise<PolishedPage> {
  const mode = input.mode ?? "colour";
  const original: PolishedPage = {
    bytes: input.bytes,
    mimeType: input.mimeType,
    polished: false,
    originalBytes: input.bytes.length,
    polishedBytes: input.bytes.length,
  };

  if (input.bytes.length === 0) return original;

  try {
    let pipeline = sharp(input.bytes)
      // FIRST, and on its own line, because it is the one step that fixes an unusable scan
      // outright: phones record orientation in EXIF rather than rotating the pixels, so a page
      // photographed in portrait can arrive on its side. A sideways certificate is not "harder to
      // read", it is filed wrong.
      .rotate();

    if (mode === "greyscale" || mode === "high-contrast") {
      pipeline = pipeline.grayscale();
    }

    pipeline = pipeline
      // The measured win of the invoice pipeline, and it applies unchanged: a desk photograph
      // occupies a narrow band of the tonal range, and stretching it to the full range turns grey
      // paper white and faint print black.
      .normalise();

    if (mode === "high-contrast") {
      // Only for documents that really are black on white. `linear` steepens the curve rather than
      // thresholding to pure 1-bit, because a hard threshold eats a light pencil signature — and a
      // signature is usually the point of the page it is on.
      pipeline = pipeline.linear(1.35, -30);
    }

    const polished = await pipeline
      // Recovers the edges of small print that survives the stretch but stays soft.
      .sharpen()
      // `withoutEnlargement` matters: upscaling a small photo invents pixels, which makes a blurred
      // serial number look confident rather than blurred.
      .resize({
        fit: "inside",
        height: HIRING_SCAN_MAX_EDGE_PX,
        width: HIRING_SCAN_MAX_EDGE_PX,
        withoutEnlargement: true,
      })
      .jpeg({ quality: HIRING_SCAN_JPEG_QUALITY })
      .toBuffer();

    // A polished image that came out empty is a failure wearing a success's clothes.
    if (polished.length === 0) return await convertToEmbeddable(input, original);

    return {
      bytes: polished,
      mimeType: "image/jpeg",
      polished: true,
      originalBytes: input.bytes.length,
      polishedBytes: polished.length,
    };
  } catch (error) {
    logError("Hiring document page could not be polished; filing the original instead", {
      labels: { event: "hiring_document_polish_failed" },
      context: { originalBytes: input.bytes.length, mimeType: input.mimeType, mode },
      error,
    });
    return await convertToEmbeddable(input, original);
  }
}

/**
 * Last resort before giving up on polish: re-encode to JPEG with no enhancement at all.
 *
 * This exists so a page whose ENHANCEMENT failed is still embeddable. If even the plain re-encode
 * fails, the original is returned only when it is already a format pdf-lib can embed — otherwise
 * the caller is told, here, rather than discovering it while assembling the PDF.
 */
async function convertToEmbeddable(
  input: { bytes: Buffer; mimeType: string },
  original: PolishedPage,
): Promise<PolishedPage> {
  try {
    const converted = await sharp(input.bytes).rotate().jpeg({ quality: HIRING_SCAN_JPEG_QUALITY }).toBuffer();
    if (converted.length > 0) {
      return {
        bytes: converted,
        mimeType: "image/jpeg",
        polished: false,
        originalBytes: input.bytes.length,
        polishedBytes: converted.length,
      };
    }
  } catch {
    // Fall through to the passthrough check below — the original error was already logged.
  }

  if (isEmbeddableImageType(input.mimeType)) return original;

  throw new Error(
    "This page could not be read as an image. Photograph it again, or upload it as a JPG, PNG or PDF.",
  );
}

function isEmbeddableImageType(mimeType: string) {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpeg" || normalized === "image/jpg" || normalized === "image/png";
}

/**
 * Assemble polished pages into one A4 PDF, in the order given.
 *
 * WHY A4 RATHER THAN THE IMAGE'S OWN ASPECT. These documents get printed and put in a physical
 * personnel file. A PDF whose page is exactly the photograph's aspect prints as an odd band on an
 * A4 sheet and lands in the folder at a different size from everything around it. Fitting each page
 * inside a real A4 sheet — rotated to landscape when the photograph is wider than it is tall, so an
 * ID card is not shrunk to a strip — is what makes the output a document rather than a picture.
 */
export async function buildScannedDocumentPdf(pages: PolishedPage[]): Promise<{
  bytes: Buffer;
  pageCount: number;
}> {
  if (pages.length === 0) {
    throw new Error("Add at least one page before saving the scan.");
  }

  const pdf = await PDFDocument.create();

  for (const page of pages) {
    const image = isPngBuffer(page.bytes)
      ? await pdf.embedPng(page.bytes)
      : await pdf.embedJpg(page.bytes);

    // A photograph wider than it is tall gets a landscape sheet. Forcing it onto portrait A4 would
    // shrink an ID card or a wide certificate to a third of the page for no reason.
    const landscape = image.width > image.height;
    const pageWidth = landscape ? A4_HEIGHT_PT : A4_WIDTH_PT;
    const pageHeight = landscape ? A4_WIDTH_PT : A4_HEIGHT_PT;
    const sheet = pdf.addPage([pageWidth, pageHeight]);

    const availableWidth = pageWidth - PAGE_MARGIN_PT * 2;
    const availableHeight = pageHeight - PAGE_MARGIN_PT * 2;
    const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;

    sheet.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  const bytes = Buffer.from(await pdf.save());
  return { bytes, pageCount: pages.length };
}

/**
 * PNG detection by magic bytes, not by the declared MIME type.
 *
 * The declared type is whatever the browser guessed from the file extension, and a `.png` that is
 * really a JPEG is common enough that trusting the label produces a "Failed to parse PNG" error
 * naming the wrong problem. The first eight bytes of a PNG are fixed by the format.
 */
function isPngBuffer(bytes: Buffer) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/**
 * Polish a batch of photographed pages and assemble them into a single PDF.
 *
 * The one entry point the API route needs: a phone sends N photographs of one document, and one
 * scanned PDF comes back. Pages are polished in sequence rather than in parallel — sharp holds a
 * decoded bitmap per image, and four 12-megapixel photographs decoded at once is ~200MB of resident
 * memory on a container sized for a Next.js server.
 */
export async function scanPagesToPdf(input: {
  mode?: HiringDocumentScanMode;
  pages: Array<{ bytes: Buffer; mimeType: string }>;
}): Promise<{ bytes: Buffer; pageCount: number; polishedPages: number }> {
  const polished: PolishedPage[] = [];
  for (const page of input.pages) {
    polished.push(await polishDocumentPhoto({ bytes: page.bytes, mimeType: page.mimeType, mode: input.mode }));
  }

  const pdf = await buildScannedDocumentPdf(polished);
  return {
    bytes: pdf.bytes,
    pageCount: pdf.pageCount,
    polishedPages: polished.filter((page) => page.polished).length,
  };
}
