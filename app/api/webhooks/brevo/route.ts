import { NextResponse } from "next/server";

import {
  isDuplicateKeyError,
  parseBrevoWebhookEvent,
  recordBrevoWebhookEvent,
  verifyBrevoWebhookAuth,
} from "@/lib/email/brevo-webhook-events";
import { logWarning } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Brevo transactional webhook receiver. Records opens/clicks/bounces/etc. into the shared
// email_delivery_events table (provider = "brevo"), so engagement is unified with Resend. Auth is
// a shared secret in the URL (?token=…) or an x-brevo-token header — Brevo does not sign payloads.
export async function POST(request: Request) {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (!secret) {
    logWarning("Brevo webhook received but BREVO_WEBHOOK_SECRET is not configured", {
      labels: { event: "webhook_misconfigured", webhook: "brevo" },
    });
    return NextResponse.json({ message: "BREVO_WEBHOOK_SECRET is not configured." }, { status: 500 });
  }

  if (!verifyBrevoWebhookAuth({ url: request.url, headers: request.headers, secret })) {
    logWarning("Rejected Brevo webhook with an invalid or missing token", {
      labels: { event: "webhook_token_invalid", webhook: "brevo" },
    });
    return NextResponse.json({ message: "Invalid Brevo webhook token." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ message: "Invalid Brevo webhook JSON." }, { status: 400 });
  }

  // Brevo posts a single event object; tolerate an array too (batched events).
  const events = Array.isArray(payload) ? payload : [payload];
  let recorded = 0;
  let duplicates = 0;
  try {
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const row = parseBrevoWebhookEvent(event as Record<string, unknown>);
      const { duplicate } = await recordBrevoWebhookEvent(row);
      if (duplicate) duplicates += 1;
      else recorded += 1;
    }
    return NextResponse.json({ duplicates, ok: true, recorded });
  } catch (error) {
    // Already-recorded → ack 200 so Brevo stops retrying; genuine transient error → 503 to retry.
    if (isDuplicateKeyError(error)) {
      return NextResponse.json({ duplicate: true, ok: true });
    }
    console.error(error, { tags: { component: "email", webhook: "brevo" } });
    return NextResponse.json({ message: "Temporary error recording webhook." }, { status: 503 });
  }
}
