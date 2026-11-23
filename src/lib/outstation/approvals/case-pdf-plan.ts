/**
 * The expense case PDF — every decision that needs no browser, so each is tested without one
 * (tests/expense-case-pdf.test.ts).
 *
 * Owner, 23 Nov 2026: "export every expense trip case as a PDF, looking 100% as it is looking in the
 * system". So the PDF is not a second drawing of the case: the server opens the REAL Expense Approvals
 * page on that one trip, as the person who pressed Export, and prints what the reviewer shows
 * (case-pdf.ts). Nothing here lays out a document; the house document look does not apply to this
 * export, on his word. What lives here:
 *
 *   1. Where the page is opened. On a deployed server, the app's own PUBLIC address: the map's key is
 *      tied to that address and Google refuses it anywhere else (measured 23 Nov 2026 on the loopback
 *      address: RefererNotAllowedMapError, and the map did not draw). On a laptop, the loopback
 *      address. Never taken from a request header: a forged Host would be handed the session.
 *   2. The fence. The print browser is signed in as a real person on the live database, so what it
 *      may ask for is an ALLOW-LIST, not a block-list: the one page, its scripts and static files, and
 *      the three reads an open case makes (measured on three cases, waiting and decided). Every other
 *      address of this app is answered with nothing. GET and HEAD only, no Server Action. The single
 *      non-GET that passes is the map's own viewport call to Google.
 *   3. The paper. One page, as wide as the desktop screen (1,440 px) and as tall as the whole case,
 *      so nothing is cut at a page break and nothing scrolls. A PDF page cannot be taller than 200
 *      inches; a taller case is scaled down to fit one page rather than split.
 *   4. When the case is drawn, and when it has stopped changing (photos decoded, maps in, no loader).
 */

import { systemDeployment } from "@/config/system-settings";

/** The desktop width the reviewer is printed at. A phone that asks gets the same desktop page. */
export const CASE_PDF_WIDTH = 1440;
/** The height the page opens at, before it is grown to the case. */
export const CASE_PDF_OPENING_HEIGHT = 900;
/** 200 inches at 96 px an inch is 19,200 px; kept a little under. */
export const CASE_PDF_MAX_PAGE_PX = 19_000;
const CASE_PDF_MIN_SCALE = 0.1;
/** Past this the viewport is not grown further; at the smallest scale it is ten pages of 19,000 px. */
const CASE_PDF_MAX_VIEWPORT_PX = Math.floor(CASE_PDF_MAX_PAGE_PX / CASE_PDF_MIN_SCALE);

export const CASE_PDF_PAGE = "/admin/outstation/expense-approvals";
const SIGN_IN_PAGE = "/login";

/** What the sessions list and the revoke reason say this short session was. */
export const CASE_PDF_SESSION_MARK = Object.freeze({
  revokeReason: "expense_case_pdf_export",
  userAgent: "Phoenix expense case PDF export",
});

/**
 * The one non-GET the print browser sends: the map asking Google what is in its viewport. It carries
 * the map's bounds and nothing of Phoenix's, and it goes to Google only.
 */
export const CASE_PDF_PASS_WRITES: readonly string[] = Object.freeze([
  "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/",
]);

export function casePdfPagePath(requestId: number): string {
  return `${CASE_PDF_PAGE}?trip=${requestId}`;
}

/** The three reads an open case makes, and nothing else under /api. */
export function casePdfReads(requestId: number): readonly string[] {
  return ["/api/admin/outstation/approvals", `/api/admin/outstation/approvals/${requestId}`, "/api/outstation/visit-workload"];
}

/** The hosts Phoenix is served from: production's and staging's. No other host is ever handed the print session. */
const CASE_PDF_PUBLIC_HOSTS: ReadonlySet<string> = new Set([new URL(systemDeployment.productionUrl).host, "phoenix-people-workforce-staging.up.railway.app"]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * An address the print session may be sent to, or null. The browser carries a real person's session
 * cookie to this address, so a setting alone is never enough (risk review, 23 Nov 2026): it must be
 * this box itself (loopback), or https on a host Phoenix is served from. A mistyped or hostile
 * `APP_URL` is ignored, and plain http never leaves the box.
 */
function trustedOriginOf(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
    return url.protocol === "https:" && CASE_PDF_PUBLIC_HOSTS.has(url.host) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Where the print browser opens the case. `PHOENIX_CASE_PDF_ORIGIN` wins when it names a trusted
 * address. A deployed server (NODE_ENV production) uses its own public address, APP_URL, when that is
 * a trusted one. With none: production opens its known domain, and any other deployment (staging)
 * stays on its own loopback port, so it never opens production. Anything else is a laptop, which uses
 * its own loopback port: a laptop's env file may name the production address, and its session would
 * mean nothing there.
 */
export function casePdfOrigin(env: Record<string, string | undefined> = process.env): string {
  const ownBox = `http://127.0.0.1:${(env.PORT ?? "").trim() || "3000"}`;
  const chosen = trustedOriginOf(env.PHOENIX_CASE_PDF_ORIGIN);
  if (chosen) return chosen;
  if (env.NODE_ENV !== "production") return ownBox;
  const named = trustedOriginOf(env.APP_URL) ?? trustedOriginOf(env.PHOENIX_APP_URL);
  if (named) return named;
  // The same reading as isProductionRuntime (src/config/system-settings.ts): staging sets APP_ENV.
  const runtime = String(env.APP_ENV || env.VERCEL_ENV || env.NODE_ENV || "").trim().toLowerCase();
  return runtime === "production" ? new URL(systemDeployment.productionUrl).origin : ownBox;
}

/**
 * One case is printed at a time in a server process. The PDF printer has two Chromium slots for the
 * whole app, and a case can hold one for over a minute; two at once would leave an offer letter or a
 * payslip waiting until it failed (risk review, 23 Nov 2026). The second export is told to try again.
 */
export function createCasePdfTurn(): { take: () => boolean; release: () => void } {
  let taken = false;
  return {
    release: () => {
      taken = false;
    },
    take: () => {
      if (taken) return false;
      taken = true;
      return true;
    },
  };
}

// ── The fence ────────────────────────────────────────────────────────────────────────────────────

export type CasePdfFenceDecision = { allow: true } | { allow: false; reason: string };
export type CasePdfFencePolicy = { origin: string; requestId: number };

const READ_METHODS = new Set(["GET", "HEAD"]);
const STATIC_FILE = /\.(?:js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|ico|webmanifest)$/i;
const refuse = (reason: string): CasePdfFenceDecision => ({ allow: false, reason });
const ALLOW: CasePdfFenceDecision = { allow: true };

/** Decide one request the print browser is about to send. */
export function classifyCasePdfRequest(
  request: { method: string; url: string; headers?: Record<string, string> },
  policy: CasePdfFencePolicy,
): CasePdfFenceDecision {
  let target: URL;
  let own: URL;
  try {
    target = new URL(request.url);
    own = new URL(policy.origin);
  } catch {
    return refuse("unparseable-url");
  }
  if (target.protocol === "data:" || target.protocol === "blob:") return ALLOW;

  const method = String(request.method ?? "GET").toUpperCase();
  const headerNames = Object.keys(request.headers ?? {}).map((name) => name.toLowerCase());
  if (headerNames.includes("next-action")) return refuse("server-action");
  if (!READ_METHODS.has(method)) {
    // `href` is the parsed address, so a path that climbs out with dot segments is already resolved.
    return method === "POST" && CASE_PDF_PASS_WRITES.some((prefix) => target.href.startsWith(prefix)) ? ALLOW : refuse("write-method");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return refuse("scheme");

  if (target.origin !== own.origin) {
    // Another site: a photo from storage, a map tile, a font. Never plain http off the box.
    return target.protocol === "https:" ? ALLOW : refuse("insecure-off-origin");
  }

  const path = target.pathname.length > 1 ? target.pathname.replace(/\/$/, "") : target.pathname;
  if (path === "/api" || path.startsWith("/api/")) {
    return casePdfReads(policy.requestId).includes(path) ? ALLOW : refuse("outside-the-case");
  }
  // The sign-in page is let through so a refused session is SEEN (and reported) instead of waited out.
  if (path === CASE_PDF_PAGE || path === SIGN_IN_PAGE) return ALLOW;
  if (path.startsWith("/_next/") || STATIC_FILE.test(path)) return ALLOW;
  return refuse("another-page");
}

// ── What the page says about itself ──────────────────────────────────────────────────────────────

export type CasePdfReading =
  | { stage: "absent" | "loading"; path: string }
  | { stage: "failed"; path: string; message: string }
  | {
      stage: "ready";
      path: string;
      /** Everything in the reviewer that does not scroll: its bar, the decision foot. */
      chrome: number;
      /** The whole height of what scrolls. */
      content: number;
      images: number;
      pendingImages: number;
      busy: number;
      maps: number;
    };

/**
 * Read in the page: is this trip drawn, and how tall is it? The reviewer marks its scroller with the
 * trip's number once the trip is read (`data-trip-file`), and with "loading" before — a loader while
 * it reads, the failure in words when the read did not land.
 */
export function casePdfReadingScript(requestId: number): string {
  return `(() => {
  const path = location.pathname;
  const box = document.querySelector("[data-desk-reviewer]");
  if (!box) return { stage: "absent", path };
  const file = box.querySelector("[data-trip-file]");
  const mark = file ? file.getAttribute("data-trip-file") : null;
  if (mark !== ${JSON.stringify(String(requestId))}) {
    // Only the loading box without its loader is a failure, and its text is the failure's own words.
    // Anything else (nothing yet, the loader, another trip mid-change) is still on its way.
    if (mark !== "loading" || file.querySelector('[aria-busy="true"]')) return { stage: "loading", path };
    return { stage: "failed", path, message: (file.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240) };
  }
  let chrome = 0;
  for (const child of box.children) if (child !== file) chrome += child.offsetHeight;
  const images = [...box.querySelectorAll("img")];
  // The scroller's one child is the case itself. Its own height, not the scroller's: a scroller is
  // never shorter than the window, so a short case would print with the empty window under it.
  const inner = file.firstElementChild;
  return {
    stage: "ready",
    path,
    chrome,
    content: inner ? inner.offsetHeight : file.scrollHeight,
    images: images.length,
    pendingImages: images.filter((image) => !image.complete).length,
    busy: box.querySelectorAll('[aria-busy="true"]').length,
    maps: box.querySelectorAll(".gm-style").length,
  };
})()`;
}

const wholeNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** What came back from the page, trusted only as far as its shape: anything else reads as "absent". */
export function parseCasePdfReading(raw: unknown): CasePdfReading {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : "";
  if (value.stage === "loading") return { stage: "loading", path };
  if (value.stage === "failed") return { stage: "failed", path, message: typeof value.message === "string" ? value.message : "" };
  if (value.stage === "ready") {
    const chrome = wholeNumber(value.chrome);
    const content = wholeNumber(value.content);
    const images = wholeNumber(value.images);
    const pendingImages = wholeNumber(value.pendingImages);
    const busy = wholeNumber(value.busy);
    const maps = wholeNumber(value.maps);
    if (chrome !== null && content !== null && content > 0 && images !== null && pendingImages !== null && busy !== null && maps !== null) {
      return { stage: "ready", path, chrome, content, images, pendingImages, busy, maps };
    }
  }
  return { stage: "absent", path };
}

/** Nothing is still arriving, and two readings in a row agree. */
export function casePdfSettled(before: CasePdfReading, after: CasePdfReading): boolean {
  if (before.stage !== "ready" || after.stage !== "ready") return false;
  return (
    after.pendingImages === 0 &&
    after.busy === 0 &&
    after.chrome === before.chrome &&
    after.content === before.content &&
    after.images === before.images &&
    after.maps === before.maps
  );
}

/**
 * Everything on the page that is not the reviewer is taken out of the print: the list behind it holds
 * OTHER people's claims, and a PDF keeps text a screen only covers. Set through the element's own
 * style object, which a Content-Security-Policy does not refuse (a `<style>` tag it would).
 */
export const CASE_PDF_ISOLATE_SCRIPT = `(() => {
  let hidden = 0;
  for (const el of document.body.children) {
    if (el.hasAttribute("data-desk-reviewer") || el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    el.style.setProperty("display", "none", "important");
    hidden += 1;
  }
  return hidden;
})()`;

// ── The paper ────────────────────────────────────────────────────────────────────────────────────

export type CasePdfPageSize = {
  /** The browser window that shows the whole case with nothing left to scroll. */
  viewportHeight: number;
  /** The paper, in px at the printed scale. */
  paperWidth: number;
  paperHeight: number;
  scale: number;
};

/** One page holding the whole case; scaled down, never split, when the case is taller than a page can be. */
export function casePdfPageSize(reading: { chrome: number; content: number }): CasePdfPageSize {
  const whole = Math.min(CASE_PDF_MAX_VIEWPORT_PX, Math.max(1, Math.ceil(reading.chrome + reading.content)));
  if (whole <= CASE_PDF_MAX_PAGE_PX) return { viewportHeight: whole, paperWidth: CASE_PDF_WIDTH, paperHeight: whole, scale: 1 };
  // Rounded DOWN to a thousandth, so the scaled case is never a hair taller than its page.
  const scale = Math.max(CASE_PDF_MIN_SCALE, Math.floor((CASE_PDF_MAX_PAGE_PX / whole) * 1000) / 1000);
  return { viewportHeight: whole, paperWidth: Math.ceil(CASE_PDF_WIDTH * scale), paperHeight: Math.ceil(whole * scale), scale };
}

/** What `page.pdf()` is given: the screen's own styles and backgrounds, no margin, one page. */
export function casePdfPrintOptions(size: CasePdfPageSize): Record<string, unknown> {
  return {
    height: `${size.paperHeight}px`,
    margin: { bottom: "0", left: "0", right: "0", top: "0" },
    pageRanges: "1",
    printBackground: true,
    scale: size.scale,
    width: `${size.paperWidth}px`,
  };
}

// ── The note under the reviewer's bar ────────────────────────────────────────────────────────────

/** The header the route answers with: "yes" when every photo and map had arrived before the print, else "no". */
export const CASE_PDF_SETTLED_HEADER = "X-Phoenix-Case-Settled";

/** Said under the bar when the file was saved before every picture had arrived. */
export const CASE_PDF_LATE_NOTE =
  "The PDF was saved, but a photo or a map had not finished loading when it was printed. Open the file; if a picture is missing, export it again.";

/** Whether the server printed before the case had stopped changing. Only its own "no" says so. */
export function casePdfPrintedLate(settledHeader: string | null | undefined): boolean {
  return (settledHeader ?? "").trim().toLowerCase() === "no";
}

export type CaseExportTone = "bad" | "info" | "warn";

/** What the export said, and the claim it said it about. */
export type CaseExportNote = { message: string; requestId: number; tone: CaseExportTone };

/**
 * The note as the claim ON SCREEN reads it. One export runs at a time and the reviewer stays open
 * while he walks the lane, so a note can belong to a claim he has already left: it then says so,
 * and never calls another claim "this claim".
 */
export function caseExportNoteOnScreen(note: CaseExportNote | null, requestId: number): { message: string; tone: CaseExportTone } | null {
  if (!note) return null;
  if (note.requestId === requestId) return { message: note.message, tone: note.tone };
  if (note.tone === "bad") return { message: `The PDF of the claim you exported was not made. ${note.message}`, tone: "bad" };
  if (note.tone === "warn") return { message: `About the claim you exported before this one: ${note.message}`, tone: "warn" };
  return { message: "Still preparing the PDF of the claim you exported. This claim can be exported when it finishes.", tone: "info" };
}

/** The page's side: the name the server gave the file, or a plain one when the header is missing. */
export function casePdfFilenameFromHeader(contentDisposition: string | null | undefined, requestId: number): string {
  const named = /filename="([A-Za-z0-9._-]{1,180}\.pdf)"/.exec(contentDisposition ?? "");
  return named ? named[1] : `Expense-trip-${requestId}.pdf`;
}

const slug = (value: string) => value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** `Expense-trip-<name>-<first day>[-to-<last day>]-<number>.pdf` — plain ASCII, so every browser keeps it. */
export function casePdfFilename(input: { employeeName: string | null; requestId: number; tripEnd: string | null; tripStart: string | null }): string {
  const day = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
  const first = day(input.tripStart);
  const last = day(input.tripEnd);
  const dates = first && last && last !== first ? `${first}-to-${last}` : first;
  return ["Expense-trip", slug(input.employeeName ?? "") || "Employee", dates, String(input.requestId)].filter(Boolean).join("-") + ".pdf";
}
