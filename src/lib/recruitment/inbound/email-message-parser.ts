// Recruitment / ATS — pure email-message-to-intake mapping (no I/O, no imapflow/mailparser
// runtime dependency beyond the ParsedMail type — safe to unit-test with plain fixture objects).

import type { ParsedMail } from "mailparser";

import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { nameFromAttachmentFilename, parseImportSenderList } from "@/lib/recruitment/inbound/cv-import-shared";
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
  const usable = list.filter((entry) => {
    // Now that scanned/photographed CVs (image kind) are genuinely supported (OpenAI vision),
    // an inline/embedded image — mailparser's `related: true`, e.g. an email signature logo
    // referenced via cid: in the HTML body — must be excluded explicitly, or every email with
    // a signature logo would be mistaken for a photographed CV.
    if (entry.related) return false;
    return detectCvFileKind(entry.contentType ?? "", entry.filename ?? "") !== "unsupported";
  });
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

/** Splits the configured comma-separated import-sender list (env var) into entries. */
export const parseEmailImportSenders = parseImportSenderList;

/**
 * Whether this message came from an address configured as a bulk CV import source (an old
 * mailbox being migrated in), rather than a direct applicant emailing the recruitment mailbox.
 * Case-insensitive — email addresses are.
 */
export function isEmailImportSender(email: string | null, importSenders?: readonly string[]): boolean {
  if (!email) return false;
  const sender = email.trim().toLowerCase();
  if (!sender) return false;
  return (importSenders ?? []).some((entry) => entry.trim().toLowerCase() === sender);
}

/**
 * Maps a parsed email (mailparser's ParsedMail) plus which mailbox/UID it came from into an
 * inbound-CV-intake input (minus `channel`, which the caller — the IMAP poller — already knows
 * is `"email"`). Pure and defensive: a message with no From header, no attachments, or no
 * Message-ID still produces a valid result rather than throwing.
 *
 * `options.importSenders` lists addresses whose messages are bulk CV imports rather than direct
 * applications — an old careers mailbox being forwarded in. Forwarding an email replaces the
 * From header with the forwarder's own address (the original applicant's address only survives,
 * unreliably, inside the quoted body text), so trusting it here would collapse every forwarded
 * CV onto one candidate — the same failure the WhatsApp import path exists to avoid. For those
 * senders no identity is taken from the message at all; intake reads the CV instead
 * (identitySource: "cv").
 */
export function parseInboundEmailMessage(
  mail: ParsedMail,
  context: { mailboxLabel: string; uid: number },
  options?: { importSenders?: readonly string[] },
): Omit<InboundCvIntakeInput, "channel"> {
  const fromEntry = Array.isArray(mail.from?.value) ? mail.from.value[0] : undefined;
  const email = fromEntry?.address?.trim().toLowerCase() || null;
  const displayName = fromEntry?.name?.trim() || null;

  const { attachment, ignoredAttachmentCount } = pickCvAttachment(mail.attachments);
  const notes = (mail.text ?? "").trim().slice(0, 500) || null;
  const providerMessageId = mail.messageId?.trim() || `email:${context.mailboxLabel}:uid:${context.uid}`;
  const isImport = isEmailImportSender(email, options?.importSenders);
  const rawMetadata: Record<string, unknown> = {
    from: email,
    ...(ignoredAttachmentCount > 0 ? { ignoredAttachmentCount } : {}),
    ...(isImport ? { bulkImport: true } : {}),
  };

  // senderIdentifier stays the forwarding address either way — it genuinely transmitted this
  // message, and the intake-events log needs it to trace an import back to its source.
  if (isImport) {
    return {
      attachment,
      candidate: {
        email: null,
        fullName:
          nameFromAttachmentFilename(attachment?.fileName ?? null) ??
          `Email Import (${providerMessageId.replace(/[<>]/g, "").slice(-8)})`,
        notes: null,
        phone: null,
      },
      identitySource: "cv",
      mailboxLabel: context.mailboxLabel,
      providerMessageId,
      providerUid: String(context.uid),
      rawMetadata,
      senderDisplayName: displayName,
      senderIdentifier: email ?? displayName ?? "unknown",
      subject: mail.subject?.trim() || null,
    };
  }

  const fullName = displayName || (email ? titleCaseFromLocalPart(email) : "Unknown Applicant");
  return {
    attachment,
    candidate: { email, fullName, notes, phone: null },
    identitySource: "sender",
    mailboxLabel: context.mailboxLabel,
    providerMessageId,
    providerUid: String(context.uid),
    rawMetadata,
    senderDisplayName: displayName,
    senderIdentifier: email ?? fullName,
    subject: mail.subject?.trim() || null,
  };
}
