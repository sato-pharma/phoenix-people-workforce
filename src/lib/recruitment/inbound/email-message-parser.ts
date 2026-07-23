// Recruitment / ATS — pure email-message-to-intake mapping (no I/O, no imapflow/mailparser
// runtime dependency beyond the ParsedMail type — safe to unit-test with plain fixture objects).

import type { ParsedMail } from "mailparser";

import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import type { InboundCvAttachment, InboundCvIntakeInput } from "@/lib/recruitment/inbound/cv-intake-service";

function titleCaseFromLocalPart(address: string): string {
  const localPart = address.split("@")[0] ?? address;
  const words = localPart
    .replace(/[._-]+/g, " ")
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : address;
}

function pickCvAttachment(
  attachments: ParsedMail["attachments"] | undefined,
): { attachment: InboundCvAttachment | null; ignoredAttachmentCount: number } {
  const list = attachments ?? [];
  const usable = list.filter((entry) => detectCvFileKind(entry.contentType ?? "", entry.filename ?? "") !== "unsupported");
  if (usable.length === 0) {
    return { attachment: null, ignoredAttachmentCount: list.length };
  }
  const first = usable[0];
  return {
    attachment: {
      bytes: first.content,
      fileName: first.filename?.trim() || "cv",
      mimeType: first.contentType || "application/octet-stream",
    },
    ignoredAttachmentCount: usable.length - 1,
  };
}

/**
 * Maps a parsed email (mailparser's ParsedMail) plus which mailbox/UID it came from into an
 * inbound-CV-intake input (minus `channel`, which the caller — the IMAP poller — already knows
 * is `"email"`). Pure and defensive: a message with no From header, no attachments, or no
 * Message-ID still produces a valid result rather than throwing.
 */
export function parseInboundEmailMessage(
  mail: ParsedMail,
  context: { mailboxLabel: string; uid: number },
): Omit<InboundCvIntakeInput, "channel"> {
  const fromEntry = Array.isArray(mail.from?.value) ? mail.from.value[0] : undefined;
  const email = fromEntry?.address?.trim().toLowerCase() || null;
  const displayName = fromEntry?.name?.trim() || null;
  const fullName = displayName || (email ? titleCaseFromLocalPart(email) : "Unknown Applicant");

  const { attachment, ignoredAttachmentCount } = pickCvAttachment(mail.attachments);
  const notes = (mail.text ?? "").trim().slice(0, 500) || null;
  const providerMessageId = mail.messageId?.trim() || `email:${context.mailboxLabel}:uid:${context.uid}`;

  return {
    attachment,
    candidate: { email, fullName, notes, phone: null },
    mailboxLabel: context.mailboxLabel,
    providerMessageId,
    providerUid: String(context.uid),
    rawMetadata: {
      from: email,
      ...(ignoredAttachmentCount > 0 ? { ignoredAttachmentCount } : {}),
    },
    senderDisplayName: displayName,
    senderIdentifier: email ?? fullName,
    subject: mail.subject?.trim() || null,
  };
}
