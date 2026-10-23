import { createHash } from "node:crypto";

import { isCrossOriginMaskedMessage } from "@/lib/error-monitor/cross-origin-masked";
import { extractTopComponent } from "@/lib/error-monitor/message-decode";
import { describeThirdPartyStack } from "@/lib/error-monitor/third-party-stack";
import { isUuid } from "@/lib/http/uuid";
import { hrNamespaceRemainder, isHrRewritablePath } from "@/lib/navigation/shell-headers";
import { isStaleDeployChunkError } from "@/lib/utils/stale-deploy-recovery";

/**
 * One `app_error_events` row turned into WHAT went wrong — the key every retry, every browser and
 * every page load of the same failure shares, and nothing else.
 *
 * The old Error Monitor grouped by `module_key|route`, so one bug read as forty issues (one per
 * page it surfaced on) while forty different bugs on one page read as one. The parts here are the
 * failure itself: the message with everything that varies per person stripped out, plus where in
 * OUR code it happened. Measured on production 2026-10-23, the browser engines disagree on the
 * wording of the commonest failure — Chrome `Cannot read properties of undefined (reading 'x')`,
 * Safari `undefined is not an object (evaluating 'a.x')`, Firefox `can't access property "x", a is
 * undefined` — and each would otherwise have been its own issue.
 *
 * What NEVER enters the key: a chunk hash (it changes on every deploy, so one bug would become a
 * new issue each release), a line or column (same), an HR id, a number, a UUID, an email or a
 * quoted value (they name the person or the record, not the failure).
 *
 * VERSIONED. A change to any rule below changes keys, which splits every existing issue in the
 * ledger from its own history — so a change bumps SIGNATURE_VERSION, and the key carries it.
 */

export const SIGNATURE_VERSION = 1;

/** The `app_error_events` columns the audit reads. Snake case, so a DB row and a snapshot CSV row both fit. */
export type AppErrorEventRow = {
  id: string;
  created_at: string;
  source: string;
  hr_id: string | null;
  login_id?: string | null;
  role?: string | null;
  module_key?: string | null;
  module_label?: string | null;
  route: string | null;
  route_type?: string | null;
  message: string | null;
  stack: string | null;
  digest?: string | null;
  release?: string | null;
  environment: string | null;
  user_agent?: string | null;
};

export type AppErrorSignatureParts = {
  source: "server" | "client";
  /** The engine-neutral message template: `react:418`, `null-access:x`, or the masked text. */
  message: string;
  /**
   * Where in our code: `component:<Name>`, `frame:<chunk path>`, `third-party:<host>`, `job:<name>`,
   * or `route:<family>` when nothing better exists. Null when the row says nothing about it.
   */
  where: string | null;
  /** Always computed for the fold, but hashed only when it IS the `where`. */
  routeFamily: string | null;
};

export type AppErrorSignature = { key: string; parts: AppErrorSignatureParts };

// ─── The client context block report-client-error.ts prepends to `stack` ──────────────────────────

const CLIENT_CONTEXT_SEPARATOR = "— Client context —";
const COMPONENT_STACK_SEPARATOR = "— Component stack —";

export type ClientContext = {
  sinceNavMs: number | null;
  seq: number | null;
  readyState: string | null;
  navType: string | null;
  domRewriter: string | null;
};

/**
 * The `key=value` line logAppError stores at the head of a client row's stack. `sinceNavMs` is
 * `performance.now()` at the throw, which is what tells one page load from the next.
 */
export function parseClientContext(stack: string | null | undefined): ClientContext {
  const empty: ClientContext = { sinceNavMs: null, seq: null, readyState: null, navType: null, domRewriter: null };
  if (!stack || !stack.startsWith(CLIENT_CONTEXT_SEPARATOR)) return empty;
  const line = stack.slice(CLIENT_CONTEXT_SEPARATOR.length).replace(/^\s+/, "").split("\n")[0] ?? "";
  const read = (name: string): string | null => {
    const match = line.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`));
    return match ? match[1] : null;
  };
  const number = (name: string): number | null => {
    const value = Number(read(name));
    return read(name) !== null && Number.isFinite(value) ? value : null;
  };
  return {
    sinceNavMs: number("sinceNavMs"),
    seq: number("seq"),
    readyState: read("readyState"),
    navType: read("navType"),
    domRewriter: read("domRewriter"),
  };
}

/** The JavaScript stack alone — without the client context in front or the component stack behind. */
function jsStackOf(stack: string | null | undefined): string {
  if (!stack) return "";
  let body = stack;
  if (body.startsWith(CLIENT_CONTEXT_SEPARATOR)) {
    const blank = body.indexOf("\n\n");
    body = blank < 0 ? "" : body.slice(blank + 2);
  }
  const component = body.indexOf(COMPONENT_STACK_SEPARATOR);
  return component < 0 ? body : body.slice(0, component);
}

// ─── The message template ─────────────────────────────────────────────────────────────────────────

const NETWORK_FAILURE_MESSAGES = new Set([
  "load failed",
  "failed to fetch",
  "error in input stream",
  "network error",
  "networkerror when attempting to fetch resource.",
]);

/** `this.rh.get(b).filter` → `filter`; `C0[c].indexOf` → `indexOf`; `a["x"]` → `x`. */
function lastPropertyOf(expression: string): string {
  const trimmed = expression.trim();
  const dotted = trimmed.match(/\.([A-Za-z_$][\w$]*)\s*$/);
  if (dotted) return dotted[1];
  const bracketed = trimmed.match(/\[\s*(['"]?)([^\]'"]*)\1\s*\]\s*$/);
  if (bracketed) return /^\d+$/.test(bracketed[2]) ? "<n>" : bracketed[2] || "<expr>";
  return /^[A-Za-z_$][\w$]*$/.test(trimmed) ? trimmed : "<expr>";
}

/**
 * A stored message is sometimes a whole serialised error object — a PostgrestError read on the
 * server, `{"message":"…","details":"…stack…"}` — truncated at 4,000 characters, so it will not
 * always parse. Its own `message` field is the failure; the details are a stack.
 */
function unwrapJsonMessage(message: string): string {
  if (!message.startsWith("{")) return message;
  try {
    const parsed = JSON.parse(message) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  } catch {
    // Truncated — read the leading field by hand below.
  }
  const leading = message.match(/^\{\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!leading) return message;
  try {
    return JSON.parse(`"${leading[1]}"`) as string;
  } catch {
    return leading[1];
  }
}

/**
 * Masks what varies per person or record. Order matters: a UUID is masked before digits would
 * shred it, an email before its domain's digits, a quoted value before anything inside it.
 */
function maskVariableText(text: string): string {
  return text
    .replace(/\bhttps?:\/\/[^\s'"<>)]+/gi, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`\n]*`/g, "<str>")
    .replace(/\b[A-Za-z]{1,4}-\d+\b/g, "<hr>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The engine-neutral template of a message: the same failure reads the same in every browser and
 * for every person.
 */
export function messageTemplate(rawMessage: string | null | undefined): string {
  const unwrapped = unwrapJsonMessage(String(rawMessage ?? "").trim());
  // The first line is the failure; anything after it is a stack or a detail dump.
  const firstLine = (unwrapped.split(/\r?\n|\\n/)[0] ?? "").trim();
  const message = firstLine.replace(/^(?:Uncaught\s+)?(?:TypeError|ReferenceError|RangeError|SyntaxError|Error):\s*/, "");
  if (!message) return "empty-message";

  // React's server-render fallback names its cause AFTER the first line ("…errored:\n\nMinified
  // React error #419…"), so the cause is read from the whole message, then templated like any other.
  if (/^Switched to client rendering because the server rendering errored/i.test(message)) {
    const whole = unwrapped.match(/react\.dev\/errors\/(\d+)/) ?? unwrapped.match(/Minified React error #(\d+)/);
    if (whole) return `react-switched:${whole[1]}`;
    const cause = unwrapped.replace(/^[\s\S]*?Switched to client rendering because the server rendering errored:?/i, "").trim();
    const inner = cause ? messageTemplate(cause) : "empty-message";
    return `react-switched:${inner === "empty-message" ? "unknown-cause" : inner}`;
  }

  // React production errors carry the code and the %s arguments in the URL. The arguments name
  // the element that mismatched, which differs per page and per person; the code is the failure.
  const react = message.match(/react\.dev\/errors\/(\d+)/) ?? message.match(/Minified React error #(\d+)/);
  if (react) return `react:${react[1]}`;
  if (isCrossOriginMaskedMessage(message)) return "masked-script-error";
  if (NETWORK_FAILURE_MESSAGES.has(message.toLowerCase())) return "network:fetch-failed";
  if (isStaleDeployChunkError(new Error(message))) return "stale-chunk";

  // Reading a property of null/undefined — the three engines' spellings, old and new V8.
  const chromeRead = message.match(/^Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([^']*)'\)/i);
  if (chromeRead) return `null-access:${chromeRead[1] || "<expr>"}`;
  const oldChromeRead = message.match(/^Cannot read property '([^']*)' of (?:undefined|null)/i);
  if (oldChromeRead) return `null-access:${oldChromeRead[1] || "<expr>"}`;
  const safariRead = message.match(/^(?:undefined|null) is not an object \(evaluating '([^']*)'\)/i);
  if (safariRead) return `null-access:${lastPropertyOf(safariRead[1])}`;
  const firefoxRead = message.match(/^can't access property "([^"]*)"/i);
  if (firefoxRead) return `null-access:${firefoxRead[1] || "<expr>"}`;
  const chromeSet = message.match(/^Cannot set propert(?:y|ies) of (?:undefined|null) \(setting '([^']*)'\)/i);
  if (chromeSet) return `null-set:${chromeSet[1] || "<expr>"}`;

  // Calling something that is not a function. Minified local names change between builds, so only
  // the last property of the expression is kept — `e.items.map` and `t.items.map` are one failure.
  const notFunction = message.match(/^(.+?) is not a function\b/);
  if (notFunction) return `not-a-function:${lastPropertyOf(notFunction[1].replace(/^\(?intermediate value\)?/, "<expr>"))}`;
  const notDefined = message.match(/^([A-Za-z_$][\w$]*) is not defined$/);
  if (notDefined) return `not-defined:${notDefined[1]}`;

  return maskVariableText(message).slice(0, 200) || "empty-message";
}

// ─── Where: the component, the server frame, the third-party host, the route ──────────────────────

const SERVER_FRAME_PATTERN = /(?:\(|\bat\s+(?:async\s+)?)((?:\/|[A-Za-z]:\\|webpack-internal:|file:)[^\s()]+?):\d+:\d+\)?/g;

/**
 * `/app/.next/server/chunks/ssr/src_lib_auth_1t8c37a1e2azj._.js` → `ssr/src_lib_auth`.
 *
 * Turbopack names a server chunk after the module it starts at, then appends a build hash as the
 * last `_` segment. The hash goes; the path stays. A chunk named by hash alone
 * (`_0f7t6cvfg1ymw._.js`) names nothing and is skipped, as is anything in node_modules or Node.
 */
export function normaliseServerFrame(rawPath: string): string | null {
  const path = rawPath.replace(/\\/g, "/");
  if (/node_modules|^node:|^internal\//.test(path)) return null;
  let tail: string;
  const nextIndex = path.indexOf("/.next/server/");
  const srcIndex = path.indexOf("/src/");
  if (nextIndex >= 0) {
    tail = path.slice(nextIndex + "/.next/server/".length);
  } else if (srcIndex >= 0) {
    tail = path.slice(srcIndex + 1);
  } else if (path.startsWith("webpack-internal:")) {
    tail = path.replace(/^webpack-internal:\/*(?:\([^)]*\)\/)?\.?\/?/, "");
  } else {
    return null;
  }
  const cleaned = tail
    .replace(/^chunks\//, "")
    // Turbopack's `<module path>_<hash>._.js` — the last `_` segment before `._.js` is the hash.
    .replace(/_[^_/]*\._\.js$/, "")
    .replace(/\._\.js$/, "")
    .replace(/\.(?:js|mjs|cjs)$/, "")
    // Webpack's numbered chunks and any long hash-like segment.
    .replace(/(^|\/)\d+(?=\/|$)/g, "$1<n>")
    .replace(/(^|[/_.-])[0-9a-z]{10,}(?=$|[/_.-])/g, (match, lead: string) => (/\d/.test(match) && /[a-z]/.test(match) ? `${lead}<h>` : match));
  const informative = cleaned
    .split("/")
    .filter((segment) => segment && segment !== "ssr" && segment !== "<n>" && segment !== "<h>" && !/^\[root-of-the-server\]/.test(segment));
  return informative.length > 0 ? cleaned : null;
}

/** The first frame of OUR server code in a server stack, normalised — or null. */
export function firstServerAppFrame(stack: string | null | undefined): string | null {
  const js = jsStackOf(stack);
  for (const match of js.matchAll(SERVER_FRAME_PATTERN)) {
    const frame = normaliseServerFrame(match[1]);
    if (frame) return frame;
  }
  return null;
}

/** Is this segment an identifier (an id, a token, a date, a composite key) rather than a page name? */
function isIdentifierSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep the raw form.
  }
  if (decoded.startsWith("[") && decoded.endsWith("]")) return false;
  if (/^\d+$/.test(decoded)) return true;
  if (isUuid(decoded)) return true;
  if (/^[a-z]{1,4}-\d+$/i.test(decoded)) return true;
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(decoded)) return true;
  if (decoded.includes(":") || decoded.includes("@")) return true;
  if (/\d/.test(decoded) && /^[A-Za-z0-9_-]{16,}$/.test(decoded)) return true;
  return decoded.length >= 24 && !decoded.includes("-");
}

/** The address with its query, hash and trailing slash removed. */
export function pathOnly(route: string | null | undefined): string | null {
  if (!route) return null;
  const path = route.split("#")[0].split("?")[0].trim();
  if (!path) return null;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Whether the route column holds an address, or a job/event name from a structured log. */
export function isAddress(route: string | null | undefined): boolean {
  return Boolean(route && route.trim().startsWith("/"));
}

/**
 * `/employee-portals/employee-360/a-12` → `/employee-portals/employee-360/[id]`.
 *
 * An `/hr/<x>` address is the proxy's spelling of `/<x>`, so both spellings land in one family —
 * stripped only where the proxy really rewrites (`isHrRewritablePath`), never `/hr/api/**`.
 */
export function routeFamily(route: string | null | undefined): string | null {
  const path = pathOnly(route);
  if (!path || !path.startsWith("/")) return null;
  const real = isHrRewritablePath(path) ? hrNamespaceRemainder(path) : path;
  const family = real
    .split("/")
    .map((segment) => (segment && isIdentifierSegment(segment) ? "[id]" : segment))
    .join("/");
  return family || "/";
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * The signature of one row. Version 1.
 *
 * `where`, in order: a third-party host when every located frame is someone else's script (a
 * Google Maps renderer failing is not the same issue as our own code failing with the same words);
 * the explicitly captured top React component (client); the first frame of our own server code
 * (server); the job name of a structured-log row; and only then the route family.
 */
export function appErrorSignatureV1(row: AppErrorEventRow): AppErrorSignature {
  const source: "server" | "client" = row.source === "server" ? "server" : "client";
  const message = messageTemplate(row.message);
  const family = isAddress(row.route) ? routeFamily(row.route) : null;
  const jobName = !isAddress(row.route) && row.route ? row.route.trim() : null;

  let where: string | null = null;
  const thirdParty = source === "client" ? describeThirdPartyStack(row.stack) : null;
  if (thirdParty) {
    where = `third-party:${thirdParty.label}`;
  } else if (source === "client") {
    const component = extractTopComponent(row.stack);
    if (component) where = `component:${component}`;
  } else {
    const frame = firstServerAppFrame(row.stack);
    if (frame) where = `frame:${frame}`;
  }
  if (!where && jobName) where = `job:${maskVariableText(jobName).slice(0, 120)}`;
  if (!where && family) where = `route:${family}`;

  const parts: AppErrorSignatureParts = { source, message, where, routeFamily: family };
  const hash = sha1Hex(JSON.stringify([SIGNATURE_VERSION, source, message, where])).slice(0, 16);
  return { key: `app:v${SIGNATURE_VERSION}:${hash}`, parts };
}

/** `APP-1A2B3C4D` — the short reference column 7 shows, from the signature's own hash. */
export function appErrorCode(signatureKey: string): string {
  const hash = signatureKey.split(":").pop() ?? "";
  return `APP-${hash.slice(0, 8).toUpperCase()}`;
}

/** A stable, non-reversible key for a guest's browser, so two guests' errors never merge. */
export function guestActorKey(userAgent: string | null | undefined): string {
  const agent = String(userAgent ?? "").trim();
  return agent ? `guest:${sha1Hex(agent).slice(0, 12)}` : "guest:unknown";
}
