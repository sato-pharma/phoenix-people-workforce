// The rules behind the new-error Telegram (owner, 17 Nov 2026: Phoenix's own error log sends the instant
// Telegram for a new error, so nothing is lost when the outside error tracker is retired). Pure on purpose:
// tests call these directly, and new-error-alert.ts is the IO around them.
//
// WHAT "NEW" MEANS. Two rows are the same error when their source and their message agree once the parts that
// change from one occurrence to the next are taken out — numbers, uuids, HR ids, long tokens. A database outage
// page is one error whatever its status code. The first row of an error sends one message; every repeat is on the
// System Audit page and sends nothing. A caller that already knows what makes two reports the same (a server
// freeze, named by its process and its culprit) passes that as the signature instead.

import { isBrowserNoiseMessage } from "@/lib/error-monitor/browser-noise";
import { isRedactedServerRenderError } from "@/lib/error-monitor/redacted-server-render";
import { classifySupabaseUnreachable } from "@/lib/error-monitor/supabase-unreachable";
import { scrubPath, scrubText } from "@/lib/observability/scrub";

export type NewErrorReport = {
  message: string;
  moduleLabel?: string | null;
  route?: string | null;
  /** Explicit grouping, for a caller whose message carries a figure that changes (a freeze's seconds). */
  signature?: string | null;
  source: string;
};

const HR_ID = /\b[A-Za-z]{1,3}-\d{1,8}\b/g;
// A uuid is one long token (36 characters of hex and hyphens), so it is folded here whole, before the numbers in it.
// Only a token that carries a digit is an id; a long table or function name is what tells two errors apart.
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g;
// A number that NAMES the error stays: "error #418" and "#423", "/errors/418", "status 403" and "status 500".
const NUMBER = /(?<![\d#]|\/errors\/|\b(?:status|code|http|error) )\d+(?:[.,]\d+)?/gi;

/** The message with every part that changes between occurrences replaced by `#`, lower-cased and bounded. */
export function normalizeErrorMessage(message: string | null | undefined): string {
  const text = String(message ?? "");
  if (classifySupabaseUnreachable(text)) return "supabase unreachable";
  return text
    .replace(LONG_TOKEN, "#")
    .replace(HR_ID, "#")
    .replace(NUMBER, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

// FNV-1a, twice with different seeds: a short, stable key for the notification's idempotency key. Not security.
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The key that makes two reports the same error: 16 hex characters. */
export function newErrorSignature(report: Pick<NewErrorReport, "message" | "signature" | "source">): string {
  const explicit = String(report.signature ?? "").trim();
  const basis = explicit
    ? `explicit|${explicit}`
    : `${String(report.source ?? "").trim().toLowerCase()}|${normalizeErrorMessage(report.message)}`;
  return `${fnv1a(basis, 0x811c9dc5)}${fnv1a(basis, 0x9e3779b9)}`;
}

/**
 * Why this report sends nothing, or null when it may. Production only, by the deployment name and never the build
 * mode: staging and the previews build as NODE_ENV=production too, so `APP_ENV` must be literally `production`.
 * A browser's own words for a cut-off request say nothing about Phoenix (browser-noise.ts) and never send; nor
 * does the browser's redacted copy of a server render error (redacted-server-render.ts), whose server row sent it.
 */
export function newErrorAlertRefusal(input: { appEnv: string | undefined; message: string | null | undefined }): string | null {
  if (String(input.appEnv ?? "").trim().toLowerCase() !== "production") return "APP_ENV is not 'production'";
  if (!String(input.message ?? "").trim()) return "no message";
  if (isBrowserNoiseMessage(input.message)) return "browser noise";
  if (isRedactedServerRenderError(String(input.message))) return "the server already reported it";
  return null;
}

const MAX_MESSAGE = 300;

function sourceLabel(source: string): string {
  const value = String(source ?? "").trim().toLowerCase();
  if (value === "client") return "Browser";
  if (value === "server") return "Server";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Unknown";
}

/** The Telegram's title and body. Scrubbed first: no HR id, e-mail address, bot token or id in a path leaves. */
export function newErrorAlertText(report: NewErrorReport): { message: string; title: string } {
  const outage = classifySupabaseUnreachable(report.message);
  const oneLine = scrubText(outage ? outage.line : String(report.message ?? "")).replace(/\s+/g, " ").trim();
  const body = oneLine.length > MAX_MESSAGE ? oneLine.slice(0, MAX_MESSAGE) : oneLine;
  const route = String(report.route ?? "").trim();
  const lines = [
    `${String(report.moduleLabel ?? "").trim() || "Other"} · ${sourceLabel(report.source)}`,
    body,
    route ? `Page: ${scrubPath(route)}` : null,
    "Sent once. Every repeat is on the System Audit.",
  ];
  return { message: lines.filter(Boolean).join("\n"), title: "New error in Phoenix" };
}

/** A process remembers what it already sent, so a repeat costs no database read. Bounded: a full memory starts over. */
export const NEW_ERROR_MEMORY_LIMIT = 2_000;

/** True when the signature is new to this process (and is now remembered). */
export function rememberNewErrorSignature(seen: Set<string>, signature: string, limit = NEW_ERROR_MEMORY_LIMIT): boolean {
  if (seen.has(signature)) return false;
  if (seen.size >= limit) seen.clear();
  seen.add(signature);
  return true;
}

/** At most this many messages per process in one window, so a broken deploy cannot flood his Telegram. */
export const NEW_ERROR_ALERTS_PER_WINDOW = 10;
export const NEW_ERROR_ALERT_WINDOW_MS = 10 * 60_000;

export type NewErrorAlertSlots = { sent: number; windowStartedAt: number };

export function createNewErrorAlertSlots(): NewErrorAlertSlots {
  return { sent: 0, windowStartedAt: 0 };
}

/** True when one more message fits this window (and it is now counted). */
export function takeNewErrorAlertSlot(slots: NewErrorAlertSlots, nowMs: number): boolean {
  if (nowMs - slots.windowStartedAt >= NEW_ERROR_ALERT_WINDOW_MS) {
    slots.windowStartedAt = nowMs;
    slots.sent = 0;
  }
  if (slots.sent >= NEW_ERROR_ALERTS_PER_WINDOW) return false;
  slots.sent += 1;
  return true;
}
