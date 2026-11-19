// The WhatsApp Inbox — the company's two WhatsApp lines, and what each one can do. A third company number, the approvals
// line, is NOT one of them: it is read only on the Super Admin's Approvals WhatsApp screen (see the end of this file).
//
// Both numbers are on the Cloud API and feed the same webhook, so a message only says which line it
// belongs to through Meta's `phone_number_id`. This module turns that id into a name a person reads.
//
// 🔴 A TEMPLATE BELONGS TO ONE BUSINESS ACCOUNT. The two lines sit in two different WhatsApp business
// accounts, and Meta refuses a template sent from a number whose account does not own it. So the
// template list is always fetched for the line being replied from, never shared between them.
// Verified live on 2026-09-15: the recruitment account holds three approved templates, the handset's
// account holds none — the inbox says so rather than offering a list that would fail on send.
//
// The ids are not secrets (they appear in every webhook body) and are stable for the life of a number.
// Env overrides exist so staging can point at a test number without a code change.

export type WhatsAppInboxLine = {
  /** Meta's phone number id — the key every message carries. */
  phoneNumberId: string;
  /** The WhatsApp business account that owns this number, and therefore its templates. */
  businessAccountId: string;
  label: string;
  displayNumber: string;
};

const RECRUITMENT_LINE: WhatsAppInboxLine = {
  businessAccountId: "2265574670642375",
  displayNumber: "+20 10 98500699",
  label: "Recruitment line",
  phoneNumberId: "1319071451278873",
};

const HR_HANDSET_LINE: WhatsAppInboxLine = {
  businessAccountId: "365968989943377",
  displayNumber: "+20 11 59888247",
  label: "HR handset",
  phoneNumberId: "477586495433549",
};

function fromEnv(line: WhatsAppInboxLine, prefix: string): WhatsAppInboxLine {
  const phoneNumberId = process.env[`${prefix}_PHONE_NUMBER_ID`]?.trim();
  const businessAccountId = process.env[`${prefix}_BUSINESS_ACCOUNT_ID`]?.trim();
  return {
    ...line,
    businessAccountId: businessAccountId || line.businessAccountId,
    phoneNumberId: phoneNumberId || line.phoneNumberId,
  };
}

export function whatsAppInboxLines(): WhatsAppInboxLine[] {
  return [
    fromEnv(RECRUITMENT_LINE, "WHATSAPP_INBOX_RECRUITMENT"),
    fromEnv(HR_HANDSET_LINE, "WHATSAPP_INBOX_HANDSET"),
  ];
}

/** The handset's line, the one whose app must be opened every 14 days. */
export function hrHandsetInboxLine(): WhatsAppInboxLine {
  return fromEnv(HR_HANDSET_LINE, "WHATSAPP_INBOX_HANDSET");
}

export function findWhatsAppInboxLine(phoneNumberId: string | null | undefined): WhatsAppInboxLine | null {
  const id = phoneNumberId?.trim();
  if (!id) return null;
  return whatsAppInboxLines().find((line) => line.phoneNumberId === id) ?? null;
}

/** A line's name for display. An unknown id is still shown — as a number, never silently hidden. */
export function whatsAppInboxLineLabel(phoneNumberId: string | null | undefined, displayNumber?: string | null): string {
  const line = findWhatsAppInboxLine(phoneNumberId);
  if (line) return line.label;
  return displayNumber?.trim() ? `WhatsApp ${displayNumber.trim()}` : "Another WhatsApp line";
}

// ── The third number (owner, 3 Nov 2026) ──
//
// The number the approval reminders go out from (src/lib/approvals/urgent-whatsapp-rules.ts), +20 10 40631155. 🔴 IT IS
// DELIBERATELY NOT IN whatsAppInboxLines ABOVE, and it has no default: HR Resourcing reads that list. Since 19 Nov 2026
// (owner: "Keep them, my screen only", "Super Admin only") its replies, ticks and every send from it — the reminders
// included — are kept in the Approvals WhatsApp store (`approvals_whatsapp_*`, src/lib/approvals-whatsapp/), read only at
// /admin/approvals-whatsapp. `postToGraph` and the webhook both ask isApprovalsLine, because neither the inbox nor the
// recruitment outbound report filters by line on its own.

/**
 * 🔴 NEVER A RECRUITMENT OR HANDSET LINE. The webhook takes everything delivered to this number out of the recruitment
 * pipeline and the WhatsApp Inbox (keeping it in the Approvals WhatsApp store) and still answers 200, so Meta never
 * redelivers. Set by mistake to a line in use, applicants would vanish from recruitment, so such a value reads as unset:
 * the reminders and the Approvals WhatsApp sends stay off, which is the loud and harmless failure.
 */
export function approvalsLinePhoneNumberId(): string | null {
  const id = process.env.WHATSAPP_APPROVALS_PHONE_NUMBER_ID?.trim();
  if (!id) return null;
  const intake = [process.env.WHATSAPP_PHONE_NUMBER_ID ?? "", ...(process.env.WHATSAPP_PHONE_NUMBER_IDS ?? "").split(",")].map((entry) => entry.trim());
  return intake.includes(id) || findWhatsAppInboxLine(id) ? null : id;
}

/** Null until both ids are set: a template belongs to one business account, so the number alone cannot send. */
export function whatsAppApprovalsLine(): { phoneNumberId: string; businessAccountId: string } | null {
  const phoneNumberId = approvalsLinePhoneNumberId();
  const businessAccountId = process.env.WHATSAPP_APPROVALS_BUSINESS_ACCOUNT_ID?.trim();
  return phoneNumberId && businessAccountId ? { businessAccountId, phoneNumberId } : null;
}

export function isApprovalsLine(phoneNumberId: string | null | undefined): boolean {
  const line = approvalsLinePhoneNumberId();
  return Boolean(line) && phoneNumberId?.trim() === line;
}
