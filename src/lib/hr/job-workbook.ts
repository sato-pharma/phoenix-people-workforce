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
 * `Sato_HRBP_Job_Description_Requirements.docx` and
 * `Sato_HR_Operations_Job_Description_Requirements.docx`, both dated 2026-08-28. Nothing is
 * paraphrased, softened, merged or dropped, because the count is the promise: 29 lines for the HR
 * Business Partner across six numbered sections, 37 for the HR Operations Coordinator across nine,
 * 66 together. tests/hr-job-workbook.test.ts asserts those three numbers and every section's own
 * line count, so a line cannot be quietly lost in an edit.
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
 * screen, none left blank."
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
  /** Stable, seat-and-section scoped: `hrbp-1-3` is the third line of HR Business Partner § 1. */
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
 * Every one of the 66 responsibilities has a real screen behind it — that is what the "none left
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

const S = {
  approvalsHub: { href: "/hr/admin/approvals-hub", label: "Other Approvals" },
  attendance: { href: "/hr/attendance", label: "Attendance" },
  attendanceDayReport: { href: "/hr/attendance/employee-day-report", label: "Employee Day-by-Day Report" },
  attendanceDevices: { href: "/hr/attendance/device-user-mapping", label: "Device User Mapping" },
  attendanceExceptions: { href: "/hr/attendance/exceptions", label: "Attendance Exceptions" },
  attendanceMonthly: { href: "/hr/attendance/monthly-summary", label: "Monthly Summary" },
  attendancePolicies: { href: "/hr/attendance/policies", label: "Attendance Policies" },
  clearance: { href: "/hr/clearance", label: "Clearance" },
  coaching: { href: "/hr/coaching", label: "Field Coaching" },
  companyCalendar: { href: "/hr/hr-calendar", label: "Company Calendar" },
  contactReview: { href: "/hr/recruitment/contact-review", label: "Missing Contact Details" },
  contracts: { href: "/hr/contracts", label: "Contract Renewal" },
  cvDatabase: { href: "/hr/cv-database", label: "CV Database" },
  deductionsGovernance: { href: "/hr/admin/deductions-governance", label: "Deductions Governance" },
  employee360: { href: "/hr/employee-360", label: "Employee 360" },
  employees: { href: "/hr/employees", label: "Employee Directory" },
  hiringDocuments: { href: "/hr/hiring-documents", label: "Hiring Documents" },
  hiringPack: { href: "/hr/hiring-pack", label: "Contract & Form 1" },
  intakeHealth: { href: "/hr/recruitment/intake-health", label: "Inbound Intake Health" },
  leave: { href: "/hr/leave-management", label: "Leave Management" },
  offers: { href: "/hr/offers", label: "Job Offers" },
  organogram: { href: "/hr/organogram", label: "Organogram" },
  overview: { href: "/hr/admin/hr-command-center", label: "HR Overview" },
  payroll: { href: "/hr/admin/payroll-management", label: "Payroll Management" },
  probation: { href: "/hr/probation", label: "Probation" },
  recruitment: { href: "/hr/recruitment", label: "Recruitment" },
  resignations: { href: "/hr/resignations", label: "Resignations" },
  retention: { href: "/hr/retention", label: "Retention Register" },
  screening: { href: "/hr/recruitment/screening", label: "Screening" },
  support: { href: "/hr/admin/support-requests", label: "HR Support Requests" },
  vacancies: { href: "/hr/reports/vacancies", label: "Vacancies Report" },
  vacationControl: { href: "/hr/leave-management/vacation-control", label: "Vacation Control" },
} as const satisfies Record<string, WorkbookScreen>;

// ── HR Business Partner (seat: HR Advisory) — 29 lines across 6 sections ───────

const HRBP_SECTIONS: readonly WorkbookSection[] = [
  {
    number: 1,
    title: "Talent Acquisition & Workforce Support",
    // Sourcing, screening and tracking are screens; the headhunting call and the first-stage
    // interview are not.
    mode: "system-and-person",
    lines: [
      {
        id: "hrbp-1-1",
        responsibility:
          "Own sourcing and first-stage screening for approved vacancies, with strong focus on Medical Representatives, sales leadership and business-critical Head Office roles.",
        screens: [S.vacancies, S.recruitment, S.screening],
        steps: [
          "Start on the Vacancies Report. It lists the seats that are genuinely empty, taken straight from the organogram. If a job is on that list, it is real.",
          "Go to Recruitment and open that job. The people who applied are already there — CVs that arrive by email or WhatsApp are filed against the job for you.",
          "Do your first review from the Screening queue, not from your inbox. That way your yes or no is saved on the candidate.",
        ],
        evidence:
          "Every step a candidate takes is saved with your name and the time. Those same times are what the system uses to work out how long a job has been open, so the numbers always match what really happened.",
        fn: "recruiting",
      },
      {
        id: "hrbp-1-2",
        responsibility:
          "Build active talent pools by territory, line, experience level and role type instead of restarting recruitment from zero for every vacancy.",
        screens: [S.cvDatabase],
        steps: [
          "Open the CV Database and filter by region, line and job title. Those are the same things your job description asks you to organise people by.",
          "Look here before you look outside. Every CV the company has ever received is still in this list.",
          "The next time the same job opens, run the same filter again. You are not starting from zero.",
        ],
        evidence:
          "You do not have to build this list yourself. CVs that arrive by email or WhatsApp are read and filed automatically, so it keeps growing even in a quiet month.",
        fn: "recruiting",
      },
      {
        id: "hrbp-1-3",
        responsibility:
          "Use direct sourcing and headhunting for hard-to-fill positions, not only job-post applications.",
        screens: [S.cvDatabase, S.intakeHealth],
        steps: [
          "Add the person yourself in the CV Database when they came from a referral or you found them directly.",
          "If a CV has no phone number or email, open Missing Contact Details. The details are usually already inside the CV and just need pulling out.",
          "Check Inbound Intake Health now and then. It shows CVs that failed to come in, so you can tell a hard job from a broken email feed.",
        ],
        evidence:
          "The screen keeps 'they came to us' and 'you found them' apart, so the people you went out and found stay visible as your work.",
        fn: "recruiting",
      },
      {
        id: "hrbp-1-4",
        responsibility:
          "Provide qualified shortlists with clear screening notes, salary expectations, availability, location fit and risk flags.",
        screens: [S.screening, S.cvDatabase],
        steps: [
          "Write the screening note, expected salary, notice period and preferred area on the candidate. Not in a covering email, which nobody can search later.",
          "Send the shortlist to the hiring manager from the same screen.",
        ],
        evidence:
          "The manager gets it in the app and on Telegram, and the send is saved with your name and the time. So 'I never received it' is something anyone can check in seconds.",
        fn: "recruiting",
      },
      {
        id: "hrbp-1-5",
        responsibility:
          "Track vacancy ageing, interview progress, offer acceptance and joining status; escalate delays early.",
        screens: [S.vacancies, S.recruitment, S.offers, S.overview],
        steps: [
          "Vacancies Report shows how long each job has been open. Recruitment shows how far each person has reached. Job Offers shows what was sent and what came back.",
          "HR Overview is your daily view. Open Vacancies, In Screening, Interviewing, Offers Out and Hired are live numbers, and each one takes you to the screen behind it.",
          "When something is stuck, raise it in HR Support Requests. Then the delay has a name and a date on it.",
        ],
        evidence:
          "An offer saves three separate facts: sent, opened, accepted. So 'no reply' and 'he never even opened it' stop looking like the same thing.",
        fn: "recruiting",
      },
      {
        id: "hrbp-1-6",
        responsibility: "Support internship, graduate and future-talent pipelines when required.",
        screens: [S.cvDatabase, S.recruitment],
        steps: [
          "Keep graduate and intern CVs in the same CV Database, under their own job title. No separate list.",
          "When a programme is approved, open it like any other job, so the intake runs through the normal pipeline.",
        ],
        evidence:
          "You end up with the same record as a permanent hire. That is what lets you find last year's group when this year's programme opens.",
        fn: "recruiting",
      },
    ],
  },
  {
    number: 2,
    title: "Employee Engagement & Field–HQ Partnership",
    // The request queue IS the channel, but being an accessible HR contact is a person.
    mode: "system-and-person",
    lines: [
      {
        id: "hrbp-2-1",
        responsibility:
          "Build regular communication channels with field employees and managers to identify concerns before they become resignation or performance issues.",
        screens: [S.support, S.overview],
        steps: [
          "Work the HR Support Requests queue every day. This IS the channel: an employee raises it from their own portal and it lands with you, whether they sit in Head Office or in Aswan.",
          "Look at Longest Wait on HR Overview first. A request that has been sitting for weeks is the problem that turns into a resignation.",
        ],
        evidence:
          "Every request keeps its whole conversation, so nothing depends on someone remembering what was said — including after you have moved on.",
        fn: "engagement_retention",
      },
      {
        id: "hrbp-2-2",
        responsibility:
          "Act as an accessible HR contact while maintaining professional boundaries, confidentiality and official communication standards.",
        screens: [S.support],
        steps: [
          "Reply inside the request. Not by WhatsApp, and not by personal message.",
          "Close it only when it is really finished, so the response-time numbers mean something.",
        ],
        evidence:
          "Your reply is saved with your name and the time. Once a request is closed, the answer cannot be quietly changed into a different one.",
        fn: "engagement_retention",
      },
      {
        id: "hrbp-2-3",
        responsibility:
          "Capture recurring field concerns, identify patterns, and present practical recommendations to the HR Section Head.",
        screens: [S.retention, S.overview],
        steps: [
          "Write the conversation in the Retention Register and pick a theme from the list.",
          "Then read the theme totals instead of re-reading your notes. That is exactly why the themes are a fixed list.",
        ],
        evidence:
          "You cannot count free writing, but you can count a theme. Twelve people tagged with the same one is a recommendation with a number behind it, not a feeling.",
        fn: "engagement_retention",
      },
      {
        id: "hrbp-2-4",
        responsibility:
          "Support recognition, engagement and communication initiatives that strengthen connection between employees, managers and Head Office.",
        screens: [S.retention, S.support],
        steps: [
          "Write down what you promised to do, with a date, on the conversation it came from.",
          "Let the system chase you. Overdue Follow-ups on HR Overview counts what was promised and not done.",
        ],
        evidence:
          "A promise with a date can be checked. The register will not save one without a date, so nothing quietly turns into a good intention.",
        fn: "engagement_retention",
      },
      {
        id: "hrbp-2-5",
        responsibility: "Ensure HR communication is understood by employees, not merely sent.",
        screens: [S.support],
        steps: [
          "Close a request only when the employee's own reply shows they understood the answer.",
          "If a request is reopened, treat it as useful news: the answer was sent, but it did not land.",
        ],
        evidence:
          "Reopened requests are one of the things this role is measured on, and the system counts them for you. Nobody has to report them.",
        fn: "engagement_retention",
      },
    ],
  },
  {
    number: 3,
    title: "Retention & Employee Experience",
    // A stay or exit interview is a conversation. No screen conducts one — the register proves it
    // happened and turns it into a countable theme.
    mode: "person-led",
    lines: [
      {
        id: "hrbp-3-1",
        responsibility:
          "Identify retention risks, particularly among strong performers and business-critical employees, and escalate them with evidence and recommended actions.",
        screens: [S.retention, S.overview],
        steps: [
          "Write the conversation down, set how serious the risk is, and say what you think should be done.",
          "That is all the escalating you need to do. High Retention Risk appears on HR Overview, and the HR Section Head reads it himself.",
        ],
        evidence:
          "The risk flag sits on a real conversation with a date on it, so your warning arrives with its proof attached instead of arriving as an opinion.",
        fn: "engagement_retention",
      },
      {
        id: "hrbp-3-2",
        responsibility:
          "Conduct structured stay discussions and exit interviews when assigned; summarize actionable themes rather than only collecting comments.",
        screens: [S.retention],
        steps: [
          "Choose Stay or Exit when you open the conversation. The register holds both kinds on purpose.",
          "Write what was said, then tag the themes before you close it.",
        ],
        evidence:
          "Stay and exit conversations sit in one place. So what people say while they are still here and what they say on the way out can finally be compared.",
        fn: "engagement_retention",
      },
      {
        id: "hrbp-3-3",
        responsibility:
          "Follow up onboarding quality during the first months of employment and flag early warning signs.",
        screens: [S.probation, S.retention],
        steps: [
          "Read the probation list to see everyone still inside their first months.",
          "If someone starts to struggle, open a stay conversation now. Do not wait for the probation result.",
        ],
        evidence:
          "Probation holds the manager's view. The register holds the employee's own words. Both are dated, so you can see which one came first.",
        fn: "performance_probation",
      },
      {
        id: "hrbp-3-4",
        responsibility:
          "Support practical actions that improve employee experience without creating unauthorized policy exceptions.",
        screens: [S.retention, S.support],
        steps: [
          "Write the agreed action and its follow-up date on the conversation.",
          "Anything that needs an exception goes to the HR Section Head as a request. It is not agreed in the room.",
        ],
        evidence:
          "The date is what turns a promise into something checkable. And an exception leaves a written request with a decision on it, instead of two people remembering it differently.",
        fn: "engagement_retention",
      },
    ],
  },
  {
    number: 4,
    title: "Performance, Probation & Development Follow-up",
    // The cases and their dates are screens; chasing the evaluator is a person.
    mode: "system-and-person",
    lines: [
      {
        id: "hrbp-4-1",
        responsibility:
          "Coordinate probation and performance follow-up cycles with managers and ensure required evaluations are completed on time.",
        screens: [S.probation, S.overview],
        steps: [
          "Read the case list: who is due, who is late, and which manager each case is waiting for.",
          "Chase that manager. Awaiting Decision on HR Overview is the same number he is being judged on.",
        ],
        evidence:
          "Late is worked out from each case's own dates, not from anyone's memory. So a cycle cannot be called on time just because nobody kept a list.",
        fn: "performance_probation",
      },
      {
        id: "hrbp-4-2",
        responsibility: "Track action plans, performance improvement plans and agreed follow-up dates.",
        screens: [S.probation],
        steps: [
          "Open the case to see the assessment, anything attached to it, and what was agreed.",
          "Follow up on the dates the case already carries.",
        ],
        evidence:
          "The plan lives on the case, not in a document on somebody's laptop. So whoever picks the case up gets the plan with it.",
        fn: "performance_probation",
      },
      {
        id: "hrbp-4-3",
        responsibility:
          "Support managers with structured documentation and employee communication while keeping final HR decisions with the HR Section Head.",
        screens: [S.probation, S.support],
        steps: [
          "Point the manager at the evaluation form. The form is the structure, and it is the same for everyone.",
          "Anything that needs a decision goes to the HR Section Head in writing.",
        ],
        evidence:
          "Your account can read every probation case and cannot record the result. That is deliberate: you run the process, the manager makes the call.",
        fn: "performance_probation",
      },
      {
        id: "hrbp-4-4",
        responsibility: "Coordinate with Training and business leaders when development needs are identified.",
        screens: [S.coaching, S.support],
        steps: [
          "Read the field coaching evaluations for that rep. They are what the manager actually saw in the field, not a summary written afterwards.",
          "Send the training need to Training as a written request.",
        ],
        evidence:
          "Each coaching evaluation carries the manager's name and the date, so a training need points back to a real visit rather than to a reputation.",
        fn: "performance_probation",
      },
    ],
  },
  {
    number: 5,
    title: "HR Business Partnering & Workforce Insight",
    mode: "system",
    lines: [
      {
        id: "hrbp-5-1",
        responsibility:
          "Understand sales-force structure, territories, vacancies, reporting lines and business priorities so HR support reflects operational reality.",
        screens: [S.organogram, S.vacancies],
        steps: [
          "Before answering any question about structure, open the organogram and look at the seat, its manager and its line.",
          "Open the Vacancies Report to see what is genuinely empty.",
        ],
        evidence:
          "The organogram is the one place the company's structure lives. A vacancy exists because a seat exists and nobody is sitting in it, so the two screens can never disagree.",
        fn: "workforce_insight",
      },
      {
        id: "hrbp-5-2",
        responsibility:
          "Use HR data to identify turnover, vacancy, attendance, performance or engagement patterns that need management attention.",
        screens: [S.overview, S.vacancies, S.attendance, S.retention],
        steps: [
          "Start on HR Overview. It is built from your own responsibilities, so everything on it is something this role owns.",
          "Click a number to reach the screen behind it, instead of copying it into a file.",
        ],
        evidence:
          "Every number is worked out fresh when the page opens. Nobody typed any of it, which is why you can quote it to the CEO without checking it first.",
        fn: "workforce_insight",
      },
      {
        id: "hrbp-5-3",
        responsibility:
          "Prepare concise people insights and recommendations for the HR Section Head and relevant managers.",
        screens: [S.overview, S.retention],
        steps: [
          "Give the number, then the theme, then what you suggest. In that order.",
          "Say which screen it came from, so the reader can see it for themselves.",
        ],
        evidence:
          "A recommendation with a count behind it can be checked by whoever receives it. One built on a feeling cannot, and that is the whole difference.",
        fn: "workforce_insight",
      },
      {
        id: "hrbp-5-4",
        responsibility:
          "Support organizational changes, transfers and manpower discussions with accurate employee and vacancy information.",
        screens: [S.organogram, S.vacancies, S.employee360],
        steps: [
          "Bring the numbers. The structure change itself is made by someone else.",
          "Check Employee 360 before you say anything about a specific person.",
        ],
        evidence:
          "Your account cannot change the organogram. So the information you give and the structure it describes can never drift apart because of an edit you made.",
        fn: "workforce_insight",
      },
      {
        id: "hrbp-5-5",
        responsibility:
          "Challenge incomplete or inconsistent information professionally and validate facts before escalating a case.",
        screens: [S.overview, S.organogram, S.contactReview],
        steps: [
          "Check the record before you repeat what you were told. No Manager Set on HR Overview is the most common example.",
          "If a candidate has gone quiet, check Missing Contact Details before deciding they lost interest.",
        ],
        evidence:
          "The incomplete-record counts come from the directory itself. So 'his manager is wrong' is settled with one click instead of an argument.",
        fn: "workforce_insight",
      },
    ],
  },
  {
    number: 6,
    title: "HR Governance, Systems & Documentation",
    mode: "system",
    lines: [
      {
        id: "hrbp-6-1",
        responsibility:
          "Maintain recruitment, engagement, probation and employee-relations actions accurately on Phoenix and approved HR trackers.",
        screens: [S.recruitment, S.retention, S.support],
        steps: [
          "Write the action on the screen where it happened, at the time it happened.",
          "Do not keep your own private tracker beside it. If something is worth tracking, it has a screen, and this book names it.",
        ],
        evidence:
          "Each of these saves a line with your name and the time. That line is what an inspection reads. A spreadsheet is not.",
        fn: "hr_governance",
      },
      {
        id: "hrbp-6-2",
        responsibility: "Ensure important employee conversations and decisions are documented through official channels.",
        screens: [S.retention, S.support],
        steps: [
          "Conversations go in the register. Requests go in the request queue. Neither goes in a personal message.",
        ],
        evidence:
          "Your account cannot delete a retention conversation, and that is on purpose: the conversation is the proof behind the turnover numbers the CEO reads.",
        fn: "hr_governance",
      },
      {
        id: "hrbp-6-3",
        responsibility: "Protect confidential employee and company information at all times.",
        screens: [S.employee360, S.retention],
        steps: [
          "If you can open it, you are allowed to open it. Your account only shows you what this role is meant to see.",
        ],
        evidence:
          "Employee 360 shows you Medical Reps and yourself, nobody else. The retention register needs a permission only you and the CEO hold. Neither one depends on you remembering a rule.",
        fn: "hr_governance",
      },
      {
        id: "hrbp-6-4",
        responsibility:
          "Follow approved HR policies and escalation paths; do not make commitments outside delegated authority.",
        screens: [S.offers, S.support],
        steps: [
          "You write the offer and send it. Approving the terms is not yours to do.",
          "Escalate in writing, so it exists whether or not anyone answers.",
        ],
        evidence:
          "Your account cannot approve an offer at all. An offer outside the agreed range simply cannot go out from here, which is safer than a rule asking you not to send one.",
        fn: "hr_governance",
      },
      {
        id: "hrbp-6-5",
        responsibility: "Contribute ideas for simplifying and digitizing HR workflows.",
        screens: [S.support],
        steps: [
          "Raise it as a written request to HR, instead of mentioning it in passing.",
        ],
        evidence:
          "A written idea outlives the conversation and the person who had it. This book exists because an earlier one did not.",
        fn: "hr_governance",
      },
    ],
  },
];

// ── HR Operations Coordinator (seat: HR Operations) — 37 lines across 9 sections

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
        screens: [S.attendance, S.attendanceExceptions, S.approvalsHub],
        steps: [
          "Work the exception queue. It is simply the list of days the rules could not settle on their own.",
          "Decide excuses and permission requests in Other Approvals. They arrive there from the employees' own portals.",
        ],
        evidence:
          "Every decision is saved with your name and the date, right beside the fingerprint record it was about. So it can be read back years later with the same facts in front of you.",
        fn: "time_attendance",
      },
      {
        id: "ops-2-2",
        responsibility:
          "Identify unexplained absences, missing punches or inconsistent records and follow up with the employee/manager before payroll closure.",
        screens: [S.attendanceExceptions, S.attendanceDayReport],
        steps: [
          "Open the day in the Employee Day-by-Day Report. It shows one person, any dates you choose, every day in full.",
          "Accept or cancel that day's fingerprint deduction on the same screen, before the month closes.",
        ],
        evidence:
          "Payroll uses days you have decided, not raw fingerprint data. So a day nobody looked at shows up as undecided instead of quietly becoming a deduction.",
        fn: "time_attendance",
      },
      {
        id: "ops-2-3",
        responsibility: "Maintain leave balances and ensure approved leave is correctly recorded in the system.",
        screens: [S.leave, S.vacationControl],
        steps: [
          "Approve or refuse the request in Leave Management. The balance updates itself from your decision.",
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
        screens: [S.attendanceMonthly, S.attendance, S.support],
        steps: [
          "Close the exceptions first, then read the Monthly Summary. In that order, or the summary is describing a month that is still moving.",
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
        screens: [S.employees, S.attendance, S.leave, S.payroll],
        steps: [
          "Fix the record, never the payroll sheet. A joining date belongs on the employee. A leaving date on the resignation. A deduction on the decided day. Unpaid leave on the leave record.",
          "Then open Payroll Management and check the run picked your change up.",
        ],
        evidence:
          "There is no separate payroll input file to keep in step, because payroll reads the records themselves. That is why this account has no write access to payroll.",
        fn: "payroll_inputs",
      },
      {
        id: "ops-3-2",
        responsibility: "Reconcile payroll inputs against approved HR documents before submission.",
        screens: [S.payroll, S.deductionsGovernance, S.hiringDocuments],
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
        screens: [S.deductionsGovernance, S.attendanceDayReport],
        steps: [
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
        screens: [S.payroll, S.support],
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
          "Use Contract & Form 1 for the document itself, so it fills from the record instead of from an old copy.",
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
          "Every upload is dated, so 'it was ready before he started' is a fact anyone can check rather than a claim.",
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
    title: "Resignation, Clearance & Offboarding",
    // The checklist opens itself and refuses release on its own; chasing seven departments does not.
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
        screens: [S.clearance],
        steps: [
          "The clearance checklist opens by itself when you record the resignation, with all seven departments already on it.",
          "Chase each department and record its answer as it comes back.",
        ],
        evidence:
          "Each answer carries who gave it and when. So 'IT cleared him' is a record, not something somebody remembers.",
        fn: "people_records",
      },
      {
        id: "ops-6-3",
        responsibility:
          "Ensure company assets, documents and required approvals are addressed before final settlement processing.",
        screens: [S.clearance],
        steps: [
          "Release is the last step, and the system refuses it until every department has answered.",
        ],
        evidence:
          "That refusal happens in the database, not on the page, and it names the departments still open. So it cannot be got round by reloading, and it tells you exactly who to chase.",
        fn: "people_records",
      },
      {
        id: "ops-6-4",
        responsibility:
          "Maintain accurate records for resignations, terminations, non-renewals and other exits.",
        screens: [S.resignations, S.clearance],
        steps: [
          "Record every exit the same way, whatever the reason. That is what makes them countable afterwards.",
        ],
        evidence:
          "Your account cannot delete a resignation or a clearance. An exit record can be corrected and can never be removed, which is what both job descriptions mean by records that survive an inspection.",
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
        screens: [S.hiringDocuments, S.clearance, S.resignations],
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
        screens: [S.employee360, S.payroll],
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
    seat: "HR Advisory",
    jobTitle: "HR Business Partner",
    mission:
      "Act as the people partner connecting Sato Pharma’s business leaders, field teams and Head Office with HR. The role combines talent acquisition, employee engagement, retention, performance follow-up and practical business partnering. It is a hands-on HR role: the successful candidate is expected to understand what is happening in the field, translate business needs into people actions, and follow through until actions are completed and documented.",
    sections: HRBP_SECTIONS,
    boundaries: [
      "This role owns execution and recommendation — not unauthorized final decisions.",
      "May source, screen, coordinate, interview at first stage, recommend, follow up and prepare documentation within approved processes.",
      "May raise concerns, retention risks and recommended people actions directly to the HR Section Head.",
      "May not independently approve headcount, salary changes, policy exceptions, disciplinary penalties, terminations, organizational changes, or offers outside approved ranges.",
      "Sensitive employee relations, final hiring decisions for key roles, compensation and policy decisions remain subject to the HR Section Head and relevant management approval.",
    ],
  },
  {
    seat: "HR Operations",
    jobTitle: "HR Operations Coordinator",
    mission:
      "Own the day-to-day operating discipline of the HR function. The HR Operations Coordinator ensures employee records, attendance, leave, contracts, payroll inputs, onboarding/offboarding, HR requests and system data are complete, accurate, approved and traceable. The role is designed to make HR operations reliable: every action should have a clear owner, deadline, document, system record and follow-up status.",
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
    jobTitle: "HR Business Partner",
    role: "HR Advisory",
    purpose: "Recruitment, engagement, retention, probation follow-up and workforce insight.",
    hasWrittenJd: true,
  },
  {
    jobTitle: "HR Operations Coordinator",
    role: "HR Operations",
    purpose: "Personnel records, attendance and leave, payroll inputs, contracts, onboarding and offboarding.",
    hasWrittenJd: true,
  },
  {
    jobTitle: "Medical Representative",
    role: "Medical Rep",
    purpose: "Field selling and doctor coverage against a call plan, on the employee portal.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "District Sales Manager",
    role: "District Manager",
    purpose: "Runs a district team: plan approval, coaching, double visits and territory performance.",
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
      "A historical HR title. It carries no access role of its own — HR access is composed from functions, and the two live bundles are HR Advisory and HR Operations.",
    hasWrittenJd: false,
  },
  {
    jobTitle: "Talent Acquisition",
    role: null,
    purpose:
      "Retired 2026-08-28. Held recruiting only; its work is now the recruiting function inside HR Advisory. Kept because employee records, offers and applications still name it historically.",
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
