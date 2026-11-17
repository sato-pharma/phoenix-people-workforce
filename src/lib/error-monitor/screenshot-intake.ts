// The limits on /api/errors/client/screenshot — the second endpoint anyone, signed in or not, can
// write through, and the only one that accepts BYTES.
//
// WHY ITS OWN ROUTE AND ITS OWN BOUNDS. `/api/errors/client` is deliberately capped at 64 KB with
// every stored field truncated (`client-error-intake.ts`, the 23 Oct 2026 audit P5-03 limits), and
// those caps must not be loosened to carry a picture. So the image travels separately, under caps of
// its own: a smaller rate limit than the report, a hard byte ceiling, two image formats each proved
// by its own magic bytes, and a signed ticket that only the report's own response hands out. An
// address that has not just filed a real error cannot upload anything at all.
//
// Pure, so the caps are tested without a request, a bucket or a database.

/** Private bucket, created by the `app_error_events_screenshot` migration. Never public. */
export const ERROR_SCREENSHOT_BUCKET = "error-screenshots";

/**
 * One viewport, rasterised from the page's own DOM and encoded as WebP (or JPEG) at quality 0.7,
 * lands well under this on every page measured. The ceiling is what stops a crafted upload, not a
 * real capture.
 */
export const ERROR_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** A crashing page produces ONE picture. Lower than the 30/min the text report allows, on purpose. */
export const ERROR_SCREENSHOT_RATE_LIMIT = 10;
export const ERROR_SCREENSHOT_RATE_WINDOW_MS = 60_000;

/**
 * How long the ticket the report hands back stays usable. The browser captures immediately after the
 * error UI paints, so this is generous; it bounds replay rather than real use.
 */
export const ERROR_SCREENSHOT_TICKET_TTL_SECONDS = 120;

/**
 * The two formats accepted, each sniffed from the bytes and never trusted from the header.
 *
 * WebP is what the browser asks for. JPEG is there because Safari cannot ENCODE WebP — on an iPhone,
 * an iPad or a Mac, `canvas.toBlob(…, "image/webp")` silently hands back a PNG — so until 17 Nov 2026
 * every crash picture from those devices was refused here and none was ever stored (production,
 * 24 Oct – 17 Nov 2026: 593 iPhone/iPad and 228 Mac Safari signed-in crash reports, 0 pictures;
 * Chromium 49 of 426). The browser now falls back to JPEG (capture-screenshot.ts), and the bucket's
 * allow-list carries both (migration `20261117044749_error_screenshots_accept_jpeg`).
 */
export const ERROR_SCREENSHOT_CONTENT_TYPES = ["image/webp", "image/jpeg"] as const;
export type ErrorScreenshotContentType = (typeof ERROR_SCREENSHOT_CONTENT_TYPES)[number];

/** Is a declared Content-Length over the cap? A missing or unreadable header is not — the read is capped too. */
export function screenshotBodyTooLarge(contentLength: string | null): boolean {
  const length = Number(contentLength);
  return Number.isFinite(length) && length > ERROR_SCREENSHOT_MAX_BYTES;
}

/**
 * Are these bytes really a WebP? `RIFF` at 0, `WEBP` at 8 — the container's own magic.
 *
 * The Content-Type header is attacker-controlled, and a bucket that believes it would happily store
 * an HTML page under an image name. The bucket's own `allowed_mime_types` is the second gate; this
 * is the first, and the one that runs before anything leaves the route.
 */
export function isWebpImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (offset: number, text: string) =>
    text.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  return ascii(0, "RIFF") && ascii(8, "WEBP");
}

/** Are these bytes really a JPEG? `FF D8 FF` at 0 — the start-of-image marker and the next one's lead byte. */
export function isJpegImage(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Which accepted format these bytes really are, or null for anything else (a PNG, an HTML page). The
 * answer is what the object is stored as — its type AND its extension — so the header the caller
 * sent never decides either.
 */
export function errorScreenshotImageType(bytes: Uint8Array): ErrorScreenshotContentType | null {
  if (isWebpImage(bytes)) return "image/webp";
  if (isJpegImage(bytes)) return "image/jpeg";
  return null;
}

/**
 * Where one capture is stored: `YYYY/MM/DD/<event id>.webp`, or `.jpg` for a JPEG.
 *
 * Partitioned by Cairo day so a day's pictures can be listed, aged and deleted as a unit, and keyed
 * by the error row's own id so a second upload against one report overwrites rather than multiplies.
 * The format is a required argument so no caller can file a JPEG under a `.webp` name by default.
 */
export function errorScreenshotObjectPath(
  eventId: string,
  contentType: ErrorScreenshotContentType,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "0000";
  const extension = contentType === "image/jpeg" ? "jpg" : "webp";
  return `${part("year")}/${part("month")}/${part("day")}/${eventId}.${extension}`;
}
