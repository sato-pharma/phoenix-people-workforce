/**
 * New-hire CRM account setup — the words the New Hire CRM Setup tab shows, and nothing that reads
 * or writes.
 *
 * 🔴 THE NOTICE AND ITS DAILY REMINDER ARE RETIRED (2026-11-07). They asked somebody to give each new
 * field hire an iReports360 account; the vendor CRM was retired on 6 Nov 2026
 * (crm_cutover.vendor_sync_retired_at) and Phoenix CRM is the only source of field work, so nobody
 * can be given one any more. Their sender (account-setup-notify.ts), their reminder
 * (account-setup-reminder.ts), their `crm_account_setup_alert` audience and every word only the notice
 * used (title, body, email summary, button, channels, deep link) left together. Never re-wire them.
 *
 * Split from ./account-setup.ts on the same reasoning as retention-risk/messages.ts: this file
 * imports nothing, so the assertions that matter most — that a missing fact prints as "Not
 * recorded" rather than vanishing, and that nothing is ever truncated with an ellipsis — run for
 * real in a plain node test instead of by reading the source.
 */

/**
 * The module and event type the retired notice was written under. Nothing sends under them any more;
 * they stay because they name the HISTORY rows already in notification_events
 * (`crm_account_setup` / `employee_added`), and because the new-hire mailbox notice still uses the
 * same event type (src/lib/notifications/operator-watch-channel-guard.ts keys on the type alone).
 */
export const CRM_ACCOUNT_SETUP_MODULE = "crm_account_setup" as const;
export const CRM_ACCOUNT_SETUP_EVENT_TYPE = "employee_added" as const;

/**
 * Where the CV downloads from — the same-origin route, gated on the session rather than on a token
 * in the link (src/lib/employees/employee-cv.ts).
 *
 * Spelled out here rather than imported from employee-cv.ts on purpose: this file deliberately
 * imports nothing, so every assertion about what the tab says runs for real in a plain node test
 * instead of by reading the source. The two are pinned to each other by
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

/** Whether this person has a CV to offer. */
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

/** The label a person is known by on the tab: their name and the code they are filed under. */
export function subjectLabel(subject: CrmAccountSetupSubject): string {
  return `${subject.displayName} (${subject.hrId})`;
}

/**
 * The detail rows, in the order the owner listed them. The New Hire CRM Setup tab and the queue
 * both build from this one function, so they can never drift.
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
