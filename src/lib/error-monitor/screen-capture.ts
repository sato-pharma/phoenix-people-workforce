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
 * a request with NO answer whose page was out of sight at any moment between sending and failing
 * (`noAnswerHappenedInSight` — a locked phone kills its requests, and the failure surfaced on a page
 * that was working again), anything sent or answered while either picture is being drawn (the
 * shared capture lock — html-to-image downloads the page's images again through this wrapper), and
 * anything beyond the per-tab throttle — the same screen once in 2 minutes, 12 a tab an hour.
 *
 * NOTHING WHILE THE SERVER CANNOT STORE ONE. An upload answered 5xx, 429 or not at all pauses every
 * tab of the browser — nothing drawn, nothing sent — for 5 minutes, doubling to an hour while it
 * keeps refusing (the outage pause, screen-capture-rules.ts). One picture stored ends it.
 *
 * NOT IN DEVELOPMENT. A local `next dev` reads and writes production (AGENTS.md §3), so a developer's
 * screen would land in the production bucket; the wrapper installs only in a production build.
 */

import {
  CAPTURE_DELAY_MS,
  EMPTY_SCREEN_THROTTLE,
  EMPTY_UPLOAD_PAUSE,
  MAX_REFUSAL_BODY_BYTES,
  classifyScreenKind,
  createPictureFilter,
  decideScreenThrottle,
  extractRefusalMessage,
  isSkippedScreenPath,
  nextUploadPause,
  noAnswerHappenedInSight,
  parseUploadPause,
  pathWithoutQuery,
  sameOriginApiPath,
  screenThrottleKey,
  serialiseUploadPause,
  settleUploadPause,
  uploadPaused,
  UPLOAD_PAUSE_STORAGE_KEY,
  type ScreenKind,
  type ScreenThrottleState,
  type UploadPauseState,
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
/** This tab's own copy of the outage pause, used only when localStorage cannot be read or written. */
let tabPause: UploadPauseState = EMPTY_UPLOAD_PAUSE;
let realFetch: typeof fetch | null = null;

/**
 * ONE PICTURE BEING DRAWN AT A TIME IN A TAB — the crash picture (capture-screenshot.ts) and the
 * refusal picture (here) take this same lock, and always give it back (17 Nov 2026).
 *
 * Until then only the refusal picture held a flag, and the crash picture held none, so two things went
 * wrong. html-to-image downloads every `<img>` on the page again, through `window.fetch` — this file's
 * wrapper — so an image under `/api/` (an employee photo, `/api/employees/<id>/photo`) answering 403 or
 * 5xx while a CRASH was being drawn filed a "refused request" picture of a request nobody made. And the
 * two could draw at once: two full-page copies on a phone's main thread together. While the lock is
 * held the wrapper ignores every request, as it always did during its own picture.
 */
let captureLockHeld = false;

/** Is a picture being drawn in this tab right now? */
export function isCaptureLockHeld(): boolean {
  return captureLockHeld;
}

/** Take the lock if it is free. Every taker gives it back in a `finally` (`withCaptureLock`). */
export function takeCaptureLock(): boolean {
  if (captureLockHeld) return false;
  captureLockHeld = true;
  return true;
}

export function releaseCaptureLock(): void {
  captureLockHeld = false;
}

const CAPTURE_LOCK_POLL_MS = 100;

/**
 * Take the lock, waiting up to `waitMs` for it to come free (0: one try, no wait). The first try is
 * made before anything is awaited, so a caller that has just checked the lock cannot lose it in a gap.
 */
export async function waitForCaptureLock(waitMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (!takeCaptureLock()) {
    if (Date.now() - startedAt >= waitMs) return false;
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_LOCK_POLL_MS));
  }
  return true;
}

/**
 * Draw under the lock: take it (waiting up to `waitMs`), run `draw` for at most `timeoutMs`, and give
 * it back whatever happens — a finished draw, a timeout or a throw (which is passed on). Null when the
 * lock could not be had, or the draw ran out of time.
 *
 * WHY THE TIMEOUT RELEASES THE LOCK. html-to-image waits on every image and font download with no limit
 * of its own, so one stalled download on a dead mobile connection would hold the lock — and so switch
 * off every picture in that tab — for as long as the page stayed open. The timeout only stops WAITING:
 * a stalled draw carries on in the background, idle on the network. Its downloads were sent while the
 * lock was held, and the wrapper judges a request by whether the lock was held when it was SENT, so
 * they still never become pictures of their own.
 */
export async function withCaptureLock<T>(
  draw: () => Promise<T>,
  options: { timeoutMs: number; waitMs?: number },
): Promise<T | null> {
  if (!(await waitForCaptureLock(options.waitMs ?? 0))) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      draw(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    releaseCaptureLock();
  }
}

/**
 * The refusal picture's whole drawing — one draw, or two when the first is too big to send — is given
 * this long under the lock (`withCaptureLock`). A normal draw takes well under a second.
 */
export const REFUSAL_DRAW_TIMEOUT_MS = 5_000;
/** Bumped each time the page goes out of sight, so a request can tell it was hidden while in flight. */
let hiddenEpoch = 0;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

type SendSight = { sentHidden: boolean; epochAtSend: number };

/**
 * The outage pause every tab shares, as it stands at `nowMs`; this tab's own copy when storage is
 * blocked (a private window). A stored pause the read had to correct — an end further off than an
 * hour, or a run of refusals long over (`settleUploadPause`) — is written back corrected: the cap is
 * measured from now, so without the write-back it would move forward with every read and never end.
 */
function readUploadPause(nowMs: number): UploadPauseState {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(UPLOAD_PAUSE_STORAGE_KEY);
  } catch {
    tabPause = settleUploadPause(tabPause, nowMs);
    return tabPause;
  }
  const state = parseUploadPause(raw, nowMs);
  if (raw !== serialiseUploadPause(state)) writeUploadPause(state);
  return state;
}

function writeUploadPause(state: UploadPauseState): void {
  tabPause = state;
  try {
    const text = serialiseUploadPause(state);
    if (text === null) window.localStorage.removeItem(UPLOAD_PAUSE_STORAGE_KEY);
    else window.localStorage.setItem(UPLOAD_PAUSE_STORAGE_KEY, text);
  } catch {
    // Storage blocked: the pause still holds in this tab.
  }
}

/** Is the outage pause running for this browser? */
export function screenUploadsPaused(nowMs: number): boolean {
  return uploadPaused(readUploadPause(nowMs), nowMs);
}

/**
 * Sends one picture, then moves the outage pause by the answer: stored ends it, the server unable to
 * store starts or lengthens it, anything else leaves it. Never throws.
 */
export async function uploadScreen(send: typeof fetch, body: string): Promise<void> {
  let answer: { status: number | null; retryAfter: string | null };
  try {
    const response = await send(SCREEN_CAPTURE_ENDPOINT, {
      body,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    answer = { status: response.status, retryAfter: response.headers.get("retry-after") };
  } catch {
    // No answer at all. The browser said it was online a moment ago, so the server is unreachable.
    answer = { status: null, retryAfter: null };
  }
  try {
    const now = Date.now();
    const current = readUploadPause(now);
    const next = nextUploadPause(current, answer, now);
    if (next !== current) writeUploadPause(next);
  } catch {
    // The pause is a saving, never a reason to surface an error.
  }
}

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
 * Only what is on screen is copied in full: a box wholly outside the viewport is copied EMPTY, so it
 * still holds its place, and what is inside it — the long table below the fold, the list above it,
 * the closed tabs, most of the cost — is left out (`createPictureFilter`, screen-capture-rules.ts,
 * which says why dropping the box itself photographed a scrolled page blank). A new filter for every
 * picture: each box is measured once, at the moment the picture is taken.
 * Shared with the crash picture in capture-screenshot.ts, which had neither guard until 23 Oct 2026.
 */
export function pictureFilter(): (node: Node) => boolean {
  return createPictureFilter<Node, Element>(
    (element) => ({ box: element.getBoundingClientRect(), display: getComputedStyle(element).display }),
    { width: window.innerWidth, height: window.innerHeight },
  );
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
    filter: pictureFilter(),
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

/**
 * This path's own one-at-a-time, from the start of a picture to the end of its upload — so a second
 * refusal is not drawn and sent while the first one's upload is still waiting to hear whether the
 * server can store it (the outage pause). Not the shared lock, which covers only the drawing: an
 * upload is neither a page copy nor a request the wrapper sees (it goes out through `realFetch`).
 */
let refusalInFlight = false;

async function captureAndSend(input: CaptureInput): Promise<void> {
  if (refusalInFlight || isCaptureLockHeld()) return;
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  // Before the throttle and before any drawing: a paused tab spends neither a slot nor the main thread.
  if (screenUploadsPaused(Date.now())) return;
  if (document.getElementsByTagName("*").length > SCREEN_MAX_ELEMENTS) return;

  const pagePath = pathWithoutQuery(window.location.pathname);
  const key = screenThrottleKey({ kind: input.kind, apiPath: input.apiPath, pagePath, status: input.status });
  const decision = decideScreenThrottle(throttle, key, Date.now());
  throttle = decision.state;
  if (!decision.allowed) return;

  refusalInFlight = true;
  try {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    // Under the lock both pictures share, for at most REFUSAL_DRAW_TIMEOUT_MS; a crash picture being
    // drawn now means this one is not (it is a picture of the same screen).
    const picture = await withCaptureLock(
      async () => {
        let drawn = await drawViewport(ratio, 0.6);
        // Too big to send: drawn once more, smaller. Never a third time.
        if (drawn && decodedBytes(drawn.dataUrl) > MAX_IMAGE_BYTES) drawn = await drawViewport(1, 0.4);
        return drawn;
      },
      { timeoutMs: REFUSAL_DRAW_TIMEOUT_MS },
    );
    if (!picture || decodedBytes(picture.dataUrl) > MAX_IMAGE_BYTES) return;

    const send = realFetch ?? window.fetch.bind(window);
    await uploadScreen(
      send,
      JSON.stringify({
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
    );
  } catch {
    // A picture that cannot be drawn or sent is simply not kept.
  } finally {
    refusalInFlight = false;
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
  if (isCaptureLockHeld()) return;
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

function onFailure(request: { path: string; method: string }, error: unknown, sight: SendSight): void {
  if (isCaptureLockHeld()) return;
  // The page cancelled its own request — nobody was refused anything.
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return;
  // Out of sight at any moment on the way: nobody met this failure (noAnswerHappenedInSight).
  if (!noAnswerHappenedInSight({ ...sight, epochNow: hiddenEpoch, hiddenNow: pageHidden() })) return;
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

    // Counts each time the page goes out of sight. Listening is best-effort: without it every
    // no-answer failure is photographed exactly as before.
    try {
      const markHidden = () => {
        hiddenEpoch += 1;
      };
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", () => {
          if (pageHidden()) markHidden();
        });
      }
      if (typeof window.addEventListener === "function") window.addEventListener("pagehide", markHidden);
    } catch {
      // Not listening — the capture still works.
    }

    const wrapped = function phoenixScreenCaptureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const result = original.call(window, input, init);
      try {
        // Judged by whether a picture was being drawn when the request was SENT: html-to-image's own
        // downloads of the page's images go out through here, and are never a block anyone met.
        if (!isCaptureLockHeld()) {
          const request = describeRequest(input, init);
          if (request) {
            const sight: SendSight = { sentHidden: pageHidden(), epochAtSend: hiddenEpoch };
            // A separate branch: the caller gets `result` untouched, and nothing here can reject it.
            result.then(
              (response) => onAnswer(request, response).catch(() => undefined),
              (error: unknown) => onFailure(request, error, sight),
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
