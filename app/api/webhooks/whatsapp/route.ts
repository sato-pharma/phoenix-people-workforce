import { NextResponse } from "next/server";

import { logError, logWarning } from "@/lib/observability/log";
import { assembleWhatsAppSourceContext, MAX_WHATSAPP_SOURCE_MESSAGES } from "@/lib/recruitment/candidate-source-context";
import { enqueueInbound } from "@/lib/recruitment/inbound/intake-queue";
import { bufferWhatsAppMessage, takeRecentWhatsAppMessages } from "@/lib/recruitment/inbound/whatsapp-message-buffer";
import {
  isWhatsAppImportSender,
  parseWhatsAppImportSenders,
  parseWhatsAppWebhookPayload,
} from "@/lib/recruitment/inbound/whatsapp-payload-parser";
import { verifyWhatsAppWebhookHandshake, verifyWhatsAppWebhookSignature } from "@/lib/recruitment/inbound/whatsapp-webhook-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The webhook now only ENQUEUES — no media download, no AI — so it acks in well under a second even
// during a bulk-forward burst. That is deliberate: Meta disables a webhook that keeps exceeding its
// short delivery timeout, so doing the heavy work here (the pre-queue design) was a self-inflicted
// Meta-block risk. The durable worker (intake-worker.ts, phoenix-inbound-intake cron) does the
// download + extraction + candidate creation, with retries. 60s is ample headroom for enqueue-only.
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
  const importSenders = parseWhatsAppImportSenders(process.env.RECRUITMENT_WHATSAPP_IMPORT_SENDERS);
  const outcomes: Array<{ wamid: string; outcome: string }> = [];

  // (The text-buffer retention sweep runs on the inbound-intake cron tick now, not here — keeping
  // the webhook's work minimal so it acks even faster.)

  // Resolve to 200 quickly. Each message is either buffered (text) or enqueued (a CV document);
  // the enqueue is idempotent on the wamid, so a Meta retry of the whole payload is safe.
  for (const message of messages) {
    try {
      // A plain text message is buffered so its first few lines can be shown next to the candidate
      // once their CV document arrives. Buffering is best-effort — never fail the message over it.
      if (message.text) {
        await bufferWhatsAppMessage(message.from, message.text).catch((bufferError) => {
          logError("WhatsApp message buffering failed", {
            error: bufferError,
            labels: { event: "whatsapp_message_buffer_failed", wamid: message.wamid },
          });
        });
      }

      // Only a CV-carrying document is queued for processing. A message with no document is
      // ignored here (no queue row, no event) — text is already buffered above.
      if (!message.document) {
        outcomes.push({ outcome: message.text ? "buffered" : "ignored", wamid: message.wamid });
        continue;
      }

      // Snapshot the source context NOW (caption + the sender's preceding messages), so it reflects
      // what was true when the CV arrived — not minutes later when the worker runs. Preceding
      // messages are skipped for a bulk forward-import (they belong to the forwarder, not the
      // applicant); the per-CV caption is still kept. Best-effort.
      const isImport = isWhatsAppImportSender(message.from, importSenders);
      let sourceContext = null;
      try {
        const buffered = isImport ? [] : await takeRecentWhatsAppMessages(message.from, MAX_WHATSAPP_SOURCE_MESSAGES);
        sourceContext = assembleWhatsAppSourceContext(message.document.caption, buffered);
      } catch (contextError) {
        logError("WhatsApp source-context assembly failed", {
          error: contextError,
          labels: { event: "whatsapp_source_context_failed", wamid: message.wamid },
        });
      }

      const { enqueued } = await enqueueInbound({
        channel: "whatsapp",
        payload: {
          caption: message.document.caption,
          contactName: message.contactName,
          deliveredToDisplayNumber: message.deliveredToDisplayNumber,
          deliveredToPhoneNumberId: message.deliveredToPhoneNumberId,
          filename: message.document.filename,
          forwarded: message.forwarded,
          from: message.from,
          kind: "whatsapp",
          mediaId: message.document.mediaId,
          messageType: message.messageType,
          mimeType: message.document.mimeType,
          sourceContext,
          wamid: message.wamid,
        },
        providerMessageId: message.wamid,
        source: "whatsapp_webhook",
      });
      outcomes.push({ outcome: enqueued ? "enqueued" : "duplicate", wamid: message.wamid });
    } catch (error) {
      // A failed enqueue is the only thing that could lose a message now. Log it loudly; returning
      // non-200 would make Meta retry the whole payload (safe — enqueue is idempotent).
      logError("WhatsApp webhook failed to enqueue a message", {
        error,
        labels: { event: "whatsapp_enqueue_failed", wamid: message.wamid },
      });
      outcomes.push({ outcome: "error", wamid: message.wamid });
    }
  }

  return NextResponse.json({ ok: true, outcomes });
}
