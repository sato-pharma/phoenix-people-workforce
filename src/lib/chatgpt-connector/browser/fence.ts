/**
 * The read-only fence for the ChatGPT connector's screenshot and video tools.
 *
 * The capture browser opens LIVE Phoenix pages as the person who asked (the owner or the CEO), so
 * every request it makes is decided here first, and the decision is a pure function so it is tested
 * without a browser (tests/chatgpt-connector-capture.test.ts). It is the production cousin of the
 * staging inspector's fence (scripts/phoenix-inspect/lib/fence.mjs) and borrows its lists:
 *
 *   - GET and HEAD only, to every host. Every other method, and every Next.js Server Action (the
 *     `Next-Action` header), is stopped and answered 204, so a page carries on as if it had saved —
 *     on a captured page "Saved" means nothing was saved.
 *   - Never-touch paths, even as a GET: exports, downloads, sign-out, cron, webhooks, unsubscribe.
 *   - Every API route whose GET writes, serves a file or spends a paid quota, and every page whose
 *     SERVER RENDER writes, from the list built from source by scripts/phoenix-inspect/side-effect-routes.ts
 *     (generated/side-effect-routes.json, traced into the image by next.config.ts). Refused as a
 *     navigation, an RSC fetch and a prefetch alike. 🔴 If that list cannot be read the fence fails
 *     CLOSED: no capture runs at all.
 *
 * What the fence cannot stop: a write a page's server render makes that the list does not know of.
 * That is why the list is built from source and refused pages are refused before the browser opens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Paths never requested, even as a GET (the inspector's list, verbatim). */
export const NEVER_TOUCH_PATHS: readonly RegExp[] = Object.freeze([
  /^\/api\/crm\/kpis-export(?:\/|$)/,
  /(?:^|\/)exports?(?:\/|$|\?|-)/i,
  /(?:^|\/)download(?:s)?(?:\/|$)/i,
  /(?:^|\/)(?:logout|sign-?out)(?:\/|$)/i,
  /^\/api\/cron(?:\/|$)/,
  /(?:^|\/)webhooks?(?:\/|$)/i,
  /(?:^|\/)unsubscribe(?:\/|$)/i,
]);

/** Under /api/ only: shapes of routes that hand over a file or act when read (the inspector's belt). */
export const NEVER_TOUCH_API_SHAPES: readonly RegExp[] = Object.freeze([
  /-(?:export|download)(?:\/|$)/i,
  /\/(?:pdf|print|pack|cv|file|files|attachments?|photos?|images?|certificate|template|templates)(?:\/|$)/i,
  /-(?:template|pdf|file|photo|attachment)(?:\/|$)/i,
  /(?:^|\/)bank-file(?:\/|$)/i,
  /\/(?:cib|fab)-download(?:\/|$)/i,
  /\/contact-numbers(?:\/|$)/i,
  /\/case-map-basemap(?:\/|$)/i,
  /^\/api\/share\//i,
  /^\/api\/public\//i,
]);

/** `/api/foo/:id/bar` or `/api/foo/**` (the access registry's pattern syntax) as an anchored path regex. */
export function routePatternToRegex(pattern: string): RegExp {
  let source = "";
  for (const segment of String(pattern).split("/").slice(1)) {
    if (segment === "**") source += "(?:/.*)?";
    else if (segment === "*" || segment.startsWith(":")) source += "/[^/]+";
    else source += `/${segment.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&")}`;
  }
  return new RegExp(`^${source || "/"}/?$`);
}

export type SideEffectRoutes = { ok: boolean; api: readonly RegExp[]; pages: readonly RegExp[] };

export const SIDE_EFFECT_ROUTES_FILE = join("scripts", "phoenix-inspect", "generated", "side-effect-routes.json");

/** Parses the source-built list. Anything unexpected is `ok: false`, which fails the fence closed. */
export function parseSideEffectRoutes(text: string): SideEffectRoutes {
  try {
    const list = JSON.parse(text) as { apiRoutes?: Array<{ pattern?: unknown }>; renderWriterPages?: Array<{ pattern?: unknown }> };
    if (!Array.isArray(list.apiRoutes) || !Array.isArray(list.renderWriterPages) || list.apiRoutes.length === 0) {
      return { ok: false, api: [], pages: [] };
    }
    const toRegex = (rows: Array<{ pattern?: unknown }>) =>
      rows.filter((row) => typeof row?.pattern === "string").map((row) => routePatternToRegex(row.pattern as string));
    return { ok: true, api: Object.freeze(toRegex(list.apiRoutes)), pages: Object.freeze(toRegex(list.renderWriterPages)) };
  } catch {
    return { ok: false, api: [], pages: [] };
  }
}

let loaded: SideEffectRoutes | null = null;
export function loadSideEffectRoutes(cwd = process.cwd()): SideEffectRoutes {
  if (loaded) return loaded;
  let result: SideEffectRoutes;
  try {
    result = parseSideEffectRoutes(readFileSync(join(cwd, SIDE_EFFECT_ROUTES_FILE), "utf8"));
  } catch {
    result = { ok: false, api: [], pages: [] };
  }
  // Only a good read is remembered, so a transient read failure does not disable capture until restart.
  if (result.ok) loaded = result;
  return result;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

export type FenceDecision = { allow: true } | { allow: false; reason: string };

export type FencePolicy = {
  /** The loopback origin the capture browser signs in to. */
  origin: string;
  /** Other origins that ARE this app (the public production address), held to the same path rules. */
  sameAppOrigins?: readonly string[];
  routes: SideEffectRoutes;
};

function pathDecision(pathname: string, routes: SideEffectRoutes): FenceDecision {
  if (!routes.ok) return { allow: false, reason: "side-effect-list-unreadable" };
  if (NEVER_TOUCH_PATHS.some((pattern) => pattern.test(pathname))) return { allow: false, reason: "never-touch-path" };
  if (routes.pages.some((pattern) => pattern.test(pathname))) return { allow: false, reason: "render-writer-page" };
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (routes.api.some((pattern) => pattern.test(pathname))) return { allow: false, reason: "side-effect-route" };
    if (NEVER_TOUCH_API_SHAPES.some((pattern) => pattern.test(pathname))) return { allow: false, reason: "never-touch-api-shape" };
  }
  return { allow: true };
}

/** Decide one request the capture browser is about to send. */
export function classifyCaptureRequest(
  request: { method: string; url: string; headers?: Record<string, string> },
  policy: FencePolicy,
): FenceDecision {
  let target: URL;
  let origin: URL;
  try {
    target = new URL(request.url);
    origin = new URL(policy.origin);
  } catch {
    return { allow: false, reason: "unparseable-url" };
  }
  if (target.protocol === "data:" || target.protocol === "blob:") return { allow: true };

  const method = String(request.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  if (headers["next-action"] !== undefined) return { allow: false, reason: "server-action" };
  if (!READ_METHODS.has(method)) return { allow: false, reason: "write-method" };
  if (target.protocol !== "http:" && target.protocol !== "https:") return { allow: false, reason: "scheme" };

  const sameApp = target.origin === origin.origin || (policy.sameAppOrigins ?? []).includes(target.origin);
  if (sameApp) return pathDecision(target.pathname, policy.routes);
  // Another site: a GET for a font, a map tile or a picture the page draws. Never plain http off-box.
  return target.protocol === "https:" ? { allow: true } : { allow: false, reason: "insecure-off-origin" };
}

/**
 * The page path ChatGPT asked for, checked before any browser opens. Returns the clean path (with its
 * query) or a reason in words the person reads.
 */
export function checkCapturePath(raw: unknown, routes: SideEffectRoutes): { ok: true; path: string } | { ok: false; reason: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, reason: "Give the page's address inside Phoenix, starting with /, for example /admin/employees." };
  if (value.length > 400) return { ok: false, reason: "That page address is too long." };
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return { ok: false, reason: "Give a page address inside Phoenix that starts with a single /, not a full web address." };
  }
  let url: URL;
  try {
    url = new URL(value, "http://phoenix.invalid");
  } catch {
    return { ok: false, reason: "That page address could not be read." };
  }
  if (url.origin !== "http://phoenix.invalid") return { ok: false, reason: "Only pages inside Phoenix can be captured." };
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return { ok: false, reason: "That is a data address, not a page. Ask the other Phoenix tools for data." };
  }
  if (!routes.ok) return { ok: false, reason: "Phoenix's safety list for captures is missing, so no capture can run. Nothing was opened." };
  const decision = pathDecision(url.pathname, routes);
  if (!decision.allow) {
    return {
      ok: false,
      reason:
        decision.reason === "render-writer-page"
          ? "That page changes something in Phoenix just by being opened, so it is never captured."
          : "That address downloads a file, signs out or acts on Phoenix, so it is never opened by a capture.",
    };
  }
  return { ok: true, path: `${url.pathname}${url.search}` };
}
