import { HR_ROLE_BUNDLES, type HrBundleName, type HrFunctionKey } from "@/lib/auth/hr-functions";
import type { PhoenixCompanyJobTitle, PhoenixRole } from "@/lib/auth/permissions";

/**
 * THE JOB WORKBOOK — every responsibility line, beside the screen that does it.
 *
 * ## Why this exists
 *
 * The owner's instruction, 2026-08-28: "for every job description it have, how will it do it on
 * Phoenix, to make it a workbook for everyone". Both HR seats open on 1 September and neither of
 * the people who held the old seats will be here to show them. A workbook that lives in the system
 * is the difference between a role that is TAUGHT and a role that is passed down by whoever
 * happens to still be sitting nearby.
 *
 * ## The rule this file follows
 *
 * Every `responsibility` below is a line from a job description the owner supplied, VERBATIM —
 * `Sato_HR_Operations_Job_Description_Requirements.docx`, dated 2026-08-28. Nothing is
 * paraphrased, softened, merged or dropped, because the count is the promise: 37 lines for the HR
 * Operations Coordinator across nine numbered sections. tests/hr-job-workbook.test.ts asserts that
 * number and every section's own line count, so a line cannot be quietly lost in an edit. (The HR
 * Business Partner's 29 lines, from `Sato_HRBP_Job_Description_Requirements.docx`, left with the
 * seat when the owner retired it on 2026-10-08.)
 *
 * What is AUTHORED is the other three columns — the screen, the steps and the evidence. Those are
 * this system's answer to the line, and they are checked mechanically rather than trusted:
 *
 *   • every `href` resolves to a page file that exists on disk;
 *   • every `href` is inside the /hr namespace and is either a navigation row for the seat that
 *     owns the line, or a sub-page of one — so a screen named here is a screen that seat can
 *     actually reach from its own sidebar, not one it would have to be told the address of;
 *   • every line's `fn` is a function that seat's bundle actually holds, so a responsibility can
 *     never be mapped to a capability the seat was not given;
 *   • no line may have an empty screen list, an empty step list, or an empty evidence line.
 *
 * That last one is the completion test the owner was promised: "all 66 lines mapped to a real
 * screen, none left blank." — 37 since the HR Business Partner seat was retired.
 *
 * ## How the authored columns are WRITTEN
 *
 * Owner's instruction, 2026-08-28, after reading the first printed cut: "make the text in more
 * simple clear english and make it more friendly", "and more easy to be understand". Both readers
 * start on 1 September with nobody to ask, and English is not the first language of either. So the
 * `steps` and `evidence` lines follow four rules:
 *
 *   1. Short sentences, one idea each. Everyday words — "check", not "validate"; "saved", not
 *      "persisted"; "written down", not "documented".
 *   2. Speak TO the reader: "Open the queue", "You do not have to build this list".
 *   3. NO permission slugs. `retention:delete` means nothing to the person doing the job, so the
 *      line says "the system will not let you delete it, and that is on purpose" instead.
 *   4. Warm, not clever. A sentence that reads well but has to be re-read twice has failed.
 *
 * The `responsibility`, `mission` and `boundaries` strings are EXEMPT from all of that — they are
 * the owner's own job descriptions and stay verbatim however formal they read. Four of them are
 * pinned character-for-character by the test.
 *
 * ## What the evidence column is for
 *
 * Both job descriptions demand traceability in almost the same words — "every important action
 * must be supported and traceable" (ops), "ensure important employee conversations and decisions
 * are documented through official channels" (hrbp). The `evidence` line answers, for each
 * responsibility, the question an audit actually asks: *if you did this, what would be left
 * behind?* Where the honest answer is "the system refuses to let you do it", that is written down
 * too — a boundary is evidence of the same kind.
 */

export type WorkbookScreen = {
  /** An /hr address. Checked against the page files on disk and against the seat's navigation. */
  href: string;
  /** The label the reader will see in their own sidebar, so the workbook and the rail agree. */
  label: string;
};

export type WorkbookLine = {
  /** Stable, seat-and-section scoped: `ops-1-3` is the third line of the HR Generalist's § 1. */
  id: string;
  /** VERBATIM from the job description. Never edit to fit a screen — change the mapping instead. */
  responsibility: string;
  screens: readonly WorkbookScreen[];
  /** What to do, in the order you do it. Plain words — see the writing rules above. */
  steps: readonly string[];
  /** What gets saved afterwards — the answer to "prove you did this". */
  evidence: string;
  /** The HR function this line is served by. Must be in the owning seat's bundle. */
  fn: HrFunctionKey;
};

/**
 * Is this section's work DONE on a screen, or is it human work the screen only records?
 *
 * Every one of the responsibilities has a real screen behind it — that is what the "none left
 * blank" test enforces. But a stay interview is a conversation, not a screen: Phoenix's job there
 * is to make sure it was written down and tagged. Saying "system" about that would be a lie of the
 * most expensive kind, because the reader would go looking for a screen that conducts an interview.
 *
 *   • `system`            — the work itself is done on the screens named.
 *   • `system-and-person` — part is on a screen, part is a call, a chase or an explanation.
 *   • `person-led`        — the work is a conversation; the system holds the record of it.
 */
export type WorkbookSectionMode = "system" | "system-and-person" | "person-led";

export type WorkbookSection = {
  /** The number as it appears in the job description, so the two can be read side by side. */
  number: number;
  title: string;
  /** Read by the Role Map page. Asserted present and valid for every section by the test. */
  mode: WorkbookSectionMode;
  lines: readonly WorkbookLine[];
};

/** The short label the Role Map prints for each mode. */
export const WORKBOOK_MODE_LABELS: Record<WorkbookSectionMode, string> = {
  system: "On the system",
  "system-and-person": "System + person",
  "person-led": "Person — system records it",
};

export type SeatWorkbook = {
  seat: HrBundleName;
  jobTitle: PhoenixCompanyJobTitle;
  /** The ROLE MISSION paragraph, verbatim. */
  mission: string;
  sections: readonly WorkbookSection[];
  /** The "Role Boundaries & Approval Authority" lines, verbatim. */
  boundaries: readonly string[];
};

// ── Screens, named once ────────────────────────────────────────────────────────
// Every reference below goes through this table rather than repeating an href. A screen that is
// renamed or moved is then one edit, and the test that checks these against the real page files and
// the real navigation checks them once each rather than once per mention.

// `approvalsHub` was here until 2026-09-01 and is deliberately gone. Its only user was ops-2-1,
// which taught the Operations seat to "decide excuses and permission requests in Other Approvals" —
// wrong on two counts even before the row was retired from her rail that day. Excuses, vacation and
// plans LEFT that inbox for their own dedicated pages (see the MIGRATED_DEEPLINK_BASES map in
// app/(admin)/admin/approvals-hub/page.tsx, which bounces stale ?module=excuse links away from it),
// so the hub now carries resignation, contract and outstation only; and the excuse decision itself
// belongs to leaveExcuseApproverAdminNavigationRoles — Super Admin, CEO and Financial Advisor — a
// list this seat has never been on. Do not re-add the entry to point a line here.
// -- 2026-09-05: five entries removed, and two of them for a reason worth reading --------------
//
// `attendance` (/hr/attendance), `leave` (/hr/leave-management) and `payroll`
// (/hr/admin/payroll-management) were HUB pages. The owner ruled that day that no rail row may
// open a page of modules - "I don't want any subtitle to be the one that when I press, it
// redirects me to a page with big modules" - so each hub's cards became rows and the door went. A
// workbook line is better off naming the screen the work is done on than the door to it, so every
// reference moved to the concrete screen: Fingerprint Report, Vacation Report, Payroll Report.
//
// `attendanceExceptions` (/hr/attendance/exceptions) and `attendanceDayReport`
// (/hr/attendance/employee-day-report) are a DIFFERENT case, and they were a live defect rather
// than a consequence of the ruling. Both pages are SUPER ADMIN ONLY - exceptions gates on
// canAccessSystemAdministratorWorkspace (scope "system" or a system-administrator role; HR
// Operations is "company" and neither), and the day report redirects on `access.role !== "Super
// Admin"` in as many words. Four of her lines taught her to do her work on them. Nothing caught
// it because the reachability check in tests/hr-job-workbook.test.ts counted a page as reachable
// when it sat under an offered row, and /hr/attendance was one - so the hub row was vouching for
// two children it does not admit her to. Removing the hub row removed the cover, and the check
// found them. The lines now name the screens she can actually open; whether she SHOULD hold
// either of these two is a permission question for the owner, not one to settle by editing a book.
const S = {
  activityReport: { href: "/hr/admin/company-activity-report", label: "Activity Report" },
  attendanceDevices: { href: "/hr/attendance/device-user-mapping", label: "Device User Mapping" },
  attendanceFingerprint: { href: "/hr/attendance/fingerprint-report", label: "Fingerprint Report" },
  attendanceMonthly: { href: "/hr/attendance/monthly-summary", label: "Monthly Summary" },
  attendancePolicies: { href: "/hr/attendance/policies", label: "Attendance Policies" },
  coaching: { href: "/hr/coaching", label: "Field Coaching" },
  companyCalendar: { href: "/hr/hr-calendar", label: "Company Calendar" },
  contactReview: { href: "/hr/recruitment/contact-review", label: "Missing Contact Details" },
  contracts: { href: "/hr/contracts", label: "Contract Renewal" },
  cvDatabase: { href: "/hr/cv-database", label: "CV Database" },
  deductions: { href: "/hr/admin/deductions", label: "Deductions" },
  employee360: { href: "/hr/employee-360", label: "Employee 360" },
  employees: { href: "/hr/employees", label: "Employee Directory" },
  hiringDocuments: { href: "/hr/hiring-documents", label: "Hiring Documents" },
  hiringPack: { href: "/hr/hiring-pack", label: "HR Forms" },
  intakeHealth: { href: "/hr/recruitment/intake-health", label: "Inbound Intake Health" },
  mailboxOffboarding: { href: "/hr/mailbox-offboarding", label: "Mailbox Revocation" },
  offers: { href: "/hr/offers", label: "Job Offers" },
  organogram: { href: "/hr/organogram", label: "Organogram" },
  overview: { href: "/hr/admin/hr-command-center", label: "HR Overview" },
  payrollReport: { href: "/hr/payroll", label: "Payroll Report" },
  probation: { href: "/hr/probation", label: "Probation" },
  recruitment: { href: "/hr/recruitment", label: "Recruitment" },
  resignations: { href: "/hr/resignations", label: "Resignations" },
  retention: { href: "/hr/retention", label: "Retention Register" },
  screening: { href: "/hr/recruitment/screening", label: "Screening" },
  support: { href: "/hr/admin/support-requests", label: "HR Support Requests" },
  vacancies: { href: "/hr/reports/vacancies", label: "Vacancies Report" },
  vacationControl: { href: "/hr/leave-management/vacation-control", label: "Vacation Control" },
  vacationRecord: { href: "/hr/leave-management/vacation-report", label: "Vacation Report" },
} as const satisfies Record<string, WorkbookScreen>;

// ── No HR Business Partner workbook since 2026-10-08 ─────────────────────────────
//
// Her 29 lines (6 sections) lived here. The owner retired the seat and the title that evening —
// "no more HR business partner. This title, no more" — so there is no job left for them to describe.
// Recruiting is the Talent Acquisition seat's; the rest is the Super Admin's for now
// (UNASSIGNED_HR_FUNCTIONS in hr-functions.ts). git history holds the lines verbatim.

// ── HR Generalist (seat: HR Operations; titled HR Operations Coordinator until 2026-10-20) — 37 lines across 9 sections

const OPS_SECTIONS: readonly WorkbookSection[] = [
  {
    number: 1,
    title: "Employee Records & Personnel Files",
    mode: "system",
    lines: [
      {
        id: "ops-1-1",
        responsibility:
          "Maintain complete and accurate personnel files for active employees and ensure required hiring documents are collected and archived.",
        screens: [S.hiringDocuments, S.hiringPack],
        steps: [
          "Open the person's documents and upload whatever is missing.",
          "The file is complete when nothing is left outstanding. The screen tells you that. You do not have to decide it yourself.",
        ],
        evidence:
          "Every document shows who uploaded it and when. The system IS the personnel file. A folder on a drive is only a copy of it.",
        fn: "people_records",
      },
      {
        id: "ops-1-2",
        responsibility:
          "Maintain employee master data, job titles, reporting lines, territories, employment status and relevant HR records on Phoenix and approved files.",
        screens: [S.employees, S.employee360],
        steps: [
          "Find the person in the Employee Directory and edit their record.",
          "Change it once, here. Line, area, manager, job title and status are read from this one record by every other screen in this book.",
        ],
        evidence:
          "Payroll, vacancies, attendance and the CRM all read this same record, so a correction cannot end up half done.",
        fn: "people_records",
      },
      {
        id: "ops-1-3",
        responsibility:
          "Audit employee records for missing, duplicate, outdated or inconsistent information and close discrepancies promptly.",
        screens: [S.overview, S.employees],
        steps: [
          "Read Incomplete Records and No Manager Set on HR Overview. That is your audit, already done for you.",
          "Open each record, fill in what is missing, and watch the number go down.",
        ],
        evidence:
          "The counts are worked out fresh every time the page opens, so your audit cannot go out of date between fixing something and someone checking it.",
        fn: "people_records",
      },
      {
        id: "ops-1-4",
        responsibility:
          "Prepare and maintain employment documents, HR letters, acknowledgements and approved personnel forms.",
        screens: [S.hiringPack, S.hiringDocuments],
        steps: [
          "Fill the employment contract and the social-insurance Form 1 from the person's own record. Do not retype their details.",
          "Print it, then mark it as issued against them.",
        ],
        evidence:
          "The system records that the letter was issued and when. A letter with no record was never issued as far as Phoenix is concerned, and that is exactly why you record it.",
        fn: "people_records",
      },
    ],
  },
  {
    number: 2,
    title: "Attendance, Leave & Working-Time Administration",
    mode: "system",
    lines: [
      {
        id: "ops-2-1",
        responsibility:
          "Review attendance records, fingerprint inputs, approved leave, permissions, excuses and relevant field-activity inputs according to company rules.",
        screens: [S.attendanceFingerprint, S.activityReport],
        steps: [
          // Was "Work the exception queue" on /hr/attendance/exceptions, a Super Admin page this
          // seat is refused (see the note on the screen table above). The Fingerprint Report is
          // the same work on a screen she holds: it is built from the raw punches and it is where
          // a day gets marked. The duty's own words - attendance records, fingerprint inputs -
          // name it.
          "Read the day on the Fingerprint Report. It is built from the raw punches, so it shows what actually happened before any rule was applied to it.",
          // The duty above says REVIEW, and review is what this seat does: an excuse or permission
          // request is DECIDED by the approver chain, and it reaches her as an already-settled input
          // on the attendance record. The old wording sent her to Other Approvals to decide them
          // herself — a screen those requests had already left, on an approver list she is not on.
          "An approved excuse or permission already shows against the day. Read it there and let it stand — you are checking that the record matches the rules, not re-deciding the request.",
        ],
        evidence:
          "Every decision is saved with your name and the date, right beside the fingerprint record it was about. So it can be read back years later with the same facts in front of you.",
        fn: "time_attendance",
      },
      {
        id: "ops-2-2",
        responsibility:
          "Identify unexplained absences, missing punches or inconsistent records and follow up with the employee/manager before payroll closure.",
        screens: [S.attendanceFingerprint, S.attendanceMonthly],
        steps: [
          // Both screens this line used to name were Super Admin only. The Fingerprint Report
          // filters by employee, by date range and by deduction, and marks each row deduct or
          // exempt - which is this line's work, on a screen this seat is offered.
          "Filter the Fingerprint Report to the person and the dates you are asking about. A missing punch or an unexplained day shows on its own row.",
          "Mark the row deduct or exempt before the month closes, and follow it up with the employee or the manager while the day is still fresh.",
        ],
        evidence:
          "Payroll uses days you have decided, not raw fingerprint data. So a day nobody looked at shows up as undecided instead of quietly becoming a deduction.",
        fn: "time_attendance",
      },
      {
        id: "ops-2-3",
        responsibility: "Maintain leave balances and ensure approved leave is correctly recorded in the system.",
        screens: [S.vacationRecord, S.vacationControl],
        steps: [
          // Was "Approve or refuse the request in Leave Management", which this seat cannot do and
          // never could: her leave grants are read, create, update and export - there is no
          // approve among them, and approving belongs to the request's own chain. The duty says
          // RECORDED, and that is what the Vacation Report shows.
          "Check the approved day landed on the Vacation Report. A balance is added up from the days themselves, so a day that is not recorded is a balance that is wrong.",
          "Change the rules in Vacation Control. Never by editing a number on someone's record.",
        ],
        evidence:
          "A balance is added up from the real days every time somebody looks at it. It is never stored as a figure, which is why it can never drift away from the days behind it.",
        fn: "time_attendance",
      },
      {
        id: "ops-2-4",
        responsibility:
          "Prepare clean, supported monthly attendance outputs and escalate unusual or repeated cases to the HR Section Head.",
        screens: [S.attendanceMonthly, S.attendanceFingerprint, S.support],
        steps: [
          "Settle the open days on the Fingerprint Report first, then read the Monthly Summary. In that order, or the summary is describing a month that is still moving.",
          "If the same person keeps coming up, escalate it in writing rather than mentioning it.",
        ],
        evidence:
          "The summary is built from decided days, so an open exception shows up as one instead of quietly disappearing into the total.",
        fn: "time_attendance",
      },
    ],
  },
  {
    number: 3,
    title: "Payroll HR Inputs & Monthly Closure",
    mode: "system",
    lines: [
      {
        id: "ops-3-1",
        responsibility:
          "Prepare and validate HR-related payroll inputs such as joining dates, separation dates, attendance deductions, unpaid leave, approved salary changes and other authorized HR adjustments.",
        screens: [S.employees, S.attendanceFingerprint, S.vacationRecord, S.payrollReport],
        steps: [
          "Fix the record, never the payroll sheet. A joining date belongs on the employee. A leaving date on the resignation. A deduction on the decided day. Unpaid leave on the leave record.",
          "Then open the Payroll Report and check the run picked your change up.",
        ],
        evidence:
          "There is no separate payroll input file to keep in step, because payroll reads the records themselves. That is why this account has no write access to payroll.",
        fn: "payroll_inputs",
      },
      {
        id: "ops-3-2",
        responsibility: "Reconcile payroll inputs against approved HR documents before submission.",
        screens: [S.payrollReport, S.hiringDocuments],
        steps: [
          "Read the payroll run against the documents behind it.",
          "Where they disagree, fix the record the figure came from. That is the only place a fix sticks.",
        ],
        evidence:
          "Your account can read payroll and deductions and change neither, so a check here is a real check. Nothing you find can be quietly fixed by typing over the number.",
        fn: "payroll_inputs",
      },
      {
        id: "ops-3-3",
        responsibility:
          "Ensure no deduction, addition or employee status change is processed without clear supporting evidence and approval.",
        screens: [S.attendanceFingerprint, S.deductions],
        steps: [
          // The only screen this line named was the Employee Day-by-Day Report - Super Admin
          // only, so the one line whose whole method was a single screen pointed at a page that
          // redirects her. Both replacements are her own rows: the Fingerprint Report is the day
          // and the decision on it, and Deductions is the month those decisions add up to, which
          // the owner opened to her on 2026-09-03 ("yes give HR access to the deductions
          // screen"). Read-only on both, which is the point the evidence line below makes.
          "Every possible deduction shows the day it came from and the decision made on that day.",
          "If there is no decision behind it, it does not go through. You stop it simply by not supporting it.",
        ],
        evidence:
          "Your account cannot create, edit or approve a deduction at all. It cannot raise one even by mistake, which is stronger than a rule asking you not to.",
        fn: "payroll_inputs",
      },
      {
        id: "ops-3-4",
        responsibility:
          "Coordinate with Finance on operational payroll questions while keeping HR approval authority with the HR Section Head.",
        screens: [S.payrollReport, S.support],
        steps: [
          "Ask in writing through the request queue. Include the figure and the screen you got it from.",
        ],
        evidence:
          "The thread keeps what was asked and what was answered, so an ordinary question does not turn into a disagreement at month end.",
        fn: "payroll_inputs",
      },
    ],
  },
  {
    number: 4,
    title: "Contracts, Probation & Employee Lifecycle",
    mode: "system",
    lines: [
      {
        id: "ops-4-1",
        responsibility: "Prepare employment contracts, renewals and amendments based on approved terms.",
        screens: [S.contracts, S.hiringPack],
        steps: [
          "Open the renewal in Contract Renewal and prepare the contract from the person's approved terms.",
          "Use HR Forms for the document itself, so it fills from the record instead of from an old copy.",
        ],
        evidence:
          "A renewal moves through HR review as a request with stages and dates. So 'it is with HR' is a place on a screen, not something somebody tells you.",
        fn: "people_records",
      },
      {
        id: "ops-4-2",
        responsibility: "Maintain contract-expiry and probation trackers with proactive reminders before deadlines.",
        screens: [S.contracts, S.probation, S.overview],
        steps: [
          "There is no tracker to keep. Contracts about to expire and open probation periods show themselves.",
          "Read Renewals In Flight and At HR Review on HR Overview each morning.",
        ],
        evidence:
          "Nothing needs to go in a diary. A tracker only ever reminds you of what somebody remembered to write in it.",
        fn: "people_records",
      },
      {
        id: "ops-4-3",
        responsibility:
          "Coordinate employee transfers, promotions and status changes after approval and ensure all related systems/documents are updated.",
        screens: [S.employees, S.hiringDocuments],
        steps: [
          "Once the approval exists, make the change on the employee record. Once.",
          "Attach the document that approved it to the person's file.",
        ],
        evidence:
          "One record feeds every screen, so a transfer cannot reach payroll and be missed by attendance. That is what happens when a company keeps two copies of the truth.",
        fn: "people_records",
      },
      {
        id: "ops-4-4",
        responsibility:
          "Support probation evaluation administration and ensure evaluation forms and decisions are documented.",
        screens: [S.probation],
        steps: [
          "Read the case list, chase the manager, and check the decision was actually saved.",
        ],
        evidence:
          "Probation is read-only for your account. The admin work is yours and the result is the manager's, and the system keeps the two apart.",
        fn: "performance_probation",
      },
    ],
  },
  {
    number: 5,
    title: "Onboarding & Joining Administration",
    // The record and the device mapping are screens; explaining the company to a new joiner is not.
    mode: "system-and-person",
    lines: [
      {
        id: "ops-5-1",
        responsibility:
          "Receive the final recruitment handover and verify joining documents before the start date.",
        screens: [S.hiringDocuments, S.hiringPack],
        steps: [
          "The handover is simply the candidate's documents becoming the employee's. Check the set is complete before the start date, not on it.",
        ],
        evidence:
          "Every upload is dated, so 'it was ready before they started' is a fact anyone can check rather than a claim.",
        fn: "people_records",
      },
      {
        id: "ops-5-2",
        responsibility:
          "Create and update employee records and coordinate required onboarding administration with relevant functions.",
        screens: [S.employees, S.attendanceDevices],
        steps: [
          "Create the employee record with line, area, manager, job title and start date.",
          "Map their fingerprint device user before day one. This is the step that goes wrong silently.",
        ],
        evidence:
          "An unmapped device gives no attendance at all rather than an error message, so this is where it has to be caught. The record is also what creates their login and their payroll row.",
        fn: "people_records",
      },
      {
        id: "ops-5-3",
        responsibility:
          "Ensure new hires receive clear instructions regarding documents, policies, working arrangements and HR processes.",
        screens: [S.support, S.companyCalendar],
        steps: [
          "A new joiner's questions arrive as requests. Answer them there, and the next joiner's answer is already written.",
          "Point them at the Company Calendar for working days, holidays and company events.",
        ],
        evidence:
          "The thread records what was told to whom. That is what makes an induction repeatable instead of remembered.",
        fn: "people_records",
      },
      {
        id: "ops-5-4",
        responsibility: "Close outstanding onboarding documentation quickly and maintain a clear joining checklist.",
        screens: [S.hiringDocuments],
        steps: [
          "Outstanding is a status on the document set. Work it down there rather than keeping your own list beside it.",
        ],
        evidence:
          "A joining file that is not complete says so on the screen, so a checklist cannot report finished while a document is still missing.",
        fn: "people_records",
      },
    ],
  },
  {
    number: 6,
    title: "Resignation & Offboarding",
    // Phoenix records the exit and tracks the one station it can observe - the company mailbox.
    // Clearing the other departments is a person doing it, not a system watching it.
    mode: "system-and-person",
    lines: [
      {
        id: "ops-6-1",
        responsibility:
          "Register resignations and other separation actions accurately and track final working dates.",
        screens: [S.resignations, S.overview],
        steps: [
          "Record the resignation with the last working date.",
          "The empty seat becomes a vacancy in the same action. You do not open it separately.",
        ],
        evidence:
          "One action writes the resignation and opens the vacancy together, so the two can never disagree about whether the seat is empty.",
        fn: "people_records",
      },
      {
        id: "ops-6-2",
        responsibility: "Coordinate clearance with concerned departments and maintain evidence of completion.",
        screens: [S.mailboxOffboarding],
        steps: [
          "Chase each department on the signed clearance paper. Phoenix does not hold that checklist - print the pair from HR Forms and file the signed originals.",
          "Company mail is the one station Phoenix does track. Record the revocation there, because a password reset does not close a leaver's mailbox on its own.",
        ],
        evidence:
          "The mailbox revocation carries who did it and when, so 'IT cleared them' is a record for the station that is hardest to verify by looking.",
        fn: "people_records",
      },
      {
        id: "ops-6-3",
        responsibility:
          "Ensure company assets, documents and required approvals are addressed before final settlement processing.",
        screens: [S.hiringPack],
        steps: [
          "The settlement is released against the signed clearance papers, not against a screen.",
        ],
        evidence:
          "Both papers are printed from the current template and archived when the owner revises the wording, so the version somebody signed is always recoverable.",
        fn: "people_records",
      },
      {
        id: "ops-6-4",
        responsibility:
          "Maintain accurate records for resignations, terminations, non-renewals and other exits.",
        screens: [S.resignations],
        steps: [
          "Record every exit the same way, whatever the reason. That is what makes them countable afterwards.",
        ],
        evidence:
          "Your account cannot delete a resignation. An exit record can be corrected and can never be removed, which is what both job descriptions mean by records that survive an inspection.",
        fn: "people_records",
      },
    ],
  },
  {
    number: 7,
    title: "Employee HR Services",
    mode: "system",
    lines: [
      {
        id: "ops-7-1",
        responsibility:
          "Handle routine employee requests for HR letters, attendance clarification, leave, employment documents and personnel procedures.",
        screens: [S.support],
        steps: [
          "Work the queue. Every routine request arrives here, from every location.",
        ],
        evidence:
          "Each request carries its conversation and how long it took, so the service level is measured from the requests themselves rather than reported by anyone.",
        fn: "people_records",
      },
      {
        id: "ops-7-2",
        responsibility:
          "Provide employees with clear factual information while avoiding unauthorized promises or policy exceptions.",
        screens: [S.support, S.employees],
        steps: [
          "Answer from the record, and answer inside the request.",
        ],
        evidence:
          "The answer stays attached to the request, so it can be checked later against what the record actually said at the time. That protects you as much as the employee.",
        fn: "people_records",
      },
      {
        id: "ops-7-3",
        responsibility:
          "Track requests to closure and escalate cases that require HR judgment or management decision.",
        screens: [S.support, S.overview],
        steps: [
          "Read Open Requests, Not Yet Started and Longest Wait on HR Overview.",
          "Where a request needs a judgement call, pass it up rather than deciding it yourself.",
        ],
        evidence:
          "Longest Wait comes from the oldest open request, so one forgotten case cannot hide behind a healthy average.",
        fn: "people_records",
      },
      {
        id: "ops-7-4",
        responsibility: "Maintain professional communication through official HR channels.",
        screens: [S.support],
        steps: [
          "Reply inside the request, not beside it.",
        ],
        evidence:
          "An answer given outside the system leaves no trace, and on Phoenix a request with no saved reply is an unanswered request. That is how it will look to whoever reviews it.",
        fn: "people_records",
      },
    ],
  },
  {
    number: 8,
    title: "Phoenix, HR Data & Process Control",
    mode: "system",
    lines: [
      {
        id: "ops-8-1",
        responsibility: "Use Phoenix as the primary source of structured HR data and keep records current.",
        screens: [S.employees, S.overview],
        steps: [
          "Put it in Phoenix first. Export to a file afterwards, only if you genuinely need one.",
        ],
        evidence:
          "Every screen in this book reads the same records. So up to date means up to date everywhere at once, not just in the copy you happen to be looking at.",
        fn: "hr_governance",
      },
      {
        id: "ops-8-2",
        responsibility: "Ensure employee status and key HR actions are reflected accurately in the system after approval.",
        screens: [S.employees, S.resignations, S.contracts],
        steps: [
          "The approval happens elsewhere. Recording it happens here, and straight away.",
        ],
        evidence:
          "The change is dated, so the gap between an approval and it being recorded is visible. That gap is exactly what produces a wrong payroll run.",
        fn: "hr_governance",
      },
      {
        id: "ops-8-3",
        responsibility: "Support data cleanup, audits and HR process automation projects.",
        screens: [S.overview, S.employees, S.attendanceDevices],
        steps: [
          "The Overview counts tell you what needs cleaning. Work them down instead of starting a survey of your own.",
          "Check Device User Mapping first. It is the one that fails without telling anybody.",
        ],
        evidence:
          "An unmapped device gives no attendance rather than an error, so this problem has no symptom until payroll. Fixing it makes attendance appear where there was none.",
        fn: "hr_governance",
      },
      {
        id: "ops-8-4",
        responsibility:
          "Maintain operational trackers only where necessary and avoid disconnected manual records when the process can be managed through the HR system.",
        screens: [S.overview],
        steps: [
          "Before you start a spreadsheet, check whether a screen already counts it. This book is that check, and every line in it names a screen.",
        ],
        evidence:
          "A spreadsheet on somebody's laptop leaves no record and does not survive the person who kept it. That is the exact problem this book was written against.",
        fn: "hr_governance",
      },
      {
        id: "ops-8-5",
        responsibility: "Report system or process gaps that could create payroll, compliance or employee-data risk.",
        screens: [S.support],
        steps: [
          "Raise it as a written request to HR, with the screen and the case that showed it to you.",
        ],
        evidence:
          "A written request outlives the conversation, the month and the person. A gap you only mentioned does not.",
        fn: "hr_governance",
      },
    ],
  },
  {
    number: 9,
    title: "Compliance & Confidentiality",
    mode: "system",
    lines: [
      {
        id: "ops-9-1",
        responsibility:
          "Support personnel administration in line with applicable Egyptian labor, social insurance and company requirements.",
        screens: [S.hiringPack, S.attendancePolicies, S.companyCalendar],
        steps: [
          "Fill Form 1 from the employee's own record. It is the social-insurance form and it has to match the file exactly.",
          "Working hours are set in Attendance Policies and the working-day calendar, not person by person.",
        ],
        evidence:
          "The form takes its figures from the record, so the government document and the personnel file cannot disagree about what someone earns or when they joined.",
        fn: "hr_governance",
      },
      {
        id: "ops-9-2",
        responsibility:
          "Maintain organized records that can support internal review, external inspection or audit when needed.",
        screens: [S.hiringDocuments, S.resignations],
        steps: [
          "File it when it happens, not when somebody asks for it.",
        ],
        evidence:
          "Every HR change writes a line in the audit trail. That trail is what an inspection actually reads, and it is written whether or not anyone expected one.",
        fn: "hr_governance",
      },
      {
        id: "ops-9-3",
        responsibility: "Handle employee information with strict confidentiality and controlled access.",
        screens: [S.employee360, S.payrollReport],
        steps: [
          "If you can open it, you are allowed to open it. Do not ask a colleague to look something up for you, and do not look something up for a colleague.",
        ],
        evidence:
          "Your account is built from a fixed list of duties, so it shows exactly what this book describes. It cannot create users or change permissions, so it cannot widen itself.",
        fn: "hr_governance",
      },
      {
        id: "ops-9-4",
        responsibility:
          "Escalate legal, disciplinary or policy-sensitive cases rather than making an independent judgment outside delegated authority.",
        screens: [S.support],
        steps: [
          "Pass it to the HR Section Head. Do not decide it, and do not hint at the answer in your reply to the employee.",
        ],
        evidence:
          "Your account cannot write to deductions, payroll or the organogram. So the decisions this line is about are not even available to be made here by mistake.",
        fn: "hr_governance",
      },
    ],
  },
];

export const HR_SEAT_WORKBOOKS: readonly SeatWorkbook[] = [
  {
    seat: "HR Operations",
    // The job description the owner supplied as "HR Operations Coordinator" moved with the seat when
    // he renamed it HR Generalist on 2026-10-20; only the title changed.
    jobTitle: "HR Generalist",
    mission:
      "Own the day-to-day operating discipline of the HR function. The HR Generalist ensures employee records, attendance, leave, contracts, payroll inputs, onboarding/offboarding, HR requests and system data are complete, accurate, approved and traceable. The role is designed to make HR operations reliable: every action should have a clear owner, deadline, document, system record and follow-up status.",
    sections: OPS_SECTIONS,
    boundaries: [
      "The role is responsible for operational control, preparation and verification — not final policy decisions.",
      "May prepare documents, update approved records, follow up employees/managers, reconcile data and return incomplete requests for correction.",
      "May flag payroll, attendance, contract, file or system discrepancies and escalate them to the HR Section Head.",
      "May not independently approve salary changes, deductions, disciplinary actions, terminations, settlement exceptions, policy exceptions or organizational changes.",
      "Any sensitive employee-relations or legal case must be escalated before action is taken.",
    ],
  },
];

/** Every responsibility line in the workbook, flattened. */
export function allWorkbookLines(): readonly (WorkbookLine & { seat: HrBundleName; section: WorkbookSection })[] {
  return HR_SEAT_WORKBOOKS.flatMap((book) =>
    book.sections.flatMap((section) => section.lines.map((line) => ({ ...line, seat: book.seat, section }))),
  );
}

/** The workbook for one seat, or null for a role that has none yet. */
export function workbookForSeat(seat: string | null | undefined): SeatWorkbook | null {
  return HR_SEAT_WORKBOOKS.find((book) => book.seat === seat) ?? null;
}

/** Line counts, per seat and in total — the numbers the owner was promised. */
export function workbookLineCounts(): { bySeat: Record<HrBundleName, number>; total: number } {
  const bySeat = {} as Record<HrBundleName, number>;
  for (const book of HR_SEAT_WORKBOOKS) {
    bySeat[book.seat] = book.sections.reduce((sum, section) => sum + section.lines.length, 0);
  }
  return { bySeat, total: Object.values(bySeat).reduce((a, b) => a + b, 0) };
}

/**
 * Does this seat's bundle actually hold the function a line is mapped to?
 *
 * The reason this is a function rather than an inline check: it is the join between the workbook
 * and the permission catalogue, and it is the assertion that stops a responsibility being mapped to
 * a capability the seat was never given. A workbook that says "do this on that screen" for a screen
 * the seat cannot open is worse than no workbook — the reader believes it.
 */
export function seatHoldsFunction(seat: HrBundleName, fn: HrFunctionKey): boolean {
  return (HR_ROLE_BUNDLES[seat] as readonly HrFunctionKey[]).includes(fn);
}

// ── Part two: every other job title in the company ─────────────────────────────
//
// The owner's instruction was that the workbook covers every job description, not only the two
// being filled. Those two have a WRITTEN job description he supplied, so their workbooks are
// per-responsibility. The rest do not — and inventing responsibility lines for a role whose job
// description this system has never seen would be exactly the kind of confident fabrication a
// workbook exists to replace.
//
// So what is recorded here for the other titles is only what the SYSTEM can state truthfully: the
// access role the title carries, where that role lands on sign-in, and what the seat is for. The
// screens each one can open are DERIVED at render time from the navigation and the permission
// matrix rather than typed here, so this half of the workbook cannot go stale when a module moves.
//
// tests/hr-job-workbook.test.ts asserts this covers every entry in phoenixCompanyJobTitles, so a
// new job title added to the company cannot silently arrive without a workbook line.

export type CompanyRoleWorkbook = {
  jobTitle: PhoenixCompanyJobTitle;
  /** The access role this title carries in Phoenix. Null where the title carries no admin access. */
  role: PhoenixRole | null;
  /** What the seat is for, in one line. */
  purpose: string;
  /** Whether a written job description has been supplied for this title. */
  hasWrittenJd: boolean;
};

export const COMPANY_ROLE_WORKBOOKS: readonly CompanyRoleWorkbook[] = [
  {
    jobTitle: "HR Generalist",
    role: "HR Operations",
    purpose: "Personnel records, attendance and leave, payroll inputs, contracts, onboarding and offboarding.",
    hasWrittenJd: true,
  },
  {
    // Opened 2026-10-20 from the owner's answers in chat — no written job description was supplied,
    // so this records access and purpose only (the anti-fabrication rule below).
    jobTitle: "HR Operations Specialist",
    role: "HR Administration",
    purpose:
      "Reviews the daily and weekly fingerprint and field reports and recommends deduction days for the HR Manager's decision; keeps the Employee Master, contract renewals and resignations moving — never a salary figure.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Medical Representative",
    role: "Medical Rep",
    purpose: "Field selling and doctor coverage against a call plan, on the employee portal.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Senior Medical Representative",
    role: "Medical Rep",
    purpose: "The Medical Representative role at a seniority grade: same list, same portal, same work.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "District Sales Manager",
    role: "District Manager",
    purpose: "Runs a district team: plan approval, coaching, double visits and territory performance.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Senior District Manager",
    role: "District Manager",
    purpose: "The District Sales Manager seat at a seniority grade: same district, same authority.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "National Sales Manager",
    role: "National Sales Manager",
    purpose: "Owns a line nationally: targets, achievement, outstation and the approval chain above district level.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Product Manager",
    role: "Product Manager",
    purpose: "Owns products within a line: marketing requests, ROI and product performance.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Group Product Manager",
    role: "Group Product Manager",
    purpose: "Owns a product group across lines, with the marketing decision authority above Product Manager.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "SFE Manager",
    role: "SFE Manager",
    purpose: "Sales-force effectiveness: CRM integrity, coverage, coaching and field compliance.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Training Manager",
    role: "Training Manager",
    purpose: "Field training and probation assessment for new joiners.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Marketing Manager",
    role: "Marketing Manager",
    purpose: "Marketing requests, customer validation and campaign ROI across lines.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Finance Manager",
    role: "Finance Manager",
    purpose: "Payroll, payslips, expenses and the finance side of leave and settlements.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Financial Advisor",
    role: "Financial Advisor",
    purpose: "Advisory finance access with the standard employee self-service floor.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "CEO",
    role: "CEO",
    purpose: "Company-wide read: sales, payroll, people, probation and the executive command centre.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "HR Manager",
    role: null,
    purpose:
      "A historical HR title. It carries no access role of its own — HR access is composed from functions, and the live bundles are HR Operations and the Talent Acquisition seat (HR Resourcing).",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Talent Acquisition",
    // Re-opened 2026-10-08 as the HR Resourcing seat, built from the owner's own ticks on the access
    // blueprint. The old "Talent Acquisition" ROLE retired on 2026-08-28 stays retired: this title
    // now carries a capability-keyed bundle (HR_ROLE_BUNDLES["HR Resourcing"]). No written job
    // description has been supplied for it, so it holds no responsibility lines — see the
    // anti-fabrication pin in tests/hr-job-workbook.test.ts.
    role: "HR Resourcing",
    purpose:
      "Recruiting pipeline and offers (builds and sends, never approves), CV lookup, the HR support and business-card desks, and read-only workforce context.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Office Co-ordinator",
    role: null,
    purpose:
      "Retired 2026-08-28. Its work is now the people-records, time-attendance and payroll-inputs functions inside HR Operations.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Admin Assist",
    role: null,
    purpose: "Head-office administrative support on the employee portal; no admin-shell access.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Buffet",
    role: null,
    purpose: "Head-office service staff on the employee portal; attendance and leave self-service only.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "QPPV",
    role: null,
    purpose:
      "Qualified Person for Pharmacovigilance. Reports to the R&D Manager and works in the Report It adverse-event register, which is patient data and is gated per person rather than by role.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Regulatory Affairs",
    role: null,
    purpose: "Regulatory submissions and product registration; portal self-service, no admin shell.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "R&D Manager",
    role: null,
    purpose: "Research and development, with the QPPV reporting into the seat.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Research and Development Manager",
    role: null,
    purpose: "The long spelling of R&D Manager, kept because employee records use both.",
    hasWrittenJd: false,
  },
];
