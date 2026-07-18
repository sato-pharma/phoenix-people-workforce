import {
  Activity,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarCheck2,
  CalendarDays,
  CalendarRange,
  ChartColumnBig,
  CircleDollarSign,
  ClipboardCheck,
  Database,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Fingerprint,
  Gift,
  Headphones,
  Home,
  Inbox,
  type LucideIcon,
  MapPinned,
  ReceiptText,
  Send,
  Settings2,
  ShieldCheck,
  Target,
  Trophy,
  User,
  Users,
  WalletCards,
} from "lucide-react";

import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { isEmployeePortalHrefCurated } from "@/lib/employee-portal/module-curation";

export type PortalNavEntry = {
  /** Short label for the compact bottom-nav tab. */
  label: string;
  /** Descriptive label for the profile quick-navigation grid. */
  fullLabel: string;
  href: string;
  icon: LucideIcon;
  /** Visible if ANY listed flag is truthy. Omitted/empty = always visible. */
  flags?: (keyof EmployeePortalNavVisibility)[];
};

/**
 * Single source of truth for the employee-portal destinations surfaced in the
 * mobile bottom nav and the profile quick-navigation grid. Hrefs/flags mirror
 * buildEmployeePortalSections in employee-portal-layout.tsx (the sidebar); the
 * employee-portal bottom-nav guard test keeps the two in sync.
 */
export const PORTAL_NAV_REGISTRY: PortalNavEntry[] = [
  // My Workspace
  { label: "Incentive", fullLabel: "Incentive", href: "/employee-portals/incentive", icon: Gift, flags: ["showIncentiveTab"] },
  { label: "Coaching", fullLabel: "Coaching Reports", href: "/employee-portals/coaching", icon: ClipboardCheck, flags: ["showMyCoachingTab", "showTeamCoachingTab"] },
  { label: "Plans", fullLabel: "Weekly / Monthly Plan", href: "/employee-portals/plans", icon: CalendarDays, flags: ["showPlansTab"] },
  { label: "Planning", fullLabel: "Planning Calendar", href: "/employee-portals/plans/calendar", icon: CalendarClock, flags: ["showPlansTab"] },
  { label: "Vacation", fullLabel: "Vacation Approvals", href: "/employee-portals/approvals/vacation", icon: CalendarDays, flags: ["showVacationApprovalsTab"] },
  { label: "Excuses", fullLabel: "Excuse Approvals", href: "/employee-portals/approvals/excuse", icon: CalendarClock, flags: ["showExcuseApprovalsTab"] },
  { label: "Plan Appr", fullLabel: "Plan Approvals", href: "/employee-portals/approvals/plan", icon: CalendarRange, flags: ["showPlanApprovalsTab"] },
  { label: "Approvals", fullLabel: "Other Approvals", href: "/employee-portals/approvals-hub", icon: Inbox, flags: ["showActionsTab"] },
  { label: "Payslips", fullLabel: "Payslips", href: "/employee-portals/payslips", icon: FileText },
  { label: "Deductions", fullLabel: "Deductions", href: "/employee-portals/deductions", icon: ReceiptText },
  { label: "Analytics", fullLabel: "Attendance Analytics", href: "/employee-portals/fingerprint-analytics", icon: Fingerprint, flags: ["showFingerprintReportTab"] },
  // Sales Intelligence (Product / Group Product Managers)
  { label: "ROI", fullLabel: "ROI Intelligence", href: "/employee-portals/roi", icon: Target, flags: ["showRoiIntelligenceTab"] },
  { label: "SoS", fullLabel: "Source of Sales", href: "/employee-portals/source-of-sales", icon: ChartColumnBig, flags: ["showSourceOfSalesTab"] },
  { label: "Coaching", fullLabel: "Coaching Analytics", href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, flags: ["showCoachingAnalyticsTab"] },
  { label: "Double Visit", fullLabel: "Double-Visit Analytics", href: "/employee-portals/double-visit-analytics", icon: Activity, flags: ["showDoubleVisitAnalyticsTab"] },
  { label: "DV Planner", fullLabel: "DV Planner", href: "/employee-portals/dv-planner", icon: CalendarCheck2, flags: ["showDoubleVisitReportTab"] },
  { label: "DV Report", fullLabel: "Double Visit Report", href: "/employee-portals/double-visit-report", icon: FileSpreadsheet, flags: ["showDoubleVisitReportTab"] },
  // Training Manager
  { label: "Overview", fullLabel: "TM Overview", href: "/employee-portals/training-manager", icon: Home, flags: ["showTrainingManagerDashboardTab"] },
  { label: "Coaching", fullLabel: "Coaching Dashboard", href: "/employee-portals/training-manager/coaching", icon: ChartColumnBig, flags: ["showTrainingManagerDashboardTab"] },
  { label: "New report", fullLabel: "Create Coaching Report", href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, flags: ["showTrainingManagerCreateCoachingTab"] },
  { label: "Field", fullLabel: "Field Coaching", href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, flags: ["showTrainingManagerFieldCoachingTab"] },
  // Marketing Requests
  { label: "Validation", fullLabel: "Customer Validation", href: "/employee-portals/marketing-requests/validation", icon: ShieldCheck, flags: ["showMarketingRequestsTab"] },
  { label: "Marketing", fullLabel: "Marketing Requests", href: "/employee-portals/marketing-requests", icon: Send, flags: ["showMarketingRequestsTab"] },
  { label: "Inbox", fullLabel: "Marketing Requests Inbox", href: "/employee-portals/marketing-requests/inbox", icon: Inbox, flags: ["showMarketingInboxTab"] },
  { label: "Control", fullLabel: "Marketing Control", href: "/employee-portals/marketing-requests/control", icon: Settings2, flags: ["showMarketingControlTab"] },
  { label: "Customers", fullLabel: "Customer Database", href: "/employee-portals/marketing-requests/customer-database", icon: Database, flags: ["showMarketingCustomerDatabaseTab"] },
  { label: "Coverage", fullLabel: "Marketing Coverage Report", href: "/employee-portals/marketing-requests/coverage-report", icon: MapPinned, flags: ["showMarketingCoverageReportTab"] },
  // Leave Management
  { label: "Vacation", fullLabel: "Vacation Request", href: "/employee-portals/vacation-request", icon: CalendarDays },
  { label: "Leave", fullLabel: "Vacation Report", href: "/employee-portals/vacation-report", icon: FileText },
  { label: "Excuses", fullLabel: "Excuses", href: "/employee-portals/excuses", icon: CalendarClock, flags: ["showExcusesTab"] },
  { label: "Report It", fullLabel: "Report It", href: "/employee-portals/report-it", icon: FileText, flags: ["showReportItTab", "showReportItDashboardTab"] },
  // Team Performance
  { label: "Team", fullLabel: "Team Performance", href: "/employee-portals/team-performance", icon: Trophy, flags: ["showTeamPerformanceTab"] },
  { label: "MRs", fullLabel: "MRs Performance", href: "/employee-portals/med-reps-performance", icon: ChartColumnBig, flags: ["showMedRepsPerformanceTab"] },
  { label: "DSMs", fullLabel: "DSMs Performance", href: "/employee-portals/dsms-performance", icon: Users, flags: ["showDsmsPerformanceTab"] },
  { label: "Team exp", fullLabel: "Team Expenses", href: "/employee-portals/team-expenses", icon: WalletCards, flags: ["showTeamExpensesTab"] },
  // Team Operations
  { label: "Vacancies", fullLabel: "Vacancies", href: "/employee-portals/vacancies", icon: BriefcaseBusiness, flags: ["showVacanciesTab"] },
  { label: "Probation", fullLabel: "Probation Tracker", href: "/employee-portals/probation", icon: ClipboardCheck, flags: ["showProbationTab"] },
  { label: "Org", fullLabel: "Organogram", href: "/employee-portals/organogram", icon: Building2, flags: ["showOrganogramTab"] },
  // Expenses
  { label: "Expenses", fullLabel: "My Outstation Expenses", href: "/employee-portals/expenses", icon: ReceiptText, flags: ["showMedicalRepExpensesTab"] },
  { label: "Expenses", fullLabel: "Expense Dashboard", href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, flags: ["showExpenseDashboardTab"] },
  { label: "Submit exp", fullLabel: "Submit Expense", href: "/employee-portals/submit-expense", icon: Send, flags: ["showExpenseActionTab"] },
  // Support
  { label: "Support", fullLabel: "Request Support", href: "/employee-portals/contact-hr-support", icon: Headphones, flags: ["showSupportTab"] },
];

/** Fixed anchors of the bottom nav — always present, not user-removable. */
export const HOME_ENTRY: PortalNavEntry = { label: "Home", fullLabel: "Home", href: "/employee-portals", icon: Home };
export const PROFILE_ENTRY: PortalNavEntry = { label: "Profile", fullLabel: "Profile", href: "/employee-portals/profile", icon: User };

/** Max user-pinned shortcuts between Home and Profile in the bottom bar. */
export const MAX_BOTTOM_NAV_CUSTOM = 4;

/** Default priority of middle bottom-nav items when the user hasn't customized. */
export const DEFAULT_BOTTOM_NAV_HREFS = [
  "/employee-portals/plans",
  "/employee-portals/plans/calendar",
  "/employee-portals/report-it",
  "/employee-portals/team-performance",
  "/employee-portals/marketing-requests",
  "/employee-portals/expense-dashboard",
  "/employee-portals/expenses",
  "/employee-portals/incentive",
  "/employee-portals/coaching",
];


export function isEntryVisible(entry: PortalNavEntry, visibility: EmployeePortalNavVisibility): boolean {
  if (!entry.flags || entry.flags.length === 0) return true;
  return entry.flags.some((flag) => Boolean(visibility[flag]));
}

/**
 * Registry entries the signed-in role can see, de-duplicated by href.
 *
 * `effectiveModuleIds` mirrors the same Modules Control curation the sidebar
 * applies (see applyModuleCuration in employee-portal-layout.tsx) so the mobile
 * bottom nav and profile quick-navigation grid never surface a destination an
 * admin has restricted out of the desktop sidebar.
 */
export function visiblePortalNavEntries(
  visibility: EmployeePortalNavVisibility,
  effectiveModuleIds?: string[] | null,
): PortalNavEntry[] {
  const seen = new Set<string>();
  const result: PortalNavEntry[] = [];
  for (const entry of PORTAL_NAV_REGISTRY) {
    if (seen.has(entry.href) || !isEntryVisible(entry, visibility)) continue;
    if (!isEmployeePortalHrefCurated(entry.href, effectiveModuleIds ?? null)) continue;
    seen.add(entry.href);
    result.push(entry);
  }
  return result;
}

export function entryByHref(href: string): PortalNavEntry | undefined {
  if (href === HOME_ENTRY.href) return HOME_ENTRY;
  if (href === PROFILE_ENTRY.href) return PROFILE_ENTRY;
  return PORTAL_NAV_REGISTRY.find((entry) => entry.href === href);
}
