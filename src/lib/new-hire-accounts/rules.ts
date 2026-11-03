// ─────────────────────────────────────────────────────────────────────────────────────────────────
// NEW HIRE ACCOUNTS — the SFE Manager sends a new rep or district manager their account.
//
// Owner, 2026-11-03: "I want him to be able to send the new accounts to the new hires, but without changing in access
// or authorities or anything. For example, I want him to have the rep name and details and action buttons, send via
// email, send via SATO email, or send via private email, or send via WhatsApp."
//
// 🔴 ONE DOOR, NARROWER THAN THE ONE IT SITS BESIDE. A setup link signs its person out and lets whoever holds it set the
// password, so this page reaches only people who have never set one: forced to set a password, active, on a field role
// and newly hired. An established account can never be taken over from here, and `user_admin` stays the Super Admin's.
//
// The address is always the register's, read on the server at the press. It is never taken from the request.
//
// The account: docs/phoenix-crm-offplan-exemptions.md, "New Hire Accounts".
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const NEW_HIRE_ACCOUNTS_PATH = "/admin/field-crm/new-hire-accounts";

/** The field roles the page reaches. The one role that matters is what is on the login, never the job title. */
export const NEW_HIRE_ROLES = ["Medical Rep", "District Manager"] as const;

/** How far back a hire date still counts as new. A date ahead of today always does: people are invited before they start. */
export const NEW_HIRE_WINDOW_DAYS = 90;

export const NEW_HIRE_CHANNELS = ["sato_email", "private_email", "whatsapp"] as const;

export type NewHireChannel = (typeof NEW_HIRE_CHANNELS)[number];

export function parseNewHireChannel(value: unknown): NewHireChannel | null {
  const key = String(value ?? "").trim();
  return NEW_HIRE_CHANNELS.find((channel) => channel === key) ?? null;
}

const CHANNEL_NAMES: Record<NewHireChannel, string> = {
  sato_email: "Sato email",
  private_email: "private email",
  whatsapp: "WhatsApp",
};

export function newHireChannelName(channel: NewHireChannel): string {
  return CHANNEL_NAMES[channel];
}

/** The earliest hire date on the page, by plain calendar arithmetic on the Cairo date it is given. */
export function firstNewHireDate(today: string): string {
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - NEW_HIRE_WINDOW_DAYS);
  return day.toISOString().slice(0, 10);
}

export type NewHirePerson = {
  role: string | null;
  isActive: boolean;
  forcePasswordReset: boolean;
  isTestPersona: boolean;
  employmentStatus: string | null;
  hireDate: string | null;
};

/** Asked for the list and asked AGAIN at every press, so a stale page can never reach anybody else. */
export function isNewHireAccount(person: NewHirePerson, today: string): boolean {
  if (!person.isActive || !person.forcePasswordReset || person.isTestPersona) return false;
  if (!NEW_HIRE_ROLES.some((role) => role === person.role)) return false;
  if (String(person.employmentStatus ?? "").trim().toLowerCase() !== "active") return false;
  const hired = String(person.hireDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hired)) return false;
  return hired >= firstNewHireDate(today);
}

export type NewHireLastSend = {
  at: string;
  byName: string | null;
  /** "Sato email", "Private email", "Email", "WhatsApp" or "Link copied". */
  how: string;
  /**
   * Sent: the mail left. Not delivered: the link exists and the person does not have it. Not confirmed: the first try did
   * not leave and the outbox was still trying, so the page cannot say. Prepared: a chat was opened for a person to send.
   */
  outcome: "sent" | "not_delivered" | "not_confirmed" | "prepared";
};

/** What one audit row says about how a link travelled. An older row carries no `emailTo`, so it says only "Email". */
export function lastSendOf(values: Record<string, unknown>): Pick<NewHireLastSend, "how" | "outcome"> {
  if (values.deliveryMode === "whatsapp") return { how: "WhatsApp", outcome: "prepared" };
  if (values.deliveryMode === "copy") return { how: "Link copied", outcome: "prepared" };
  const how = values.emailTo === "private" ? "Private email" : values.emailTo === "work" ? "Sato email" : "Email";
  if (values.delivery === "email_queued_for_retry") return { how, outcome: "not_confirmed" };
  return { how, outcome: values.delivery === "email_sent" ? "sent" : "not_delivered" };
}

export function lastSendOutcomeText(outcome: NewHireLastSend["outcome"]): string {
  if (outcome === "sent") return "Sent";
  if (outcome === "prepared") return "Prepared";
  if (outcome === "not_confirmed") return "Not confirmed";
  return "Not delivered";
}

export type NewHireAccountRow = {
  /** The key of the press. Never drawn: the page shows people by name. */
  loginId: string;
  name: string;
  jobTitle: string | null;
  lineName: string;
  areaName: string;
  hireDate: string;
  satoEmail: string | null;
  privateEmail: string | null;
  /** The number as a person dials it, or null when the register holds none that can be read with confidence. */
  mobile: string | null;
  lastSend: NewHireLastSend | null;
};

export type NewHireAccountsView = {
  rows: NewHireAccountRow[];
  /** True when the record of earlier sends could not be read, so no row may claim that none was sent. */
  lastSendUnavailable: boolean;
};

export type NewHireSendResult = {
  loginId: string;
  channel: NewHireChannel;
  message: string;
  /** False only when an email did not leave. */
  delivered: boolean;
  /** WhatsApp only: that person's chat with the message already written, for the person who pressed to send. */
  whatsAppUrl: string | null;
  lastSend: NewHireLastSend;
};

/** The address a channel needs on this row, or null when the register holds none. */
export function newHireAddress(row: Pick<NewHireAccountRow, "satoEmail" | "privateEmail" | "mobile">, channel: NewHireChannel): string | null {
  if (channel === "sato_email") return row.satoEmail;
  if (channel === "private_email") return row.privateEmail;
  return row.mobile;
}

/** Why a button cannot be pressed, in the words printed under it. */
export function newHireMissingText(channel: NewHireChannel): string {
  if (channel === "whatsapp") return "No readable mobile number on file";
  return `No ${newHireChannelName(channel)} on file`;
}

/** What the page's one note says: what a press does, and what it never does. */
export const NEW_HIRE_ACCOUNTS_EXPLAINER =
  "These are new medical reps and district managers who have not set a password yet. Each button sends one person a link to set their password. The link works once, for 48 hours, and sending again cancels the last one. Nothing here changes anybody's role, line, manager or access. A person leaves this list when they set their password.";
