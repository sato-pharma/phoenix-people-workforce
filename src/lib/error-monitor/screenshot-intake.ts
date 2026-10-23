// The limits on /api/errors/client/screenshot — the second endpoint anyone, signed in or not, can
// write through, and the only one that accepts BYTES.
//
// WHY ITS OWN ROUTE AND ITS OWN BOUNDS. `/api/errors/client` is deliberately capped at 64 KB with
// every stored field truncated (`client-error-intake.ts`, the 23 Oct 2026 audit P5-03 limits), and
// those caps must not be loosened to carry a picture. So the image travels separately, under caps of
// its own: a smaller rate limit than the report, a hard byte ceiling, one fixed content type, and a
// signed ticket that only the report's own response hands out. An address that has not just filed a
// real error cannot upload anything at all.
//
// Pure, so the caps are tested without a request, a bucket or a database.

/** Private bucket, created by the `app_error_events_screenshot` migration. Never public. */
export const ERROR_SCREENSHOT_BUCKET = "error-screenshots";

/**
 * One viewport, rasterised from the page's own DOM and encoded as WebP at quality 0.7, lands well
 * under this on every page measured. The ceiling is what stops a crafted upload, not a real capture.
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

/** The one format accepted. Sniffed from the bytes, never trusted from the header. */
export const ERROR_SCREENSHOT_CONTENT_TYPE = "image/webp";

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

/**
 * Where one capture is stored: `YYYY/MM/DD/<event id>.webp`.
 *
 * Partitioned by Cairo day so a day's pictures can be listed, aged and deleted as a unit, and keyed
 * by the error row's own id so a second upload against one report overwrites rather than multiplies.
 */
export function errorScreenshotObjectPath(eventId: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "0000";
  return `${part("year")}/${part("month")}/${part("day")}/${eventId}.webp`;
}
