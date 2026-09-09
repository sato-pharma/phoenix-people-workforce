/**
 * New-hire CRM account setup — every word the feature says, and nothing that reads or writes.
 *
 * Split from ./account-setup.ts on the same reasoning as retention-risk/messages.ts: this file
 * imports nothing but a type, so the assertions that matter most — that the notice carries all
 * seven facts the owner asked for, that a missing one prints as "Not recorded" rather than
 * vanishing, and that nothing is ever truncated with an ellipsis — run for real in a plain node
 * test instead of by reading the source.
 */

import type { SystemNotificationChannel } from "@/lib/notifications/system";

/** The admin-editable audience key (see role-recipients.ts). */
export const CRM_ACCOUNT_SETUP_AUDIENCE = "crm_account_setup_alert" as const;
export const CRM_ACCOUNT_SETUP_MODULE = "crm_account_setup" as const;
export const CRM_ACCOUNT_SETUP_EVENT_TYPE = "employee_added" as const;

/**
 * Email AND in-app, and only those — the owner asked for both by name on 2026-09-07 ("make sure it
 * sends an in-app email and an in-app notification and the email").
 *
 * Telegram and push are deliberately absent. He did not ask for them, and this notice carries a
 * named new hire's mobile number and work email: push would put those on a lock screen, and the
 * house already draws that line for anything naming an individual.
 */
export const CRM_ACCOUNT_SETUP_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "email"];

/** Where the notice sends the reader — the CRM workspace tab that asks for the two values. */
export const CRM_ACCOUNT_SETUP_VIEW = "account_setup" as const;

export function crmAccountSetupHref(hrId?: string | null): string {
  const trimmed = String(hrId ?? "").trim();
  const base = `/admin/crm?view=${CRM_ACCOUNT_SETUP_VIEW}`;
  return trimmed ? `${base}&hrId=${encodeURIComponent(trimmed)}` : base;
}

/**
 * Where the CV downloads from — the same-origin route, gated on the session rather than on a token
 * in the link (src/lib/employees/employee-cv.ts).
 *
 * Spelled out here rather than imported from employee-cv.ts on purpose: this file deliberately
 * imports nothing but a type, so every assertion about what the notice says runs for real in a
 * plain node test instead of by reading the source. The two are pinned to each other by
 * tests/employee-cv.test.ts rather than by a shared import.
 */
export function crmAccountSetupCvHref(hrId?: string | null): string {
  return `/api/employees/${encodeURIComponent(String(hrId ?? "").trim())}/cv`;
}

export const CRM_ACCOUNT_SETUP_CV_CTA_LABEL = "Download the CV" as const;

/** What the CV row says when there is no CV on file. Stated, never blank — see NOT_RECORDED. */
export const NO_CV_ON_FILE = "Not attached" as const;

/**
 * The facts about one new hire that the notice carries. Every field the owner named on 2026-09-07 —
 * line, hiring date, region, area, manager, work email, mobile — plus the person's own name and HR
 * id, which is what makes the rest addressable.
 *
 * `cvFileName` joined them on 2026-09-09, when the owner asked for the CV to be attachable at hire
 * and downloadable from this notice. It is the FILENAME rather than a boolean because the reader
 * decides whether to open it from what it is called — "Ahmed-Hassan-CV.pdf" and "scan_0031.jpg"
 * are different propositions — and because a name is also the only signal in the notice that the
 * right document was attached.
 */
export type CrmAccountSetupSubject = {
  areaName: string | null;
  cvFileName?: string | null;
  displayName: string;
  hireDate: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  managerName: string | null;
  mobileNumber: string | null;
  regionName: string | null;
  workEmail: string | null;
};

/** Whether this notice has a CV to offer. */
export function hasCvOnFile(subject: CrmAccountSetupSubject): boolean {
  return String(subject.cvFileName ?? "").trim().length > 0;
}

/**
 * A missing value prints as this rather than as an empty cell.
 *
 * It is doing real work: this notice exists to get a CRM account created, and "no line recorded" is
 * itself something the reader must see — an empty cell reads as a rendering fault and gets ignored,
 * while a stated blank gets fixed.
 */
export const NOT_RECORDED = "Not recorded";

function stated(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : NOT_RECORDED;
}

/**
 * The hiring date is a DATE-ONLY value (`employees.hire_date`, a `date` column), which `new Date`
 * parses as UTC midnight. Rendering it in Africa/Cairo would shift the calendar day; UTC here is
 * not a timezone choice, it is the absence of one. The owner's "report every time in Cairo" rule
 * governs INSTANTS we stamped, not calendar days — see AGENTS.md §2.1 on the three causes of a UI
 * timeZone: "UTC".
 */
export function formatHireDate(value: string | null | undefined): string {
  const text = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NOT_RECORDED;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" })
    .format(new Date(`${text}T00:00:00Z`));
}

/** The label a person is known by in this notice: their name and the code they are filed under. */
export function subjectLabel(subject: CrmAccountSetupSubject): string {
  return `${subject.displayName} (${subject.hrId})`;
}

export function crmAccountSetupTitle(subject: CrmAccountSetupSubject): string {
  return `New employee — CRM account needed: ${subject.displayName}`;
}

/**
 * The one-line body. It says what happened, who it is about, and what is being asked for — in that
 * order, because it is read on a phone where the second sentence may not be read at all.
 *
 * THE CV IS NAMED HERE, NOT ONLY IN THE DETAIL ROWS, AND THAT IS NOT DUPLICATION. The in-app
 * renderer caps a notification at its FIRST EIGHT detail rows (notificationDetails in
 * communication/metrics.ts). This notice already carries nine, so the CV row — which goes last —
 * never reaches the bell menu at all. The email shows every row and gets a download button; in-app
 * this sentence is the only thing that tells the reader a CV exists, and the notice's own link
 * lands him on the screen the download button is on.
 */
export function crmAccountSetupMessage(subject: CrmAccountSetupSubject): string {
  const cv = hasCvOnFile(subject)
    ? ` Their CV (${String(subject.cvFileName).trim()}) is on the record, and the same screen downloads it.`
    : "";
  return `${subjectLabel(subject)} has been added to the employee master. Open the New Hire CRM Setup tab to record the CRM username and CRM code for this person, or mark that no CRM account is needed.${cv}`;
}

/**
 * The detail rows, in the order the owner listed them. Used for the email's metric table and for
 * the in-app notification's metadata, so both carry the same facts and can never drift.
 *
 * The CV row goes LAST and is always present — `Not attached` when there is none. A row that
 * disappeared when empty would make "this hire has no CV" indistinguishable from "this notice
 * predates the CV feature", and the first is something HR should go and fix.
 */
export function crmAccountSetupDetails(subject: CrmAccountSetupSubject): Array<{ label: string; value: string }> {
  return [
    { label: "Employee", value: subjectLabel(subject) },
    { label: "Job title", value: stated(subject.jobTitle) },
    { label: "Line", value: stated(subject.lineName) },
    { label: "Hiring date", value: formatHireDate(subject.hireDate) },
    { label: "Region", value: stated(subject.regionName) },
    { label: "Area", value: stated(subject.areaName) },
    { label: "Manager", value: stated(subject.managerName) },
    { label: "Work email", value: stated(subject.workEmail) },
    { label: "Mobile number", value: stated(subject.mobileNumber) },
    { label: "CV", value: hasCvOnFile(subject) ? String(subject.cvFileName).trim() : NO_CV_ON_FILE },
  ];
}

/** The email's opening paragraph — the same facts as the body, addressed to a reader with time. */
export function crmAccountSetupEmailSummary(subject: CrmAccountSetupSubject): string {
  const cv = hasCvOnFile(subject)
    ? ` Their CV is attached to the employee record as ${String(subject.cvFileName).trim()}, and the second button below downloads it.`
    : "";
  return `${subjectLabel(subject)} has just been added to the employee master and has no iReports360 (CRM) account recorded yet. Until the CRM username and CRM code are entered against this employee, their visits and check-ins cannot be matched to them and their field work will read as nothing at all.${cv} The details below are everything on the employee record as it stands now.`;
}

export const CRM_ACCOUNT_SETUP_CTA_LABEL = "Enter the CRM username and code" as const;
