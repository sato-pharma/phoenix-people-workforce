import {
  Award,
  BookUser,
  BriefcaseBusiness,
  Building2,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX2,
  ChartColumnBig,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Database,
  FileSpreadsheet,
  FileText,
  Fingerprint,
  FlaskConical,
  Gauge,
  Gift,
  Headphones,
  Home,
  IdCard,
  Mail,
  Inbox,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  MapPinCheck,
  MapPinned,
  Package,
  PackageCheck,
  PackageSearch,
  PhoneCall,
  Radar,
  ReceiptText,
  Repeat2,
  Scale,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sunrise,
  Target,
  Trophy,
  User,
  TrendingUp,
  Users,
  UsersRound,
  WalletCards,
  Waypoints,
} from "lucide-react";

import type { NavigationPermission, NavigationSectionItem } from "@/config/system-navigation";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";

export type PortalNavEntry = {
  /** Short label for the compact bottom-nav tab. */
  label: string;
  /** Descriptive label for the profile quick-navigation grid. */
  fullLabel: string;
  href: string;
  icon: LucideIcon;
  /** Visible if ANY listed flag is truthy. Omitted/empty = always visible. */
  flags?: (keyof EmployeePortalNavVisibility)[];
  /**
   * The single permission the linked page enforces at its entry gate, mirrored here so the two
   * cannot drift. Derived mechanically from the page's own `assertPermission`/`canAccess` gate;
   * `employee-portal-nav-permission-matches-page.test.ts` re-derives it and fails if this copy
   * disagrees. Omitted where the page has no machine-readable single-permission gate (its entry is
   * decided by a role set, an unreadable predicate, or a computed visibility flag alone).
   */
  permission?: NavigationPermission;
  /**
   * The live pending-count badge this destination carries, mirrored from its own row in
   * `employeePortalNavigationSectionSeeds` (src/config/system-navigation.ts) so the bottom bar
   * announces exactly what the sidebar does.
   *
   * The bar is the ONLY navigation on a phone, so a queue with nothing on its tab is a queue
   * nobody is told about — the same failure the sidebar badges exist to prevent, on the surface
   * where it costs most. It renders as the `compact` dot on the icon, never the count pill: at
   * most six tabs share a 375px bar and a pill would eat a label the golden rule already forbids
   * shrinking or truncating.
   *
   * A mirrored copy, like `permission` above, and kept honest the same way:
   * `employee-portal-bottom-nav-badges.test.ts` re-reads the seed and fails if the two disagree,
   * in EITHER direction — a badge added to a nav row and forgotten here is the drift that would
   * otherwise show up as one surface counting and the other silent.
   */
  navBadge?: NavigationSectionItem["navBadge"];
};

/**
 * Single source of truth for the employee-portal destinations surfaced in the
 * mobile bottom nav and the profile quick-navigation grid. Hrefs/flags mirror
 * buildEmployeePortalSections in employee-portal-layout.tsx (the sidebar); the
 * employee-portal bottom-nav guard test keeps the two in sync.
 *
 * BOTH labels must be unique across this list. The bar renders `label`; the customizer that picks
 * what goes in the bar renders `fullLabel` — so a repeat in either one lets a person choose two
 * entries that look different and end up with two tabs they cannot tell apart. Asserted in
 * tests/employee-portal-bottom-nav.test.ts.
 *
 * `label` is also width-bound: at most six tabs (Home + four pinned + Profile) share a 375px bar,
 * which is ~49px of text each at 10px/900. Measure a new short form with the probe in
 * scripts/measure-sidebar-labels.ts; do not guess one.
 */
export const PORTAL_NAV_REGISTRY: PortalNavEntry[] = [
  // My Workspace
  { label: "Incentive", fullLabel: "Incentive", href: "/employee-portals/incentive", icon: Gift, flags: ["showIncentiveTab"], permission: { resource: "incentive", action: "read" } },
  { label: "Plans", fullLabel: "Weekly / Monthly Plan", href: "/employee-portals/plans", icon: CalendarDays, flags: ["showPlansTab"] },
  { label: "Planning", fullLabel: "Planning Calendar", href: "/employee-portals/plans/calendar", icon: CalendarClock, flags: ["showPlanningCalendarTab"], permission: { resource: "weekly_plans", action: "read" } },
  { label: "Vac Appr", fullLabel: "Leave Approvals", href: "/employee-portals/approvals/vacation", icon: CalendarDays, flags: ["showVacationApprovalsTab"], navBadge: "vacation-approvals-pending" },
  { label: "Exc Appr", fullLabel: "Excuse Approvals", href: "/employee-portals/approvals/excuse", icon: CalendarClock, flags: ["showExcuseApprovalsTab"], navBadge: "excuse-approvals-pending" },
  { label: "Plan Appr", fullLabel: "Plan Approvals", href: "/employee-portals/approvals/plan", icon: CalendarRange, flags: ["showPlanApprovalsTab"], navBadge: "plan-approvals-pending" },
  { label: "Approvals", fullLabel: "Other Approvals", href: "/employee-portals/approvals-hub", icon: Inbox, flags: ["showActionsTab"], navBadge: "approvals-hub-pending" },
  { label: "Payslips", fullLabel: "Payslips", href: "/employee-portals/payslips", icon: FileText, permission: { resource: "payslips", action: "read" } },
  { label: "Deductions", fullLabel: "Deductions", href: "/employee-portals/deductions", icon: ReceiptText, permission: { resource: "employee_profile", action: "read" } },
  // MY DISPUTES — one place for everything the employee has disputed, in any of the three modules,
  // decided or waiting (owner, 2026-10-09). Before this a dispute could only be read from inside
  // the screen that raised it, and a decided one disappeared from both sides. Gated on
  // attendance:read, the same permission the page and its routes assert; every list is self-scoped.
  { label: "Disputes", fullLabel: "My Disputes", href: "/employee-portals/disputes", icon: Scale, permission: { resource: "attendance", action: "read" } },
  { label: "360", fullLabel: "Employee 360", href: "/employee-portals/employee-360", icon: IdCard, permission: { resource: "employee_profile", action: "read" } },
  // Every employee's own business card — view, correct name/number, request print from HR.
  { label: "Cards", fullLabel: "Business Cards", href: "/employee-portals/business-cards", icon: IdCard, permission: { resource: "business_card_requests", action: "create" } },
  // Every employee's own email signature — one picture built from their record, with the paste steps (owner, 2026-10-17). Gated like the page: employee_profile:read.
  { label: "Signature", fullLabel: "Email Signature", href: "/employee-portals/email-signature", icon: Mail, permission: { resource: "employee_profile", action: "read" } },
  // My Milestones — the rep's own keepsake cards, self-scoped (owner, 2026-09-30). No `permission`:
  // the page gates by role predicate (canUseEmployeePortalMilestones), not a matrix permission.
  { label: "Milestones", fullLabel: "My Milestones", href: "/employee-portals/milestones", icon: Award, flags: ["showMilestonesTab"] },
  // Production Planner — the toll-manufacturing buy list for Ivyronc (owner, 2026-10-05). No
  // `permission`: `production_planning` is granted to no portal role at all, by design — the two
  // people in this shell who hold the module are admitted BY NAME, so the gate is
  // `showProductionPlanningTab` carrying `isNamedProductionPlanningPerson` in, and the page itself
  // re-asks the database. A matrix permission here would answer "yes" for the whole company.
  { label: "Production", fullLabel: "Production Planner", href: "/employee-portals/production-planning", icon: FlaskConical, flags: ["showProductionPlanningTab"] },
  { label: "Analytics", fullLabel: "Attendance Analytics", href: "/employee-portals/fingerprint-analytics", icon: Fingerprint, flags: ["showFingerprintReportTab"], permission: { resource: "attendance", action: "read" } },
  // Sales Intelligence (Product / Group Product Managers)
  // Sales vs Target leads the sales group: it is the field force's daily dashboard and the only
  // sales destination a Medical Rep can open, so it must be reachable from the phone bottom bar
  // rather than the desktop sidebar alone.
  { label: "vs Target", fullLabel: "Sales vs Target", href: "/employee-portals/sales-vs-target", icon: Gauge, flags: ["showSalesVsTargetTab"], permission: { resource: "sales", action: "read" } },
  { label: "Forecast", fullLabel: "Make It Happen", href: "/employee-portals/make-it-happen", icon: Sparkles, flags: ["showMakeItHappenTab"], permission: { resource: "sales", action: "read" } },
  // Daily Forecast — the CNS reps' boxes for today, a Phoenix CRM tab (owner, 2026-10-01). No
  // `permission`: the gate is the module's own answer (`forecastIsOffered`), carried in by the flag.
  { label: "Daily Forecast", fullLabel: "Daily Forecast", href: "/employee-portals/field-crm/forecast", icon: PackageCheck, flags: ["showDailyForecastTab"] },
  { label: "ROI", fullLabel: "ROI Intelligence", href: "/employee-portals/roi", icon: Target, flags: ["showRoiIntelligenceTab"] },
  { label: "SoS", fullLabel: "Source of Sales", href: "/employee-portals/source-of-sales", icon: ChartColumnBig, flags: ["showSourceOfSalesTab"], permission: { resource: "sales", action: "read" } },
  // The three sales destinations below plus My Visits/Team Calendar further down were in the
  // sidebar but never in this registry, so the mobile bottom bar and the profile quick-nav grid
  // could not reach them at all — for a Regional Manager that meant a default bottom bar with zero
  // sales tabs. The sync test only checked registry -> sidebar, so the reverse drift stayed silent;
  // it now checks both directions.
  { label: "Weekly", fullLabel: "Weekly Sales", href: "/employee-portals/weekly-sales", icon: CalendarRange, flags: ["showWeeklyTab"], permission: { resource: "sales", action: "read" } },
  { label: "Stock", fullLabel: "Weekly Stock", href: "/employee-portals/weekly-stock", icon: Package, flags: ["showWeeklyStockTab"], permission: { resource: "sales", action: "read" } },
  { label: "Closing", fullLabel: "Monthly Closing", href: "/employee-portals/monthly-closing", icon: CalendarRange, flags: ["showMonthlyClosingTab"], permission: { resource: "sales", action: "read" } },
  // The short label is "Performance", not "Review": the bottom nav shows `label` alone and the row
  // below already owns that word there — two tabs both reading "Review" name neither of them.
  { label: "Performance", fullLabel: "Performance Review", href: "/employee-portals/monthly-closing/performance-review", icon: Trophy, flags: ["showPerformanceReviewTab"], permission: { resource: "sales", action: "read" } },
  { label: "Review", fullLabel: "Business Review", href: "/employee-portals/business-review", icon: ChartColumnBig, flags: ["showBusinessReviewTab"] },
  // Two DIFFERENT modules whose full names both start with "Territory" — the short `label` is all
  // the bottom nav shows, so they must not both read "Territory" there. Drilldown is the
  // geography-rooted sales tree; Management is the brick-allocation / rep-residence map.
  { label: "Drilldown", fullLabel: "Sales Drilldown", href: "/employee-portals/territory-drilldown", icon: MapPinned, flags: ["showTerritoryDrilldownTab"], permission: { resource: "sales", action: "read" } },
  { label: "CRM", fullLabel: "CRM", href: "/employee-portals/crm", icon: Database, flags: ["showCrmMasterTab"], permission: { resource: "crm_visits", action: "read" } },
  // The short label is "Reps", not "Reps List": the bottom nav shows `label` alone, and this board
  // is the one page on it a manager reads standing in a pharmacy. Reachable from the phone by the
  // owner's golden rule for it — "must be mobile friendly", never desktop-only.
  { label: "Reps", fullLabel: "Reps List", href: "/employee-portals/reps-list", icon: BookUser, flags: ["showRepsListTab"], permission: { resource: "crm_visits", action: "read" } },
  // My List's sidebar row was retired 2026-09-25 (owner: "hide"/"delete the dormant My List board
  // code") — the rep's list lives in Phoenix CRM now. The /employee-portals/my-list route survives
  // only as a redirect onto it, so it needs no registry row here.
  // KPIs carries the same role list and the same permission as Reps List — one gate, two doors.
  // "KPIs" is already short enough for the bottom nav, so label and fullLabel are the same word.
  { label: "KPIs", fullLabel: "KPIs", href: "/employee-portals/kpis", icon: TrendingUp, flags: ["showKpisTab"], permission: { resource: "crm_visits", action: "read" } },
  // The three measures that left the KPIs page for a page each (owner, 2026-10-14). Same gate as the
  // KPIs row above — `showKpisTab` and crm_visits:read — because the pages are the same board sliced
  // by measure, so no seat sees one door without the others. No `permission` copy here: the gate lives in the
  // shared report page, not in the route file, and the nav-permission guard (B6) mirrors only a page's own gate.
  { label: "Frequency", fullLabel: "Frequency", href: "/employee-portals/kpis/frequency", icon: Repeat2, flags: ["showKpisTab"] },
  { label: "Coverage", fullLabel: "Coverage", href: "/employee-portals/kpis/coverage", icon: Radar, flags: ["showKpisTab"] },
  { label: "Call Rate", fullLabel: "Call Rate", href: "/employee-portals/kpis/call-rate", icon: PhoneCall, flags: ["showKpisTab"] },
  // Early Birds — the one board in this registry a rep opens BEFORE the working day rather than
  // after it, which is exactly the case for a phone tab. No `permission`: the page has no single
  // machine-readable gate (resolveEarlyBirdsScope decides what it shows from the reporting chain),
  // and employee-portal-nav-permission-matches-page.test.ts requires the field to be absent then.
  { label: "Early Birds", fullLabel: "Early Birds", href: "/employee-portals/early-birds", icon: Sunrise, flags: ["showEarlyBirdsTab"] },
  // Phoenix Ranks (owner, 2026-10-05) — one gate, the page's own: canAccess(access, "early_birds", "read").
  { label: "Ranks", fullLabel: "Phoenix Ranks", href: "/employee-portals/ranks", icon: Award, flags: ["showRanksTab"], permission: { resource: "early_birds", action: "read" } },
  // Reps Plans had an entry here until 2026-09-21, when the owner merged it into Reps List — its board
  // is the Call rate tab there, and /employee-portals/reps-plans forwards to it.
  { label: "Territory", fullLabel: "Territory Management", href: "/employee-portals/territory-management", icon: Waypoints, flags: ["showTerritoryManagementTab"], permission: { resource: "territory", action: "read" } },
  { label: "Targets", fullLabel: "Targets", href: "/employee-portals/targets", icon: Target, flags: ["showTargetsTab"], permission: { resource: "sales", action: "read" } },
  // Spotlight (self) — the rep's own recognition sheet, MEDICAL REP ONLY (owner, 2026-09-30). Its page
  // gates on spotlight_self:read, mirrored here; keep in sync with the sidebar entry in
  // employee-portal-layout.tsx.
  { label: "Spotlight", fullLabel: "Spotlight", href: "/employee-portals/spotlight", icon: Sparkles, flags: ["showSpotlightTab"], permission: { resource: "spotlight_self", action: "read" } },
  // One link, the merged ROI Tracker module (ROI + former Coverage Report as two tabs, owner
  // instruction 2026-09-22). Offered on EITHER flag — showMarketingCoverageReportTab is the broader
  // set (Finance Manager / Financial Advisor), who land on the Coverage tab. Keep in sync with the
  // sidebar entry in employee-portal-layout.tsx.
  { label: "ROI Tracker", fullLabel: "Marketing ROI Tracker", href: "/employee-portals/roi-tracker", icon: Target, flags: ["showMarketingRoiTrackingTab", "showMarketingCoverageReportTab"] },
  { label: "Direct Order", fullLabel: "Direct Orders", href: "/employee-portals/direct-orders", icon: ReceiptText, flags: ["showDirectOrdersTab"], navBadge: "direct-orders-needs-action" },
  // A Medical Rep's view-only window onto the counted direct orders in his own area (owner,
  // 2026-09-24). No `permission`: the page gates on role + area via canUseEmployeePortalAreaDirectOrders,
  // not a single assertPermission — same as the requester Direct Order entry above.
  { label: "Area Orders", fullLabel: "Area Direct Orders", href: "/employee-portals/direct-orders-in-my-area", icon: PackageSearch, flags: ["showAreaDirectOrdersTab"] },
  { label: "Visits", fullLabel: "My Visits", href: "/employee-portals/visits", icon: MapPinned, flags: ["showMyVisitsTab"], permission: { resource: "crm_visits", action: "read" } },
  // Phoenix CRM — the rep's own customer list, weekly plan, visits and reports. Beside My Visits
  // because the button inside that page was its only door until 2026-09-23. No `permission`: the
  // page carries no single machine-readable gate (loadPhoenixCrmPage weighs the phoenix_crm
  // permission, the viewer's territories and whether his line is open together), and B6 above
  // requires the field to be absent then.
  // The short label is the full one on purpose: "CRM" alone is already taken above by the vendor
  // CRM Master board, and a manager who holds both would see two tabs reading "CRM".
  { label: "Phoenix CRM", fullLabel: "Phoenix CRM", href: "/employee-portals/field-crm", icon: ClipboardList, flags: ["showPhoenixCrmTab"] },
  { label: "Place checks", fullLabel: "Place checks", href: "/employee-portals/place-checks", icon: MapPinCheck, flags: ["showTeamPlaceChecksTab"], permission: { resource: "phoenix_crm", action: "read" } },
  { label: "Visit report", fullLabel: "Visit report", href: "/employee-portals/visit-report", icon: ClipboardList, flags: ["showTeamPlaceChecksTab"], permission: { resource: "phoenix_crm", action: "read" } },
  { label: "DV requests", fullLabel: "Double visit requests", href: "/employee-portals/double-visit-requests", icon: UsersRound, flags: ["showDoubleVisitRequestsTab"], permission: { resource: "phoenix_crm", action: "read" } },
  { label: "My map", fullLabel: "My map", href: "/employee-portals/my-map", icon: MapIcon, flags: ["showMyMapTab"], permission: { resource: "phoenix_crm", action: "read" } },
  { label: "Calendar", fullLabel: "Team Calendar", href: "/employee-portals/team-calendar", icon: CalendarRange, flags: ["showTeamCalendarTab"] },
  { label: "Absence", fullLabel: "Field Absence Calendar", href: "/employee-portals/field-absence", icon: CalendarX2, flags: ["showFieldAbsenceTab"], permission: { resource: "field_absence", action: "read" } },
  { label: "DV Planner", fullLabel: "DV Planner", href: "/employee-portals/dv-planner", icon: CalendarCheck2, flags: ["showDoubleVisitReportTab"], permission: { resource: "double_visit_analytics", action: "read" } },
  { label: "DV Report", fullLabel: "Double Visit Report", href: "/employee-portals/double-visit-report", icon: FileSpreadsheet, flags: ["showDoubleVisitReportTab"], permission: { resource: "double_visit_analytics", action: "read" } },
  { label: "Field Day", fullLabel: "Field Activity", href: "/employee-portals/field-activity", icon: MapPinned, flags: ["showFieldActivityTab"], permission: { resource: "double_visit_analytics", action: "read" } },
  // Training Manager
  { label: "Overview", fullLabel: "TM Overview", href: "/employee-portals/training-manager", icon: Home, flags: ["showTrainingManagerDashboardTab"] },
  { label: "TM coach", fullLabel: "Coaching Dashboard", href: "/employee-portals/training-manager/coaching", icon: ChartColumnBig, flags: ["showTrainingManagerDashboardTab"], permission: { resource: "coaching", action: "read" } },
  { label: "Field", fullLabel: "Field Coaching", href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, flags: ["showTrainingManagerFieldCoachingTab"], permission: { resource: "coaching", action: "read" } },
  { label: "Achieve", fullLabel: "Rep Achievement", href: "/employee-portals/training-manager/rep-achievement", icon: Trophy, flags: ["showTrainingManagerDashboardTab"], permission: { resource: "rep_product_achievement", action: "read" } },
  { label: "Plan", fullLabel: "Weekly Plan", href: "/employee-portals/field-crm/plan", icon: CalendarRange, flags: ["showTrainingManagerWeeklyPlanTab"] },
  // Market Awareness
  { label: "Awr Appr", fullLabel: "Awareness Inbox", href: "/employee-portals/market-awareness/inbox", icon: Inbox, flags: ["showMarketAwarenessInboxTab"], permission: { resource: "market_awareness", action: "read" }, navBadge: "market-awareness-approvals-pending" },
  { label: "Awareness", fullLabel: "Market Awareness", href: "/employee-portals/market-awareness", icon: Sparkles, flags: ["showMarketAwarenessTab"], permission: { resource: "market_awareness", action: "read" } },
  // Marketing Requests
  { label: "Validation", fullLabel: "Customer Validation", href: "/employee-portals/marketing-requests/validation", icon: ShieldCheck, flags: ["showMarketingValidationTab"] },
  { label: "Marketing", fullLabel: "Marketing Requests", href: "/employee-portals/marketing-requests", icon: Send, flags: ["showMarketingRequestsTab"] },
  { label: "Inbox", fullLabel: "Marketing Inbox", href: "/employee-portals/marketing-requests/inbox", icon: Inbox, flags: ["showMarketingInboxTab"], navBadge: "marketing-approvals-pending" },
  { label: "All", fullLabel: "All Marketing Requests", href: "/employee-portals/marketing-requests/all", icon: ClipboardList, flags: ["showMarketingAllRequestsTab"] },
  { label: "Control", fullLabel: "Marketing Control", href: "/employee-portals/marketing-requests/control", icon: Settings2, flags: ["showMarketingControlTab"] },
  { label: "Customers", fullLabel: "Customer Database", href: "/employee-portals/marketing-requests/customer-database", icon: Database, flags: ["showMarketingCustomerDatabaseTab"] },
  // "Coverage" was its own entry until 2026-09-22, when the Coverage Report became the Coverage tab
  // of the ROI Tracker module above. Its route now redirects there; the merged link carries both flags.
  // Leave Management
  { label: "Vacation", fullLabel: "Vacation Request", href: "/employee-portals/vacation-request", icon: CalendarDays },
  { label: "Leave", fullLabel: "Vacation Report", href: "/employee-portals/vacation-report", icon: FileText },
  { label: "Excuses", fullLabel: "Excuses", href: "/employee-portals/excuses", icon: CalendarClock, flags: ["showExcusesTab"] },
  { label: "Report It", fullLabel: "Report It", href: "/employee-portals/report-it", icon: FileText, flags: ["showReportItTab", "showReportItDashboardTab"] },
  // Team Performance
  { label: "Team", fullLabel: "Team Performance", href: "/employee-portals/team-performance", icon: Trophy, flags: ["showTeamPerformanceTab"], permission: { resource: "sales", action: "read" } },
  { label: "MRs", fullLabel: "MRs Performance", href: "/employee-portals/med-reps-performance", icon: ChartColumnBig, flags: ["showMedRepsPerformanceTab"], permission: { resource: "sales", action: "read" } },
  { label: "DSMs", fullLabel: "DSMs Performance", href: "/employee-portals/dsms-performance", icon: Users, flags: ["showDsmsPerformanceTab"], permission: { resource: "sales", action: "read" } },
  { label: "Team exp", fullLabel: "Team Expenses", href: "/employee-portals/team-expenses", icon: WalletCards, flags: ["showTeamExpensesTab"], permission: { resource: "expenses", action: "read" } },
  // Team Operations
  { label: "Vacancies", fullLabel: "Vacancies", href: "/employee-portals/vacancies", icon: BriefcaseBusiness, flags: ["showVacanciesTab"], permission: { resource: "vacancies", action: "read" } },
  { label: "Candidates", fullLabel: "My Candidates", href: "/employee-portals/recruitment-candidates", icon: UsersRound, flags: ["showMyCandidatesTab"], permission: { resource: "hiring_interviews", action: "read" } },
  // No `permission`: the page is opened by a share row, not by a grant (src/lib/recruitment/interview-calendar.ts).
  { label: "Interviews", fullLabel: "Interview Calendar", href: "/employee-portals/interview-calendar", icon: CalendarClock, flags: ["showInterviewCalendarTab"] },
  { label: "Probation", fullLabel: "Probation Tracker", href: "/employee-portals/probation", icon: ClipboardCheck, flags: ["showProbationTab"], permission: { resource: "probation", action: "read" } },
  // The Team Coaching Skills Survey (owner, 2026-10-31) — managers only, never the person rated.
  { label: "Survey", fullLabel: "Coaching Skills Survey", href: "/employee-portals/coaching-skills-survey", icon: ListChecks, flags: ["showCoachingSkillsSurveyTab"], permission: { resource: "coaching_skills_survey", action: "read" } },
  { label: "Org", fullLabel: "Organogram", href: "/employee-portals/organogram", icon: Building2, flags: ["showOrganogramTab"], permission: { resource: "organogram", action: "read" } },
  // Expenses
  { label: "My exp", fullLabel: "My Outstation Expenses", href: "/employee-portals/expenses", icon: ReceiptText, flags: ["showMedicalRepExpensesTab"], permission: { resource: "expenses", action: "read" } },
  { label: "Exp dash", fullLabel: "Expense Dashboard", href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, flags: ["showExpenseDashboardTab"], permission: { resource: "expenses", action: "read" } },
  { label: "My claims", fullLabel: "Expense Submissions", href: "/employee-portals/expense-submissions", icon: ReceiptText, flags: ["showExpenseSubmissionsTab"], permission: { resource: "expenses", action: "read" } },
  { label: "Submit exp", fullLabel: "Submit Expense", href: "/employee-portals/submit-expense", icon: Send, flags: ["showExpenseActionTab"], permission: { resource: "outstation", action: "create" } },
  // Support
  { label: "Support", fullLabel: "Request Support", href: "/employee-portals/contact-hr-support", icon: Headphones, flags: ["showSupportTab"], permission: { resource: "support_requests", action: "create" } },
];

/** Fixed anchors of the bottom nav — always present, not user-removable. */
export const HOME_ENTRY: PortalNavEntry = { label: "Home", fullLabel: "Home", href: "/employee-portals", icon: Home, permission: { resource: "employee_profile", action: "read" } };
export const PROFILE_ENTRY: PortalNavEntry = { label: "Profile", fullLabel: "Profile", href: "/employee-portals/profile", icon: User, permission: { resource: "employee_profile", action: "read" } };

/** Max user-pinned shortcuts between Home and Profile in the bottom bar. */
export const MAX_BOTTOM_NAV_CUSTOM = 4;

/**
 * Default priority of middle bottom-nav items when the user hasn't customized.
 *
 * Source of Sales sits high on purpose: this list is filtered by visibility and then truncated to
 * MAX_BOTTOM_NAV_CUSTOM, and before it was added it contained NO sales destination at all — so a
 * District/Regional/National Sales Manager's default mobile bar was plans + planning + marketing +
 * expenses, with nothing from the job they actually do all day. (Sales Analytics sat beside it until
 * the owner retired that module on 2026-09-17; a bar someone saved with it simply drops the link,
 * because the bottom nav keeps only the saved links that are still visible.)
 */
export const DEFAULT_BOTTOM_NAV_HREFS = [
  "/employee-portals/plans",
  "/employee-portals/plans/calendar",
  "/employee-portals/source-of-sales",
  "/employee-portals/report-it",
  "/employee-portals/team-performance",
  "/employee-portals/marketing-requests",
  "/employee-portals/expense-dashboard",
  "/employee-portals/expenses",
  "/employee-portals/incentive",
];

/**
 * The Medical Rep's own default bar: **Phoenix CRM · Incentive · Monthly Closing** (owner,
 * 2026-09-29, in those words).
 *
 * The shared list above is one global priority order, so a rep fell through it to Source of Sales,
 * outstation expenses and Incentive — three slots, and no door to Phoenix CRM, the module that IS
 * his working day. Reordering the shared list to fix that would have moved every other role's tabs
 * too, so the rep gets his own list and nobody else's bar changes.
 *
 * Still filtered by visibility like any other: a rep whose line is not yet open in
 * `phoenix_crm_line_rollout` simply drops the CRM tab.
 */
export const MEDICAL_REP_BOTTOM_NAV_HREFS = [
  "/employee-portals/field-crm",
  "/employee-portals/incentive",
  "/employee-portals/monthly-closing",
];

/**
 * The default middle tabs for THIS viewer, before any pinning — the rep's own list, else the
 * shared one.
 *
 * `showMedicalRepExpensesTab` is the Medical Rep flag (`isMedicalRep`, navigation.ts) and is the
 * only rep-exclusive flag in the visibility bag.
 *
 * Report It is kept only for the roles that had it BEFORE it was opened to everyone on 2026-09-29.
 * It is now visible to every portal role, and it sits fourth in the shared list, so without this
 * it would have displaced a District Manager's Team Performance tab and an NSM's Marketing
 * Requests tab — a change to their phones that nobody asked for. The pharmacovigilance roles keep
 * it exactly where it was; everyone else can still pin it.
 */
export function defaultBottomNavHrefs(visibility: EmployeePortalNavVisibility): string[] {
  if (visibility.showMedicalRepExpensesTab) return MEDICAL_REP_BOTTOM_NAV_HREFS;
  if (visibility.showReportItDashboardTab) return DEFAULT_BOTTOM_NAV_HREFS;
  return DEFAULT_BOTTOM_NAV_HREFS.filter((href) => href !== "/employee-portals/report-it");
}


export function isEntryVisible(entry: PortalNavEntry, visibility: EmployeePortalNavVisibility): boolean {
  if (!entry.flags || entry.flags.length === 0) return true;
  return entry.flags.some((flag) => Boolean(visibility[flag]));
}

/**
 * Registry entries the signed-in role can see, de-duplicated by href.

 */
export function visiblePortalNavEntries(
  visibility: EmployeePortalNavVisibility,
): PortalNavEntry[] {
  const seen = new Set<string>();
  const result: PortalNavEntry[] = [];
  for (const entry of PORTAL_NAV_REGISTRY) {
    if (seen.has(entry.href) || !isEntryVisible(entry, visibility)) continue;
    seen.add(entry.href);
    result.push(entry);
  }
  return result;
}

/**
 * The middle tabs the phone bar shows for someone who has pinned nothing: the role's defaults,
 * visible ones only, capped — what EmployeePortalBottomNav computes inline. A first pin starts from
 * these (togglePinnedHref), so pinning one page never silently strips the bar down to that page.
 */
export function shownDefaultBottomNavHrefs(visibility: EmployeePortalNavVisibility): string[] {
  const visible = new Set(visiblePortalNavEntries(visibility).map((entry) => entry.href));
  return defaultBottomNavHrefs(visibility).filter((href) => visible.has(href)).slice(0, MAX_BOTTOM_NAV_CUSTOM);
}

export function entryByHref(href: string): PortalNavEntry | undefined {
  if (href === HOME_ENTRY.href) return HOME_ENTRY;
  if (href === PROFILE_ENTRY.href) return PROFILE_ENTRY;
  return PORTAL_NAV_REGISTRY.find((entry) => entry.href === href);
}
