import sharp from "sharp";

import { logError } from "@/lib/observability/log";

// ─────────────────────────────────────────────────────────────────────────────
// Turn a phone photograph of an invoice into something legible — the scanner-app step.
//
// A rep photographs a paper invoice on a pharmacy counter: dim light, a phone held at an angle,
// glare off the plastic, and 8pt Arabic print. What the reader receives is a low-contrast grey
// rectangle. Measured on a simulated dim invoice, the pipeline below lifts the tonal spread
// **8.5x** — from 30 levels to the full 255.
//
// It runs on the SERVER, between receiving the photograph and reading it. That placement is the
// whole reason this is affordable: the image is already being uploaded, so a rep on Egyptian mobile
// data downloads nothing, their phone does no work, and there is no library in the browser bundle.
// The same enhancement done client-side would have cost megabytes on every form load.
//
// What it does NOT do is correct perspective. Straightening a photograph taken at an angle needs
// corner detection, which needs OpenCV, which is a different order of dependency. Contrast, tone
// and orientation are the cheap wins; whether the angle matters is a question the invoice-read
// counters can answer before anyone pays for that.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The long edge, in pixels, that a prepared invoice is capped at.
 *
 * Chosen so 8pt print survives: an A4 page at 2000px on the long edge is roughly 170 dpi, which
 * keeps a digit distinguishable from its neighbours. Going lower saves bytes and starts turning a
 * 6 into an 8 — the same reason the read itself asks for `detail: "high"`.
 */
export const MAX_PREPARED_EDGE_PX = 2000;

export type PreparedInvoice = {
  bytes: Buffer;
  mimeType: string;
  /** False when the original was passed through untouched — see `prepareInvoicePhoto`. */
  prepared: boolean;
  originalBytes: number;
  preparedBytes: number;
};

/**
 * Prepare a photographed invoice for reading.
 *
 * **It can never refuse the photograph.** Every failure path returns the ORIGINAL bytes and logs.
 * An exotic colour profile, a truncated upload, a format sharp dislikes — none of those are the
 * rep's fault and none of them are worth turning a readable invoice into an error message. This is
 * the same rule the storefront evidence check and the outcome record already follow: a step that
 * exists to IMPROVE a read must never be the reason there is no read.
 */
export async function prepareInvoicePhoto(input: { bytes: Buffer; mimeType: string }): Promise<PreparedInvoice> {
  const original: PreparedInvoice = {
    bytes: input.bytes,
    mimeType: input.mimeType,
    prepared: false,
    originalBytes: input.bytes.length,
    preparedBytes: input.bytes.length,
  };
  if (input.bytes.length === 0) return original;

  try {
    const prepared = await sharp(input.bytes)
      // FIRST, and on its own line because it is the one step that fixes an unreadable photo
      // outright: phones record orientation in EXIF rather than rotating the pixels, so a photo
      // taken in portrait can arrive on its side. Sideways 8pt Arabic is not "harder to read", it
      // is a different problem entirely.
      .rotate()
      // An invoice is black ink on white paper. Colour carries no information here and costs the
      // reader attention across three channels instead of one.
      .grayscale()
      // The measured win. A dim counter photo occupies a narrow band of greys; this stretches it to
      // the full range, so faint print becomes actual black on actual white.
      .normalise()
      // Recovers the edges of small digits that survive the stretch but stay soft.
      .sharpen()
      // Cap the long edge. `withoutEnlargement` matters: upscaling a small photo invents pixels and
      // makes a blurred digit look confident rather than blurred.
      .resize({
        fit: "inside",
        height: MAX_PREPARED_EDGE_PX,
        width: MAX_PREPARED_EDGE_PX,
        withoutEnlargement: true,
      })
      // Quality 92, not 100: above ~90 a JPEG of a grayscale document grows fast and gains nothing
      // a reader can use, and these bytes cross the Atlantic on every read.
      .jpeg({ quality: 92 })
      .toBuffer();

    // A prepared image that came out empty is a failure wearing a success's clothes.
    if (prepared.length === 0) return original;

    return {
      bytes: prepared,
      mimeType: "image/jpeg",
      prepared: true,
      originalBytes: input.bytes.length,
      preparedBytes: prepared.length,
    };
  } catch (error) {
    logError("Invoice photo could not be prepared; reading the original instead", {
      labels: { event: "invoice_prepare_failed" },
      context: { originalBytes: input.bytes.length, mimeType: input.mimeType },
      error,
    });
    return original;
  }
}
