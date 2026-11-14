/**
 * The write fence for the Phoenix visual explorer. Everything a browsing context asks the network for
 * is decided here, and the decision is a pure function so it is tested without a browser
 * (tests/phoenix-inspect-fence.test.ts).
 *
 * Built on the run driver's two layers (.claude/skills/run-phoenix-workforce/driver.mjs) and made
 * stricter for an unattended explorer:
 *
 *   1. context.route sees every request the network stack is asked for (navigation, XHR, form post,
 *      worker). Allowed: GET or HEAD to the ONE target origin, or to a short list of font hosts.
 *      Refused: every other method, every Next.js Server Action (`Next-Action` header), every other
 *      origin, every production host whatever the method, and every never-touch path (exports,
 *      downloads, sign-out, cron, webhooks) even as a GET.
 *   2. Page-side stubs replace fetch (non-GET) and navigator.sendBeacon, because a beacon or a
 *      keepalive fetch from a closing page slipped past layer 1 (driver incident, 1 Nov 2026).
 *
 * A stopped write is answered as a success (204), so the page carries on as if it had saved: on a
 * fenced page "Saved" means nothing was saved.
 *
 * Sign-in is NOT done through a fenced context. explore.mjs posts the one sign-in request from a
 * separate, short-lived context's API client and hands the resulting session to the fenced context
 * in memory; the fenced context itself never sends a POST.
 *
 * What the fence cannot stop: writes a page's own SERVER render makes while answering a GET (a
 * "last seen" stamp, a page-view audit row). That is why the explorer runs on STAGING only, with
 * staging-only logins. 🔴 The test accounts' server-side dry run does NOT cover this: it marks
 * writes only, and GET, HEAD and OPTIONS are never marked (`src/lib/auth/test-dry-run-rules.ts`,
 * `READ_METHODS`), so a GET that writes writes for real even for a `TEST-` login. For GET, this
 * file is the only guard, and since 14 Nov 2026 its list is BUILT FROM SOURCE, not typed:
 * scripts/phoenix-inspect/side-effect-routes.ts scans app/** and the access registry and writes
 * generated/side-effect-routes.json — every API route whose GET writes, serves a file or spends a paid
 * quota, and every page whose server render writes. Those are refused here as a navigation, an RSC
 * fetch and a prefetch alike; if that file cannot be read the fence fails CLOSED and refuses every
 * /api GET. tests/phoenix-inspect-route-fence.test.ts fails when the file is stale against today's
 * source, and fails any registered module whose plan opens an address the fence refuses — the gate
 * before a sensitive module is enabled. The KPIs board opens none (no write in its pages or domain
 * files; staging's audit log held only the sign-ins of the first run).
 */

import { readFileSync } from "node:fs";

/** Hosts the explorer must never reach, by any method. */
export const PRODUCTION_HOSTS = Object.freeze(["phoenix-hr.satopharma.com"]);

/** The only origin the explorer may browse. */
export const STAGING_ORIGIN = "https://phoenix-people-workforce-staging.up.railway.app";

/** Third-party hosts allowed for GET only: fonts. Everything else off-origin is refused. */
export const THIRD_PARTY_GET_HOSTS = Object.freeze(["fonts.googleapis.com", "fonts.gstatic.com"]);

/**
 * Paths never requested, even as a GET, because a GET there has a side effect or leaves the page:
 * the KPIs XLSX export writes an audit row and spends rate-limit budget; any export or download
 * hands over a file of real data; sign-out ends the session; cron and webhooks act on the system.
 */
export const NEVER_TOUCH_PATHS = Object.freeze([
  /^\/api\/crm\/kpis-export(?:\/|$)/,
  /(?:^|\/)exports?(?:\/|$|\?|-)/i,
  /(?:^|\/)download(?:s)?(?:\/|$)/i,
  /(?:^|\/)(?:logout|sign-?out)(?:\/|$)/i,
  /^\/api\/cron(?:\/|$)/,
  /(?:^|\/)webhooks?(?:\/|$)/i,
  /(?:^|\/)unsubscribe(?:\/|$)/i,
]);

/**
 * Under /api/ only (never a page or a static asset): the shapes of routes that hand over a file or act
 * when read, from the universal-inspection roadmap's B3 (docs/phoenix-intelligence/
 * PHOENIX_UNIVERSAL_INSPECTION_ROADMAP.md §5). A belt to the source-built list below, so a route added
 * after the list was generated is still refused when its name says what it does.
 */
export const NEVER_TOUCH_API_SHAPES = Object.freeze([
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
export function routePatternToRegex(pattern) {
  let source = "";
  for (const segment of String(pattern).split("/").slice(1)) {
    if (segment === "**") source += "(?:/.*)?";
    else if (segment === "*" || segment.startsWith(":")) source += "/[^/]+";
    else source += `/${segment.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&")}`;
  }
  return new RegExp(`^${source || "/"}/?$`);
}

/**
 * Built from source (scripts/phoenix-inspect/side-effect-routes.ts → generated/side-effect-routes.json):
 * every API route whose GET writes, serves a file or spends a quota, and every page whose server render
 * writes. A missing or unreadable file fails CLOSED: the fence then refuses every /api/ GET.
 */
function loadSideEffectRoutes() {
  try {
    const list = JSON.parse(readFileSync(new URL("../generated/side-effect-routes.json", import.meta.url), "utf8"));
    return {
      ok: true,
      api: Object.freeze(list.apiRoutes.map((route) => routePatternToRegex(route.pattern))),
      pages: Object.freeze(list.renderWriterPages.map((route) => routePatternToRegex(route.pattern))),
    };
  } catch {
    return { ok: false, api: Object.freeze([]), pages: Object.freeze([]) };
  }
}
export const SIDE_EFFECT_ROUTES = Object.freeze(loadSideEffectRoutes());

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Decide one request.
 * @param {{ method: string, url: string, headers?: Record<string, string> }} request
 * @param {{ origin: string, thirdPartyGetHosts?: readonly string[] }} policy
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function classifyRequest(request, policy) {
  let target;
  let origin;
  try {
    target = new URL(request.url);
    origin = new URL(policy.origin);
  } catch {
    return { allow: false, reason: "unparseable-url" };
  }
  if (target.protocol === "data:" || target.protocol === "blob:") return { allow: true };
  if (PRODUCTION_HOSTS.includes(target.hostname)) return { allow: false, reason: "production-host" };
  if (PRODUCTION_HOSTS.includes(origin.hostname)) return { allow: false, reason: "policy-targets-production" };

  const method = String(request.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (headers["next-action"] !== undefined) return { allow: false, reason: "server-action" };
  if (!READ_METHODS.has(method)) return { allow: false, reason: "write-method" };

  if (target.origin !== origin.origin) {
    const hosts = policy.thirdPartyGetHosts ?? THIRD_PARTY_GET_HOSTS;
    return hosts.includes(target.hostname) && target.protocol === "https:"
      ? { allow: true }
      : { allow: false, reason: "off-origin" };
  }
  if (NEVER_TOUCH_PATHS.some((pattern) => pattern.test(target.pathname))) {
    return { allow: false, reason: "never-touch-path" };
  }
  // A page whose server render writes: refused as a navigation AND as the RSC fetch or prefetch of the
  // same path, because either one makes the server render it.
  if (SIDE_EFFECT_ROUTES.pages.some((pattern) => pattern.test(target.pathname))) {
    return { allow: false, reason: "render-writer-page" };
  }
  if (target.pathname === "/api" || target.pathname.startsWith("/api/")) {
    if (!SIDE_EFFECT_ROUTES.ok) return { allow: false, reason: "side-effect-list-unreadable" };
    if (SIDE_EFFECT_ROUTES.api.some((pattern) => pattern.test(target.pathname))) return { allow: false, reason: "side-effect-route" };
    if (NEVER_TOUCH_API_SHAPES.some((pattern) => pattern.test(target.pathname))) return { allow: false, reason: "never-touch-api-shape" };
  }
  return { allow: true };
}

/**
 * A URL as it may be written to a log: path with ids masked, query KEYS only, never values,
 * never another origin's path.
 */
export function sanitizeUrlForLog(url, policyOrigin) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return "(unparseable)";
  }
  if (target.protocol === "data:" || target.protocol === "blob:") return `${target.protocol}(inline)`;
  const keys = [...new Set(target.searchParams.keys())].sort();
  const query = keys.length > 0 ? `?${keys.map((key) => `${key}=…`).join("&")}` : "";
  if (target.origin !== new URL(policyOrigin).origin) return `${target.origin}/(off-origin path withheld)`;
  return `${maskPathIds(target.pathname)}${query}`;
}

/**
 * An error message as a manifest, a log or a tool reply may keep it: its first line only (Playwright's
 * call log below it quotes the element it waited for, href and text included), escape codes removed,
 * every address reduced by sanitizeUrlForLog, and every other run of three or more digits masked (a
 * timeout's own "30000ms" is kept). Found 14 Nov 2026: a timed-out drill-down click wrote the link it
 * waited on, a staging rep number with it, into the run's manifest.
 */
export function sanitizeErrorText(message, policyOrigin, max = 200) {
  const firstLine = String(message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0].trim();
  const relativeTo = (address) => {
    try {
      return sanitizeUrlForLog(new URL(address, policyOrigin).href, policyOrigin);
    } catch {
      return "(unparseable)";
    }
  };
  const addressesMasked = firstLine
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]*/gi, (address) => sanitizeUrlForLog(address, policyOrigin))
    .replace(/\b(?:data|blob):[^\s"'<>)]*/gi, (address) => `${address.split(":")[0]}:(inline)`)
    .replace(/(^|[\s"'(=])(\/[^\s"'<>)]*)/g, (whole, lead, address) => `${lead}${relativeTo(address)}`);
  return addressesMasked.replace(/(?<!\d)\d{3,}(?!\d)(?!ms\b)/g, (digits) => "0".repeat(digits.length)).slice(0, max);
}

/** Masks path segments that look like ids: digits, uuids, hr ids, long hex, and dynamic tokens. */
export function maskPathIds(pathname) {
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      if (/^\d+$/.test(segment)) return ":n";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":uuid";
      if (/^[A-Za-z]{1,6}-?\d{2,}$/.test(segment)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ":hex";
      if (/^[A-Za-z0-9_-]{24,}$/.test(segment)) return ":token";
      if (/%[0-9a-f]{2}/i.test(segment)) return ":text";
      return segment;
    })
    .join("/");
}

/** The page-side layer, installed with context.addInitScript(PAGE_STUBS, key). */
export function PAGE_STUBS(key) {
  const report = (how, method, url) => {
    try {
      const held = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      held.push([how, method, new URL(String(url), location.href).href]);
      sessionStorage.setItem(key, JSON.stringify(held));
    } catch {
      // A sandboxed frame has no storage: the write is still stopped, it just goes unlisted.
    }
  };
  const realFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? input?.headers ?? undefined);
    if ((method === "GET" || method === "HEAD") && !headers.has("next-action")) return realFetch.call(this, input, init);
    report("fetch", method, input?.url ?? input);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  Navigator.prototype.sendBeacon = function sendBeacon(url) {
    report("beacon", "POST", url);
    return true;
  };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__phxMethod = String(method).toUpperCase();
    this.__phxUrl = url;
    return realOpen.call(this, method, url, ...rest);
  };
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function send(body) {
    if (this.__phxMethod && this.__phxMethod !== "GET" && this.__phxMethod !== "HEAD") {
      report("xhr", this.__phxMethod, this.__phxUrl);
      return undefined;
    }
    return realSend.call(this, body);
  };
  // A form that posts is stopped before it becomes a navigation: a refused navigation is the one
  // write the network layer can only cancel, never answer (see installFence).
  const methodOf = (form, submitter) =>
    String(submitter?.getAttribute?.("formmethod") || form.getAttribute("method") || "GET").toUpperCase();
  const actionOf = (form, submitter) => submitter?.getAttribute?.("formaction") || form.action || location.href;
  const realSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function submit() {
    const method = methodOf(this, null);
    if (method === "GET") return realSubmit.call(this);
    report("form", method, actionOf(this, null));
    return undefined;
  };
  window.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const method = methodOf(form, event.submitter);
      if (method === "GET") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      report("form", method, actionOf(form, event.submitter));
    },
    true,
  );
}

export const STOPPED_KEY = "__phxInspectWritesStopped";

/**
 * Install both layers on a Playwright BrowserContext. Every refusal is appended to `log` as
 * { layer, reason, method, url } with the URL already sanitized.
 */
export async function installFence(context, policy, log) {
  await context.addInitScript(PAGE_STUBS, STOPPED_KEY);
  await context.route("**/*", (route) => {
    const request = route.request();
    const verdict = classifyRequest(
      { method: request.method(), url: request.url(), headers: request.headers() },
      policy,
    );
    if (verdict.allow) return route.continue();
    log.push({
      layer: "network",
      reason: verdict.reason,
      method: request.method(),
      url: sanitizeUrlForLog(request.url(), policy.origin),
    });
    // A refused navigation is CANCELLED the way Chrome cancels a stopped load ("aborted"): the tab stays
    // on its page with its list of stopped writes. Not "blockedbyclient" (that commits Chrome's error
    // page over the page), and not a 204 (the page stays, but Playwright waits for that navigation to
    // finish for ever: self-check, 14 Nov 2026, every capture after a form post timed out).
    if (request.isNavigationRequest()) return route.abort("aborted");
    return route.abort("blockedbyclient");
  });
}

/** Read the page-side list of stopped writes from every frame of a page, into `log`. */
export async function collectPageStoppedWrites(page, policy, log) {
  for (const frame of page.frames()) {
    const read = frame
      .evaluate((key) => {
        const held = sessionStorage.getItem(key);
        sessionStorage.removeItem(key);
        return held;
      }, STOPPED_KEY)
      .catch(() => null);
    const held = await Promise.race([read, new Promise((done) => setTimeout(done, 5_000, null))]);
    for (const [how, method, url] of JSON.parse(held ?? "[]")) {
      log.push({ layer: `page-${how}`, reason: "write-method", method, url: sanitizeUrlForLog(url, policy.origin) });
    }
  }
}
