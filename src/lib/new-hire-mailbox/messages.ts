/**
 * New hire mailboxes — every word the notice says, and nothing that reads or writes. Imports only a
 * type, so tests/new-hire-mailbox.test.ts checks what the notice says by running it.
 */

import type { SystemNotificationChannel } from "@/lib/notifications/system";

/** The admin-editable audience key (see role-recipients.ts). Defaults to Super Admin alone. */
export const NEW_HIRE_MAILBOX_AUDIENCE = "new_hire_mailbox_alert" as const;
export const NEW_HIRE_MAILBOX_MODULE = "new_hire_mailbox" as const;
export const NEW_HIRE_MAILBOX_EVENT_TYPE = "employee_added" as const;

/**
 * In-app and Telegram, and NEVER email — the owner's choice when he asked for this on 2026-09-18.
 * Email is also the one channel that makes no sense here: the notice is about a mailbox that does
 * not exist yet. Push is absent because nobody asked for it.
 */
export const NEW_HIRE_MAILBOX_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "telegram"];

/** The page every notice lands on. The same page serves both shells; /hr/ rewrites onto it. */
export const NEW_HIRE_MAILBOX_PATH = "/new-hire-mailboxes" as const;

export function newHireMailboxHref(hrId?: string | null): string {
  const trimmed = String(hrId ?? "").trim();
  return trimmed ? `${NEW_HIRE_MAILBOX_PATH}?hrId=${encodeURIComponent(trimmed)}` : NEW_HIRE_MAILBOX_PATH;
}

/** Where the mailbox is created. Turbify's own control panel: it publishes no API for this. */
export const TURBIFY_CONTROL_PANEL_URL = "https://ecp.turbify.com/";

/** The name the app password is given in Turbify, so it can be found and deleted later. */
export const NEW_HIRE_APP_PASSWORD_NAME = "Phoenix email" as const;

export type NewHireMailboxSubject = {
  displayName: string;
  /** The address Phoenix proposes, or the one HR typed. Null when there was nothing to build it from. */
  emailAddress: string | null;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
};

/** A missing value prints as this rather than as a blank a reader takes for a rendering fault. */
export const NOT_RECORDED = "Not recorded";
export const NO_ADDRESS_YET = "Type one on the page";

function stated(value: string | null | undefined, fallback = NOT_RECORDED): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : fallback;
}

/**
 * A DATE-ONLY value (`employees.hire_date`), which parses as UTC midnight: formatting it in UTC keeps
 * it on its own calendar day. The Cairo rule governs instants, not calendar days.
 */
export function formatHireDate(value: string | null | undefined): string {
  const text = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NOT_RECORDED;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" })
    .format(new Date(`${text}T00:00:00Z`));
}

export function newHireMailboxTitle(subject: NewHireMailboxSubject): string {
  return `New employee — company email needed: ${subject.displayName}`;
}

/** The body, read on a phone: who, which address, and what to do — in that order. */
export function newHireMailboxMessage(subject: NewHireMailboxSubject): string {
  const address = subject.emailAddress
    ? `Create ${subject.emailAddress} in Turbify`
    : "Create their mailbox in Turbify";
  return `${subject.displayName} has been added. ${address}, make an app password named "${NEW_HIRE_APP_PASSWORD_NAME}" inside it, and paste it on the New Hire Mailboxes page. Their My email in Phoenix is then connected, with nothing for them to do.`;
}

/** The detail rows the in-app notice carries. No mobile number and no HR id: neither is needed. */
export function newHireMailboxDetails(subject: NewHireMailboxSubject): Array<{ label: string; value: string }> {
  return [
    { label: "Employee", value: subject.displayName },
    { label: "Job title", value: stated(subject.jobTitle) },
    { label: "Line", value: stated(subject.lineName) },
    { label: "Hiring date", value: formatHireDate(subject.hireDate) },
    { label: "Email to create", value: stated(subject.emailAddress, NO_ADDRESS_YET) },
  ];
}

/** The steps the page shows above the queue. Turbify's own wording for each screen. */
export const NEW_HIRE_MAILBOX_STEPS: readonly string[] = [
  "In Turbify: My Services → Email → Email user, and create the address shown on the card.",
  "Sign in to the new mailbox with the temporary password Turbify gives you, and set a new one.",
  `In that mailbox: Manage your account → Manage App Passwords → Generate, named "${NEW_HIRE_APP_PASSWORD_NAME}".`,
  "Paste the app password on the card and press Connect. Phoenix checks it with Turbify before saving it.",
];
