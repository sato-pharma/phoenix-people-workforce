import {
  BellRing,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChartColumnBig,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
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
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { NavigationMode, PermissionAction, PermissionResource, PhoenixRole } from "@/lib/auth/permissions";

export type NavigationPermission = {
  action?: PermissionAction;
  resource: PermissionResource;
};

export type NavigationSectionItem = {
  href: `/${string}`;
  icon: LucideIcon;
  label: string;
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
};

export type NavigationSection = {
  id: string;
  items: readonly NavigationSectionItem[];
  label: string;
};

export const navigationHomePathByMode: Record<NavigationMode, `/${string}`> = {
  admin: "/admin/access",
  "employee-portal": "/employee-portals",
};

export const adminNavigationSections = [
  {
    id: "executive",
    items: [
      { href: "/admin/sales-command", icon: ChartNoAxesColumnIncreasing, label: "Sales Command", roles: ["CEO", "Super Admin"] },
    ],
    label: "Executive",
  },
  {
    id: "sales-intelligence",
    items: [
      { href: "/sales-intelligence", icon: ChartColumnBig, label: "Executive Dashboard", permissions: [{ resource: "sales" }], exact: true },
      { href: "/sales-intelligence/details", icon: FileSpreadsheet, label: "Sales Details", permissions: [{ resource: "sales" }] },
      { href: "/sales-intelligence/data-quality", icon: ShieldCheck, label: "Data Quality Center", permissions: [{ action: "import", resource: "sales" }] },
    ],
    label: "Sales Intelligence",
  },
  {
    id: "command-center",
    items: [
      { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }] },
      { href: "/admin/data-health", icon: Database, label: "Data Health", permissions: [{ resource: "admin" }] },
      { href: "/admin/monitoring", icon: Radar, label: "Monitoring", permissions: [{ resource: "admin" }] },
      { href: "/admin/logs", icon: ScrollText, label: "Audit Logs", permissions: [{ resource: "admin" }] },
    ],
    label: "Command Center",
  },
  {
    id: "people-management",
    items: [
      { href: "/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees" }] },
      { href: "/admin/weekly-plans", icon: CalendarDays, label: "Weekly / Monthly Plans", permissions: [{ resource: "weekly_plans" }] },
      { href: "/admin/field-workforce-compliance", icon: ClipboardCheck, label: "Workforce Compliance", permissions: [{ resource: "hr_calendar" }] },
      { href: "/admin/deductions-governance", icon: ShieldCheck, label: "Deductions Governance", permissions: [{ resource: "deductions", action: "read" }] },
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
      { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
      { href: "/recruitment", icon: BriefcaseBusiness, label: "Recruitment", permissions: [{ resource: "recruitment" }] },
      { href: "/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "vacancies" }] },
      { href: "/offers", icon: IdCard, label: "Offer Lifecycle", permissions: [{ resource: "offers" }] },
      { href: "/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }] },
      { href: "/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }] },
      { href: "/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
      { href: "/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations" }] },
    ],
    label: "People Management",
  },
  {
    id: "attendance-management",
    items: [
      { href: "/attendance/fingerprint-report", icon: FileSpreadsheet, label: "Fingerprint Report", permissions: [{ resource: "employees" }] },
      { href: "/attendance/monthly-summary", icon: CalendarCheck, label: "Monthly Summary", permissions: [{ resource: "employees" }] },
      { href: "/attendance/analytics", icon: ChartColumnBig, label: "Attendance Analytics", permissions: [{ resource: "employees" }] },
      { href: "/attendance/exceptions", icon: ShieldCheck, label: "Attendance Exceptions", permissions: [{ resource: "attendance", action: "read" }] },
      { href: "/attendance/device-user-mapping", icon: Fingerprint, label: "Device User Mapping", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/attendance/policies", icon: CalendarClock, label: "Attendance Policies", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/hr-calendar", icon: CalendarDays, label: "HR Calendar", permissions: [{ resource: "hr_calendar" }] },
    ],
    label: "Attendance Management",
  },
  {
    id: "sales-performance",
    items: [
      { href: "/sales/import", icon: Database, label: "Source of Sales", permissions: [{ resource: "sales" }] },
      { href: "/sales/database-mapping", icon: Database, label: "Database Mapping", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/missing-data", icon: TriangleAlert, label: "Missing Data", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/normalizer", icon: Sparkles, label: "Source Normalizer", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/monthly-closing", icon: ChartColumnBig, label: "Monthly Closing", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/customer-directory", icon: UsersRound, label: "Customer Directory", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/executive-report", icon: Building2, label: "Executive Report", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/queue", icon: FileUp, label: "Monthly Sales", permissions: [{ resource: "sales" }] },
      { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales Dashboard", permissions: [{ resource: "sales" }], exact: true },
      { href: "/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
      { href: "/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }] },
    ],
    label: "Sales & Performance",
  },
  {
    id: "weekly-sales",
    items: [
      { href: "/sales/weekly", icon: FileUp, label: "Weekly Sales Upload", permissions: [{ action: "import", resource: "weekly_sales" }] },
      { href: "/sales/weekly/dashboard", icon: ChartNoAxesColumnIncreasing, label: "Weekly Sales Dashboard", permissions: [{ resource: "weekly_sales" }] },
      { href: "/sales/weekly/assignments", icon: UsersRound, label: "Weekly Product Access", permissions: [{ action: "update", resource: "weekly_sales" }] },
    ],
    label: "Weekly Sales",
  },
  {
    id: "marketing-requests",
    items: [
      { href: "/admin/marketing-requests/validation", icon: ShieldCheck, label: "Customer Validation", roles: ["District Manager", "SFE Manager", "Super Admin"] },
      { href: "/admin/marketing-requests", icon: Megaphone, label: "Marketing Requests", roles: ["District Manager", "SFE Manager", "Super Admin"], exact: true },
      { href: "/admin/marketing-requests/inbox", icon: Inbox, label: "Approval Inbox", roles: ["District Manager", "SFE Manager", "Super Admin"] },
      { href: "/admin/marketing-requests/control", icon: Settings2, label: "Marketing Control", roles: ["District Manager", "SFE Manager", "Super Admin"] },
      { href: "/admin/marketing-requests/customer-database", icon: Database, label: "Customer Database", roles: ["Super Admin"] },
      { href: "/admin/marketing-requests/roi-tracking", icon: ChartColumnBig, label: "ROI Tracking", roles: ["District Manager", "SFE Manager", "Super Admin"] },
    ],
    label: "Marketing Requests",
  },
  {
    id: "payroll",
    items: [
      { href: "/payroll", icon: FileSpreadsheet, label: "Payroll Report", permissions: [{ resource: "payroll" }], exact: true },
      { href: "/admin/payslips-center", icon: ScrollText, label: "Payslips Center", permissions: [{ resource: "payslips" }], roles: ["Super Admin"] },
    ],
    label: "Payroll Management",
  },
  {
    id: "expenses-outstation",
    items: [
      { href: "/payroll/expenses/dashboard", icon: ChartColumnBig, label: "Outstation Expenses", permissions: [{ resource: "expenses" }] },
      { href: "/payroll/expenses", icon: FileSpreadsheet, label: "Historical Upload", permissions: [{ resource: "expenses" }], exact: true },
      { href: "/admin/outstation/requests", icon: MapPinned, label: "Expense Requests", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
      { href: "/admin/outstation/requests?action=create-manager-expense", icon: PlusCircle, label: "Add Manual Expense", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"], activeTab: "create-manager-expense" },
      { href: "/admin/outstation/policy", icon: CalendarClock, label: "Outstation Policy", permissions: [{ resource: "outstation", action: "update" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
      { href: "/admin/outstation/heatmaps", icon: MapPinned, label: "Outstation Heatmaps", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
    ],
    label: "Outstation Expenses",
  },
  {
    id: "leave-management",
    items: [
      { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }] },
      { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }] },
      { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }] },
      { href: "/leave-management/vacation-action-center", icon: ClipboardCheck, label: "Vacation Action Center", permissions: [{ resource: "leave" }] },
    ],
    label: "Leave Management",
  },
  {
    id: "access-communication",
    items: [
      { href: "/admin/access", icon: ShieldCheck, label: "Users & Access", permissions: [{ resource: "admin_access" }] },
      { href: "/admin/email-reply-composer", icon: Mail, label: "Email Composer", permissions: [{ resource: "communication" }] },
      { href: "/admin/email-templates", icon: BellRing, label: "Email Templates", permissions: [{ resource: "communication" }] },
      { href: "/admin/notifications/telegram", icon: Send, label: "Telegram", permissions: [{ resource: "communication" }] },
      { href: "/admin/notifications/telegram/templates", icon: MessageSquareText, label: "Telegram Templates", permissions: [{ resource: "communication" }] },
      { href: "/admin/workflow-control", icon: Settings2, label: "Workflow Control", permissions: [{ resource: "workflow_registry" }], roles: ["Super Admin"] },
    ],
    label: "Access & Communication",
  },
  {
    id: "pharmacovigilance",
    items: [
      { href: "/admin/report-it", icon: ShieldAlert, label: "Reports Dashboard", permissions: [{ resource: "report_it", action: "export" }] },
      { href: "/admin/report-it/new", icon: ShieldAlert, label: "Report It", permissions: [{ resource: "report_it", action: "create" }] },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSection[];

export const employeePortalNavigationSections = [
  {
    id: "employee-portal",
    items: [
      { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales", excludedRoles: ["Training Manager"], permissions: [{ resource: "sales" }], exact: true },
      { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/payslips", icon: ChartColumnBig, label: "Payroll & Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }], exact: true },
      { href: "/employee-portals/deductions", icon: ReceiptText, label: "Deductions", permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Outstation Expenses", permissions: [{ resource: "expenses" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Expense Dashboard", permissions: [{ resource: "expenses" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Submit Expense", permissions: [{ resource: "outstation", action: "create" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/employee-portals/team-expenses", icon: ReceiptText, label: "Team Expenses", permissions: [{ resource: "expenses" }], roles: ["National Sales Manager"] },
    ],
    label: "Medical Rep Portal",
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
    ],
    label: "Marketing Requests",
  },
  {
    id: "leave-management",
    items: [
      { href: "/leave-management/vacation-request", icon: CalendarDays, label: "Vacation Request", permissions: [{ resource: "leave", action: "create" }] },
      { href: "/leave-management/vacation-report", icon: FileSpreadsheet, label: "Vacation Report", permissions: [{ resource: "leave" }] },
      { href: "/leave-management/vacation-control", icon: Settings2, label: "Vacation Control", permissions: [{ resource: "leave", action: "update" }] },
      { href: "/leave-management/vacation-action-center", icon: ClipboardCheck, label: "Vacation Action Center", permissions: [{ resource: "leave" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Manager", "Finance Manager"] },
    ],
    label: "Leave Management",
  },
  {
    id: "attendance",
    items: [
      { href: "/employee-portals/attendance", icon: Fingerprint, label: "My Attendance", permissions: [{ resource: "attendance", action: "read" }] },
    ],
    label: "Attendance",
  },
  {
    id: "pharmacovigilance",
    items: [
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Report It", permissions: [{ resource: "report_it", action: "create" }] },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSection[];

export function getNavigationSections(mode: NavigationMode): readonly NavigationSection[] {
  return mode === "employee-portal" ? employeePortalNavigationSections : adminNavigationSections;
}
