import type { EmployeeDirectoryData, EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdsMatch, normalizeHrIdForAccess } from "@/lib/hr-id";
import { isWithinManagerHierarchy, type SeatContinuitySubject } from "@/lib/workforce/hierarchy-resolver";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrBundleGrants } from "@/lib/auth/hr-functions";
// Temporary per-account module suspensions. Imported for its VALUE; module-locks.ts imports only
// TYPES back from this file, so there is no runtime cycle between the two.
import { isModuleLockedForAccess } from "@/lib/auth/module-locks";
// The one portal-role list, shared with the landing path. It imports only a TYPE back from here.
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";

export const phoenixRoles = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Finance Manager",
  "Financial Advisor",
  // HR seats are BUNDLES OF FUNCTIONS, not job titles — see src/lib/auth/hr-functions.ts.
  // "HR Specialist" (retired 2026-06) and "Talent Acquisition" (retired here, 2026-08-28) were
  // both job titles used as permission keys, and both had to be renamed across the codebase and
  // an eleven-table migration when the person left. These names are labels for a set of
  // functions and are read by nothing for intent, so none can go stale the same way.
  //
  // "HR Advisory" (shown as HR Business Partner) is RETIRED: the owner retired the HR Business Partner seat on 2026-10-08 ("no more HR business partner";
  // recruiting went to Talent Acquisition, the rest of its work to the Super Admin — "Leave it for
  // system administrator now").
  // The key stays as a DORMANT label — see retiredPhoenixRoles below: nobody can be given it, its
  // matrix entry is empty, and the restrictions written against it stay compiled.
  "HR Advisory",
  "HR Operations",
  // Shown everywhere as "Talent Acquisition" (HR_SEAT_JOB_TITLES). Opened 2026-10-08.
  "HR Resourcing",
  // Shown everywhere as "HR Operations Specialist" (HR_SEAT_JOB_TITLES). Opened 2026-10-20 for the
  // attendance and field review, the people master without salary, renewals and resignations.
  "HR Administration",
  "Manager",
  "CEO",
  "Super Admin",
] as const;
export type PhoenixRole = (typeof phoenixRoles)[number];

/**
 * Roles nobody may be given any more. User Access offers only `assignablePhoenixRoles`, and
 * upsertAccessUserCore (src/lib/admin/access-control.ts) refuses a retired role server-side, so a
 * hidden option is never the only thing standing in the way.
 *
 * A retired key stays in `phoenixRoles` rather than being deleted so that every RESTRICTION written
 * against it keeps compiling and keeps applying to any stray stored copy — while its grants are
 * gone: its matrix entry is empty and no seat set, role list or role-name gate names it.
 */
export const retiredPhoenixRoles: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>(["HR Advisory"]);

export const assignablePhoenixRoles: readonly PhoenixRole[] = phoenixRoles.filter(
  (role) => !retiredPhoenixRoles.has(role),
);

export const phoenixCompanyJobTitles = [
  "District Sales Manager",
  // A seniority grade on the district seat, opened 2026-09-29 when the owner promoted B-94. It is
  // a JOB TITLE and nothing else: it provisions as "Employee" like every title outside the
  // two-name field-force allowlist (see access-role.ts), and the district access he holds comes
  // from his explicitly-assigned "District Manager" app role, exactly as it did before.
  "Senior District Manager",
  "Medical Representative",
  // A seniority grade on the medical-rep title, an appreciation label the owner gave B-7 on
  // 2026-09-29. Like "Senior District Manager" above it is a JOB TITLE and nothing else: it carries
  // no access of its own (her "Medical Rep" app role is unchanged) and every job-function rule keeps
  // treating her exactly as a medical rep.
  "Senior Medical Representative",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Admin Assist",
  "SFE Manager",
  "QPPV",
  "Buffet",
  "Training Manager",
  "Marketing Manager",
  "Office Co-ordinator",
  "Regulatory Affairs",
  "Talent Acquisition",
  // HR Generalist and HR Operations Specialist are JOB TITLES and belong here; the ACCESS each
  // carries is "HR Operations" and "HR Administration" in phoenixRoles above, which is a different
  // list on purpose. "HR Generalist" replaced "HR Operations Coordinator" on 2026-10-20 (owner: "make
  // the old account HR genralist" — everywhere), the day the HR Operations Specialist seat opened.
  // Office Co-ordinator and Talent Acquisition stay listed because employee records, offers and
  // candidate applications still name them historically. "HR Business Partner" is NOT listed since
  // 2026-10-08 — the owner: "no more HR business partner. This title, no more."
  "HR Generalist",
  "HR Operations Specialist",
  "Finance Manager",
  "CEO",
  "HR Manager",
  "R&D Manager",
  "Research and Development Manager",
  "Financial Advisor",
] as const;
export type PhoenixCompanyJobTitle = (typeof phoenixCompanyJobTitles)[number];

export type PermissionAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "export"
  | "import";

export type PermissionResource =
  // Spotlight: the recognition export. Super Admin and CEO ONLY, by the owner's instruction when
  // the module was specified. It reads every rep, district and line in the company with no scope
  // narrowing of any kind, and it produces a shareable sheet with people's names and achievement
  // on it — so a narrower role holding it would be both a scope leak and a publishing right.
  | "spotlight"
  // Spotlight (self): a MEDICAL REP looking only at himself. A different resource from `spotlight`
  // above, on purpose — the admin routes assert `spotlight` and read the whole company, so granting a
  // rep that would hand him everyone's sheet. This one is held by the rep and gates his own portal
  // page and the /api/spotlight/me routes, which resolve his HR id from the session and never from
  // the wire. Owner, 2026-09-30: a rep may filter his own achievement over any period and generate
  // the pic or PDF only at 90% and above.
  | "spotlight_self"
  // The performance card (self): a MEDICAL REP exporting his OWN keepsake — his banner, his rank
  // and his achievement by month — as a picture or a PDF, and minting the public link that lets
  // LinkedIn, Facebook and WhatsApp show it (owner, 2026-10-03). Its OWN resource for the same
  // reason `spotlight_self` is one: the route renders the caller's card from his session HR id and
  // never from the wire, so the grant reaches nobody else's numbers. Deliberately NOT folded into
  // `employee_profile:export`, which is a broad record-export right the rep does not hold and must
  // not gain in order to save a picture of himself.
  | "performance_card_self"
  // Incentive (self): a person reading their OWN incentive progress and earnings — the portal's
  // /employee-portals/incentive and the admin shell's /workspace/incentive. Its own resource so the
  // module can be LOCKED (owner, 2026-10-16): the page used to gate on `employee_profile`, the
  // portal's entry gate, which can never be locked. The grant is DERIVED, not typed per role — every
  // role that holds `employee_profile:read` holds this (see the loop above `permissionMatrix`),
  // which is exactly who could open the page before, so no one gains or loses the tab.
  | "incentive"
  // Milestones: the service-anniversary and birthday keepsake. SUPER ADMIN ONLY — it is NOT the
  // same shape as spotlight above, and this is the one place that says so. It was Super Admin and
  // CEO until the owner narrowed it himself on 2026-09-23, in these words: "not approved. Make it
  // only super admin. None either uh, CEO." Do not widen it back, to the CEO or to anybody else,
  // without him saying so in words — it reads every active employee's hire date AND date of birth
  // with no scope narrowing, pulls their photograph out of the private bucket, and now writes to
  // the employee record and prints a whole window of people at once. Every one of those is a
  // publishing right rather than a reading one.
  | "milestones"
  // Customer identity (Phoenix CRM Wave 2): deciding that a row in Phoenix CRM, in the marketing
  // venue register, on a direct order and in the iReports360 mirror are all the SAME doctor, or
  // the same shop. SUPER ADMIN ONLY, by the owner's own ruling of 2026-09-30 — the system suggests
  // and HE confirms, in bulk or one by one. It reads every customer in all four systems at once
  // with no scope narrowing of any kind, and a confirmation is a judgement about who a real person
  // IS, which is the same shape of right as `milestones` above rather than an ordinary reading
  // one. Do not widen it, to the CEO or to the SFE, without him saying so in words.
  | "customer_identity"
  | "employees"
  | "employee_profile"
  | "employee_documents"
  | "team"
  | "overview"
  | "admin_access"
  | "system_cleanup"
  | "imports"
  | "sales"
  | "weekly_sales"
  | "direct_orders"
  | "payroll"
  | "payslips"
  | "deductions"
  | "double_visit_analytics"
  // Field Absence Calendar (owner, 2026-10-18): the names of field people the system did not see at
  // all on a working day. READ ONLY, and four roles only — capped in `hardBoundaryAllowedActions`,
  // because the page names people, and a rep or a district manager must never hold it.
  | "field_absence"
  | "weekly_plans"
  | "expenses"
  | "market_awareness"
  | "vacancies"
  | "organogram"
  | "offers"
  | "probation"
  | "resignations"
  | "contracts"
  | "coaching"
  | "communication"
  | "hr_calendar"
  // HR Reminders (owner, 2026-10-17): the HR team's shared notes, reminders and calendar. `read`
  // opens the page and lets a person comment on what they may see; `create` / `update` / `delete`
  // act on the person's OWN items only — the service checks ownership, so no action here ever
  // reaches a teammate's note. The Super Admin sees every item (the HR Manager's oversight) and
  // edits none that is not his own.
  | "hr_reminders"
  // HR Reports (owner, 2026-10-20): the daily and weekly fingerprint and field reports the HR
  // Operations Specialist reviews row by row. `read` opens them; `update` is HER review (confirm,
  // reject or recommend an edit, with a reason) and her Submit; `approve` is the decision, and only
  // the Super Admin holds it. Days only — the EGP beside a row is computed on the server and shown
  // to the approver alone.
  | "hr_ops_reports"
  | "outstation"
  | "leave"
  | "admin"
  | "user_admin"
  | "permission_admin"
  | "support_requests"
  | "business_card_requests"
  | "recruitment"
  | "candidates"
  // CV Lookup (owner, 2026-09-30, asked for Yasmeena Elsafory / HR Operations): SEARCH the CV
  // database and open only what the search returned. SEPARATE from `candidates` on purpose, and
  // the separation IS the feature — `candidates` is the POOL, a list of every applicant the
  // company holds, and his instruction was "she can search the cvs ... i dont want her to have
  // access to all cvs". Riding on `candidates:read` would have handed her exactly the access he
  // refused, and hiding the pool's sidebar row would have been presentation, not revocation: a
  // typed URL walks straight past it (the same lesson as the CV Database on 2026-09-01).
  //
  // `read` is the ONLY action it will ever carry, and the hard boundary below enforces that
  // rather than asking for it. This resource opens a search box and one person's file; it must
  // never grow a way to change or delete a candidate. There is deliberately NO `export` — a
  // download of the result set is the pool in a spreadsheet, which is the thing withheld.
  | "cv_lookup"
  | "account_activation"
  | "hiring_interviews"
  | "workflow_registry"
  | "report_it"
  | "attendance"
  | "crm_visits"
  // Plan Verification (District Manager page, tab two). SEPARATE from `crm_visits` on purpose.
  // `crm_visits:update` exists for the Doctor Coverage visit-norms singleton and is held only by
  // Super Admin and SFE Manager; reusing it here would have forced one of two wrong outcomes —
  // either the district managers this feature is FOR cannot verify, or granting them the verify
  // hands them company-wide visit norms as well. A plan approval is its own authority.
  | "crm_plans"
  // Native visit ENTRY (CRM phase 3, the pilot). SEPARATE from `crm_visits` for the same reason as
  // `crm_plans`: `crm_visits` reads the vendor mirror and every portal role holds it, while this key
  // WRITES Phoenix's own visit record. `create`/`delete` are a rep's own visits; `approve` is a
  // manager confirming he accompanied one — narrowed again, below the matrix, to the partner named on
  // that visit and to reps beneath him.
  | "crm_visit_entry"
  // Doctor lists maintained in Phoenix (CRM phase 7). SEPARATE from `crm_visit_entry` because a list
  // change is not a visit: `create` is a rep asking for a change to his OWN list; `approve` is the
  // manager the request was sent to answering it — narrowed again, below the matrix, to that stored
  // manager and to reps beneath him; `update` is the SFE Manager and the administrator changing any
  // rep's list directly (owner, 2026-09-14: "Rep asks, DM approves, SFE and system admin can edit").
  | "crm_contact_lists"
  | "early_birds"
  | "user_activity"
  | "synthetic_journeys"
  | "mailbox_monitor"
  | "mailbox_offboarding"
  | "retention"
  // Territory Management — the brick/area MAP. SEPARATE from `sales` on purpose, exactly like
  // `crm_plans` above. The module gated on `sales:read` until 2026-09-07, when the owner asked for
  // it on the HR Business Partner's sidebar; `sales:read` is the wrong key for that, because the
  // Employee role holds it too and it opens Source of Sales, Monthly Closing, Sales vs Target and
  // every other money page in the sidebar's Sales section. This map carries no money at all — its
  // payload is bricks, areas, coordinates, coverage counts and a "where should a rep hired here
  // live" recommendation — so it earns its own key rather than dragging the commercial surface
  // along with it.
  | "territory"
  // Company device register — the laptops, tablets and phones an employee signs for on the custody
  // receipt (إقرار استلام عهدة). SEPARATE from `employees` on purpose, exactly like `crm_plans` and
  // `territory` above. `employees` is a Super-Admin-only hard boundary holding salaries and
  // national IDs; this payload is asset tags, serials, IMEIs and who is carrying them. The people
  // who run it are HR Operations, at a joiner's desk and again at an exit, and handing somebody a
  // laptop must not require the personnel file — riding on `employees` would have meant either
  // opening that file to do it, or the register being unusable by the only seat that needs it.
  | "company_devices"
  // Phoenix CRM, the field force's own module built clean on 2026-09-16 (customer lists validated with
  // a live photo, the spot's location and the doctor's timings; weekly plans; visits; native reports).
  // SEPARATE from the pilot's `crm_visit_entry`, `crm_contact_lists` and `crm_plans` on purpose: the
  // pilot is retired after go-live and its grants go with it, and this module's authority is narrowed
  // again below the matrix by the organogram (src/lib/phoenix-crm/server/access.ts). `create` is a
  // rep's list, plan and visits and a district manager's own visits; `approve` is the territory's
  // reviewing manager deciding a grade or a drop and approving a plan (the SFE Manager only returns a
  // plan); `update` is the settings. The Super Admin's entries are always test entries.
  | "phoenix_crm"
  // Visual Aids (owner, 2026-09-18): the promotional flyers a rep holds up to a doctor on his company
  // tablet, moved into Phoenix from WhatsApp. `create` uploads one, `update` retires or replaces one;
  // NOBODY holds `delete`, because a flyer is never hard-deleted — retiring keeps the file and the
  // row, so the company can always say what was in front of doctors and when. `read` is narrowed
  // AGAIN below the matrix, to the active aids of the reader's OWN line (src/lib/visual-aids/).
  | "visual_aids"
  // Production Planner (owner, 2026-10-05): the raw-material plan for the products EGPI
  // toll-manufactures for us. `create`/`update` draft and commit a plan, record a run and edit the
  // settings; `export` is the live-formula workbook. NOBODY holds `delete`, because a stock report
  // and a recorded run are append-only facts about a date. 🔴 `Manager` and `Employee` hold NOTHING
  // here even though the module's main user is a Manager: see productionPlanningLevel in
  // src/lib/production-planning/access.ts for why the gate is named people, not a role.
  | "production_planning";

/**
 * The runtime twin of the `PermissionResource` union above. Both lists must hold exactly the same
 * names, and since 2026-08-29 that is CHECKED rather than merely asked for: the set-equality
 * assertion the three notes below used to request by hand now lives in
 * tests/permission-lookup-totality.test.ts, which runs in the required CI `validate` job.
 *
 * Why a name missing from THIS array is dangerous while the union still lists it. The union is a
 * compile-time type; `buildPermissionLookup` iterates the array. A resource present in one and not
 * the other therefore produces a lookup with no key for it — and `permissionAllowed` in
 * navigation/active-path.ts treats an unseen key as PERMITTED. The result is not a broken link or
 * an error: it is the module quietly offered to every role in the company.
 *
 * The per-resource notes further down record which specific modules that would expose. They are
 * kept because the reasoning is worth reading; the mechanism is stated once, here.
 */
export const permissionResources: PermissionResource[] = [
  "admin",
  "spotlight",
  "spotlight_self",
  "performance_card_self",
  "incentive",
  "milestones",
  "customer_identity",
  "overview",
  "admin_access",
  "system_cleanup",
  "imports",
  "sales",
  "weekly_sales",
  "direct_orders",
  "payroll",
  "deductions",
  "double_visit_analytics",
  "field_absence",
  "weekly_plans",
  "expenses",
  "market_awareness",
  "employees",
  "team",
  "offers",
  "probation",
  "resignations",
  "contracts",
  "coaching",
  "communication",
  "user_admin",
  "permission_admin",
  "workflow_registry",
  "employee_documents",
  "employee_profile",
  "vacancies",
  "organogram",
  "hr_calendar",
  "payslips",
  "outstation",
  "leave",
  "support_requests",
  "business_card_requests",
  "recruitment",
  "candidates",
  // Omitting this would offer CV Lookup — a search box over every CV the company holds, and the
  // file behind each hit — to EVERY role, because `permissionAllowed` treats a key the lookup has
  // never seen as PERMITTED. Mechanism at the head of this array.
  "cv_lookup",
  "account_activation",
  "hiring_interviews",
  "report_it",
  "attendance",
  "crm_visits",
  // Omitting this from the array would offer Plan Verification — a button that writes into the
  // customer's CRM — to every role in the company. Mechanism at the head of this array.
  "crm_plans",
  // Omitting this would offer native visit entry — a write into Phoenix's own visit record — to every
  // role. Mechanism at the head of this array.
  "crm_visit_entry",
  // Omitting this would offer doctor-list changes — a write into every rep's list — to every role.
  // Mechanism at the head of this array.
  "crm_contact_lists",
  // Omitting this would show the Early Birds tab to every role — Finance Manager, HR Operations,
  // Employee. "with no test failure" was true when this was written; it no longer is.
  "early_birds",
  "user_activity",
  "synthetic_journeys",
  // Mailbox compliance monitor — Super Admin only (hard boundary below). Omitting this would leak
  // the tab to every role.
  "mailbox_monitor",
  // Phase 6 (2026-08-28). Omitting either would offer the Mailbox Revocation register and the
  // Retention Register to every role in the company - including the leaver's own colleagues, and
  // Retention holds what people said in confidence about their manager and their pay.
  //
  // `mailbox_offboarding` was called `clearance` until 2026-09-01, when the Clearance & Offboarding
  // module was removed at the owner's instruction. The mailbox register was the one surviving
  // consumer of that resource, so it took a name of its own rather than keep a grant named after a
  // module that no longer exists - a resource whose name no longer matches anything is how a later
  // reader talks himself into "helpfully" widening it.
  "mailbox_offboarding",
  "retention",
  // Territory Management. Omitting this would offer the brick map — and its residence
  // recommendations, which name where the company's field force lives — to every role, since
  // `permissionAllowed` treats a key the lookup has never seen as PERMITTED. Mechanism at the head
  // of this array.
  "territory",
  // Company device register. Omitting this would offer it to every role, since `permissionAllowed`
  // treats a key the lookup has never seen as PERMITTED — and the payload names, per employee, the
  // serial and IMEI of the machine he is carrying and what the company values it at. That is a
  // shopping list, and it would be readable by the whole company.
  "company_devices",
  // Phoenix CRM. Omitting this would offer every territory's customer list, its doctors' timings and
  // clinic photos, and the plan and visit screens to every role. Mechanism at the head of this array.
  "phoenix_crm",
  // Visual Aids. Omitting this would offer the upload and retire buttons, and every line's flyers, to
  // every role. Mechanism at the head of this array.
  "visual_aids",
  // Production Planner. Omitting this would offer the whole raw-material plan — and the prices and
  // costs on it — to every role in the company. Mechanism at the head of this array.
  "production_planning",
  // HR Reminders. Omitting this would offer the HR team's private notes — and the Super Admin's
  // view of every one of them — to every role in the company. Mechanism at the head of this array.
  "hr_reminders",
  // HR Reports. Omitting this would offer every person's attendance and visit review — and the
  // decision on it — to every role in the company. Mechanism at the head of this array.
  "hr_ops_reports",
];

export const permissionActions: PermissionAction[] = [
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "export",
  "import",
];

export type AccessScope = "self" | "team" | "hierarchy" | "line" | "company" | "none" | "system";
export type BusinessScope = "SELF" | "TEAM" | "HIERARCHY" | "LINE" | "COMPANY" | "NONE";
/**
 * Which shell a viewer gets.
 *
 * `hr` is the third mode, added 2026-08-28 at the owner's instruction that the HR seats must not
 * sit on the admin addresses. It renders the SAME chrome as `admin` — same components, same
 * density, deliberately not a second design — but its own authored navigation, under the `/hr`
 * URL prefix. See middleware.ts for how a request reaches it.
 */
export type NavigationMode = "admin" | "employee-portal" | "hr";

/**
 * The seats that live in the `/hr` namespace.
 *
 * Membership is by BUNDLE NAME rather than by "does this role hold HR grants", and that is
 * deliberate: a derived test would silently pull in any future role that happened to gain an HR
 * resource, which is the fail-OPEN direction. Adding a seat here is a decision someone makes on
 * purpose.
 */
export const hrNamespaceRoles = new Set<PhoenixRole>(["HR Operations", "HR Resourcing", "HR Administration"]);

export function usesHrNamespace(role: PhoenixRole): boolean {
  return hrNamespaceRoles.has(role);
}

/** A test account's link to the real employee whose portal it lives in (src/lib/auth/test-persona.ts). */
export type TestPersonaLink = {
  /** The test account's own login id (`TEST-…`). */
  loginId: string;
  /** The real employee it mirrors — the same value as the context's `hrId`. */
  mirrorsHrId: string;
};

export type AccessContext = {
  hrId: string | null;
  loginId?: string | null;
  role: PhoenixRole;
  scope: AccessScope;
  source: "session" | "system" | "dev-header" | "guest";
  /**
   * Set ONLY on a test account's session. `hrId` and `role` are then the mirrored employee's, so every
   * read is hers — and nothing may write as her: see src/lib/auth/test-persona.ts for the guard.
   */
  testPersona?: TestPersonaLink | null;
};

export type PermissionMap = Record<PhoenixRole, Partial<Record<PermissionResource, PermissionAction[]>>>;

/**
 * A viewer's whole permission surface, flattened to `resource:action` -> boolean.
 *
 * TOTAL by construction: every resource crossed with every action, `false` where the matrix does
 * not grant it. Totality is the point. `permissionAllowed` in navigation/active-path.ts treats a
 * MISSING key as permitted (UX-only, and every destination re-asserts server-side), so a lookup
 * with holes in it silently shows links rather than hiding them. Building it in one place is what
 * makes that branch unreachable.
 *
 * This replaces 21 hand-written copies of the same nested loop across app/ and src/. They were
 * byte-identical in substance and all correct — which is exactly the problem: nothing forced them
 * to stay that way, and a 22nd copy written slightly differently is invisible until a link appears
 * for someone who should not see it. tests/permission-lookup-totality.test.ts pins both halves:
 * that this returns a total lookup, and that no copy has grown back.
 *
 * Kept here rather than beside the type in navigation/active-path.ts on purpose: the resource and
 * action arrays live in this module, and active-path.ts states in its own header that it stays free
 * of runtime dependencies so it can be unit-tested and imported by client components. Every one of
 * the 21 call sites is a server component that already imports from this file, so this adds no new
 * import edge anywhere — it removes two per page.
 */
export type NavigationPermissionLookup = Partial<Record<`${PermissionResource}:${PermissionAction}`, boolean>>;

export function buildPermissionLookup(matrix: PermissionMap, role: PhoenixRole): NavigationPermissionLookup {
  const lookup: NavigationPermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = matrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

type PermissionDbOverrideRow = {
  role_name: string | null;
  resource: string | null;
  action: string | null;
  is_allowed: boolean | null;
};

const allActions: PermissionAction[] = ["read", "create", "update", "delete", "approve", "export", "import"];
// Governance: approval authority is reserved for Super Admin / HR Manager.
// The HR bundles operate recruitment and personnel workflows but must not inherit the retired
// broad HR/payroll/leave/outstation authority — see HR_ROLE_BOUNDARIES in hr-functions.ts.
export const adminShellEmployeeRoles = [
  "SFE Manager",
  "Finance Manager",
  "Financial Advisor",
  // Owner decision 2026-08-28: the HR seats live on the ADMIN shell, not the employee portal. The
  // portal needs a second copy of every admin tool, and two of those copies shipped unreachable for
  // the seat this replaces.
  "HR Operations",
  // Talent Acquisition, 2026-10-08: the owner chose the admin shell on the access blueprint, the
  // same side as both other HR seats.
  "HR Resourcing",
  // HR Operations Specialist, 2026-10-20: the same HR shell as the other seats.
  "HR Administration",
] as const satisfies readonly PhoenixRole[];
const adminShellEmployeeRoleSet = new Set<PhoenixRole>(adminShellEmployeeRoles);

export function isAdminShellEmployeeRole(role: PhoenixRole): boolean {
  return adminShellEmployeeRoleSet.has(role);
}

// Every caller pairs this with a resource check — `isHrAuthorityRole(role) && canAccess(role, X, Y)` —
// so listing every HR bundle here is safe and the grant does the discriminating: the recruitment
// and offers pages also demand recruitment:read, which only HR Resourcing holds, and
// vacation control also demands leave:update, which only HR Operations holds. HR Resourcing MUST
// be here: hardBoundaryAllowedActions strips recruitment, candidates, offers, employee_documents,
// cv_lookup and the HR half of the two request desks from any role that is not.
export const hrAuthorityRoles = [
  "Super Admin",
  "HR Operations",
  "HR Resourcing",
] as const satisfies readonly PhoenixRole[];
const hrAuthorityRoleSet = new Set<PhoenixRole>(hrAuthorityRoles);
const hrSupportStaffActions: PermissionAction[] = ["read", "create", "update", "export"];
const supportRequestSenderActions: PermissionAction[] = ["create"];

export function isHrAuthorityRole(role: PhoenixRole): boolean {
  return hrAuthorityRoleSet.has(role);
}

/**
 * Who may OPEN the personal candidate inbox at /recruitment/candidates.
 *
 * This widens who can reach the screen, never what any of them can see. The page is a per-person
 * inbox rather than the candidate pool: listApplications() scopes to the requisitions the caller is
 * hiring manager for (canSeeApplication in src/lib/recruitment/access.ts), and
 * listCandidatesSentToManager() scopes to the caller's own HR_ID. Whoever opens it sees only the
 * CVs addressed to them — for most roles that is an empty screen, which is the honest answer.
 *
 * Owner request (2026-08-24): the gate read `access.role !== "CEO"`, so the Super Admin account
 * that owns the system was redirected off the one recruitment screen it could not otherwise
 * inspect. Its own named set rather than a widening of hrAuthorityRoles, for the same reason
 * outstationApprovalReviewRoles below is its own — running a hiring round and administering the
 * system are different privileges and must be able to diverge later without one dragging the other.
 */
// HR Resourcing (the Talent Acquisition seat) added 2026-10-08 — the owner ticked My Candidates for
// her. It lists the CVs addressed to HER, which is empty until somebody sends her one.
export const personalCandidateInboxRoles = ["CEO", "Super Admin", "HR Resourcing"] as const satisfies readonly PhoenixRole[];
const personalCandidateInboxRoleSet = new Set<PhoenixRole>(personalCandidateInboxRoles);

export function canOpenPersonalCandidateInbox(
  context: Pick<AccessContext, "role" | "scope">,
): boolean {
  return context.scope === "system" || personalCandidateInboxRoleSet.has(context.role);
}

export const systemAdministratorRoles = ["Super Admin"] as const satisfies readonly PhoenixRole[];
const systemAdministratorRoleSet = new Set<PhoenixRole>(systemAdministratorRoles);

export function canAccessSystemAdministratorWorkspace(context: Pick<AccessContext, "role" | "scope">): boolean {
  return context.scope === "system" || systemAdministratorRoleSet.has(context.role);
}

export function assertSystemAdministratorWorkspaceAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "system administrator workspace",
) {
  if (!canAccessSystemAdministratorWorkspace(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may READ the Company Vacation Report (/admin/vacation-report) — the org-wide register of
 * leave that carries the Source column, i.e. whether a day came from a request the employee
 * submitted through Phoenix or from the field CRM's own vacation marking.
 *
 * Owner request (2026-08-27): the SFE Manager must be able to see, and export, every employee's
 * vacation alongside where each one came from. Deliberately its own named set rather than a
 * widening of systemAdministratorRoles — the same reasoning as outstationApprovalReviewRoles
 * above: reading an org-wide report and administering the system are different privileges and
 * must be able to diverge later without one silently dragging the other along.
 *
 * READING is all this grants. The one write this report can perform — turning an unverified CRM
 * Signal row into a real, balance-deducting vacation request — keeps its own gate below and
 * stays Super Admin only, because the owner's instruction was explicit: he can read, he can
 * export, he cannot add.
 */
// HR Operations added 2026-08-29 (owner). Her job description's second area is "Attendance, Leave &
// Working-Time Administration" — "Maintain leave balances and ensure approved leave is correctly
// recorded" — which is this register and no smaller surface. Membership here rather than her new
// company scope is deliberate and is the whole point of the named-set convention: canReadCompany-
// VacationReport short-circuits on scope "system" only, so a company scope would NOT have admitted
// her, and this line is the only thing that does. READ and export; the one write this report can
// perform (turning a CRM Signal row into a balance-deducting request) keeps its Super-Admin-only
// gate below, untouched.
export const companyVacationReportReaderRoles = ["Super Admin", "SFE Manager", "HR Operations"] as const satisfies readonly PhoenixRole[];
const companyVacationReportReaderRoleSet = new Set<PhoenixRole>(companyVacationReportReaderRoles);

export function canReadCompanyVacationReport(context: Pick<AccessContext, "role" | "scope">): boolean {
  return context.scope === "system" || companyVacationReportReaderRoleSet.has(context.role);
}

export function assertCompanyVacationReportReadAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "the company vacation report",
) {
  if (!canReadCompanyVacationReport(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may READ the Company Activity Report (/admin/company-activity-report) — the day-by-day
 * account of what every employee actually did over a freely chosen date range (CRM field/campaign
 * visits, office attendance, leave activity, and gaps). Deliberately the SAME two roles as the
 * Company Vacation Report above, and its own named set for the same reason: reading an org-wide
 * report and administering the system are different privileges and must be able to diverge later
 * without one silently dragging the other along.
 *
 * Owner-confirmed 2026-08-28: this is NOT a payroll report — it exists purely for awareness and
 * accuracy review. It has no write path at all, so READING is all this ever grants.
 */
// HR Operations added 2026-08-29 (owner), for the same job-description area as the vacation
// report above: "Identify unexplained absences, missing punches or inconsistent records and
// follow up with the employee/manager before payroll closure". This report is the day-by-day
// account of attendance, leave activity and gaps, which is that sentence exactly. It has no
// write path at all, so reading is all this can ever grant.
export const companyActivityReportReaderRoles = ["Super Admin", "SFE Manager", "HR Operations"] as const satisfies readonly PhoenixRole[];
const companyActivityReportReaderRoleSet = new Set<PhoenixRole>(companyActivityReportReaderRoles);

export function canReadCompanyActivityReport(context: Pick<AccessContext, "role" | "scope">): boolean {
  return context.scope === "system" || companyActivityReportReaderRoleSet.has(context.role);
}

export function assertCompanyActivityReportReadAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "the company activity report",
) {
  if (!canReadCompanyActivityReport(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may turn ONE unverified "CRM Signal" row into a real, approved, balance-deducting vacation
 * request (app/api/vacation/company-report/approve).
 *
 * Deliberately unchanged and deliberately separate from the read helper above — the same split
 * canDecideOutstationExpenseApprovals makes below. Hiding the button in the table is a courtesy;
 * THIS is the boundary, and the approve POST route keeps asserting system-administrator access so
 * an SFE Manager request is refused server-side regardless of what the client renders.
 */
export function canApproveCompanyVacationReportRow(context: Pick<AccessContext, "role" | "scope">): boolean {
  return canAccessSystemAdministratorWorkspace(context);
}

/**
 * Who may READ the outstation expense approvals workspace, including its claim validation.
 *
 * Owner request (2026-08-08): the CEO must see whether a claim is corroborated by CRM evidence.
 * The page was Super Admin only, so he could not open it at all. This is the single, named
 * widening — deliberately its own set rather than a change to systemAdministratorRoles, because
 * reading a validation result and administering the system are different privileges and must be
 * able to diverge later without one silently dragging the other along.
 *
 * The CEO's scope is "company", not "system", so the scope shortcut above cannot admit him by
 * accident; membership of this set is the only thing that does.
 */
export const outstationApprovalReviewRoles = ["Super Admin", "CEO"] as const satisfies readonly PhoenixRole[];
const outstationApprovalReviewRoleSet = new Set<PhoenixRole>(outstationApprovalReviewRoles);

export function canReviewOutstationExpenseApprovals(
  context: Pick<AccessContext, "role" | "scope">,
): boolean {
  return context.scope === "system" || outstationApprovalReviewRoleSet.has(context.role);
}

export function assertOutstationExpenseApprovalReviewAccess(
  context: Pick<AccessContext, "role" | "scope">,
  workspace = "outstation expense approvals",
) {
  if (!canReviewOutstationExpenseApprovals(context)) {
    throw new Error(`Forbidden: ${context.role} cannot access ${workspace}.`);
  }
}

/**
 * Who may DECIDE an outstation expense — approve, reject, adjust the payable amount.
 *
 * Deliberately unchanged and deliberately separate from the read helper above. The CEO can read
 * every validation result and decide nothing; Super Admin remains the only role that moves money.
 * Hiding the buttons in the UI is a courtesy — THIS is the boundary, and the decision POST route
 * keeps asserting system-administrator access so a CEO request is refused server-side regardless
 * of what the client renders.
 */
export function canDecideOutstationExpenseApprovals(
  context: Pick<AccessContext, "role" | "scope">,
): boolean {
  return canAccessSystemAdministratorWorkspace(context);
}

function hardBoundaryAllowedActions(role: PhoenixRole, resource: PermissionResource): PermissionAction[] | null {
  switch (resource) {
    case "admin":
      return role === "Super Admin" ? allActions : [];
    case "admin_access":
    case "permission_admin":
    case "user_admin":
    case "system_cleanup":
    case "user_activity":
      return role === "Super Admin" ? allActions : [];
    case "synthetic_journeys":
      return role === "Super Admin" ? ["read"] : [];
    case "field_absence":
      // The owner's four, 2026-10-18 ("admin and national sales managers and SFE and CEO"), and READ
      // alone: the calendar is a view over records other modules own, so there is nothing to write.
      // Capped here so an override can never hand a rep or a district manager the list of names.
      return role === "Super Admin" || role === "CEO" || role === "National Sales Manager" || role === "SFE Manager" ? ["read"] : [];
    case "employees":
      if (role === "Super Admin") return allActions;
      // HR Operations maintains personnel records. She may not delete: her job description requires
      // records that survive an audit, so destruction stays Super Admin. This cap is belt-and-braces
      // over HR_ROLE_BOUNDARIES. (HR Advisory read them until the seat was retired, 2026-10-08.)
      if (role === "HR Operations") return ["read", "create", "update", "export", "import"];
      // The HR Operations Specialist keeps the master up to date and moves it in and out by sheet,
      // with every money field withheld server-side (isSalaryBlindRole). She does not ADD a person.
      if (role === "HR Administration") return ["read", "update", "export", "import"];
      return [];
    case "hr_ops_reports":
      // Her review is `update`; the decision is `approve`, the Super Admin's alone, so an override
      // can never hand a reviewer the right to decide her own recommendation.
      if (role === "Super Admin") return ["read", "update", "approve"];
      if (role === "HR Administration") return ["read", "update"];
      return [];
    case "mailbox_offboarding":
      // ops 6 - Resignation & Offboarding. HR Operations runs it; the CEO observes.
      // No delete for anyone but Super Admin: a mailbox revocation row is an ATTESTATION that a
      // leaver's company mail was actually closed, and both job descriptions require records that
      // survive an audit.
      if (role === "Super Admin") return allActions;
      if (role === "HR Operations") return ["read", "create", "update", "export"];
      if (role === "CEO") return ["read", "export"];
      return [];
    case "retention":
      // hrbp 3 - Retention & Employee Experience. HR Advisory only, and deliberately NOT HR
      // Operations: a stay discussion is someone telling HR what they think of their manager and
      // their pay, and an exit interview is the same in the past tense. Spreading it across the
      // HR department by default would be the quiet kind of privacy widening that
      // HR_ROLE_BOUNDARIES exists to catch - the same shape as the report_it:export entry.
      // The CEO reads it because company-wide turnover themes are exactly his question, and he
      // already reads every resignation and every payslip.
      // The HR Business Partner kept this register until the seat was retired on 2026-10-08; it is the
      // Super Admin's now ("Leave it for system administrator now"), and the CEO still reads it.
      if (role === "Super Admin") return allActions;
      if (role === "CEO") return ["read", "export"];
      return [];
    case "company_devices":
      // The custody receipt is signed by three parties — the holder, IT (مُسلِّم العهدة) and
      // Finance (اعتماد الإدارة المالية) — but only one of them has a seat in Phoenix that runs the
      // paperwork: HR Operations already prints the receipt out of the hiring pack at a joiner's
      // desk and closes it at an exit, so the register goes where that work already happens.
      //
      // No delete for anyone but Super Admin, the same rule mailbox_offboarding follows above. A
      // custody row is the record that a named person signed for a named machine; البند (10) of the
      // receipt makes it the basis of a wage deduction, so destroying one destroys both the
      // company's claim and the employee's defence against it.
      //
      // Finance Manager is deliberately NOT here yet. He signs the paper and البند (10) is his
      // clause, so a read grant is arguable — but it is the owner's call, not a default, and a
      // resource is easier to widen later than to narrow after people have used it.
      //
      // `import` is the ACTION rather than a resource of its own, because that is how every other
      // import in this codebase is gated (`employees:import`). Without it HR Operations — the seat
      // that actually walks the fleet and enters it — could register devices one at a time but not
      // in bulk, which for ~85 of them is the same as not at all. It opens no door that `create`
      // did not already open; it only names the bulk one so it can be withdrawn on its own.
      if (role === "Super Admin") return allActions;
      if (role === "HR Operations") return ["read", "create", "update", "export", "import"];
      if (role === "CEO") return ["read", "export"];
      return [];
    case "mailbox_monitor":
      // Reading employees' company mailboxes for compliance — the most sensitive surface in the
      // app. Super Admin (the owner) only; no other role, ever.
      return role === "Super Admin" ? allActions : [];
    case "employee_documents":
    case "recruitment":
    case "candidates":
    case "offers":
      return isHrAuthorityRole(role) ? allActions : [];
    case "cv_lookup":
      // READ AND NOTHING ELSE, for an HR authority role only — capped here rather than merely
      // left out of the matrix, because this is the one resource whose whole purpose is to be
      // narrower than the grant beside it. `candidates` above returns allActions, so a later
      // session that "tidies" CV Lookup into that case list, or that adds `cv_lookup: allActions`
      // to a role by hand, would silently turn a read-only search into a write surface over the
      // candidate pool. The cap makes both of those a no-op instead of a widening.
      //
      // No `export`: see the resource's own note. A result set that can be downloaded is the pool
      // in a spreadsheet, and the pool is exactly what this resource exists to withhold.
      return isHrAuthorityRole(role) ? ["read"] : [];
    case "support_requests":
      return isHrAuthorityRole(role) ? hrSupportStaffActions : supportRequestSenderActions;
    case "business_card_requests":
      // Same shape as support_requests: every employee may open a request for their own card
      // (create), HR staff read and work the queue. The sender's `create` is granted to every
      // role by the special-case in applyHardPermissionBoundaries below.
      return isHrAuthorityRole(role) ? hrSupportStaffActions : supportRequestSenderActions;
    // `hiring_interviews` is deliberately NOT hard-boundary-capped (falls to `default`
    // below) — it is a narrow, purpose-built resource (a hiring manager's own assigned
    // candidate + their own interview only, enforced by service-layer scoping in
    // src/lib/recruitment/hiring-manager-view.ts) and must stay independent of the broad
    // `recruitment`/`candidates`/`offers` HR-authority-only lock above.
    default:
      return null;
  }
}

export function isRolePermissionWithinHardBoundary(
  role: PhoenixRole,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  const allowedActions = hardBoundaryAllowedActions(role, resource);
  return !allowedActions || allowedActions.includes(action);
}

/**
 * Grants the base matrix DECLARES that the hard boundary then strips. Empty is the only healthy
 * answer, and a test pins it there.
 *
 * WHY THIS IS WORTH A FUNCTION. `applyHardPermissionBoundaries` deletes such a key at module load,
 * so a declaration like the CEO's `recruitment: ["read"]` is not a grant, a bug, or a safety net —
 * it is a sentence in a security file that says the opposite of what the system does. It reads as
 * deliberate, it survives review, and the next person to ask "can the CEO open recruitment?" gets
 * the wrong answer from the most authoritative-looking place in the codebase.
 *
 * The same check already exists one layer up for the composed HR seats, in
 * tests/hr-retention-register.test.ts, and its comment calls a stripped grant "a LIE IN THE WORKBOOK,
 * not a safety net". This is that check for the roles the base matrix spells out by hand.
 *
 * It returns the dead grants rather than exposing `defaultPermissionMatrix` itself, deliberately:
 * that object is PRE-boundary, and anything importing it would be reading permissions the system
 * does not honour — the exact confusion this exists to remove, handed out as an API.
 */
export function deadMatrixGrants(): Array<{
  role: PhoenixRole;
  resource: PermissionResource;
  actions: PermissionAction[];
}> {
  const dead: Array<{ role: PhoenixRole; resource: PermissionResource; actions: PermissionAction[] }> = [];
  for (const role of phoenixRoles) {
    for (const [resource, actions] of Object.entries(defaultPermissionMatrix[role]) as Array<
      [PermissionResource, PermissionAction[] | undefined]
    >) {
      const stripped = (actions ?? []).filter(
        (action) => !isRolePermissionWithinHardBoundary(role, resource, action),
      );
      if (stripped.length > 0) dead.push({ actions: stripped, resource, role });
    }
  }
  return dead;
}

/**
 * Minimum permissions that must never be denied via `role_permission_overrides`.
 * These are permissions that the employee portal requires for basic functionality;
 * revoking them via a DB override breaks portal pages with an unrecoverable
 * Forbidden error. The admin Access Control Manager checks this before persisting
 * a deny-override.
 */
export const portalMinimumPermissions: ReadonlyArray<{
  action: PermissionAction;
  resource: PermissionResource;
  roles: readonly PhoenixRole[];
}> = [
  { resource: "probation", action: "read", roles: phoenixRoles },
  { resource: "leave", action: "read", roles: phoenixRoles },
  { resource: "employee_profile", action: "read", roles: phoenixRoles },
  { resource: "payroll", action: "read", roles: phoenixRoles },
  // Payslips portal (/employee-portals/payslips) requires payslips:read for all
  // employee-portal roles that carry it by default. Without this floor, a deny-override
  // in role_permission_overrides can silently break the page with a Forbidden error.
  {
    resource: "payslips",
    action: "read",
    roles: [
      "Employee",
      "Medical Rep",
      "Manager",
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
      "Marketing Manager",
      "Training Manager",
      "CEO",
    ],
  },
  // Expense dashboard (/employee-portals/expense-dashboard) requires expenses
  // read for all employee-portal roles. Without this floor, a deny-override in
  // role_permission_overrides can silently break the page with a Forbidden error.
  {
    resource: "expenses",
    action: "read",
    roles: [
      "Employee",
      "Medical Rep",
      "Manager",
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
      "Marketing Manager",
      "Training Manager",
      "CEO",
    ],
  },
  // Submit-expense page (/employee-portals/submit-expense) requires outstation:create
  // for all roles that can reach it. Without this floor, a deny-override in
  // role_permission_overrides can silently break the page with a Forbidden error.
  {
    resource: "outstation",
    action: "create",
    roles: [
      "Employee",
      "Manager",
      "District Manager",
      "Regional Manager",
      "National Sales Manager",
      "Product Manager",
      "Group Product Manager",
      "Marketing Manager",
    ],
  },
];

export function isDenialBlockedByMinimumPermission(
  role: PhoenixRole,
  resource: PermissionResource,
  action: PermissionAction,
): boolean {
  return portalMinimumPermissions.some(
    (min) =>
      min.resource === resource &&
      min.action === action &&
      min.roles.includes(role),
  );
}

function applyHardPermissionBoundaries<T extends PermissionMap>(matrix: T): T {
  for (const role of phoenixRoles) {
    for (const resource of permissionResources) {
      const allowedActions = hardBoundaryAllowedActions(role, resource);
      if (!allowedActions) continue;

      if (resource === "support_requests" || resource === "business_card_requests") {
        matrix[role][resource] = [...allowedActions];
        continue;
      }

      const currentActions = matrix[role][resource] ?? [];
      const boundedActions = currentActions.filter((action) => allowedActions.includes(action));
      if (boundedActions.length > 0) {
        matrix[role][resource] = boundedActions;
      } else {
        delete matrix[role][resource];
      }
    }
  }
  return matrix;
}

const defaultPermissionMatrix: PermissionMap = {
  "Super Admin": {
    market_awareness: allActions,
    field_absence: ["read"],
    // Production Planner. No `delete`: a stock report and a recorded run are append-only facts
    // about a date, and a mistyped run is EXCLUDED from learning rather than removed.
    production_planning: ["read", "create", "update", "export"],
    admin: allActions,
    attendance: allActions,
    // Reads the native-visit pilot. `update` (the owner, 2026-09-14): he enters a visit FOR a chosen
    // rep, with no location and marked as entered by him, and reads every rep's saved visits. No
    // create/delete/approve: he is nobody's rep and nobody's accompanying manager, and a confirmation
    // is the named partner's own click.
    crm_visit_entry: ["read", "update"],
    // Changes any rep's doctor list directly. No `approve`: a rep's request is his manager's click.
    crm_contact_lists: ["read", "update"],
    // `update` added 2026-08-09 for the Doctor Coverage visit-norms editor
    // (/admin/doctor-coverage-settings). It gates ONLY that policy singleton — the CRM visit
    // mirror itself stays read-only everywhere, since it is a vendor mirror nothing may write.
    crm_visits: ["read", "update"],
    crm_plans: ["read", "approve"],
    // Phoenix CRM (owner, 2026-09-16: Add Visit and the report are tried from day one). Every entry
    // this seat makes is a TEST entry, excluded from every report; the service refuses a real one.
    // `update` is the Settings tab. No `delete`: nothing in the module is deleted.
    phoenix_crm: ["read", "create", "update", "approve"],
    early_birds: ["read", "approve"],
    communication: allActions,
    overview: ["read"],
    admin_access: ["read"],
    system_cleanup: allActions,
    // Bulk login-account/role admin (/api/admin/users/bulk) only. Employee-record bulk
    // import (/api/imports/employees/*) checks the `employees` resource instead, so
    // HR Operations' `employees` grant covers it without touching this key.
    imports: allActions,
    contracts: allActions,
    coaching: allActions,
    employee_documents: allActions,
    employee_profile: allActions,
    employees: allActions,
    expenses: allActions,
    hr_calendar: allActions,
    // Reads every HR team item and comments on any; creates, edits and removes only his own.
    hr_reminders: ["read", "create", "update", "delete"],
    // Reads every daily and weekly HR report, and decides each recommended row (approve).
    hr_ops_reports: ["read", "update", "approve"],
    outstation: allActions,
    leave: allActions,
    organogram: allActions,
    offers: allActions,
    payroll: allActions,
    payslips: allActions,
    deductions: allActions,
    double_visit_analytics: allActions,
    weekly_plans: allActions,
    probation: allActions,
    resignations: allActions,
    permission_admin: allActions,
    mailbox_monitor: allActions,
    mailbox_offboarding: allActions,
    retention: allActions,
    company_devices: allActions,
    workflow_registry: allActions,
    sales: allActions,
    territory: allActions,
    direct_orders: allActions,
    weekly_sales: allActions,
    team: allActions,
    user_admin: allActions,
    vacancies: allActions,
    recruitment: allActions,
    candidates: allActions,
    // `["read"]`, not allActions — the hard boundary caps every role at read, so allActions here
    // would be a dead grant (deadMatrixGrants() reports those, and a stripped entry is a sentence
    // in a security file that says the opposite of what the system does). He holds the whole pool
    // through `candidates` anyway; this is here so the owner can open the SAME screen HR
    // Operations opens and see exactly what she sees.
    cv_lookup: ["read"],
    hiring_interviews: allActions,
    report_it: allActions,
    // Activity Control Center: Super Admin only (read + export). Deliberately
    // omitted from every other role so the employee-monitoring surface stays
    // tightly held. Widen via role_permission_overrides if ever needed.
    user_activity: ["read", "export"],
    synthetic_journeys: ["read"],
    spotlight: ["read", "export"],
    // Milestones: the service-anniversary keepsake — the due list and the printable card.
    milestones: ["read", "export"],
    // Wave 2. `update` is the confirmation itself — a link, or a "not the same" ruling and its
    // withdrawal. No `delete`: a ruling is withdrawn, never erased, so the decision survives its
    // own reversal.
    customer_identity: ["read", "update", "export"],
    // Visual Aids: uploads, retires and replaces, and opens every line's. No `delete` for anyone —
    // a flyer is retired, never destroyed.
    visual_aids: ["read", "create", "update"],
  },
  CEO: {
    field_absence: ["read"],
    // Spotlight: read and export. The owner named him and the Super Admin as the only two holders.
    spotlight: ["read", "export"],
    // Production Planner (owner, 2026-10-05): "the main controller is the R&D manager Dr. Sahar
    // Khalil and the CEO Dr. Anwar" — so full control here, not the observational read the CEO
    // account carries on the irreversible HR and finance workflows below.
    production_planning: ["read", "create", "update", "export"],
    // 🔴 NO `milestones` HERE, AND NOT BY OVERSIGHT. The owner took it off the CEO on 2026-09-23
    // ("not approved. Make it only super admin. None either uh, CEO."), so the grant is DELETED
    // rather than emptied — `milestones: []` would still name him a holder to the union that
    // builds the resource list, and to every screen that reads it.
    // Market Awareness: he is the second and final approval on every activity — no cost
    // threshold skips him (owner answer 36). `approve` here is HIS action; nothing in this module
    // may ever write a decision row on his behalf.
    market_awareness: ["read", "approve", "export"],
    // Segregation of duties: the CEO account is observational on irreversible HR/finance
    // workflows. It may read/export attendance but not create/update/delete records.
    attendance: ["read", "export"],
    crm_visits: ["read"],
    // Read but NOT approve, the same segregation of duties as the line above: verifying a plan
    // writes into the customer's CRM and cannot be undone from Phoenix, so it is an irreversible
    // workflow and this account stays observational on it. The Plans board opens; the button does
    // not render and the route refuses it.
    crm_plans: ["read"],
    // Phoenix CRM: reads the company's lists, plans, visits and reports; decides nothing.
    phoenix_crm: ["read"],
    early_birds: ["read"],
    overview: ["read"],
    imports: ["read"], // Bulk user-admin preview only — see Super Admin's `imports` note above.
    // SoD: read/export only — contract renew/not-renew (can drive termination)
    // belongs to Super Admin/HR. The CEO is observational on contracts.
    contracts: ["read", "export"],
    coaching: ["read"],
    employee_profile: ["read", "update", "export"],
    // NOTE: hard boundary (hardBoundaryAllowedActions → "employees" → Super Admin only) removes
    // these actions at runtime. CEO sees only their own employee record via canSeeEmployee().
    // getEmployeeDirectoryRows() (unfiltered) is used on the command center for headcount only.
    // SoD: read/export only — expense approval belongs to managers + Finance/Super Admin.
    expenses: ["read", "export"],
    // SoD: read/export only — outstation approval belongs to managers + Super Admin.
    outstation: ["read", "export"],
    // Retained by owner decision: CEO approves leave (and excuses, modeled under leave)
    // for their own direct reports. The decide path binds the actor to the active approval
    // step, so this stays scoped to the CEO's chain and does not over-grant.
    //
    // `create` added 2026-08-29 (owner, asked directly). The CEO is an employee and files his own
    // vacation like everyone else. Without it, /leave-management/vacation-request named him in its
    // `roles:` list while the ANDed `leave:create` clause hid the row — and the page itself carries
    // no permission gate at all, so he could always submit a request by typing the address and was
    // simply never offered the link. Narrow by construction: the only route keyed on leave:create
    // is the attachment upload for the caller's own request. `approve` is untouched, so the
    // segregation of duties above still holds — he creates his own and decides his reports'.
    leave: ["read", "create", "approve", "export"],
    // SoD: read/approve/export only — the CEO is the final approver of direct orders but
    // never creates/edits them (the decide path binds the actor to the active CEO step).
    direct_orders: ["read", "approve", "export"],
    organogram: ["read", "export"],
    payroll: ["read", "export"],
    probation: ["read"],
    workflow_registry: ["read"],
    payslips: ["read", "export"],
    // SoD: read/export only — deduction decisions belong to the governance actors.
    deductions: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    // Retained by owner decision: CEO approves weekly plans for their direct reports.
    // The approval path binds the actor to the active approval step via the plan workspace,
    // so this stays scoped to the CEO's chain and does not over-grant company-wide.
    weekly_plans: ["read", "approve", "export"],
    // SoD: read/export only — resignation finalization belongs to Super Admin/HR.
    resignations: ["read", "export"],
    sales: ["read", "export"],
    // Territory Management, split out of `sales:read` on 2026-09-07. Same reach as before —
    // this key exists so the map can be granted without the money pages, not to narrow anyone.
    territory: ["read"],
    weekly_sales: ["read", "export"],
    team: ["read", "export"],
    vacancies: ["read", "export"],
    // NO `recruitment` and NO `candidates`, and their absence is the accurate statement.
    //
    // Both were declared here as ["read"] and neither ever took effect: they are hard-boundary
    // capped to `isHrAuthorityRole`, which the CEO is not, so applyHardPermissionBoundaries deleted
    // both keys at module load and `canAccess(ceo, "candidates", "read")` has always been false.
    // tests/ceo-account-contract.test.ts pins that it must stay false — the two lines were claiming
    // exactly what the contract forbids. Removing them changes no behaviour; it stops the most
    // authoritative-looking file in the codebase from answering "can the CEO read candidates?" with
    // the opposite of the truth. See deadMatrixGrants().
    //
    // NSM/RM/CEO candidate tracking: CEO's own hiring round (District Manager -> HR/RM
    // -> National Sales Manager -> CEO for a District Manager candidate). Deliberately NOT
    // hard-boundary-capped (see hiring-manager-view.ts) so this grant actually takes effect — it is
    // the one recruitment-shaped resource the CEO genuinely holds, and the reason he is not
    // shut out of his own hiring round by the two lines removed above.
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create", "export"],
    // SoD: read/export only, matching `resignations` above - the CEO observes an exit, he does
    // not record that a leaver's mailbox was actually closed.
    mailbox_offboarding: ["read", "export"],
    retention: ["read", "export"],
    // Same SoD line. The CEO reads what the company owns and what has walked out of the door with
    // a leaver — that is his question — and does not record a handover or price a settlement.
    company_devices: ["read", "export"],
  },
  // ── The two HR seats, composed from functions ─────────────────────────────────────────────
  // These entries are NOT hand-maintained. Each is the union of the grants carried by the
  // functions its bundle holds (src/lib/auth/hr-functions.ts), where every function traces to a
  // numbered section of the job description the owner supplied on 2026-08-28.
  //
  // To change what a seat can do, move a function key between the bundles in that file — do not
  // add a key here. A grant added here would have no job-description line behind it, which is
  // exactly how the seat this replaces accumulated company-wide employee write access over four
  // months of one-off expansions.
  //
  // What each holds today (hr-functions.ts is the source; this is a reading aid):
  //   HR Operations  people_records · time_attendance · payroll_inputs ·
  //                  performance_probation · hr_governance · cv_lookup
  // The HR Business Partner seat (HR Advisory) is retired — see the entry below and
  // UNASSIGNED_HR_FUNCTIONS for the work that is the Super Admin's until he hands it to a seat.
  // RETIRED 2026-10-08 (retiredPhoenixRoles): holds nothing. Its bundle is gone from hr-functions.ts.
  "HR Advisory": {},
  "HR Operations": hrBundleGrants("HR Operations"),
  //   HR Resourcing  recruiting · cv_lookup · employee_requests · workforce_context · recognition
  //                  (shown as Talent Acquisition; built from the owner's 2026-10-08 blueprint)
  "HR Resourcing": hrBundleGrants("HR Resourcing"),
  //   HR Administration  attendance_review · people_master · team_reminders
  //                      (shown as HR Operations Specialist; built from the owner's 2026-10-20 answers)
  "HR Administration": hrBundleGrants("HR Administration"),
  // Finance Manager (Ahmed El Maraghy, B-185 — the only holder): the company's finance execution
  // point. He EXECUTES money movements that others have already approved; he does not approve the
  // spend itself. Retuned 2026-08-10 on owner instruction, when the account was activated for the
  // first time since it was created on 2026-05-02.
  //
  // (The comment that used to sit here described Financial Advisor, whose real block is below.)
  "Finance Manager": {
    // Production Planner (owner, 2026-10-05): "and the finance manager, Mr. Ahmed El Maraghi, also
    // open to him, read only, read only." He sees the costed plan and takes the workbook; he does
    // not draft, commit or record anything.
    production_planning: ["read", "export"],
    // Market Awareness: informed for execution, plus the paid / not-paid mark — `update`. This is
    // deliberately NOT the marketing invoice obligation (no hold, no overdue nudge).
    market_awareness: ["read", "update", "export"],
    // No `update`: it is asserted NOWHERE in the codebase, so it granted nothing — but it would
    // have silently handed him order mutation the day anyone added an
    // assertPermission(access, "direct_orders", "update") to an edit route. `read` is what the
    // sales-month setter checks (setDirectOrderSalesMonth), and `export` covers the report and
    // its share links.
    direct_orders: ["read", "export"],
    attendance: ["read", "export"],
    crm_visits: ["read"],
    employee_profile: ["read", "update"],
    // NO `outstation` key at all (owner, 2026-08-10): "exclude him 100% from outstation or
    // expenses". Outstation expense claims are a field-operations module the HR Manager approves
    // and Super Admin administers; he has no duty in it. Removing the key — rather than trimming
    // actions — is what closes /api/admin/outstation/**, the Expense Command Center, the expense
    // queue, manual entry, the historical upload and the dashboards in one move.
    //
    // `expenses` is cut to a bare `read` and is NOT an expense grant any more. It survives for one
    // reason only: `expenses:read` is the permission the WHOLE /api/marketing-requests/** namespace
    // is gated on (see access-registry.ts), including /api/marketing-requests/:id/decision and
    // /finance-evidence — the two routes he uses to execute the terminal `finance_execution` rung
    // and attach the money-transfer proof. Delete this key and the rung activated on 2026-08-10
    // becomes a dead end nobody can clear. It buys him nothing on the expense side: getExpensesScope
    // now returns SELF for this role, every outstation page/nav/hub row is gone, and `approve` (the
    // action outstation actually gates its writes on) was never held.
    //
    // If the marketing routes are ever re-gated onto a marketing-specific resource, this key should
    // be deleted outright — it exists only to bridge that collision.
    expenses: ["read"],
    // `approve` added 2026-08-10 (owner): he is the direct manager of three head-office staff
    // (OF-0001, A-1, A-4) and their vacations route to him. This is only the COARSE gate — both
    // decide paths still bind the actor to an assigned pending approval step
    // (getPendingVacationApprovalStepForActor), so a company-scoped role cannot decide anyone
    // else's leave. The Workflow Registry `leave_requests` module is a SECOND, fail-closed gate
    // and must name this role too, or the decision 403s after passing this one.
    //
    // `create` added 2026-08-10 — a BUG FIX, not a widening. The "Request Vacation" row under My
    // Requests is shown to every adminShellEmployeeRole, but its page guard
    // (requireAdminShellEmployeeWorkspaceAccess with action "create") is a PERMISSION check, and
    // he was the only one of the four without the grant. Pressing his own Request Vacation row
    // silently redirected him to /admin/outstation/expense-command — and an admin-shell role has
    // no employee portal, so he had no way to file leave anywhere on the system. SFE Manager,
    // Financial Advisor and the HR bundles all already hold it.
    //
    // Scope is exactly self-service: getVacationRequestPageData, createVacationRequest,
    // resubmitVacationRequest, and the attachment upload URL. It cannot reach company vacation
    // administration — canManageVacationRecords additionally requires leave:DELETE (which he does
    // not hold) plus isAllVacationVisibility, and assertVacationAdminManagement re-checks that
    // same visibility — so `create` on its own moves nothing there.
    leave: ["read", "create", "export", "update", "approve"],
    // Read + export ONLY (owner, 2026-08-10) — deliberately NOT allActions. He keeps everything
    // finance actually needs: the payroll page (with getPayrollScope === COMPANY), the BANK
    // TRANSFER FILE and the statutory summary (both gated on `export`), and the Automated Payroll
    // finance/CIB/FAB sheets (those gate on isAutomatedPayrollFinanceActor, an allow-list
    // independent of this matrix). What he loses is destructive: deleting a salary batch,
    // uploading/replacing payroll, and driving the payroll workflow. `read` must stay — it is a
    // portalMinimumPermissions floor, and payroll_workflow_alert re-checks it per recipient.
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    deductions: ["read", "export"],
    weekly_plans: ["read", "export"],
    // RESTORED 2026-08-10 (owner), together with the `case "Finance Manager": return "COMPANY"` arm
    // in getSalesScope below. **These two must never be separated.** The grant was removed earlier
    // the same day because it passed this permission gate while getSalesScope fell through to NONE:
    // every Source-of-Sales query returned zero rows and the page showed an empty table with no
    // explanation. The grant is not the fix — the grant PLUS the scope arm is.
    //
    // COMPANY specifically, not a narrower scope: his employees.line_name is "Office", which
    // bridgeEmployeeLineToOfficial maps to "Head Office" (sales/official-lines.ts), and every line
    // filter drops Head Office. At any scope below COMPANY his available-line list resolves EMPTY
    // and the Monthly Closing export 403s on every line.
    //
    // NO `import`. That single action is the upload/publish workspace's key — it gates
    // /sales/monthly-closing, /sales/upload, /sales/mapping-database and eight more, plus the
    // "Monthly Closing" hub card. He CONSUMES the closing; he does not produce or publish it.
    //
    // Restricted products stay hidden: canViewRestrictedProducts is CEO + Super Admin only and is
    // untouched. That costs him nothing on the closing — every LA003/LA004/SS001 row sits on the
    // Head Office line, which listMonthlyClosingLines excludes for EVERYONE including the CEO, so
    // his workbook matches the CEO's exactly. It does bite on Source of Sales, where Head Office is
    // ~80% of company value; sos-dashboard-impl.tsx labels that on the figure itself.
    sales: ["read", "export"],
    // Organogram (owner, 2026-08-10). The grant alone is NOT sufficient and never was: the page has
    // TWO gates, and canAccessCompanyOrganogram in src/lib/reports/organogram.ts is the second one.
    // He is named there explicitly, and in canAccessHeadOffice — he is head-office staff, so without
    // the latter his own department is invisible in the very view he was granted.
    organogram: ["read"],
    // Resignations — READ ONLY (owner, 2026-08-10). Company-wide with no scope work needed:
    // isCompanyResignationReader (src/lib/resignations/service.ts) already short-circuits on
    // access.scope === "company", which this role has.
    //
    // Deliberately NOT create/update/approve. Acting on a resignation needs two further levers he
    // does not have and is not getting: a Workflow Registry row (a DB edit; the module is
    // fail-closed and currently lists Super Admin / CEO / the HR bundles), and a company-scope
    // branch in canSeeEmployee — which has none, so today he can only act on his own record.
    resignations: ["read"],
    workflow_registry: ["read"],
    report_it: ["read", "create", "export"],
  },
  // New role: executes the Finance step of marketing requests from the /workspace admin shell.
  // Deliberately narrow — marketing-finance participation (granted via the marketing service
  // role-sets, not a permission resource) + own self-service only; NO HR/payroll/employee authority.
  "Financial Advisor": {
    attendance: ["read"],
    crm_visits: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    leave: ["read", "create"],
    payslips: ["read", "export"],
    report_it: ["read", "create"],
  },
  Employee: {
    attendance: ["read"],
    crm_visits: ["read"],
    overview: [],
    coaching: ["read"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    report_it: ["read", "create"],
  },
  "Medical Rep": {
    attendance: ["read"],
    crm_visits: ["read"],
    // Native visit entry — his OWN visits only, and only while his line is the pilot line.
    crm_visit_entry: ["read", "create", "delete"],
    // Asks for a change to his OWN doctor list; his manager decides it.
    crm_contact_lists: ["read", "create"],
    // Phoenix CRM: validates the territory's customers, files the weekly plan and enters its visits —
    // the rep's OWN territory only, from the day the line opens (narrowed below the matrix).
    phoenix_crm: ["read", "create"],
    early_birds: ["read"],
    overview: [],
    coaching: ["read"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "update"],
    payroll: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    payslips: ["read", "export"],
    // Visual Aids: opens the active flyers of his OWN line on the tablet — narrowed below the matrix
    // by resolveVisualAidReaderLines, never by this grant.
    visual_aids: ["read"],
    report_it: ["read", "create"],
    // Spotlight (self): his OWN recognition sheet over any period he picks, and the pic/PDF only at
    // 90%+ against the published closing (owner, 2026-09-30). `read` powers the on-screen preview;
    // `export` renders the picture or the PDF. Self-scope is enforced in the loader by his session
    // HR id, never a wire field — this grant reaches nobody else's numbers.
    spotlight_self: ["read", "export"],
    // The performance card (self): his own banner, rank and achievement chart as a picture or a
    // PDF, plus the public link that carries it to LinkedIn/Facebook/WhatsApp. `export` is the only
    // action — there is nothing to read that his landing page does not already show him.
    performance_card_self: ["export"],
  },
  "District Manager": {
    // Market Awareness: NO GRANT. He held `read` as an informed party (owner answers 42 and 43)
    // until 2026-09-12, when the owner asked for the module to be hidden from district managers
    // outright — it is "only applicable for product or group product managers and marketing and
    // national sales manager". Removing the grant is what makes the hide real: the sidebar list in
    // employee-portal/navigation.ts is UX only, so leaving `read` here would have kept every route,
    // every activity and the approval announcement open to him behind a missing link.
    direct_orders: ["read", "create", "update", "approve", "export"],
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    // The seat this feature was built for. `approve` verifies a rep's plan straight into the CRM;
    // it is narrowed AGAIN, below the matrix, to the reps actually beneath this manager in the org
    // tree — the permission says he may verify a plan, not that he may verify anyone's.
    crm_plans: ["read", "approve"],
    // Confirms a native visit a rep says he accompanied — only when HE is the partner named on it and
    // the rep is beneath him. `create`/`delete`: the owner, 2026-09-14 — in rare cases he submits a
    // single visit without the rep, to one of his reps' doctors. He files no weekly plan.
    crm_visit_entry: ["read", "create", "delete", "approve"],
    // Answers a doctor-list request — only one sent to HIM, for a rep beneath him.
    crm_contact_lists: ["read", "approve"],
    // Phoenix CRM: `approve` decides the grade and drop requests and approves the weekly plans of the
    // territories this seat reviews; `create` is a visit to a customer of a territory beneath it (the
    // rep enters a double visit as a rule). Both narrowed below the matrix by the organogram.
    phoenix_crm: ["read", "create", "approve"],
    early_birds: ["read", "approve"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    // Spotlight (self): his OWN district's recognition sheet over any period he picks, and the
    // pic/PDF only at 90%+ against the published closing (owner, 2026-09-30, extending the rep's).
    // A DM's own achievement IS his district — the loader totals the reps under his seat, exactly as
    // the Monthly Closing grades him (rollupAchievementByDm) — and it reaches no other district.
    spotlight_self: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read", "export"],
    sales: ["read", "export"],
    // Territory Management (the portal twin at /employee-portals/territory-management). His own
    // areas only — resolveTerritoryScope still narrows the map to his seat's areas.
    territory: ["read"],
    weekly_sales: ["read", "export"],
    team: ["read", "export"],
    vacancies: ["read", "export"],
    weekly_plans: ["read", "create", "update", "approve"],
    hiring_interviews: ["read", "update"],
    // Visual Aids: opens the active flyers of his OWN line on the tablet — narrowed below the matrix
    // by resolveVisualAidReaderLines, never by this grant.
    visual_aids: ["read"],
    report_it: ["read", "create"],
  },
  "Regional Manager": {
    direct_orders: ["read", "create", "update", "approve", "export"],
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    // Sits directly above the district manager in the same tree, so a plan a DM may verify is
    // already inside this seat's subtree. Granted so a plan is not stranded whenever a district
    // seat is vacant — which is exactly when someone above has to act.
    crm_plans: ["read", "approve"],
    crm_visit_entry: ["read", "approve"],
    // A request goes to the rep's NEAREST active manager, so this seat answers one only while the
    // district seat above that rep is vacant.
    crm_contact_lists: ["read", "approve"],
    // Phoenix CRM: reads the region; decides and approves only as the nearest manager above the rep
    // (a vacant district seat). Enters no visits: the rep enters a chain visit.
    phoenix_crm: ["read", "approve"],
    early_birds: ["read"],
    overview: [],
    // NO `deductions` grant (owner instruction, 2026-08-06: "everyone can only see his deductions
    // only"). This previously read `["read"]`, declared to match a portal page that widened a
    // Regional Manager to their whole management subtree. That widening is gone —
    // collectPortalDeductionScope is now self-only for every role — so the grant has no remaining
    // justification, and while it stood it also opened the company-wide admin endpoints
    // (/api/admin/deductions/*), whose only check was this same `deductions:read`. That let a
    // read-only role download every employee's deduction amounts for any month.
    // A Regional Manager still sees their OWN deductions: the portal page and its nav entry both
    // gate on `employee_profile`, not on this resource.
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    // `export` added 2026-07-30 alongside canExportProbation (src/lib/probation/service.ts), which
    // is what actually enforces this. Matches District Manager and National Sales Manager, the rungs
    // either side of the RM. Scoped, not company-wide: the export is built from getProbationRows,
    // which filters every employee through canReadProbationEmployee, so an RM downloads exactly the
    // med reps in their own subtree — the same rows the tracker already shows them.
    probation: ["read", "export"],
    sales: ["read", "export"],
    // Territory Management (portal twin), narrowed to his own region by resolveTerritoryScope.
    territory: ["read"],
    weekly_sales: ["read", "export"],
    team: ["read", "export"],
    // Same undeclared-access correction as `deductions` above: getEmployeePortalVacancies already
    // has an explicit Regional Manager branch that bounds open seats to the RM's own line AND the
    // regions inside their management subtree (regionsWithinManagerHierarchy), but the grant was
    // never declared — so the page's canAccess gate refused every RM and that branch was dead code.
    // Read-only + export, matching District Manager (team-scoped) and National Sales Manager
    // (line-scoped); every vacancy WRITE surface stays on `vacancies:create`, which RM does not have.
    vacancies: ["read", "export"],
    weekly_plans: ["read", "create", "update", "approve"],
    hiring_interviews: ["read", "update"],
    // Visual Aids: opens the active flyers of his OWN line on the tablet — narrowed below the matrix
    // by resolveVisualAidReaderLines, never by this grant.
    visual_aids: ["read"],
    report_it: ["read", "create"],
  },
  "National Sales Manager": {
    // Market Awareness: an APPROVER since the parallel group shipped (2026-09-09). Every activity
    // waits on the Marketing Manager and on the National Sales Manager of each line it targets, so
    // this seat holds `approve` for the same reason the Marketing Manager does. It reads far
    // narrower than it looks: `approve` gates exactly one route, the decision POST, and
    // `canDecideSlot` then admits him to HIS line's slot only — three people hold this title, one
    // per line. Without it he was routed a decision the route refused him, which is a queue that
    // cannot be cleared by the only person allowed to clear it.
    market_awareness: ["read", "approve", "export"],
    // His own line only — the scope is the NSM seat he holds (src/lib/field-absence/access.ts).
    field_absence: ["read"],
    direct_orders: ["read", "create", "update", "approve", "export"],
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    crm_visit_entry: ["read", "approve"],
    // Same as the Regional Manager: a request reaches him only when he is the rep's nearest manager.
    crm_contact_lists: ["read", "approve"],
    // Phoenix CRM: the same as the Regional Manager, on the line.
    phoenix_crm: ["read", "approve"],
    early_birds: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create", "export"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    probation: ["read", "export"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    // Territory Management (portal twin), narrowed to his own line by resolveTerritoryScope.
    territory: ["read"],
    weekly_sales: ["read", "export"],
    team: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read", "export"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    // Visual Aids: opens the active flyers of his OWN line on the tablet — narrowed below the matrix
    // by resolveVisualAidReaderLines, never by this grant.
    visual_aids: ["read"],
    report_it: ["read", "create"],
  },
  "Product Manager": {
    // Market Awareness: raises activities, sees his OWN only. The narrowing to his own rows is in
    // scope.ts, not here — the matrix says he may read the module, never whose rows.
    market_awareness: ["read", "create", "export"],
    direct_orders: ["read", "create", "update", "export"],
    attendance: ["read"],
    // `update` = the Doctor Coverage visit-norms editor only (owner, 2026-08-09: PM, GPM and
    // Marketing Manager set the norms themselves). The CRM visit MIRROR stays read-only for
    // every role — it is a vendor mirror nothing may write. Note the norms are one GLOBAL
    // setting: an edit here changes the coverage rule for all three lines, not just this
    // role's own. Owner accepted that trade-off explicitly when granting it.
    crm_visits: ["read", "update"],
    // Phoenix CRM — READ ALONE, for ONE report (owner, 2026-10-02: "product managers and marketing see
    // it too — for their own products, company-wide, never per rep and never any honesty figure"):
    // what the field heard about his own products. He holds no seat in the sales organogram, so every
    // other Phoenix CRM read answers him with nothing or a refusal, exactly as it answers the Training
    // Manager's read; `create`, `update` and `approve` are what resolvePhoenixCrmViewer turns into
    // entering visits and deciding them, and he does none of those (src/lib/phoenix-crm/server/access.ts
    // `readsFieldHeardByProduct`, pinned by tests/phoenix-crm-insight-reports.test.ts).
    phoenix_crm: ["read"],
    early_birds: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "update"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
  "Group Product Manager": {
    // Market Awareness: raises activities AND is the manager step for the PMs who report to her.
    market_awareness: ["read", "create", "approve", "export"],
    direct_orders: ["read", "create", "update", "export"],
    attendance: ["read"],
    // `update` = the Doctor Coverage visit-norms editor only (owner, 2026-08-09: PM, GPM and
    // Marketing Manager set the norms themselves). The CRM visit MIRROR stays read-only for
    // every role — it is a vendor mirror nothing may write. Note the norms are one GLOBAL
    // setting: an edit here changes the coverage rule for all three lines, not just this
    // role's own. Owner accepted that trade-off explicitly when granting it.
    crm_visits: ["read", "update"],
    // Phoenix CRM — READ ALONE, for ONE report (owner, 2026-10-02: "product managers and marketing see
    // it too — for their own products, company-wide, never per rep and never any honesty figure"):
    // what the field heard about his own products. He holds no seat in the sales organogram, so every
    // other Phoenix CRM read answers him with nothing or a refusal, exactly as it answers the Training
    // Manager's read; `create`, `update` and `approve` are what resolvePhoenixCrmViewer turns into
    // entering visits and deciding them, and he does none of those (src/lib/phoenix-crm/server/access.ts
    // `readsFieldHeardByProduct`, pinned by tests/phoenix-crm-insight-reports.test.ts).
    phoenix_crm: ["read"],
    early_birds: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "update"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    // Visual Aids (owner, 2026-09-18): one of the three uploaders. Uploads a flyer against a line,
    // retires it, replaces it with a newer version. No `delete` — a flyer is never destroyed.
    visual_aids: ["read", "create", "update"],
    report_it: ["read", "create"],
  },
  "SFE Manager": {
    market_awareness: ["read", "export"],
    field_absence: ["read"],
    // `approve` added 2026-08-02 on owner instruction, alongside the Direct Orders Approvals
    // sidebar entry. This is APPROVAL AUTHORITY over direct orders, not just visibility — the
    // page carries no guard of its own, so showing it without this grant would only produce
    // buttons that 403.
    direct_orders: ["read", "export", "approve"],
    attendance: ["read", "create", "update", "delete", "export"],
    // See the Super Admin note: `update` is the Doctor Coverage visit-norms editor only. SFE
    // Manager owns this module, so he sets the norms. CEO is deliberately NOT granted it —
    // that account stays observational by design.
    crm_visits: ["read", "update"],
    // Owns the doctor lists once iReports360 stops: changes any rep's list directly.
    crm_contact_lists: ["read", "update"],
    // Phoenix CRM (owner, 2026-09-16: "the SFE sees every plan and can return one"). Reads the
    // company; `approve` is narrowed below the matrix to RETURNING a plan — the district manager
    // approves, and grade and drop requests stay the district manager's.
    phoenix_crm: ["read", "approve"],
    early_birds: ["read"],
    overview: ["read"],
    // Read-only org structure (2026-08-02): needed for /organogram. Grants no write anywhere —
    // seat/vacancy mutations are gated separately.
    organogram: ["read"],
    // Field Workforce Compliance gates on hr_calendar:read. Read-only: it is the working-day
    // calendar the compliance view is computed against, not an HR authoring grant.
    hr_calendar: ["read"],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: allActions,
    coaching: ["read"],
    // SFE Manager submits the (data-driven) SFE probation assessment. probation:read admits them
    // through the coarse route/middleware gate; the fine boundary (canSubmitSfeAssessment) still
    // restricts writes to SFE Manager / probation admin.
    probation: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    sales: ["read", "import", "export"],
    // Territory Management. Carried over verbatim from `sales:read`, which gated the module
    // until 2026-09-07 — he owns the brick/area geography and loses nothing in the split.
    territory: ["read"],
    weekly_sales: allActions,
    weekly_plans: ["read", "create", "update"],
    report_it: ["read", "create"],
  },
  "Training Manager": {
    attendance: ["read"],
    crm_visits: ["read"],
    early_birds: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    // NOTE: the `employees` (employee-master admin) resource is intentionally NOT granted —
    // it is Super-Admin-only at the hard boundary. Training Manager's org-wide directory
    // visibility comes from `team`/`employee_profile` reads + the Training-Manager branch in
    // canSeeEmployee(), not from employee-master admin access.
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read", "create", "update"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read", "export"],
    team: ["read"],
    vacancies: ["read"],
    organogram: ["read"],
    weekly_plans: ["read", "create", "update"],
    report_it: ["read", "create"],
    // Owner, 2026-09-22: "give SFE and Training Manager the full company list too". The SFE Manager's
    // grant landed that day; this one did not, so `DIRECTORY_COMPANY_ROLES` (phoenix-crm/server/
    // doctors.ts) named the Training Manager while `assertPermission(access, "phoenix_crm", "read")`
    // refused him at the door — the directory he was promised answered 403 to every call.
    // READ ALONE, deliberately: `create`, `update` and `approve` are what resolvePhoenixCrmViewer
    // turns into entering visits, requesting list changes and deciding them (access.ts), and he does
    // none of those. He also holds no sales seat, so `territoryForRead` still refuses him every
    // territory — the owner's own ruling of the same day, "The list is enough for him".
    phoenix_crm: ["read"],
  },
  // Marketing Manager uses the employee portal like PM/GPM for reports and sidebar modules,
  // while HR authority remains blocked.
  "Marketing Manager": {
    // Market Awareness: raises activities and is the manager step for the PMs reporting to him.
    // His own request skips the manager step and goes straight to the CEO — he reports to the CEO,
    // so there is no step underneath (owner answer 35).
    market_awareness: ["read", "create", "approve", "export"],
    attendance: ["read"],
    // `update` = the Doctor Coverage visit-norms editor only (owner, 2026-08-09: PM, GPM and
    // Marketing Manager set the norms themselves). The CRM visit MIRROR stays read-only for
    // every role — it is a vendor mirror nothing may write. Note the norms are one GLOBAL
    // setting: an edit here changes the coverage rule for all three lines, not just this
    // role's own. Owner accepted that trade-off explicitly when granting it.
    crm_visits: ["read", "update"],
    // Phoenix CRM — READ ALONE, for ONE report (owner, 2026-10-02: "product managers and marketing see
    // it too — for their own products, company-wide, never per rep and never any honesty figure"):
    // what the field heard about his own products. He holds no seat in the sales organogram, so every
    // other Phoenix CRM read answers him with nothing or a refusal, exactly as it answers the Training
    // Manager's read; `create`, `update` and `approve` are what resolvePhoenixCrmViewer turns into
    // entering visits and deciding them, and he does none of those (src/lib/phoenix-crm/server/access.ts
    // `readsFieldHeardByProduct`, pinned by tests/phoenix-crm-insight-reports.test.ts).
    phoenix_crm: ["read"],
    early_birds: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "update"],
    coaching: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    organogram: ["read"],
    vacancies: ["read"],
    probation: ["read"],
    sales: ["read", "export"],
    weekly_sales: ["read", "export"],
    weekly_plans: ["read", "create", "update"],
    hiring_interviews: ["read", "update"],
    // Visual Aids (owner, 2026-09-18): one of the three uploaders. Uploads a flyer against a line,
    // retires it, replaces it with a newer version. No `delete` — a flyer is never destroyed.
    visual_aids: ["read", "create", "update"],
    report_it: ["read", "create"],
  },
  Manager: {
    attendance: ["read", "create", "update", "delete", "export"],
    crm_visits: ["read"],
    overview: [],
    employee_profile: ["read", "update"],
    expenses: ["read", "export"],
    double_visit_analytics: ["read", "export"],
    outstation: ["read", "create"],
    leave: ["read", "create", "approve", "export"],
    coaching: ["read"],
    // Organogram (owner, 2026-09-02: "show the full organogram to sama mosaad account").
    //
    // The grant is ROLE-keyed because the matrix has no per-user layer — role_permission_overrides
    // keys on role_name and there is no user-scoped equivalent — but the OWNER'S DECISION was one
    // account, not the rung. So the two page gates in src/lib/reports/organogram.ts pin the actual
    // view to named HR_IDs (isFullOrganogramPinnedAccount, reading
    // src/lib/reports/organogram-pinned-accounts.ts): A-3, and since 2026-10-20 AB, the R&D Manager
    // the QPPV reports to (owner). This grant is deliberately the widest of the three conditions
    // rather than the operative one.
    //
    // That leaves the third Manager account (A-14 Regulatory Affairs) holding organogram:read and
    // seeing nothing, which is safe and was measured, not assumed: every organogram route asserts
    // this permission and THEN re-asks the scope question
    // (canAccessCompanyOrganogram || isLineScopedOrganogramRole) before returning a row — see
    // app/api/reports/organogram/{route,contact-numbers,whatsapp/[hrId],employee/[hrId]}. A Manager
    // who is not pinned falls through every one of those to a 403, the portal page redirects them,
    // and resolveEmployeePortalNavVisibility offers no link. This is the ONE entry in this file where
    // "granted on paper, bounced in practice" is the intended state rather than the bug.
    organogram: ["read"],
    payroll: ["read", "export"],
    payslips: ["read", "export"],
    probation: ["read"],
    sales: ["read", "export"],
    team: ["read", "export"],
    weekly_plans: ["read", "approve"],
    hiring_interviews: ["read", "update"],
    report_it: ["read", "create"],
  },
};

// Incentive (self) is derived rather than typed into every role block: the page it guards used to
// ask for `employee_profile:read`, so the same roles hold `incentive:read` now. Written as a loop so
// a role added tomorrow inherits the grant the day it gets its profile, with nothing to remember.
for (const role of phoenixRoles) {
  if (defaultPermissionMatrix[role].employee_profile?.includes("read")) {
    defaultPermissionMatrix[role].incentive = ["read"];
  }
}

export const permissionMatrix: PermissionMap = applyHardPermissionBoundaries(structuredClone(defaultPermissionMatrix));

export const systemAccessContext: AccessContext = {
  hrId: null,
  role: "Super Admin",
  scope: "system",
  source: "system",
};

function tryParseRole(value: string | null | undefined): PhoenixRole | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  // GOVERNANCE: this parses an *explicit app role* string (the stored
  // app_auth_users.role, an admin-assigned role, or a workflow allowedRole) plus
  // a few legacy role codes/aliases. It is NOT a job-title interpreter:
  // descriptive job titles — "HR Manager", "Talent Acquisition", "R&D Manager",
  // "Medical Representative", "District Sales Manager", "Regional Sales Manager" —
  // are deliberately absent so a title can never be silently turned into a
  // (privileged) role here. Provisioning never derives a role from a title (see
  // resolveEmployeeAccessRole, which always returns "Employee"); real roles are
  // assigned explicitly. Job-function classification for non-security business
  // rules (outstation allowance tiers, employee-portal / coaching routing) lives
  // in resolveJobFunctionRole (src/lib/employees/job-function.ts), NOT here.
  const legacy: Record<string, PhoenixRole> = {
    "admin assist": "Employee",
    "admin assistant": "Employee",
    buffet: "Employee",
    "account admin": "Super Admin",
    admin: "Super Admin",
    employee: "Employee",
    nsm: "National Sales Manager",
    "office co-ordinator": "Employee",
    "office coordinator": "Employee",
    qppv: "Employee",
    "regulatory affairs": "Employee",
    "employee medical rep": "Medical Rep",
    "medical rep": "Medical Rep",
    "district manager": "District Manager",
    "regional manager": "Regional Manager",
    "national sales manager": "National Sales Manager",
    "product manager": "Product Manager",
    "group product manager": "Group Product Manager",
    "sfe manager": "SFE Manager",
    "training manager": "Training Manager",
    "marketing manager": "Marketing Manager",
    "finance manager": "Finance Manager",
    // Both retired HR seats fail CLOSED, and that is the point rather than an oversight.
    // "HR Specialist" was retired 2026-06 and demoted here; "Talent Acquisition" is retired
    // 2026-08-28 and gets identical treatment. Aliasing a retired seat to its SUCCESSOR looks
    // like continuity and is really a privilege carry-forward: verified in production
    // 2026-08-28, the only row still carrying "Talent Acquisition" is A-16, is_active=false,
    // employment_status=resigned. Pointing that string at HR Advisory would hand a departed
    // employee's stored role — or a token minted before the migration — the full recruiting
    // grant. The two new hires are provisioned with their role written explicitly, so nobody
    // who should have access ever reaches this table.
    "hr specialist": "Employee",
    "talent acquisition": "Employee",
    manager: "Manager",
    ceo: "CEO",
    "super admin": "Super Admin",
  };
  if (legacy[normalized]) return legacy[normalized];

  const normalizedNoPunctuation = normalized.replace(/[^a-z0-9 ]/g, "");
  const legacyNoPunctuation: Record<string, PhoenixRole> = {
    accountadmin: "Super Admin",
    adminassist: "Employee",
    adminassistant: "Employee",
    buffet: "Employee",
    nsm: "National Sales Manager",
    "office coordinator": "Employee",
    qppv: "Employee",
    regulatoryaffairs: "Employee",
    employee: "Employee",
    medicalrep: "Medical Rep",
    districtmanager: "District Manager",
    regionalmanager: "Regional Manager",
    nationalsalesmanager: "National Sales Manager",
    productmanager: "Product Manager",
    groupproductmanager: "Group Product Manager",
    sfemanager: "SFE Manager",
    trainingmanager: "Training Manager",
    marketingmanager: "Marketing Manager",
    financemanager: "Finance Manager",
    hrspecialist: "Employee",
    talentacquisition: "Employee",
    ceo: "CEO",
    superadmin: "Super Admin",
  };
  if (legacyNoPunctuation[normalizedNoPunctuation]) return legacyNoPunctuation[normalizedNoPunctuation];

  const matched = phoenixRoles.find((role) => role.toLowerCase() === normalized);
  return matched ?? null;
}

export function normalizeRole(value: string | null | undefined): PhoenixRole {
  return tryParseRole(value) ?? "Employee";
}

export function parseRoleStrict(value: string | null | undefined): PhoenixRole {
  const parsed = tryParseRole(value);
  if (!parsed) {
    throw new Error(`Invalid role "${String(value ?? "").trim()}".`);
  }
  return parsed;
}

export function isNationalSalesManager(value: string | null | undefined): boolean {
  return normalizeRole(value) === "National Sales Manager";
}

export function isMedicalRep(value: string | null | undefined): boolean {
  return normalizeRole(value) === "Medical Rep";
}

export function getRolePrivilegeRank(role: PhoenixRole) {
  switch (role) {
    case "Super Admin":
      return 400;
    case "CEO":
      return 300;
    case "HR Operations":
    case "HR Resourcing":
    case "HR Administration":
      return 150;
    case "Finance Manager":
      return 200;
    default:
      return 100;
  }
}

export function normalizeHrId(value: string | null | undefined) {
  return canonicalHrIdKey(value);
}

// Client-safe (no server deps) — defined in hr-id.ts and re-exported here so
// existing server-side importers of this module keep working unchanged.
export { hrIdsMatch, normalizeHrIdForAccess };

export function resolveEmployeeIdentityId(context: Partial<Pick<AccessContext, "hrId" | "loginId">> | null | undefined) {
  if (!context) return null;
  return normalizeHrId(context.hrId) ?? normalizeHrId(context.loginId);
}

/**
 * Which of the two SHELLS a viewer belongs to — admin or employee portal.
 *
 * This deliberately never returns `"hr"`, even for an HR-namespace role. The mode a shell renders
 * in is a property of the ADDRESS, not of the person: `/hr/probation` renders HR navigation and
 * `/probation` renders admin navigation, and the middleware header is what tells them apart (see
 * `app/(admin)/layout.tsx`). Every existing caller here — the approvals badge-count audience, the
 * hub pages' portal bounce, the dual-mode pages — is asking "portal or not", and returning a third
 * value would silently change each of those answers. `usesHrNamespace` is the question about the
 * person; this is the question about the shell.
 */
export function resolveNavigationMode(context: AccessContext): NavigationMode {
  if (context.source === "guest" || context.scope === "none") {
    return "employee-portal";
  }
  // The CEO is an executive Admin account: it uses the existing admin shell and
  // navigation (landing on /admin/sales-command), never the employee portal.
  if (context.role === "CEO") {
    return "admin";
  }
  return isPortalShellRole(context.role) ? "employee-portal" : "admin";
}

export function canManageCoachingReports(context: Pick<AccessContext, "role" | "scope">) {
  // Marketing Manager is intentionally excluded: the permission matrix grants it coaching:["read"]
  // only (oversight analytics), with no create/update. It previously appeared here, over-granting
  // coaching-lifecycle WRITE authority that bypassed the matrix. Read/oversight stays broad via
  // coachingOversightRoles in src/lib/coaching/service.ts.
  return (
    context.scope === "system" ||
    context.role === "Super Admin" ||
    context.role === "Training Manager" ||
    context.role === "Product Manager" ||
    context.role === "Group Product Manager"
  );
}

export function scopeForRole(role: PhoenixRole): AccessScope {
  if (
    role === "Super Admin" ||
    role === "CEO" ||
    role === "Finance Manager" ||
    // Owner ruling 2026-08-29. HR Operations administers attendance, leave and payroll inputs for
    // the whole company — her job description opens "Review attendance records, fingerprint inputs,
    // approved leave, permissions, excuses" and "Maintain leave balances", neither of which means
    // anything about one person. She resolved to "self" until now, which is the scope of somebody
    // who may see only their own row, and it silently contradicted grants she already held:
    // attendance/leave/employees/payroll/payslips read+export were all composed onto this seat when
    // it was built, and a self scope makes several of them unusable while leaving them looking
    // granted.
    //
    // This widens LESS than it appears. canAccess short-circuits on scope === "system" and on
    // nothing else, so no permission-matrix boundary moves here — every refusal asserted by
    // tests/hr-function-governance.test.ts still comes from the matrix. Reading this file for
    // `scope === "company"` finds exactly two consumers: canViewEmployeeActivity (still gated in
    // front by user_activity:read, which this seat does not hold) and the command centre's company
    // payroll summary. The org-wide REPORTS stay behind their own named role sets above, which is
    // the convention here precisely so a scope change cannot drag them along by accident.
    role === "HR Operations"
  ) {
    return "company";
  }
  if (role === "District Manager" || role === "Manager") return "team";
  if (role === "Regional Manager") return "hierarchy";
  if (
    role === "National Sales Manager" ||
    role === "Product Manager" ||
    role === "Group Product Manager" ||
    role === "Marketing Manager"
  ) {
    return "line";
  }
  return "self";
}

export function createAccessContext(input: {
  hrId?: string | null;
  loginId?: string | null;
  role?: string | null;
  source?: AccessContext["source"];
  testPersona?: TestPersonaLink | null;
}): AccessContext {
  const role = normalizeRole(input.role);
  const hrId = normalizeHrId(input.hrId);
  const source = input.source ?? "session";

  return {
    hrId,
    loginId: input.loginId ?? null,
    role,
    scope: source === "guest" ? "none" : scopeForRole(role),
    source,
    // Only present on a test account's session, so every other context keeps its exact shape.
    ...(input.testPersona ? { testPersona: input.testPersona } : {}),
  };
}

type PermissionMatrix = typeof defaultPermissionMatrix;

type PermissionCacheState = {
  fetchedAt: number;
  matrix: PermissionMatrix;
};

const permissionCacheSeconds = Number(process.env.PHOENIX_PERMISSION_MATRIX_CACHE_SECONDS ?? 30);
const permissionCacheMs = Math.max(5000, Number.isFinite(permissionCacheSeconds) ? permissionCacheSeconds * 1000 : 30000);
let permissionCache: PermissionCacheState | null = null;
let permissionMatrixPromise: Promise<PermissionMatrix> | null = null;

function clonePermissionMatrix(matrix: PermissionMatrix): PermissionMatrix {
  return JSON.parse(JSON.stringify(matrix)) as PermissionMatrix;
}

function normalizePermissionResource(value: string | null | undefined): PermissionResource | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "admin") {
    return "admin_access";
  }
  const found = permissionResources.find((resource) => resource.toLowerCase() === normalized);
  return found ?? null;
}

function normalizePermissionAction(value: string | null | undefined): PermissionAction | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  const found = permissionActions.find((action) => action === normalized);
  return found ? (normalized as PermissionAction) : null;
}

export function parsePermissionResourceStrict(value: string | null | undefined): PermissionResource {
  const resource = normalizePermissionResource(value);
  if (!resource) {
    throw new Error(`Invalid permission resource "${String(value ?? "").trim()}".`);
  }
  return resource;
}

export function parsePermissionActionStrict(value: string | null | undefined): PermissionAction {
  const action = normalizePermissionAction(value);
  if (!action) {
    throw new Error(`Invalid permission action "${String(value ?? "").trim()}".`);
  }
  return action;
}

function toPermissionMatrix(overrides: PermissionDbOverrideRow[]): PermissionMatrix {
  const merged = clonePermissionMatrix(defaultPermissionMatrix);

  overrides.forEach((override) => {
    const role = normalizeRole(override.role_name);
    const resource = normalizePermissionResource(override.resource);
    const action = normalizePermissionAction(override.action);
    if (!resource || !action || typeof override.is_allowed !== "boolean") return;

    const current = merged[role][resource] ?? [];
    const withoutAction = current.filter((item) => item !== action);

    merged[role][resource] = override.is_allowed ? [...withoutAction, action] : withoutAction;
  });

  // Re-apply portal minimum permissions after overrides so that a deny-override
  // in the DB can never strip a floor permission required for portal functionality.
  // Only roles that already carry the floor permission in defaultPermissionMatrix
  // are protected here — this must never GRANT a resource to a role that was
  // deliberately never given it (e.g. Financial Advisor has no payroll access).
  for (const min of portalMinimumPermissions) {
    for (const role of min.roles) {
      if (!defaultPermissionMatrix[role][min.resource]?.includes(min.action)) continue;
      const current = merged[role][min.resource] ?? [];
      if (!current.includes(min.action)) {
        merged[role][min.resource] = [...current, min.action];
      }
    }
  }

  return applyHardPermissionBoundaries(merged);
}

async function getPermissionMatrixFromDb(): Promise<PermissionMatrix> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("role_permission_overrides")
    .select("role_name,resource,action,is_allowed");

  // Never swallow a load failure into the default matrix. A silent revert to
  // defaults can re-grant access an admin explicitly revoked (or drop a grant)
  // with no trace. Surface it and let resolvePermissionMatrix fall back to the
  // last-known-good matrix instead of quietly changing the live policy.
  if (error || !data) {
    throw new Error(
      `Failed to load role_permission_overrides: ${error?.message ?? "no rows returned"}`,
    );
  }

  return toPermissionMatrix(data as PermissionDbOverrideRow[]);
}

async function resolvePermissionMatrix(): Promise<PermissionMatrix> {
  if (permissionCache && permissionCache.fetchedAt + permissionCacheMs > Date.now()) {
    return permissionCache.matrix;
  }

  if (!permissionMatrixPromise) {
    permissionMatrixPromise = getPermissionMatrixFromDb()
      .then((matrix) => {
        permissionCache = { fetchedAt: Date.now(), matrix };
        return matrix;
      })
      .catch((error) => {
        // Fail observable, not silent. Retain the last-known-good matrix so a
        // transient DB error can't quietly widen access; only a cold start with
        // no prior matrix falls back to the built-in defaults. We intentionally
        // do not cache this degraded result, so the next call retries the DB.
        logError("role_permission_overrides load failed; retaining last-known matrix", { labels: { event: "permission_matrix_load_failed" }, error });
        return permissionCache?.matrix ?? applyHardPermissionBoundaries(clonePermissionMatrix(defaultPermissionMatrix));
      })
      .finally(() => {
        permissionMatrixPromise = null;
      });
  }

  return permissionMatrixPromise;
}

/**
 * The effective matrix read straight from `role_permission_overrides`: no cache, and NO last-known-good
 * fallback. Any load failure throws. Only the owner-only MCP source's live authorization uses this;
 * the web app keeps `getPermissionMatrix`, whose fallback is deliberate for a page render.
 */
export async function loadPermissionMatrixUncached(): Promise<PermissionMatrix> {
  return getPermissionMatrixFromDb();
}

export function clearPermissionMatrixCache() {
  permissionCache = null;
}

export async function getPermissionMatrix(): Promise<PermissionMatrix> {
  return resolvePermissionMatrix();
}

export async function canAccess(
  context: AccessContext,
  resource: PermissionResource,
  action: PermissionAction = "read",
) {
  if (context.scope === "system") return true;
  if (context.source === "guest" || context.scope === "none") return false;
  const matrix = await resolvePermissionMatrix();
  const granted = matrix[context.role][resource]?.includes(action) ?? false;
  if (!granted) return false;

  // A temporary per-account lock SUSPENDS a module the role still grants. Checked here, after the
  // matrix, so it costs nothing on a resource the viewer never had — and so every `assertPermission`
  // in the app enforces it without a single route handler being edited. See ./module-locks.ts; it
  // fails OPEN, so a broken lock table can never take the application away from everyone.
  return !(await isModuleLockedForAccess(context, resource));
}

export function getSalesScope(context: Pick<AccessContext, "role"> & { salesScopeOverride?: BusinessScope | null }): BusinessScope {
  if (context.salesScopeOverride) return context.salesScopeOverride;
  switch (context.role) {
    case "Medical Rep":
    case "Employee":
      return "SELF";
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Marketing Manager":
      return "LINE";
    case "SFE Manager":
    case "CEO":
    case "Super Admin":
    // Finance Manager added 2026-08-10 (owner) as the second half of the restored `sales` grant
    // above — see the long note on that key. This arm is not optional garnish: the grant WITHOUT it
    // is precisely the bug that got the grant removed earlier the same day, because a role that
    // falls to the NONE default below gets fail-closed EMPTY line/region/area sets, and every
    // consumer reads an empty set as "no rows" rather than "no access". The page then renders a
    // confident empty table.
    //
    // It must be COMPANY rather than LINE: his employees.line_name is "Office" → "Head Office",
    // which every line filter drops, so any bounded scope resolves his available-line list to empty.
    //
    // Deliberately the switch arm and NOT app_auth_users.sales_scope_override: AccessContext carries
    // no salesScopeOverride field, so every caller passing a bare context takes this switch and
    // would never see a DB value; and the Access Control Manager renders the role's scope from
    // getSalesScope({ role }) with no override, so a DB-only grant would display as NONE while the
    // holder actually had COMPANY. This is role policy, not per-person data.
    case "Finance Manager":
      // Company-wide commercial oversight. Restricted products stay hidden unless the role
      // is explicitly allowed by canViewRestrictedProducts.
      return "COMPANY";
    default:
      return "NONE";
  }
}

export function getPayrollScope(context: Pick<AccessContext, "role">): BusinessScope {
  if (
    context.role === "CEO" ||
    context.role === "Finance Manager" ||
    context.role === "Super Admin" ||
    // Owner ruling 2026-08-29, the payroll half of the same decision as scopeForRole above.
    //
    // This seat was ALREADY granted payroll:[read, export] and payslips:[read, export] in the
    // matrix when it was composed — its job description owns "Payroll HR Inputs & Monthly Closure"
    // and preparing clean attendance outputs "before payroll closure". But this function is
    // consulted BEFORE those grants: /payroll and /admin/payslips-center both redirect on
    // getPayrollScope(access) !== "COMPANY" and never reach the permission check. So the seat held
    // four payroll grants that no page would honour — granted on paper, bounced in practice, which
    // is the exact failure mode this repo has shipped three times.
    //
    // Read+export only. Every payroll WRITE — publishing a batch, deciding a deduction, moving an
    // amount — is a separate matrix action this seat does not hold, and Payroll Copilot and
    // Insurance Wages stay Super-Admin-gated at their own pages.
    context.role === "HR Operations"
  ) {
    return "COMPANY";
  }

  return "SELF";
}

export function getExpensesScope(
  context: Pick<AccessContext, "role"> & { expensesScopeOverride?: BusinessScope | null },
) {
  if (context.expensesScopeOverride) return context.expensesScopeOverride;

  switch (context.role) {
    case "District Manager":
    case "Manager":
      return "TEAM";
    case "Regional Manager":
      return "HIERARCHY";
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
    case "Training Manager":
    case "Marketing Manager":
      return "LINE";
    case "SFE Manager":
    case "CEO":
    // Finance Manager removed 2026-08-10 (owner: "exclude him 100% from outstation or expenses").
    // He falls to SELF, and as head-office staff he files no outstation claims, so his expense
    // visibility is empty rather than company-wide. This is the scope half of the removal: the
    // `outstation` key is gone from his matrix, but resolveExpenseAccessFilter in
    // src/lib/outstation/expenses.ts reads getExpensesScope off the residual `expenses:read` he
    // keeps for the marketing routes — leaving him COMPANY here would have handed back exactly the
    // company-wide expense read the key removal was meant to close.
    case "Super Admin":
      return "COMPANY";
    default:
      return "SELF";
  }
}

export function canAccessPayroll(
  context: AccessContext,
  target: { employeeHrId?: string | null; hrId?: string | null; managerHrId?: string | null },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || getPayrollScope(context) === "COMPANY") return true;
  return hrIdsMatch(context.hrId, target.employeeHrId ?? target.hrId);
}

export function canAccessSales(
  context: AccessContext,
  record: { employeeHrId?: string | null; hrId?: string | null; managerHrId?: string | null; line?: string | null },
  viewer?: { line?: string | null },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  const scope = context.scope === "system" ? "COMPANY" : getSalesScope(context);
  if (scope === "COMPANY") return true;
  if (scope === "NONE") return false;
  if (!context.hrId) return false;
  if (scope === "SELF") return hrIdsMatch(context.hrId, record.employeeHrId ?? record.hrId);
  if (scope === "TEAM") return hrIdsMatch(context.hrId, record.managerHrId);
  if (scope === "LINE") return normalizeLineName(record.line) === normalizeLineName(viewer?.line);
  return false;
}

export function normalizeLineName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export async function canReadEmployeeDirectory(context: AccessContext) {
  return (
    (await canAccess(context, "employees", "read")) ||
    (await canAccess(context, "team", "read")) ||
    (await canAccess(context, "employee_profile", "read"))
  );
}

export function isDirectReport(
  managerHrId: string | null,
  employee: Pick<EmployeeDirectoryRow, "managerHrId"> & { pendingManagerReplacementForHrId?: string | null },
) {
  return (
    hrIdsMatch(managerHrId, employee.managerHrId) ||
    // Seat continuity: a report whose manager seat is mid-replacement carries the marker; the
    // stand-in must keep seeing them (mirrors reportsToManagerSeat in the hierarchy resolver).
    hrIdsMatch(managerHrId, employee.pendingManagerReplacementForHrId ?? null)
  );
}

function canSeeDirectReportsByRole(role: PhoenixRole) {
  return (
    role === "District Manager" ||
    role === "Manager" ||
    role === "Regional Manager" ||
    role === "National Sales Manager"
  );
}

export function canSeeEmployee(
  context: AccessContext,
  employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId"> & { pendingManagerReplacementForHrId?: string | null },
  options?: { byCanonicalHrId?: Map<string, SeatContinuitySubject> },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || context.role === "Super Admin") return true;

  // Training Manager has org-wide training oversight: they coach and assess employees across
  // every line, so the employee directory (and any canSeeEmployee-gated training surface) shows
  // the whole company. Sensitive financial domains stay self-scoped because getPayrollScope /
  // getExpensesScope key off role, not this helper, so org-wide oversight never exposes salaries.
  if (context.role === "Training Manager") return true;

  // HR Operations has company-wide people oversight to maintain the records (people_records). Same
  // carve-out shape as Training Manager above, for the same reason: sensitive financial domains stay
  // self-scoped because they key off role, not this helper. HR Advisory had it too, for workforce
  // insight, until the seat was retired on 2026-10-08.
  if (context.role === "HR Operations") return true;
  // The HR Operations Specialist keeps the whole Employee Master and reviews everyone's attendance —
  // the same company-wide people view, by name, with salary withheld wherever it would show.
  if (context.role === "HR Administration") return true;

  const currentHrId = normalizeHrId(context.hrId);
  const employeeHrId = normalizeHrId(employee.hrId);

  if (!currentHrId || !employeeHrId) return false;

  if (hrIdsMatch(currentHrId, employeeHrId)) {
    return true;
  }

  // Regional Manager / NSM manage through intermediate managers, so a single manager hop showed
  // them almost nobody. When the caller can supply the full directory index (list surfaces do),
  // they see their whole reporting subtree via the canonical walker. Single-row callers without
  // an index keep the conservative direct-report behaviour; Medical Rep / Employee are unaffected
  // either way (canSeeDirectReportsByRole stays false for them).
  if (
    options?.byCanonicalHrId &&
    (context.role === "Regional Manager" || context.role === "National Sales Manager")
  ) {
    return isWithinManagerHierarchy({
      employee: {
        managerHrId: employee.managerHrId,
        pendingManagerReplacementForHrId: employee.pendingManagerReplacementForHrId ?? null,
      },
      byCanonicalHrId: options.byCanonicalHrId,
      viewerCanonicalHrId: canonicalHrIdKey(currentHrId) || "",
      canonicalize: (value) => canonicalHrIdKey(value) || null,
    });
  }

  return canSeeDirectReportsByRole(context.role) && isDirectReport(currentHrId, employee);
}

export function canSeeHrScopedRecord(
  context: AccessContext,
  record: {
    employeeHrId?: string | null;
    hrId?: string | null;
    managerHrId?: string | null;
  },
) {
  if (context.source === "guest" || context.scope === "none") return false;
  if (context.scope === "system" || context.role === "Super Admin") return true;

  const currentHrId = normalizeHrId(context.hrId);
  const employeeHrId = normalizeHrId(record.employeeHrId ?? record.hrId);
  const managerHrId = normalizeHrId(record.managerHrId);

  if (!currentHrId) return false;
  if (context.role === "District Manager" || context.role === "Manager") {
    return hrIdsMatch(currentHrId, employeeHrId) || hrIdsMatch(currentHrId, managerHrId);
  }

  return hrIdsMatch(currentHrId, employeeHrId);
}

export function filterEmployeesForAccess<T extends Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">>(
  rows: T[],
  context: AccessContext,
) {
  // Build the manager index once so RM/NSM resolve their whole subtree, not one hop.
  const byCanonicalHrId = new Map<string, SeatContinuitySubject>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (!key) continue;
    byCanonicalHrId.set(key, {
      managerHrId: row.managerHrId,
      pendingManagerReplacementForHrId:
        (row as { pendingManagerReplacementForHrId?: string | null }).pendingManagerReplacementForHrId ?? null,
    });
  }
  return rows.filter((row) => canSeeEmployee(context, row, { byCanonicalHrId }));
}

// Owner-requested (2026-07-25): an HR seat browses the whole employee directory (see
// hardBoundaryAllowedActions above), but must not see the real salary figures for this specific
// set of senior employees — her own manager chain (B-10 HR Manager, AA CEO) plus a handful of
// other named seniors. Row visibility is unaffected; only the compensation fields below are
// blanked.
//
// HR OPERATIONS WAS REMOVED FROM THIS RULE ON 2026-09-06, at the owner's explicit instruction:
// "yasmeen is the one responsible for completing and adding all employees records". He was asked
// directly whether that includes his own pay and the CEO's, and answered that it does. This is now
// HR ADVISORY'S rule alone — hence the name.
//
// Why it had to change rather than stay as a read-only nicety. The same filter that blanks these
// figures on screen also runs over the employee master EXPORT
// (app/api/employees/template/route.ts), so the sheet HR Operations downloaded came out with these
// seven people's salary cells EMPTY. The importer skips a blank cell, so her upload could never
// move them — she confirmed an import, it reported success, and those rows never changed. From a
// Super Admin account the identical file worked, because nothing was blanked on the way out. A
// redaction that silently edits the round trip is not a redaction, it is a data-entry trap.
//
// See the isSalaryRedactedForViewer check in app/api/employees/route.ts's POST
// handler for the matching write-side guard — without it, a blanked read
// becomes a real, destructive write the moment this viewer edits an unrelated
// field and saves. That guard now protects HR Advisory only, which is sound because HR Advisory
// holds employees:["read","export"] and cannot reach the import at all — so no role that can
// import has anything redacted from it.
const HR_ADVISORY_SALARY_REDACTED_HR_IDS = new Set(
  ["B-10", "AA", "A-12", "AB", "OF-0002", "B-185", "A-9"].map((id) => normalizeHrId(id)),
);

/**
 * THE PAY THE HR BUSINESS PARTNER MAY SEE — one list, two screens.
 *
 * The owner set this boundary on 2026-09-01, about the Payslips Center: "you will make her able to
 * see the district managers, the Medicare reps, and herself only in the payslips." The Employee
 * Directory opened to her in the same breath, and it carries base/basic/gross/net salary columns —
 * so the same sentence has to govern both, or the restriction he asked for is undone by the screen
 * next to it.
 *
 * Spelled as `salary_records.job_title` and `employees.jobTitle` actually hold them, and compared
 * case-INSENSITIVELY: both columns are free text and already carry casing drift ("Sfe Manager"
 * beside "SFE Manager"). Exact-after-lowercasing, never a prefix — "Regional Sales Manager" must
 * never be admitted by "District Sales Manager".
 *
 * This is HER boundary. It does not touch HR Operations, who runs payroll inputs company-wide.
 */
export const HR_ADVISORY_COMPENSATION_JOB_TITLES = [
  "District Sales Manager",
  // "the district managers" in his 2026-09-01 sentence is the SEAT, not the spelling of one man's
  // title. B-94 became a Senior District Manager on 2026-09-29 and still runs Giza (Pedia); leaving
  // this out would have quietly removed him from her payslip list and blanked his pay in her
  // directory — narrowing, by accident, a boundary the owner drew by hand. Exact-after-lowercasing
  // as the note above requires: this admits the senior grade and still never admits "Regional
  // Sales Manager".
  "Senior District Manager",
  "Medical Representative",
  // The senior-grade medical-rep title (B-7, 2026-09-29). Exact-after-lowercasing like the rest of
  // this list — leaving it off would silently drop her from the HR Business Partner's pay view, a
  // boundary the owner drew by hand, purely because of an appreciation label.
  "Senior Medical Representative",
] as const;

function compensationMatchKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * May the HR Business Partner see this person's pay?
 *
 * `viewerHrId` is compared separately from the titles because her OWN title is not on the list,
 * and folding it in would open every other HR Business Partner's pay to her. HR ids are mixed
 * case in this database, so both sides are lowered before they are compared.
 */
export function matchesHrAdvisoryCompensationAudience(
  row: { hrId: string | null | undefined; jobTitle: string | null | undefined },
  viewerHrId: string | null | undefined,
): boolean {
  const titleKey = compensationMatchKey(row.jobTitle);
  if (HR_ADVISORY_COMPENSATION_JOB_TITLES.some((title) => compensationMatchKey(title) === titleKey)) {
    return true;
  }
  const selfKey = compensationMatchKey(viewerHrId);
  return selfKey.length > 0 && compensationMatchKey(row.hrId) === selfKey;
}

/**
 * True when `context` must not see (or write) the real salary figures for `hrId`.
 *
 * HR Advisory only, since 2026-09-06 — see HR_ADVISORY_SALARY_REDACTED_HR_IDS. HR Operations owns
 * the employee master end to end, including the salary columns of the seven seniors this list
 * names, so redacting her both hid figures she is accountable for and silently emptied them out of
 * the export she maintains the records with.
 */
export function isSalaryRedactedForViewer(
  context: Pick<AccessContext, "role">,
  hrId: string | null | undefined,
): boolean {
  if (context.role !== "HR Advisory") return false;
  return HR_ADVISORY_SALARY_REDACTED_HR_IDS.has(normalizeHrId(hrId ?? ""));
}

function redactSalaryFields(row: EmployeeDirectoryRow, context: AccessContext): EmployeeDirectoryRow {
  // Two rules, either of which blanks the money, and BOTH now apply to HR Advisory alone. The
  // named-seniors rule above predates this and covered both HR seats until 2026-09-06, when the
  // owner took HR Operations off it (she owns the employee master, salary columns included); the
  // second is the HR Business Partner's compensation audience, added 2026-09-01 when the Employee
  // Directory was opened to her — see HR_ADVISORY_COMPENSATION_JOB_TITLES. She keeps every other
  // column on every row: this hides pay, never people, so the directory she was given is the whole
  // directory.
  //
  // Nothing here reaches HR Operations any more, so the export she downloads carries every figure
  // she is expected to maintain. That matters more than it reads: this function also runs over the
  // employee master export, and a blanked cell there is indistinguishable from one the user cleared
  // on purpose by the time the importer sees it.
  const outsideHerCompensationAudience =
    context.role === "HR Advisory" &&
    !matchesHrAdvisoryCompensationAudience({ hrId: row.hrId, jobTitle: row.jobTitle }, context.hrId);
  if (!isSalaryRedactedForViewer(context, row.hrId) && !outsideHerCompensationAudience) return row;
  return {
    ...row,
    baseSalary: null,
    basicSalary: null,
    extraCostOfLiving: null,
    fuelAllowance: null,
    grossSalary: null,
    medicalInsurance: null,
    netSalary: null,
    salaryDetails: null,
    socialInsurance: null,
    socialInsuranceWage: null,
    taxes: null,
  };
}

export function filterEmployeeDirectoryForAccess(
  directory: EmployeeDirectoryData,
  context: AccessContext,
): EmployeeDirectoryData {
  if (context.source === "guest" || context.scope === "none") {
    return {
      ...directory,
      employees: [],
      lookups: {
        ...directory.lookups,
        managers: [],
      },
      summary: {
        activeEmployees: 0,
        employeesWithoutManagers: 0,
        totalEmployees: 0,
        uniqueAreas: 0,
        uniqueLines: 0,
      },
    };
  }
  if (context.scope === "system" || context.role === "Super Admin") return directory;

  const employees = filterEmployeesForAccess(directory.employees, context).map((employee) =>
    redactSalaryFields(employee, context),
  );
  const visibleHrIds = new Set(employees.map((employee) => normalizeHrId(employee.hrId)).filter(Boolean));

  return {
    ...directory,
    employees,
    lookups: {
      ...directory.lookups,
      managers: directory.lookups.managers.filter((manager) => visibleHrIds.has(normalizeHrId(manager.value))),
    },
    summary: {
      activeEmployees: employees.filter((employee) =>
        ["active", "on_leave"].includes(String(employee.employmentStatus ?? "active").toLowerCase()),
      ).length,
      employeesWithoutManagers: employees.filter(isMissingRequiredManager).length,
      totalEmployees: employees.length,
      uniqueAreas: new Set(employees.map((employee) => employee.areaName).filter(Boolean)).size,
      uniqueLines: new Set(employees.map((employee) => employee.lineName).filter(Boolean)).size,
    },
  };
}

export async function assertPermission(
  context: AccessContext,
  resource: PermissionResource,
  action: PermissionAction = "read",
) {
  if (await canAccess(context, resource, action)) return;

  // A locked module says so. The message still starts with "Forbidden:" because ~200 route handlers
  // key their 403 on exactly that prefix (isForbiddenError in ./server.ts) — changing the shape of
  // this error would turn every one of them into a 500. The page shells intercept before this and
  // render the lock notice; this is what an API caller sees.
  if (await isModuleLockedForAccess(context, resource)) {
    throw new Error(`Forbidden: ${resource} is temporarily locked by the system administrator.`);
  }

  throw new Error(`Forbidden: ${context.role} cannot ${action} ${resource}.`);
}

export async function canAccessAttendanceSetup(
  context: AccessContext,
  action: Extract<PermissionAction, "read" | "update"> = "read",
) {
  return canAccess(context, "employees", action);
}

export async function assertAttendanceSetupPermission(
  context: AccessContext,
  action: Extract<PermissionAction, "read" | "update"> = "read",
) {
  if (!(await canAccessAttendanceSetup(context, action))) {
    throw new Error(`Forbidden: ${context.role} cannot ${action} attendance setup.`);
  }
}

/**
 * Fingerprint Attendance Report: a page-scoped exception to the "employees"
 * hard boundary (Super Admin only — see hardBoundaryAllowedActions). CEO is
 * explicitly allowed onto this one report/export even though CEO does not
 * otherwise hold employees:read; every other "employees"-gated surface
 * (employee directory, Attendance Setup, etc.) stays Super Admin-only.
 */
export async function canAccessFingerprintReport(context: AccessContext) {
  if (context.role === "CEO") return true;
  return canAccess(context, "employees", "read");
}

export async function assertFingerprintReportPermission(context: AccessContext) {
  if (!(await canAccessFingerprintReport(context))) {
    throw new Error(`Forbidden: ${context.role} cannot read the fingerprint attendance report.`);
  }
}

/**
 * Weekly normalizer mapping-template workbook: a route-scoped CEO exception, same shape as the
 * fingerprint report above.
 *
 * The workbook embeds the UNSCOPED master catalogue — every product code/name/line, every region,
 * every area — including the confidential Head Office line (LA003/LA004/SS001). That catalogue is
 * why the route moved off `weekly_sales:export` (#2234): export reaches down to Medical Rep, so the
 * whole sales field could pull it. But `weekly_sales:update` is held only by Super Admin and SFE
 * Manager, and that swept up the CEO too — who is one of exactly two roles
 * (see HEAD_OFFICE_LINE_KEYS / canViewHeadOffice in src/lib/sales/weekly/access.ts) already cleared
 * to see the Head Office line the workbook's sensitivity rests on.
 *
 * So the CEO is allowed here explicitly rather than by widening `update`, which would also hand him
 * create/delete/approve/import across every other weekly_sales route. Every sibling normalizer route
 * (preview / save / learn / ai-suggest) stays update-only.
 */
export async function canAccessWeeklyMappingTemplate(context: AccessContext) {
  if (context.role === "CEO") return true;
  return canAccess(context, "weekly_sales", "update");
}

export async function assertWeeklyMappingTemplatePermission(context: AccessContext) {
  if (!(await canAccessWeeklyMappingTemplate(context))) {
    throw new Error(`Forbidden: ${context.role} cannot export the weekly mapping template.`);
  }
}

/**
 * Workflow Control Center (Admin / Governance) access design.
 *
 * Phase 1 is a READ-ONLY workflow map + simulator. Access is restricted to HR
 * governance: Super Admin only. HR Manager is a manager title held by a Super
 * Admin account. Both HR bundles are intentionally excluded, as are CEO,
 * Finance Manager, all Sales roles, Training
 * Manager and Employees.
 *
 * If a future non-Super-Admin HR governance user must be granted access, add
 * their (normalized) HR_ID to WORKFLOW_CONTROL_GOVERNANCE_HR_IDS rather than
 * widening the role set.
 *
 * Editing is globally disabled in Phase 1 via WORKFLOW_CONTROL_EDIT_ENABLED.
 * The edit design is reserved for Phase 2 (versioning / draft / publish /
 * rollback) but stays locked while the flag is false.
 */
export const WORKFLOW_CONTROL_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

/** Extra non-Super-Admin HR governance accounts (normalized HR_IDs). None today. */
export const WORKFLOW_CONTROL_GOVERNANCE_HR_IDS: readonly string[] = [];

/** Phase 1: workflow editing is disabled for everyone. Flipped on in Phase 2. */
export const WORKFLOW_CONTROL_EDIT_ENABLED = false;

export function canAccessWorkflowControlCenter(context: Pick<AccessContext, "role" | "hrId">): boolean {
  if (WORKFLOW_CONTROL_ACCESS_ROLES.includes(context.role)) return true;
  const normalized = normalizeHrIdForAccess(context.hrId);
  return normalized != null && WORKFLOW_CONTROL_GOVERNANCE_HR_IDS.some((id) => normalizeHrIdForAccess(id) === normalized);
}

export function canEditWorkflowControlCenter(context: Pick<AccessContext, "role" | "hrId">): boolean {
  // Phase 2 design: edit follows the same access set — but stays locked until
  // WORKFLOW_CONTROL_EDIT_ENABLED is turned on.
  if (!WORKFLOW_CONTROL_EDIT_ENABLED) return false;
  return canAccessWorkflowControlCenter(context);
}

/**
 * Phase 2A: a SAFE, client-only Draft Editor (display/config fields, local
 * state, no persistence, no runtime/publish). Available to the same governance
 * set as access (Super Admin only). This is distinct from
 * WORKFLOW_CONTROL_EDIT_ENABLED, which gates REAL runtime editing/publish and
 * remains OFF.
 */
export const WORKFLOW_CONTROL_DRAFT_EDITOR_ENABLED = true;

export function canUseWorkflowDraftEditor(context: Pick<AccessContext, "role" | "hrId">): boolean {
  if (!WORKFLOW_CONTROL_DRAFT_EDITOR_ENABLED) return false;
  return canAccessWorkflowControlCenter(context);
}

/**
 * Activity Control Center (Admin oversight) access design.
 *
 * The control center reports how every user navigates the system (module-level
 * usage + dwell time, drawn from app_sessions and activity_events). Because it
 * is an employee-monitoring surface, access is restricted to Super Admin only.
 * The page also enforces `assertPermission(ctx, "user_activity", action)`; this
 * role gate is a fast, explicit redirect guard that mirrors the matrix.
 *
 * To onboard a non-Super-Admin governance account later, prefer adding a
 * `role_permission_overrides` row (resource `user_activity`) over widening this
 * role list.
 */
export const ACTIVITY_CONTROL_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

/**
 * Transparency flag: when true, the employee portal surfaces a short notice that
 * in-app usage is recorded for security/product purposes. Owner chose silent for
 * v1; flip to true to enable the notice with zero further code changes.
 */
export const ACTIVITY_TRACKING_SHOW_EMPLOYEE_NOTICE = false;

export function canAccessActivityControlCenter(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return ACTIVITY_CONTROL_ACCESS_ROLES.includes(context.role);
}
