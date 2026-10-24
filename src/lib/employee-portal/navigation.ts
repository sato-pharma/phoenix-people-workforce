import { parseRoleStrict, type PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { DOCTOR_COVERAGE_PORTAL_ROLES } from "@/lib/crm/doctor-coverage-roles";
import { DOCTOR_LIST_PORTAL_ROLES } from "@/lib/crm/doctor-list-roles";
import { canViewMarketingCoverageReport } from "@/lib/marketing-requests/coverage-report-access";
import { isDirectOrderRequesterRole } from "@/lib/direct-orders/types";
import { isNamedProductionPlanningPerson } from "@/lib/production-planning/access";
import { isFullOrganogramPinnedHrId } from "@/lib/reports/organogram-pinned-accounts";
import { VISUAL_AIDS_PORTAL_ROLES } from "@/lib/visual-aids/rules";

export type EmployeePortalNavVisibility = {
  showDashboardTab?: boolean;
  showExcusesTab?: boolean;
  showExpenseActionTab?: boolean;
  showExpenseDashboardTab?: boolean;
  showMyVisitsTab?: boolean;
  showDeductionsTab?: boolean;
  showIncentiveTab?: boolean;
  showMarketingRequestsTab?: boolean;
  // Market Awareness — conferences, round tables and speaker programmes raised by the product
  // managers. The PORTAL BUILDS ITS OWN SIDEBAR: an entry in system-navigation.ts does not put a
  // link here, which is how a shipped, reachable page can be reachable by nobody.
  showMarketAwarenessTab?: boolean;
  /** The Market Awareness approvals queue — its own inbox under Approvals Hub, beside Marketing. */
  showMarketAwarenessInboxTab?: boolean;
  // Visual Aids — the flyers a rep shows a doctor on the tablet (owner, 2026-09-18). The rep, his
  // DM, RM and NSM read their own line; the Marketing Manager and the GPM also upload. The list is
  // VISUAL_AIDS_PORTAL_ROLES in src/lib/visual-aids/rules.ts, pinned against the matrix by a test.
  showVisualAidsTab?: boolean;
  showMarketingInboxTab?: boolean;
  /**
   * Customer Validation — the field-capture screen. Its OWN flag since 2026-09-18: the Medical Rep
   * keeps this one while showMarketingRequestsTab / showMarketingInboxTab go dark for them.
   */
  showMarketingValidationTab?: boolean;
  showMarketingAllRequestsTab?: boolean;
  showMarketingCustomerDatabaseTab?: boolean;
  showMarketingControlTab?: boolean;
  showMarketingRoiTrackingTab?: boolean;
  showMarketingCoverageReportTab?: boolean;
  showMyPerformanceTab?: boolean;
  showTeamPerformanceTab?: boolean;
  showMedRepsPerformanceTab?: boolean;
  showRepsListTab?: boolean;
  /** KPIs — Summary, Call Rate, Coverage and Frequency. Every portal-mode role with a reach. */
  showKpisTab?: boolean;
  showMedicalRepExpensesTab?: boolean;
  // Spotlight (self) — the rep's own recognition sheet (owner, 2026-09-30). MEDICAL REP ONLY, keyed
  // on isMedicalRep like showMedicalRepExpensesTab; the page and the /api/spotlight/me routes gate on
  // spotlight_self, so this flag only draws the door.
  showSpotlightTab?: boolean;
  showDsmsPerformanceTab?: boolean;
  // Team Calendar — NSM-only live field-visit month grid for their whole line, scoped
  // server-side (see src/lib/employee-portal/team-calendar.ts). Reads the iReports360
  // visits mirror; each green numeric day deep-links to that rep's day drill-down.
  showTeamCalendarTab?: boolean;
  // Field Absence Calendar — the National Sales Manager's door to the names on his own line the
  // system did not see at all on a working day (owner, 2026-10-18). The admin-mode holders (Super
  // Admin, CEO, SFE Manager) have their own row in adminNavigationSectionSeeds. The link grants
  // nothing: loadFieldAbsencePage re-checks the grant, the role and his NSM seat's line.
  showFieldAbsenceTab?: boolean;
  showTeamExpensesTab?: boolean;
  showVacanciesTab?: boolean;
  // "My Candidates" (/employee-portals/recruitment-candidates) — candidates assigned to a hiring
  // manager's own open seats, already scoped by canSeeApplication (src/lib/recruitment/access.ts).
  // The page, the `hiring_interviews` grant and a notification deep-link into it
  // (src/lib/recruitment/applications.ts) all shipped, but no sidebar/bottom-nav link ever did — so
  // a manager notified about their candidate had no way back to the page except the command palette.
  showMyCandidatesTab?: boolean;
  // "Manager CV Engagement" (/employee-portals/recruitment-engagement) — the SILENT report of which
  // managers opened / answered / ignored the CVs sent to them. National-Sales-Manager-only in the
  // portal (scoped to his own line server-side); Super Admin and CEO reach the same report through
  // the admin twin. The manager being measured never sees it — see manager-cv-engagement.ts.
  showManagerEngagementTab?: boolean;
  // "Interview Calendar" (/employee-portals/interview-calendar) — the owner's interview calendar,
  // shown only to someone he SHARED it with (a row in ats_interview_calendar_shares). Not a role
  // fact at all, so it arrives as data (hasInterviewCalendarAccess, read by the portal shell), the
  // way hasDeviceMapping does. With no data it is false: nobody is offered a calendar by role.
  showInterviewCalendarTab?: boolean;
  showProbationTab?: boolean;
  showOrganogramTab?: boolean;
  showPlansTab?: boolean;
  // Planning Calendar (read-only, HO-scoped for Talent Acquisition — see
  // isPlanItemVisibleToViewer). Split from showPlansTab (2026-07-25) so the Weekly/
  // Monthly Plan submission link can be removed for a role while keeping this one.
  showPlanningCalendarTab?: boolean;
  showSupportTab?: boolean;
  // Recruitment & Hiring group (Recruitment, CV Database, Hiring Documents) plus HR
  // Support Requests (which lives in the "HR Support" section) — Talent Acquisition's
  // portal mirror of the admin-shell hrAuthorityNavigationRoles tools. See
  // employee-portal-layout.tsx. Vacation Control has a page but is deliberately unlinked
  // (owner-requested removal, 2026-07-24).
  showRecruitmentHiringTab?: boolean;
  // People Management group (Employees, Contract Renewal, Resignations, Vacancies
  // Report) — Talent Acquisition's company-wide HR tooling, separate from the
  // Recruitment & Hiring group above. See employee-portal-layout.tsx.
  showPeopleManagementTab?: boolean;
  // Private Calendar (self-scoped — each employee sees only their own recognized activity; the
  // page has no role gate and every portal role holds the employee_profile:read + attendance:read
  // that getPrivateCalendarWorkspace asserts). Shown to every role as of the 2026-08-01 owner
  // decision, reversing the earlier Talent-Acquisition-only default.
  showPrivateCalendarTab?: boolean;
  // Narrow account activate/deactivate tool — see src/lib/recruitment/account-activation.ts.
  showAccountActivationTab?: boolean;
  showMyCoachingTab?: boolean;
  showTeamCoachingTab?: boolean;
  showTrainingManagerCreateCoachingTab?: boolean;
  showTrainingManagerDashboardTab?: boolean;
  showTrainingManagerFieldCoachingTab?: boolean;
  showReportItTab?: boolean;
  showReportItDashboardTab?: boolean;
  showFingerprintReportTab?: boolean;
  /**
   * Phoenix CRM — customer lists, weekly plans, visits and reports (owner, 2026-09-23: "put it in the
   * sidebar"). NOT a role test: the module's own gate already answers it — the `phoenix_crm`
   * permission, a territory of the viewer's own or beneath him, and his line opened in
   * `phoenix_crm_line_rollout`. That is `phoenixCrmEntryAvailable`, which the My Visits button has
   * always asked; this row asks the same question, so the two doors can never disagree.
   *
   * Until today the button on My Visits was the only door, one click in, and 71 of the 73 territories
   * with a reference list waiting had never opened the module once.
   */
  showPhoenixCrmTab?: boolean;
  /**
   * Daily Forecast — the CNS reps' pre-filled boxes for the day, a Phoenix CRM tab given its own row
   * under Forecast & Target (owner, 2026-10-01: "put it under forecast in sidebar"). NOT a role test,
   * for the same reason as the row above: `phoenixCrmSidebarEntries` answers it with the very function
   * that offers the tab (`forecastIsOffered` — a CNS territory in scope), so a Pedia or Anti Infective
   * rep never sees a row that opens onto "not yours to open".
   */
  showDailyForecastTab?: boolean;
  /**
   * Place checks — a district manager's own team's place validations, where he comments on one and
   * recommends validating it or not (owner, 2026-10-13: "in every district manager account, build a
   * tab in his sidebar that shows the check places only for his team"). NOT a role test, for the same
   * reason as the two rows above: `phoenixCrmSidebarEntries` answers it with `readsTeamPlaceChecks`,
   * the very predicate that gates the page, so the row can never open onto a redirect.
   */
  showTeamPlaceChecksTab?: boolean;
  /**
   * Double visit requests — what the reps ask their managers and product managers for at a customer, and
   * each person's answer (owner, 2026-10-16: "a new sidebar report is generated for managers … all
   * managers must have access on this report as per their scope upto ceo"). NOT a role test, for the same
   * reason as the rows above: `phoenixCrmSidebarEntries` answers it with `doubleVisitReportAudience`, the
   * very predicate that gates the page and its routes, so the row can never open onto a redirect.
   */
  showDoubleVisitRequestsTab?: boolean;
  // Sales Intelligence (Product / Group Product Managers): line- or product-scoped
  // analytics surfaces that mirror the admin dashboards inside the employee portal.
  showRoiIntelligenceTab?: boolean;
  // Source of Sales — distributor sell-in dashboard, scope-aware. Shown to the field sales
  // management roles + product/marketing managers (see /employee-portals/source-of-sales).
  showSourceOfSalesTab?: boolean;
  // Weekly Sales — de-cumulated weekly distributor sell-in, same role set as Source of Sales.
  showWeeklyTab?: boolean;
  // Weekly Stock — stock on hand per product at every depot, with weeks of cover. Scoped exactly like
  // Weekly Sales (resolveWeeklyAccessScope); Medical Rep included (owner, 2026-09-14).
  showWeeklyStockTab?: boolean;
  // Monthly Closing — the portal render of the admin /sales/monthly-closing Closing Matrix +
  // Details, published-gated and scoped to the viewer (see loadPortalMonthlyClosing /
  // canAccessPortalClosing). Shown to the field-sales roles that own a line (DM/RM/NSM/PM/GPM), the
  // Marketing Manager for her oversight lines, and the Medical Rep for their own area(s) only.
  showMonthlyClosingTab?: boolean;
  // Performance Review — the presentation cut of the same closing, scoped to the viewer's own
  // territory and published-gated (owner, 2026-10-13: "show performance review tab in each district
  // manager account … and of course, everyone sees only his scope"). The three TERRITORY tiers only;
  // the enforcing gate this flag must stay level with is PORTAL_PERFORMANCE_REVIEW_ROLES in
  // closing-performance-review-access.ts, and the bound itself is applied server-side.
  showPerformanceReviewTab?: boolean;
  // Sales vs Target (/employee-portals/sales-vs-target) — Source of Sales + Direct Orders measured
  // against target, from July 2026 onwards. The FIRST sales surface a Medical Rep can open (owner
  // decision 2026-08-04, reversing the 2026-07-30 call that kept reps out of portal Targets); a rep
  // is bounded to their own attributed rows by resolveVsTargetBound, which is the enforcing gate
  // this flag must stay in sync with. Marketing Manager is included because their Head-Office line
  // resolves through MARKETING_OVERSIGHT to the three product lines, so the page is not empty.
  showSalesVsTargetTab?: boolean;
  // Make It Happen (/employee-portals/make-it-happen) — the forecast planner: units per
  // concentration, and "Press here and Phoenix will Make It Happen". Owner roles 2026-09-13:
  // Medical Rep, District Manager, NSM, PM, GPM, Marketing Manager (SFE Manager and Super Admin use
  // the admin twin). Mirrors MAKE_IT_HAPPEN_PORTAL_ROLES in src/lib/sales/make-it-happen/scope.ts,
  // which is the enforcing gate. Explicit "District Manager", not isDistrictManager: the Head-Office
  // "Manager" rung has no sales rows to plan.
  showMakeItHappenTab?: boolean;
  // Territory & Sales Drilldown — geography-rooted (Region>Area>Block>Brick>Pharmacy) sales
  // tree at /employee-portals/territory-drilldown. All four sales roles now shipped (see
  // TERRITORY_DRILLDOWN_ROLES in src/lib/sales/territory/service.ts, the server-side gate
  // this flag must stay in sync with).
  showTerritoryDrilldownTab?: boolean;
  // Scoped CRM Master (/employee-portals/crm) — the full CRM grid + export, row-bounded to the
  // caller's own scope. Mirrors PORTAL_CRM_ROLES in src/lib/crm/portal-crm-scope.ts (the enforcing
  // gate); spelled out here because that module pulls in the Supabase server client.
  showCrmMasterTab?: boolean;
  // Territory Management — the brick-allocation / rep-residence map at
  // /employee-portals/territory-management. A DIFFERENT module from Territory & Sales Drilldown
  // above: this one compares multiple areas' bricks against each other, which is why Medical Rep
  // is excluded. Must stay in sync with PORTAL_ROLES in that page (the server-side gate).
  showTerritoryManagementTab?: boolean;
  // Targets — READ-ONLY scoped view at /employee-portals/targets (owner decision 2026-07-30:
  // DM/RM/NSM view; editing and upload stay with SFE Manager / Super Admin on /sales/targets).
  // Medical Rep reaches the same URL since 2026-09-16 (owner) and is served their OWN targets.
  // Must stay in sync with PORTAL_TARGETS_ROLES + PORTAL_REP_TARGETS_ROLES in
  // src/lib/sales/portal-targets.ts, the page gate.
  showTargetsTab?: boolean;
  // Business Review — the portal-scoped view of /business-review, at
  // /employee-portals/business-review. Same field-management role set as Source of Sales;
  // the page itself resolves each viewer's scope from the seat map (portal-scope.ts) and denies
  // anyone not in the access map, so this flag only surfaces the sidebar link.
  showBusinessReviewTab?: boolean;
  showCoachingAnalyticsTab?: boolean;
  showDoubleVisitAnalyticsTab?: boolean;
  showDoubleVisitReportTab?: boolean;
  // Field Activity — one person's field days end to end, at /employee-portals/field-activity.
  //
  // It shipped (#4647) with its ONLY catalog row in employeePortalNavigationSectionSeeds and an
  // /admin/ href, which is the Early Birds trap below repeated: that catalog drives the command
  // palette and Modules Control, never the portal rail, and app/(admin)/layout.tsx bounces every
  // portal-mode viewer out of /admin/** before the page runs. So five of the module's eight roles
  // — DM, RM, NSM, PM, GPM — could neither see it nor reach it by typing the address. The owner
  // found it the same evening: "I CANNOT SEE IT IN NSM SIDEBAR?".
  //
  // The three roles absent here (SFE Manager, Super Admin, CEO) are ADMIN-mode and keep the
  // /admin/field-activity page with its own row in adminNavigationSectionSeeds.
  showFieldActivityTab?: boolean;
  // Early Birds — the fortnightly field-discipline board at /employee-portals/early-birds.
  //
  // The page shipped with NO portal sidebar row at all. Its only catalog entry sits in
  // `employeePortalNavigationSectionSeeds` (system-navigation.ts), which drives the command
  // palette and Modules Control but NOT the portal rail — that rail is built by hand in
  // buildEmployeePortalSections — so for every role below the board was reachable only by typing
  // the URL, or by catching the "View board" link on the landing-page stars card, which renders
  // nothing at all in a fortnight with no stars.
  //
  // The role set mirrors that catalog row exactly, and is deliberately WIDER than the scope
  // resolver: resolveEarlyBirdsScope (src/lib/early-birds/permissions.ts) is the enforcing gate and
  // answers "which districts", so a viewer with an empty subtree gets the page's own named empty
  // state rather than a missing row, which reads as a permission fault.
  showEarlyBirdsTab?: boolean;
  // Phoenix Ranks — the shared board at /employee-portals/ranks (owner, 2026-10-05): every medical
  // rep of every line, scored on eight equal measures. Unlike Early Birds it is FOR the rep, so the
  // Medical Rep keeps the row; the rest of the audience is Early Birds' own, and the page enforces
  // `early_birds:read` server-side.
  showRanksTab?: boolean;
  showActionsTab?: boolean;
  // Direct Orders — submit/report are the same requester-role set the module itself
  // enforces server-side (DIRECT_ORDER_REQUESTER_ROLES); approvals is only the two
  // roles that ever sit as a person-rung in the approval ladder (see
  // directOrderManagementLadder) — the CEO's rung always resolves to the admin shell.
  showDirectOrdersTab?: boolean;
  // Direct Orders in my area — the Medical Rep's view-only window onto direct orders booked in
  // their own territory (owner, 2026-09-24). Distinct from showDirectOrdersTab, which is the
  // requester WORKSPACE the rep does not have.
  showAreaDirectOrdersTab?: boolean;
  // My Milestones — the rep's own service-anniversary and Sato-Pharma birthday keepsake cards, which
  // he may download for himself (owner, 2026-09-30). Medical-Rep only, self-scoped end to end: the
  // page lists only his occasions and the /api/milestones/my-card route builds only his card. This is
  // NOT the Super-Admin Milestones workspace (/milestones), which prints anyone's card company-wide.
  showMilestonesTab?: boolean;
  // Production Planner — the toll-manufacturing buy list for Ivyronc, made by EGPI out of raw
  // materials Sato supplies. 🔴 THIS FLAG IS KEYED TO A NAMED LIST OF PEOPLE, NOT TO A ROLE, and it
  // is the only one here that is. The owner named five: the R&D Manager (its main user), the CEO,
  // himself, the Finance Manager and the R&D Supervisor. Two of them sit in this shell, and their
  // roles cannot be used as the key — `Manager` would also open it to the QPPV, and `Employee` is
  // the whole company. So it reads `isNamedProductionPlanningPerson(viewerHrId)`, and a sixth
  // person admitted later from the module's own Settings tab reaches the module by its URL rather
  // than by this row. That under-reports, which is the right direction for a door: the page itself
  // asks the database (resolveProductionPlanningLevel), so this row is UX only.
  showProductionPlanningTab?: boolean;
  showVacationApprovalsTab?: boolean;
  // Excuse has its own flag (distinct from vacation) so a module can be hidden for one role
  // without touching the other — e.g. National Sales Manager sees Vacation but not Excuse.
  showExcuseApprovalsTab?: boolean;
  showPlanApprovalsTab?: boolean;
  showAttendanceTab?: boolean;
};

function resolvePortalRole(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
): PhoenixRole {
  // The APP ACCESS role is authoritative — it is what every server-side permission check uses —
  // so the portal nav follows it, not the job title. It is tried FIRST and wins whenever it
  // resolves to a definite (non-"Employee") role. This is what lets a Medical Rep acting as a
  // District Manager (app role elevated, HR job title deliberately left "Medical Representative")
  // get the District Manager nav their access actually grants; previously the title took precedence
  // and pinned them to the Medical Rep sidebar.
  //
  // The job title is the FALLBACK, kept for the historical case this function was written for: an
  // account whose app role is still the default "Employee" (never upgraded) but whose real role
  // lives in its title. In that case accessRole yields nothing here and the title-based
  // classification supplies the role, exactly as before. UX only — every portal page keeps its own
  // server-side access guard.
  for (const candidate of [accessRole, roleLabel]) {
    if (!candidate) continue;
    try {
      const strict = parseRoleStrict(candidate);
      if (strict !== "Employee") return strict;
    } catch {}
    const jobFunctionRole = resolveJobFunctionRole(candidate);
    if (jobFunctionRole !== "Employee") return jobFunctionRole;
  }

  return "Employee";
}

/**
 * Launch posture flag for Beta employee-portal modules.
 *
 * Marketing Requests and Contact HR Support have both graduated from Beta to full
 * modules and are no longer gated by this flag. Contact HR Support is available to
 * every employee-portal user (everyone can reach their HR team); Marketing Requests
 * stays role-gated. No employee-portal module is currently gated behind this flag,
 * but it is retained for any future Beta launch.
 *
 * Set PHOENIX_PORTAL_SHOW_BETA_NAV=true (server env) to surface future Beta modules
 * in the nav for roles that are already authorized for them. Read at call time so the
 * launch posture can change without a rebuild and so tests can toggle it.
 */
export function isEmployeePortalBetaNavEnabled(): boolean {
  return String(process.env.PHOENIX_PORTAL_SHOW_BETA_NAV ?? "").trim().toLowerCase() === "true";
}

const marketingRequestRoles = new Set<PhoenixRole>([
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
]);

/**
 * Who may RAISE a marketing request, and therefore who is offered the drafts workspace
 * (/employee-portals/marketing-requests) and the Approval Inbox (.../inbox).
 *
 * THE MEDICAL REP IS DELIBERATELY ABSENT (owner, 2026-09-18: "from medical rep accounts hide
 * /employee-portals/marketing-requests/inbox & /employee-portals/marketing-requests but leave
 * /employee-portals/marketing-requests/validation"). A rep's job in this module is now the FIELD
 * CAPTURE — stand at the venue, take the GPS fix and the live photo, validate the customer — and
 * the spend request against that customer is raised by their District Manager. The rep keeps
 * Customer Validation (marketingRequestRoles, above) and the ROI Tracker, so they can still do the
 * capture and still watch what the money their manager spent on their area returned.
 *
 * This is the UX half only. The boundary is server-side: assertMarketingRequestCreationAccess and
 * assertMarketingDraftWorkspaceAccess in src/lib/marketing-requests/service.ts, which this list
 * must stay in lockstep with.
 */
const marketingRequestCreatorRoles = new Set<PhoenixRole>(
  Array.from(marketingRequestRoles).filter((role) => role !== "Medical Rep"),
);

const hideMyPerformanceTabRoles = new Set<PhoenixRole>([
  "Training Manager",
]);

/**
 * Who gets Report It as the PHARMACOVIGILANCE section (the dashboard over every report) rather than
 * as the plain "Report It" row under Leave & HR (submit one, read your own).
 *
 * Every portal role reaches the page either way — see showReportItTab — so this only decides which
 * of the two rows a viewer is given, and the layout draws at most one of them.
 */
function showReportItDashboardRoles(role: PhoenixRole): boolean {
  return (
    role === "Product Manager" ||
    role === "Group Product Manager" ||
    role === "Marketing Manager" ||
    role === "Training Manager"
  );
}

/**
 * Who sees Market Awareness in the portal sidebar. The creators plus the roles that are INFORMED
 * when an activity is approved — being told about one is useless without a way to open it.
 *
 * THE DISTRICT MANAGER IS DELIBERATELY ABSENT (owner, 2026-09-12: "hide from them, only applicable
 * for product or group product managers and marketing and national sales manager"). That reverses
 * owner answers 42 and 43, which had made every DM in the region an informed reader. The hide is
 * total rather than cosmetic: the matrix grant, the see-all scope and the approval announcement all
 * dropped him in the same change, because a sidebar link removed while the notification still fires
 * only moves the door — it does not close it.
 *
 * This is UX only. Every route calls assertPermission(market_awareness) and then narrows by
 * identity, because the matrix has no per-row layer and a Product Manager sees only his own.
 */
/**
 * Who can hold a Market Awareness decision, and therefore who is offered the Awareness Approvals
 * inbox in the portal sidebar. This list is what DRAWS the link — the portal builds its own nav from
 * these flags, so a seat missing here has no door to the queue however complete its permissions are.
 *
 * The parallel group (2026-09-09) put every activity in front of the Marketing Manager AND the
 * National Sales Manager of each line it targets, so the NSM belongs here. He shipped without it and
 * was routed decisions he had nowhere to answer. The Group Product Manager stays for the retired
 * single-manager step, which historical rows can still sit on, and the CEO is the final step.
 * Super Admin is included because he can act on any step.
 *
 * UX only, like every list in this file. The page itself gates on market_awareness:read and the
 * queue is scoped server-side to the decisions that are actually the caller's, so a seat on this
 * list holding no decision sees an empty inbox rather than a refusal.
 */
export const MARKET_AWARENESS_DECIDER_ROLES: readonly PhoenixRole[] = [
  "Group Product Manager",
  "Marketing Manager",
  "National Sales Manager",
  "CEO",
  "Super Admin",
] as const;

export const MARKET_AWARENESS_PORTAL_ROLES: readonly PhoenixRole[] = [
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "National Sales Manager",
  "SFE Manager",
  "Finance Manager",
  "CEO",
  "Super Admin",
] as const;

/**
 * The drafts workspace and the Approval Inbox. Medical Rep excluded — see
 * marketingRequestCreatorRoles.
 */
export function canUseEmployeePortalMarketingRequests(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return marketingRequestCreatorRoles.has(resolvePortalRole(roleLabel, accessRole));
}

/**
 * Customer Validation (/employee-portals/marketing-requests/validation) — the field-capture screen.
 *
 * Its own predicate since 2026-09-18, because it is the ONE marketing surface a Medical Rep keeps
 * when the drafts workspace and the Approval Inbox are hidden from them. Before this it shared
 * canUseEmployeePortalMarketingRequests, so narrowing that list would have closed the capture screen
 * on the very people who do the capturing.
 */
export function canUseEmployeePortalMarketingValidation(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return marketingRequestRoles.has(resolvePortalRole(roleLabel, accessRole));
}

export function canUseEmployeePortalMarketingControl(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  const role = resolvePortalRole(roleLabel, accessRole);
  return role === "SFE Manager" || role === "Super Admin";
}

/**
 * Whether the dashboard "Submit Marketing Request" quick-action should render.
 *
 * Marketing Requests is now a full module, so the quick-action renders whenever
 * the role is already authorized for Marketing — independent of the beta flag.
 * The leading `betaNavEnabled` parameter is retained for call-site compatibility
 * (the dashboard still passes it) but no longer gates visibility.
 */
export function shouldShowEmployeePortalMarketingQuickAction(
  _betaNavEnabled: boolean | undefined,
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return canUseEmployeePortalMarketingRequests(roleLabel, accessRole);
}

/**
 * SFE Manager joined Super Admin here on owner instruction (2026-08-03): the SFE Manager owns
 * customer validation, so it has to see every customer employees have submitted — validated and
 * unvalidated alike — not just the ones that already cleared. Kept to these two: this table shows
 * raw submitted evidence (addresses, phone numbers, live photos) for the whole company.
 */
export function canUseEmployeePortalMarketingCustomerDatabase(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  const role = resolvePortalRole(roleLabel, accessRole);
  return role === "Super Admin" || role === "SFE Manager";
}

/**
 * Company-wide marketing request register (owner instruction, 2026-08-03).
 *
 * Marketing Manager, SFE Manager and Super Admin must be able to see EVERY request on the system
 * and where each one is stopped. Deliberately narrower than marketingRequestRoles: a District
 * Manager or Medical Rep still sees only their own subtree, through the normal workspace.
 */
export function canUseEmployeePortalMarketingAllRequests(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  const role = resolvePortalRole(roleLabel, accessRole);
  return role === "Marketing Manager" || role === "SFE Manager" || role === "Super Admin";
}

/**
 * ROI Tracker (/employee-portals/roi-tracker).
 *
 * Reads marketingRequestRoles, NOT the narrower creator list: the Medical Rep keeps this screen by
 * owner instruction (2026-09-18) so they can "track roi of requests his manager did in his area".
 * Rows are bounded server-side — resolveMarketingRoiScope gives a rep their own seat plus the
 * requests whose target customer sits in their own area, nothing wider.
 */
export function canUseEmployeePortalMarketingRoiTracking(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return marketingRequestRoles.has(resolvePortalRole(roleLabel, accessRole));
}

/**
 * Direct Orders in my area — the Medical Rep's VIEW-ONLY window onto the direct orders their
 * District Manager booked on pharmacies in the rep's own area (owner instruction, 2026-09-24).
 *
 * Medical-Rep only, by design: every manager seat either RAISES direct orders through the
 * requester workspace (showDirectOrdersTab / DIRECT_ORDER_REQUESTER_ROLES) or already reads a wider
 * report, so none of them needs this narrow area window. Rows are bounded server-side to the rep's
 * own area(s) — `employees.area_id` plus their own REP seat's areas, merged areas expanded for the
 * counted month — see getRepAreaDirectOrders.
 */
export function canUseEmployeePortalAreaDirectOrders(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return resolvePortalRole(roleLabel, accessRole) === "Medical Rep";
}

/**
 * My Milestones (/employee-portals/milestones) — the rep's own keepsake cards, self-scoped.
 *
 * Medical-Rep only, by owner instruction (2026-09-30): every other seat either has the Super-Admin
 * Milestones workspace or does not congratulate itself. This is the audience the sidebar offers AND
 * the audience /api/milestones/my-card admits — one predicate so the door and the route agree. The
 * route is self-scoped regardless (it only ever builds the caller's own card), so this narrows WHO
 * may reach it, never WHOSE card it makes.
 */
export function canUseEmployeePortalMilestones(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return resolvePortalRole(roleLabel, accessRole) === "Medical Rep";
}

/**
 * Broader than ROI Tracking's own role set: the Marketing Coverage Report is
 * deliberately open to the whole marketing/sales hierarchy INCLUDING Finance
 * Manager and Financial Advisor (company-wide server-side, as in ROI Tracking —
 * see coverage-report-scope.ts), not just marketingRequestRoles.
 */
export function canUseEmployeePortalMarketingCoverageReport(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
) {
  return canViewMarketingCoverageReport(resolvePortalRole(roleLabel, accessRole));
}

export function resolveEmployeePortalNavVisibility(
  roleLabel: string | null | undefined,
  accessRole?: string | null | undefined,
  employeeLineName?: string | null | undefined,
  employeeDepartmentName?: string | null | undefined,
  viewerHrId?: string | null | undefined,
  hasDeviceMapping?: boolean,
  hasInterviewCalendarAccess?: boolean,
  hasPhoenixCrmEntry?: boolean,
  hasPhoenixCrmForecast?: boolean,
  hasTeamPlaceChecks?: boolean,
  hasDoubleVisitRequests?: boolean,
): EmployeePortalNavVisibility {
  const resolvedRole = resolvePortalRole(roleLabel, accessRole);
  const normalizedLine = String(employeeLineName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizedDepartment = String(employeeDepartmentName ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const isMedicalRep = resolvedRole === "Medical Rep";
  const isDistrictManager = resolvedRole === "District Manager" || resolvedRole === "Manager";
  /**
   * The Head-Office people-manager rung, folded into `isDistrictManager` above as a legacy alias.
   *
   * It is NOT a district seat, and the two live accounts on it are Head Office (QPPV, R&D Manager),
   * so five rows it inherited through that alias opened to an empty page or an outright refusal:
   * Team Performance ("only available for District Sales Managers"), Sales vs Target and Monthly
   * Closing (no territory, no line — Head Office is stripped from every closing viewer), Early
   * Birds ("no district in your scope") and Weekly / Monthly Plan (the rung is not in
   * WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES and holds no `weekly_plans:create`, so submitting is
   * Forbidden). Hidden at the owner's instruction, 2026-09-29.
   *
   * Only those five. Everything else the rung reaches through the alias — Team Coaching Reports,
   * Probation Tracker, the approvals — is unchanged, which is why the alias itself stays and the
   * derived flags below read `managerTierScope` rather than the narrowed Team Performance flag.
   */
  const isHeadOfficeManagerRung = resolvedRole === "Manager";
  /** The manager-tier reach the rows BELOW derive from — deliberately still includes the rung. */
  const managerTierScope = isDistrictManager;
  const isNationalSalesManager = resolvedRole === "National Sales Manager";
  // Regional Manager sits between DSM and NSM: region-scoped (own line, narrowed to the regions in
  // their management subtree — see regionsWithinManagerHierarchy). Their Probation, Team Coaching
  // and Organogram data access already exists server-side; these tabs surface it.
  const isRegionalManager = resolvedRole === "Regional Manager";
  // Product / Group Product / Marketing Managers get line-scoped Vacancies, Probation, and
  // Organogram views (see getEmployeePortalVacancies, probation service, and
  // isLineScopedOrganogramRole). The sidebar tabs must mirror that data access.
  const isProductManager = resolvedRole === "Product Manager";
  const isGroupProductManager = resolvedRole === "Group Product Manager";
  const isMarketingManager = resolvedRole === "Marketing Manager";
  const isA3Account = canonicalHrIdKey(viewerHrId) === "a-3";
  // The retired Talent Acquisition seat was the ONLY portal-mode HR/office role. Both successor
  // bundles (HR Advisory, HR Operations) are ADMIN-shell roles — resolveNavigationMode never
  // returns "employee-portal" for either — so no portal role is HR/office staff any more and this
  // is empty by design. Kept as a named set rather than deleted so the field-employee carve-outs
  // below still read as deliberate exclusions; the /hr namespace (Phase 2) is where these tools
  // live for the new seats. Adding a portal-mode HR role here is the only thing that revives them.
  const portalHrOfficeRoles = new Set<PhoenixRole>([]);
  const isPortalHrOfficeStaff = portalHrOfficeRoles.has(resolvedRole);
  // The raw ACCESS role, not the job-title-derived one — see showActionsTab below.
  const isPlainEmployeeAccessRole = String(accessRole ?? "").trim().toLowerCase() === "employee";
  const isHeadOffice =
    ["office", "headoffice", "hq"].includes(normalizedLine) ||
    ["office", "headoffice", "hq"].includes(normalizedDepartment);
  // Direct Orders is hidden from the CNS line entirely (owner decision) — even a role
  // that would otherwise qualify (DM/RM/NSM/PM/GPM) never sees these 3 tabs while on
  // the CNS line. This is a NAV-ONLY exclusion; it does not touch data access.
  const isCnsLine = normalizedLine === "cns";
  const isTrainingManager = resolvedRole === "Training Manager";
  // Mirrors EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts, which is the enforcing gate.
  // Spelled out here instead of imported: that module pulls in the Supabase server client and
  // node:crypto, neither of which may reach this nav helper (it is consumed by client components).
  const isExcuseExcludedPortalRole =
    resolvedRole === "District Manager" || resolvedRole === "Regional Manager";
  const hideMyPerformanceTab = hideMyPerformanceTabRoles.has(resolvedRole);
  const showTeamPerformanceTab = isDistrictManager && !isHeadOfficeManagerRung;
  // MRs Performance and DSMs Performance — the National Sales Manager's line roll-ups, and since
  // 2026-10-20 the Regional Manager's too (owner: "every single role that's applicable to appear in
  // a module"). His landing page already listed his districts and his top reps, and Team
  // Performance told him it was for District Sales Managers only, so he had no page for either.
  // Both pages admit him by the same two roles and the data is the same builder, bounded to his own
  // seat's areas (resolveVsTargetBound) — never his whole line.
  const isPerformanceRollupRole = isNationalSalesManager || isRegionalManager;
  const showMedRepsPerformanceTab = isPerformanceRollupRole;
  // Reps List — the portal twin of /admin/reps-list, scoped to the viewer's own reach. The owner
  // asked for it on 2026-08-31: "every manager in the employee portal has a scoped reps list."
  //
  // IMPORTED as of 2026-09-03, like Reps Plans and KPIs below, and no longer spelled out. It had to
  // be spelled out while the list lived in doctor-list-access.ts, which reaches the Supabase server
  // client through manager-scope.ts and so can never be imported here; the roles moved to
  // doctor-list-roles.ts, which carries no server-only import for exactly this caller. That removes
  // the second hand-maintained copy — the widening that day took the portal half from three seats to
  // seven, which is where keeping two copies in step by hand stops being realistic.
  //
  // Deliberately NOT isDistrictManager — that predicate also admits the bare "Manager" title, which
  // the access module does not. Reusing it would show a Manager a row the page then refuses, which
  // is the "visible row he cannot open" bug the sidebar tests exist to catch. Asking the list itself
  // makes the two answers one answer.
  const showRepsListTab = DOCTOR_LIST_PORTAL_ROLES.includes(resolvedRole);
  // My List was RETIRED from the portal sidebar (owner, 2026-09-25: "hide the my-list board", then
  // "delete the dormant My List board code") — the rep's own contact list lives in Phoenix CRM's
  // List tab, which every rep reaches by its own phoenix_crm:read link. The old /employee-portals/
  // my-list route survives only as a redirect onto it; there is no sidebar row to compute here.
  // KPIs — imported rather than spelled out, unlike Reps List above. doctor-coverage-roles.ts is the
  // SINGLE list of who reaches this board and was deliberately built free of any server-only import
  // for exactly this caller, so there is no second copy to drift. It is also the module the page
  // gate and the data scope both read, which is what stops a visible row the page then refuses.
  //
  // Marketing Manager is in the list and is portal-mode, so she gets the row; Super Admin, CEO and
  // SFE Manager are admin-mode and land on /admin/kpis instead.
  //
  // DOCTOR_COVERAGE_PORTAL_ROLES, not canSeeDoctorCoverage — the PORTAL half of the list, exactly as
  // the two flags above take the portal half of theirs. The predicate answers for every role with
  // any door onto the board, admin-mode seats included, and reading it here rested on the argument
  // that this resolver never runs for those seats. That argument is true today and is not the kind
  // of thing this file should depend on: it is a claim about a caller three modules away, it is
  // untestable from here, and the day a preview or an impersonation path renders the portal rail for
  // an admin-mode viewer it changes silently. system-navigation.ts already states this row's roles
  // are DOCTOR_COVERAGE_PORTAL_ROLES verbatim, so the flag and the catalog entry now read one list
  // and the constant that exists for this caller is no longer unused.
  const showKpisTab = DOCTOR_COVERAGE_PORTAL_ROLES.includes(resolvedRole);
  // Talent Acquisition is HR staff processing outstation expenses, not a field claimant —
  // she has no outstation expenses of her own, so both expense tabs stay hidden for her.
  const showExpenseActionTab = !isMedicalRep && !isPortalHrOfficeStaff;
  const showExpenseDashboardTab = !isMedicalRep && !isPortalHrOfficeStaff;
  // "My Visits" (CRM field visits) and Deductions are owner-requested exclusions for
  // Talent Acquisition specifically — she is HR/office staff, not a field employee.
  const showMyVisitsTab = !isPortalHrOfficeStaff;
  const showDeductionsTab = !isPortalHrOfficeStaff;
  // Marketing Requests and Contact HR Support are full modules: their tabs are visible
  // without the launch flag. Marketing role checks still apply, so Marketing visibility
  // never extends to an unauthorized role. Contact HR Support is available to every
  // employee-portal user — everyone must be able to reach their HR team.
  const showMarketingRequestsTab = canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingValidationTab = canUseEmployeePortalMarketingValidation(resolvedRole);
  const showMarketAwarenessTab = MARKET_AWARENESS_PORTAL_ROLES.includes(resolvedRole);
  const showVisualAidsTab = VISUAL_AIDS_PORTAL_ROLES.includes(resolvedRole);
  // Only the seats that can actually hold a decision: the two manager-step holders and the CEO.
  // An empty queue for everyone else is noise, and the page scopes itself server-side anyway.
  const showMarketAwarenessInboxTab = MARKET_AWARENESS_DECIDER_ROLES.includes(resolvedRole);
  const showMarketingInboxTab = canUseEmployeePortalMarketingRequests(resolvedRole);
  const showMarketingAllRequestsTab = canUseEmployeePortalMarketingAllRequests(resolvedRole);
  const showMarketingCustomerDatabaseTab = canUseEmployeePortalMarketingCustomerDatabase(resolvedRole);
  const showMarketingControlTab = canUseEmployeePortalMarketingControl(resolvedRole);
  const showMarketingRoiTrackingTab = canUseEmployeePortalMarketingRoiTracking(resolvedRole);
  const showMarketingCoverageReportTab = canUseEmployeePortalMarketingCoverageReport(resolvedRole);
  // The 2026-09-29 portal hide of coaching was LIFTED by the owner on 2026-10-24 ("lift the hide
  // from everyone"), so this is the pre-hide rule again. Regional Manager included:
  // canAccessCoachingEmployee (coaching/service.ts) already scopes an RM to their full management
  // subtree via isWithinManagerHierarchy, so the reports exist — only the link was missing.
  const showTeamCoachingTab = showTeamPerformanceTab || showMedRepsPerformanceTab || isRegionalManager;
  // Must stay in lockstep with WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES (weekly-planning/plan-v1.ts):
  // a role listed here but not there sees the builder link and gets "Forbidden" on submit, and a
  // role eligible there but missing here can submit but has no way to reach the page. District
  // Manager was the second case until 2026-07-30 (eligible to submit, no link).
  //
  // "Manager" was the FIRST case — listed here, absent there, and holding no `weekly_plans:create`
  // — for as long as this list has existed, which is exactly the failure the paragraph above
  // describes. Removed 2026-09-29 at the owner's instruction, with the other four rows the
  // Head-Office rung inherited through the District Manager alias.
  const showPlansTab = [
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Training Manager",
    "National Sales Manager",
    "CEO",
    "Super Admin",
    "Regional Manager",
    "District Manager",
  ].includes(resolvedRole);
  const baseShowMyPerformanceTab = !hideMyPerformanceTab;
  const baseShowIncentiveTab = !isTrainingManager && !isMarketingManager && !isPortalHrOfficeStaff;
  // Product / Group Product Managers (and their line manager, Marketing Manager) get the
  // line/product-scoped Sales Intelligence analytics surfaces. Each page enforces its own
  // server-side scope; the sidebar visibility just mirrors that access.
  const showSalesIntelligence = isProductManager || isGroupProductManager || isMarketingManager;
  // National Sales Manager also gets the ROI/Marketing Intelligence dashboard (their business
  // scope is LINE — see getSalesScope — so the page + service already bound them to their own
  // line's data). Deliberately NOT folded into showSalesIntelligence: that flag also drives
  // Coaching Analytics and Double-Visit Analytics, which NSM was not asked to gain here.
  const showRoiIntelligenceTab = showSalesIntelligence || isNationalSalesManager;
  const showDirectOrdersTab = !isCnsLine && isDirectOrderRequesterRole(resolvedRole);
  // The Medical Rep's read-only "Direct Orders in my area" window (owner, 2026-09-24). Bounded to
  // the rep's own area server-side; not tied to the requester workspace above.
  const showAreaDirectOrdersTab = canUseEmployeePortalAreaDirectOrders(resolvedRole);
  // My Milestones — the rep's own keepsake cards, self-scoped (owner, 2026-09-30).
  const showMilestonesTab = canUseEmployeePortalMilestones(resolvedRole);
  // Production Planner — by NAME, never by role (see the field's comment above).
  const showProductionPlanningTab = isNamedProductionPlanningPerson(viewerHrId);

  return {
    showDashboardTab: !isTrainingManager,
    showDsmsPerformanceTab: isPerformanceRollupRole,
    showTeamCalendarTab: isNationalSalesManager,
    showFieldAbsenceTab: isNationalSalesManager,
    // The isHeadOffice branch is line/department-based, so a District or Regional Manager sitting
    // on the Office line would otherwise be offered a submit form the server now rejects — mirror
    // the EXCUSE_EXCLUDED_ROLES gate here so the tab never appears for those two roles.
    showExcusesTab:
      !isExcuseExcludedPortalRole &&
      (isHeadOffice ||
        isNationalSalesManager ||
        isProductManager ||
        isGroupProductManager ||
        isMarketingManager ||
        isTrainingManager ||
        isPortalHrOfficeStaff),
    showExpenseActionTab: isA3Account ? false : showExpenseActionTab,
    showExpenseDashboardTab: isA3Account ? false : showExpenseDashboardTab,
    showIncentiveTab: isA3Account ? false : baseShowIncentiveTab,
    showMarketingAllRequestsTab,
    showMarketingCustomerDatabaseTab,
    showMarketingControlTab,
    showMarketingInboxTab,
    showMarketingValidationTab,
    showMarketAwarenessInboxTab,
    showMarketAwarenessTab,
    showVisualAidsTab,
    showMarketingRequestsTab,
    showMarketingRoiTrackingTab,
    showMarketingCoverageReportTab,
    showMedRepsPerformanceTab,
    showRepsListTab,
    showKpisTab,
    showMedicalRepExpensesTab: isMedicalRep,
    // Medical Rep and District Manager (owner, 2026-09-30). `isDistrictManager` folds in the
    // Head-Office "Manager" rung as a legacy alias, which holds no sales seat — excluded here, or the
    // door opens on a page that can only tell him he has no seat.
    showSpotlightTab: isMedicalRep || (isDistrictManager && !isHeadOfficeManagerRung),
    showMyPerformanceTab: isA3Account ? false : baseShowMyPerformanceTab,
    // My Coaching Reports — hidden from the portal sidebar for Medical Rep by owner instruction
    // (2026-09-24), mirroring the Early Birds change; District Manager / NSM / Regional Manager
    // keep the row via showTeamCoachingTab below, untouched. The route and the coaching module
    // itself are unaffected — only this flag, and only for the rep's own row, changed.
    showMyCoachingTab: false,
    // Report It (pharmacovigilance) — EVERY portal role, from 2026-09-29 (owner). Every one of them
    // holds `report_it:read`/`create` and the page serves all of them the submission form and their
    // own reports, but the row existed only for A-3 and the four roles on the dashboard flag below,
    // so a Medical Rep, DM, RM or NSM who saw a side effect had no door to report it. The two flags
    // stay separate — this one draws the row under Leave & HR, the other draws the
    // Pharmacovigilance section — and the layout shows at most one of the two per viewer.
    showReportItTab: !showReportItDashboardRoles(resolvedRole),
    showReportItDashboardTab: showReportItDashboardRoles(resolvedRole),
    // District Manager added 2026-08-22 alongside isLineScopedOrganogramRole in
    // src/lib/reports/organogram.ts, which is the enforcing gate; this flag only surfaces the
    // link. Spelled `resolvedRole === "District Manager"` deliberately, NOT isDistrictManager:
    // the latter also matches the Head-Office "Manager" rung, and that rung as a whole still gets
    // no organogram link — only the ONE pinned account below does.
    //
    // isA3Account added 2026-09-02 (owner: "show the full organogram to sama mosaad account"). The
    // rung DOES now hold organogram:read in defaultPermissionMatrix, but the enforcing gates
    // (canAccessCompanyOrganogram / canAccessHeadOffice in src/lib/reports/organogram.ts) are
    // pinned by HR_ID (A-3, and AB since 2026-10-20), so surfacing the link for the whole rung
    // would hand A-14 a row that redirects — the dead link tests/sfe-manager-nav-dead-links.test.ts
    // exists for. This flag is the pinned accounts' ONLY door: system-navigation.ts's portal
    // Organogram entry deliberately does NOT list "Manager", because that file cannot express an
    // HR_ID, so adding the role there would fail
    // tests/organogram-nav-link-exists-for-every-role-that-can-open-it.test.ts as a dead link for
    // A-14. The cost is that the command palette cannot offer it to them.
    //
    // Training Manager added 2026-09-10 (owner: A-7 reported the organogram missing). This is the
    // SAME hole the 2026-08-25 fix was written for, one layer further in, and it stayed open
    // because that fix landed in the wrong file for this shell: system-navigation.ts's portal
    // Organogram entry lists him, but that seed drives the command palette, NOT the portal
    // sidebar. The rail in employee-portal-layout.tsx is built from these flags alone, so the
    // entry there was true and the link still never rendered. He is company-scoped in
    // canAccessCompanyOrganogram and holds organogram:read, so the page has served him the whole
    // chart on request the entire time — exactly the "granted on paper, unreachable in the
    // product" shape, and the third time this page has paid for it.
    //
    // The pinned accounts are read from src/lib/reports/organogram-pinned-accounts.ts, the SAME list
    // the two enforcing gates read, so the link and the page cannot disagree. That list gained AB,
    // the R&D Manager the QPPV reports to (owner, 2026-10-20); A-14 stays outside, with no link.
    // `isA3Account` is no longer the organogram door — it still carries her other carve-outs only.
    showOrganogramTab:
      isFullOrganogramPinnedHrId(viewerHrId) ||
      showMedRepsPerformanceTab ||
      resolvedRole === "District Manager" ||
      isRegionalManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager ||
      isTrainingManager ||
      isPortalHrOfficeStaff,
    // Talent Acquisition keeps the read-only Planning Calendar (HO-scoped) but not the
    // Weekly/Monthly Plan submission page — owner-requested removal, 2026-07-25. The Head-Office
    // rung keeps it too: it is READ-ONLY and it holds `weekly_plans:read`, so unlike the builder
    // below it opens and works. `isHeadOfficeManagerRung` is spelled out because that rung just
    // left `showPlansTab`.
    showPlanningCalendarTab: isA3Account || isHeadOfficeManagerRung || showPlansTab,
    // The A-3 override (2026-06-10) went with the rung on 2026-09-29: it granted the BUILDER, and
    // the builder refuses her — QPPV is not in WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES and the
    // Manager role holds no `weekly_plans:create`, so submitting was always Forbidden. She keeps
    // the read-only Planning Calendar above, which is the half that ever worked.
    // A manager whose Phoenix CRM team is live plans his week THERE (owner, 2026-10-16), and the tab
    // stays to READ the plans he filed on this form before (owner, 2026-10-17: "make it unhidden, but
    // make them not able to submit … only able to see their historical plans"). The page shows him
    // that history only, and the form refuses him a new plan, an edit ask, a cancel and visit details.
    showPlansTab: showPlansTab && !isPortalHrOfficeStaff,
    // Regional Manager included: canReadProbationEmployee already has an RM branch that walks the
    // full management subtree (probation/service.ts), so an RM sees every med rep under every DSM
    // in their region — the tab was the only thing missing.
    //
    // Training Manager added 2026-09-29 (owner). `canViewAllProbation` already includes him
    // (probation/service.ts), the page lets him file manager feedback, and system-navigation.ts
    // lists him — the rail is built from these flags alone, so he had the page and no door to it.
    // The third time this exact shape has been fixed here; see the Organogram note above.
    //
    // `managerTierScope`, not showTeamPerformanceTab: the Head-Office rung keeps this row.
    showProbationTab:
      managerTierScope ||
      showMedRepsPerformanceTab ||
      isRegionalManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager ||
      isTrainingManager ||
      isPortalHrOfficeStaff,
    showSupportTab: true,
    showRecruitmentHiringTab: isPortalHrOfficeStaff,
    showPeopleManagementTab: isPortalHrOfficeStaff,
    showPrivateCalendarTab: true,
    showAccountActivationTab: isPortalHrOfficeStaff,
    showTeamCoachingTab,
    // Team Expenses was an NSM-only surface. It is retired from the portal nav:
    // the NSM's single expense destination is now the Expense Dashboard, whose
    // LINE scope (see getExpensesScope) already covers self + the whole line.
    showTeamExpensesTab: false,
    showTeamPerformanceTab,
    // The Training Manager section is back in the portal (owner, 2026-10-24: "full section … lift the
    // hide from everyone"), after the 2026-09-29 hide.
    showTrainingManagerCreateCoachingTab: isTrainingManager,
    showTrainingManagerDashboardTab: isTrainingManager,
    showTrainingManagerFieldCoachingTab: isTrainingManager,
    // Regional Manager included: getEmployeePortalVacancies already has an RM branch that bounds
    // open seats to the RM's own line AND the regions in their management subtree, so the data was
    // there — the missing `vacancies` grant (added to defaultPermissionMatrix) and this flag were
    // the only two things keeping it unreachable. Same shape as the Probation/Organogram/Team
    // Coaching RM fixes above.
    //
    // "Manager" is excluded for the same reason showMyCandidatesTab below excludes it, and the
    // exclusion has to be written out because it arrives here indirectly: line 292 folds Manager
    // into isDistrictManager, which is showTeamPerformanceTab, which is the first disjunct above.
    // Manager is the one manager-tier role holding no `vacancies` grant at all, so the page's own
    // `canAccess(access, "vacancies", "read")` gate redirected it on arrival — a rail row that
    // bounced. Found 2026-08-29 by every-offered-link-opens.test.ts, once it was reading gates
    // through tests/support/page-gate-reader.ts; its own parser could not see that gate's shape.
    //
    // Removing the row rather than granting the permission is what the matrix says to do: Manager
    // is a strict SUBSET of District Manager — measured the same day, it holds 0 permissions DM
    // lacks, while DM holds 6 resources it lacks (crm_plans, direct_orders, early_birds,
    // organogram, vacancies, weekly_sales) and strictly more actions on 3 others. A difference
    // that runs one way on every single resource is a deliberate narrowing, not an oversight, so
    // `vacancies` is withheld on purpose and granting it here would widen real access.
    //
    // Training Manager added 2026-09-29 (owner), same shape as Probation above: he holds
    // `vacancies:read`, and getEmployeePortalVacancies → canAccessCompanyVacancies serves him the
    // whole company, so the page worked and only the row was missing.
    showVacanciesTab:
      (managerTierScope ||
        showMedRepsPerformanceTab ||
        isRegionalManager ||
        isProductManager ||
        isGroupProductManager ||
        isMarketingManager ||
        isTrainingManager) &&
      resolvedRole !== "Manager",
    // Mirrors the roles that actually hold `hiring_interviews: ["read","update"]` in
    // defaultPermissionMatrix (the page's own canAccess gate is the enforcing check), and the same
    // set the command-palette entry in system-navigation.ts already declares. "Manager" is
    // deliberately left out here: it is in that palette list but has no hiring_interviews grant, so
    // a sidebar link would dead-end on the page's empty state.
    showMyCandidatesTab:
      resolvedRole === "District Manager" ||
      isRegionalManager ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    // National Sales Manager only. The report is scoped to his own line inside
    // loadManagerCvEngagement (resolveHiringManagerScopeHrIds → LINE), so a company-wide manager
    // never appears in it; Super Admin and CEO see every line through the admin-shell twin instead.
    // The three roles it admits are exactly canViewManagerCvEngagement — kept in step by hand,
    // because that gate lives in a server module this client-consumed helper must not import.
    showManagerEngagementTab: isNationalSalesManager,
    // Shared with them by the calendar's owner — see hasInterviewCalendarAccess in
    // src/lib/recruitment/interview-calendar.ts, which the page itself also asks.
    showInterviewCalendarTab: hasInterviewCalendarAccess === true,
    // Personally device-tracked employees see their own punch history; a head-of-department
    // Marketing Manager also gets the tab to review their team's attendance (self + her subtree,
    // gated server-side by assertCanViewEmployeeAttendance on /employee-portals/fingerprint-analytics).
    // So does the generic "Manager" seat (the R&D Manager has reports): the page admits him through
    // his attendance:read grant and the picker lists the same team (owner, 2026-10-20).
    showFingerprintReportTab: hasDeviceMapping === true || isMarketingManager || isHeadOfficeManagerRung,
    // No role test on purpose. `phoenixCrmEntryAvailable` (src/lib/phoenix-crm/server/page.ts) is the
    // module's own gate and already answers permission, territory and line opening together; a second
    // list of roles here would drift from it the first time the owner opens or closes a line.
    showPhoenixCrmTab: hasPhoenixCrmEntry === true,
    // The same module gate, its forecast half — never a role list either.
    showDailyForecastTab: hasPhoenixCrmForecast === true,
    // And its district-manager half (owner, 2026-10-13). `readsTeamPlaceChecks` answers it, so a
    // manager whose seat tier changes gains or loses the row without a list here being edited.
    showTeamPlaceChecksTab: hasTeamPlaceChecks === true,
    // And the report of the double visits reps ask for (owner, 2026-10-16), the module's own answer too.
    showDoubleVisitRequestsTab: hasDoubleVisitRequests === true,
    showRoiIntelligenceTab,
    // Mirrors PORTAL_SOS_ACTION_ROLES (portal-sos-dashboard.ts). Medical Rep added 2026-09-14 (owner):
    // he sees his own area's pharmacy action lists only, never the distributor dashboard.
    showSourceOfSalesTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Medical Rep",
    // Mirrors PORTAL_WEEKLY_ROLES (portal-weekly-dashboard.ts) plus PORTAL_WEEKLY_REP_ROLES
    // (portal-weekly-rep.ts). Medical Rep added 2026-09-16 (owner): the same page shows him his own
    // area's weekly sales only, never the managers' dashboard, its API or its export.
    showWeeklyTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Medical Rep",
    // Weekly Stock — mirrors PORTAL_WEEKLY_STOCK_ROLES (stock-dashboard-service.ts), the server-side
    // gate this flag must stay in sync with.
    showWeeklyStockTab:
      resolvedRole === "Medical Rep" ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager",
    // Monthly Closing — mirrors PORTAL_CLOSING_ROLES (monthly-closing-portal.ts), the server-side
    // gate this flag must stay in sync with. isDistrictManager already folds in the legacy "Manager"
    // alias. Marketing Manager added 2026-08-12 (owner) — she opens her three oversight lines here;
    // see PORTAL_CLOSING_ROLES for why this tab, and not the admin /sales/monthly-closing URL she
    // named, is her door. Medical Rep added 2026-09-16 (owner) — their own area(s) only, never their
    // region; the bound is enforced server-side in resolvePortalClosingScope, not by this flag.
    //
    // The Head-Office rung is excluded from 2026-09-29 (owner). PORTAL_CLOSING_ROLES still admits
    // it as a "legacy District Manager alias", but no live account on it is a district seat, and
    // the page strips Head Office from every viewer — so it always answered "couldn't resolve a
    // product line". The page gate is unchanged; only the row is gone.
    showMonthlyClosingTab:
      isMedicalRep ||
      (isDistrictManager && !isHeadOfficeManagerRung) ||
      isRegionalManager ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    // Performance Review — the three TERRITORY tiers, mirroring PORTAL_PERFORMANCE_REVIEW_ROLES
    // (closing-performance-review-access.ts), the server-side gate this flag must stay level with.
    // The Head-Office rung is excluded for the same reason as the row above it: it holds no district
    // seat, so the page could only ever answer "couldn't resolve a product line".
    showPerformanceReviewTab:
      (isDistrictManager && !isHeadOfficeManagerRung) || isRegionalManager || isNationalSalesManager,
    // Same exclusion, same day: the rung gets TEAM sales scope but holds no district seat, so
    // resolveVsTargetBound answers "No sales territory" and the page is empty for it.
    showSalesVsTargetTab:
      isMedicalRep ||
      (isDistrictManager && !isHeadOfficeManagerRung) ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    showMakeItHappenTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    showTerritoryDrilldownTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      // Super Admin / CEO see every line and drill any one of them nationwide via the line picker
      // (TERRITORY_DRILLDOWN_ROLES / isTerritoryLinePickerRole, the server-side gate this mirrors).
      resolvedRole === "Super Admin" ||
      resolvedRole === "CEO",
    // Mirrors PORTAL_CRM_ROLES exactly (Medical Rep / DSM / RM / NSM, and since 2026-10-20 the
    // Product and Group Product Manager on their own line). Uses the explicit "District Manager"
    // check, NOT isDistrictManager, so the Head-Office "Manager" rung — which has no field reps and
    // would get an empty grid — is excluded, matching the page's own gate.
    showCrmMasterTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager,
    // Mirrors PORTAL_TERRITORY_MANAGEMENT_ROLES in src/lib/territory-management/service.ts, which is
    // the enforcing gate; this flag only surfaces the sidebar link. Spelled out rather than imported
    // for the same reason as the excuse gate above — that module pulls in the Supabase server client,
    // which must never reach this nav helper (it is consumed by client components).
    // Note `resolvedRole === "District Manager"` deliberately, NOT `isDistrictManager`: the latter
    // also matches the Head-Office "Manager" rung, which the page does not admit. Medical Rep is
    // excluded by design (multi-area comparison is a District-Manager-and-up decision).
    showTerritoryManagementTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager,
    // Mirrors PORTAL_TARGETS_ROLES + PORTAL_REP_TARGETS_ROLES in src/lib/sales/portal-targets.ts
    // (the enforcing gate). Spelled out rather than imported: that module reaches the Supabase server
    // client via the sales scope resolver, which must not be pulled into this client-consumed nav
    // helper. Medical Rep sees their OWN targets (owner, 2026-09-16); the Head-Office "Manager" rung
    // owns no areas, so exact-match again.
    showTargetsTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager,
    // Every field-management role, AND the Medical Rep — the owner opened this module to a rep on
    // 2026-09-26 (own list only, downward-only) and asked for the sidebar link on 2026-09-30. The
    // page and both export routes resolve each viewer's scope from the seat map (portal-scope.ts)
    // and a rep narrows to his own areas, so this flag only surfaces the link. CEO/SFE/Super Admin
    // reach it through the admin shell instead.
    showBusinessReviewTab:
      isMedicalRep ||
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager,
    // Coaching Analytics is reachable in the portal again (owner, 2026-10-24, lifting the 2026-09-29 hide).
    showCoachingAnalyticsTab: showSalesIntelligence,
    showDoubleVisitAnalyticsTab: showSalesIntelligence || isTrainingManager,
    // Double Visit Report — sidebar link mirrors the page's own DV_FOCUS_ROLES access gate
    // (home-snapshot.ts): DSM/RM/NSM/PM/GPM/TM. Each server-scopes its own data.
    showDoubleVisitReportTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Training Manager",
    // Field Activity — the PORTAL half of FIELD_ACTIVITY_ROLES (field-activity/access.ts), which is
    // that list minus the three admin-mode seats. Training Manager is deliberately absent: it holds
    // the DV board for its counts, not for one person's day. The link grants nothing on its own —
    // resolveFieldActivityAccess re-checks the role AND the grant, and canOpenSubject narrows every
    // request to the viewer's own org-tree scope.
    showFieldActivityTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager",
    // Early Birds — mirrors the module's own catalog row in employeePortalNavigationSectionSeeds
    // (system-navigation.ts) exactly: every portal-mode role in its audience, MINUS Medical Rep,
    // hidden from the portal sidebar by owner instruction (2026-09-24) — the page and its
    // catalog entry (Modules Control, command palette) are untouched, and every other role in
    // the audience keeps the row. CEO / SFE Manager / Super Admin resolve to the ADMIN shell and
    // get /admin/early-birds from the admin rail instead.
    //
    // The Head-Office "Manager" rung was admitted here on the argument that an honest "no district
    // reports to you" beats an empty grid. The owner ruled otherwise on 2026-09-29: it is not in
    // the catalog row this claims to mirror "exactly", it holds no `early_birds:read`, and a row
    // that only ever says "nothing here" is a row worth removing.
    showRanksTab:
      resolvedRole === "Medical Rep" ||
      (isDistrictManager && !isHeadOfficeManagerRung) ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager ||
      isTrainingManager,
    showEarlyBirdsTab:
      (isDistrictManager && !isHeadOfficeManagerRung) ||
      resolvedRole === "Regional Manager" ||
      isNationalSalesManager ||
      isProductManager ||
      isGroupProductManager ||
      isMarketingManager ||
      isTrainingManager,
    // Other Approvals ("Approvals Hub") — Talent Acquisition has no approval authority
    // (governance restricts that to Super Admin / HR Manager, see hard-boundary notes in
    // permissions.ts), so the whole hub is hidden for her even though the other flags
    // above already evaluate false for her role.
    // Plain "Employee" is excluded for the same reason: the permission matrix grants that
    // role no `approve` action on any resource, so the inbox can never hold an actionable
    // item for them.
    //
    // Deliberately requires BOTH the resolved portal role AND the raw access role to be
    // Employee. resolvePortalRole() also returns "Employee" as its fallback for a job title
    // it cannot classify (e.g. "Qppv"), and such a person may still hold a real approver
    // ACCESS role — gating on the resolved role alone would strip the hub from them. The
    // access role is the permission source of truth, so it gets the deciding vote.
    showActionsTab:
      !isTrainingManager &&
      !isMedicalRep &&
      !isPortalHrOfficeStaff &&
      !(resolvedRole === "Employee" && isPlainEmployeeAccessRole),
    showMyVisitsTab,
    showDeductionsTab,
    showDirectOrdersTab,
    showAreaDirectOrdersTab,
    showMilestonesTab,
    showProductionPlanningTab,
    // Vacation Approvals — confirmed portal-shell approver roles.
    showVacationApprovalsTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Manager",
    // Excuse Approvals — same set MINUS National Sales Manager, District Manager and Regional
    // Manager. Excuse is a Head-Office / fingerprint-attendance concept and is direct-manager-only
    // (no manager-of-manager step), so nobody in the field ladder ever routes one upward: an NSM,
    // DSM or RM never has anything actionable here. DSM/RM removed by owner decision 2026-07-30 —
    // see EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts, which is the enforcing gate; this
    // flag only hides the link. Note "Manager" stays: that is the Head-Office people-manager rung.
    showExcuseApprovalsTab:
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Manager",
    // Weekly / Monthly Plan Approvals — plan submitters + their managers (same portal set as the
    // plan builder link). Kept as its own flag so it never drifts with the leave/excuse gate.
    showPlanApprovalsTab:
      resolvedRole === "District Manager" ||
      resolvedRole === "Regional Manager" ||
      resolvedRole === "National Sales Manager" ||
      resolvedRole === "Product Manager" ||
      resolvedRole === "Group Product Manager" ||
      resolvedRole === "Marketing Manager" ||
      resolvedRole === "Manager",
    showAttendanceTab: true,
  };
}
