// Recruitment / ATS — pure WhatsApp Cloud API webhook payload parsing (no I/O). Flattens Meta's
// nested entry[].changes[].value.messages[] structure and matches each message to its sender's
// self-reported profile name via the sibling contacts[] array (matched by wa_id).
//
// Only `type: "document"` messages carry a CV candidate — the actual media download (async,
// Graph API) happens separately (whatsapp-media.ts, called from the webhook route) so this
// module stays pure and unit-testable with plain fixture objects. Non-document messages (text,
// image, audio, etc.) are still returned here (so the webhook can log/ignore them via the same
// ingestInboundCv path with attachment: null), just without a `document` field.

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
        const documentNode = messageType === "document" ? asRecord(message?.document) : null;
        const mediaId = asString(documentNode?.id);
        const document: ParsedWhatsAppDocument | null = mediaId
          ? {
              caption: asString(documentNode?.caption),
              filename: asString(documentNode?.filename),
              mediaId,
              mimeType: asString(documentNode?.mime_type) ?? "application/octet-stream",
            }
          : null;

        messages.push({
          contactName: contactNameByWaId.get(from) ?? null,
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
