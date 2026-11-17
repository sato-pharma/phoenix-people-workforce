"use client";

import {
  REFUSAL_DRAW_TIMEOUT_MS,
  SCREEN_MAX_ELEMENTS,
  pictureFilter,
  withCaptureLock,
} from "@/lib/error-monitor/screen-capture";
import { ERROR_SCREENSHOT_MAX_BYTES } from "@/lib/error-monitor/screenshot-intake";

/**
 * A picture of the screen the employee was actually looking at when it broke (owner, 23 Oct 2026).
 *
 * HOW, AND WHAT IT IS NOT. A web page cannot photograph itself — there is no browser API that hands
 * a page its own pixels, and the one that comes close (`getDisplayMedia`) puts a permission prompt
 * in front of someone whose screen has just broken. So this RASTERISES the live DOM: it walks the
 * document, inlines what it can reach, and paints it into a canvas. That is a real image of the real
 * page, and it is what every error tool that offers "a screenshot" is doing. Three things it cannot
 * reproduce, by construction, and none of them is a bug to chase:
 *
 *   - cross-origin images and fonts the page never got permission to read back;
 *   - the inside of an `<iframe>`;
 *   - a `<canvas>` another origin's pixels have tainted.
 *
 * WHEN. After the error UI has painted, not at the moment of the throw — the point is the screen the
 * employee is sitting in front of, which is the boundary's fallback card, not the half-torn tree
 * behind it. Two animation frames plus a short settle gets past React's commit and the paint.
 *
 * NEVER COSTLY, NEVER LOUD. Bounded by a timeout, a size ceiling and a per-page-load count, drawn
 * under the one capture lock it shares with the refusal picture (screen-capture.ts), wrapped so
 * nothing it does can surface as a second error on top of the one being reported, and entirely
 * absent from the path when the report found no row to attach to.
 *
 * WEBP, OR JPEG WHERE THE BROWSER CANNOT ENCODE WEBP (Safari, every Apple device) — `encodeCapture`.
 */

/** Past React's commit and the browser's paint of the fallback, without pinning a frame. */
const SETTLE_MS = 180;

/** The whole capture, rasterise and encode. A page too heavy to draw in this is one we let go. */
const CAPTURE_TIMEOUT_MS = 3_000;

/** Downscale wide screens: a 2,560-pixel desktop is legible at this and a third of the bytes. */
const MAX_CAPTURE_WIDTH = 1_280;

/** WebP (or the JPEG fallback) at this is visually clean for a UI screenshot and a fraction of the equivalent PNG. */
export const CAPTURE_QUALITY = 0.7;

/**
 * How long a crash picture waits for the capture lock a REFUSAL picture is holding — that one gives it
 * back within its own draw timeout — before letting this picture go. The crash picture is the one the
 * owner asked for first, so it waits rather than gives up at once (screen-capture.ts, the shared lock).
 */
const CAPTURE_LOCK_WAIT_MS = REFUSAL_DRAW_TIMEOUT_MS + 1_000;

/**
 * A single streamed tree being orphaned fires 16–23 errors at once (see `report-client-error.ts`).
 * They are one picture, so only the first couple on a page load are worth taking.
 */
const MAX_CAPTURES_PER_PAGE_LOAD = 2;

let capturesThisPageLoad = 0;

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, SETTLE_MS);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, SETTLE_MS)));
  });
}

/** The one thing the encoder needs of a canvas, so the format choice is tested without a browser. */
type EncodableCanvas = { toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void };

function canvasBlob(canvas: EncodableCanvas, type: string, quality: number): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The picture as WebP, or as JPEG at the same quality when this browser cannot encode WebP; null
 * when it can do neither. The blob's own `type` is what was really encoded, and it is sent as the
 * upload's Content-Type.
 *
 * WHY THE FALLBACK (17 Nov 2026). WebKit cannot encode WebP: on an iPhone, an iPad or Safari on a
 * Mac, `toBlob(…, "image/webp")` does not fail — it silently hands back a PNG. That PNG went up
 * labelled `image/webp`, the route's magic-byte check refused it, and no crash picture from those
 * devices was ever stored (production, 24 Oct – 17 Nov 2026: 593 iPhone/iPad and 228 Mac Safari
 * signed-in crash reports, 0 pictures). Every browser encodes JPEG, and the route takes either.
 */
export async function encodeCapture(canvas: EncodableCanvas, quality: number = CAPTURE_QUALITY): Promise<Blob | null> {
  const webp = await canvasBlob(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await canvasBlob(canvas, "image/jpeg", quality);
  if (jpeg && jpeg.type === "image/jpeg") return jpeg;
  return null;
}

/**
 * Post one picture to the error row the ticket names, labelled with the format it really is.
 *
 * NOT `keepalive` — browsers cap a keepalive body at 64 KB, which is an eighth of a typical capture,
 * so the request would be rejected before it left. An unload loses the picture; the report it
 * belongs to was sent separately, and already landed.
 */
export async function sendErrorScreenshot(send: typeof fetch, blob: Blob, ticket: string): Promise<void> {
  await send("/api/errors/client/screenshot", {
    body: blob,
    headers: { "Content-Type": blob.type, "x-phoenix-screenshot-ticket": ticket },
    method: "POST",
  }).catch(() => {
    // Swallow — the picture is a nicety on top of a report that is already stored.
  });
}

/** The live document as a WebP (or JPEG) blob, or null when it cannot be drawn within the bounds. */
async function rasteriseViewport(): Promise<Blob | null> {
  const target = document.body;
  if (!target) return null;
  // The two guards the refusal picture (screen-capture.ts) has, for the same reason: html-to-image
  // copies every computed style of every node it keeps, on the main thread, and the timeout below
  // only stops WAITING — the work carries on. A background error on the payroll grid or a CRM board
  // froze the tab for seconds (review of #6358, 23 Oct 2026). Too big: no picture; the report stands.
  if (document.getElementsByTagName("*").length > SCREEN_MAX_ELEMENTS) return null;

  // Loaded only when something has actually crashed — it must not sit in the first-load bundle of
  // every page just to be ready for an error most sessions never see.
  const { toCanvas } = await import("html-to-image");

  const width = Math.max(1, window.innerWidth || target.clientWidth || MAX_CAPTURE_WIDTH);
  const canvas = await toCanvas(target, {
    backgroundColor: "#ffffff",
    // Off-screen boxes are copied EMPTY — the long table below the fold is most of the cost, and it
    // cannot appear in a viewport-sized picture anyway — but they keep their size, or a scrolled page
    // draws everything shifted up out of the picture (screen-capture-rules.ts, createPictureFilter).
    filter: pictureFilter(),
    // Only what is on screen. A long page's full height is not what the employee was looking at,
    // and it multiplies the bytes for the part nobody was reading.
    height: Math.max(1, window.innerHeight || target.clientHeight),
    pixelRatio: Math.min(1, MAX_CAPTURE_WIDTH / width),
    // The picture starts at the scroll position, so it is the viewport the filter above kept — without
    // this a scrolled page drew its top, whose nodes the filter had just dropped. A margin, not a
    // transform, as in screen-capture.ts: a transform would scroll fixed elements away with the page.
    style: { margin: "0", marginLeft: `${-Math.round(window.scrollX)}px`, marginTop: `${-Math.round(window.scrollY)}px` },
    width,
  });

  return encodeCapture(canvas);
}

/**
 * Take the picture and attach it to the error row the ticket names. Best-effort end to end: every
 * failure path is a silent return, because the error itself is already filed with or without this.
 */
export async function captureAndUploadErrorScreenshot(ticket: string): Promise<void> {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (!ticket) return;
    if (capturesThisPageLoad >= MAX_CAPTURES_PER_PAGE_LOAD) return;
    capturesThisPageLoad += 1;

    await nextPaint();

    // Under the capture lock the refusal picture shares (screen-capture.ts): while it is held the
    // fetch wrapper ignores requests, so this picture's own downloads of the page's images — an
    // employee photo under /api/ answering 403 — never file a "refused request" picture, and the two
    // pictures never copy the page on the main thread at once. Given back when the draw ends or runs
    // out of time, whichever is first.
    const blob = await withCaptureLock(() => rasteriseViewport(), {
      timeoutMs: CAPTURE_TIMEOUT_MS,
      waitMs: CAPTURE_LOCK_WAIT_MS,
    });
    if (!blob || blob.size === 0 || blob.size > ERROR_SCREENSHOT_MAX_BYTES) return;

    await sendErrorScreenshot(window.fetch.bind(window), blob, ticket);
  } catch {
    // Swallow — capturing the screen must never become the second error on it.
  }
}
