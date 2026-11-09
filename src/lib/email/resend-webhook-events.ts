import crypto from "crypto";

import { redactCredentialLinksInJson } from "@/lib/email/credential-redaction";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ResendDeliveryStatus =
  | "bounced"
  | "clicked"
  | "complained"
  | "delivered"
  | "failed"
  | "opened"
  | "sent"
  | "suppressed"
  | "unknown";

type ResendWebhookPayload = {
  created_at?: string;
  data?: Record<string, unknown>;
  type?: string;
};

type DeliveryEventRow = {
  event_type: string;
  failure_reason: string | null;
  occurred_at: string;
  provider: "resend";
  provider_event_id: string;
  provider_message_id: string | null;
  raw_event: ResendWebhookPayload;
  recipients: string[];
  sender: string | null;
  status: ResendDeliveryStatus;
  subject: string | null;
};

const webhookToleranceSeconds = 5 * 60;

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function webhookSecretBytes(secret: string) {
  const trimmed = secret.trim();
  const value = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  return Buffer.from(value, "base64");
}

export function verifyResendWebhookSignature(input: {
  body: string;
  headers: Headers;
  secret: string;
}) {
  const svixId = input.headers.get("svix-id");
  const svixTimestamp = input.headers.get("svix-timestamp");
  const svixSignature = input.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestamp = Number(svixTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > webhookToleranceSeconds) return false;

  const signedPayload = `${svixId}.${svixTimestamp}.${input.body}`;
  const digest = crypto
    .createHmac("sha256", webhookSecretBytes(input.secret))
    .update(signedPayload)
    .digest("base64");

  return svixSignature
    .split(" ")
    .some((signature) => {
      const value = signature.trim().startsWith("v1,")
        ? signature.trim().slice("v1,".length)
        : signature.trim();
      return value ? timingSafeEqual(value, digest) : false;
    });
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function textOrNull(value: unknown) {
  const normalized = text(value);
  return normalized || null;
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean);
  }
  const single = text(value);
  return single ? [single] : [];
}

function deliveryStatus(eventType: string): ResendDeliveryStatus {
  switch (eventType.toLowerCase()) {
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.delivery_delayed":
    case "email.failed":
      return "failed";
    case "email.suppressed":
      return "suppressed";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    default:
      return "unknown";
  }
}

/**
 * Whether a recorded "duplicate key" / unique-violation error means the row already
 * exists (safe to ack with 200 rather than make Resend retry).
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("duplicate key") || message.includes("unique constraint");
}

/**
 * Map a delivery event to a suppression decision (or null if it should not suppress).
 *  - complaint  → permanent (fail-closed: never re-email a spam complaint)
 *  - hard bounce → permanent; an explicitly transient/soft bounce gets a 7-day expiry so
 *    it auto-recovers. Unknown/empty bounce subtype is treated as hard (reputation-safe).
 */
export function suppressionReasonForEvent(
  row: Pick<DeliveryEventRow, "status" | "raw_event">,
): { reason: "hard_bounce" | "complaint"; expiresAt: string | null } | null {
  if (row.status === "complained") return { reason: "complaint", expiresAt: null };
  if (row.status === "bounced") {
    const data = (row.raw_event?.data ?? {}) as Record<string, unknown>;
    const bounce = (typeof data.bounce === "object" && data.bounce ? data.bounce : {}) as Record<string, unknown>;
    const subtype = String(bounce.subType ?? bounce.type ?? data.type ?? "").toLowerCase();
    const soft = subtype.includes("transient") || subtype.includes("soft") || subtype.includes("undetermined");
    return {
      reason: "hard_bounce",
      expiresAt: soft ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() : null,
    };
  }
  return null;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const normalized = textOrNull(value);
    if (normalized) return normalized;
  }
  return null;
}

function failureReason(data: Record<string, unknown>) {
  const bounce = typeof data.bounce === "object" && data.bounce ? data.bounce as Record<string, unknown> : null;
  // `email.failed` carries its cause under `data.failed.reason` (a quota or account refusal) — the
  // only place Resend states WHY a message it accepted never left.
  const failed = typeof data.failed === "object" && data.failed ? data.failed as Record<string, unknown> : null;
  return firstText(
    data.reason,
    data.message,
    data.error,
    data.diagnostic_code,
    failed?.reason,
    failed?.message,
    bounce?.message,
    bounce?.reason,
    bounce?.diagnostic_code,
  );
}

function occurredAt(payload: ResendWebhookPayload, data: Record<string, unknown>) {
  const raw = firstText(data.created_at, payload.created_at);
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

export function parseResendWebhookEvent(payload: ResendWebhookPayload, providerEventId: string): DeliveryEventRow {
  const data = typeof payload.data === "object" && payload.data ? payload.data : {};
  const eventType = text(payload.type) || "unknown";
  return {
    event_type: eventType,
    failure_reason: failureReason(data),
    occurred_at: occurredAt(payload, data),
    provider: "resend",
    provider_event_id: providerEventId,
    provider_message_id: firstText(data.email_id, data.id, data.message_id),
    // A click on a set-your-password link carries the link; its token is never stored.
    raw_event: redactCredentialLinksInJson(payload),
    recipients: stringArray(data.to),
    sender: textOrNull(data.from),
    status: deliveryStatus(eventType),
    subject: textOrNull(data.subject),
  };
}

export async function recordResendWebhookEvent(row: DeliveryEventRow): Promise<{ duplicate: boolean }> {
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("email_delivery_events")
    .upsert(row, { onConflict: "provider_event_id" });

  if (result.error) {
    if (isDuplicateKeyError(result.error)) return { duplicate: true };
    throw result.error;
  }

  // Feed the durable suppression list on bounce/complaint (most-recent status wins via
  // onConflict address). A suppression write failure must not fail the webhook ack — the
  // delivery event is already recorded.
  const decision = suppressionReasonForEvent(row);
  if (decision && row.recipients.length > 0) {
    const now = new Date().toISOString();
    const suppressions = Array.from(new Set(row.recipients.map((address) => address.trim().toLowerCase())))
      .filter(Boolean)
      .map((address) => ({
        address,
        bounce_subtype: row.failure_reason,
        expires_at: decision.expiresAt,
        reason: decision.reason,
        source: "resend_webhook",
        updated_at: now,
      }));
    if (suppressions.length > 0) {
      const suppressionResult = await supabase
        .from("email_suppressions")
        .upsert(suppressions, { onConflict: "address" });
      if (suppressionResult.error && !isDuplicateKeyError(suppressionResult.error)) {
        logError("Failed to upsert email suppressions from Resend webhook", { labels: { event: "resend_webhook_suppression_upsert_failed" }, error: suppressionResult.error });
      }
    }
  }

  return { duplicate: false };
}
