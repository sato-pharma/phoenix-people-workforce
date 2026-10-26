import { NextResponse } from "next/server";

import {
  checkBrevoWebhookAuth,
  isDuplicateKeyError,
  parseBrevoWebhookEvent,
  recordBrevoWebhookEvent,
} from "@/lib/email/brevo-webhook-events";
import { logWarning } from "@/lib/observability/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Brevo transactional webhook receiver. Records opens/clicks/bounces/etc. into the shared
// email_delivery_events table (provider = "brevo"), so engagement is unified with Resend. Auth is
// a shared secret in the Authorization: Bearer header ONLY (Brevo does not sign payloads); a secret
// in the URL (?token=) never authenticates anything (audit point 20, 2026-10-26). The webhook
// registered in Brevo must use Bearer-token authentication with BREVO_WEBHOOK_SECRET and a URL with no
// token on it; while the old ?token= is still on the address a valid Bearer is accepted and logged.
export async function POST(request: Request) {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (!secret) {
    logWarning("Brevo webhook received but BREVO_WEBHOOK_SECRET is not configured", {
      labels: { event: "webhook_misconfigured", webhook: "brevo" },
    });
    return NextResponse.json({ message: "BREVO_WEBHOOK_SECRET is not configured." }, { status: 500 });
  }

  const auth = checkBrevoWebhookAuth({ url: request.url, headers: request.headers, secret });
  if (!auth.ok) {
    // The reason (never the token) says which half of the cut-over is wrong: secret_in_url means the
    // Brevo webhook still has ?token= on its URL; bearer_missing means it has no Bearer token set.
    logWarning("Rejected Brevo webhook with an invalid or missing token", {
      labels: { event: "webhook_token_invalid", reason: auth.reason, webhook: "brevo" },
    });
    return NextResponse.json({ message: "Invalid Brevo webhook token." }, { status: 401 });
  }
  if (auth.warning) {
    // The cut-over's last step is still open: Brevo sends the right Bearer, but its webhook address
    // still has ?token= on it, so the old secret keeps landing in access logs. Take it off the URL.
    logWarning("Accepted a Brevo webhook whose URL still carries ?token=", {
      labels: { event: "webhook_secret_in_url", reason: auth.warning, webhook: "brevo" },
    });
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
