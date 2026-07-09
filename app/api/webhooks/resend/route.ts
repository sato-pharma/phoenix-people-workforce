import { NextResponse } from "next/server";

import {
  isDuplicateKeyError,
  parseResendWebhookEvent,
  recordResendWebhookEvent,
  verifyResendWebhookSignature,
} from "@/lib/email/resend-webhook-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ message: "RESEND_WEBHOOK_SECRET is not configured." }, { status: 500 });
  }

  const body = await request.text();
  if (!verifyResendWebhookSignature({ body, headers: request.headers, secret })) {
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
