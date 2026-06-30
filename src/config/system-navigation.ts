import {
  Activity,
  Archive,
  BellRing,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  ClipboardList,
  Download,
  Columns3,
  Database,
  FileCheck2,
  FilePlus2,
  FileSpreadsheet,
  FileUp,
  Fingerprint,
  Hourglass,
  IdCard,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MapPinned,
  Megaphone,
  MessageSquareText,
  Network,
  PlusCircle,
  Radar,
  ReceiptText,
  ScrollText,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Tags,
  Target,
  TriangleAlert,
  Trash2,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  adminShellEmployeeRoles,
  type NavigationMode,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "@/lib/auth/permissions";

export type NavigationPermission = {
  action?: PermissionAction;
  resource: PermissionResource;
};

export type NavigationSectionItem = {
  href: `/${string}`;
  icon: LucideIcon;
  label: string;
  moduleId: string;
  excludedRoles?: readonly PhoenixRole[];
  roles?: readonly PhoenixRole[];
  permissions?: readonly NavigationPermission[];
  /**
   * Active-route matching hints (consumed by `isActivePath` in
   * `@/lib/navigation/active-path`). `exact` highlights the item ONLY when the
   * pathname equals its href base (prevents a parent route from staying active on
   * its children, e.g. `/sales` vs `/sales/import`). `activeTab` highlights the
   * item only when the sidebar's active query-param tab matches (for two items
   * that share the same path but differ by `?tab=`/`?action=`).
   */
  exact?: boolean;
  activeTab?: string;
  navBadge?: "approvals-hub-pending";
};

export type NavigationSection = {
  id: string;
  items: readonly NavigationSectionItem[];
  label: string;
};

type NavigationSectionItemSeed = Omit<NavigationSectionItem, "moduleId"> & {
  moduleId?: string;
};

type NavigationSectionSeed = Omit<NavigationSection, "items"> & {
  items: readonly NavigationSectionItemSeed[];
};

function moduleIdPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function defaultModuleId(mode: NavigationMode, section: NavigationSectionSeed, item: NavigationSectionItemSeed) {
  const prefix = mode === "employee-portal" ? "portal" : "admin";
  const labelPart = moduleIdPart(item.label);
  const hrefPart = moduleIdPart(item.href);
  const tabPart = item.activeTab ? `_${moduleIdPart(item.activeTab)}` : "";
  return `${prefix}.${moduleIdPart(section.id)}.${labelPart}.${hrefPart}${tabPart}`;
}

function withModuleIds(
  mode: NavigationMode,
  sections: readonly NavigationSectionSeed[],
): readonly NavigationSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({
      ...item,
      moduleId: item.moduleId ?? defaultModuleId(mode, section, item),
    })),
  }));
}

const hrAuthorityNavigationRoles = ["Super Admin", "Talent Acquisition"] as const satisfies readonly PhoenixRole[];
const companyPayrollNavigationRoles = ["Super Admin", "Finance Manager"] as const satisfies readonly PhoenixRole[];
const systemAdministratorNavigationRoles = ["Super Admin"] as const satisfies readonly PhoenixRole[];

export const navigationHomePathByMode: Record<NavigationMode, `/${string}`> = {
  admin: "/admin/access",
  "employee-portal": "/employee-portals",
};

const adminNavigationSectionSeeds = [
  // ── Tier 1: Executive overview ────────────────────────────────────────────────
  // Items ordered: primary dashboard → intelligence → monitoring → audit → admin tools → destructive
  {
    id: "command-center",
    items: [
      { href: "/admin/ceo-command-center", icon: LayoutDashboard, label: "CEO Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], roles: ["CEO"] },
      { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }], excludedRoles: ["CEO"] },
      { href: "/admin/sales-marketing-intelligence", icon: ChartColumnBig, label: "Sales & Marketing Intelligence", roles: ["CEO", "Super Admin", "SFE Manager", "Product Manager", "Group Product Manager", "National Sales Manager"] },
      { href: "/admin/monitoring", icon: Radar, label: "Monitoring", permissions: [{ resource: "admin" }], excludedRoles: ["CEO"] },
      { href: "/admin/logs", icon: ScrollText, label: "Audit Logs", permissions: [{ resource: "admin" }], excludedRoles: ["CEO"] },
      { href: "/admin/data-health", icon: Database, label: "Data Health", permissions: [{ resource: "admin" }], excludedRoles: ["CEO"] },
      { href: "/admin/activity-control", icon: Activity, label: "Activity Control", permissions: [{ resource: "user_activity", action: "read" }], roles: ["Super Admin"] },
      { href: "/admin/data-backup", icon: Download, label: "Data Backup", roles: ["Super Admin"] },
      { href: "/admin/system-cleanup", icon: Trash2, label: "System Cleanup", roles: ["Super Admin"] },
    ],
    label: "Command Center",
  },

  // ── Tier 2: Personal workspace (admin-shell employee roles) ──────────────────
  {
    id: "workspace-my-workspace",
    items: [
      { href: "/workspace", icon: LayoutDashboard, label: "My Dashboard", moduleId: "admin.workspace.my_dashboard", permissions: [{ resource: "employee_profile", action: "read" }], roles: adminShellEmployeeRoles, exact: true },
      { href: "/workspace/incentive", icon: Sparkles, label: "Incentive", moduleId: "admin.workspace.incentive", permissions: [{ resource: "employee_profile", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/plans", icon: CalendarDays, label: "Weekly / Monthly Plan", moduleId: "admin.workspace.weekly_monthly_plan", permissions: [{ resource: "weekly_plans", action: "read" }], roles: adminShellEmployeeRoles, exact: true },
      { href: "/workspace/plans/calendar", icon: CalendarRange, label: "Planning Calendar", moduleId: "admin.workspace.planning_calendar", permissions: [{ resource: "weekly_plans", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/private-calendar", icon: CalendarCheck, label: "Private Calendar", moduleId: "admin.workspace.private_calendar", permissions: [{ resource: "employee_profile", action: "read" }], roles: adminShellEmployeeRoles },
    ],
    label: "My Workspace",
  },
  {
    id: "workspace-payroll",
    items: [
      { href: "/workspace/payslips", icon: ScrollText, label: "Payslips", moduleId: "admin.workspace.payslips", permissions: [{ resource: "payslips", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/deductions", icon: ReceiptText, label: "Deductions", moduleId: "admin.workspace.deductions", permissions: [{ resource: "employee_profile", action: "read" }], roles: adminShellEmployeeRoles },
    ],
    label: "Payroll",
  },
  {
    id: "workspace-leave-management",
    items: [
      { href: "/workspace/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", moduleId: "admin.workspace.vacation_request", permissions: [{ resource: "leave", action: "create" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", moduleId: "admin.workspace.vacation_report", permissions: [{ resource: "leave", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/fingerprint-report", icon: Fingerprint, label: "My Attendance", moduleId: "admin.workspace.fingerprint_report", permissions: [{ resource: "attendance", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/excuses", icon: CalendarClock, label: "Excuses", moduleId: "admin.workspace.excuses", permissions: [{ resource: "employee_profile", action: "read" }], roles: adminShellEmployeeRoles },
    ],
    label: "Leave Management",
  },
  {
    id: "workspace-team-operations",
    items: [
      { href: "/workspace/organogram", icon: Network, label: "Organogram", moduleId: "admin.workspace.organogram", permissions: [{ resource: "organogram", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/vacancies", icon: BriefcaseBusiness, label: "Vacancies", moduleId: "admin.workspace.vacancies", permissions: [{ resource: "vacancies", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/probation", icon: Hourglass, label: "Probation Tracker", moduleId: "admin.workspace.probation_tracker", permissions: [{ resource: "probation", action: "read" }], roles: adminShellEmployeeRoles },
    ],
    label: "Team Operations",
  },
  {
    id: "workspace-expenses",
    items: [
      { href: "/workspace/expense-dashboard", icon: ReceiptText, label: "Expense Command Center", moduleId: "admin.workspace.expense_dashboard", permissions: [{ resource: "expenses", action: "read" }], roles: adminShellEmployeeRoles },
      { href: "/workspace/submit-expense", icon: PlusCircle, label: "Submit Expense", moduleId: "admin.workspace.submit_expense", permissions: [{ resource: "outstation", action: "create" }], roles: adminShellEmployeeRoles },
    ],
    label: "Expenses",
  },
  {
    id: "workspace-support",
    items: [
      { href: "/workspace/contact-hr-support", icon: LifeBuoy, label: "Request Support", moduleId: "admin.workspace.request_support", permissions: [{ resource: "support_requests", action: "create" }], roles: adminShellEmployeeRoles },
    ],
    label: "Support",
  },

  // ── Tier 3: Role-specific workspaces (Marketing Manager / SFE) ───────────────
  {
    id: "workspace-marketing-requests",
    items: [
      { href: "/admin/sales-marketing-intelligence", icon: ChartColumnBig, label: "ROI Dashboard", moduleId: "admin.workspace.roi_dashboard_mm", roles: ["Marketing Manager"] },
      { href: "/workspace/marketing-requests/overview", icon: LayoutDashboard, label: "Overview", moduleId: "admin.workspace.marketing_overview", roles: ["SFE Manager", "Marketing Manager", "Finance Manager", "Financial Advisor"], exact: true },
      { href: "/workspace/marketing-requests/validation", icon: ShieldCheck, label: "Customer Validation", moduleId: "admin.workspace.customer_validation", roles: ["SFE Manager", "Marketing Manager"] },
      { href: "/workspace/marketing-requests", icon: Megaphone, label: "Marketing Requests", moduleId: "admin.workspace.marketing_requests", roles: ["SFE Manager", "Marketing Manager", "Finance Manager", "Financial Advisor"], exact: true },
      { href: "/workspace/marketing-requests/inbox", icon: Inbox, label: "Approval Inbox", moduleId: "admin.workspace.approval_inbox", roles: ["SFE Manager", "Marketing Manager", "Finance Manager", "Financial Advisor"] },
      { href: "/workspace/marketing-requests/roi-tracking", icon: ChartColumnBig, label: "ROI Tracking", moduleId: "admin.workspace.roi_tracking", roles: ["SFE Manager", "Marketing Manager", "Finance Manager", "Financial Advisor"] },
    ],
    label: "Marketing & ROI",
  },
  {
    id: "workspace-sales-intelligence",
    items: [
      { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "SoS Dashboard", moduleId: "admin.workspace.mm_sos_dashboard", permissions: [{ resource: "sales" }], roles: ["Marketing Manager"], exact: true },
      { href: "/sales/weekly/dashboard", icon: ChartNoAxesColumnIncreasing, label: "Weekly Sales Dashboard", moduleId: "admin.workspace.mm_weekly_sales", permissions: [{ resource: "weekly_sales" }], roles: ["Marketing Manager"] },
      { href: "/sales/monthly-dashboard", icon: CalendarRange, label: "Sales Queue Closing Dashboard", moduleId: "admin.workspace.mm_monthly_sales", permissions: [{ resource: "sales" }], roles: ["Marketing Manager"] },
      { href: "/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", moduleId: "admin.workspace.mm_coaching_analytics", permissions: [{ resource: "coaching" }], roles: ["Marketing Manager"] },
      { href: "/admin/double-visit-analytics", icon: Activity, label: "Double Visit Analytics", moduleId: "admin.workspace.mm_double_visit", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["Marketing Manager"] },
    ],
    label: "Sales Intelligence",
  },

  // ── Tier 4: HR & People ───────────────────────────────────────────────────────
  // Items ordered: time-sensitive actions → headcount records → lifecycle events → compliance
  {
    id: "people-management",
    items: [
      { href: "/admin/approvals-hub", icon: Inbox, label: "Approvals Hub", permissions: [{ resource: "leave", action: "read" }], navBadge: "approvals-hub-pending" },
      { href: "/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees" }], roles: ["Super Admin"] },
      // Organogram/Probation/Vacancies Report duplicate the workspace-team-operations
      // /workspace/organogram, /workspace/probation, /workspace/vacancies entries for the
      // admin-shell-employee Marketing Manager (same underlying report, different href).
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }], excludedRoles: ["Marketing Manager"] },
      { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }], excludedRoles: ["Marketing Manager"] },
      { href: "/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }], excludedRoles: ["Marketing Manager"] },
      { href: "/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
      { href: "/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations" }] },
      // Org-wide plans review for Super Admin only. CEO uses the Company Calendar + Private Calendars.
      { href: "/admin/weekly-plans", icon: CalendarDays, label: "Weekly / Monthly Plans", permissions: [{ resource: "weekly_plans" }], roles: ["Super Admin"] },
      { href: "/admin/field-workforce-compliance", icon: ClipboardCheck, label: "Workforce Compliance", permissions: [{ resource: "hr_calendar" }] },
      { href: "/admin/support-requests", icon: LifeBuoy, label: "HR Support Requests", permissions: [{ resource: "support_requests" }], roles: hrAuthorityNavigationRoles },
    ],
    label: "People Management",
  },
  {
    id: "recruitment-hiring",
    items: [
      { href: "/recruitment", icon: BriefcaseBusiness, label: "Recruitment", permissions: [{ resource: "recruitment" }], roles: hrAuthorityNavigationRoles },
      { href: "/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "vacancies" }], roles: hrAuthorityNavigationRoles },
      { href: "/offers", icon: IdCard, label: "Offer Lifecycle", permissions: [{ resource: "offers" }], roles: hrAuthorityNavigationRoles },
      { href: "/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }], roles: hrAuthorityNavigationRoles },
    ],
    label: "Recruitment & Hiring",
  },
  // Items ordered: reporting views → calendar references → admin config
  {
    id: "attendance-management",
    items: [
      { href: "/attendance/fingerprint-report", icon: FileSpreadsheet, label: "My Attendance", permissions: [{ resource: "employees" }] },
      { href: "/attendance/monthly-summary", icon: CalendarCheck, label: "Monthly Summary", permissions: [{ resource: "employees" }] },
      { href: "/attendance/analytics", icon: ChartColumnBig, label: "Attendance Analytics", permissions: [{ resource: "attendance", action: "read" }] },
      { href: "/hr-calendar", icon: CalendarDays, label: "Company Calendar", permissions: [{ resource: "hr_calendar" }] },
      { href: "/admin/private-calendars", icon: CalendarDays, label: "Private Calendars", permissions: [{ resource: "attendance", action: "read" }], roles: ["CEO", "Super Admin"] },
      { href: "/attendance/exceptions", icon: ShieldCheck, label: "Attendance Exceptions", permissions: [{ resource: "attendance", action: "read" }], roles: systemAdministratorNavigationRoles },
      { href: "/attendance/device-user-mapping", icon: Fingerprint, label: "Device User Mapping", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/attendance/policies", icon: CalendarClock, label: "Attendance Policies", permissions: [{ resource: "employees", action: "update" }] },
    ],
    label: "Attendance Management",
  },
  {
    id: "leave-management",
    items: [
      // Self-service vacation request/report for Super Admin + CEO. Admin-shell employee roles
      // (SFE/Marketing/Finance/Talent Acquisition) use the identical /workspace/leave-management
      // home instead, so listing them here too produced duplicate sidebar entries. HR controls
      // below (vacation-control / action-center) keep their own role gating.
      { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }], roles: ["Super Admin", "CEO"] },
      { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }], roles: ["Super Admin", "CEO"] },
      { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }], roles: hrAuthorityNavigationRoles },
      { href: "/leave-management/vacation-action-center", icon: ClipboardCheck, label: "Vacation Action Center", permissions: [{ resource: "leave" }], roles: systemAdministratorNavigationRoles },
    ],
    label: "Leave Management",
  },
  {
    id: "payroll",
    items: [
      { href: "/payroll", icon: FileSpreadsheet, label: "Payroll Report", permissions: [{ resource: "payroll" }], roles: companyPayrollNavigationRoles, excludedRoles: ["CEO"], exact: true },
      { href: "/admin/m-payroll", icon: ScrollText, label: "CEO Payroll View", permissions: [{ resource: "payroll" }], roles: ["CEO", "Super Admin"] },
      { href: "/admin/payslips-center", icon: ScrollText, label: "Payslips Center", permissions: [{ resource: "payslips" }], roles: ["Super Admin", "CEO"] },
      { href: "/admin/deductions-governance", icon: ShieldCheck, label: "Deductions Governance", permissions: [{ resource: "deductions", action: "read" }] },
    ],
    label: "Payroll Management",
  },

  // ── Tier 5: Field operations ──────────────────────────────────────────────────
  // Items ordered: overview → active queue → data entry → historical → config
  {
    id: "expenses-outstation",
    items: [
      { href: "/admin/outstation/expense-command", icon: Radar, label: "Expense Command Center", permissions: [{ resource: "outstation", action: "read" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
      { href: "/admin/outstation/expense-command?tab=queue", icon: MapPinned, label: "Expense Requests", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager"], activeTab: "queue" },
      { href: "/admin/outstation/expense-command?tab=queue&action=create-manager-expense", icon: PlusCircle, label: "Add Manual Expense", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager"], activeTab: "create-manager-expense" },
      { href: "/payroll/expenses/dashboard", icon: ChartColumnBig, label: "Outstation Expenses", permissions: [{ resource: "expenses" }], roles: systemAdministratorNavigationRoles },
      { href: "/payroll/expenses", icon: FileSpreadsheet, label: "Historical Upload", permissions: [{ resource: "expenses" }], roles: systemAdministratorNavigationRoles, exact: true },
      { href: "/admin/outstation/policy", icon: CalendarClock, label: "Outstation Policy", permissions: [{ resource: "outstation", action: "update" }], roles: ["Super Admin", "Finance Manager"] },
    ],
    label: "Outstation Expenses",
  },
  {
    id: "field-coaching",
    items: [
      { href: "/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
      // Coaching Analytics / Double Visit Analytics duplicate the workspace-sales-intelligence
      // entries (same href) for the admin-shell-employee Marketing Manager.
      { href: "/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }], excludedRoles: ["Marketing Manager"] },
      { href: "/admin/double-visit-analytics", icon: Activity, label: "Double Visit Analytics", permissions: [{ resource: "double_visit_analytics", action: "read" }], excludedRoles: ["Marketing Manager"] },
      { href: "/coaching/import", icon: FileUp, label: "Import History", permissions: [{ action: "create", resource: "coaching" }] },
      { href: "/coaching/archived", icon: Archive, label: "Resigned Evaluations", permissions: [{ action: "create", resource: "coaching" }] },
    ],
    label: "Field Coaching",
  },

  // ── Tier 6: Sales operations ──────────────────────────────────────────────────
  // Items ordered: dashboards → data entry → upload → data management → QA/diagnostics
  {
    id: "sales-source-of-sales",
    items: [
      { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "SoS Dashboard", permissions: [{ resource: "sales" }], excludedRoles: ["CEO", "Marketing Manager"], exact: true },
      { href: "/sales/monthly-dashboard", icon: CalendarRange, label: "Sales Queue Closing Dashboard", moduleId: "admin.sales_operations.monthly_closing", permissions: [{ resource: "sales" }], excludedRoles: ["CEO", "Marketing Manager"] },
      { href: "/sales/monthly-closing", icon: ChartColumnBig, label: "SoS Monthly Closing Entry", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/upload", icon: FileUp, label: "Sales Upload", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/import", icon: FileSpreadsheet, label: "Sales Import (Advanced)", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/mapping-database", icon: Database, label: "Mapping Database", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/database-mapping", icon: Database, label: "Master Data & Profiles", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/customer-directory", icon: UsersRound, label: "Customer Directory", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/customer-mapping", icon: MapPinned, label: "Customer Mapping", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/distributor-profiles", icon: Tags, label: "Distributor Column Editor", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/missing-data", icon: TriangleAlert, label: "Missing Data", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/normalizer", icon: Sparkles, label: "Source Normalizer", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/diagnostics", icon: Stethoscope, label: "Sales Diagnostics", permissions: [{ action: "import", resource: "sales" }] },
    ],
    label: "Source of Sales",
  },
  {
    id: "sales-weekly-module",
    items: [
      { href: "/sales/weekly/dashboard", icon: ChartNoAxesColumnIncreasing, label: "Weekly Sales Dashboard", permissions: [{ resource: "weekly_sales" }], excludedRoles: ["Marketing Manager"] },
      { href: "/sales/weekly", icon: FileUp, label: "Weekly Sales Upload", permissions: [{ action: "import", resource: "weekly_sales" }] },
      // Branch→Region, Product, Mapping Workbook, Missing Data and Missing Products are now tabs of
      // the single Weekly Mapping workspace (old routes redirect here).
      { href: "/sales/weekly/mapping", icon: Tags, label: "Weekly Mapping", permissions: [{ action: "update", resource: "weekly_sales" }] },
      { href: "/sales/weekly/distributor-editor", icon: Columns3, label: "Weekly Distributor Column Editor", permissions: [{ action: "import", resource: "weekly_sales" }] },
      { href: "/sales/weekly/assignments", icon: UsersRound, label: "Weekly Product Access", permissions: [{ action: "update", resource: "weekly_sales" }] },
    ],
    label: "Weekly Sales",
  },
  {
    id: "sales-queue-module",
    items: [
      { href: "/sales/queue", icon: ClipboardList, label: "Sales Queue", permissions: [{ action: "import", resource: "sales" }] },
    ],
    label: "Sales Queue",
  },
  {
    id: "sales-analytics",
    items: [
      { href: "/admin/analytics", icon: ChartColumnBig, label: "Analytics Hub", permissions: [{ resource: "sales" }], roles: ["Super Admin", "CEO", "National Sales Manager", "Product Manager", "Group Product Manager", "SFE Manager"] },
      { href: "/admin/analytics/source-sales", icon: ChartColumnBig, label: "SoS Analytics", permissions: [{ resource: "sales" }], roles: ["Super Admin", "CEO", "National Sales Manager", "Product Manager", "Group Product Manager", "SFE Manager"] },
      { href: "/admin/analytics/monthly-closing", icon: CalendarRange, label: "Closing Analytics", permissions: [{ resource: "sales" }], roles: ["Super Admin", "CEO", "National Sales Manager", "SFE Manager"] },
      { href: "/admin/analytics/weekly-sales", icon: ChartNoAxesColumnIncreasing, label: "Weekly Analytics", permissions: [{ resource: "weekly_sales" }], roles: ["Super Admin", "CEO", "National Sales Manager", "Product Manager", "Group Product Manager", "SFE Manager"] },
      { href: "/admin/analytics/executive-comparison", icon: ChartColumnBig, label: "Executive Comparison", permissions: [{ resource: "sales" }], roles: ["Super Admin", "CEO"] },
      { href: "/admin/analytics/reconciliation", icon: ChartColumnBig, label: "Reconciliation", permissions: [{ resource: "sales" }], roles: ["Super Admin", "CEO"] },
    ],
    label: "Sales Analytics",
  },

  // ── Tier 7: Marketing ─────────────────────────────────────────────────────────
  {
    id: "marketing-requests",
    items: [
      // SFE Manager uses the de-duplicated /workspace/marketing-requests home, while Marketing
      // Manager uses the employee-portal marketing request routes alongside PM/GPM. This org-wide
      // admin module stays for District Manager + Super Admin only.
      // ROI Dashboard is a READ-ONLY executive report — also surfaces to CEO for oversight.
      { href: "/admin/marketing-requests/roi-tracking", icon: ChartColumnBig, label: "ROI Dashboard", roles: ["Super Admin", "CEO"] },
      { href: "/admin/marketing-requests/validation", icon: ShieldCheck, label: "Customer Validation", roles: ["District Manager", "Super Admin"] },
      { href: "/admin/marketing-requests", icon: Megaphone, label: "Marketing Requests", roles: ["District Manager", "Super Admin"], exact: true },
      { href: "/admin/marketing-requests/inbox", icon: Inbox, label: "Approval Inbox", roles: ["District Manager", "Super Admin"] },
      { href: "/admin/marketing-requests/customer-database", icon: Database, label: "Customer Database", roles: ["Super Admin"] },
      { href: "/admin/marketing-requests/bulk-upload", icon: FileUp, label: "Bulk Upload", roles: ["Super Admin"] },
      { href: "/admin/marketing-requests/control", icon: Settings2, label: "Marketing Control", roles: systemAdministratorNavigationRoles },
    ],
    label: "Marketing Requests",
  },

  // ── Tier 8: System administration ────────────────────────────────────────────
  // Items ordered: access control → system config → communication tools
  {
    id: "access-communication",
    items: [
      { href: "/admin/access", icon: ShieldCheck, label: "Users & Access", permissions: [{ resource: "admin_access" }], excludedRoles: ["CEO"] },
      { href: "/admin/scope-visibility", icon: ShieldAlert, label: "Scope & Visibility", roles: ["Super Admin"] },
      { href: "/admin/modules-control", icon: Settings2, label: "Modules Control", permissions: [{ resource: "module_control", action: "read" }], roles: ["Super Admin"] },
      { href: "/admin/workflow-control", icon: Settings2, label: "Workflow Control", permissions: [{ resource: "workflow_registry" }], roles: ["Super Admin"] },
      { href: "/admin/email-reply-composer", icon: Mail, label: "Email Composer", permissions: [{ resource: "communication" }] },
      { href: "/admin/email-templates", icon: BellRing, label: "Email Templates", permissions: [{ resource: "communication" }] },
      { href: "/admin/notifications/telegram", icon: Send, label: "Telegram", permissions: [{ resource: "communication" }] },
      { href: "/admin/notifications/telegram/templates", icon: MessageSquareText, label: "Telegram Templates", permissions: [{ resource: "communication" }] },
      { href: "/workspace/contact-hr-support", icon: LifeBuoy, label: "Request HR Support", permissions: [{ resource: "support_requests", action: "create" }], roles: ["CEO"] },
    ],
    label: "Access & Communication",
  },
  {
    id: "pharmacovigilance",
    items: [
      { href: "/admin/report-it", icon: ShieldAlert, label: "Reports Dashboard", roles: ["Super Admin"] },
      { href: "/admin/report-it/new", icon: ShieldAlert, label: "Report It" },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSectionSeed[];

const employeePortalNavigationSectionSeeds = [
  {
    id: "employee-portal",
    items: [
      { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/approvals-hub", icon: Inbox, label: "Approvals Hub", permissions: [{ resource: "leave", action: "read" }], navBadge: "approvals-hub-pending" },
      { href: "/employee-portals/private-calendar", icon: CalendarCheck, label: "Private Calendar", permissions: [{ resource: "employee_profile" }] },
      { href: "/employee-portals/plans", icon: CalendarDays, label: "Weekly / Monthly Plans", permissions: [{ resource: "weekly_plans" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Manager"] },
      { href: "/employee-portals/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram", action: "read" }], roles: ["National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies", action: "read" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager"] },
      { href: "/employee-portals/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/employee-portals/contact-hr-support", icon: LifeBuoy, label: "HR Support", permissions: [{ resource: "support_requests", action: "create" }] },
      { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Outstation Expenses", permissions: [{ resource: "expenses" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Expense Dashboard", permissions: [{ resource: "expenses" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Submit Expense", permissions: [{ resource: "outstation", action: "create" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/team-expenses", icon: ReceiptText, label: "Team Expenses", permissions: [{ resource: "expenses" }], roles: ["National Sales Manager"] },
    ],
    label: "Medical Rep Portal",
  },
  {
    id: "payroll",
    items: [
      { href: "/payslips", icon: ScrollText, label: "Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }], exact: true },
      { href: "/employee-portals/deductions", icon: ReceiptText, label: "Deductions", permissions: [{ resource: "employee_profile" }], exact: true },
    ],
    label: "Payroll",
  },
  {
    id: "sales-operations",
    items: [
      { href: "/employee-portals/source-of-sales", icon: ChartNoAxesColumnIncreasing, label: "Source of Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Marketing Manager"] },
    ],
    label: "Sales Operations",
  },
  {
    id: "coaching",
    items: [
      { href: "/employee-portals/double-visit-analytics", icon: Activity, label: "Double-Visit Analytics", permissions: [{ resource: "double_visit_analytics", action: "read" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
      { href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
    ],
    label: "Coaching",
  },
  {
    id: "employee-marketing-requests",
    items: [
      {
        href: "/employee-portals/marketing-requests/validation",
        icon: ShieldCheck,
        label: "Customer Validation",
        roles: [
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
        ],
      },
      {
        href: "/employee-portals/marketing-requests",
        icon: Megaphone,
        label: "Marketing Requests",
        roles: [
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
        ],
      },
      {
        href: "/employee-portals/marketing-requests/inbox",
        icon: Inbox,
        label: "Approval Inbox",
        roles: [
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
        ],
      },
      {
        href: "/employee-portals/marketing-requests/control",
        icon: Settings2,
        label: "Marketing Control",
        roles: ["SFE Manager", "Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/customer-database",
        icon: Database,
        label: "Customer Database",
        roles: ["Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/roi-tracking",
        icon: ChartColumnBig,
        label: "ROI Tracking",
        roles: [
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
        ],
      },
      { href: "/employee-portals/roi", icon: Target, label: "ROI Dashboard", permissions: [{ resource: "sales" }], roles: ["Product Manager", "Group Product Manager", "Marketing Manager"] },
    ],
    label: "Marketing Requests",
  },
  {
    id: "leave-management",
    items: [
      { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }] },
      { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }] },
      { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }], roles: hrAuthorityNavigationRoles },
      { href: "/leave-management/vacation-action-center", icon: ClipboardCheck, label: "Vacation Action Center", permissions: [{ resource: "leave" }], roles: systemAdministratorNavigationRoles },
      { href: "/employee-portals/attendance", icon: Fingerprint, label: "Fingerprint Report", permissions: [{ resource: "attendance", action: "read" }] },
    ],
    label: "Leave Management",
  },
  {
    id: "pharmacovigilance",
    items: [
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Reports Dashboard", roles: ["Manager"] },
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Report It", excludedRoles: ["Manager"] },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSectionSeed[];

export const adminNavigationSections = withModuleIds("admin", adminNavigationSectionSeeds);
export const employeePortalNavigationSections = withModuleIds("employee-portal", employeePortalNavigationSectionSeeds);

export function getNavigationSections(mode: NavigationMode): readonly NavigationSection[] {
  return mode === "employee-portal" ? employeePortalNavigationSections : adminNavigationSections;
}
