import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  composeHrRoleGrants,
  getHrFunction,
  HR_FUNCTIONS,
  HR_ROLE_BOUNDARIES,
  HR_ROLE_BUNDLES,
  type HrBundleName,
  type HrFunctionKey,
} from "../src/lib/auth/hr-functions.ts";
import {
  canAccess,
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
  "app/employee-portals/account-activation/page.tsx",
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
  // Names HR Advisory in TERRITORY_COMPANY_WIDE_NON_SALES_ROLES, added 2026-09-07 with the owner's
  // instruction to put Territory Management on her sidebar. Reviewed verdict: it GRANTS reach, and
  // it is listed for exactly that reason - it is the string that decides she sees the WHOLE brick
  // map rather than an empty one.
  //
  // It is not a permission. `territory:read` is what admits her, composed onto workforce_insight and
  // asserted by the page and all four read routes; this set only answers "which areas", after the
  // gate. It exists because every other reader of that function is on the sales ladder, so the scope
  // resolver asks resolveSalesAccessScope - which answers NONE for her, and NONE means EMPTY sets,
  // not "everything". Without this she would pass the gate and read a blank map.
  //
  // Company-wide is the right bound and withholds nothing the job description reserves: the map
  // carries bricks, areas, coordinates, coverage counts and a rep-residence recommendation, and no
  // money at all. The two privileged acts on the module stay shut - pinning is sales:import,
  // publishing a public preview link is sales:export, and she holds neither.
  "src/lib/territory-management/service.ts",
  "src/components/admin/access-control-manager.tsx",
  "src/components/admin/workflow-registry-manager.tsx",
  // Names both seats in the Retention Register's confidentiality notice, added 2026-09-01.
  // Reviewed verdict: DISPLAY ONLY, and it describes a restriction rather than creating one. Both
  // strings are arguments to displayTitleForRole(), which turns a role KEY into the job title the
  // company actually uses — the notice renders "readable by the HR Business Partner … not visible
  // to the HR Operations Coordinator". Nothing branches on either value: no gate, no query filter,
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
  "src/config/system-navigation.ts",
  "src/lib/admin/access-control.ts",
  // Names "HR Advisory" in a comment, added 2026-09-04. Reviewed verdict: it GRANTS NOTHING and
  // GATES NOTHING — the seat appears once, in the header prose explaining why this module sits
  // beside displayTitleForRole(), and nowhere in the code. The module maps an ACCOUNT (hr_id
  // "b-10") to the job title the shell prints for that person, and its only consumer is a
  // `roleLabel` string. `access.role` is untouched, so every gate still reads the permission key;
  // the reason it is keyed on the account rather than the role is precisely that admin-HR shares
  // the Super Admin key and must keep reading Super Admin.
  "src/lib/auth/account-job-titles.ts",
  "src/lib/auth/hr-functions.ts",
  "src/lib/auth/permissions.ts",
  // Names HR Operations in mapPhoenixRoleToAccessScopeType, which fills the access_scope COLUMN
  // when an account is provisioned. That column is a mirror: nothing reads it back to decide
  // access, so the string grants the seat nothing. It is listed because a mirror disagreeing with
  // scopeForRole misleads anyone auditing user_access_profiles — keeping the two in step is for
  // legibility, not enforcement. SFE Manager already sits that way (scope "self", mirror
  // COMPANY_READ), which is why this is a per-seat note and not a general invariant.
  // Names HR Advisory in systemEmail.seatReplyTo, added 2026-09-11. Reviewed verdict: it GRANTS
  // NOTHING. The value is a Reply-To address chosen by the SENDER's seat when that seat composes a
  // mail by hand — it opens no page, widens no query, and reads no record on her behalf. It is
  // listed because the string is a seat name, which is what Rule 10 pins, and because a reply
  // address is a CLAIM about who answers: if the HR Business Partner seat is ever retired or
  // renamed, this line starts routing replies to a mailbox nobody watches.
  //
  // Deliberately not a From address — From stays on the verified sending subdomain, and
  // tests/distribution-lists-access.test.ts pins both directions of that.
  "src/config/system-settings.ts",
  "src/lib/auth/supabase-identity.ts",
  "src/lib/contracts/service.ts",
  // Names HR Advisory in canManageDistributionLists, added 2026-09-11 when the owner asked that the
  // HR Business Partner reach /admin/distribution-lists. Reviewed verdict: it GRANTS reach, and the
  // grant is bounded by a fail-CLOSED allowlist in the same file.
  //
  // What it opens: the named recipient groups and the Turbify alias register, narrowed by
  // distributionListScopeFor to HR_OWNED_LIST_KEYS — `hr_team` alone today. A list absent from that
  // set is invisible to her, so one added later is private until somebody decides it is hers. The
  // owner answered "HR lists only" — so `finance_team` stays out, enforced in the [listKey] route
  // and in both alias actions rather than merely hidden on the screen. (The Monthly Closing Cc list
  // named in that exchange was retired the same day, when the lists became the Sato Email
  // Composer's alone.)
  //
  // What it cannot do here: send. Editing a list sends nothing; the only sender that reads a list is
  // the Sato Email Composer, gated separately in src/lib/sato-email/access.ts and listed below. The
  // alias register cannot touch a mailbox at all because Turbify has no API — its output is a
  // worklist a human applies by hand. No HR_ROLE_BOUNDARIES entry is crossed: this is not payroll,
  // deductions, organogram, user_admin, permission_admin or report_it.
  //
  // Why by name rather than a permission: the fitting resource, `communication`, also gates the
  // email composer, the email templates and the Telegram console, so scoping THIS screen through it
  // could not have expressed "these lists and not those".
  //
  // ⚠ CORRECTED 2026-09-11. This note used to end "and no HR function grants it". That stopped
  // being true in the same branch that added this file: `hr_communication` grants `communication`
  // to the HR Advisory bundle. THIS IS THE FILE THAT EXISTS TO ANSWER "what was this seat given",
  // and it was answering the opposite. She holds `communication`, and what that opened is fenced
  // in three places rather than left to the accident that Super Admin used to be its only holder:
  // the Telegram route's five Super-Admin checks, `privileged-fields.ts` on the template fields
  // that decide where mail goes, and the list allowlist here.
  "src/lib/distribution-lists/access.ts",
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
  // Names HR Advisory in resolvePayslipCenterAudience, added 2026-09-01. Reviewed verdict: it
  // GRANTS reach — this is the string that lets her open the Payslips Center at all — and it is
  // listed for exactly that reason. The owner asked for it in those words and bounded it in the
  // same breath: "you will make her able to see the district managers, the Medicare reps, and
  // herself only in the payslips." Deliberately NOT a widening of getPayrollScope, which /payroll
  // and the batch screens also consult; this opens one page's rows for two job titles.
  //
  // What it does NOT hand her is the thing her job description withholds: canExportPayslipDocument
  // is unchanged (Super Admin + Finance Manager), so she reads figures on screen and cannot carry
  // a rendered payslip document out of the building. tests/hr-advisory-module-access.test.ts pins
  // the audience in both directions, including every title it must refuse.
  "src/lib/payroll/payslip-center.ts",
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
  "src/lib/notifications/role-recipients.ts",
  // src/lib/probation/feedback-service.ts sat here until 2026-09-01. It named both seats in
  // resolveSubmitterRole, mapping them to the "ta" submitter role. The file was deleted with the
  // rest of the legacy probation feedback path — see tests/probation-legacy-feedback-retired.test.ts.
  "src/lib/probation/service.ts",
  "src/lib/recruitment/access.ts",
  "src/lib/recruitment/account-activation.ts",
  "src/lib/reports/organogram.ts",
  "src/lib/resignations/service.ts",
  // Names HR Advisory in canUseSatoEmail, added 2026-09-12 for the Sato Email Composer. Owner
  // 2026-09-11: "This module would be accessible for HR business partner and the system
  // administrator." Reviewed verdict: it GRANTS reach, and this is the SENDING half of the pair
  // whose editing half sits at src/lib/distribution-lists/access.ts above — so it is the one of the
  // two that can actually put mail in somebody's inbox, and it was read as such.
  //
  // What it opens: one screen, where she writes a subject and a body, picks a fixed template or
  // types freely, addresses the switched-on distribution lists or named colleagues, and sends. The
  // owner asked for exactly this, and for both seats to be able to address any list.
  //
  // What it cannot do, and none of these is left to the screen: it cannot reach the whole company
  // — `allEmployees` lists are withheld in the service, so naming one by hand gets nothing either.
  // It cannot mail an address the directory does not know without declaring it, because the
  // Recipient Assurance Guard still runs. It cannot exceed the manual-email recipient cap, because
  // every email is cut to it. And it cannot skip the Notification Confidence Gate: the fan-out hold
  // is not applied (owner: "in composer its manual email by human") but the gate itself runs on
  // every send, pinned by tests/sato-email-lists-only-composer.test.ts.
  //
  // No HR_ROLE_BOUNDARIES entry is crossed: this is not payroll, deductions, organogram,
  // user_admin, permission_admin or report_it. She already holds `communication` through
  // hr_communication — the reason this is a by-name gate rather than that resource is that
  // `communication` also opens the older HR reply composer, the system email templates and the
  // Telegram console, and the owner scoped this to the new module alone.
  "src/lib/sato-email/access.ts",
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
  "src/lib/workflow-control/definitions.ts",
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

  // No orphans: a function held by no bundle is dead code that reads as live policy.
  const heldByABundle = new Set<HrFunctionKey>();
  for (const name of bundleNames) {
    for (const key of HR_ROLE_BUNDLES[name]) heldByABundle.add(key);
  }
  for (const fn of HR_FUNCTIONS) {
    assert.ok(
      heldByABundle.has(fn.key),
      `HR function "${fn.key}" is in no bundle. Either give it to a seat or delete it: an unheld ` +
        "function looks like policy and grants nothing.",
    );
  }
  // ...and the reverse, so a bundle cannot name a function that does not exist.
  assert.deepEqual(
    [...heldByABundle].sort(),
    HR_FUNCTIONS.map((fn) => fn.key).sort(),
    "the union of both bundles must be exactly the function catalogue: at the end of the day, " +
      "everything (owner, 2026-08-28)",
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
    // The one resource applyHardPermissionBoundaries assigns rather than intersects, so it is the
    // only place a post-composition grant can appear. Pinned below rather than waved through.
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
    // ...and the one widening path, pinned explicitly so a second one cannot be added quietly.
    assert.deepEqual(
      live.support_requests?.slice().sort(),
      ["create", "export", "read", "update"],
      `${name} must hold the HR support-staff action set. This one resource is SET by ` +
        "applyHardPermissionBoundaries rather than filtered, so it is the only grant in the matrix " +
        "that hr-functions.ts does not fully control.",
    );
  }
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
