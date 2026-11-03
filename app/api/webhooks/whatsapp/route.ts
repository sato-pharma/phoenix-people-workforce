import { NextResponse } from "next/server";

import { applyApprovalsLineStatuses } from "@/lib/approvals/urgent-whatsapp-log";
import { splitApprovalsLineDelivery } from "@/lib/approvals/urgent-whatsapp-rules";
import { logError, logInfo, logWarning } from "@/lib/observability/log";
import {
  assembleWhatsAppSourceContext,
  MAX_WHATSAPP_SOURCE_MESSAGES,
  type WhatsAppSourceContext,
} from "@/lib/recruitment/candidate-source-context";
import { enqueueInbound, type WhatsAppQueuePayload } from "@/lib/recruitment/inbound/intake-queue";
import {
  handleClassifyReply,
  handleClassifyText,
  startClassification,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { bufferWhatsAppMessage, takeRecentWhatsAppMessages } from "@/lib/recruitment/inbound/whatsapp-message-buffer";
import {
  handleExtraQuestionReply,
  handleExtraQuestionText,
} from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import { handleTextOnlyMessage } from "@/lib/recruitment/inbound/whatsapp-text-only-applicant";
import {
  isWhatsAppImportSender,
  parseWhatsAppImportSenders,
  parseWhatsAppWebhookDelivery,
  type ParsedWhatsAppMessage,
} from "@/lib/recruitment/inbound/whatsapp-payload-parser";
import { recordUnattributedWhatsAppMessage } from "@/lib/recruitment/inbound/whatsapp-unattributed-sender";
import { verifyWhatsAppWebhookHandshake, verifyWhatsAppWebhookSignature } from "@/lib/recruitment/inbound/whatsapp-webhook-events";
import { approvalsLinePhoneNumberId } from "@/lib/whatsapp-inbox/lines";
import { recordInboxDelivery } from "@/lib/whatsapp-inbox/record";
import { extractFtpSubmissionIds } from "@/lib/whatsapp-videos/handoff-contract";
import { captureInboundSubmissionId, captureInboundVideo } from "@/lib/whatsapp-videos/inbox";

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
// (startClassification skips import senders and history replays), so this is a bound on the tail case,
// not a limit anyone reaches in normal traffic. Anything over the budget is simply not asked; the
// CV itself is unaffected because it was already enqueued.
const MAX_CLASSIFY_PROMPTS_PER_DELIVERY = 3;

// One queue-payload shape for both CV branches below, so a username sender's row cannot drift from a
// phone sender's. `from` is null for a username sender; userId and username are null for a phone
// sender who has none.
function cvQueuePayload(
  message: ParsedWhatsAppMessage,
  document: NonNullable<ParsedWhatsAppMessage["document"]>,
  sourceContext: WhatsAppSourceContext | null,
): WhatsAppQueuePayload {
  return {
    caption: document.caption,
    contactName: message.contactName,
    deliveredToDisplayNumber: message.deliveredToDisplayNumber,
    deliveredToPhoneNumberId: message.deliveredToPhoneNumberId,
    filename: document.filename,
    forwarded: message.forwarded,
    from: message.from,
    historical: message.historical,
    kind: "whatsapp",
    mediaId: document.mediaId,
    messageType: message.messageType,
    mimeType: document.mimeType,
    sourceContext,
    userId: message.userId,
    username: message.username,
    wamid: message.wamid,
  };
}

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

  // 🔴 THE THIRD NUMBER LEAVES BEFORE ANYTHING READS THE DELIVERY (owner, 3 Nov 2026). The approval reminders' number
  // does not read replies, and the inbox below files every line it is handed, so a reply left in would reach HR
  // Resourcing, the applicant bot and Talent Acquisition. Per change, not per delivery: the number sits under the
  // recruitment business account, so an applicant's CV can arrive in the same delivery and must still go through.
  const approvalsLine = splitApprovalsLineDelivery(payload, approvalsLinePhoneNumberId());
  payload = approvalsLine.payload;
  if (approvalsLine.droppedChanges > 0) {
    logInfo("WhatsApp delivery on the approvals line was dropped", {
      context: { messages: approvalsLine.droppedMessages, statuses: approvalsLine.statuses.length },
      labels: { event: "whatsapp_approvals_line_dropped", webhook: "whatsapp" },
    });
    await applyApprovalsLineStatuses(approvalsLine.statuses);
  }

  // THE WHATSAPP INBOX KEEPS ITS OWN COPY, FIRST. Every message on both numbers — from the person,
  // echoed from the handset, replayed from the phone's history — plus the delivery ticks on what we
  // sent. It runs before the recruitment pipeline below so a slow CV intake can never cost the inbox a
  // message, and it never throws: the inbox is a record, and a record failing must not make Meta
  // redeliver (or disable) the webhook the recruitment line depends on.
  const inbox = await recordInboxDelivery(payload).catch((inboxError: unknown) => {
    logError("WhatsApp Inbox failed to record a webhook delivery", {
      error: inboxError,
      labels: { event: "whatsapp_inbox_record_threw", webhook: "whatsapp" },
    });
    return null;
  });

  // `unattributed` holds the nodes with no message id or no sender at all. They are recorded after the
  // loop below — never silently dropped, which is how a username sender's videos vanished on 14 Sep.
  const delivery = parseWhatsAppWebhookDelivery(payload);
  const messages = delivery.messages;
  const importSenders = parseWhatsAppImportSenders(process.env.RECRUITMENT_WHATSAPP_IMPORT_SENDERS);
  const outcomes: Array<{ wamid: string | null; outcome: string }> = [];
  let classifyPromptsSent = 0;
  // Bounded exactly like classifyPromptsSent, and for the same reason: each reply is a Graph round
  // trip inside a request whose job is to ack fast.
  let textOnlyRepliesSent = 0;

  // (The text-buffer retention sweep runs on the inbound-intake cron tick now, not here — keeping
  // the webhook's work minimal so it acks even faster.)

  // Resolve to 200 quickly. Each message is either buffered (text) or enqueued (a CV document);
  // the enqueue is idempotent on the wamid, so a Meta retry of the whole payload is safe.
  for (const message of messages) {
    try {
      // A tap on one of our own interactive menus. Handled before anything else: it carries no text
      // and no document, so it would otherwise fall through to "ignored" and the applicant's answer
      // would be dropped silently. Never throws — a failed answer must not fail the delivery.
      // A username sender with no phone is keyed on their user id (BSUID) — the menus were sent to it.
      const conversationKey = message.from ?? message.userId;
      if (message.interactiveReplyId && conversationKey && !message.historical) {
        const replyOutcome = await handleClassifyReply({
          phoneNumberId: message.deliveredToPhoneNumberId,
          rowId: message.interactiveReplyId,
          waId: conversationKey,
        }).catch((replyError) => {
          logError("WhatsApp classification reply handling threw", {
            error: replyError,
            labels: { event: "whatsapp_classify_reply_threw", wamid: message.wamid },
          });
          return "no_session" as const;
        });
        // "not_ours" means the row id was not one of the fixed six's three-part ids — tried next as
        // an admin-defined extra question (a four-part id). The two namespaces never both match, so
        // this never double-handles a tap the fixed six already own.
        if (replyOutcome === "not_ours") {
          const extraReplyOutcome = await handleExtraQuestionReply({
            phoneNumberId: message.deliveredToPhoneNumberId,
            rowId: message.interactiveReplyId,
            waId: conversationKey,
          }).catch((extraError) => {
            logError("WhatsApp screening extra-question reply handling threw", {
              error: extraError,
              labels: { event: "whatsapp_extra_question_reply_threw", wamid: message.wamid },
            });
            return "no_session" as const;
          });
          outcomes.push({ outcome: `extra_${extraReplyOutcome}`, wamid: message.wamid });
          continue;
        }
        outcomes.push({ outcome: `classify_${replyOutcome}`, wamid: message.wamid });
        continue;
      }

      // A FUTURE TALENTS SUBMISSION ID ("FTP-12345678"), which interns type next to their closing
      // videos. Kept for the FTP Portal, which uses it to tell whose videos a chat holds, and then
      // dropped from this pipeline: no classification, no buffer, no notification, and no reply here —
      // the owner's thank-you is sent by the inbound-intake cron after the videos (whatsapp-videos/thanks).
      //
      // 🔴 IT MUST BE HANDLED BEFORE handleClassifyText, THE BUFFER AND THE TEXT-ONLY BRANCH. Without
      // it the id is a text from a sender with no CV on file, so the intern is answered "please send
      // your CV as a file" and Talent Acquisition is told an applicant wrote in. Narrow by
      // construction — extractFtpSubmissionIds needs the FTP prefix and exactly eight digits — so no
      // applicant's message is taken on a guess. A history replay is kept too, flagged, because an id
      // typed weeks ago still says who sent the videos beside it.
      if (message.text && !message.document) {
        const submissionIds = extractFtpSubmissionIds(message.text);
        if (submissionIds.length > 0) {
          const captured = await captureInboundSubmissionId({
            contactName: message.contactName,
            deliveredToDisplayNumber: message.deliveredToDisplayNumber,
            deliveredToPhoneNumberId: message.deliveredToPhoneNumberId,
            historical: message.historical,
            sentAt: message.sentAt,
            submissionIds,
            // A username sender may have no phone number: the BSUID keys the id instead, and the
            // portal matches that sender by the id they typed.
            userId: message.userId,
            username: message.username,
            waId: message.from,
            wamid: message.wamid,
          });
          outcomes.push({ outcome: `submission_id_${captured.outcome}`, wamid: message.wamid });
          continue;
        }
      }

      // A VIDEO. Captured into its own holding table and then dropped from this pipeline entirely —
      // no queue row, no candidate, no notification. Its one reply, the owner's thank-you, is sent by
      // the inbound-intake cron once the sender has finished (whatsapp-videos/thanks) — never from here.
      //
      // 🔴 IT MUST BE HANDLED BEFORE THE BUFFER, THE NO-PHONE RECORD AND THE TEXT-ONLY BRANCH BELOW,
      // and the ordering is the whole point of this block rather than a style preference. A video
      // carries no `document`, so without this it falls into handleTextOnlyMessage, where the guard
      // table splits it two ways and both are wrong: a REPLAYED video hits the `historical` rung and is
      // discarded with no record at all, and a LIVE video hits `new_contact` — so the sender is
      // answered "please send your CV as a file" and Talent Acquisition is notified. The senders are
      // the company's own interns sending their closing videos, so that second path means messaging
      // twenty-nine of them to ask for a job application they never made. A username sender with no
      // phone is captured here too, under the BSUID.
      //
      // Best-effort like everything else here: a capture failure is logged and reported in the
      // outcome, never raised, because a non-200 makes Meta retry the whole payload.
      if (message.video) {
        const captured = await captureInboundVideo({
          caption: message.video.caption,
          contactName: message.contactName,
          deliveredToDisplayNumber: message.deliveredToDisplayNumber,
          deliveredToPhoneNumberId: message.deliveredToPhoneNumberId,
          fileName: message.video.filename,
          historical: message.historical,
          mediaId: message.video.mediaId,
          mimeType: message.video.mimeType,
          sentAt: message.sentAt,
          userId: message.userId,
          username: message.username,
          waId: message.from,
          wamid: message.wamid,
        });
        outcomes.push({ outcome: `video_${captured.outcome}`, wamid: message.wamid });
        continue;
      }

      // A SENDER WITH NO PHONE NUMBER (a WhatsApp username, and Meta did not share the phone). Its
      // videos and typed submission id were kept above.
      //
      // A CV is QUEUED for intake like any other (owner decision, 15 Sep 2026), and the worker builds
      // the candidate from what the CV says, because there is no number to trust. It is never
      // classified, buffered or answered: those paths key a person on a phone number and message
      // them, and the owner decided the same day that a username sender is sent nothing. The caption
      // alone is the source context, since the text buffer is keyed on a phone number too.
      //
      // 🔴 A CV FROM A USERNAME SENDER NOW OPENS THE QUESTIONS (owner, 20 Oct 2026: a woman who wrote
      // to the HR line from a username was never asked anything). The conversation is keyed on the
      // user id (BSUID) instead of a phone, every send addresses it through Meta's `recipient` field
      // (whatsapp-recipient.ts), and her taps and typed answers come back here keyed the same way. The
      // 15 Sep "sent nothing" decision was about interns, whose videos and submission ids are taken
      // above and never reach this point; only a CV document opens a conversation.
      //
      // Everything else — a greeting, a tap with no conversation — is RECORDED as one intake event and
      // goes no further. Never throws.
      if (!message.from) {
        if (message.document) {
          let sourceContext: WhatsAppSourceContext | null = null;
          try {
            sourceContext = assembleWhatsAppSourceContext(message.document.caption, []);
          } catch (contextError) {
            logError("WhatsApp source-context assembly failed", {
              error: contextError,
              labels: { event: "whatsapp_source_context_failed", wamid: message.wamid },
            });
          }
          const { enqueued } = await enqueueInbound({
            channel: "whatsapp",
            payload: cvQueuePayload(message, message.document, sourceContext),
            providerMessageId: message.wamid,
            source: "whatsapp_webhook",
          });
          if (enqueued && message.userId && classifyPromptsSent < MAX_CLASSIFY_PROMPTS_PER_DELIVERY) {
            const classifyOutcome = await startClassification({
              cvWamid: message.wamid,
              historical: message.historical,
              isImportSender: false,
              phoneNumberId: message.deliveredToPhoneNumberId,
              waId: message.userId,
            });
            if (classifyOutcome === "asked" || classifyOutcome === "reasked") classifyPromptsSent += 1;
          }
          outcomes.push({ outcome: enqueued ? "no_phone_cv_enqueued" : "no_phone_cv_duplicate", wamid: message.wamid });
          continue;
        }
        // A typed answer from a username sender who is mid-conversation — their salary, an "Other".
        if (message.text && message.userId && !message.historical) {
          const typed = await handleClassifyText({
            phoneNumberId: message.deliveredToPhoneNumberId,
            text: message.text,
            waId: message.userId,
          }).catch(() => "no_session" as const);
          if (typed === "advanced" || typed === "unusable_text") {
            outcomes.push({ outcome: `classify_${typed}`, wamid: message.wamid });
            continue;
          }
          if (typed === "not_awaiting_text") {
            const extraTyped = await handleExtraQuestionText({
              phoneNumberId: message.deliveredToPhoneNumberId,
              text: message.text,
              waId: message.userId,
            }).catch(() => "no_session" as const);
            if (extraTyped === "advanced" || extraTyped === "unusable_text" || extraTyped === "completed") {
              outcomes.push({ outcome: `extra_${extraTyped}`, wamid: message.wamid });
              continue;
            }
          }
        }
        const recorded = await recordUnattributedWhatsAppMessage({ kind: "no_phone", message });
        outcomes.push({ outcome: `no_phone_${recorded.outcome}`, wamid: message.wamid });
        continue;
      }

      // A typed answer to an escape row — any of the three questions since 2026-08-28. Checked
      // BEFORE buffering, because this text is the applicant's answer to a question we asked, not
      // context about their CV, and filing it as context would both lose the answer and staple a
      // job title onto the next document they send.
      //
      // Narrow on purpose, and the narrowing lives in `handleClassifyText`, not here: it acts only
      // when this sender has an open conversation parked on one of the typed-answer steps (an "Other"
      // follow-up, or the expected-salary question), and returns `not_awaiting_text` for everything
      // else, which falls through to the buffer exactly as before. Keeping the step list in one place
      // is why adding the screening questions needed no change on this side. A message carrying a
      // document is excluded outright — that is a CV with a caption, never an answer.
      if (message.text && !message.document && !message.historical) {
        const textOutcome = await handleClassifyText({
          phoneNumberId: message.deliveredToPhoneNumberId,
          text: message.text,
          waId: message.from,
        }).catch((textError) => {
          logError("WhatsApp classification text handling threw", {
            error: textError,
            labels: { event: "whatsapp_classify_text_threw", wamid: message.wamid },
          });
          return "no_session" as const;
        });
        if (textOutcome === "advanced" || textOutcome === "unusable_text") {
          outcomes.push({ outcome: `classify_${textOutcome}`, wamid: message.wamid });
          continue;
        }
        // "not_awaiting_text" means the fixed six have no open free-text step for this sender — tried
        // next as an admin-defined free-text question. Anything neither owns falls through to the
        // existing buffering behaviour below, unchanged.
        if (textOutcome === "not_awaiting_text") {
          const extraTextOutcome = await handleExtraQuestionText({
            phoneNumberId: message.deliveredToPhoneNumberId,
            text: message.text,
            waId: message.from,
          }).catch((extraError) => {
            logError("WhatsApp screening extra-question text handling threw", {
              error: extraError,
              labels: { event: "whatsapp_extra_question_text_threw", wamid: message.wamid },
            });
            return "no_session" as const;
          });
          if (
            extraTextOutcome === "advanced" ||
            extraTextOutcome === "unusable_text" ||
            extraTextOutcome === "completed"
          ) {
            outcomes.push({ outcome: `extra_${extraTextOutcome}`, wamid: message.wamid });
            continue;
          }
        }
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

      // A message with no document. Until 2026-08-29 this line simply dropped it: buffered above,
      // no queue row, no intake event, nobody told — and the buffer's own 24-hour retention sweep
      // then erased it. That was the single largest loss on this channel. It is now recorded, the
      // applicant is asked for the file, and a human is notified; every guard (import senders, a
      // history replay, someone mid-conversation, a repeat message today) lives in
      // decideTextOnlyAction, not here. Best-effort by construction — this must never turn into a
      // non-200, because Meta would then retry the whole payload and re-ask the same person.
      if (!message.document) {
        const textOnly = await handleTextOnlyMessage({
          body: message.text,
          contactName: message.contactName,
          deliveredToDisplayNumber: message.deliveredToDisplayNumber,
          deliveredToPhoneNumberId: message.deliveredToPhoneNumberId,
          historical: message.historical,
          importSenders,
          repliesSent: textOnlyRepliesSent,
          waId: message.from,
          wamid: message.wamid,
        });
        if (textOnly.asked) textOnlyRepliesSent += 1;
        outcomes.push({ outcome: `text_only_${textOnly.reason}`, wamid: message.wamid });
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
        payload: cvQueuePayload(message, message.document, sourceContext),
        providerMessageId: message.wamid,
        source: "whatsapp_webhook",
      });
      // Ask the applicant what they are applying for. Only on a genuinely new CV: a duplicate is a
      // Meta retry of something already handled, and re-prompting would ask the same person the
      // same question twice.
      if (enqueued && classifyPromptsSent < MAX_CLASSIFY_PROMPTS_PER_DELIVERY) {
        const classifyOutcome = await startClassification({
          cvWamid: message.wamid,
          historical: message.historical,
          isImportSender: isImport,
          phoneNumberId: message.deliveredToPhoneNumberId,
          waId: message.from,
        });
        // A re-ask is a Graph API call like any other, so it spends the same budget. Counting only
        // the first ask would let a payload of CVs from one stalled sender slip past the cap.
        if (classifyOutcome === "asked" || classifyOutcome === "reasked") classifyPromptsSent += 1;
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

  // Nodes with no message id, or with neither a phone number nor a BSUID. Nothing can be done with
  // them, and nothing is sent — but each leaves an intake event, so a delivery can never again be
  // acknowledged with no trace of what it held. Never throws.
  for (const node of delivery.unattributed) {
    const recorded = await recordUnattributedWhatsAppMessage({ kind: "unattributed", node });
    outcomes.push({ outcome: `unattributed_${node.reason}_${recorded.outcome}`, wamid: node.wamid });
  }

  return NextResponse.json({ inbox, ok: true, outcomes });
}
