// Recruitment / ATS — pure WhatsApp Cloud API webhook payload parsing (no I/O). Flattens Meta's
// nested entry[].changes[].value.messages[] structure and matches each message to its sender's
// self-reported profile name via the sibling contacts[] array (matched by wa_id).
//
// Only `type: "document"` messages carry a CV candidate — the actual media download (async,
// Graph API) happens separately (whatsapp-media.ts, called from the webhook route) so this
// module stays pure and unit-testable with plain fixture objects. Non-document messages (text,
// image, audio, etc.) are still returned here (so the webhook can log/ignore them via the same
// ingestInboundCv path with attachment: null), just without a `document` field.

import type { InboundCvAttachment, InboundCvIntakeInput } from "@/lib/recruitment/inbound/cv-intake-service";

export type ParsedWhatsAppDocument = {
  mediaId: string;
  mimeType: string;
  filename: string | null;
};

export type ParsedWhatsAppMessage = {
  wamid: string;
  from: string; // digits-only, Meta convention (e.g. "201001234567")
  contactName: string | null;
  messageType: string;
  document: ParsedWhatsAppDocument | null;
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
              filename: asString(documentNode?.filename),
              mediaId,
              mimeType: asString(documentNode?.mime_type) ?? "application/octet-stream",
            }
          : null;

        messages.push({
          contactName: contactNameByWaId.get(from) ?? null,
          document,
          from,
          messageType,
          wamid,
        });
      }
    }
  }

  return messages;
}

/**
 * Turns a parsed message plus its already-downloaded attachment (or null, for a non-document
 * message / a download that failed) into an inbound-CV-intake input. Pure — the caller has
 * already done any async media download.
 */
export function buildWhatsAppIntakeInput(
  message: ParsedWhatsAppMessage,
  attachment: InboundCvAttachment | null,
): Omit<InboundCvIntakeInput, "channel"> {
  const phone = `+${message.from}`;
  const fullName = message.contactName || `WhatsApp Applicant (${phone})`;

  return {
    attachment,
    candidate: { email: null, fullName, notes: null, phone },
    providerMessageId: message.wamid,
    rawMetadata: { messageType: message.messageType, wa_id: message.from },
    senderDisplayName: message.contactName,
    senderIdentifier: phone,
  };
}
