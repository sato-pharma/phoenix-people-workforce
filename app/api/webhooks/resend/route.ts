import { NextResponse } from "next/server";

import {
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
  await recordResendWebhookEvent(event);

  return NextResponse.json({ ok: true });
}
