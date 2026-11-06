import { NextResponse } from "next/server";

import {
  isDuplicateKeyError,
  parseResendWebhookEvent,
  recordResendWebhookEvent,
  verifyResendWebhookSignature,
} from "@/lib/email/resend-webhook-events";
import { moduleSendingAccounts } from "@/lib/email/module-sending-accounts";
import { logWarning } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    logWarning("Resend webhook received but RESEND_WEBHOOK_SECRET is not configured", {
      labels: { event: "webhook_misconfigured", webhook: "resend" },
    });
    return NextResponse.json({ message: "RESEND_WEBHOOK_SECRET is not configured." }, { status: 500 });
  }

  // Each Resend account signs its webhook with its own secret, so the extra sending accounts
  // (RESEND_API_KEY_2, _3 and _4, see src/lib/email/email-providers.ts) add RESEND_WEBHOOK_SECRET_2, _3 and _4,
  // and each per-module account (src/lib/email/module-sending-accounts.ts) adds RESEND_WEBHOOK_SECRET_<SUFFIX>
  // — without it that account's delivered/opened/clicked events would be rejected with a 401.
  // Those accounts stopped SENDING on 2026-11-06 (one Resend, one Brevo — email-providers.ts); their
  // secrets stay here so the late bounces and complaints of mail they already sent are still recorded.
  const secrets = [
    secret,
    process.env.RESEND_WEBHOOK_SECRET_2,
    process.env.RESEND_WEBHOOK_SECRET_3,
    process.env.RESEND_WEBHOOK_SECRET_4,
    ...moduleSendingAccounts.map((account) => process.env[`RESEND_WEBHOOK_SECRET_${account.suffix}`]),
  ].filter((value): value is string => Boolean(value?.trim()));
  const body = await request.text();
  if (!secrets.some((candidate) => verifyResendWebhookSignature({ body, headers: request.headers, secret: candidate }))) {
    // A spike here means forged/misconfigured webhook traffic — surface for alerting.
    logWarning("Rejected Resend webhook with an invalid signature", {
      labels: { event: "webhook_signature_invalid", webhook: "resend" },
    });
    return NextResponse.json({ message: "Invalid Resend webhook signature." }, { status: 401 });
  }

  let payload: { type?: string; data?: Record<string, unknown>; created_at?: string };
  try {
    payload = JSON.parse(body) as { type?: string; data?: Record<string, unknown>; created_at?: string };
  } catch {
    return NextResponse.json({ message: "Invalid Resend webhook JSON." }, { status: 400 });
  }
  const eventId = request.headers.get("svix-id") ?? "";
  const event = parseResendWebhookEvent(payload, eventId);

  try {
    const { duplicate } = await recordResendWebhookEvent(event);
    return NextResponse.json({ duplicate, ok: true });
  } catch (error) {
    // Already-recorded (duplicate) → ack with 200 so Resend stops retrying.
    if (isDuplicateKeyError(error)) {
      return NextResponse.json({ duplicate: true, ok: true });
    }
    // A genuine transient DB error → 503 so Resend retries; tag it so it is not silent.
    console.error(error, {
      tags: { component: "email", webhook: "resend", eventType: event.event_type },
    });
    return NextResponse.json({ message: "Temporary error recording webhook." }, { status: 503 });
  }
}
