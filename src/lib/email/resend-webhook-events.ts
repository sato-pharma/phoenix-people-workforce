import crypto from "crypto";

import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ResendDeliveryStatus = "bounced" | "complained" | "delivered" | "failed" | "sent" | "suppressed" | "unknown";

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
    default:
      return "unknown";
  }
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
  return firstText(
    data.reason,
    data.message,
    data.error,
    data.diagnostic_code,
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
    raw_event: payload,
    recipients: stringArray(data.to),
    sender: textOrNull(data.from),
    status: deliveryStatus(eventType),
    subject: textOrNull(data.subject),
  };
}

export async function recordResendWebhookEvent(row: DeliveryEventRow) {
  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("email_delivery_events")
    .upsert(row, { onConflict: "provider_event_id" });

  if (result.error) throw result.error;
}
