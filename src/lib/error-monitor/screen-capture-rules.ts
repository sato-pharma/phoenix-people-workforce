/**
 * THE RULES OF THE ERROR SCREENSHOT — what a refusal or a failure a person met is, which requests are
 * never photographed, how a path is masked, and how often one tab may send a picture.
 *
 * Owner's decision, 23 Oct 2026: "every single type of error or block" a person meets leaves a
 * screenshot of exactly what they saw, shown as-is to the Super Admin only on the System Audit page,
 * kept 90 days. A BLOCK is the person trying to do something and being refused (a visit save refused,
 * a validation refused); an ERROR is a request that failed or an error screen that was shown. The
 * in-progress "checking…" state is neither — only the outcome is photographed.
 *
 * PURE AND SHARED. No DOM, no clock, no I/O: the browser half (screen-capture.ts), the intake route
 * (app/api/errors/screen) and the nightly detector (src/lib/system-audit/detectors/user-screens.ts)
 * all read these, and tests/user-error-screens.test.ts pins every rule without a browser.
 */

import { isUuid } from "@/lib/http/uuid";

export const SCREEN_KINDS = ["error_screen", "refused_request", "failed_request"] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

export function isScreenKind(value: unknown): value is ScreenKind {
  return typeof value === "string" && (SCREEN_KINDS as readonly string[]).includes(value);
}

/** The same (kind, masked api path, status) is photographed at most once in this window, per tab. */
export const SAME_SCREEN_GAP_MS = 2 * 60 * 1000;
/** And one tab sends at most this many pictures in any rolling hour. */
export const MAX_SCREENS_PER_TAB_PER_HOUR = 12;
const HOUR_MS = 60 * 60 * 1000;
/** How long after the refusal arrives the picture is taken, so the page has drawn it. */
export const CAPTURE_DELAY_MS = 900;
/** The words read off a refused response, as the browser keeps them. The server keeps up to 1,000. */
export const CLIENT_MESSAGE_CAP = 500;
/** A refusal body bigger than this is not read for its words (it is not a refusal sentence). */
export const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

/**
 * Requests that are NEVER photographed, whatever they answer. Each is either part of the capture
 * itself (a refusal of the capture would photograph itself), or a background poll the person did not
 * ask for and would not see fail — a refused badge count is not a block anyone met.
 *
 *   prefix — the path is this, or starts with this followed by `/`
 *   exact  — the path is exactly this
 *   suffix — the path ends with this (the sidebar badge counts all end the same way)
 */
export const SCREEN_CAPTURE_SKIP_LIST: ReadonlyArray<{ match: "prefix" | "exact" | "suffix"; path: string; why: string }> = [
  { match: "prefix", path: "/api/errors", why: "The error reporters themselves, this capture's own endpoint included" },
  { match: "prefix", path: "/api/auth", why: "Sign-in, sign-out and the idle-session heartbeat" },
  { match: "prefix", path: "/api/activity", why: "Page-view tracking, sent from every page" },
  { match: "exact", path: "/api/admin/activity/live", why: "Activity Control's live poll" },
  { match: "exact", path: "/api/notifications/in-app", why: "The notification bell's poll" },
  { match: "prefix", path: "/api/navigation", why: "Sidebar layout, read by every page" },
  { match: "prefix", path: "/api/employee-portals/navigation", why: "Portal sidebar layout, read by every page" },
  { match: "exact", path: "/api/approvals/badge-counts", why: "Sidebar badge counts, polled by every page" },
  { match: "suffix", path: "/pending-count", why: "Sidebar badge counts, polled by every page" },
  { match: "suffix", path: "/needs-action-count", why: "Sidebar badge counts, polled by every page" },
  { match: "suffix", path: "/unbooked-count", why: "Sidebar badge counts, polled by every page" },
  { match: "prefix", path: "/api/phoenix-crm/touch-trail", why: "Phoenix CRM's background touch-trail beacon" },
  { match: "prefix", path: "/api/health", why: "Health check" },
  { match: "prefix", path: "/api/healthz", why: "Health check" },
  { match: "prefix", path: "/api/readyz", why: "Health check" },
];

/** The path with its query, hash and trailing slash removed; null when it is not a path. */
export function pathWithoutQuery(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("/")) return null;
  const path = raw.split("#")[0].split("?")[0];
  if (!path) return null;
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** Whether a same-origin API path is on the skip list. */
export function isSkippedScreenPath(apiPath: string | null | undefined): boolean {
  const path = pathWithoutQuery(apiPath);
  if (!path) return true;
  for (const entry of SCREEN_CAPTURE_SKIP_LIST) {
    if (entry.match === "exact" && path === entry.path) return true;
    if (entry.match === "prefix" && (path === entry.path || path.startsWith(`${entry.path}/`))) return true;
    if (entry.match === "suffix" && path.endsWith(entry.path)) return true;
  }
  return false;
}


/**
 * Does this path segment name a RECORD (an id, an HR id, a date, a token) rather than a route? A
 * route word with a digit in it (`ireports360`) is not one; `B-10`, `123`, a UUID or `2026-10-23` is.
 */
export function isIdentifierPathSegment(segment: string): boolean {
  let value = segment;
  try {
    value = decodeURIComponent(segment);
  } catch {
    // A malformed escape is still a segment; judged as written.
  }
  if (!value) return false;
  if (isUuid(value)) return true;
  if (/^\d+$/.test(value)) return true;
  if (/^[A-Za-z]{0,4}-?\d+$/.test(value)) return true;
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return true;
  if (/[@:\s]/.test(value)) return true;
  return value.length >= 16 && /\d/.test(value) && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * `/api/phoenix-crm/visits/3f2…/validate?x=1` → `/api/phoenix-crm/visits/:id/validate`. The same
 * refusal on two records is one kind of screen; the path keeps the route and drops the record.
 */
export function maskApiPath(path: string | null | undefined): string | null {
  const clean = pathWithoutQuery(path);
  if (!clean) return null;
  return clean
    .split("/")
    .map((segment) => (segment && isIdentifierPathSegment(segment) ? ":id" : segment))
    .join("/");
}

/**
 * Which kind of screen an answer is, or null when it is not one. 5xx or no answer at all (the
 * network failed) is a FAILED request; any other 4xx is a REFUSED one — the person was blocked.
 *
 * A GET or HEAD answered 404 is not photographed: a read that finds nothing (an optional photo, a
 * record that does not exist yet) is how pages ask "is there one?", not a block anyone met.
 */
export function classifyScreenKind(input: { status: number | null; networkFailure: boolean; method?: string | null }): ScreenKind | null {
  if (input.networkFailure) return "failed_request";
  const status = input.status;
  if (typeof status !== "number" || !Number.isFinite(status)) return null;
  if (status >= 500 && status <= 599) return "failed_request";
  if (status >= 400 && status <= 499) {
    const method = String(input.method ?? "GET").toUpperCase();
    if (status === 404 && (method === "GET" || method === "HEAD")) return null;
    // A 401 means there is no signed-in session — a visitor on a public page, or a session that just
    // ended. The intake only files a picture under a signed-in person, so it would refuse this one with
    // the same 401 after the browser had already drawn and sent it (risk review, 23 Oct 2026).
    if (status === 401) return null;
    return "refused_request";
  }
  return null;
}

function stringField(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>).message;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

/**
 * The words a refused or failed response carried for the person — `message`, else `error`, else
 * `detail` of a JSON body (each may be a string or `{ message }`). A body that is not JSON carries no
 * words we can trust as what the page showed, so it yields null. Capped at `cap` characters.
 */
export function extractRefusalMessage(contentType: string | null | undefined, body: string | null | undefined, cap = CLIENT_MESSAGE_CAP): string | null {
  const text = String(body ?? "").trim();
  if (!text) return null;
  const type = String(contentType ?? "").toLowerCase();
  if (!type.includes("json") && !text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const words = stringField(record.message) ?? stringField(record.error) ?? stringField(record.detail);
  if (!words) return null;
  return words.length > cap ? words.slice(0, cap) : words;
}

/** The throttle's memory for one tab: when each key was last photographed, and every send this hour. */
export type ScreenThrottleState = {
  lastByKey: Readonly<Record<string, number>>;
  sentAt: readonly number[];
};

export const EMPTY_SCREEN_THROTTLE: ScreenThrottleState = { lastByKey: {}, sentAt: [] };

/** The throttle key: the kind, the masked path (or the page for an error screen) and the status. */
export function screenThrottleKey(input: { kind: ScreenKind; apiPath: string | null; pagePath?: string | null; status: number | null }): string {
  const where = input.apiPath ? maskApiPath(input.apiPath) : maskApiPath(input.pagePath ?? null);
  return `${input.kind}|${where ?? "-"}|${input.status ?? "-"}`;
}

/**
 * May this tab photograph `key` at `nowMs`? Returns the decision and the state to keep — the state
 * changes only when the answer is yes, so a refused attempt never pushes the window forward.
 */
export function decideScreenThrottle(state: ScreenThrottleState, key: string, nowMs: number): { allowed: boolean; state: ScreenThrottleState } {
  const recent = state.sentAt.filter((at) => nowMs - at < HOUR_MS);
  const last = state.lastByKey[key];
  if (typeof last === "number" && nowMs - last < SAME_SCREEN_GAP_MS) {
    return { allowed: false, state: { lastByKey: state.lastByKey, sentAt: recent } };
  }
  if (recent.length >= MAX_SCREENS_PER_TAB_PER_HOUR) {
    return { allowed: false, state: { lastByKey: state.lastByKey, sentAt: recent } };
  }
  const lastByKey: Record<string, number> = {};
  for (const [known, at] of Object.entries(state.lastByKey)) {
    if (nowMs - at < SAME_SCREEN_GAP_MS) lastByKey[known] = at;
  }
  lastByKey[key] = nowMs;
  return { allowed: true, state: { lastByKey, sentAt: [...recent, nowMs] } };
}

/**
 * Is `url` (as fetch was given it) a same-origin `/api/` request? Returns its path, or null. Never
 * throws: a URL that will not parse is simply not ours.
 */
export function sameOriginApiPath(url: string, origin: string): string | null {
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin) return null;
    if (parsed.pathname !== "/api" && !parsed.pathname.startsWith("/api/")) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

/**
 * WHAT THE PICTURE COPIES. html-to-image copies every computed style of every node it keeps, on the
 * main thread, so what lies off screen is not copied in full — but it must still TAKE ITS SPACE.
 *
 * Until 23 Oct 2026 an off-screen element was dropped whole. Its space went with it, so everything
 * after it moved up by its height, and THEN the picture moved the page up by the scroll position: a
 * person scrolled down a long list was photographed with the page shifted up twice, out of the
 * picture. Khaled Mohamed Ali Bedair's refusal on Phoenix CRM at 18:51 Cairo, the first real one, was
 * a white card with nothing on it but the sidebar and the top bar around it (System Audit,
 * 84aae968-c5ea-4a1a-afbd-b7abf25938d7).
 *
 * Now an off-screen BOX stays, EMPTY: the library writes its computed width and height onto the copy,
 * so it holds its place exactly, and only what is INSIDE it is left out — still most of the cost.
 * Only a box that keeps its own size is emptied. An inline element's size IS its text, and a table
 * part's widths are decided by its cells (a fixed table reads them off the first row), so emptying
 * either would move what is on screen; their contents are copied. A zero-size box is never off
 * screen: it may hold visible children positioned outside it.
 */
export type PictureBox = { top: number; right: number; bottom: number; left: number; width: number; height: number };
export type PictureViewport = { width: number; height: number };

const BOXES_THAT_KEEP_THEIR_SIZE = new Set(["block", "flex", "grid", "flow-root", "list-item", "inline-block", "inline-flex", "inline-grid"]);

/** Can this box stand in, empty, for everything inside it? Only when it cannot appear in the picture. */
export function emptiesInPicture(box: PictureBox, display: string, viewport: PictureViewport): boolean {
  if (box.width === 0 && box.height === 0) return false;
  const outside = box.bottom < 0 || box.right < 0 || box.top > viewport.height || box.left > viewport.width;
  return outside && BOXES_THAT_KEEP_THEIR_SIZE.has(display);
}

/**
 * The `filter` html-to-image calls on every node it is about to copy: a node is left out only when
 * the box it sits in is being kept empty. The off-screen box itself is always copied — that is what
 * holds the layout. Each box is measured once per picture.
 */
export function createPictureFilter<N extends { parentElement: E | null }, E extends object>(
  measure: (element: E) => { box: PictureBox; display: string },
  viewport: PictureViewport,
): (node: N) => boolean {
  const emptied = new WeakMap<E, boolean>();
  return (node) => {
    const parent = node.parentElement;
    if (!parent) return true;
    let empty = emptied.get(parent);
    if (empty === undefined) {
      const { box, display } = measure(parent);
      empty = emptiesInPicture(box, display, viewport);
      emptied.set(parent, empty);
    }
    return !empty;
  };
}
