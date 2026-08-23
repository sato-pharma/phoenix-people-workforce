"use client";

import { useEffect, useState, useTransition, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NavBadge } from "@/components/layout/sidebar";
import {
  Menu,
  Search,
  CalendarClock,
  Zap,
  LogOut,
  Activity,
  CircleDollarSign,
  ReceiptText,
  Trophy,
  X,
  Users,
  BriefcaseBusiness,
  ClipboardCheck,
  Building2,
  ChartColumnBig,
  FileCheck2,
  FileSignature,
  FilePlus2,
  ClipboardList,
  ShieldCheck,
  Database,
  Settings2,
  Home,
  Send,
  FileText,
  FileSpreadsheet,
  Fingerprint,
  Gift,
  IdCard,
  CalendarDays,
  Headphones,
  HeartPulse,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  WalletCards,
  UserCog,
  UsersRound,
  Inbox,
  Target,
  CalendarRange,
  CalendarCheck2,
  MapPinned,
  Stethoscope,
  Waypoints,
} from "lucide-react";
import { EmployeePortalBottomNav } from "@/components/employee-portal/employee-portal-bottom-nav";
import { SessionSecurityGuard } from "@/components/auth/session-security-guard";
import { OneSignalProvider } from "@/components/notifications/onesignal-provider";
import { logoutOneSignal } from "@/lib/notifications/onesignal-client";
import { InAppNotificationsBell } from "@/components/layout/in-app-notifications-bell";
import { InternalMessagesMenu } from "@/components/layout/internal-messages-menu";
import { RouteTransitionProvider } from "@/components/layout/route-transition-provider";
import { PageTransition } from "@/components/ui/page-transition";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { isEmployeePortalHrefCurated } from "@/lib/employee-portal/module-curation";
import { isEmployeePortalOwnedRoute } from "@/lib/employee-portal/routes";
import { resolveDeepestActiveHref } from "@/lib/navigation/active-path";
import { systemAssets } from "@/config/system-settings";

const EMPLOYEE_SIDEBAR_COLLAPSED_KEY = "phoenix-employee-sidebar-collapsed";
const EMPLOYEE_SIDEBAR_COLLAPSED_EVENT = "phoenix-employee-sidebar-collapsed-change";
const EMPLOYEE_ROUTE_PENDING_EVENT = "phoenix-employee-route-pending";

function subscribeToEmployeeSidebarCollapsed(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT, callback);

  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT, callback);
  };
}

function getEmployeeSidebarCollapsedSnapshot() {
  try {
    return window.localStorage.getItem(EMPLOYEE_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function getEmployeeSidebarCollapsedServerSnapshot() {
  return false;
}

function navItemClass(active: boolean) {
  return active
    ? "bg-[#FFF0E7] text-[#F05A1A] shadow-[0_10px_22px_rgba(240,90,26,0.10)]"
    : "text-[#26334F] hover:bg-[#FFF6F0] hover:text-[#F05A1A]";
}

function navIconClass(active: boolean) {
  return active
    ? "text-[#F05A1A]"
    : "text-[#25314A]/76 group-hover:text-[#F05A1A]";
}

/**
 * Hub roots that must never stay lit on a child route, even when NO deeper sidebar row matches it.
 * Only the portal root qualifies: /employee-portals/profile (and a few other destinations) have no
 * sidebar row of their own, so without this "Command Center" would light up while you sit on them.
 * Every other parent is handled by longest-match below and needs no entry here.
 */
const EXACT_ONLY_PORTAL_HREFS = new Set(["/employee-portals"]);

/**
 * The ONE active sidebar row for a path — the deepest matching href wins.
 *
 * The rule itself lives in src/lib/navigation/active-path.ts (React-free, so the Node test harness
 * can exercise it; this component imports next/navigation at module scope and cannot be imported
 * there). See resolveDeepestActiveHref for why longest-match replaced the old hand-kept list.
 */
function resolveActivePortalHref(pathname: string, sections: readonly EmployeePortalNavSection[]) {
  return resolveDeepestActiveHref(
    pathname,
    sections.flatMap((section) => section.items.map((item) => item.href)),
    EXACT_ONLY_PORTAL_HREFS,
  );
}

type EmployeePortalNavProps = {
  activePathOverride?: string;
  data: EmployeePortalShellData;
  disableSessionGuard?: boolean;
  // Modules Control override for this person, resolved server-side by
  // getEffectiveSidebarModuleIds. null = no override configured — every
  // destination below stays visible, matching pre-curation behavior exactly.
  effectiveModuleIds?: string[] | null;
  visibility: EmployeePortalNavVisibility;
};

type EmployeePortalNavItem = {
  href: string;
  label: string;
  icon: typeof Activity;
  // Live pending-count badge (mirrors the admin sidebar's navBadge) — the Vacation/
  // Excuse/Plan/Direct Orders/Marketing Approvals links plus the residual "Other
  // Approvals" inbox carry one.
  navBadge?:
    | "approvals-hub-pending"
    | "vacation-approvals-pending"
    | "excuse-approvals-pending"
    | "plan-approvals-pending"
    | "direct-orders-needs-action"
    | "marketing-approvals-pending";
};

type EmployeePortalNavSection = {
  hideTitle?: boolean;
  items: EmployeePortalNavItem[];
  title: string;
};

/**
 * Collapsed-rail icon per section. Every title below MUST map to a DISTINCT icon: the collapsed
 * sidebar shows nothing but this strip of icons, so two sections sharing one are indistinguishable.
 * Previously "Approvals Hub"/"Leave Management" both rendered CalendarDays and "Marketing & ROI"/
 * "Team Operations"/"Recruitment & Hiring" all rendered BriefcaseBusiness.
 */
function sectionRailIcon(title: string): typeof Activity {
  if (title === "Training Manager") return ClipboardCheck;
  if (title === "My Workspace") return Home;
  if (title === "Approvals Hub") return FileCheck2;
  if (title === "Sales") return ChartColumnBig;
  if (title === "My Team") return Users;
  if (title === "Field Activity") return MapPinned;
  if (title === "Recruitment & Hiring") return BriefcaseBusiness;
  if (title === "People Management") return UsersRound;
  if (title === "Marketing & ROI") return Target;
  if (title === "Pay & Expenses") return CircleDollarSign;
  if (title === "Pharmacovigilance") return ShieldCheck;
  if (title === "Leave & HR") return CalendarDays;
  return Activity;
}

function buildEmployeePortalSections({
  showDashboardTab = true,
  showExcusesTab = false,
  showExpenseActionTab = false,
  showExpenseDashboardTab = false,
  showFingerprintReportTab = false,
  showIncentiveTab = true,
  showMarketingRequestsTab = false,
  showMarketingInboxTab = false,
  showMarketingAllRequestsTab = false,
  showMarketingCustomerDatabaseTab = false,
  showMarketingControlTab = false,
  showMarketingCoverageReportTab = false,
  showMyPerformanceTab: _showMyPerformanceTab = true,
  showTeamPerformanceTab = false,
  showMedRepsPerformanceTab = false,
  showMedicalRepExpensesTab = false,
  showDoctorCoverageTab = false,
  showDsmsPerformanceTab = false,
  showTeamCalendarTab = false,
  showTeamExpensesTab = false,
  showVacanciesTab = false,
  showMyCandidatesTab = false,
  showProbationTab = false,
  showOrganogramTab = false,
  showPlansTab = false,
  showPlanningCalendarTab = false,
  showSupportTab = false,
  showRecruitmentHiringTab = false,
  showPeopleManagementTab = false,
  showPrivateCalendarTab = false,
  showAccountActivationTab = false,
  showMyVisitsTab = true,
  showDeductionsTab = true,
  showMyCoachingTab = false,
  showTeamCoachingTab = false,
  showTrainingManagerCreateCoachingTab = false,
  showTrainingManagerDashboardTab = false,
  showTrainingManagerFieldCoachingTab = false,
  showReportItTab = false,
  showReportItDashboardTab = false,
  showRoiIntelligenceTab = false,
  showSourceOfSalesTab = false,
  showWeeklyTab = false,
  showMonthlyClosingTab = false,
  showSalesAnalyticsTab = false,
  showSalesVsTargetTab = false,
  showTerritoryDrilldownTab = false,
  showTerritoryManagementTab = false,
  showCrmMasterTab = false,
  showTargetsTab = false,
  showMarketingRoiTrackingTab = false,
  showBusinessReviewTab = false,
  showDoubleVisitAnalyticsTab = false,
  showDoubleVisitReportTab = false,
  showCoachingAnalyticsTab = false,
  showActionsTab = false,
  showDirectOrdersTab = false,
  showVacationApprovalsTab = false,
  showExcuseApprovalsTab = false,
  showPlanApprovalsTab = false,
  showAttendanceTab: _showAttendanceTab = false,
}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {
  return [
    // Training Manager's own section leads the sidebar for TMs. It sits above
    // "My Workspace" here; for every other role this section is empty and is
    // dropped by the items.length filter below, so their order is unchanged.
    {
      title: "Training Manager",
      items: [
        ...(showTrainingManagerDashboardTab ? [{ href: "/employee-portals/training-manager", label: "Overview", icon: Home }] : []),
        ...(showTrainingManagerDashboardTab ? [{ href: "/employee-portals/training-manager/coaching", label: "Coaching Dashboard", icon: ChartColumnBig }] : []),
        ...(showTrainingManagerCreateCoachingTab ? [{ href: "/employee-portals/training-manager/create-coaching-report", label: "Create Coaching Report", icon: FilePlus2 }] : []),
        ...(showTrainingManagerFieldCoachingTab ? [{ href: "/employee-portals/training-manager/field-coaching", label: "Field Coaching", icon: ClipboardCheck }] : []),
      ],
    },
    {
      title: "My Workspace",
      items: [
        ...(showDashboardTab ? [{ href: "/employee-portals", label: "Command Center", icon: Home }] : []),
        // Open to every role, self-scoped (see src/lib/employee-360/access.ts) — same
        // employee_profile:read gate as the rest of "My Workspace", no visibility flag needed.
        { href: "/employee-portals/employee-360", label: "Employee 360", icon: IdCard },
        // Private Calendar — self-scoped to the viewer's own recognized activity. Shown to every
        // portal role as of the 2026-08-01 owner decision (was Talent-Acquisition-only); kept behind
        // the showPrivateCalendarTab flag so Modules Control can still curate it per role/person.
        ...(showPrivateCalendarTab ? [{ href: "/employee-portals/private-calendar", label: "Private Calendar", icon: CalendarDays }] : []),
        // Incentive now lives in the Payroll section; "Other Approvals" now lives in the
        // Approvals Hub section — neither belongs in My Workspace anymore.
        ...(showMyCoachingTab ? [{ href: "/employee-portals/coaching", label: "My Coaching Reports", icon: ClipboardCheck }] : []),
        ...(showPlansTab ? [{ href: "/employee-portals/plans", label: "Weekly / Monthly Plan", icon: CalendarDays }] : []),
        ...(showPlanningCalendarTab ? [{ href: "/employee-portals/plans/calendar", label: "Planning Calendar", icon: CalendarClock }] : []),
      ],
    },
    // Dedicated Approvals Hub section — mirrors the admin shell's own "Approvals Hub" nav
    // section (system-navigation.ts) rather than bundling these links into "My Workspace".
    // "Other Approvals" (residual combined inbox) and the Marketing Requests Inbox also live
    // here now, alongside Vacation/Excuse/Plan Approvals — same visibility flags, new home.
    {
      title: "Approvals Hub",
      items: [
        ...(showVacationApprovalsTab ? [{ href: "/employee-portals/approvals/vacation", label: "Leave Approvals", icon: CalendarDays, navBadge: "vacation-approvals-pending" as const }] : []),
        ...(showExcuseApprovalsTab ? [{ href: "/employee-portals/approvals/excuse", label: "Excuse Approvals", icon: CalendarClock, navBadge: "excuse-approvals-pending" as const }] : []),
        ...(showPlanApprovalsTab ? [{ href: "/employee-portals/approvals/plan", label: "Plan Approvals", icon: CalendarRange, navBadge: "plan-approvals-pending" as const }] : []),
        ...(showMarketingInboxTab ? [{ href: "/employee-portals/marketing-requests/inbox", label: "Marketing Inbox", icon: Inbox, navBadge: "marketing-approvals-pending" as const }] : []),
        ...(showActionsTab ? [{ href: "/employee-portals/approvals-hub", label: "Other Approvals", icon: Inbox, navBadge: "approvals-hub-pending" as const }] : []),
      ],
    },
    // Section order below is daily -> weekly -> occasional -> monthly/self-service. Sales and My
    // Team (the actual job of a field-sales manager) now sit above the personal-admin sections;
    // Payroll used to rank 3rd, above both. Merged sections: "Team Performance" + "Team Operations"
    // -> "My Team" (they meant the same thing, and an RM's Team Performance held a single coaching
    // link), "Payroll" + "Expenses" -> "Pay & Expenses", "Leave Management" + "HR Support" ->
    // "Leave & HR". No item was added or removed by the merge — only regrouped and reordered.
    {
      title: "Sales",
      items: [
        // First in the section on purpose: the owner expects this to be the field force's
        // most-opened dashboard, and it is the only one a Medical Rep can open at all.
        ...(showSalesVsTargetTab ? [{ href: "/employee-portals/sales-vs-target", label: "Sales vs Target", icon: Target }] : []),
        ...(showSourceOfSalesTab ? [{ href: "/employee-portals/source-of-sales", label: "Source of Sales", icon: ChartColumnBig }] : []),
        ...(showWeeklyTab ? [{ href: "/employee-portals/weekly-sales", label: "Weekly Sales", icon: CalendarRange }] : []),
        ...(showMonthlyClosingTab ? [{ href: "/employee-portals/monthly-closing", label: "Monthly Closing", icon: CalendarRange }] : []),
        ...(showSalesAnalyticsTab ? [{ href: "/employee-portals/sales-analytics", label: "Sales Analytics", icon: Activity }] : []),
        ...(showBusinessReviewTab ? [{ href: "/employee-portals/business-review", label: "Business Review", icon: ChartColumnBig }] : []),
        ...(showDoctorCoverageTab ? [{ href: "/employee-portals/doctor-coverage", label: "Doctor Coverage", icon: Stethoscope }] : []),
        ...(showTerritoryDrilldownTab ? [{ href: "/employee-portals/territory-drilldown", label: "Sales Drilldown", icon: MapPinned }] : []),
        // Territory Management (brick allocation + rep-residence map) — a DIFFERENT module from the
        // Drilldown above. The page and its API routes already existed and were scope-guarded, but
        // no sidebar entry was ever added, so DM/RM/NSM could only reach it by typing the URL.
        ...(showTerritoryManagementTab ? [{ href: "/employee-portals/territory-management", label: "Territory Management", icon: Waypoints }] : []),
        // Read-only Targets. /sales/targets keeps the authoring tools and bounces portal roles away,
        // so without this twin a DM/RM/NSM had no targets surface at all.
        ...(showTargetsTab ? [{ href: "/employee-portals/targets", label: "Targets", icon: Target }] : []),
        ...(showDirectOrdersTab ? [{ href: "/employee-portals/direct-orders", label: "Direct Orders", icon: ReceiptText }] : []),
      ],
    },
    // Merged from the old "Team Performance" + "Team Operations": performance views first, then
    // the people-ops views (open seat -> candidate -> probation -> where they sit in the org).
    {
      title: "My Team",
      items: [
        ...(showTeamPerformanceTab ? [{ href: "/employee-portals/team-performance", label: "Team Performance", icon: Trophy }] : []),
        ...(showMedRepsPerformanceTab ? [{ href: "/employee-portals/med-reps-performance", label: "MRs Performance", icon: ChartColumnBig }] : []),
        ...(showDsmsPerformanceTab ? [{ href: "/employee-portals/dsms-performance", label: "DSMs Performance", icon: Users }] : []),
        ...(showTeamCoachingTab ? [{ href: "/employee-portals/coaching", label: "Team Coaching Reports", icon: ClipboardCheck }] : []),
        ...(showVacanciesTab ? [{ href: "/employee-portals/vacancies", label: "Vacancies", icon: BriefcaseBusiness }] : []),
        // Sits next to Vacancies on purpose: open seat -> assigned candidate -> probation is one
        // lifecycle, and this page only ever shows candidates for THIS manager's own open seats.
        ...(showMyCandidatesTab ? [{ href: "/employee-portals/recruitment-candidates", label: "My Candidates", icon: UsersRound }] : []),
        ...(showProbationTab ? [{ href: "/employee-portals/probation", label: "Probation Tracker", icon: ClipboardCheck }] : []),
        ...(showOrganogramTab ? [{ href: "/employee-portals/organogram", label: "Organogram", icon: Building2 }] : []),
        ...(showTeamExpensesTab ? [{ href: "/employee-portals/team-expenses", label: "Team Expenses", icon: WalletCards }] : []),
      ],
    },
    {
      title: "Field Activity",
      items: [
        // Every employee-portal role sees their own CRM visits except Talent Acquisition
        // (owner-requested exclusion — she is HR/office staff, not a field employee).
        ...(showMyVisitsTab ? [{ href: "/employee-portals/visits", label: "My Visits", icon: MapPinned }] : []),
        // Full scoped CRM Master — self for a Medical Rep, the team's rows for DSM/RM/NSM. My Visits
        // above stays: it is the always-on self view every portal role keeps.
        ...(showCrmMasterTab ? [{ href: "/employee-portals/crm", label: "CRM", icon: Database }] : []),
        ...(showDoubleVisitAnalyticsTab ? [{ href: "/employee-portals/double-visit-analytics", label: "Double-Visit Analytics", icon: Activity }] : []),
        ...(showDoubleVisitReportTab ? [{ href: "/employee-portals/dv-planner", label: "DV Planner", icon: CalendarCheck2 }] : []),
        ...(showDoubleVisitReportTab ? [{ href: "/employee-portals/double-visit-report", label: "Double Visit Report", icon: FileSpreadsheet }] : []),
        ...(showCoachingAnalyticsTab ? [{ href: "/employee-portals/coaching-analytics", label: "Coaching Analytics", icon: ChartColumnBig }] : []),
        ...(showTeamCalendarTab ? [{ href: "/employee-portals/team-calendar", label: "Team Calendar", icon: CalendarRange }] : []),
      ],
    },
    {
      title: "Marketing & ROI",
      items: [
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests/validation", label: "Customer Validation", icon: ShieldCheck }] : []),
        ...(showMarketingRequestsTab ? [{ href: "/employee-portals/marketing-requests", label: "Marketing Requests", icon: Send }] : []),
        ...(showMarketingControlTab ? [{ href: "/employee-portals/marketing-requests/control", label: "Marketing Control", icon: Settings2 }] : []),
        // Company-wide register — every request and where it is stopped. Sits beside the personal
        // workspace above, which deliberately shows an oversight role only its OWN requests.
        ...(showMarketingAllRequestsTab ? [{ href: "/employee-portals/marketing-requests/all", label: "All Marketing Requests", icon: ClipboardList }] : []),
        ...(showMarketingCustomerDatabaseTab ? [{ href: "/employee-portals/marketing-requests/customer-database", label: "Customer Database", icon: Database }] : []),
        ...(showMarketingCoverageReportTab ? [{ href: "/employee-portals/marketing-requests/coverage-report", label: "Coverage Report", icon: MapPinned }] : []),
        ...(showRoiIntelligenceTab ? [{ href: "/employee-portals/roi", label: "ROI Dashboard", icon: Target }] : []),
        // ROI Tracker — the marketing-ROI source of truth (portal twin of /admin/marketing-roi-tracker,
        // its own URL by owner rule 2026-07-28). showMarketingRoiTrackingTab was computed in
        // navigation.ts but never rendered here, so this page had no sidebar link at all. Distinct
        // from "ROI Dashboard" above, which is the Sales-Marketing-Intelligence module.
        ...(showMarketingRoiTrackingTab ? [{ href: "/employee-portals/roi-tracker", label: "ROI Tracker", icon: Target }] : []),
      ],
    },
    // Talent Acquisition's portal mirror of the admin-shell hrAuthorityNavigationRoles
    // tools (see app/employee-portals/{recruitment,cv-database,hiring-documents,
    // intake-health,vacation-control,support-requests}/page.tsx). Empty — and dropped by the
    // items.length filter below — for every other role. HR Support Requests lives in the
    // "HR Support" section below, alongside Request Support.
    //
    // This list must cover every tool on the admin hub (recruitmentHiringPageItems),
    // because the hub itself is unreachable for this role: app/(admin)/layout.tsx
    // redirects portal-mode users out of the entire admin group. A tool added there
    // and not here is invisible to the only role that works it —
    // tests/recruitment-hub-portal-coverage.test.ts fails when the two drift.
    {
      title: "Recruitment & Hiring",
      items: [
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/recruitment", label: "Recruitment", icon: BriefcaseBusiness }] : []),
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/cv-database", label: "CV Database", icon: FileSpreadsheet }] : []),
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/hiring-documents", label: "Hiring Documents", icon: FileCheck2 }] : []),
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/hiring-pack", label: "Contract & Form 1", icon: FileSignature }] : []),
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/intake-health", label: "Inbound Intake Health", icon: HeartPulse }] : []),
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/contact-review", label: "Missing Contact Details", icon: IdCard }] : []),
      ],
    },
    // Talent Acquisition's company-wide HR tooling, separate from the recruiting-pipeline
    // tools above (see app/employee-portals/{employees,contracts,resignations}/page.tsx).
    // Vacancies Report reuses the existing /employee-portals/vacancies page — the
    // company-wide branch of getEmployeePortalVacancies now covers her (see
    // canAccessCompanyVacancies in src/lib/reports/organogram.ts).
    {
      title: "People Management",
      items: [
        ...(showPeopleManagementTab ? [{ href: "/employee-portals/employees", label: "Employees", icon: UsersRound }] : []),
        ...(showPeopleManagementTab ? [{ href: "/employee-portals/contracts", label: "Contract Renewal", icon: CalendarClock }] : []),
        ...(showPeopleManagementTab ? [{ href: "/employee-portals/resignations", label: "Resignations", icon: FileSpreadsheet }] : []),
        ...(showPeopleManagementTab ? [{ href: "/employee-portals/vacancies", label: "Vacancies Report", icon: BriefcaseBusiness }] : []),
        ...(showAccountActivationTab ? [{ href: "/employee-portals/account-activation", label: "Account Activation", icon: UserCog }] : []),
      ],
    },
    // Merged from the old "Payroll" + "Expenses": what I am paid and what I claim back, in one
    // place, below the team/sales work instead of interleaved with it.
    {
      title: "Pay & Expenses",
      items: [
        ...(showIncentiveTab ? [{ href: "/employee-portals/incentive", label: "Incentive", icon: Gift }] : []),
        { href: "/employee-portals/payslips", label: "Payslips", icon: FileText },
        ...(showDeductionsTab ? [{ href: "/employee-portals/deductions", label: "Deductions", icon: ReceiptText }] : []),
        ...(showMedicalRepExpensesTab ? [{ href: "/employee-portals/expenses", label: "My Outstation Expenses", icon: ReceiptText }] : []),
        ...(showExpenseDashboardTab ? [{ href: "/employee-portals/expense-dashboard", label: "Expense Dashboard", icon: CircleDollarSign }] : []),
        // Shares showExpenseDashboardTab deliberately: anyone allowed to see expense figures is by
        // definition allowed to see his OWN submissions, and a second flag would be one more place
        // for the two to drift apart.
        ...(showExpenseDashboardTab ? [{ href: "/employee-portals/expense-submissions", label: "Expense Submissions", icon: ReceiptText }] : []),
        ...(showExpenseActionTab ? [{ href: "/employee-portals/submit-expense", label: "Submit Expense", icon: Send }] : []),
      ],
    },
    {
      title: "Pharmacovigilance",
      items: [
        ...(showReportItDashboardTab
          ? [{ href: "/employee-portals/report-it", label: "Report It", icon: FileText }]
          : []),
      ],
    },
    // Merged from the old "Leave Management" + "HR Support" — time off, attendance and reaching HR
    // are one errand-shaped group, and "HR Support" was a one-item section for most roles.
    {
      title: "Leave & HR",
      items: [
        { href: "/employee-portals/vacation-request", label: "Vacation Request", icon: CalendarDays },
        { href: "/employee-portals/vacation-report", label: "Vacation Report", icon: FileText },
        ...(showExcusesTab ? [{ href: "/employee-portals/excuses", label: "Excuses", icon: CalendarClock }] : []),
        ...(showFingerprintReportTab ? [{ href: "/employee-portals/fingerprint-analytics", label: "Attendance Analytics", icon: Fingerprint }] : []),
        ...(showReportItTab ? [{ href: "/employee-portals/report-it", label: "Report It", icon: FileText }] : []),
        ...(showSupportTab ? [{ href: "/employee-portals/contact-hr-support", label: "Request Support", icon: Headphones }] : []),
        ...(showRecruitmentHiringTab ? [{ href: "/employee-portals/support-requests", label: "HR Support Requests", icon: Headphones }] : []),
      ],
    },
  ].filter((section) => section.items.length > 0);
}

/**
 * Applies an admin-configured Modules Control curation on top of the role-driven
 * sections above. `effectiveModuleIds` null (the common case — no override
 * configured) is a no-op; this only trims items when an admin has explicitly
 * restricted this person's/role's/line's employee-portal sidebar.
 */
function applyModuleCuration(
  sections: EmployeePortalNavSection[],
  effectiveModuleIds: string[] | null | undefined,
): EmployeePortalNavSection[] {
  if (!effectiveModuleIds) return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => isEmployeePortalHrefCurated(item.href, effectiveModuleIds)),
    }))
    .filter((section) => section.items.length > 0);
}

function dispatchEmployeePortalRoutePending(href: string) {
  window.dispatchEvent(new CustomEvent(EMPLOYEE_ROUTE_PENDING_EVENT, { detail: { href } }));
}

function shouldUseClientNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.currentTarget.target &&
    isEmployeePortalOwnedRoute(href)
  );
}

function EmployeePortalRouteProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let fallbackTimeout: number | null = null;
    const handlePending = () => {
      setVisible(true);
      if (fallbackTimeout) {
        window.clearTimeout(fallbackTimeout);
      }
      fallbackTimeout = window.setTimeout(() => setVisible(false), 6000);
    };

    window.addEventListener(EMPLOYEE_ROUTE_PENDING_EVENT, handlePending);

    return () => {
      window.removeEventListener(EMPLOYEE_ROUTE_PENDING_EVENT, handlePending);
      if (fallbackTimeout) {
        window.clearTimeout(fallbackTimeout);
      }
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), 180);
    return () => window.clearTimeout(timeout);
  }, [pathname]);

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-x-0 top-0 z-[70] h-[3px] origin-left bg-gradient-to-r from-orange-500 via-amber-400 to-sky-500 shadow-[0_0_18px_rgba(249,115,22,0.45)] transition duration-300 ${
        visible ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0"
      }`}
    />
  );
}

function EmployeePortalMenu({
  mode,
  onNavigate,
  pathname,
  sections,
}: {
  mode: "desktop" | "mobile";
  onNavigate?: () => void;
  pathname: string;
  sections: EmployeePortalNavSection[];
}) {
  const isMobile = mode === "mobile";
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // Resolved once for the whole menu, not per row: only the deepest matching href is active.
  const activeHref = resolveActivePortalHref(pathname, sections);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setPendingHref(null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [pathname]);

  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!shouldUseClientNavigation(event, href)) {
      onNavigate?.();
      return;
    }

    const hrefPath = href.split("#")[0];
    if (hrefPath === pathname) {
      onNavigate?.();
      return;
    }

    event.preventDefault();
    setPendingHref(href);
    dispatchEmployeePortalRoutePending(href);
    onNavigate?.();
    startTransition(() => router.push(href));
  };

  return (
    <>
      {sections.map((section, sectionIndex) => (
        <div
          key={section.title}
          className={
            sectionIndex < sections.length - 1
              ? isMobile
                ? "border-b border-orange-100/70 pb-4"
                : "border-b border-[#E9EDF5] pb-3"
              : undefined
          }
        >
          {section.hideTitle ? null : (
            <div className={`${isMobile ? "mb-2" : "mb-1.5"} flex items-center justify-between px-3 pt-1`}>
              <p
                className={
                  isMobile
                    ? "text-[10px] font-black uppercase tracking-[0.16em] text-[#1D2B42]"
                    : "text-[9px] font-black uppercase tracking-[0.18em] text-[#344073]"
                }
              >
                {section.title}
              </p>
              <ChevronDown className={`${isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} text-[#F05A1A]`} />
            </div>
          )}
          <div className={isMobile ? "space-y-1" : "space-y-0.5"}>
            {section.items.map((item) => {
              const active = item.href.split("#")[0] === activeHref;
              const pending = isPending && pendingHref === item.href;
              return (
                <Link
                  aria-busy={pending || undefined}
                  aria-current={active ? "page" : undefined}
                  key={item.label}
                  className={`group flex items-center gap-3 rounded px-4 py-2.5 ${
                    isMobile ? "text-[13px] font-semibold duration-200" : "text-[12px] font-bold duration-150"
                  } transition ${pending ? "bg-[#FFF7ED] text-[#EA580C] ring-1 ring-orange-200/80" : navItemClass(active)}`}
                  href={item.href}
                  onClick={(event) => handleNavigate(event, item.href)}
                  prefetch
                >
                  <item.icon
                    className={`${
                      isMobile ? "h-4 w-4" : "h-[15px] w-[15px] stroke-[2.1]"
                    } shrink-0 transition ${pending ? "text-[#EA580C]" : navIconClass(active)}`}
                  />
                  <span>{item.label}</span>
                  {item.navBadge === "approvals-hub-pending" ? <NavBadge src="/api/approvals-hub/pending-count" /> : null}
                  {item.navBadge === "vacation-approvals-pending" ? <NavBadge src="/api/approvals/vacation/pending-count" /> : null}
                  {item.navBadge === "excuse-approvals-pending" ? <NavBadge src="/api/approvals/excuse/pending-count" /> : null}
                  {item.navBadge === "plan-approvals-pending" ? <NavBadge src="/api/approvals/plan/pending-count" /> : null}
                  {item.navBadge === "direct-orders-needs-action" ? <NavBadge src="/api/direct-orders/needs-action-count" /> : null}
                  {item.navBadge === "marketing-approvals-pending" ? <NavBadge src="/api/marketing-requests/pending-count" /> : null}
                  {pending ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-orange-500 employee-portal-nav-pending-dot" /> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

export function EmployeePortalTopNav({
  activePathOverride,
  data,
  disableSessionGuard = false,
  effectiveModuleIds,
  visibility,
}: EmployeePortalNavProps) {
  const currentPathname = usePathname();
  const router = useRouter();
  const pathname = activePathOverride ?? currentPathname;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const closeMobileMenu = () => setMobileMenuOpen(false);

  const employeeName = data.employee.fullName.trim();
  const firstName = employeeName.split(/\s+/)[0] || "Employee";

  const menuSections = applyModuleCuration(buildEmployeePortalSections(visibility), effectiveModuleIds);
  const searchTerm = searchQuery.trim().toLowerCase();
  const searchMatches = searchTerm
    ? menuSections
      .flatMap((section) =>
        section.items.map((item) => ({
          ...item,
          section: section.title,
        })),
      )
      .filter((item) =>
        `${item.label} ${item.section}`.toLowerCase().includes(searchTerm),
      )
      .slice(0, 6)
    : [];

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  const handleLogout = async () => {
    // Unbind this browser from the signed-out user's OneSignal identity first — best
    // effort, never blocks sign-out — so a shared device doesn't keep receiving their
    // pushes after someone else signs in.
    logoutOneSignal();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  const navigateToSearchResult = (href: string) => {
    setSearchQuery("");
    setSearchOpen(false);
    dispatchEmployeePortalRoutePending(href);
    router.push(href);
  };

  return (
    <>
      {disableSessionGuard ? null : <SessionSecurityGuard />}
      <OneSignalProvider />
      <header className="fixed inset-x-0 top-0 z-30 w-full border-b border-slate-200/80 bg-white/96 shadow-[0_12px_34px_rgba(15,23,42,0.10)] backdrop-blur-2xl">
        <div className="mx-auto flex h-[56px] w-full max-w-[1560px] items-center gap-1.5 px-2 sm:gap-2.5 sm:px-4 lg:h-[64px] lg:px-8">
          <button
            aria-label="Menu"
            aria-controls="employee-portal-mobile-sidebar"
            aria-expanded={mobileMenuOpen}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded border border-orange-200 bg-orange-50 text-orange-700 shadow-[0_6px_16px_rgba(249,115,22,0.10)] transition hover:border-orange-300 hover:bg-orange-100 focus:outline-none focus:ring-2 focus:ring-orange-500/20 lg:hidden"
            onClick={() => setMobileMenuOpen((open) => !open)}
            type="button"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-center lg:flex-none">
            <div className="min-w-0">
              <p className="text-[8px] font-black uppercase tracking-[0.22em] text-orange-600 sm:text-[9px] sm:tracking-[0.26em]">Employee Portal</p>
              <p className="whitespace-nowrap text-[10px] font-bold text-slate-500 sm:text-[11px]">{data.employee.roleLabel}</p>
            </div>
          </div>

          <div className="relative ml-auto hidden w-full max-w-sm items-center md:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-slate-400" />
            <input
              aria-label="Search"
              className="h-10 w-full rounded-sm border border-slate-200 bg-slate-50/90 pl-9 pr-3 text-sm font-semibold text-slate-700 shadow-inner placeholder:text-slate-400 outline-none transition focus:border-orange-300 focus:bg-white focus:ring-2 focus:ring-orange-400/15"
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchOpen(false);
                  return;
                }
                if (event.key === "Enter" && searchMatches[0]) {
                  event.preventDefault();
                  navigateToSearchResult(searchMatches[0].href);
                }
              }}
              placeholder="Search portal pages..."
              value={searchQuery}
              type="text"
            />
            {searchOpen && searchQuery.trim().length > 0 ? (
              <div
                className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.16)]"
                role="listbox"
              >
                {searchMatches.length > 0 ? (
                  searchMatches.map((item) => (
                    <button
                      aria-selected={false}
                      className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-orange-50"
                      key={`${item.section}-${item.href}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        navigateToSearchResult(item.href);
                      }}
                      role="option"
                      type="button"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-orange-500" />
                      <span className="min-w-0">
                        <span className="block whitespace-nowrap text-sm font-bold text-slate-800">{item.label}</span>
                        <span className="block whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{item.section}</span>
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-3 text-sm font-semibold text-slate-500">
                    No matching portal pages.
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <InAppNotificationsBell isAdminMode={false} />
          <InternalMessagesMenu isAdminMode={false} />
          <div className="hidden items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 lg:flex">
            <CalendarClock className="h-3 w-3 text-slate-400" />
            <span className="whitespace-nowrap">
              {new Date().toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "Africa/Cairo", year: "numeric" })}
            </span>
          </div>
          {visibility.showMyPerformanceTab === false ? null : (
            <div className="hidden items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-[11px] font-bold text-orange-700 lg:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500 ep-pulse-orange" />
              <Zap className="h-3 w-3" />
              <span className="whitespace-nowrap">Live Performance</span>
            </div>
          )}
          <div className="relative flex shrink-0">
            <button
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
            className="flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-1.5 py-1 shadow-[0_8px_20px_rgba(15,23,42,0.06)] transition hover:border-orange-200 hover:bg-orange-50/70 sm:px-2"
              onClick={() => setUserMenuOpen((open) => !open)}
              type="button"
            >
              <Image alt="Phoenix" className="h-7 w-7 shrink-0 rounded object-contain" height={28} src={systemAssets.iconLogo} width={28} />
              <div className="hidden pr-0.5 text-left sm:block">
                <p className="text-xs font-semibold text-slate-800 whitespace-nowrap">{firstName}</p>
              </div>
              <ChevronDown className="hidden h-3 w-3 text-slate-400 sm:block" />
            </button>

            {userMenuOpen ? (
              <div
                className="absolute right-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded border border-slate-200 bg-white shadow-lg"
                role="menu"
              >
                <div className="border-b border-slate-100 px-3.5 py-2.5">
                  <p className="text-sm font-black text-slate-900">{data.employee.fullName}</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">{data.employee.roleLabel}</p>
                  <p className="mt-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.10em] text-orange-600">
                    {data.employee.hrId}
                  </p>
                </div>
                <Link
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-orange-50 hover:text-orange-700"
                  href="/employee-portals/profile"
                  onClick={() => setUserMenuOpen(false)}
                  role="menuitem"
                >
                  <UserCog className="h-4 w-4" />
                  My Profile
                </Link>
                <div className="mx-3 h-px bg-slate-100" />
                <button
                  className="flex w-full items-center gap-2 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-orange-50 hover:text-orange-700"
                  onClick={() => {
                    setUserMenuOpen(false);
                    void handleLogout();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <LogOut className="h-4 w-4" />
                  Log Out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* Mobile Sidebar Overlay */}
      <button
        aria-label="Close menu"
        className={`fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-200 lg:hidden ${
          mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={closeMobileMenu}
        type="button"
      />

      {/* Mobile Sidebar Content */}
      <div
        aria-hidden={!mobileMenuOpen}
        className="fixed inset-y-0 left-0 z-50 flex h-dvh max-h-dvh w-[min(88vw,320px)] flex-col border-r border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-in-out will-change-transform lg:hidden"
        id="employee-portal-mobile-sidebar"
        style={{ transform: mobileMenuOpen ? "translate3d(0, 0, 0)" : "translate3d(-100%, 0, 0)" }}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-4">
          <button
            aria-label="Close menu"
            className="flex h-8 w-8 items-center justify-center rounded border border-slate-100 text-slate-400 hover:text-slate-600"
            onClick={closeMobileMenu}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="phoenix-employee-sidebar-scroll flex-1 space-y-4 overflow-y-auto px-4 pb-4 pt-1">
          <EmployeePortalMenu mode="mobile" onNavigate={closeMobileMenu} pathname={pathname} sections={menuSections} />

          <div className="pt-3 mt-3 border-t border-slate-100">
            <button
              className="flex w-full items-center gap-3 rounded px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
              onClick={() => {
                closeMobileMenu();
                void handleLogout();
              }}
              type="button"
            >
              <LogOut className="h-4 w-4" />
              <span>Log Out</span>
            </button>
          </div>
        </nav>

        <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3">
          <div className="rounded border border-orange-100 bg-orange-50 p-3 shadow-[0_8px_20px_rgba(249,115,22,0.08)]">
            <div className="flex items-center gap-3">
              <Image alt="Phoenix" className="h-8 w-8 shrink-0 rounded object-cover" height={32} src={systemAssets.adminRailMark} width={32} />
              <div>
                <p className="text-sm font-semibold text-slate-900">{data.employee.fullName}</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-600">{data.employee.roleLabel}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function EmployeePortalSidebar({
  activePathOverride,
  effectiveModuleIds,
  visibility,
}: {
  activePathOverride?: string;
  effectiveModuleIds?: string[] | null;
  visibility: EmployeePortalNavVisibility;
}) {
  const currentPathname = usePathname();
  const pathname = activePathOverride ?? currentPathname;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const persistedCollapsed = useSyncExternalStore(
    subscribeToEmployeeSidebarCollapsed,
    getEmployeeSidebarCollapsedSnapshot,
    getEmployeeSidebarCollapsedServerSnapshot,
  );
  const [fallbackCollapsed, setFallbackCollapsed] = useState<boolean | null>(null);
  const collapsed = fallbackCollapsed ?? persistedCollapsed;

  const sections = applyModuleCuration(buildEmployeePortalSections(visibility), effectiveModuleIds);
  const shellActiveHref = resolveActivePortalHref(pathname, sections);
  const activeSectionTitle = sections.find((section) =>
    section.items.some((item) => item.href.split("#")[0] === shellActiveHref),
  )?.title;

  const toggleCollapsed = () => {
    const nextCollapsed = !collapsed;
    setFallbackCollapsed(nextCollapsed);

    try {
      window.localStorage.setItem(EMPLOYEE_SIDEBAR_COLLAPSED_KEY, String(nextCollapsed));
    } catch {
      return;
    }

    window.dispatchEvent(new Event(EMPLOYEE_SIDEBAR_COLLAPSED_EVENT));
  };

  const handleLogout = async () => {
    // Unbind this browser from the signed-out user's OneSignal identity first — best
    // effort, never blocks sign-out — so a shared device doesn't keep receiving their
    // pushes after someone else signs in.
    logoutOneSignal();
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };

  const handleRailNavigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!shouldUseClientNavigation(event, href)) return;

    const hrefPath = href.split("#")[0];
    if (hrefPath === pathname) return;

    event.preventDefault();
    dispatchEmployeePortalRoutePending(href);
    startTransition(() => router.push(href));
  };

  return (
    <aside className={`hidden shrink-0 self-start transition-[width] duration-200 lg:block ${collapsed ? "w-[78px]" : "w-[324px]"}`}>
      <div className="sticky top-[78px] flex max-h-[calc(100vh-104px)] w-full overflow-hidden rounded-sm border border-slate-200/90 bg-white/96 shadow-[0_24px_70px_rgba(15,23,42,0.14)] ring-1 ring-white/80 backdrop-blur">
        <div className={`${collapsed ? "w-full" : "w-[58px]"} shrink-0 bg-[#101a31]`}>
          <div className="flex h-full min-h-0 flex-col items-center py-4">
            <button
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex h-9 w-9 items-center justify-center rounded text-white/82 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/35"
              onClick={toggleCollapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              type="button"
            >
              {collapsed ? <ChevronsRight className="h-[17px] w-[17px]" /> : <ChartColumnBig className="h-[17px] w-[17px]" />}
            </button>
            <nav className="phoenix-employee-sidebar-scroll mt-5 flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pb-3">
              {sections.map((section) => {
                const Icon = sectionRailIcon(section.title);
                const active = section.title === activeSectionTitle;
                const firstItem = section.items[0];
                return (
                  <Link
                    aria-label={section.title}
                    className={`relative flex h-10 w-[52px] items-center justify-center rounded transition ${
                      active ? "bg-white/10 text-white" : "text-white/58 hover:bg-white/8 hover:text-white"
                    }`}
                    href={firstItem.href}
                    key={section.title}
                    onClick={(event) => handleRailNavigate(event, firstItem.href)}
                    prefetch
                    title={section.title}
                  >
                    {active ? <span className="absolute left-[-8px] h-7 w-[3px] rounded-r-sm bg-[#F05A1A]" /> : null}
                    <Icon className="h-[16px] w-[16px]" />
                  </Link>
                );
              })}
            </nav>
            {collapsed ? (
              <button
                aria-label="Log out"
                className="mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded text-white/64 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/35"
                onClick={handleLogout}
                title="Log out"
                type="button"
              >
                <LogOut className="h-[16px] w-[16px]" />
              </button>
            ) : null}
          </div>
        </div>

        <div className={`${collapsed ? "hidden" : "flex"} min-h-0 flex-1 flex-col bg-[linear-gradient(180deg,#ffffff_0%,#fbfcff_100%)] px-4 py-5`}>
          <div className="mb-4 flex items-start justify-between pl-1 pr-0">
            <div className="flex items-center gap-2.5">
              <Image
                alt="Phoenix Workforce logo"
                className="h-8 w-8 rounded-sm border border-orange-100 bg-orange-50 object-contain p-1 shadow-[0_8px_18px_rgba(249,115,22,0.12)]"
                height={32}
                priority
                src="/brand/phoenix-bird-icon.png"
                width={32}
              />
              <div>
                <div className="text-[11px] font-black leading-none tracking-[0.30em] text-[#25314A]">
                  PHOENIX
                </div>
                <div className="mt-1 text-[8px] font-black leading-none tracking-[0.34em] text-[#F05A1A]">
                  WORKFORCE
                </div>
              </div>
            </div>
            <button
              aria-label="Collapse sidebar"
              className="flex h-7 w-7 items-center justify-center rounded-sm bg-slate-100 text-[#293268] transition hover:bg-orange-50 hover:text-orange-700"
              onClick={toggleCollapsed}
              type="button"
            >
              <ChevronsLeft className="h-3 w-3" />
            </button>
          </div>

          <nav className="phoenix-employee-sidebar-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <EmployeePortalMenu mode="desktop" pathname={pathname} sections={sections} />
          </nav>

          <div className="mt-4 shrink-0 border-t border-[#E9EDF5] pt-3">
            <button
              className="flex w-full items-center gap-3 rounded bg-[#FFF2EE] px-4 py-2.5 text-[12px] font-black text-[#F05A1A] transition hover:bg-[#FFE8DD]"
              onClick={handleLogout}
              type="button"
            >
              <LogOut className="h-[15px] w-[15px] shrink-0" />
              <span>Log Out</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function EmployeePortalChrome({
  activePathOverride,
  children,
  data,
  disableSessionGuard = false,
  effectiveModuleIds,
  visibility,
}: {
  activePathOverride?: string;
  children: ReactNode;
  data: EmployeePortalShellData;
  disableSessionGuard?: boolean;
  effectiveModuleIds?: string[] | null;
  visibility: EmployeePortalNavVisibility;
}) {
  return (
    <RouteTransitionProvider>
      <div className="employee-portal-shell relative min-h-screen overflow-x-hidden bg-[linear-gradient(160deg,#f4f8fc_0%,#f8fafc_28%,#fdf8f5_58%,#f6faf8_82%,#f8fafc_100%)] pt-[56px] lg:pt-[64px]">
        <EmployeePortalRouteProgress />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.035)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.52),transparent_58%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0)_72%)]" />
        <EmployeePortalTopNav
          activePathOverride={activePathOverride}
          data={data}
          disableSessionGuard={disableSessionGuard}
          effectiveModuleIds={effectiveModuleIds}
          visibility={visibility}
        />
        <div className="relative mx-auto flex w-full max-w-[1580px] items-start gap-4 px-3 py-4 sm:px-4 sm:py-5 lg:gap-7 lg:px-8 lg:py-7">
          <EmployeePortalSidebar activePathOverride={activePathOverride} effectiveModuleIds={effectiveModuleIds} visibility={visibility} />
          <main className="employee-portal-mobile-safe min-w-0 flex-1 space-y-5 pb-24 lg:space-y-7 lg:pb-0">
            <PageTransition>{children}</PageTransition>
          </main>
        </div>
        <EmployeePortalBottomNav activePathOverride={activePathOverride} effectiveModuleIds={effectiveModuleIds} visibility={visibility} />
      </div>
    </RouteTransitionProvider>
  );
}
