// Recruitment / ATS — pure WhatsApp Cloud API webhook payload parsing (no I/O). Flattens Meta's
// nested entry[].changes[].value.messages[] structure and matches each message to its sender's
// self-reported profile name via the sibling contacts[] array (matched by wa_id).
//
// A CV arrives as a `type: "document"` message OR a `type: "image"` message — applicants very
// commonly PHOTOGRAPH their CV rather than attach a file, and the downstream vision path reads
// images natively. Both carry a downloadable media id (the actual download happens later in the
// worker), so both produce a `document` ref here; an image simply has no filename. Other message
// types (text, audio, video, …) carry no `document` and are ignored by the webhook.

import { normalizePhone } from "@/lib/recruitment/candidate-matching";
import { nameFromAttachmentFilename, parseImportSenderList } from "@/lib/recruitment/inbound/cv-import-shared";
import type { InboundCvAttachment, InboundCvIntakeInput } from "@/lib/recruitment/inbound/cv-intake-service";

export type ParsedWhatsAppDocument = {
  mediaId: string;
  mimeType: string;
  filename: string | null;
  // The caption typed on the document itself, if any (Meta puts it on the media node). Shown as
  // part of the candidate's "source" context.
  caption: string | null;
};

export type ParsedWhatsAppMessage = {
  wamid: string;
  from: string; // digits-only, Meta convention (e.g. "201001234567")
  contactName: string | null;
  messageType: string;
  document: ParsedWhatsAppDocument | null;
  // For a plain "text" message, its body — buffered per sender so the first few messages can be
  // shown next to the candidate once their CV document arrives. Null for non-text messages.
  text: string | null;
  // Meta sets context.forwarded on a forwarded message. Captured for the audit trail only —
  // import routing keys off the configured sender allowlist below, which does not depend on
  // Meta populating this field.
  forwarded: boolean;
  // The BUSINESS number this message was delivered TO (Meta's value.metadata). Once more than one
  // intake line feeds the same webhook (e.g. a second HR number in coexistence mode), this is the
  // only thing that tells apart which line a CV arrived on — the sender/from is the applicant, not
  // the receiving number. Null when Meta omits metadata (older payload shapes / test fixtures).
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseWhatsAppWebhookPayload(payload: unknown): ParsedWhatsAppMessage[] {
  const messages: ParsedWhatsAppMessage[] = [];
  const root = asRecord(payload);
  const entries = Array.isArray(root?.entry) ? root!.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry)?.changes) ? (asRecord(entry)!.changes as unknown[]) : [];
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;

      // Which business line this batch was delivered to. Meta puts it once per change, so it
      // applies to every message in this value block.
      const metadata = asRecord(value.metadata);
      const deliveredToPhoneNumberId = asString(metadata?.phone_number_id);
      const deliveredToDisplayNumber = asString(metadata?.display_phone_number);

      const contactNameByWaId = new Map<string, string>();
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const contact of contacts) {
        const contactRecord = asRecord(contact);
        const waId = asString(contactRecord?.wa_id);
        const name = asString(asRecord(contactRecord?.profile)?.name);
        if (waId && name) contactNameByWaId.set(waId, name);
      }

      const rawMessages = Array.isArray(value.messages) ? value.messages : [];
      for (const raw of rawMessages) {
        const message = asRecord(raw);
        const wamid = asString(message?.id);
        const from = asString(message?.from);
        if (!wamid || !from) continue;

        const messageType = asString(message?.type) ?? "unknown";
        // A document OR an image (photographed CV) both carry a CV. The image node has the same
        // id/mime_type/caption shape as document, just no filename.
        const mediaNode =
          messageType === "document"
            ? asRecord(message?.document)
            : messageType === "image"
              ? asRecord(message?.image)
              : null;
        const mediaId = asString(mediaNode?.id);
        const document: ParsedWhatsAppDocument | null = mediaId
          ? {
              caption: asString(mediaNode?.caption),
              filename: asString(mediaNode?.filename),
              mediaId,
              mimeType: asString(mediaNode?.mime_type) ?? "application/octet-stream",
            }
          : null;

        messages.push({
          contactName: contactNameByWaId.get(from) ?? null,
          deliveredToDisplayNumber,
          deliveredToPhoneNumberId,
          document,
          forwarded: asRecord(message?.context)?.forwarded === true,
          from,
          messageType,
          text: messageType === "text" ? asString(asRecord(message?.text)?.body) : null,
          wamid,
        });
      }
    }
  }

  return messages;
}

/** Splits the configured comma-separated import-sender list (env var) into entries. */
export const parseWhatsAppImportSenders = parseImportSenderList;

// Last 9 significant digits, so a number configured in local form (01001234567) still matches
// the international form Meta reports (201001234567). Being format-tolerant matters here: a
// silently non-matching entry would send an entire bulk import down the normal sender path and
// merge every forwarded CV onto one candidate — the exact failure this feature exists to avoid.
function phoneTail(value: string): string | null {
  const digits = normalizePhone(value)?.replace(/^0+/, "") ?? null;
  return digits && digits.length >= 9 ? digits.slice(-9) : null;
}

/**
 * Whether this message came from an account configured as a bulk CV import source (an old
 * WhatsApp being migrated in), rather than from an applicant messaging the business directly.
 */
export function isWhatsAppImportSender(from: string, importSenders?: readonly string[]): boolean {
  const sender = phoneTail(from);
  if (!sender) return false;
  return (importSenders ?? []).some((entry) => phoneTail(entry) === sender);
}

/**
 * Turns a parsed message plus its already-downloaded attachment (or null, for a non-document
 * message / a download that failed) into an inbound-CV-intake input. Pure — the caller has
 * already done any async media download.
 *
 * `options.importSenders` lists accounts whose messages are bulk CV imports rather than direct
 * applications. For those, the sender describes the person doing the forwarding, so no identity
 * is taken from it at all and intake reads the CV instead (identitySource: "cv").
 */
export function buildWhatsAppIntakeInput(
  message: ParsedWhatsAppMessage,
  attachment: InboundCvAttachment | null,
  options?: { importSenders?: readonly string[] },
): Omit<InboundCvIntakeInput, "channel"> {
  const phone = `+${message.from}`;
  const isImport = isWhatsAppImportSender(message.from, options?.importSenders);
  const rawMetadata: Record<string, unknown> = {
    messageType: message.messageType,
    wa_id: message.from,
    ...(message.forwarded ? { forwarded: true } : {}),
    ...(isImport ? { bulkImport: true } : {}),
    // Recorded on every intake event so the two lines are distinguishable in the data and a
    // future per-number silence check can query it. Only present when Meta supplied metadata.
    ...(message.deliveredToPhoneNumberId ? { deliveredToPhoneNumberId: message.deliveredToPhoneNumberId } : {}),
    ...(message.deliveredToDisplayNumber ? { deliveredToDisplayNumber: message.deliveredToDisplayNumber } : {}),
  };

  // senderIdentifier stays the forwarding account either way — it is genuinely who transmitted
  // this message, and the intake-events log needs it to trace an import back to its source.
  if (isImport) {
    return {
      attachment,
      candidate: {
        email: null,
        fullName:
          nameFromAttachmentFilename(message.document?.filename ?? null) ??
          `WhatsApp Import (${message.wamid.slice(-8)})`,
        notes: null,
        phone: null,
      },
      identitySource: "cv",
      providerMessageId: message.wamid,
      rawMetadata,
      senderDisplayName: message.contactName,
      senderIdentifier: phone,
    };
  }

  return {
    attachment,
    candidate: { email: null, fullName: message.contactName || `WhatsApp Applicant (${phone})`, notes: null, phone },
    identitySource: "sender",
    providerMessageId: message.wamid,
    rawMetadata,
    senderDisplayName: message.contactName,
    senderIdentifier: phone,
  };
}
