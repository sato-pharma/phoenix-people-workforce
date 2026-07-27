// Recruitment / ATS — pure email-message-to-intake mapping (no I/O, no imapflow/mailparser
// runtime dependency beyond the ParsedMail type — safe to unit-test with plain fixture objects).

import type { ParsedMail } from "mailparser";

import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { extractAllowlistedCvUrl } from "@/lib/recruitment/inbound/cv-link";
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

/**
 * Every usable CV attachment on the message, in order. An inline/embedded image (mailparser's
 * `related: true`, e.g. a signature logo referenced via cid: in the HTML body) is excluded — it is
 * structurally an embedded asset, not a standalone attachment — as is any unsupported file type.
 */
export function pickCvAttachments(attachments: ParsedMail["attachments"] | undefined): InboundCvAttachment[] {
  return (attachments ?? [])
    .filter((entry) => !entry.related && detectCvFileKind(entry.contentType ?? "", entry.filename ?? "") !== "unsupported")
    .map((entry) => ({
      bytes: entry.content,
      fileName: entry.filename?.trim() || "cv",
      mimeType: entry.contentType || "application/octet-stream",
    }));
}

/** First usable attachment + how many further usable attachments were left behind (singular path). */
function pickCvAttachment(
  attachments: ParsedMail["attachments"] | undefined,
): { attachment: InboundCvAttachment | null; ignoredAttachmentCount: number } {
  const usable = pickCvAttachments(attachments);
  return { attachment: usable[0] ?? null, ignoredAttachmentCount: Math.max(0, usable.length - 1) };
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

// The per-message facts that are the SAME across every attachment on that message (identity, notes,
// subject, base id, import flag). Computed once; the per-attachment builder below fans out from it.
type EmailIdentity = {
  email: string | null;
  displayName: string | null;
  notes: string | null;
  isImport: boolean;
  providerMessageIdBase: string;
  subject: string | null;
};

function emailIdentity(
  mail: ParsedMail,
  context: { mailboxLabel: string; uid: number },
  options?: { importSenders?: readonly string[] },
): EmailIdentity {
  const fromEntry = Array.isArray(mail.from?.value) ? mail.from.value[0] : undefined;
  const email = fromEntry?.address?.trim().toLowerCase() || null;
  return {
    displayName: fromEntry?.name?.trim() || null,
    email,
    isImport: isEmailImportSender(email, options?.importSenders),
    notes: (mail.text ?? "").trim().slice(0, 500) || null,
    providerMessageIdBase: mail.messageId?.trim() || `email:${context.mailboxLabel}:uid:${context.uid}`,
    subject: mail.subject?.trim() || null,
  };
}

// Builds ONE intake input for a given attachment + provider-message-id. A bulk forward-import reads
// identity from the CV itself (a forwarded message reports the FORWARDER's address, so trusting the
// sender would collapse every forwarded CV onto one candidate); a direct applicant's own address IS
// their contact detail.
function buildEmailIntakeInput(
  id: EmailIdentity,
  attachment: InboundCvAttachment | null,
  providerMessageId: string,
  context: { mailboxLabel: string; uid: number },
  extraMetadata: Record<string, unknown>,
): Omit<InboundCvIntakeInput, "channel"> {
  const rawMetadata: Record<string, unknown> = {
    from: id.email,
    ...(id.isImport ? { bulkImport: true } : {}),
    ...extraMetadata,
  };

  if (id.isImport) {
    return {
      attachment,
      candidate: {
        email: null,
        fullName:
          nameFromAttachmentFilename(attachment?.fileName ?? null) ??
          `Email Import (${id.providerMessageIdBase.replace(/[<>]/g, "").slice(-8)})`,
        notes: null,
        phone: null,
      },
      identitySource: "cv",
      mailboxLabel: context.mailboxLabel,
      providerMessageId,
      providerUid: String(context.uid),
      rawMetadata,
      senderDisplayName: id.displayName,
      senderIdentifier: id.email ?? id.displayName ?? "unknown",
      subject: id.subject,
    };
  }

  const fullName = id.displayName || (id.email ? titleCaseFromLocalPart(id.email) : "Unknown Applicant");
  return {
    attachment,
    candidate: { email: id.email, fullName, notes: id.notes, phone: null },
    identitySource: "sender",
    mailboxLabel: context.mailboxLabel,
    providerMessageId,
    providerUid: String(context.uid),
    rawMetadata,
    senderDisplayName: id.displayName,
    senderIdentifier: id.email ?? fullName,
    subject: id.subject,
  };
}

/**
 * Maps a parsed email into a single inbound-CV-intake input (the FIRST usable attachment). Kept for
 * back-compat and for the shared per-message identity logic; the durable worker uses the plural
 * `parseInboundEmailMessages` so a mail with several CVs produces several candidates.
 */
export function parseInboundEmailMessage(
  mail: ParsedMail,
  context: { mailboxLabel: string; uid: number },
  options?: { importSenders?: readonly string[] },
): Omit<InboundCvIntakeInput, "channel"> {
  const id = emailIdentity(mail, context, options);
  const { attachment, ignoredAttachmentCount } = pickCvAttachment(mail.attachments);
  return buildEmailIntakeInput(
    id,
    attachment,
    id.providerMessageIdBase,
    context,
    ignoredAttachmentCount > 0 ? { ignoredAttachmentCount } : {},
  );
}

/**
 * One intake input PER usable CV attachment — so an agency/referral email carrying several CVs
 * becomes several candidates instead of losing all but the first. The first attachment keeps the
 * bare Message-ID as its idempotency key (unchanged from the single-attachment path); each further
 * attachment is suffixed `#<index>` so it dedupes independently in ats_cv_intake_events. A mail with
 * no usable attachment still yields one input (attachment: null) so the ignored event is logged.
 */
export function parseInboundEmailMessages(
  mail: ParsedMail,
  context: { mailboxLabel: string; uid: number },
  options?: { importSenders?: readonly string[] },
): Array<Omit<InboundCvIntakeInput, "channel">> {
  const id = emailIdentity(mail, context, options);
  const usable = pickCvAttachments(mail.attachments);
  if (usable.length === 0) {
    // No attachment — but the CV may be a share LINK in the body. Record an allowlisted URL (if
    // any) so the worker can fetch it; a non-import only (a forwarder's link isn't the applicant's).
    const cvLinkUrl = id.isImport ? null : extractAllowlistedCvUrl(mail.text ?? null, mail.html);
    return [buildEmailIntakeInput(id, null, id.providerMessageIdBase, context, cvLinkUrl ? { cvLinkUrl } : {})];
  }
  return usable.map((attachment, index) =>
    buildEmailIntakeInput(
      id,
      attachment,
      index === 0 ? id.providerMessageIdBase : `${id.providerMessageIdBase}#${index}`,
      context,
      index > 0 ? { attachmentIndex: index } : {},
    ),
  );
}
