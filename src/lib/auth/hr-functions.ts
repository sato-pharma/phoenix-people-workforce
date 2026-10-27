import type { PermissionAction, PermissionResource, PhoenixCompanyJobTitle } from "@/lib/auth/permissions";

/**
 * HR FUNCTIONS — the unit an HR seat is built from.
 *
 * ## Why this file exists
 *
 * Twice now a person's JOB TITLE has been used as the system's permission key, and twice the key
 * was stranded when the person left. "HR Specialist" was retired in June 2026
 * (20260612042046_retire_hr_specialist_role.sql) and replaced with "Talent Acquisition" — which
 * repeated the same mistake with a different noun, and had to be retired in turn when that seat
 * was vacated in August. Each retirement was a codebase-wide rename plus an eleven-table migration.
 *
 * The owner's instruction (2026-08-28) is to stop describing HR seats as job titles and start
 * describing them as FUNCTIONS, with a seat holding a subset:
 *
 *     "we will see the functions she will do and make, for example, six HR functions. The HR
 *      business partner have from this six, for example, four. And the operational have only
 *      two, but at the end of the day, everything."
 *
 * So this catalogue is the functions, and a role is a BUNDLE of them. The correction that produced
 * it matters as much as the result: the first pass named a role "HR Recruiting" after the largest
 * single thing the HR Business Partner does, which is the old mistake wearing a capability's
 * clothes — she also owns engagement, retention, probation follow-up and workforce insight. A
 * function is one of those; a role is the set.
 *
 * ## What this buys, concretely
 *
 * - A seat's scope changes by moving a function between bundles — one array entry, no rename.
 * - A new HR seat is a new bundle, not a new codebase-wide string.
 * - Every grant traces to a numbered section of a real job description, so "why does she have
 *   this?" has an answer that is not "someone added it in July".
 * - The role NAME carries no meaning any more, which is the point: it cannot go stale, because
 *   nothing reads it for intent.
 *
 * ## The rule that keeps it honest
 *
 * A function is a capability ("maintain personnel records"), never a person, a title, or a
 * department seat. tests/hr-function-governance.test.ts fails the build if a function key or a
 * bundle name ever collides with an entry in phoenixCompanyJobTitles.
 */

export type HrFunctionKey =
  | "recruiting"
  | "cv_lookup"
  | "engagement_retention"
  | "performance_probation"
  | "workforce_insight"
  | "hr_communication"
  | "people_records"
  | "time_attendance"
  | "payroll_inputs"
  | "hr_governance"
  | "hiring_paperwork"
  | "employee_requests"
  | "workforce_context"
  | "recognition"
  | "team_reminders"
  | "attendance_review"
  | "people_master";

export type HrFunction = {
  key: HrFunctionKey;
  /** Shown in the admin UI. Describes the capability, never the seat that holds it. */
  label: string;
  /** One line on what holding this function lets a person actually do. */
  summary: string;
  /**
   * Where this came from. Cited against the two job descriptions the owner supplied on
   * 2026-08-28, so every grant below traces to a line he signed off rather than to a session's
   * judgement. `hrbp` = HR Business Partner, `ops` = HR Operations Coordinator.
   */
  jdSections: string[];
  /** The permission-matrix entries this function contributes. Merged by union across a bundle. */
  grants: Partial<Record<PermissionResource, PermissionAction[]>>;
};

const READ_ONLY: PermissionAction[] = ["read"];
const READ_EXPORT: PermissionAction[] = ["read", "export"];
const MAINTAIN: PermissionAction[] = ["read", "create", "update", "export"];

export const HR_FUNCTIONS: readonly HrFunction[] = [
  {
    key: "recruiting",
    label: "Recruiting",
    summary:
      "Own sourcing, screening, shortlists, interviews, offers and joining status for approved vacancies.",
    jdSections: ["hrbp 1 — Talent Acquisition & Workforce Support"],
    grants: {
      // `approve` here is the act of marking an application HIRED — the final step of recruiting,
      // not an approval of someone else's request. POST /api/recruitment/applications/[id]/convert
      // asserts it; without it a seat can run a candidate through screening and interviews and
      // then be unable to finish the hire (owner-confirmed 2026-08-04, carried forward).
      // Deliberately no `delete`: removing an application or a requisition stays Super Admin.
      recruitment: ["read", "create", "update", "approve", "export", "import"],
      candidates: ["read", "create", "update", "delete", "export", "import"],
      // READ + EXPORT ONLY — deliberately not MAINTAIN. Recruiting READS the vacancy board (the
      // Vacancies Report gates on vacancies:read), and that is every vacancies action anything in
      // this codebase asserts for her. The CV Database and its template route used to be named here
      // too; both moved to recruitment:read on 2026-09-01 — she holds that in full, so this seat is
      // unaffected. `export` is left as it stands: nothing asserts vacancies:export today either,
      // and narrowing an Advisory grant is not a side effect the CV Database change gets to have.
      // `create` is asserted in exactly ONE place — POST /api/employees/[hrId]/resign — which she
      // cannot reach and must not: recording a departure is ops 6, not recruiting. Holding a grant
      // she can never spend is not harmless, it is the half-granted shape that
      // tests/hr-seat-route-coherence.test.ts exists to catch. And opening a seat that no
      // resignation emptied is the organogram, which is the Super Admin's intent alone.
      vacancies: READ_EXPORT,
      // NO `approve` on offers, ever. Both job descriptions forbid approving an offer outside the
      // approved range; the offer chain's approval step belongs to the HR Section Head and above.
      offers: MAINTAIN,
      hiring_interviews: ["read", "update"],
      // account_activation and employee_documents lived here until 2026-10-08 and moved, unchanged,
      // to `hiring_paperwork` below — see the note there for why a recruiting seat can now exist
      // without them.
    },
  },
  {
    key: "hiring_paperwork",
    label: "Hiring Paperwork",
    summary:
      "Fill the new joiner's hiring documents and HR forms, and switch their portal login on.",
    // Split out of `recruiting` on 2026-10-08, grants unchanged, when the owner built the Talent
    // Acquisition seat on the access blueprint and ticked the pipeline but NOT Hiring Documents or
    // HR Forms. Both pages, and every hiring-pack and hiring-documents route, open on
    // employee_documents — the contract, the salary on it and the national-ID paperwork — so
    // leaving these two grants inside `recruiting` would have handed his new seat exactly the
    // pages he left out. HR Advisory holds both functions, so nothing she can do changed.
    jdSections: ["hrbp 1 — Talent Acquisition & Workforce Support"],
    grants: {
      // The portal-only activate/deactivate tool for a new joiner's login. Deliberately NOT
      // user_admin, which also covers role, scope and permission changes and stays Super Admin.
      account_activation: ["read", "update"],
      // HR Forms and Hiring Documents are cards on the Recruitment & Hiring hub, and both
      // pages gate on employee_documents. hr_governance grants only read+export, so the seat that
      // runs the hire must carry the write half or it can open the contract and not fill it.
      employee_documents: MAINTAIN,
    },
  },
  {
    key: "cv_lookup",
    label: "CV Lookup",
    summary:
      "Find one candidate's CV and application by searching for them. No candidate list, no export.",
    // NOT a job-description section, and it says so rather than borrowing one. The owner asked for
    // this capability by name on 2026-09-30: "in yasmeen el safory account i want to make
    // something that she can search the cvs in admin account and finds only what it search for i
    // dont want her to have access to all cvs."
    jdSections: ["owner 2026-09-30 — search-only CV access for HR Operations"],
    grants: {
      // ONE grant, one action, and that is the entire function. It is deliberately NOT folded into
      // `recruiting` above: recruiting carries candidates:read/create/update/delete plus the whole
      // pipeline, and giving HR Operations that function to obtain a search box is the widening the
      // owner refused. A function of its own is also what makes the capability withdrawable in one
      // line — remove the key from her bundle and the screen, the two routes and the sidebar row
      // all close together.
      //
      // Nothing else is added here. The file behind a hit is built by the CV Lookup route, which
      // asserts THIS grant rather than `candidates:read`, so the seat needs no recruitment key to
      // open it.
      cv_lookup: READ_ONLY,
    },
  },
  {
    key: "engagement_retention",
    label: "Engagement & Retention",
    summary:
      "Field-to-HQ contact, employee concerns, retention risk, stay discussions and exit interviews.",
    jdSections: [
      "hrbp 2 — Employee Engagement & Field-HQ Partnership",
      "hrbp 3 — Retention & Employee Experience",
    ],
    grants: {
      support_requests: MAINTAIN,
      // Employee business-card change requests (name / number) — worked by HR exactly as a support
      // request is, so it traces to the same two functions (this one and people_records).
      business_card_requests: MAINTAIN,
      // NOT report_it. "Report It" is PHARMACOVIGILANCE — adverse drug reactions, seriousness
      // (death, hospitalisation, congenital anomaly), suspected medicines, patient outcomes. It is
      // regulatory patient-safety data and has nothing to do with employee concerns, despite a name
      // that reads like a grievance channel. Its `export` action is the read-EVERY-report gate
      // (canViewAllReports in src/lib/report-it/service.ts) and is held by three roles only:
      // Super Admin, CEO, Finance Manager. The retired Talent Acquisition seat never had it, and
      // handing it to HR by composition would have widened a patient-privacy boundary sideways
      // under cover of a rename. If a NAMED person in HR ever needs to see all reports, the
      // designed route is the per-person `report_it_dashboard_access` table, not a role grant.
      // Both seats still keep read+create through the self-service floor: anyone may file one.
      //
      // The structured stay/exit interview register hrbp 3 requires. Added 2026-08-28 (Phase 6),
      // exactly where the placeholder comment said it would go, and with no other edit anywhere -
      // which is the indirection paying for itself: HR Advisory holds engagement_retention, so she
      // gained the whole module from this one line.
      //
      // No `delete`. A retention conversation is the evidence behind a turnover theme, and
      // removing one silently changes a company-wide number the CEO reads.
      retention: MAINTAIN,
    },
  },
  {
    key: "hr_communication",
    label: "HR Communication",
    summary:
      "Composing and sending HR email by hand, and the templates behind it.",
    jdSections: ["hrbp 2 — Employee Engagement & Field-HQ Partnership"],
    // Added 2026-09-11. The owner asked that the HR Business Partner's mail answer to
    // HRBP@satopharma.com, and review found she had no way to send anything at all: the reply
    // address sat on a route only Super Admin could reach, so it could never fire. Told that making
    // it real meant granting `communication`, he chose to give her the composer.
    //
    // 🔴 `communication` IS MUCH WIDER THAN "SEND AN EMAIL", and there is no narrower resource.
    // The first version of this comment named only the composer and the templates; review found
    // that incomplete, and the owner had already approved the grant on that description. The full
    // picture, so the next reader does not have to rediscover it:
    //
    //   * the manual email composer and its send route (`communication: update`) — the point of it
    //   * the email TEMPLATES, including `isActive`. Deactivating one silently stops that whole
    //     class of email: setting `password_reset` inactive ends every password-reset mail
    //     company-wide, with a log line and nothing else
    //   * a template's static Cc/Bcc addresses, which are declared EXTERNAL to the Recipient
    //     Assurance Guard — so the control that normally blocks an unrecognised address is told
    //     that this one is deliberate
    //   * the Telegram admin console
    //   * /admin/notifications/email-tracking, a COMPANY-WIDE email activity log carrying the
    //     subject and recipient of payroll, resignation and offer mail. This seat holds no payroll
    //     grant and still sees that metadata
    //
    // TWO DOORS WERE CLOSED rather than accepted (owner, 2026-09-11): the 250-recipient Telegram
    // onboarding CAMPAIGN and the company-wide Telegram switch are now Super-Admin-only in
    // app/api/admin/notifications/telegram/route.ts. Both were Super-Admin-only by ACCIDENT until
    // this function existed — Super Admin was the sole holder of `communication` — and a bulk-send
    // button behind an HR seat is the standing never-fire-bulk-email rule, not a nuance.
    //
    // NOT `create`, `delete`, `approve` or `import`: nothing in the composer path asks for them,
    // and the narrower set is the one that still does the job.
    grants: {
      communication: ["read", "update"],
    },
  },
  {
    key: "performance_probation",
    label: "Performance & Probation",
    summary:
      "Probation cycles, evaluation completion, performance follow-up and action-plan tracking.",
    // Held by BOTH bundles, and that is not an oversight: the business partner drives the cycle
    // ("ensure required evaluations are completed on time") while operations administers the
    // paperwork ("ensure evaluation forms and decisions are documented"). Same Phoenix module,
    // two genuinely different jobs against it.
    jdSections: [
      "hrbp 4 — Performance, Probation & Development Follow-up",
      "ops 4 — Contracts, Probation & Employee Lifecycle",
    ],
    grants: {
      // Read is what /employee-portals/probation asserts. Write and administration stay with the
      // isProbationAdministrator roles — this is the exact grant whose absence produced 25
      // production "Forbidden: Talent Acquisition cannot read probation" errors on 2026-07-25.
      probation: READ_ONLY,
      coaching: READ_ONLY,
    },
  },
  {
    key: "workforce_insight",
    label: "Workforce Insight",
    summary:
      "Read the org structure, vacancies, turnover and attendance patterns to advise management.",
    jdSections: ["hrbp 5 — HR Business Partnering & Workforce Insight"],
    grants: {
      // READ only, across the board. This function is for understanding the workforce and
      // advising on it; changing it is people_records' job. That division is what keeps the
      // business partner inside her own boundary rule — she may not make organizational changes.
      organogram: READ_ONLY,
      employees: READ_EXPORT,
      // Read-only, and deliberately no create: the Planning Calendar is a window onto where the
      // field force will be, which is how an HR seat schedules an interview or a training day
      // without asking a manager. Submitting a plan is the field force's own job — the retired
      // seat held exactly this pair (owner, 2026-07-25).
      //
      // This clause used to end "so it does NOT reach HR Operations, who has no reason to read a
      // rep's call plan". That stopped being true on 2026-09-01, when the owner named
      // /admin/weekly-plans/calendar in his list of modules to open on the Operations seat. She now
      // holds the same READ_ONLY grant through `time_attendance` — attached there, not moved from
      // here, because this function is HR Advisory's alone and moving it would have dragged
      // organogram, employees and attendance across with it. The two copies are deliberate; the
      // reason each seat has one is different, and the comment at each says which.
      weekly_plans: READ_ONLY,
      employee_profile: READ_ONLY,
      attendance: READ_ONLY,
      overview: READ_ONLY,
      // Both added 2026-09-01 at the owner's instruction, when he asked for the HR Business
      // Partner's sidebar to carry Contract Renewal and the Company Calendar. READ only, and they
      // live in THIS function rather than in people_records because workforce_insight is held by
      // HR Advisory alone — the same reason people_records carries its own copy of `organogram`.
      //
      // contracts: she advises on renewals ("workforce insight") and cannot change one; every
      // contract WRITE stays with people_records, which is HR Operations.
      //
      // hr_calendar: read is the Company Calendar and the Field Workforce Compliance report, the
      // latter of which was already listed in her sidebar and rendered for nobody. `update` is
      // still REFUSED and must stay refused — it saves an HR decision on a compliance
      // recommendation, the PATCH accepts payroll recommendations as well as leave ones, and "may
      // not approve salary changes" is a named boundary in her job description. See the identical
      // note on people_records below, where the same refusal was reasoned out on 2026-08-28.
      contracts: READ_ONLY,
      hr_calendar: READ_ONLY,
      // Territory Management — the brick/area map. Added 2026-09-07 on the owner's instruction
      // ("territory management is not appearing in hr business partner account make it appear to
      // her"). It sits in workforce_insight rather than recruiting because it is read-only
      // understanding of how the field force is laid out, which is this function's whole remit;
      // the module's own headline question — "where should a Medical Rep hired for this area
      // actually live?" — is the one she answers when she sources for a vacancy.
      //
      // `territory` is its own resource, NOT `sales:read`. The module was gated on sales:read
      // until this change, and granting her that key would have opened Source of Sales, Monthly
      // Closing, Sales vs Target and the rest of the commercial surface as a side effect — money
      // her job description never mentions. See the note on the resource in permissions.ts.
      //
      // READ only, and there is no wider action to want: placing a pin is sales:import and
      // publishing a public preview link is sales:export, both of which stay Super Admin.
      territory: READ_ONLY,
      // The vacancy board — "vacancies" is in this function's own summary above. Added 2026-10-08
      // when the owner moved recruiting off the HR Business Partner: `recruiting` was the only
      // function carrying this read, so the move would otherwise have taken her Vacancies Report and
      // her dashboard's Vacant Seats tile with it, and he said she keeps workforce insight. READ
      // only — opening a seat is the organogram's, and `create` is a resignation, not insight.
      vacancies: READ_ONLY,
    },
  },
  {
    key: "people_records",
    label: "People Records & Lifecycle",
    summary:
      "Personnel files, master data, contracts, onboarding, resignations, offboarding and HR letters.",
    jdSections: [
      "ops 1 — Employee Records & Personnel Files",
      "ops 4 — Contracts, Probation & Employee Lifecycle",
      "ops 5 — Onboarding & Joining Administration",
      "ops 6 — Resignation & Offboarding",
      "ops 7 — Employee HR Services",
    ],
    grants: {
      employees: ["read", "create", "update", "export", "import"],
      employee_profile: ["read", "update"],
      employee_documents: MAINTAIN,
      // READ only, and added 2026-08-30 (owner: both new HR seats must see the full company
      // organogram). It lives HERE and not in workforce_insight — which is where the other seat's
      // copy comes from — because workforce_insight also carries weekly_plans, and that grant is
      // documented directly below as one that must NOT reach this seat. Moving the whole function
      // across to get one resource would have dragged it along.
      //
      // ops 5 and ops 6 are the reason it belongs to this function at all: onboarding places
      // somebody into a seat and offboarding empties one, and `vacancies: create` immediately
      // below only exists because the resignation RPC opens the seat the departure just vacated.
      // Reading the chart you are about to change is the same job.
      //
      // organogram:update stays denied to both seats through HR_ROLE_BOUNDARIES ("may not make
      // organizational changes"), which is the owner's never-change-the-skeleton rule, so this
      // grants sight of the structure and no power over it.
      organogram: READ_ONLY,
      contracts: ["read", "create", "update", "export"],
      resignations: ["read", "create", "update", "export"],
      // `vacancies: [read, create]`. The `create` half is offboarding: POST
      // /api/employees/[hrId]/resign asserts employees:update + resignations:create +
      // vacancies:create together, because the one RPC it calls —
      // phx_resign_employee_and_open_vacancy — records the departure AND opens the seat the
      // departure just emptied. Without it the seat that OWNS offboarding (ops 6) cannot record a
      // single resignation.
      //
      // `read` was ADDED 2026-09-01 on the owner's explicit instruction. It was create-only until
      // then, and this note read "the Vacancies Report and the CV Database are Advisory's
      // recruiting pages, not this seat's". He asked for the Vacancies Report in her sidebar, was
      // shown that granting it widens this seat past offboarding, and confirmed. Do not narrow it
      // back without him. The intended consequence, stated before he agreed: she can read the whole
      // company vacancy board.
      //
      // The OTHER consequence was that the CV Database rode this same resource and came with it —
      // and he refused that outright the same day: "block the cv database for her too". So the CV
      // Database, its portal mirror and its template route moved to recruitment:read, which she does
      // not hold. **Do not re-gate any of them on `vacancies` to make a screen appear** — that is
      // the exact edit this grant makes tempting and the one he ruled out.
      //
      // Still NOT `export`: nothing in this codebase asserts vacancies:export at all, so adding it
      // would be a grant she could never spend, which
      // is the half-granted shape tests/hr-seat-route-coherence.test.ts exists to catch. Still not
      // organizational change either — organogram:update stays denied to both seats, and the
      // resignation path can only ever fire for a person who is actually leaving.
      vacancies: ["read", "create"],
      // READ ONLY, and `update` was CONSIDERED and REFUSED on 2026-08-28 — do not add it as a
      // convenience. hr_calendar:update gates exactly one action in this codebase: saving an HR
      // decision on a Field Workforce Compliance recommendation. That looked like hers (Workforce
      // Compliance is in her navigation, and it writes no payroll or leave action — the UI says so
      // outright). But the PATCH accepts ANY recommendationKey, and the report carries payroll
      // recommendations beside the leave ones; only the CLIENT hides the payroll half from a viewer
      // without payroll standing. So the grant cannot be scoped to the half that is hers, and
      // "may not approve salary changes" is a named boundary in both job descriptions.
      // The refusal is already a clean one — the route returns "You do not have access to update
      // Field Workforce Compliance decisions.", not a raw Forbidden string — so the page reads as a
      // boundary rather than a fault. If the owner wants her deciding LEAVE recommendations, the
      // fix is to split the decision path by recommendation kind first, then grant.
      hr_calendar: READ_ONLY,
      support_requests: MAINTAIN,
      // Business-card change requests edit a person's name and number on file — master data.
      business_card_requests: MAINTAIN,
      // ops 6 - Resignation & Offboarding. Added 2026-08-28 (Phase 6), renamed from `clearance`
      // on 2026-09-01 when the Clearance & Offboarding module was removed at the owner's
      // instruction. This is the half of ops 6 that had nowhere to live: `resignations` records
      // that someone left, and nothing recorded whether his company mailbox was actually closed.
      //
      // MAINTAIN, not allActions, and it does NOT reach payroll. "May not approve final
      // settlement" is a named boundary in this same job description and stays enforced by the
      // payroll entries in HR_ROLE_BOUNDARIES.
      mailbox_offboarding: MAINTAIN,
      // The other half of ops 6, and of ops 1 at the other end of the arc. HR Operations already
      // prints the custody receipt (إقرار استلام عهدة) out of the hiring pack when somebody joins
      // and collects the device back when they leave — this is the register behind that paper, so
      // the grant follows the work rather than creating a new one.
      //
      // MAINTAIN, and it does NOT reach payroll, which matters more here than it does above:
      // البند (10) of the receipt lets an unreturned device be recovered by deduction from wages,
      // and "may not approve final settlement" is a named boundary in this same job description.
      // Recording that a device did not come back is hers; deciding what leaves somebody's pay
      // packet is not, and the payroll entries in HR_ROLE_BOUNDARIES keep it that way.
      company_devices: MAINTAIN,
      // NO `delete` anywhere in this function. Removing an employee, a contract or a resignation
      // destroys a personnel record, and both job descriptions require records that "can support
      // internal review, external inspection or audit". Deletion stays Super Admin.
    },
  },
  {
    key: "time_attendance",
    label: "Time & Attendance",
    summary:
      "Attendance review, missing punches, permissions, excuses and leave balances up to payroll cutoff.",
    jdSections: ["ops 2 — Attendance, Leave & Working-Time Administration"],
    grants: {
      attendance: MAINTAIN,
      leave: MAINTAIN,
      // READ ONLY, added 2026-09-01 on the owner's explicit instruction, to open the Planning
      // Calendar (/admin/weekly-plans/calendar) in her sidebar. That page is the field force's
      // submitted weekly and monthly plans, the official holidays, and the conflicts between them —
      // working-time administration, which is this function's own JD line, which is why the grant
      // is attached HERE rather than invented as a new function or borrowed from workforce_insight
      // (HR Advisory's, and the reason this resource was absent from this bundle until now).
      //
      // He was told before agreeing that it lets her see where every medical rep plans to be.
      //
      // READ and nothing else: approving or rejecting a plan belongs to the sales ladder, and this
      // seat holds no weekly_plans write action of any kind. The plans LIST at /admin/weekly-plans
      // opens on this same grant and is deliberately NOT linked for her — it is the approval
      // workspace, not a calendar. That needs no reachability-backlog entry: the reverse guard is
      // keyed by route and the admin shell already offers that address to other roles.
      weekly_plans: READ_ONLY,
    },
  },
  {
    key: "payroll_inputs",
    label: "Payroll Inputs",
    summary:
      "Prepare and reconcile the HR inputs that feed payroll, and check them against approved documents.",
    jdSections: ["ops 3 — Payroll HR Inputs & Monthly Closure"],
    grants: {
      // READ on payroll and deductions, and nothing else. The JD says "prepare and validate HR
      // inputs" and "ensure no deduction is processed without evidence and approval" — that is
      // reconciliation against the payroll run, not authority over it. Publishing a deduction
      // stays with the owner (standing rule: never auto-publish deductions), and approving a
      // salary change is a named boundary in this same JD. HR_ROLE_BOUNDARIES below is what
      // mechanically holds this line.
      payroll: READ_EXPORT,
      deductions: READ_ONLY,
      payslips: READ_EXPORT,
    },
  },
  {
    key: "hr_governance",
    label: "HR Governance & Data Control",
    summary:
      "Keep HR actions recorded on Phoenix, protect confidential data, and report process gaps.",
    // Held by both bundles: both job descriptions carry an explicit governance section, and both
    // make the same demand — that the system, not a private spreadsheet, is where HR actions live.
    jdSections: [
      "hrbp 6 — HR Governance, Systems & Documentation",
      "ops 8 — Phoenix, HR Data & Process Control",
      "ops 9 — Compliance & Confidentiality",
    ],
    grants: {
      employee_documents: READ_EXPORT,
      // NOT report_it — see engagement_retention above. Both job descriptions ask HR to "report
      // process gaps", and this file briefly read that as the Report It module; it is the adverse
      // drug reaction register. The HR route for a process gap is support_requests.
      overview: READ_ONLY,
    },
  },
  {
    key: "employee_requests",
    label: "Employee Requests",
    summary:
      "Work the two desks an employee raises a request at: HR support and business cards.",
    // The Talent Acquisition seat, specified by the owner on the access blueprint on 2026-10-08.
    // He ticked HR Support Requests and Business Card Requests and left Retention Register out, so
    // this is NOT engagement_retention: that function carries `retention` beside these two, and
    // handing it over would have opened stay discussions and exit interviews to a seat he never
    // gave them to. A function of its own is the narrowest thing that serves his ticks.
    jdSections: ["owner 2026-10-08 — Talent Acquisition access blueprint"],
    grants: {
      support_requests: MAINTAIN,
      business_card_requests: MAINTAIN,
    },
  },
  {
    key: "workforce_context",
    label: "Workforce Context",
    summary:
      "Read the organogram, the planning and HR calendars, the punctuality boards, the KPIs board and the probation dashboard. No personnel records.",
    // The same blueprint. He ticked Organogram, Planning Calendar, HR Calendar, Early Birds and
    // Phoenix Ranks, and did NOT tick Employees, Contract Renewal, Territory Management or any
    // command centre. workforce_insight carries every one of those (employees, contracts,
    // territory, overview), so it is deliberately not reused: this is its read-only context half
    // without the records, which is exactly the line his ticks drew.
    jdSections: ["owner 2026-10-08 — Talent Acquisition access blueprint"],
    grants: {
      organogram: READ_ONLY,
      weekly_plans: READ_ONLY,
      hr_calendar: READ_ONLY,
      early_birds: READ_ONLY,
      // He ticked the Probation Decision Dashboard, Probation Analytics and the Probation hub, and
      // left the Probation Tracker out. READ only — the same grant performance_probation carries,
      // without its coaching half, which he did not tick. Company-wide reading comes from
      // canReadAllProbation (src/lib/probation/service.ts); the tracker is fenced by page
      // (src/lib/auth/seat-page-fences.ts).
      probation: READ_ONLY,
      // KPIs — call rate, coverage and frequency per rep. The owner ticked it on the blueprint and,
      // asked in chat on 2026-10-08 whether that should carry the CRM visit data behind it, answered
      // "Give her KPIs". READ only, company-wide: src/lib/crm/doctor-coverage-roles.ts places the seat
      // with the other company seats, and the board's own page gate is what this grant opens.
      crm_visits: READ_ONLY,
    },
  },
  {
    key: "recognition",
    label: "Recognition",
    summary:
      "Open Spotlight and Milestones: the company-wide recognition sheet and the anniversary and birthday keepsakes, and print them.",
    // The Talent Acquisition seat. The owner ticked both pages on the blueprint; both had been
    // narrowed by his own earlier rulings (Spotlight to Super Admin and CEO, Milestones to Super
    // Admin alone on 2026-09-23). Asked in chat on 2026-10-08 he answered "Open all four" — Needs You,
    // WhatsApp Inbox, Milestones and Spotlight — so this function carries the two that are grants.
    // READ and EXPORT, as the Super Admin holds them: printing the sheet is what both pages are for.
    jdSections: ["owner 2026-10-08 — Talent Acquisition access blueprint, confirmed in chat the same day"],
    grants: {
      spotlight: READ_EXPORT,
      milestones: READ_EXPORT,
    },
  },
  {
    key: "team_reminders",
    label: "Team Reminders",
    summary:
      "Write notes and reminders for the HR team, choose who may see each, view them as a list, a week or a month, and join the conversation under any of them.",
    // The owner, 2026-10-17: a small shared-notes module for "the HR team, Yasmin, Yomna, and me,
    // and an office coordinator that will be hired". Held by EVERY HR seat, so whoever is given
    // one joins the team without a code change. The office coordinator took the HR Operations
    // Specialist seat (HR Administration) on 2026-10-28, the owner's pick over HR Operations.
    // NOT a job-description section, and it says so rather than borrowing one.
    jdSections: ["owner 2026-10-17 — HR team reminders, shared notes and calendar"],
    grants: {
      // `read` opens the page and lets a person comment on what they may see; create / update /
      // delete act on the person's OWN items only, enforced by the service. No export and no
      // approve: nothing in this module is a record anyone signs off.
      hr_reminders: ["read", "create", "update", "delete"],
    },
  },
  {
    key: "attendance_review",
    label: "Attendance & Field Review",
    summary:
      "Review the daily and weekly fingerprint and field-visit reports and recommend deduction days, row by row, for the HR Manager to decide. Days only — never an amount, never payroll.",
    // Owner, 2026-10-20, building the HR Operations Specialist seat: "daily and weekly reports for
    // fingerprints and for the field force", from which she "recommends deductions" — every row
    // "confirm or rejct or recommend edit with reason" — and "she will never take desicion".
    jdSections: ["owner 2026-10-20 — HR Operations Specialist seat: attendance and field review"],
    grants: {
      // `update` is HER review of a row (confirm / reject / recommend an edit, with a reason) and her
      // Submit. Deciding a row is `approve`, which only the Super Admin holds; nothing here reaches
      // `deductions` or `payroll`, which HR_ROLE_BOUNDARIES keeps absent from every seat.
      hr_ops_reports: ["read", "update"],
    },
  },
  {
    key: "people_master",
    label: "People Master (No Salary)",
    summary:
      "Keep the Employee Master up to date — edit, import and export it — and follow contracts, renewals and resignations, with every salary figure withheld.",
    // Owner, 2026-10-20: "Contract renewals, resignations, Employee Master import and export, all
    // with no salary", the organogram "hides salary", renewals are "track and prepare papers", and
    // for resignations "i submit the emp resigned she recieves notification and start folloeing up
    // until he comes to office to do fillfill resignation cycle".
    jdSections: ["owner 2026-10-20 — HR Operations Specialist seat: people master without salary"],
    grants: {
      // No `create`: adding an employee stays with the HR Generalist seat and the Super Admin. The
      // salary is withheld server-side for this seat (isSalaryBlindRole), not by these actions.
      employees: ["read", "update", "export", "import"],
      organogram: READ_ONLY,
      // Track and prepare: read every contract and move it through HR review and the signed upload.
      // Creating, renewing, not renewing or cancelling one stays his decision.
      contracts: ["read", "update"],
      // Follow a resignation he submitted through to the completed cycle. No `create` (he submits)
      // and no `export` (a resignation export carries the settlement).
      resignations: ["read", "update"],
    },
  },
] as const;

/**
 * The HR seats, each as a SET OF FUNCTIONS — two opened 1 September 2026, the third (HR Resourcing,
 * shown as Talent Acquisition) on 8 October 2026.
 *
 * The bundle name is a label and carries no meaning on its own — that is deliberate, and it is
 * what stops this from going stale the way "HR Specialist" and "Talent Acquisition" both did. To
 * change what a seat can do, move a function key between these arrays. To add a seat, add a
 * bundle. Neither needs a rename, a codebase sweep, or a migration.
 *
 * Union of the seats = the WHOLE catalogue, which is the owner's "at the end of the day, everything":
 * between them the HR department is fully covered, with two functions (performance_probation,
 * hr_governance) genuinely shared because both job descriptions ask for them from different angles.
 * Rule 3 of tests/hr-function-governance.test.ts asserts that union by identity, so a function added
 * to the catalogue and handed to neither seat fails the build instead of sitting here as dead policy.
 *
 * This line used to say "all eight functions". It was already wrong when it said so — there were
 * nine — and a tenth arrived with `cv_lookup` on 2026-09-30, so the COUNT is gone rather than
 * corrected: the invariant is the union, and a number maintained by hand beside it can only go stale
 * again.
 */
export const HR_ROLE_BUNDLES = {
  // NO "HR Advisory" bundle since 2026-10-08. The owner retired the HR Business Partner seat that
  // evening: first "move recruiting off the HR Business Partner", then "no more HR business partner.
  // This title, no more … everything regarding recruiting is for the talent acquisition", and, asked
  // who takes the rest, "Leave it for system administrator now". So `recruiting` is the Talent
  // Acquisition seat's, and the four functions only she held are UNASSIGNED_HR_FUNCTIONS below.
  "HR Operations": [
    "people_records",
    "time_attendance",
    "payroll_inputs",
    "performance_probation",
    "hr_governance",
    // Added 2026-09-30 at the owner's instruction. She is NOT a recruiting seat and this does not
    // make her one: `recruiting` is the Talent Acquisition seat's, the CV Database stays shut to her
    // (tests/cv-database-recruiting-boundary.test.ts), and what she gains is a search box that
    // answers with the people she searched for and nothing else.
    "cv_lookup",
    // Added 2026-10-17 (HR team reminders, the owner's request) as a seat grant, never a
    // per-person one. The office coordinator was expected to take THIS seat; on 2026-10-28 the
    // owner put her on the HR Operations Specialist seat (HR Administration) instead.
    "team_reminders",
  ],
  // The Talent Acquisition seat, opened 2026-10-08 from the owner's own ticks on the access
  // blueprint. Shown as "Talent Acquisition" (HR_SEAT_JOB_TITLES below); keyed "HR Resourcing" so
  // the key never strands when the person changes, which is the exact failure that retired the old
  // "Talent Acquisition" role on 2026-08-28.
  //
  // `recruiting` is THIS seat's alone since 2026-10-08 — the owner moved it off the HR Business
  // Partner the same evening and then retired that seat, before this one had a holder, so until he
  // hands it out the pipeline is worked by the Super Admin alone, by his choice.
  //
  // No hiring_paperwork (he left Hiring Documents and HR Forms out), no hr_communication (he
  // answered "no" to system email), no engagement_retention, no workforce_insight, no
  // people_records, no time_attendance, no payroll_inputs.
  "HR Resourcing": [
    "recruiting",
    "cv_lookup",
    "employee_requests",
    "workforce_context",
    "recognition",
    "team_reminders",
  ],
  // Shown as HR Operations Specialist (owner, 2026-10-20). Salary-blind by name — isSalaryBlindRole.
  "HR Administration": [
    "attendance_review",
    "people_master",
    "team_reminders",
  ],
} as const satisfies Record<string, readonly HrFunctionKey[]>;

export type HrBundleName = keyof typeof HR_ROLE_BUNDLES;

/**
 * Functions NO seat holds — the Super Admin's, who holds every resource anyway.
 *
 * All four were the HR Business Partner's alone. The owner retired that seat on 2026-10-08 and,
 * asked who takes the rest of its work, answered "Leave it for system administrator now". They stay
 * in the catalogue rather than being deleted because "now" is his word: when he hands this work to a
 * seat, it is a move of a key from this list into a bundle, with every grant still traced to its
 * job-description line. Rule 3 of tests/hr-function-governance.test.ts asserts the seats plus this
 * list cover the whole catalogue, so a function cannot sit unassigned without being named here.
 */
export const UNASSIGNED_HR_FUNCTIONS: readonly HrFunctionKey[] = [
  "hiring_paperwork",
  "engagement_retention",
  "hr_communication",
  "workforce_insight",
];

/**
 * THE JOB TITLE EACH SEAT IS SHOWN AS — display only, never a key.
 *
 * The bundle names above are deliberately NOT job titles: that is the whole point of this file,
 * and `tests/hr-function-governance.test.ts` fails the build if a bundle name ever collides with
 * an entry in `phoenixCompanyJobTitles`. But a person does not think of herself as "HR Operations".
 *
 * So the two live side by side, and the split is the resolution of the tension rather than a
 * compromise with it: the bundle name stays the permission key that nothing reads for intent and
 * that can never strand when the seat changes hands, while this map is the only thing a human ever
 * sees. (The HR Business Partner title left this map when the owner retired that seat, 2026-10-08:
 * "no more HR business partner. This title, no more.") Renaming the key to the title is precisely the mistake that cost two codebase-wide renames
 * and an eleven-table migration — do not do it, and do not "simplify" this map away.
 *
 * `COMPANY_ROLE_WORKBOOKS` in `src/lib/hr/job-workbook.ts` holds the same pairing for the whole
 * company. It is not imported here on purpose — that module is ~1,300 lines of workbook prose and
 * this map is read on every authenticated page render. `tests/hr-job-workbook.test.ts` asserts the
 * two agree, so they cannot drift apart.
 */
export const HR_SEAT_JOB_TITLES = {
  // Renamed from "HR Operations Coordinator" on 2026-10-20 (owner: "make the old account HR
  // genralist" — everywhere). Display only: the key and every grant are unchanged.
  "HR Operations": "HR Generalist",
  "HR Resourcing": "Talent Acquisition",
  "HR Administration": "HR Operations Specialist",
} as const satisfies Record<HrBundleName, PhoenixCompanyJobTitle>;

/** The HR Operations Specialist seat's key, named once so no caller spells it by hand. */
export const HR_OPERATIONS_SPECIALIST_SEAT = "HR Administration" as const satisfies HrBundleName;

/**
 * The seat that never sees a salary, an allowance, an insurance or a tax amount — anywhere (owner,
 * 2026-10-20: "she never touches payroll or salary"). The one exception he made is the contract
 * renewal annex she prepares. Bank name, account and payment mode stay visible to her.
 *
 * Every server path that returns or accepts a money field asks this, so the withholding is
 * enforced where the data leaves the server — the screens only follow it.
 */
export function isSalaryBlindRole(role: string | null | undefined): boolean {
  return String(role ?? "") === HR_OPERATIONS_SPECIALIST_SEAT;
}

/**
 * The label to SHOW for a role. Returns the seat's job title for the two HR bundles and the role
 * itself for everything else — every other role key in this system already reads as a title
 * ("Finance Manager", "SFE Manager"), so this is not a company-wide relabelling and must not grow
 * into one. Takes a plain string because the callers hold `app_auth_users.role`, which is text.
 */
export function displayTitleForRole(role: string | null | undefined): string {
  const seat = String(role ?? "");
  return (HR_SEAT_JOB_TITLES as Record<string, string>)[seat] ?? seat;
}

/**
 * ROLE BOUNDARIES — the "may not approve" lists from both job descriptions, made mechanical.
 *
 * Each job description ends with a section headed "Role Boundaries & Approval Authority". Those
 * lines are what keep an HR coordinator from quietly acquiring the authority to change a salary.
 * Written here as resource:action pairs that must be ABSENT from the composed matrix, and
 * asserted in tests/hr-function-governance.test.ts — so a future session that widens a function
 * above cannot widen a bundle past its JD without turning CI red.
 *
 * This is the half a permission matrix cannot express on its own: a matrix says what a role HAS,
 * and drift happens in what nobody noticed it GAINED.
 *
 * FOUR JD BOUNDARY WORDS HAVE NO RESOURCE OF THEIR OWN — they are not missing, they are carried
 * by the resource that actually performs them. Checked against the PermissionResource union on
 * 2026-08-28: there is no `headcount`, `penalties`, `settlement` or `policy` resource, and
 * inventing one would add a permission nothing asserts.
 *
 *   "may not approve headcount"            -> organogram:update. Approving headcount IS creating a
 *                                             seat; that is the skeleton, and it stays Super Admin.
 *                                             (vacancies:create is NOT this — see people_records:
 *                                             it can only open a seat a resignation just emptied.)
 *   "may not approve disciplinary penalty" -> deductions:create/update/approve. A penalty in this
 *                                             system is money off a salary; there is no other path.
 *   "may not approve final settlement"     -> payroll:create/update/approve. A settlement is a
 *                                             payroll run for a leaver.
 *   "may not grant a policy exception"     -> NO SYSTEM ACTION EXISTS. This one is a judgement made
 *                                             in conversation, not a button. It cannot be enforced
 *                                             mechanically and is deliberately not faked here — do
 *                                             not add a resource for it to make the list look
 *                                             complete.
 */
export const HR_ROLE_BOUNDARIES: readonly {
  resource: PermissionResource;
  action: PermissionAction;
  why: string;
}[] = [
  { resource: "payroll", action: "approve", why: "may not approve salary changes (hrbp + ops)" },
  { resource: "payroll", action: "update", why: "may not change payroll figures (hrbp + ops)" },
  { resource: "payroll", action: "create", why: "may not originate a payroll run (hrbp + ops)" },
  { resource: "deductions", action: "approve", why: "may not approve deductions (ops)" },
  { resource: "deductions", action: "create", why: "may not raise a deduction (ops)" },
  { resource: "deductions", action: "update", why: "may not alter a deduction (ops)" },
  { resource: "offers", action: "approve", why: "may not approve an out-of-range offer (hrbp)" },
  { resource: "employees", action: "delete", why: "may not terminate or destroy a record (hrbp + ops)" },
  { resource: "contracts", action: "delete", why: "may not destroy a contract record (ops)" },
  { resource: "resignations", action: "delete", why: "may not destroy an exit record (ops)" },
  { resource: "mailbox_offboarding", action: "delete", why: "may not destroy the attestation that a leaver's mailbox was closed (ops)" },
  { resource: "company_devices", action: "delete", why: "may not destroy a custody record - البند (10) makes it the basis of a wage deduction, so it is both the company's claim and the employee's defence (ops)" },
  { resource: "retention", action: "delete", why: "may not destroy an exit interview - it is the evidence behind a turnover theme (hrbp)" },
  { resource: "organogram", action: "update", why: "may not make organizational changes (hrbp + ops)" },
  { resource: "user_admin", action: "read", why: "role, scope and permission admin stays Super Admin" },
  { resource: "permission_admin", action: "read", why: "may not grant permissions (hrbp + ops)" },
  { resource: "workflow_registry", action: "read", why: "may not change approval chains" },
  { resource: "admin_access", action: "read", why: "may not reach the admin access console" },
  { resource: "system_cleanup", action: "read", why: "may not run destructive maintenance" },
  // Added 2026-08-28 after this list FAILED to catch a real over-grant. Two functions here granted
  // report_it:export, which is the read-EVERY-adverse-drug-reaction-report gate, not an HR one —
  // "Report It" is pharmacovigilance (seriousness, suspected medicines, patient outcomes) and the
  // name simply reads like a grievance channel. tests/report-it-access.test.ts caught it, having
  // pinned that privacy boundary long before either HR seat existed. The lesson is the entry: a
  // boundary list built only from what the job descriptions FORBID misses what they never mention.
  { resource: "report_it", action: "export", why: "may not read every adverse-event report — that is patient data, three roles only" },
];

/**
 * What every HR seat holds as an EMPLOYEE of the company, before any HR function is added.
 *
 * This is not an HR function and must never be listed in HR_ROLE_BUNDLES: it is the same
 * self-service floor Financial Advisor carries (permissions.ts) — open your own payslip, request
 * your own vacation, edit your own profile, raise your own IT ticket. It is separated out because
 * composing a role purely from HR functions produces a seat that can administer everyone else's
 * leave and payslip and not reach her own, which is invisible in a permission table and immediate
 * on the first day: /payslips throws an uncaught Forbidden rather than rendering an empty state.
 *
 * That is exactly what the composed HR Advisory bundle did before this constant existed — she held
 * no payslips and no leave at all, because neither recruiting nor governance is an employee duty.
 */
const HR_SEAT_SELF_SERVICE: Partial<Record<PermissionResource, PermissionAction[]>> = {
  // Own payslip only. The Payslips Center's data gate is getPayrollScope, and the document export
  // is canExportPayslipDocument (Super Admin + Finance Manager) — neither is opened by this.
  payslips: READ_EXPORT,
  // Request and withdraw her own leave. NOT update/approve: approving leave is time_attendance,
  // which only HR Operations holds.
  leave: ["read", "create"],
  employee_profile: ["read", "update"],
  // Her own incentive page. permissions.ts derives incentive:read for every role holding
  // employee_profile:read; naming it here keeps it traceable to this floor, which the HR function
  // governance test requires of every grant on an HR seat.
  incentive: READ_ONLY,
  attendance: READ_ONLY,
  overview: READ_ONLY,
  report_it: ["read", "create"],
  support_requests: ["create"],
  // Request her own business card. applyHardPermissionBoundaries SETS this sender `create` on every
  // role that is not an HR authority (the same shape as support_requests above), so naming it here
  // changes no grant — it keeps the HR Operations Specialist seat, the first seat outside
  // hrAuthorityRoles, traceable to this floor, which rule 6 of tests/hr-function-governance.test.ts
  // requires of every grant an HR seat holds.
  business_card_requests: ["create"],
};

const FUNCTIONS_BY_KEY = new Map(HR_FUNCTIONS.map((fn) => [fn.key, fn]));

export function getHrFunction(key: HrFunctionKey): HrFunction {
  const found = FUNCTIONS_BY_KEY.get(key);
  // Not reachable through the type system, but this file is also read by the admin UI and by the
  // migration generator, both of which can hand it a string that came from the database.
  if (!found) throw new Error(`Unknown HR function "${key}".`);
  return found;
}

/**
 * Compose a bundle's function keys into a permission-matrix entry.
 *
 * Grants UNION across HR_SEAT_SELF_SERVICE and every named function: two functions naming the same resource contribute the union of
 * their actions, so holding workforce_insight (employees: read, export) alongside people_records
 * (employees: read, create, update, export, import) yields the wider set rather than whichever
 * happened to be listed last. That ordering-independence is the property worth having — it means
 * reordering HR_ROLE_BUNDLES can never silently change what a seat can do.
 */
export function composeHrRoleGrants(
  keys: readonly HrFunctionKey[],
): Partial<Record<PermissionResource, PermissionAction[]>> {
  const merged = new Map<PermissionResource, Set<PermissionAction>>();
  // The self-service floor first, so a function that also names one of these resources widens it
  // rather than being widened by it — the union makes the order irrelevant, but reading it in this
  // order matches the intent: she is an employee first, then an HR seat.
  for (const [resource, actions] of Object.entries(HR_SEAT_SELF_SERVICE)) {
    merged.set(resource as PermissionResource, new Set(actions ?? []));
  }
  for (const key of keys) {
    for (const [resource, actions] of Object.entries(getHrFunction(key).grants)) {
      const bucket = merged.get(resource as PermissionResource) ?? new Set<PermissionAction>();
      for (const action of actions ?? []) bucket.add(action);
      merged.set(resource as PermissionResource, bucket);
    }
  }
  const composed: Partial<Record<PermissionResource, PermissionAction[]>> = {};
  for (const [resource, actions] of merged) {
    composed[resource] = [...actions];
  }
  return composed;
}

/** The composed matrix entry for a bundle, ready to spread into permissionMatrix. */
export function hrBundleGrants(bundle: HrBundleName) {
  return composeHrRoleGrants(HR_ROLE_BUNDLES[bundle]);
}
