// Recruitment / ATS — a WhatsApp message that cannot be tied to a phone number, RECORDED rather than lost.
//
// WHY THIS EXISTS. A WhatsApp user who adopts a username is identified to a business by a
// business-scoped user id (BSUID, e.g. "EG.13491208655302741918"), and Meta then omits the phone
// number — `from` on the message, `wa_id` on the contact — unless the business exchanged messages
// with that phone in the last 30 days or holds it as a contact. Until 2026-09-15 the parser returned
// null for any message with no `from`, before a single row or log line was written: on 14 Sep 2026 a
// Future Talents intern with a username sent his closing videos and his submission id, and
// production held nothing from him at all.
//
// His videos and typed id now reach the FTP holding tables under the BSUID (the webhook does that
// before this module is ever reached). Everything else from a phone-less sender — a CV, a greeting,
// a tap — has nowhere safe to go: every recruitment path keys a person on a phone number, and several
// of them answer the sender. So it lands HERE, as one ats_cv_intake_events row, and nothing else:
//
//   * no reply. Sending to a BSUID needs Meta's `recipient` field rather than `to`, and on this line
//     the only message an intern may ever receive is the owner's "Thanks, well received. Good luck!".
//     This file imports nothing that can send.
//   * no candidate, no buffer, no classification.
//   * the row is countable: `unattributedSender: true` on raw_metadata, the reason in words on
//     error_message, and existing outcomes only — the outcome column carries a CHECK constraint, and
//     a CV that could not be processed belongs in the CV-bearing count, a text does not.
//
// The same row is written for a message Meta sent with NO usable identity at all (no phone and no
// BSUID) or with no message id, which the parser hands back separately instead of dropping.
//
// Idempotent on (channel, provider_message_id), the unique index every intake event claims through,
// so a Meta redelivery records once. Never throws: the webhook must answer 200 whatever happens here.

import { logError, logWarning } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import type {
  ParsedWhatsAppMessage,
  UnattributedWhatsAppNode,
} from "@/lib/recruitment/inbound/whatsapp-payload-parser";

export type UnattributedWhatsAppSubject =
  // Parsed, with a BSUID, but no phone number to key a person on.
  | { kind: "no_phone"; message: ParsedWhatsAppMessage }
  // Not parseable into a message at all: no sender, or no message id.
  | { kind: "unattributed"; node: UnattributedWhatsAppNode };

export type UnattributedIntakeEvent = {
  channel: "whatsapp";
  outcome: "ignored_no_attachment" | "ignored_unsupported_attachment";
  provider_message_id: string | null;
  sender_identifier: string | null;
  sender_display_name: string | null;
  error_message: string;
  raw_metadata: Record<string, unknown>;
};

const REASON_TEXT = {
  no_message_id: "Meta sent this WhatsApp message without a message id, so it could not be processed. Nothing was sent to the sender.",
  no_phone_number:
    "The sender uses a WhatsApp username and Meta sent no phone number, so this message could not be tied to an applicant. Nothing was sent to the sender.",
  no_sender:
    "Meta sent this WhatsApp message with no sender at all (no phone number and no user id), so it could not be tied to anyone.",
} as const;

// A text body is kept for a human to recognise the message, bounded so a pasted essay cannot bloat
// the row. Cut on a word where one is near.
function boundedBody(body: string | null | undefined, max = 500): string | null {
  const flattened = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!flattened) return null;
  if (flattened.length <= max) return flattened;
  const cut = flattened.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function lineMetadata(input: {
  historical: boolean;
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
}): Record<string, unknown> {
  return {
    // The health check's public-arrival clock skips replays on this flag, exactly as it does for a CV.
    ...(input.historical ? { historyImport: true } : {}),
    ...(input.deliveredToPhoneNumberId ? { deliveredToPhoneNumberId: input.deliveredToPhoneNumberId } : {}),
    ...(input.deliveredToDisplayNumber ? { deliveredToDisplayNumber: input.deliveredToDisplayNumber } : {}),
  };
}

/** The row written for one unattributed message. Pure, so the shape is pinned without a database. */
export function buildUnattributedIntakeEvent(subject: UnattributedWhatsAppSubject): UnattributedIntakeEvent {
  if (subject.kind === "no_phone") {
    const { message } = subject;
    const media = message.document ?? message.video;
    return {
      channel: "whatsapp",
      error_message: REASON_TEXT.no_phone_number,
      outcome: media ? "ignored_unsupported_attachment" : "ignored_no_attachment",
      provider_message_id: message.wamid,
      raw_metadata: {
        unattributedSender: true,
        reason: "no_phone_number",
        messageType: message.messageType,
        userId: message.userId,
        ...(message.username ? { username: message.username } : {}),
        ...(message.text ? { body: boundedBody(message.text) } : {}),
        ...(media?.filename ? { filename: media.filename } : {}),
        ...(media?.caption ? { caption: boundedBody(media.caption) } : {}),
        ...(message.sentAt ? { sentAt: message.sentAt } : {}),
        ...(message.forwarded ? { forwarded: true } : {}),
        ...lineMetadata(message),
      },
      sender_display_name: message.contactName,
      sender_identifier: message.userId,
    };
  }

  const { node } = subject;
  return {
    channel: "whatsapp",
    error_message: REASON_TEXT[node.reason],
    outcome: node.hasMedia ? "ignored_unsupported_attachment" : "ignored_no_attachment",
    provider_message_id: node.wamid,
    raw_metadata: {
      unattributedSender: true,
      reason: node.reason,
      messageType: node.messageType,
      ...(node.userId ? { userId: node.userId } : {}),
      ...(node.username ? { username: node.username } : {}),
      ...(node.from ? { wa_id: node.from } : {}),
      ...(node.sentAt ? { sentAt: node.sentAt } : {}),
      ...lineMetadata(node),
    },
    sender_display_name: node.contactName,
    sender_identifier: node.userId ?? (node.from ? `+${node.from}` : null),
  };
}

export type UnattributedRecordOutcome = "recorded" | "duplicate" | "failed";

/** Writes the row. Never throws; a failure is logged loudly, because it is the last trace of the message. */
export async function recordUnattributedWhatsAppMessage(
  subject: UnattributedWhatsAppSubject,
): Promise<{ outcome: UnattributedRecordOutcome }> {
  const event = buildUnattributedIntakeEvent(subject);
  const labels = {
    event: "whatsapp_unattributed_message",
    messageType: String(event.raw_metadata.messageType ?? "unknown"),
    reason: String(event.raw_metadata.reason ?? "unknown"),
    wamid: event.provider_message_id ?? "(none)",
  };
  try {
    const { error } = await recruitmentDb().from("ats_cv_intake_events").insert(event);
    if (error) {
      if ((error as { code?: string }).code === "23505") return { outcome: "duplicate" };
      logError("Failed to record a WhatsApp message with no phone number", { error, labels });
      return { outcome: "failed" };
    }
    logWarning("Recorded a WhatsApp message that could not be tied to a phone number", { labels });
    return { outcome: "recorded" };
  } catch (error) {
    logError("Recording a WhatsApp message with no phone number threw", { error, labels });
    return { outcome: "failed" };
  }
}
