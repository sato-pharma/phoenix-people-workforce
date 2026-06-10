import {
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarDays,
  ChartColumnBig,
  CircleDollarSign,
  ClipboardCheck,
  Database,
  FilePlus2,
  FileText,
  Gift,
  Headphones,
  Home,
  Inbox,
  LineChart,
  type LucideIcon,
  ReceiptText,
  Send,
  Settings2,
  ShieldCheck,
  Trophy,
  User,
  Users,
  WalletCards,
} from "lucide-react";

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
};

/**
 * Single source of truth for the employee-portal destinations surfaced in the
 * mobile bottom nav and the profile quick-navigation grid. Hrefs/flags mirror
 * buildEmployeePortalSections in employee-portal-layout.tsx (the sidebar); the
 * employee-portal bottom-nav guard test keeps the two in sync.
 */
export const PORTAL_NAV_REGISTRY: PortalNavEntry[] = [
  // My Workspace
  { label: "Performance", fullLabel: "My Performance", href: "/employee-portals/sales", icon: LineChart, flags: ["showMyPerformanceTab"] },
  { label: "Incentive", fullLabel: "Incentive", href: "/employee-portals/incentive", icon: Gift, flags: ["showIncentiveTab"] },
  { label: "Coaching", fullLabel: "Coaching Reports", href: "/employee-portals/coaching", icon: ClipboardCheck, flags: ["showMyCoachingTab", "showTeamCoachingTab"] },
  { label: "Plans", fullLabel: "Weekly / Monthly Plan", href: "/employee-portals/plans", icon: CalendarDays, flags: ["showPlansTab"] },
  { label: "Payslips", fullLabel: "Payslips", href: "/payslips", icon: FileText },
  { label: "Deductions", fullLabel: "Deductions", href: "/employee-portals/deductions", icon: ReceiptText },
  // Training Manager
  { label: "Coaching", fullLabel: "Coaching Dashboard", href: "/employee-portals/training-manager", icon: ChartColumnBig, flags: ["showTrainingManagerDashboardTab"] },
  { label: "New report", fullLabel: "Create Coaching Report", href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, flags: ["showTrainingManagerCreateCoachingTab"] },
  { label: "Field", fullLabel: "Field Coaching", href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, flags: ["showTrainingManagerFieldCoachingTab"] },
  // Marketing Requests
  { label: "Validation", fullLabel: "Customer Validation", href: "/employee-portals/marketing-requests/validation", icon: ShieldCheck, flags: ["showMarketingRequestsTab"] },
  { label: "Marketing", fullLabel: "Marketing Requests", href: "/employee-portals/marketing-requests", icon: Send, flags: ["showMarketingRequestsTab"] },
  { label: "Inbox", fullLabel: "Approval Inbox", href: "/employee-portals/marketing-requests/inbox", icon: Inbox, flags: ["showMarketingInboxTab"] },
  { label: "Control", fullLabel: "Marketing Control", href: "/employee-portals/marketing-requests/control", icon: Settings2, flags: ["showMarketingControlTab"] },
  { label: "Customers", fullLabel: "Customer Database", href: "/employee-portals/marketing-requests/customer-database", icon: Database, flags: ["showMarketingCustomerDatabaseTab"] },
  { label: "ROI", fullLabel: "ROI Tracking", href: "/employee-portals/marketing-requests/roi-tracking", icon: ChartColumnBig, flags: ["showMarketingRoiTrackingTab"] },
  // Leave Management
  { label: "Vacation", fullLabel: "Vacation Request", href: "/leave-management/vacation-request", icon: CalendarDays },
  { label: "Leave", fullLabel: "Vacation Report", href: "/leave-management/vacation-report", icon: FileText },
  { label: "Excuses", fullLabel: "Excuses", href: "/employee-portals/excuses", icon: CalendarClock, flags: ["showExcusesTab"] },
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
  { label: "Expenses", fullLabel: "Expense Dashboard", href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, flags: ["showManagementTab"] },
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
  "/employee-portals/sales",
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

/** Registry entries the signed-in role can see, de-duplicated by href. */
export function visiblePortalNavEntries(visibility: EmployeePortalNavVisibility): PortalNavEntry[] {
  const seen = new Set<string>();
  const result: PortalNavEntry[] = [];
  for (const entry of PORTAL_NAV_REGISTRY) {
    if (seen.has(entry.href) || !isEntryVisible(entry, visibility)) continue;
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
