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
  | "engagement_retention"
  | "performance_probation"
  | "workforce_insight"
  | "people_records"
  | "time_attendance"
  | "payroll_inputs"
  | "hr_governance";

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
      // Vacancies Report and CV Database both gate on vacancies:read) and exports the CV template,
      // and that is every vacancies action anything in this codebase actually asserts for her.
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
      // The portal-only activate/deactivate tool for a new joiner's login. Deliberately NOT
      // user_admin, which also covers role, scope and permission changes and stays Super Admin.
      account_activation: ["read", "update"],
      // Contract & Form 1 and Hiring Documents are cards on the Recruitment & Hiring hub, and both
      // pages gate on employee_documents. hr_governance grants only read+export, so recruiting must
      // carry the write half or the seat that runs the hire can open the contract and not fill it.
      employee_documents: MAINTAIN,
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
      // NOT report_it. "Report It" is PHARMACOVIGILANCE — adverse drug reactions, seriousness
      // (death, hospitalisation, congenital anomaly), suspected medicines, patient outcomes. It is
      // regulatory patient-safety data and has nothing to do with employee concerns, despite a name
      // that reads like a grievance channel. Its `export` action is the read-EVERY-report gate
      // (canViewAllReports, src/lib/report-it/service.ts:8) and is held by three roles only:
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
      // seat held exactly this pair (owner, 2026-07-25) and it belongs to the insight function,
      // so it does NOT reach HR Operations, who has no reason to read a rep's call plan.
      weekly_plans: READ_ONLY,
      employee_profile: READ_ONLY,
      attendance: READ_ONLY,
      overview: READ_ONLY,
    },
  },
  {
    key: "people_records",
    label: "People Records & Lifecycle",
    summary:
      "Personnel files, master data, contracts, onboarding, resignations, clearance and HR letters.",
    jdSections: [
      "ops 1 — Employee Records & Personnel Files",
      "ops 4 — Contracts, Probation & Employee Lifecycle",
      "ops 5 — Onboarding & Joining Administration",
      "ops 6 — Resignation, Clearance & Offboarding",
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
      // `vacancies: create` and NOTHING else. POST /api/employees/[hrId]/resign asserts
      // employees:update + resignations:create + vacancies:create together, because the one RPC it
      // calls — phx_resign_employee_and_open_vacancy — records the departure AND opens the seat the
      // departure just emptied. Without this third grant the seat that OWNS offboarding (ops 6)
      // cannot record a single resignation. It is not `read`: the Vacancies Report and the CV
      // Database gate on vacancies:read (a nav entry with no action resolves to `read`), and those
      // are Advisory's recruiting pages, not this seat's. It is not organizational change either —
      // organogram:update stays denied to both seats, and this path can only ever fire for a person
      // who is actually leaving.
      vacancies: ["create"],
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
      // ops 6 - Resignation, Clearance & Offboarding. Added 2026-08-28 (Phase 6). This is the
      // half of ops 6 that had nowhere to live: `resignations` records that someone left, and
      // until now nothing recorded the clearance behind it.
      //
      // MAINTAIN, not allActions, and it does NOT reach payroll. Recording that a settlement was
      // released is gated on every station being decided - phx_hr_clearance_release refuses
      // otherwise, in the database, not in a page - but it writes no money. "May not approve
      // final settlement" is a named boundary in this same job description and stays enforced by
      // the payroll entries in HR_ROLE_BOUNDARIES.
      clearance: MAINTAIN,
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
] as const;

/**
 * The two HR seats opening 1 September 2026, each as a SET OF FUNCTIONS.
 *
 * The bundle name is a label and carries no meaning on its own — that is deliberate, and it is
 * what stops this from going stale the way "HR Specialist" and "Talent Acquisition" both did. To
 * change what a seat can do, move a function key between these arrays. To add a seat, add a
 * bundle. Neither needs a rename, a codebase sweep, or a migration.
 *
 * Union of the two = all eight functions, which is the owner's "at the end of the day,
 * everything": between them the HR department is fully covered, with two functions
 * (performance_probation, hr_governance) genuinely shared because both job descriptions ask for
 * them from different angles.
 */
export const HR_ROLE_BUNDLES = {
  "HR Advisory": [
    "recruiting",
    "engagement_retention",
    "performance_probation",
    "workforce_insight",
    "hr_governance",
  ],
  "HR Operations": [
    "people_records",
    "time_attendance",
    "payroll_inputs",
    "performance_probation",
    "hr_governance",
  ],
} as const satisfies Record<string, readonly HrFunctionKey[]>;

export type HrBundleName = keyof typeof HR_ROLE_BUNDLES;

/**
 * THE JOB TITLE EACH SEAT IS SHOWN AS — display only, never a key.
 *
 * The bundle names above are deliberately NOT job titles: that is the whole point of this file,
 * and `tests/hr-function-governance.test.ts` fails the build if a bundle name ever collides with
 * an entry in `phoenixCompanyJobTitles`. But a person does not think of herself as "HR Advisory".
 * The owner's instruction (2026-08-30) is that Aya's title is **HR Business Partner** and that it
 * is the title shown everywhere in her account.
 *
 * So the two live side by side, and the split is the resolution of the tension rather than a
 * compromise with it: `"HR Advisory"` stays the permission key that nothing reads for intent and
 * that can never strand when the seat changes hands, while this map is the only thing a human ever
 * sees. Renaming the key to the title is precisely the mistake that cost two codebase-wide renames
 * and an eleven-table migration — do not do it, and do not "simplify" this map away.
 *
 * `COMPANY_ROLE_WORKBOOKS` in `src/lib/hr/job-workbook.ts` holds the same pairing for the whole
 * company. It is not imported here on purpose — that module is ~1,300 lines of workbook prose and
 * this map is read on every authenticated page render. `tests/hr-job-workbook.test.ts` asserts the
 * two agree, so they cannot drift apart.
 */
export const HR_SEAT_JOB_TITLES = {
  "HR Advisory": "HR Business Partner",
  "HR Operations": "HR Operations Coordinator",
} as const satisfies Record<HrBundleName, PhoenixCompanyJobTitle>;

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
  { resource: "clearance", action: "delete", why: "may not destroy the evidence a settlement was released against (ops)" },
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
  attendance: READ_ONLY,
  overview: READ_ONLY,
  report_it: ["read", "create"],
  support_requests: ["create"],
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
