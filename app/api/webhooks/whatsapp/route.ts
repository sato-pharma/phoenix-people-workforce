import { NextResponse } from "next/server";

import { logError, logWarning } from "@/lib/observability/log";
import { assembleWhatsAppSourceContext, MAX_WHATSAPP_SOURCE_MESSAGES } from "@/lib/recruitment/candidate-source-context";
import { enqueueInbound } from "@/lib/recruitment/inbound/intake-queue";
import { handleClassifyReply, startClassification } from "@/lib/recruitment/inbound/whatsapp-classify-session";
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

// At most this many self-classification prompts per webhook DELIVERY. Each prompt is one Graph API
// call inside the request, and this file exists to ack fast — a payload carrying many CVs must not
// turn into many serial round trips. A bulk forward is already excluded before any network call
// (startClassification skips forwarded and import senders), so this is a bound on the tail case,
// not a limit anyone reaches in normal traffic. Anything over the budget is simply not asked; the
// CV itself is unaffected because it was already enqueued.
const MAX_CLASSIFY_PROMPTS_PER_DELIVERY = 3;

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
  let classifyPromptsSent = 0;

  // (The text-buffer retention sweep runs on the inbound-intake cron tick now, not here — keeping
  // the webhook's work minimal so it acks even faster.)

  // Resolve to 200 quickly. Each message is either buffered (text) or enqueued (a CV document);
  // the enqueue is idempotent on the wamid, so a Meta retry of the whole payload is safe.
  for (const message of messages) {
    try {
      // A tap on one of our own interactive menus. Handled before anything else: it carries no text
      // and no document, so it would otherwise fall through to "ignored" and the applicant's answer
      // would be dropped silently. Never throws — a failed answer must not fail the delivery.
      if (message.interactiveReplyId && !message.historical) {
        const replyOutcome = await handleClassifyReply({
          phoneNumberId: message.deliveredToPhoneNumberId,
          rowId: message.interactiveReplyId,
          waId: message.from,
        }).catch((replyError) => {
          logError("WhatsApp classification reply handling threw", {
            error: replyError,
            labels: { event: "whatsapp_classify_reply_threw", wamid: message.wamid },
          });
          return "no_session" as const;
        });
        outcomes.push({ outcome: `classify_${replyOutcome}`, wamid: message.wamid });
        continue;
      }

      // A plain text message is buffered so its first few lines can be shown next to the candidate
      // once their CV document arrives. Buffering is best-effort — never fail the message over it.
      // A history replay is excluded: those lines were typed weeks ago, and letting them into the
      // live buffer would staple one applicant's old chat onto the next applicant's CV.
      if (message.text && !message.historical) {
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
      // applicant) and for a history replay (the buffer holds live traffic, not the past); the
      // per-CV caption is still kept either way. Best-effort.
      const isImport = isWhatsAppImportSender(message.from, importSenders);
      let sourceContext = null;
      try {
        const useBuffer = !isImport && !message.historical;
        const buffered = useBuffer ? await takeRecentWhatsAppMessages(message.from, MAX_WHATSAPP_SOURCE_MESSAGES) : [];
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
          historical: message.historical,
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
      // Ask the applicant what they are applying for. Only on a genuinely new CV: a duplicate is a
      // Meta retry of something already handled, and re-prompting would ask the same person the
      // same question twice.
      if (enqueued && classifyPromptsSent < MAX_CLASSIFY_PROMPTS_PER_DELIVERY) {
        const classifyOutcome = await startClassification({
          cvWamid: message.wamid,
          forwarded: message.forwarded,
          historical: message.historical,
          isImportSender: isImport,
          phoneNumberId: message.deliveredToPhoneNumberId,
          waId: message.from,
        });
        if (classifyOutcome === "asked") classifyPromptsSent += 1;
      }

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
