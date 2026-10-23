"use client";

import { SCREEN_MAX_ELEMENTS, pictureFilter } from "@/lib/error-monitor/screen-capture";
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
 * NEVER COSTLY, NEVER LOUD. Bounded by a timeout, a size ceiling and a per-page-load count, wrapped
 * so nothing it does can surface as a second error on top of the one being reported, and entirely
 * absent from the path when the report found no row to attach to.
 */

/** Past React's commit and the browser's paint of the fallback, without pinning a frame. */
const SETTLE_MS = 180;

/** The whole capture, rasterise and encode. A page too heavy to draw in this is one we let go. */
const CAPTURE_TIMEOUT_MS = 3_000;

/** Downscale wide screens: a 2,560-pixel desktop is legible at this and a third of the bytes. */
const MAX_CAPTURE_WIDTH = 1_280;

/** WebP at this is visually clean for a UI screenshot and a fraction of the equivalent PNG. */
const CAPTURE_QUALITY = 0.7;

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

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    }),
  ]);
}

/** The live document as a WebP blob, or null when it cannot be drawn within the bounds. */
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

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/webp", CAPTURE_QUALITY);
  });
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

    const blob = await withTimeout(rasteriseViewport(), CAPTURE_TIMEOUT_MS);
    if (!blob || blob.size === 0 || blob.size > ERROR_SCREENSHOT_MAX_BYTES) return;

    // NOT `keepalive` — browsers cap a keepalive body at 64 KB, which is an eighth of a typical
    // capture, so the request would be rejected before it left. An unload loses the picture; the
    // report it belongs to was sent separately, and already landed.
    await fetch("/api/errors/client/screenshot", {
      body: blob,
      headers: { "Content-Type": "image/webp", "x-phoenix-screenshot-ticket": ticket },
      method: "POST",
    }).catch(() => {
      // Swallow — the picture is a nicety on top of a report that is already stored.
    });
  } catch {
    // Swallow — capturing the screen must never become the second error on it.
  }
}
