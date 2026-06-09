import { NextResponse } from "next/server";

import { addEmailSuppression } from "@/lib/email/suppression";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auth/password notification types are transactional and must never be unsubscribable.
const nonUnsubscribableTypes = new Set(["password_reset", "user_created", "password_setup"]);

function landingPage(message: string, status: number) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:420px;padding:32px;text-align:center}h1{color:#f97316;font-size:20px;margin:0 0 12px}p{font-size:14px;line-height:1.6;color:#cbd5e1}</style></head><body><main><h1>Phoenix Workforce</h1><p>${message}</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * RFC 8058 one-click unsubscribe. The mailbox provider POSTs here automatically when the
 * recipient clicks "Unsubscribe"; humans land on the GET page. Both verify a signed,
 * expiring token (no session needed) and add a durable suppression. Idempotent.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyUnsubscribeToken(token);
  if (!payload) {
    return NextResponse.json({ error: "invalid_or_expired" }, { status: 410 });
  }
  if (nonUnsubscribableTypes.has(payload.type)) {
    return NextResponse.json({ error: "transactional_not_unsubscribable" }, { status: 400 });
  }
  await addEmailSuppression({ address: payload.addr, reason: "unsubscribe", source: "unsubscribe_endpoint" });
  return NextResponse.json({ ok: true });
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const payload = verifyUnsubscribeToken(token);
  if (!payload) {
    return landingPage("This unsubscribe link is invalid or has expired.", 410);
  }
  if (nonUnsubscribableTypes.has(payload.type)) {
    return landingPage("Account and security emails cannot be unsubscribed.", 400);
  }
  // Honour the click on GET too (some clients only GET), so the recipient is unsubscribed
  // immediately rather than needing a second action.
  await addEmailSuppression({ address: payload.addr, reason: "unsubscribe", source: "unsubscribe_endpoint" });
  return landingPage("You have been unsubscribed from Phoenix Workforce notifications. You will still receive account and security emails.", 200);
}
