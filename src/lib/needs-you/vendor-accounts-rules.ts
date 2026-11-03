/**
 * THE VENDOR ACCOUNTS ON THE BOARD, AS PURE RULES (owner, 3 Nov 2026).
 *
 * On 2 Nov 2026 GitHub suspended the account and Supabase showed outstanding invoices, and neither reached any
 * board. These three sources read what Phoenix can already see for itself, and each answers one of three ways:
 *
 *   - the vendor answered and all is well: nothing on the board;
 *   - the vendor refused us, or the key is missing: a row in his own lane, because only he can settle an account;
 *   - the vendor could not be asked: an amber "could not be read", never a calm zero.
 *
 * 🔴 ONE FAILED READ MUST NOT HIDE ANOTHER, AND A 5xx IS NOT A REFUSAL. That is why these are three sources and
 * not one, and why the probes carry an HTTP status: a Meta outage worded as "your account was refused" sends him
 * to investigate a problem that does not exist.
 *
 * 🔴 WHAT THIS CANNOT SEE IS SAID OUT LOUD. Production holds no key that can read Supabase invoices or Railway
 * standing, and nothing here would have caught the Supabase banner. So {@link NEEDS_YOU_VENDORS_NOT_READ_LINE} is
 * printed on the board and the Sunday email. It is a fixed line, not an item, so it can never block the all-clear.
 *
 * 🔴 EVERY SENTENCE IS FIXED, NEVER THE VENDOR'S TEXT. A vendor's error can run to paragraphs and can echo a
 * request back, and the daily digest is 900 characters that Telegram slices from the end.
 *
 * Pure: its only imports are `./types` and the import-free dispatch reasons. No clock, no network, no environment.
 */

import { classifySyntheticDispatchFailure } from "@/lib/observability/synthetic-dispatch-reasons";

import { needsYouDestinations, type NeedsYouItem, type NeedsYouSourceId, type NeedsYouSourceState } from "./types";

/** The dispatch runs hourly, so this many hours of silence means the job itself has stopped reporting. */
export const VENDOR_GITHUB_SILENCE_HOURS = 12;

export const NEEDS_YOU_VENDORS_NOT_READ_LINE =
  "This board cannot read Supabase invoices, Railway standing, GitHub billing, OneSignal, Google Maps, Sentry or " +
  "cron-job.org. Check those on their own screens.";

export const VENDOR_GITHUB_REFUSED_LABEL = "GitHub refused Phoenix's hourly run. The account or its key needs you.";
export const VENDOR_GITHUB_KEY_MISSING_LABEL = "The GitHub key is missing, so Phoenix's hourly run has stopped.";
export const VENDOR_WHATSAPP_NOT_CONNECTED_LABEL = "WhatsApp is not connected. The key or the line number is missing.";
export const VENDOR_TELEGRAM_REFUSED_LABEL = "Telegram refused the bot's key. The bot needs you.";
export const VENDOR_TELEGRAM_KEY_MISSING_LABEL = "The Telegram bot key is missing.";

export function vendorWhatsAppRefusedLabel(lines: number): string {
  return lines === 1 ? "Meta refused one WhatsApp line. The account or its key needs you." : `Meta refused ${lines} WhatsApp lines. The account or its key needs you.`;
}

function vendorItem(sourceId: NeedsYouSourceId, key: string, label: string, note: string | null = null): NeedsYouItem {
  return {
    key: `${sourceId}:${key}`,
    sourceId,
    kind: "flag",
    lane: "yours",
    label,
    count: null,
    people: [],
    href: needsYouDestinations[sourceId].href,
    externalUrl: null,
    oldestAt: null,
    ageDays: null,
    overdue: false,
    note,
  };
}

const allFine: NeedsYouSourceState = { status: "ok", items: [] };

function oneRow(item: NeedsYouItem): NeedsYouSourceState {
  return { status: "ok", items: [item] };
}

// ── GitHub, from the hourly dispatch's own heartbeat. No network call of its own. ──

export type VendorGithubHeartbeat = {
  lastOutcome: "success" | "fail" | null;
  lastSuccessAt: string | null;
  lastFailAt: string | null;
  lastDetail: string | null;
};

const STAGING_GITHUB = "Only production runs the hourly GitHub job";

export function judgeGithubAccount(row: VendorGithubHeartbeat | null, now: Date, production: boolean): NeedsYouSourceState {
  const reports = [row?.lastSuccessAt, row?.lastFailAt].map((iso) => (iso ? Date.parse(iso) : Number.NaN)).filter(Number.isFinite);
  if (!row || reports.length === 0) {
    return production ? { status: "unavailable", because: "the hourly GitHub run has never reported" } : { status: "not-applicable", because: STAGING_GITHUB };
  }
  if (now.getTime() - Math.max(...reports) > VENDOR_GITHUB_SILENCE_HOURS * 3_600_000) {
    return production
      ? { status: "unavailable", because: `the hourly GitHub run has not reported for more than ${VENDOR_GITHUB_SILENCE_HOURS} hours` }
      : { status: "not-applicable", because: STAGING_GITHUB };
  }
  if (row.lastOutcome === "success") return allFine;

  switch (classifySyntheticDispatchFailure(row.lastDetail)) {
    case "refused":
      return oneRow(vendorItem("vendor-github", "refused", VENDOR_GITHUB_REFUSED_LABEL));
    case "token-unset":
      return production ? oneRow(vendorItem("vendor-github", "key-missing", VENDOR_GITHUB_KEY_MISSING_LABEL)) : { status: "not-applicable", because: STAGING_GITHUB };
    case "not-answered":
      return { status: "unavailable", because: "GitHub did not answer the last hourly run" };
    default:
      return { status: "unavailable", because: "the last hourly GitHub run failed for a reason this board cannot name" };
  }
}

// ── WhatsApp, from a read of every configured line. ──

export type VendorWhatsAppProbe = {
  ok: boolean;
  failureKind: "transport" | "meta" | null;
  httpStatus?: number | null;
};

/** Did Meta itself say no? A dropped connection, an outage and a rate limit all say nothing about the account. */
function metaRefused(probe: VendorWhatsAppProbe): boolean {
  if (probe.ok || probe.failureKind !== "meta") return false;
  const status = probe.httpStatus ?? null;
  return status === null || (status !== 429 && status < 500);
}

export function judgeWhatsAppAccount(probes: readonly VendorWhatsAppProbe[], production: boolean): NeedsYouSourceState {
  // `probeAllWhatsAppNumbers` answers an empty list only when there is no key or no line to ask about.
  if (probes.length === 0) {
    return production ? oneRow(vendorItem("vendor-whatsapp", "not-connected", VENDOR_WHATSAPP_NOT_CONNECTED_LABEL)) : { status: "not-applicable", because: "WhatsApp is not set up on this environment" };
  }
  const refused = probes.filter(metaRefused).length;
  const unread = probes.filter((probe) => !probe.ok && !metaRefused(probe)).length;
  if (refused > 0) {
    const note = unread > 0 ? `${unread} more could not be read.` : null;
    return oneRow(vendorItem("vendor-whatsapp", "refused", vendorWhatsAppRefusedLabel(refused), note));
  }
  if (unread > 0) return { status: "unavailable", because: unread === 1 ? "Meta did not answer for one WhatsApp line" : `Meta did not answer for ${unread} WhatsApp lines` };
  return allFine;
}

// ── Telegram, from the bot's own webhook read. ──

export type VendorTelegramStatus = {
  /** Is there a bot key at all? */
  hasToken: boolean;
  /** Telegram answered, whatever it said. */
  checked: boolean;
  error: string | null;
  httpStatus?: number | null;
};

export function judgeTelegramAccount(status: VendorTelegramStatus, production: boolean): NeedsYouSourceState {
  if (!status.hasToken) {
    return production ? oneRow(vendorItem("vendor-telegram", "key-missing", VENDOR_TELEGRAM_KEY_MISSING_LABEL)) : { status: "not-applicable", because: "The Telegram bot is not set up on this environment" };
  }
  if (!status.checked) return { status: "unavailable", because: "Telegram did not answer" };
  if (!status.error) return allFine;
  // 401 is a dead key and 404 a bot that no longer exists. Anything else says nothing about the account.
  if (status.httpStatus === 401 || status.httpStatus === 404) return oneRow(vendorItem("vendor-telegram", "refused", VENDOR_TELEGRAM_REFUSED_LABEL));
  return { status: "unavailable", because: "Telegram answered with a fault of its own" };
}
