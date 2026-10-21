import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  composeHrRoleGrants,
  getHrFunction,
  HR_FUNCTIONS,
  HR_ROLE_BOUNDARIES,
  HR_ROLE_BUNDLES,
  UNASSIGNED_HR_FUNCTIONS,
  type HrBundleName,
  type HrFunctionKey,
} from "../src/lib/auth/hr-functions.ts";
import {
  canAccess,
  isHrAuthorityRole,
  normalizeRole,
  permissionMatrix,
  phoenixCompanyJobTitles,
  phoenixRoles,
  scopeForRole,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * HR FUNCTION GOVERNANCE
 *
 * Two mistakes are pinned here, and both have already been made in this repository.
 *
 * The FIRST is naming a permission role after whoever currently holds the job. "HR Specialist"
 * was retired in 2026-06 and "Talent Acquisition" on 2026-08-28, and each retirement cost a
 * rename across the codebase plus a multi-table migration, because a job title is a fact about a
 * person and a permission key is a fact about a capability. The owner named this explicitly on
 * 2026-08-28 as the second time the same mistake had been made. Rule 1 below is that instruction
 * made mechanical, so the third time turns a PR red instead of costing a day.
 *
 * The SECOND is a role quietly growing past what its job description says it may do. A permission
 * matrix records what a role HAS; drift lives in what nobody noticed it GAINED. Both job
 * descriptions end with a "Role Boundaries & Approval Authority" section, and HR_ROLE_BOUNDARIES
 * turns those lines into resource:action pairs that must stay ABSENT. Rule 4 asserts them against
 * the composed matrix, and rule 5 against each function on its own, so a boundary cannot be
 * breached either by widening a function or by adding it to a bundle it was never written for.
 */

/**
 * A role name that is ALSO a company job title. Each of these predates the rule and is left alone
 * deliberately: renaming a live sales role touches the organogram, the AU seat model, every stored
 * profile and years of historical records, for no security gain. The list is CLOSED and frozen at
 * 2026-08-28. It is not a precedent and nothing may be added to it, because a NEW collision is the
 * exact mistake this file exists to stop.
 */
const GRANDFATHERED_NAME_COLLISIONS: readonly string[] = [
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "Financial Advisor",
  "CEO",
];

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Retired as permission roles. Neither may return as one, under any spelling. */
const RETIRED_HR_ROLE_NAMES: readonly string[] = ["HR Specialist", "Talent Acquisition"];

/**
 * Every file that names an HR seat as a string, reviewed on 2026-08-28. Each one is access decided
 * OUTSIDE the permission matrix, so Rule 10 makes the list explicit rather than letting a by-name
 * grant arrive unnoticed. Reviewed verdicts for the ones that grant rather than describe:
 *
 *   contracts/service.ts        company-wide contract READ. `contracts:delete` stays a boundary.
 *   excuses/service.ts          company-wide excuse visibility — time & attendance is ops 3.
 *   employees/access-provisioning.ts  routes HR Operations to the CREATE-only, rank-bounded
 *                               provisioning path instead of the Super-Admin-only upsert. Narrower
 *                               than the alternative, not wider — and both admin consoles stay shut
 *                               (user_admin:read and permission_admin:read are boundaries).
 *   employee-360/access.ts      NARROWS both seats to medical-rep records only.
 *
 * The rest are navigation, notification audiences, workflow definitions and UI copy.
 */
const FILES_NAMING_AN_HR_SEAT: readonly string[] = [
  // Names both seats in DEDICATED_COMMAND_CENTER_ROLES, added 2026-08-30 when the generic Admin
  // Command Center was retired. Reviewed verdict: it REMOVES reach and can only ever remove it.
  // The set is a redirect list — a role in it is sent to resolveLandingPathForRole(role), which for
  // these two is their own /hr/admin/hr-command-center — so naming a seat here takes a page away
  // and grants nothing. The page the redirect skips was measured against production first: it
  // answered EGP 0 payroll / EGP 0 sales / EGP 0 expenses for HR Advisory and EGP 0 sales /
  // EGP 0 expenses for HR Operations, so nothing they could act on was lost with it.
  "app/(admin)/admin/page.tsx",
  // Names HR Operations in VIEW_ROLES, added 2026-09-22 with the Daily Deductions module — the
  // running-tally sibling of the month-final Deductions screen below. Reviewed verdict: it GRANTS
  // reach, and it is the string that opens the daily screen for her — the same audience
  // {Super Admin, CEO, HR Operations} as the month page, deliberately, because the two are two views
  // of the same money.
  //
  // It hands her nothing her job description withholds. payroll_inputs has granted her
  // deductions:read since the seat was composed, and this page gives her READ ONLY: the two read
  // routes (GET /publish list, GET /active) assert deductions:read, which she holds, and the page
  // passes canPublish={role === "Super Admin"} so no compute or publish control renders for her.
  // Her named boundaries — deductions:approve/create/update — all stay ABSENT and are enforced
  // server-side, not merely hidden: POST /compute asserts deductions:create, POST /publish and
  // POST /supersede assert deductions:approve, and publishDailyTally additionally asserts Super
  // Admin. So she can read a published tally and nothing else, exactly as on the month screen.
  //
  // Added to the SET rather than replaced by canAccess(access, "deductions", "read"): the Finance
  // Manager still holds that grant and the owner revoked his month screen on 2026-08-11 (excludedRoles
  // ["Finance Manager"] on the hub card), so a permission check would have handed the page back to
  // him as a side effect. HR Advisory is not here.
  "app/(admin)/admin/daily-deductions/page.tsx",
  // Names HR Operations in VIEW_ROLES, added 2026-09-03. Reviewed verdict: it GRANTS reach, and it
  // is the string that opens the Deductions screen for her — listed for exactly that reason.
  //
  // The owner asked for it in these words: "yes give HR access to the deductions screen." It hands
  // her nothing her job description withholds. payroll_inputs — cited to "ops 3 — Payroll HR Inputs
  // & Monthly Closure", whose line is "ensure no deduction is processed without evidence and
  // approval" — has granted her deductions:read since the seat was composed; only this hard-coded
  // set was refusing her, which is why the link the new deductions-comment mail carries used to
  // bounce. Her named boundaries are deductions:approve/create/update, and all three stay ABSENT:
  // Rule 4 below asserts that against the composed matrix, canDecide on the page is Super Admin
  // alone, and every mutating route asserts approve or create rather than read.
  //
  // Added to the SET rather than replaced by canAccess(access, "deductions", "read"): the Finance
  // Manager still holds that grant and the owner revoked his screen on 2026-08-11, so a permission
  // check would have handed the page back to him as a side effect. HR Advisory is not here.
  "app/(admin)/admin/deductions/page.tsx",
  "app/(admin)/admin/recruitment-hiring/page.tsx",
  "app/(admin)/attendance/page.tsx",
  // app/employee-portals/account-activation/page.tsx left this list on 2026-10-08: it named only the retired HR Advisory seat.
  // Names "HR Advisory" and "HR Business Partner" in a COMMENT only, and grants nothing.
  //
  // Reviewed verdict: it hands the seat NOTHING. The page's gate is `canSendWhatsAppTemplate`,
  // which is where the reach is decided; the string here explains why the JOB TITLE needs no entry
  // of its own — "HR Business Partner" is the title shown for the "HR Advisory" key
  // (HR_SEAT_JOB_TITLES), not a PhoenixRole — so that the next reader does not "fix" it by adding
  // a role string that matches nothing. She already held this page before the comment existed,
  // through `recruitmentManageRoles`.
  //
  // Listed rather than reworded around, because the file genuinely does discuss the seat and this
  // set is the register of exactly that.
  "app/(admin)/recruitment/whatsapp-templates/page.tsx",
  // src/lib/territory-management/service.ts left this list on 2026-10-08: it named only the retired HR Advisory seat.
  // Names HR Operations in canViewEmployeeAttendanceReport, added 2026-09-17 on the owner's ruling
  // that she sees the requester's attendance and leave history beside the requests she approves in
  // the Approvals Hub. Reviewed verdict: it GRANTS reach — one person's attendance report, anyone —
  // and is listed for exactly that reason.
  //
  // It hands her nothing her job description withholds. time_attendance ("ops 2 — Attendance, Leave
  // & Working-Time Administration") already composes attendance:MAINTAIN and leave:MAINTAIN onto
  // the seat, and people_records gives her employees:read, which already opens the WHOLE-COMPANY
  // Fingerprint Report (canAccessFingerprintReport) with every employee's punches and deductions.
  // Before this string she approved leave blind: the hub's context panel answered 403, because the
  // per-person check fell back to direct reports and she is nobody's manager.
  //
  // Named by string rather than by canAccess(access, "attendance", "read"): the Finance Manager
  // holds attendance:read and is SELF-ONLY by the owner's 2026-08-10 instruction, so a permission
  // check here would have handed every employee's workbook back to him. The bulk list scoper in the
  // same file is deliberately unchanged, and HR Advisory is not here.
  "src/lib/attendance/employee-attendance.ts",
  "src/components/admin/access-control-manager.tsx",
  "src/components/admin/workflow-registry-manager.tsx",
  // Names both seats in the Retention Register's confidentiality notice, added 2026-09-01.
  // Reviewed verdict: DISPLAY ONLY, and it describes a restriction rather than creating one. Both
  // strings are arguments to displayTitleForRole(), which turns a role KEY into the job title the
  // company actually uses — the notice renders "readable by the HR Business Partner … not visible
  // to the HR Generalist" (titled HR Operations Coordinator until 2026-10-20). Nothing branches on
  // either value: no gate, no query filter,
  // no audience list. The register's real gate is canAccess(access, "retention", "read") in
  // app/(admin)/retention/page.tsx, which this change does not touch.
  //
  // It is listed because the strings are seat names, which is what Rule 10 pins — and because the
  // notice is a CLAIM about who can read the register. If retention:read ever widens, this copy
  // starts asserting a boundary that no longer holds, so it has to be re-read rather than left.
  "src/components/retention/retention-workspace.tsx",
  // Names both seats in HR_SEAT_ROLES, added 2026-09-03 when the owner answered "HR gets the
  // deductions comment". Reviewed verdict: it is a NOTIFICATION AUDIENCE and grants nothing. The
  // two strings are the argument to `.in("role", ...)` against app_auth_users, used only to decide
  // who is mailed; no page opens, no query widens, no record is read on either seat's behalf.
  //
  // It is deliberately NOT a grant, and it did not become one when the screen opened. Told that
  // the deductions screen these emails point at gated on VIEW_ROLES = {"Super Admin", "CEO"} and
  // would bounce both seats, the owner answered "yes give HR access to the deductions screen" the
  // same day. That access was granted where access is granted — the page's role set and
  // isDeductionsReadActor, both listed below and both HR OPERATIONS ONLY. This audience list stayed
  // as it is: BOTH seats are mailed, because an employee disputing a deduction is an employee
  // concern and hrbp 2 is engagement. HR Advisory therefore reads the comment in full in the mail
  // body and her link lands on /employee-portals — the owner was told that in those words.
  //
  // Resolved by ROLE and never by job title, per the owner's rule that an HR seat is composed from
  // a function catalogue. That is not stylistic: weekly-planning's hrAcknowledgementRecipients
  // matches job_title ilike '%HR Manager%' / '%Admin HR%' and production returns ZERO employees for
  // both, so its HR leg has only ever reached Super Admins.
  "src/lib/conversations/notify.ts",
  // Names HR Operations in contractRenewalHrApproverRoles, added 2026-09-29 when the owner moved
  // the contract renewal reminders to 75/60/30/15 days and asked that they reach Yasmeena El
  // Safory. Reviewed verdict: it is a NOTIFICATION AUDIENCE and grants nothing — the same shape as
  // conversations/notify.ts above. The string is an argument to `.in("role", ...)` against
  // app_auth_users, read only to decide who the reminder is addressed to; no page opens, no query
  // widens, and no contract is read on the seat's behalf by naming her here.
  //
  // It hands her nothing her job description withholds. people_records already composes
  // `contracts: read/create/update/export` onto the seat, so the Contract Renewal page and the
  // renewal workflow were hers before this line existed — what she did not have was the reminder
  // telling her a renewal was coming. Her one named contracts boundary, `contracts:delete`, stays
  // ABSENT and is enforced by the composed matrix, not by this set.
  //
  // Resolved by ROLE and never by hr id, per the owner's rule that an HR seat is composed from a
  // function catalogue: the reminder then follows the seat when the person in it changes. HR
  // Advisory is deliberately NOT here — her contracts grant is READ_ONLY in the catalogue ("she
  // advises on renewals and cannot change one"), so a reminder whose whole subject is a pending
  // recommendation is not hers to act on, and mailing her one would assert otherwise.
  //
  // HR Administration (the HR Operations Specialist seat) joined the same list on 2026-10-20: she
  // tracks renewals and prepares their papers. Same verdict — a notification audience, granting
  // nothing. Her people_master function already composes `contracts: read/update`, and the reminder
  // carries no salary figure (its metrics are name, title, area, line, renewal date and the run).
  "app/api/notifications/contract-renewals/route.ts",
  "src/config/system-navigation.ts",
  "src/lib/admin/access-control.ts",
  // src/lib/auth/account-job-titles.ts left this list on 2026-10-08: it named only the retired HR Advisory seat.
  "src/lib/auth/hr-functions.ts",
  "src/lib/auth/permissions.ts",
  // Names HR Operations in mapPhoenixRoleToAccessScopeType, which fills the access_scope COLUMN
  // when an account is provisioned. That column is a mirror: nothing reads it back to decide
  // access, so the string grants the seat nothing. It is listed because a mirror disagreeing with
  // scopeForRole misleads anyone auditing user_access_profiles — keeping the two in step is for
  // legibility, not enforcement. SFE Manager already sits that way (scope "self", mirror
  // COMPANY_READ), which is why this is a per-seat note and not a general invariant.
  // src/config/system-settings.ts left this list on 2026-10-08: it named only the retired HR Advisory seat.
  "src/lib/auth/supabase-identity.ts",
  // Names HR Administration in isCompanyContractReader, added 2026-10-20 with the HR Operations
  // Specialist seat. Reviewed verdict: it GRANTS reach — every contract, company-wide, READ — and is
  // listed for that reason, the same verdict as HR Operations beside it. It hands her nothing her
  // brief withholds: people_master composes contracts read+update (track and prepare papers, owner,
  // 2026-10-20), and creating, renewing, not renewing or cancelling one stays his. contracts:delete
  // stays a boundary.
  "src/lib/contracts/service.ts",
  // Names HR Administration in SEAT_PRINTABLE_DOCUMENTS, added 2026-10-20. Reviewed verdict: it GRANTS
  // reach — eight BUILT-IN papers she may print without holding employee_documents (which the hard
  // boundary strips from her, since she is outside hrAuthorityRoles). It hands her nothing her brief
  // withholds and is NARROWER than the key: no company template (`custom:<uuid>`), no template studio,
  // and only the papers of the two moments the owner gave her — the contract renewal she prepares and
  // the resignation she follows up. The renewal annex prints the salary, and that is the owner's one
  // money exception for her; none of the other seven prints an amount. Every seat not named keeps the
  // employee_documents check it had before.
  "src/lib/hiring-pack/document-registry.ts",
  // src/lib/distribution-lists/access.ts left this list on 2026-10-08: it named only the retired HR Advisory seat.
  // Names HR Operations in isDeductionsReadActor, added 2026-09-03 with the page above. Reviewed
  // verdict: it GRANTS reach, and it is the wider half of the two — the page is a door, this is the
  // data. Every company-wide deductions read route asserts this gate ON TOP of the matrix, so
  // without it she would have opened the screen and had each panel 403.
  //
  // It is company-wide by necessity, not by choice: the screen has no self-only mode. That is a
  // smaller step than it reads as, because getPayrollScope already returns COMPANY for her seat
  // (owner, 2026-08-29) and payroll_inputs already grants payroll and payslips read+export — every
  // employee's gross and net is on her screen today, and a deduction is a component of the payslip
  // she can already open.
  //
  // What it does NOT hand her is the file. Her deductions grant is ["read"] with no `export`, so
  // /api/admin/deductions/export refuses her at assertPermission even though it calls this same
  // gate — the same split the owner set for her payslips on 2026-09-01. tests/deductions-read-gate
  // .test.ts pins that absence directly, because widening it would look like tidying.
  "src/lib/deductions/permissions.ts",
  "src/lib/employee-360/access.ts",
  "src/lib/employees/access-provisioning.ts",
  // Names both seats in `employeeCvReaderRoles`, added 2026-09-09 with the owner's instruction to
  // let a new hire's CV be attached to the master record and downloaded from the notice. Reviewed
  // verdict: it GRANTS reach, and it is listed for exactly that reason — it is the string that
  // decides HR Advisory and HR Operations may open an employee's CV.
  //
  // It withholds nothing and takes nothing away. Both seats already hold `employees:read` —
  // workforce_insight for HR Advisory, people_records for HR Operations — so reading one document
  // filed on the employee master is inside both job descriptions rather than beside them. The
  // owner named all four seats himself when asked who should be able to open the link.
  //
  // WRITING IS NOT IN THIS SET AND MUST NOT JOIN IT. Attaching, replacing and removing a CV rides
  // `employees:update`, which people_records holds and workforce_insight deliberately does not
  // (her boundary is "may not terminate or destroy a record"). So HR Advisory can read this
  // document and cannot change it, and that split is the composed matrix's, not this file's.
  //
  // A named set rather than a permission resource, on the same reasoning as
  // companyVacationReportReaderRoles: the SFE Manager holds no `employees` grant at all, and a
  // permission-shaped gate would refuse the one person the notice is addressed to.
  "src/lib/employees/employee-cv.ts",
  "src/lib/excuses/service.ts",
  "src/lib/hiring-documents/service.ts",
  // Names HR Operations and HR Resourcing in REMINDER_TEAM_ROLES, added 2026-10-17, and HR
  // Administration from 2026-10-20. Reviewed verdict: it
  // GRANTS no reach. It only names who is on the HR team for the shared-notes page, and the page's
  // access is the `hr_reminders` grant every seat's bundle carries through `team_reminders`; the file adds
  // the one thing the matrix cannot say, which teammates a note may be shared WITH. Nothing a job
  // description withholds is handed over: a note is private until its author shares it.
  "src/lib/hr-reminders/access.ts",
  // src/lib/payroll/payslip-center.ts left this list on 2026-10-08: it named only the retired HR Advisory seat.
  // Names HR Advisory in managerCvEngagementRoles, added 2026-09-01. Reviewed verdict: it GRANTS
  // reach, by the owner's own amendment — the list was his, verbatim, and read "NOT SFE, NOT HR"
  // until he was asked directly and said to add the HR Business Partner. Chasing the managers who
  // have not answered on a candidate is recruiting, which is her function.
  //
  // The amendment is HER seat alone: HR Operations is still refused, and that split is asserted in
  // tests/recruitment-manager-cv-engagement.test.ts rather than left to this comment. The report
  // is read-only and scoped to hiring activity — it holds no salary, no personnel record and no
  // payroll figure, so it crosses none of her named boundaries.
  "src/lib/recruitment/manager-cv-engagement.ts",
  // The job workbook. It names both seats because it IS the two job descriptions, one per seat —
  // but it grants nothing: every field is prose and an href, there is no permission, no gate and
  // no branch on the seat name anywhere in it. tests/hr-job-workbook.test.ts asserts the opposite
  // direction, that every screen it names is one the seat's own sidebar already offers, so the
  // workbook can only ever describe access the matrix has already decided.
  "src/lib/hr/job-workbook.ts",
  // Names HR Resourcing in `TALENT_ACQUISITION_SEAT`, added 2026-10-13 with that seat's own landing
  // page — the owner's instruction to rebuild her overview "from scratch" against her handbook.
  // Reviewed verdict: it is a GATE and it can only ever NARROW. The constant is compared against
  // `hrBundleForRole(access.role)` in two places and nowhere else: the page, which renders
  // `TalentAcquisitionOverview` for a match and the unchanged `HrCommandCenter` for every other HR
  // seat, and `getTalentAcquisitionOverview`, which returns null outright when it does not match.
  // So the string decides WHICH landing component she is served, never what she may read.
  //
  // It hands her nothing her job description withholds, and that is enforced rather than asserted
  // here: the page's loader fetches only through `sourcesFor(seat)`, the same bundle-derived
  // allow-list the generic command centre uses, so it cannot read a source her functions do not
  // declare. The two sources `workforce_context` gained the same day — probationOutcomes and
  // vacationsToday — are grants she already held (`probation: READ_ONLY`, and `canReadAllProbation`
  // names this seat; `leave` for the vacation panel), and no other seat holds that function, so
  // nothing else moved. The page also shows her LESS than before: employee requests is off it by
  // his word, while the grant and the sidebar row stay.
  "src/lib/hr/talent-acquisition-logic.ts",
  "src/lib/notifications/role-recipients.ts",
  // Names HR Operations in HR_GENERALIST_SEAT / VACANT_SEAT_STAND_INS, added 2026-10-20 when the seat
  // was left empty for a future hire (owner: every notice addressed to it goes to him until then).
  // Reviewed verdict: a NOTIFICATION AUDIENCE, granting nothing. It decides only who RECEIVES a notice
  // addressed to an empty seat — the Super Admin, who holds every resource already — and it reads
  // app_auth_users to learn whether the seat is empty. No page opens and no query widens.
  "src/lib/notifications/vacant-seat.ts",
  // Names HR Resourcing in `noticeHiddenFromSeat` / `noticeFetchLimit`, added 2026-10-16 so her
  // notification center holds a new CV, interview requests and accepted offers only. Reviewed
  // verdict: it can only ever REMOVE rows from her own band. The deny-list drops recruitment alert
  // kinds from the read AFTER the recipient-isolation filter has run, so it widens nothing, grants
  // nothing and gates no route; for every other role both helpers return their input unchanged.
  "src/lib/notifications/seat-notice-filter.ts",
  // Names both seats in `sectionDrawerRoles`, added 2026-10-16 with the tiled drawer rail. Reviewed
  // verdict: presentation only. `usesSectionDrawers` is read by the sidebar renderer AFTER
  // `getSections` has decided which rows exist, so it cannot add, remove or re-gate a row; the
  // seats' access is whatever the permission matrix already gave them. HR Administration (the HR
  // Operations Specialist seat) joined the list on 2026-10-20 under the same verdict.
  "src/lib/navigation/active-path.ts",
  // The offer joining form (owner, 2026-10-08). It names HR Operations only as the ACTOR of
  // provisionNewHireAccess, to take that seat's create-only, rank-bounded door: it can make one NEW
  // default-rank login for the hr id the form just wrote and never change an existing account. It
  // grants the seat nothing and gates nothing on it.
  "src/lib/offers/joining-form-service.ts",
  // src/lib/probation/feedback-service.ts sat here until 2026-09-01. It named both seats in
  // resolveSubmitterRole, mapping them to the "ta" submitter role. The file was deleted with the
  // rest of the legacy probation feedback path — see tests/probation-legacy-feedback-retired.test.ts.
  "src/lib/probation/service.ts",
  "src/lib/recruitment/access.ts",
  "src/lib/recruitment/account-activation.ts",
  // daily-cv-digest.ts and recruitment-notify.ts name "HR Resourcing", added 2026-10-20 with the
  // rebuilt workspace (owner: Talent Acquisition sees every tab except HR Section Head and Talent
  // Acquisition). Reviewed verdict: each names the seat only to apply the Talent Acquisition fence —
  // the 18:00 digest and her CV notices drop the HR applicants she may not see. They can only REMOVE
  // rows from what she already received; they grant nothing.
  "src/lib/recruitment/inbound/daily-cv-digest.ts",
  "src/lib/recruitment/inbound/recruitment-notify.ts",
  // Names HR Operations in isInterviewCalendarOwner, added 2026-09-21. Owner, that day: "make
  // Yasmeena HR Operations full access and control to it as admin". Reviewed verdict: it GRANTS
  // reach, and only to the interview calendar: she books, moves and cancels interviews, shares the
  // calendar and records how an interview went. From the calendar she may also search candidates
  // and add an outside person while booking (interview-calendar.ts, mayUseRecruitmentFromCalendar),
  // and nothing else in Recruitment opens: her matrix row still holds no recruitment or candidates
  // grant. The calendar holds no salary, no personnel record and no payroll figure, so it crosses
  // none of her named boundaries.
  // ALSO names HR Resourcing (Talent Acquisition) in isInterviewCalendarOwner, added 2026-10-21. Owner,
  // that day: "make the TA have full access on the interview and can schedule and do everything and use
  // every single feature". Reviewed verdict: the same reach, to the same calendar only. She already holds
  // the candidates grants through `recruiting`, so searching and adding while booking opens nothing new,
  // and the Talent Acquisition fence (owner, 2026-10-20) still runs on the calendar's candidate search
  // and its bookings, so an HR applicant is never offered or shown to her. No salary, personnel record
  // or payroll figure sits on the calendar, so it crosses none of her named boundaries.
  "src/lib/recruitment/interview-calendar-types.ts",
  // Names "Super Admin" and "HR Operations" in resolveHrIdsForRole, added 2026-09-23 with the
  // interview-request flow. Reviewed verdict: it names the two seats only to pick who is TOLD a new
  // interview request has landed (the inbox notice) — it grants nothing and gates nothing, exactly
  // like role-recipients.ts. The recipients receive an in-app + Telegram message and a link to the
  // calendar they already reach; the notice carries no salary, personnel or payroll figure.
  "src/lib/recruitment/interview-request-notifications.ts",
  // Names "Super Admin" and "HR Resourcing" in REQUISITION_ATTACH_ROLES, added 2026-10-16 (owner:
  // "by one click from admin or TA"). Reviewed verdict: it is a GATE and it can only NARROW. The
  // press already sits behind `candidates:update`, which only those two seats hold; this restates
  // the answer in the service itself so a matrix override cannot widen it. Attaching opens an
  // application on a requisition she already recruits for, and nothing else.
  "src/lib/recruitment/requisition-attach.ts",
  // Names "HR Resourcing" in resolveHrIdsForRole, added 2026-10-16. Reviewed verdict: it picks the
  // OWNER written on a requisition the autopilot opens (owner: "Yomna Gamal", read from the role so
  // her successor inherits it). It grants nothing and gates nothing, like role-recipients.ts: being
  // the owner gives her no grant she did not already hold.
  "src/lib/recruitment/requisition-autopilot.ts",
  // fence.ts and role-tabs.ts name "HR Resourcing", added 2026-10-20 with the rebuilt workspace.
  // Reviewed verdict: a GATE that can only NARROW. role-tabs.ts keeps the HR Section Head and Talent
  // Acquisition tabs out of her tab list, and fence.ts answers an HR applicant as not-found at every
  // boundary that returns a candidate. Her candidates and recruitment grants are unchanged.
  "src/lib/recruitment/workspace/fence.ts",
  "src/lib/recruitment/workspace/role-tabs.ts",
  // organogram.ts names HR Administration in canAccessCompanyOrganogram, and resignations/service.ts
  // in isCompanyResignationReader, both added 2026-10-20 with the HR Operations Specialist seat.
  // Reviewed verdict: each GRANTS a company-wide READ — the whole chart, every resignation — and is
  // listed for that reason. Neither hands her money: canViewOrganogramSensitiveFields admits her for
  // the personal and bank rows, but both organogram employee routes pass omitSalary for
  // isSalaryBlindRole, and the settlement on a resignation is withheld for it too. organogram:update and
  // resignations:delete stay boundaries, and she holds no resignations:create (the owner submits).
  "src/lib/reports/organogram.ts",
  "src/lib/resignations/service.ts",
  // src/lib/sato-email/access.ts left this list on 2026-10-08: it named only the retired HR Advisory seat.
  // Names both seats in `roleHrefsForSubject`, added 2026-09-07 with the retention-risk alert.
  // Reviewed verdict: ROUTING ONLY, and it can only ever REMOVE a wrong destination — it grants
  // nothing and it cannot widen what either seat may open.
  //
  // The two strings are keys in a role -> URL map consumed by `notificationHrefForViewerRole`, so
  // the alert's action link points at the address each recipient's own shell serves. Employee 360
  // exists at three addresses, one per shell, and `portal-twins.ts` carries no forwarding rule for
  // it, so without this map an HR seat would be sent to an address that is not theirs. Nothing
  // branches on the value beyond picking a string.
  //
  // What the link opens is gated where it always was, and that gate is NARROWER than the alert's
  // audience: `/employee-360/[hrId]` requires `employee_profile:read` AND passes
  // `canViewEmployee360Subject`, which limits both HR seats to Medical Reps and themselves. Every
  // subject of a CRM-silence alert is a Medical Rep by construction (`logsOwnCrmVisitsTitle`), so
  // the link resolves to a report they may already open; an extended-leave subject who is not
  // field force lands on that page's own out-of-scope state, which is the same answer they would
  // get by typing the address. Removing the two keys would not close anything — it would only send
  // them to a shell that bounces them.
  "src/lib/retention-risk/messages.ts",
  "src/lib/support-requests/service.ts",
  // HR Operations reads the whole company's vacation report (her 2026-08-29 company scope, carried
  // into this second, parallel scope switch on 2026-10-20). Reading only — approvals are gated apart.
  "src/lib/vacation/visibility-scope.ts",
  "src/lib/workflow-control/definitions.ts",
  // ── The Talent Acquisition seat (HR Resourcing), 2026-10-08 ──────────────────────────────────
  // Each file below names HR Resourcing because the owner ticked that page for her on the access
  // blueprint and the page gates by NAME rather than by a permission key. Reviewed verdict for
  // every one: it GRANTS her a READ of the page he ticked, and nothing her bundle withholds —
  // none of them reaches payroll, salary, deductions, contracts, employee documents or messaging.
  //
  //   ceo-probation/page.tsx     the probation hub (a page of three cards). The tracker card is
  //                              DROPPED for her by isPageFencedForRole; dashboard and analytics
  //                              read through canReadAllProbation, which is GET-only for her.
  //   company-calendar/page.tsx  READ: she is not in CALENDAR_MANAGER_ROLES, so /api/calendar
  //                              refuses her edits.
  //   early-birds/page.tsx, ranks/page.tsx, early-birds/permissions.ts
  //                              READ of the company-wide board. Confirming a fortnight stays with
  //                              each District Manager; she holds no early_birds write action.
  //   private-calendar/logic.ts  the company-wide private-calendar viewer, which he ticked.
  //   whatsapp-inbox/access.ts, crm/doctor-coverage-roles.ts
  //                              the owner's own answers in chat the same day ("Open all four",
  //                              "Give her KPIs"). The WhatsApp Inbox is messaging she was given by
  //                              name, deliberately. KPIs places her with the company seats and opens
  //                              the KPIs board only; Reps List keeps its own role list. Needs You
  //                              was one of the four and was TAKEN BACK on 2026-10-16 ("remove needs
  //                              you and hide from ta account") — its page no longer names her.
  "app/(admin)/admin/ceo-probation/page.tsx",
  "src/lib/crm/doctor-coverage-roles.ts",
  "src/lib/whatsapp-inbox/access.ts",
  "app/(admin)/admin/company-calendar/page.tsx",
  "app/(admin)/admin/early-birds/page.tsx",
  // The Ranks admin audience (page AND certificate route read it), moved here from the page itself
  // so the two cannot drift: same grant as before, the Talent Acquisition seat reads the board and
  // may print any rep's certificate from it.
  "src/lib/rep-ranks/admin-audience.ts",
  "src/lib/early-birds/permissions.ts",
  "src/lib/private-calendar/logic.ts",
  // REMOVES reach and can only ever remove it: the per-seat page fence. Naming a seat here closes a
  // page her keys would otherwise open (the CV Database, the Probation Tracker, the attendance and
  // planning screens, Payslips Center) and opens nothing. The HR Operations Specialist seat (HR
  // Administration) joined it on 2026-10-20: company attendance, Employee 360, both deduction
  // screens, the vacation request desk and the Payslips Center are closed to her.
  "src/lib/auth/seat-page-fences.ts",
  // GRANTS her the Business Cards print screen through business_card_requests:update, the desk she
  // already works — instead of employee_documents, which carries contracts and salary letters and
  // which the owner left OUT of her seat. A card holds a name, title, phone and work email only.
  "src/lib/business-cards/access.ts",
];

/**
 * Indent for a multi-line assertion message. Built from a char code on purpose: this file is
 * edited through shells that eat backslashes in a heredoc (AGENTS.md 2.1), and a swallowed
 * escape here turns join("<newline>") into a syntax error that takes the whole suite down
 * before a single test runs. A constant cannot be mangled that way.
 */
const BREACH_SEP = String.fromCharCode(10) + '  ';

export async function runHrFunctionGovernanceTests() {
  const bundleNames = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];

  // --- Rule 1: a permission role is never a job title ------------------------------------------
  for (const role of phoenixRoles) {
    if (GRANDFATHERED_NAME_COLLISIONS.includes(role)) continue;
    assert.ok(
      !(phoenixCompanyJobTitles as readonly string[]).includes(role),
      `"${role}" is BOTH a phoenixRoles member and a phoenixCompanyJobTitle. A permission key ` +
        "must describe a capability, not a seat, or it goes stale the day its holder leaves. " +
        "Name the role for what it lets someone DO and keep the job title in " +
        "phoenixCompanyJobTitles. Do not add it to GRANDFATHERED_NAME_COLLISIONS: that list is " +
        "closed at 2026-08-28.",
    );
  }
  // ...and the grandfather list must not rot into cover for a name that no longer collides.
  for (const name of GRANDFATHERED_NAME_COLLISIONS) {
    assert.ok(
      (phoenixRoles as readonly string[]).includes(name) &&
        (phoenixCompanyJobTitles as readonly string[]).includes(name),
      `"${name}" is grandfathered as a role/title collision but is no longer both. Remove it from ` +
        "GRANDFATHERED_NAME_COLLISIONS rather than leaving a stale exemption behind.",
    );
  }

  // --- Rule 2: the retired HR seats stay retired, and fail CLOSED ------------------------------
  for (const retired of RETIRED_HR_ROLE_NAMES) {
    assert.ok(
      !(phoenixRoles as readonly string[]).includes(retired),
      `"${retired}" is back in phoenixRoles. It is a job title; the access it carried lives in ` +
        "HR_ROLE_BUNDLES.",
    );
    // normalizeRole is what a stored profile and a stale JWT's app_metadata both pass through.
    // Resolving a retired seat to its SUCCESSOR reads as continuity and is really a privilege
    // carry-forward: production on 2026-08-28 held exactly one row still naming Talent
    // Acquisition, belonging to A-16, is_active false, employment_status resigned.
    assert.equal(
      normalizeRole(retired),
      "Employee",
      `"${retired}" must resolve DOWN to Employee, never sideways to an HR bundle`,
    );
    assert.equal(normalizeRole(retired.toLowerCase()), "Employee");
    assert.equal(normalizeRole(retired.replace(/[^A-Za-z]/g, "")), "Employee");
  }

  // --- Rule 3: every function is real, cited, and used -----------------------------------------
  const seenKeys = new Set<HrFunctionKey>();
  for (const fn of HR_FUNCTIONS) {
    assert.ok(!seenKeys.has(fn.key), `duplicate HR function key "${fn.key}"`);
    seenKeys.add(fn.key);
    assert.ok(fn.label.trim().length > 0, `${fn.key} has no label`);
    assert.ok(fn.summary.trim().length > 0, `${fn.key} has no summary`);
    // Every grant must trace to a line the owner signed off, not to a session's judgement.
    assert.ok(
      fn.jdSections.length > 0,
      `${fn.key} cites no job-description section. Every function must name where it came from, ` +
        "or the catalogue becomes a place to park a grant nobody asked for.",
    );
    for (const cite of fn.jdSections) {
      assert.ok(cite.trim().length > 0, `${fn.key} has an empty jdSections entry`);
    }
    assert.ok(
      Object.keys(fn.grants).length > 0,
      `${fn.key} grants nothing, which is a label pretending to be a capability`,
    );
    assert.equal(getHrFunction(fn.key).key, fn.key, `getHrFunction("${fn.key}") does not round-trip`);
  }

  // No orphans: a function held by no bundle is dead code that reads as live policy — UNLESS it is
  // named in UNASSIGNED_HR_FUNCTIONS. That list exists because the owner retired the HR Business Partner seat on 2026-10-08 and,
  // asked who takes its work, answered "Leave it for system administrator now": four functions are
  // the Super Admin's until he hands them to a seat. Naming them keeps that a decision on record
  // rather than a silent orphan, and keeps handing them out a move rather than a rebuild.
  const heldByABundle = new Set<HrFunctionKey>();
  for (const name of bundleNames) {
    for (const key of HR_ROLE_BUNDLES[name]) heldByABundle.add(key);
  }
  const unassigned = new Set<HrFunctionKey>(UNASSIGNED_HR_FUNCTIONS);
  for (const key of unassigned) {
    assert.ok(!heldByABundle.has(key), `"${key}" is listed as unassigned but a seat holds it — take it off the list`);
  }
  for (const fn of HR_FUNCTIONS) {
    assert.ok(
      heldByABundle.has(fn.key) || unassigned.has(fn.key),
      `HR function "${fn.key}" is in no bundle and not in UNASSIGNED_HR_FUNCTIONS. Give it to a seat, ` +
        "name it as unassigned with the owner's word for it, or delete it: an unheld function looks like policy and grants nothing.",
    );
  }
  // ...and the reverse, so neither list can name a function that does not exist.
  assert.deepEqual(
    [...heldByABundle, ...unassigned].sort(),
    HR_FUNCTIONS.map((fn) => fn.key).sort(),
    "the seats' bundles plus the unassigned list must be exactly the function catalogue: at the " +
      "end of the day, everything (owner, 2026-08-28)",
  );

  // --- Rule 4: no bundle breaches a job-description boundary -----------------------------------
  // Asserted against BOTH the composition and permissionMatrix, because they are not the same
  // object and only the second one governs access. permissions.ts runs applyHardPermissionBoundaries
  // over the composed matrix, and for `support_requests` that pass SETS the actions outright
  // (matrix[role][resource] = [...allowedActions]) rather than filtering them, so it is a path that
  // can WIDEN a grant after composition. Checking the catalogue alone would not see that.
  assert.ok(HR_ROLE_BOUNDARIES.length > 0, "the boundary list is empty, so the JD limits are unenforced");
  const breaches: string[] = [];
  for (const name of bundleNames) {
    const sources: [string, Record<string, string[] | undefined>][] = [
      ["composition", composeHrRoleGrants(HR_ROLE_BUNDLES[name]) as Record<string, string[] | undefined>],
      ["permissionMatrix", permissionMatrix[name as PhoenixRole] as Record<string, string[] | undefined>],
    ];
    for (const [where, grants] of sources) {
      for (const boundary of HR_ROLE_BOUNDARIES) {
        if (grants[boundary.resource]?.includes(boundary.action)) {
          breaches.push(`${name} holds ${boundary.resource}:${boundary.action} in ${where} (${boundary.why})`);
        }
      }
    }
  }
  assert.deepEqual(breaches, [], `HR role boundaries breached:
  ${breaches.join(BREACH_SEP)}`);

  // --- Rule 5: no INDIVIDUAL function can breach one either ------------------------------------
  // Rule 4 only sees the two bundles that exist today. The owner's design is that bundles get
  // recomposed, so a function carrying a forbidden pair is a landmine for the next composition.
  const functionBreaches: string[] = [];
  for (const fn of HR_FUNCTIONS) {
    const grants = fn.grants as Record<string, string[] | undefined>;
    for (const boundary of HR_ROLE_BOUNDARIES) {
      if (grants[boundary.resource]?.includes(boundary.action)) {
        functionBreaches.push(`${fn.key} grants ${boundary.resource}:${boundary.action} (${boundary.why})`);
      }
    }
  }
  assert.deepEqual(
    functionBreaches,
    [],
    `an HR function breaches a boundary, so ANY bundle holding it would too:
  ${functionBreaches.join(BREACH_SEP)}`,
  );

  // --- Rule 6: the matrix is the composition NARROWED, never widened ---------------------------
  // If someone edits permissionMatrix directly, the catalogue stops describing reality while still
  // reading as though it does, and every assertion above would be testing a fiction. A plain
  // deepEqual cannot express this: applyHardPermissionBoundaries legitimately caps a composed
  // grant afterwards (HR Advisory composes employees read+export and is hard-capped to exactly
  // that; HR Operations is capped to read/create/update/export/import with delete withheld from
  // both). Narrowing is the safe direction and is allowed. WIDENING is what must never happen.
  const SET_NOT_FILTERED: readonly string[] = [
    // A resource applyHardPermissionBoundaries assigns rather than intersects, so it is a place a
    // post-composition grant can appear. Pinned below rather than waved through.
    "support_requests",
  ];
  for (const name of bundleNames) {
    assert.ok(
      (phoenixRoles as readonly string[]).includes(name),
      `bundle "${name}" is not a phoenixRoles member, so nothing can be assigned it`,
    );
    const composed = composeHrRoleGrants(HR_ROLE_BUNDLES[name]) as Record<string, string[] | undefined>;
    const live = permissionMatrix[name as PhoenixRole] as Record<string, string[] | undefined>;

    for (const [resource, actions] of Object.entries(live)) {
      if (SET_NOT_FILTERED.includes(resource)) continue;
      assert.ok(
        composed[resource],
        `permissionMatrix["${name}"] grants "${resource}", which no HR function contributes. A ` +
          "bundle may only be narrowed after composition, never given something new. Add it to a " +
          "function in hr-functions.ts so it traces to a job-description line.",
      );
      for (const action of actions ?? []) {
        assert.ok(
          composed[resource]?.includes(action),
          `permissionMatrix["${name}"].${resource} holds "${action}" but the composition does not. ` +
            "Something widened this after hr-functions.ts composed it.",
        );
      }
    }
    // ...and the widening path, pinned explicitly so a second one cannot be added quietly. The
    // staff set (read the inbox, work it, export it) belongs to an HR AUTHORITY seat only; every
    // other seat gets the sender's `create`, like every employee. The HR Operations Specialist
    // (HR Administration, 2026-10-20) is the first HR seat outside hrAuthorityRoles — the owner gave
    // her no request desk — so she is pinned to the sender set, not the staff set.
    const supportActions = isHrAuthorityRole(name as PhoenixRole)
      ? ["create", "export", "read", "update"]
      : ["create"];
    assert.deepEqual(
      live.support_requests?.slice().sort(),
      supportActions,
      `${name} must hold the ${isHrAuthorityRole(name as PhoenixRole) ? "HR support-staff" : "sender"} ` +
        "action set. This resource is SET by applyHardPermissionBoundaries rather than filtered, so it " +
        "is a grant in the matrix that hr-functions.ts does not fully control.",
    );
    // business_card_requests is SET the same way. It is not skipped above: every action the matrix
    // holds must also be composed (the floor's sender `create`, or employee_requests' desk), and it
    // is pinned here to the same split.
    assert.deepEqual(
      live.business_card_requests?.slice().sort(),
      supportActions,
      `${name} must hold the ${isHrAuthorityRole(name as PhoenixRole) ? "request-desk" : "sender"} ` +
        "action set on business_card_requests, which applyHardPermissionBoundaries SETS.",
    );
  }
  // The seats that are NOT an HR authority, named, so a seat cannot fall out of hrAuthorityRoles
  // (and lose the request desks, the hiring documents and the recruitment pipeline at once) without
  // this list being edited on purpose.
  assert.deepEqual(
    bundleNames.filter((name) => !isHrAuthorityRole(name as PhoenixRole)),
    ["HR Administration"],
    "only the HR Operations Specialist seat (HR Administration) sits outside hrAuthorityRoles",
  );
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");
  for (const name of bundleNames) {
    // A plain substring check, not a regex: the escapes in a RegExp built from a template
    // literal do not survive every editing path used on this repo, and a half-eaten pattern
    // does not throw - it silently stops matching and reads as a real failure.
    assert.ok(
      permissionsSource.includes(`"${name}": hrBundleGrants("${name}")`),
      `permissions.ts must build "${name}" via hrBundleGrants, so the job description stays ` +
        "the source of truth rather than a hand-maintained matrix block.",
    );
  }

  // --- Rule 7: both seats keep a self-service floor ---------------------------------------------
  // Composing a role purely from HR functions produced a seat that could administer everyone
  // else's leave and payslip and not reach her own. /payslips throws an uncaught Forbidden rather
  // than rendering an empty state, so this is a broken page, not a missing convenience.
  for (const name of bundleNames) {
    const grants = permissionMatrix[name as PhoenixRole] as Record<string, string[] | undefined>;
    assert.ok(grants.payslips?.includes("read"), `${name} cannot open her own payslip`);
    assert.ok(grants.leave?.includes("create"), `${name} cannot request her own vacation`);
    assert.ok(grants.employee_profile?.includes("read"), `${name} cannot open her own profile`);
    assert.ok(grants.overview?.includes("read"), `${name} has no landing page`);
    assert.ok(grants.report_it?.includes("create"), `${name} cannot report a problem`);
  }

  // --- Rule 8: the split is real ----------------------------------------------------------------
  // The owner's correction on 2026-08-28: the business partner is not only recruiting, and the two
  // seats are different subsets of one catalogue. If a future change collapses them back into a
  // single role holding everything, the catalogue still type-checks and this is what refuses.
  assert.ok(bundleNames.length >= 2, "there must be at least two bundles, or this is one role again");
  for (const name of bundleNames) {
    const held = new Set<HrFunctionKey>(HR_ROLE_BUNDLES[name]);
    assert.ok(
      held.size < HR_FUNCTIONS.length,
      `"${name}" holds every function in the catalogue, which makes it the monolithic HR role the ` +
        "function split exists to replace",
    );
    assert.ok(held.size > 0, `"${name}" holds no functions`);
  }
  const [first, ...rest] = bundleNames;
  for (const other of rest) {
    const a = [...HR_ROLE_BUNDLES[first]].sort();
    const b = [...HR_ROLE_BUNDLES[other]].sort();
    assert.notDeepEqual(a, b, `"${first}" and "${other}" hold identical functions`);
  }

  // --- Rule 9: every boundary is REFUSED BY THE GATE, not merely absent from a table -------------
  // Rules 4 and 5 read the grants. This one asks canAccess — the function the route handlers and
  // the page gates actually call — because a matrix entry is not the last word on access. canAccess
  // short-circuits to true on `context.scope === "system"` before it consults any matrix, and it
  // merges role_permission_overrides from the database on top of the composed one. Both seats
  // resolve to scope "self" today, which is why the boundaries hold; that is a fact worth asserting
  // rather than a note worth trusting, since scopeForRole falls through to a default and a future
  // seat added to the wrong branch would open all 17 at once with no grant having changed.
  const refusalFailures: string[] = [];
  for (const name of bundleNames) {
    const role = name as PhoenixRole;
    const access = {
      role,
      scope: scopeForRole(role),
      hrId: "HR-BOUNDARY-TEST",
      source: "session",
    } as AccessContext;

    assert.notEqual(
      access.scope,
      "system",
      `"${name}" resolves to scope "system", and canAccess returns true for that before it reads ` +
        "any matrix — every job-description boundary below is open, whatever the grants say",
    );

    for (const boundary of HR_ROLE_BOUNDARIES) {
      if (await canAccess(access, boundary.resource, boundary.action)) {
        refusalFailures.push(
          `${name}: canAccess allows ${boundary.resource}:${boundary.action} — ${boundary.why}`,
        );
      }
    }

    // The control. Without it a canAccess that returned false for everything — a broken import, a
    // matrix that failed to load — would satisfy every assertion above by refusing the whole seat.
    assert.ok(
      await canAccess(access, "overview", "read"),
      `"${name}" is refused overview:read, so canAccess is refusing everything and the boundary ` +
        "checks above passed by accident rather than by boundary",
    );
  }
  assert.deepEqual(
    refusalFailures,
    [],
    `a job-description boundary is not actually refused at the gate:
  ${refusalFailures.join(BREACH_SEP)}`,
  );

  // --- Rule 10: a grant written by NAME has to be acknowledged ----------------------------------
  // Every rule above reasons about the permission matrix. Some access in this codebase does not go
  // through it: `access.role === "HR Operations"` in a service, a role Set on a page. That kind of
  // grant is invisible to Rules 4, 5 and 9 alike, and it is not hypothetical — the HR sidebar
  // offered a Deductions row that app/(admin)/admin/deductions/page.tsx refused by name, because the
  // page's gate was a role set and no permission test could see it.
  //
  // There is no way to check such a grant mechanically: it is ordinary code. So this pins the LIST.
  // A new file naming either seat fails here, which forces the one question that matters — does this
  // hand the seat something its job description does not — to be answered by a person, once, at the
  // moment it is written. Adding the path after answering it is the correct fix; the list is
  // expected to grow with each phase.
  const namingSeat: string[] = [];
  const skip = new Set(["node_modules", ".next", ".git", ".claude", "__snapshots__"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("_wt-") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = readFileSync(full, "utf8");
        if (bundleNames.some((name) => source.includes(`"${name}"`))) {
          namingSeat.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
        }
      }
    }
  };
  for (const root of ["app", "src"]) walk(path.join(REPO_ROOT, root));

  assert.deepEqual(
    namingSeat.sort(),
    [...FILES_NAMING_AN_HR_SEAT].sort(),
    "a file names an HR seat by string, which is a grant or a gate the permission matrix cannot " +
      "see and no boundary rule above can check. Confirm it does not hand the seat anything its job " +
      "description withholds, then add or remove the path in FILES_NAMING_AN_HR_SEAT",
  );
}
