import crypto from "crypto";

import { redactCredentialLinksInJson } from "@/lib/email/credential-redaction";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Brevo transactional webhooks are NOT HMAC-signed (unlike Resend/svix). We authenticate them
// with a shared secret carried ONLY in the `Authorization: Bearer` header, verified in constant
// time against BREVO_WEBHOOK_SECRET; a secret in the URL (`?token=`) is never accepted (checkBrevoWebhookAuth).
// Events are normalised into the SAME
// `email_delivery_events` table the Resend webhook writes (provider = "brevo"), so opens/clicks/
// bounces land in one place regardless of which provider actually sent the mail.

export type BrevoDeliveryStatus =
  | "bounced"
  | "clicked"
  | "complained"
  | "delivered"
  | "failed"
  | "opened"
  | "sent"
  | "suppressed"
  | "unsubscribed"
  | "unknown";

type BrevoWebhookPayload = Record<string, unknown>;

type BrevoDeliveryEventRow = {
  event_type: string;
  failure_reason: string | null;
  occurred_at: string;
  provider: "brevo";
  provider_event_id: string;
  provider_message_id: string | null;
  raw_event: BrevoWebhookPayload;
  recipients: string[];
  sender: string | null;
  status: BrevoDeliveryStatus;
  subject: string | null;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function textOrNull(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const normalized = textOrNull(value);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Constant-time string comparison. Both sides are hashed to a fixed 32 bytes first, so neither the
 * comparison nor an early length check tells a caller how long the secret is or how much of it matched.
 */
function timingSafeEqual(left: string, right: string) {
  const leftDigest = crypto.createHash("sha256").update(left, "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(right, "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export type BrevoWebhookAuthResult =
  | { ok: true; warning?: "secret_in_url" }
  | { ok: false; reason: "secret_not_configured" | "secret_in_url" | "bearer_missing" | "bearer_mismatch" };

/** The token in `Authorization: Bearer <token>`, or "" when the header is absent or another scheme. */
function bearerToken(header: string | null): string {
  const match = /^\s*bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() ?? "";
}

/** True when the URL carries a `token` query parameter (any value), or cannot be read at all. */
function urlCarriesToken(url: string): boolean {
  try {
    return new URL(url).searchParams.has("token");
  } catch {
    return true;
  }
}

/**
 * Authenticate a Brevo webhook (audit point 20, owner-approved 2026-10-26).
 *
 * The secret travels ONLY in the `Authorization: Bearer <BREVO_WEBHOOK_SECRET>` header — Brevo's
 * webhook "Bearer token" authentication — compared in constant time. It used to be accepted in the
 * URL (`?token=`) or an `x-brevo-token` header. A secret in a URL is written into every access log,
 * proxy log and error report the URL passes through, so `?token=` never authenticates anything and
 * `x-brevo-token` is no longer read at all.
 *
 * THE CUT-OVER (risk review, 26 Oct). Brevo is switched to send the NEW secret as a Bearer header
 * BEFORE this code ships, while the webhook address still carries the old `?token=` (the code then
 * running reads it). So a request with a valid Bearer is ACCEPTED even when `?token=` is still on
 * its URL — refusing it would drop every delivery event between the deploy and the moment the token
 * is taken off the address — and it comes back with `warning: "secret_in_url"`, which the route logs
 * until the address is clean. A request that carries `?token=` and no valid Bearer is refused as
 * `secret_in_url`, so the old configuration on its own fails loudly instead of quietly.
 */
export function checkBrevoWebhookAuth(input: { url: string; headers: Headers; secret: string }): BrevoWebhookAuthResult {
  const secret = input.secret.trim();
  if (!secret) return { ok: false, reason: "secret_not_configured" };
  const tokenInUrl = urlCarriesToken(input.url);
  const provided = bearerToken(input.headers.get("authorization"));
  if (provided && timingSafeEqual(provided, secret)) return tokenInUrl ? { ok: true, warning: "secret_in_url" } : { ok: true };
  if (tokenInUrl) return { ok: false, reason: "secret_in_url" };
  return { ok: false, reason: provided ? "bearer_mismatch" : "bearer_missing" };
}

/** True only for a request whose `Authorization: Bearer` header carries the secret (checkBrevoWebhookAuth). */
export function verifyBrevoWebhookAuth(input: { url: string; headers: Headers; secret: string }): boolean {
  return checkBrevoWebhookAuth(input).ok;
}

// Brevo `event` → our shared status vocabulary.
function brevoStatus(event: string): BrevoDeliveryStatus {
  switch (event.toLowerCase()) {
    case "request":
      return "sent";
    case "delivered":
      return "delivered";
    case "opened":
    case "unique_opened":
    case "loadedbyproxy":
    case "proxy_open":
    case "unique_proxy_open":
      return "opened";
    case "click":
      return "clicked";
    case "hard_bounce":
    case "soft_bounce":
    case "invalid_email":
      return "bounced";
    case "blocked":
      return "suppressed";
    case "spam":
      return "complained";
    case "unsubscribed":
      return "unsubscribed";
    case "deferred":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function occurredAt(payload: BrevoWebhookPayload) {
  // Prefer the epoch (`ts_event`/`ts`) — unambiguous UTC. Brevo's `date` string is sent in the
  // account's LOCAL timezone WITHOUT an offset, so parsing it as UTC skews the time (e.g. +3h for
  // Cairo). Only trust the string when it carries an explicit offset/Z; otherwise fall back to the
  // receive time (the webhook arrives right after the event).
  const epoch = Number(payload.ts_event ?? payload.ts);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000).toISOString();
  const raw = firstText(payload.date, payload["date_event"]);
  if (raw && /(z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Stable per-event id for idempotent recording: a hash of the fields that identify ONE event —
 * message id, event, recipient, timestamp and clicked link — so a Brevo retry of the same event
 * dedupes while two distinct opens/clicks, or the same event for two recipients, are kept apart.
 *
 * 🔴 NEVER key on the payload's `id`. It is the id of the WEBHOOK, not of the event: every event
 * Brevo sends carries the same number (2080303 on production), so keying on it upserted every open,
 * click and bounce onto ONE row — production held exactly one Brevo event, ever. The recipient is
 * in the hash because a batch fans out to many people who are delivered in the same second.
 */
export function brevoProviderEventId(payload: BrevoWebhookPayload): string {
  const messageId = firstText(payload["message-id"], payload.messageId) ?? "";
  const event = firstText(payload.event) ?? "";
  const recipient = (firstText(payload.email, payload["recipient"]) ?? "").toLowerCase();
  const stamp = firstText(payload.ts_epoch, payload.ts_event, payload.ts, payload.date) ?? "";
  const link = firstText(payload.link, payload.URL, payload.url) ?? "";
  const digest = crypto.createHash("sha256").update(`${messageId}|${event}|${recipient}|${stamp}|${link}`).digest("hex");
  return `brevo:${digest}`;
}

export function parseBrevoWebhookEvent(payload: BrevoWebhookPayload): BrevoDeliveryEventRow {
  const event = text(payload.event) || "unknown";
  const recipient = firstText(payload.email, payload["recipient"]);
  return {
    event_type: `brevo.${event}`,
    failure_reason: firstText(payload.reason, payload["error"]),
    occurred_at: occurredAt(payload),
    provider: "brevo",
    provider_event_id: brevoProviderEventId(payload),
    provider_message_id: firstText(payload["message-id"], payload.messageId),
    // A click on a set-your-password link carries the link; its token is never stored.
    raw_event: redactCredentialLinksInJson(payload),
    recipients: recipient ? [recipient] : [],
    sender: firstText(payload["sender_email"], payload.sender),
    status: brevoStatus(event),
    subject: textOrNull(payload.subject),
  };
}

/** Whether a duplicate-key / unique-violation means the row already exists (safe to ack 200). */
export function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("duplicate key") || message.includes("unique constraint");
}

// Suppression decision (mirrors the Resend policy): a spam complaint / unsubscribe / hard bounce
// permanently suppresses the address; a soft bounce gets a 7-day expiry so it auto-recovers.
function suppressionReasonForBrevoEvent(
  status: BrevoDeliveryStatus,
  event: string,
): { reason: "hard_bounce" | "complaint"; expiresAt: string | null } | null {
  const normalized = event.toLowerCase();
  if (status === "complained" || status === "unsubscribed") return { reason: "complaint", expiresAt: null };
  if (normalized === "soft_bounce") {
    return { reason: "hard_bounce", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() };
  }
  if (status === "bounced" || status === "suppressed") return { reason: "hard_bounce", expiresAt: null };
  return null;
}

// ── Confirming a bounce-list event with Brevo (S01, F-COM-017) ───────────────────────────────
// A webhook event that would put an address on the bounce list is acted on only once Brevo's own
// event log (GET /v3/smtp/statistics/events, read with the account's API key) shows that event for
// that address and message. The delivery row is always recorded; only the bounce-list write waits
// for the confirmation. Not confirmed (not found, or Brevo cannot be asked) → the list is unchanged
// and the reason is logged. A real bounce that misses here is still caught by the next send's own
// provider.

const BREVO_EVENTS_ENDPOINT = "https://api.brevo.com/v3/smtp/statistics/events";
const BREVO_CONFIRM_TIMEOUT_MS = 8_000;
const BREVO_CONFIRM_RETRY_DELAY_MS = 3_000;
/** Both Brevo accounts in the failover chain post to this one webhook, so either may hold the event. */
const BREVO_CONFIRM_KEY_ENVS = ["BREVO_API_KEY", "BREVO_API_KEY_2"] as const;

/** Webhook event name → the `event` filter of Brevo's event log. Only bounce-list events are here. */
const BREVO_EVENT_LOG_FILTER: Record<string, string> = {
  blocked: "blocked",
  hard_bounce: "hardBounces",
  invalid_email: "invalid",
  soft_bounce: "softBounces",
  spam: "spam",
  unsubscribed: "unsubscribed",
};

export type BrevoEventConfirmation = "confirmed" | "not_found" | "unavailable";

type BrevoEventLogEntry = { email?: unknown; messageId?: unknown };

/** The webhook sends `message-id` with or without angle brackets; the event log uses them. Compare bare. */
function bareMessageId(value: string): string {
  return value.trim().replace(/^<+/, "").replace(/>+$/, "");
}

async function askBrevoEventLog(
  apiKey: string,
  input: { email: string; eventFilter: string; messageId: string },
): Promise<"confirmed" | "not_found" | "unavailable"> {
  const url = new URL(BREVO_EVENTS_ENDPOINT);
  url.searchParams.set("email", input.email);
  url.searchParams.set("messageId", `<${bareMessageId(input.messageId)}>`);
  url.searchParams.set("event", input.eventFilter);
  url.searchParams.set("days", "30");
  url.searchParams.set("limit", "50");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "api-key": apiKey },
      method: "GET",
      signal: AbortSignal.timeout(BREVO_CONFIRM_TIMEOUT_MS),
    });
  } catch {
    return "unavailable";
  }
  if (!response.ok) return "unavailable";
  const body = (await response.json().catch(() => null)) as { events?: BrevoEventLogEntry[] } | null;
  if (!body || typeof body !== "object") return "unavailable";
  const events = Array.isArray(body.events) ? body.events : [];
  const email = input.email.toLowerCase();
  const messageId = bareMessageId(input.messageId);
  const match = events.some(
    (entry) => text(entry?.email).toLowerCase() === email && bareMessageId(text(entry?.messageId)) === messageId,
  );
  return match ? "confirmed" : "not_found";
}

/**
 * Whether Brevo's own event log holds this bounce-list event. Never throws. Asks each configured
 * Brevo account; a miss is asked once more after a short wait, because the log can trail the webhook.
 */
export async function confirmBrevoEventWithBrevo(
  input: { email: string | null; event: string; messageId: string | null },
  options: { retryDelayMs?: number } = {},
): Promise<BrevoEventConfirmation> {
  const eventFilter = BREVO_EVENT_LOG_FILTER[input.event.toLowerCase()];
  const email = input.email?.trim();
  const messageId = input.messageId ? bareMessageId(input.messageId) : "";
  if (!eventFilter || !email || !messageId) return "not_found";
  const keys = BREVO_CONFIRM_KEY_ENVS.map((name) => process.env[name]?.trim()).filter((key): key is string => Boolean(key));
  if (keys.length === 0) return "unavailable";

  const retryDelayMs = options.retryDelayMs ?? BREVO_CONFIRM_RETRY_DELAY_MS;
  let outcome: BrevoEventConfirmation = "not_found";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    let anyUnavailable = false;
    for (const apiKey of keys) {
      const answer = await askBrevoEventLog(apiKey, { email, eventFilter, messageId });
      if (answer === "confirmed") return "confirmed";
      if (answer === "unavailable") anyUnavailable = true;
    }
    outcome = anyUnavailable ? "unavailable" : "not_found";
  }
  return outcome;
}

export async function recordBrevoWebhookEvent(
  row: BrevoDeliveryEventRow,
  options: { confirmRetryDelayMs?: number } = {},
): Promise<{ duplicate: boolean; suppression: "applied" | "unconfirmed" | "none" }> {
  const supabase = getSupabaseAdmin();
  const result = await supabase.from("email_delivery_events").upsert(row, { onConflict: "provider_event_id" });
  if (result.error) {
    if (isDuplicateKeyError(result.error)) return { duplicate: true, suppression: "none" };
    throw result.error;
  }

  const event = String((row.raw_event as { event?: unknown }).event ?? "");
  const decision = suppressionReasonForBrevoEvent(row.status, event);
  if (!decision || row.recipients.length === 0) return { duplicate: false, suppression: "none" };

  const confirmation = await confirmBrevoEventWithBrevo(
    { email: row.recipients[0] ?? null, event, messageId: row.provider_message_id },
    { retryDelayMs: options.confirmRetryDelayMs },
  );
  if (confirmation !== "confirmed") {
    // Kind and outcome only — never the address or the message id.
    logWarning("Brevo webhook event not confirmed by Brevo; the bounce list is unchanged", {
      labels: { brevo_event: event.toLowerCase(), event: "brevo_webhook_suppression_unconfirmed", outcome: confirmation },
    });
    return { duplicate: false, suppression: "unconfirmed" };
  }

  {
    const now = new Date().toISOString();
    const suppressions = Array.from(new Set(row.recipients.map((address) => address.trim().toLowerCase())))
      .filter(Boolean)
      .map((address) => ({
        address,
        bounce_subtype: row.failure_reason,
        expires_at: decision.expiresAt,
        reason: decision.reason,
        source: "brevo_webhook",
        updated_at: now,
      }));
    if (suppressions.length > 0) {
      const suppressionResult = await supabase.from("email_suppressions").upsert(suppressions, { onConflict: "address" });
      if (suppressionResult.error && !isDuplicateKeyError(suppressionResult.error)) {
        logError("Failed to upsert email suppressions from Brevo webhook", { labels: { event: "brevo_webhook_suppression_upsert_failed" }, error: suppressionResult.error });
      }
    }
  }

  return { duplicate: false, suppression: "applied" };
}
