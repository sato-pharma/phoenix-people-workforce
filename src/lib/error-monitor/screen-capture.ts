"use client";

/**
 * THE ERROR SCREENSHOT — the browser half.
 *
 * Owner, 23 Oct 2026: every error or block a person meets leaves a picture of exactly what they saw,
 * for the Super Admin's System Audit page only, kept 90 days (docs/system-audit.md, "What the person
 * saw"). One door leads here:
 *
 *   1. `installScreenCapture()` wraps `window.fetch` once, from GlobalErrorReporter. A same-origin
 *      `/api/` request that answers 4xx (REFUSED — the person was blocked) or 5xx, or that never gets
 *      an answer at all (FAILED), is photographed ~900 ms later, once the page has drawn the refusal.
 *   An ERROR SCREEN (a crash) is not photographed here: the crash screenshot of #6358
 *      (`/api/errors/client/screenshot`, docs/observability.md) already takes it, guests included,
 *      on the error row itself — a second picture of the same crash would be noise.
 *
 * THE WRAPPER NEVER CHANGES WHAT THE CALLER GETS. It returns the very promise the real fetch returned,
 * before doing anything else; everything it does happens on a separate branch of that promise whose
 * failures are swallowed. It never retries, never delays the result, never throws, and never wraps
 * twice (a global marker, so a hot reload or a second mount is a no-op). The refusal's words are read
 * from a CLONE of the response, before the caller can consume the body.
 *
 * WHAT IS NEVER PHOTOGRAPHED: the skip list in screen-capture-rules.ts (the capture's own endpoint,
 * sign-in and the heartbeat, background polls), a hidden tab, a GET answered 404, a request the page
 * itself cancelled, anything while the browser reports itself offline (the picture could not be sent),
 * and anything beyond the per-tab throttle — the same screen once in 2 minutes, 12 a tab an hour.
 *
 * NOT IN DEVELOPMENT. A local `next dev` reads and writes production (AGENTS.md §3), so a developer's
 * screen would land in the production bucket; the wrapper installs only in a production build.
 */

import {
  CAPTURE_DELAY_MS,
  EMPTY_SCREEN_THROTTLE,
  MAX_REFUSAL_BODY_BYTES,
  classifyScreenKind,
  decideScreenThrottle,
  extractRefusalMessage,
  isSkippedScreenPath,
  pathWithoutQuery,
  sameOriginApiPath,
  screenThrottleKey,
  type ScreenKind,
  type ScreenThrottleState,
} from "@/lib/error-monitor/screen-capture-rules";

export {
  classifyScreenKind,
  decideScreenThrottle,
  extractRefusalMessage,
  isSkippedScreenPath,
  maskApiPath,
  sameOriginApiPath,
  screenThrottleKey,
  SCREEN_CAPTURE_SKIP_LIST,
} from "@/lib/error-monitor/screen-capture-rules";

export const SCREEN_CAPTURE_ENDPOINT = "/api/errors/screen";
const INSTALLED_MARKER = "__phoenixScreenCaptureInstalled";
/** The decoded picture the server accepts; one over it is re-drawn once smaller, then dropped. */
const MAX_IMAGE_BYTES = 1_200_000;
/** A 1×1 transparent GIF stands in for any image the picture cannot load, so one bad image never sinks it. */
const IMAGE_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type CaptureInput = {
  kind: ScreenKind;
  status: number | null;
  method: string | null;
  apiPath: string | null;
  message: string | null;
};

let throttle: ScreenThrottleState = EMPTY_SCREEN_THROTTLE;
let capturing = false;
let realFetch: typeof fetch | null = null;

function isProductionBuild(): boolean {
  return process.env.NODE_ENV === "production";
}

function decodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/**
 * Above this many elements the page is not drawn at all. html-to-image copies every computed style of
 * every element it keeps, on the main thread, about a second after the person met the refusal — on a
 * page this large that is a freeze, and on a rep’s tablet it can be a crashed tab (risk review,
 * 23 Oct 2026). The refusal is still in the ledger through its own error row; only the picture is lost.
 */
export const SCREEN_MAX_ELEMENTS = 15_000;

/**
 * Only what is on screen is copied. An element whose box lies wholly outside the viewport cannot
 * appear in a viewport-sized picture, and dropping it drops its whole subtree — the long table below
 * the fold, the closed tabs — which is most of the cost. A zero-size box is kept: it may hold visible
 * children positioned outside it. Text and other non-element nodes are always kept.
 * Shared with the crash picture in capture-screenshot.ts, which had neither guard until 23 Oct 2026.
 */
export function onScreen(node: Node): boolean {
  if (!(node instanceof Element)) return true;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

/** The visible viewport, at the current scroll position, as a JPEG data URL — or null. */
async function drawViewport(pixelRatio: number, quality: number): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const body = document.body;
  if (!body) return null;
  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  const { toJpeg } = await import("html-to-image");
  const background = getComputedStyle(body).backgroundColor;
  const dataUrl = await toJpeg(body, {
    backgroundColor: background && background !== "rgba(0, 0, 0, 0)" ? background : "#ffffff",
    cacheBust: false,
    filter: onScreen,
    height,
    imagePlaceholder: IMAGE_PLACEHOLDER,
    pixelRatio,
    quality,
    // A margin, not a transform, moves the page to the scroll position: a transform would make every
    // fixed element (a toast, a dialog — usually the refusal itself) scroll away with the page.
    style: { margin: "0", marginLeft: `${-Math.round(window.scrollX)}px`, marginTop: `${-Math.round(window.scrollY)}px` },
    width,
  });
  return { dataUrl, width, height };
}

async function captureAndSend(input: CaptureInput): Promise<void> {
  if (capturing) return;
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (document.getElementsByTagName("*").length > SCREEN_MAX_ELEMENTS) return;

  const pagePath = pathWithoutQuery(window.location.pathname);
  const key = screenThrottleKey({ kind: input.kind, apiPath: input.apiPath, pagePath, status: input.status });
  const decision = decideScreenThrottle(throttle, key, Date.now());
  throttle = decision.state;
  if (!decision.allowed) return;

  capturing = true;
  try {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    let picture = await drawViewport(ratio, 0.6);
    // Too big to send: drawn once more, smaller. Never a third time.
    if (picture && decodedBytes(picture.dataUrl) > MAX_IMAGE_BYTES) picture = await drawViewport(1, 0.4);
    if (!picture || decodedBytes(picture.dataUrl) > MAX_IMAGE_BYTES) return;

    const send = realFetch ?? window.fetch.bind(window);
    await send(SCREEN_CAPTURE_ENDPOINT, {
      body: JSON.stringify({
        apiPath: input.apiPath,
        height: picture.height,
        image: picture.dataUrl,
        kind: input.kind,
        message: input.message,
        method: input.method,
        pagePath,
        status: input.status,
        width: picture.width,
      }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => undefined);
  } catch {
    // A picture that cannot be drawn or sent is simply not kept.
  } finally {
    capturing = false;
  }
}

function later(input: CaptureInput): void {
  try {
    window.setTimeout(() => {
      void captureAndSend(input).catch(() => undefined);
    }, CAPTURE_DELAY_MS);
  } catch {
    // Never let the capture surface as an error of its own.
  }
}

function describeRequest(input: RequestInfo | URL, init: RequestInit | undefined): { path: string; method: string } | null {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = sameOriginApiPath(url, window.location.origin);
  if (!path || isSkippedScreenPath(path)) return null;
  const method = String(init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET")).toUpperCase();
  return { path, method };
}

async function onAnswer(request: { path: string; method: string }, response: Response): Promise<void> {
  if (capturing) return;
  const kind = classifyScreenKind({ status: response.status, networkFailure: false, method: request.method });
  if (!kind) return;
  let message: string | null = null;
  try {
    const length = Number(response.headers.get("content-length"));
    if (!(Number.isFinite(length) && length > MAX_REFUSAL_BODY_BYTES)) {
      const text = await response.clone().text();
      if (text.length <= MAX_REFUSAL_BODY_BYTES) message = extractRefusalMessage(response.headers.get("content-type"), text);
    }
  } catch {
    // The caller consumed the body first, or it was not readable: the picture still says it.
  }
  later({ kind, status: response.status, method: request.method, apiPath: request.path, message });
}

function onFailure(request: { path: string; method: string }, error: unknown): void {
  if (capturing) return;
  // The page cancelled its own request — nobody was refused anything.
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return;
  later({ kind: "failed_request", status: null, method: request.method, apiPath: request.path, message: null });
}

/** Wraps window.fetch once. Safe to call any number of times; does nothing outside a production build. */
export function installScreenCapture(): void {
  try {
    if (typeof window === "undefined" || !isProductionBuild()) return;
    const marked = window as unknown as Record<string, unknown>;
    if (marked[INSTALLED_MARKER]) return;
    const original = window.fetch;
    if (typeof original !== "function") return;
    marked[INSTALLED_MARKER] = true;
    realFetch = original.bind(window);

    const wrapped = function phoenixScreenCaptureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const result = original.call(window, input, init);
      try {
        if (!capturing) {
          const request = describeRequest(input, init);
          if (request) {
            // A separate branch: the caller gets `result` untouched, and nothing here can reject it.
            result.then(
              (response) => onAnswer(request, response).catch(() => undefined),
              (error: unknown) => onFailure(request, error),
            ).catch(() => undefined);
          }
        }
      } catch {
        // Never let the wrapper cost the caller its answer.
      }
      return result;
    };
    window.fetch = wrapped as typeof fetch;
  } catch {
    // Not installed — the app works exactly as before.
  }
}
