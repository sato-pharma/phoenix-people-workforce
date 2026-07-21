import crypto from "crypto";

import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Brevo transactional webhooks are NOT HMAC-signed (unlike Resend/svix). We authenticate them
// with a shared secret carried in the URL (`?token=…`) or an `x-brevo-token` header, verified
// timing-safely against BREVO_WEBHOOK_SECRET. Events are normalised into the SAME
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

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Authenticate a Brevo webhook via the shared secret in `?token=` or the `x-brevo-token`
 * header. Returns false when the secret is missing or does not match.
 */
export function verifyBrevoWebhookAuth(input: { url: string; headers: Headers; secret: string }): boolean {
  const secret = input.secret.trim();
  if (!secret) return false;
  let tokenFromQuery = "";
  try {
    tokenFromQuery = new URL(input.url).searchParams.get("token")?.trim() ?? "";
  } catch {
    tokenFromQuery = "";
  }
  const tokenFromHeader = input.headers.get("x-brevo-token")?.trim() ?? "";
  const provided = tokenFromQuery || tokenFromHeader;
  if (!provided) return false;
  return timingSafeEqual(provided, secret);
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
 * Stable per-event id for idempotent recording. Uses Brevo's own `id` when present, else a hash
 * of the fields that uniquely identify the event (message id + event + timestamp + clicked link),
 * so a Brevo retry of the same event dedupes while two distinct opens/clicks are kept separate.
 */
export function brevoProviderEventId(payload: BrevoWebhookPayload): string {
  const explicit = firstText(payload.id);
  if (explicit) return `brevo:${explicit}`;
  const messageId = firstText(payload["message-id"], payload.messageId) ?? "";
  const event = firstText(payload.event) ?? "";
  const stamp = firstText(payload.date, payload.ts_event, payload.ts) ?? "";
  const link = firstText(payload.link, payload.URL, payload.url) ?? "";
  const digest = crypto.createHash("sha256").update(`${messageId}|${event}|${stamp}|${link}`).digest("hex");
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
    raw_event: payload,
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

export async function recordBrevoWebhookEvent(row: BrevoDeliveryEventRow): Promise<{ duplicate: boolean }> {
  const supabase = getSupabaseAdmin();
  const result = await supabase.from("email_delivery_events").upsert(row, { onConflict: "provider_event_id" });
  if (result.error) {
    if (isDuplicateKeyError(result.error)) return { duplicate: true };
    throw result.error;
  }

  const event = String((row.raw_event as { event?: unknown }).event ?? "");
  const decision = suppressionReasonForBrevoEvent(row.status, event);
  if (decision && row.recipients.length > 0) {
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

  return { duplicate: false };
}
