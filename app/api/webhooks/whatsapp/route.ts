import { NextResponse } from "next/server";

import { logError, logWarning } from "@/lib/observability/log";
import { ingestInboundCv } from "@/lib/recruitment/inbound/cv-intake-service";
import { downloadWhatsAppMedia } from "@/lib/recruitment/inbound/whatsapp-media";
import { buildWhatsAppIntakeInput, parseWhatsAppWebhookPayload } from "@/lib/recruitment/inbound/whatsapp-payload-parser";
import { verifyWhatsAppWebhookHandshake, verifyWhatsAppWebhookSignature } from "@/lib/recruitment/inbound/whatsapp-webhook-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Meta's one-time webhook verification handshake — dormant (403s) until WHATSAPP_WEBHOOK_VERIFY_TOKEN
// is configured and the same value is entered into the Meta App dashboard's webhook config.
export async function GET(request: Request) {
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    return NextResponse.json({ message: "WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured." }, { status: 500 });
  }
  const url = new URL(request.url);
  const challenge = verifyWhatsAppWebhookHandshake({
    challenge: url.searchParams.get("hub.challenge"),
    mode: url.searchParams.get("hub.mode"),
    token: url.searchParams.get("hub.verify_token"),
    verifyToken,
  });
  if (challenge === null) {
    logWarning("Rejected WhatsApp webhook verification handshake", {
      labels: { event: "webhook_handshake_invalid", webhook: "whatsapp" },
    });
    return NextResponse.json({ message: "Verification failed." }, { status: 403 });
  }
  return new NextResponse(challenge, { headers: { "Content-Type": "text/plain" }, status: 200 });
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    logWarning("WhatsApp webhook received but WHATSAPP_APP_SECRET is not configured", {
      labels: { event: "webhook_misconfigured", webhook: "whatsapp" },
    });
    return NextResponse.json({ message: "WHATSAPP_APP_SECRET is not configured." }, { status: 500 });
  }

  const body = await request.text();
  if (!verifyWhatsAppWebhookSignature({ body, header: request.headers.get("x-hub-signature-256"), secret })) {
    logWarning("Rejected WhatsApp webhook with an invalid signature", {
      labels: { event: "webhook_signature_invalid", webhook: "whatsapp" },
    });
    return NextResponse.json({ message: "Invalid WhatsApp webhook signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ message: "Invalid WhatsApp webhook JSON." }, { status: 400 });
  }

  const messages = parseWhatsAppWebhookPayload(payload);
  const outcomes: Array<{ wamid: string; outcome: string }> = [];

  // Always resolve to 200 quickly — Meta retry-storms a webhook that doesn't ack fast, and one
  // message's failure must never block the rest of the batch (each is independently idempotent
  // via ingestInboundCv's provider_message_id claim, so a later retry of the whole payload is safe).
  for (const message of messages) {
    try {
      let downloaded: { bytes: Buffer; mimeType: string } | null = null;
      if (message.document) {
        try {
          downloaded = await downloadWhatsAppMedia(message.document.mediaId);
        } catch (mediaError) {
          logError("WhatsApp media download failed", {
            error: mediaError,
            labels: { event: "whatsapp_media_download_failed", wamid: message.wamid },
          });
        }
      }
      const input = buildWhatsAppIntakeInput(
        message,
        downloaded
          ? { bytes: downloaded.bytes, fileName: message.document?.filename ?? "cv", mimeType: downloaded.mimeType }
          : null,
      );
      const result = await ingestInboundCv({ channel: "whatsapp", ...input });
      outcomes.push({ outcome: result.outcome, wamid: message.wamid });
    } catch (error) {
      logError("WhatsApp inbound CV intake failed for a message", {
        error,
        labels: { event: "whatsapp_intake_failed", wamid: message.wamid },
      });
      outcomes.push({ outcome: "error", wamid: message.wamid });
    }
  }

  return NextResponse.json({ ok: true, outcomes });
}
