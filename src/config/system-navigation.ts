import {
  Activity,
  BellRing,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
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
  LifeBuoy,
  Mail,
  MapPin,
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
  Tags,
  TriangleAlert,
  Trash2,
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
    id: "command-center",
    items: [
      { href: "/admin", icon: LayoutDashboard, label: "Command Center", permissions: [{ resource: "admin" }, { resource: "overview" }] },
      { href: "/admin/data-health", icon: Database, label: "Data Health", permissions: [{ resource: "admin" }] },
      { href: "/admin/system-cleanup", icon: Trash2, label: "System Cleanup", roles: ["Super Admin"] },
      { href: "/admin/monitoring", icon: Radar, label: "Monitoring", permissions: [{ resource: "admin" }] },
      { href: "/admin/logs", icon: ScrollText, label: "Audit Logs", permissions: [{ resource: "admin" }] },
      { href: "/admin/activity-control", icon: Activity, label: "Activity Control", permissions: [{ resource: "user_activity", action: "read" }], roles: ["Super Admin"] },
    ],
    label: "Command Center",
  },
  {
    id: "people-management",
    items: [
      { href: "/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees" }] },
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
      { href: "/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation" }] },
      { href: "/contracts", icon: CalendarClock, label: "Contract Renewal", permissions: [{ resource: "contracts" }] },
      { href: "/resignations", icon: FileSpreadsheet, label: "Resignations", permissions: [{ resource: "resignations" }] },
      { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
      { href: "/admin/weekly-plans", icon: CalendarDays, label: "Weekly / Monthly Plans", permissions: [{ resource: "weekly_plans" }] },
      { href: "/admin/field-workforce-compliance", icon: ClipboardCheck, label: "Workforce Compliance", permissions: [{ resource: "hr_calendar" }] },
      { href: "/admin/deductions-governance", icon: ShieldCheck, label: "Deductions Governance", permissions: [{ resource: "deductions", action: "read" }] },
      { href: "/admin/support-requests", icon: LifeBuoy, label: "HR Support Requests", permissions: [{ resource: "support_requests" }] },
    ],
    label: "People Management",
  },
  {
    id: "recruitment-hiring",
    items: [
      { href: "/recruitment", icon: BriefcaseBusiness, label: "Recruitment", permissions: [{ resource: "recruitment" }] },
      { href: "/cv-database", icon: FileSpreadsheet, label: "CV Database", permissions: [{ resource: "vacancies" }] },
      { href: "/offers", icon: IdCard, label: "Offer Lifecycle", permissions: [{ resource: "offers" }] },
      { href: "/hiring-documents", icon: FileCheck2, label: "Hiring Documents", permissions: [{ resource: "employee_documents" }] },
    ],
    label: "Recruitment & Hiring",
  },
  {
    id: "attendance-management",
    items: [
      { href: "/attendance/fingerprint-report", icon: FileSpreadsheet, label: "My Attendance", permissions: [{ resource: "employees" }] },
      { href: "/attendance/monthly-summary", icon: CalendarCheck, label: "Monthly Summary", permissions: [{ resource: "employees" }] },
      { href: "/attendance/analytics", icon: ChartColumnBig, label: "Attendance Analytics", permissions: [{ resource: "employees" }] },
      { href: "/attendance/exceptions", icon: ShieldCheck, label: "Attendance Exceptions", permissions: [{ resource: "attendance", action: "read" }] },
      { href: "/admin/private-calendars", icon: CalendarDays, label: "Private Calendars", permissions: [{ resource: "attendance", action: "read" }], roles: ["CEO", "Super Admin"] },
      { href: "/attendance/device-user-mapping", icon: Fingerprint, label: "Device User Mapping", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/attendance/policies", icon: CalendarClock, label: "Attendance Policies", permissions: [{ resource: "employees", action: "update" }] },
      { href: "/hr-calendar", icon: CalendarDays, label: "HR Calendar", permissions: [{ resource: "hr_calendar" }] },
    ],
    label: "Attendance Management",
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
      { href: "/admin/outstation/expense-command?tab=queue", icon: MapPinned, label: "Expense Requests", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"], activeTab: "queue" },
      { href: "/admin/outstation/expense-command?tab=queue&action=create-manager-expense", icon: PlusCircle, label: "Add Manual Expense", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"], activeTab: "create-manager-expense" },
      { href: "/admin/outstation/policy", icon: CalendarClock, label: "Outstation Policy", permissions: [{ resource: "outstation", action: "update" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
      { href: "/admin/outstation/expense-command", icon: Radar, label: "Expense Command Center", permissions: [{ resource: "outstation", action: "read" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
    ],
    label: "Outstation Expenses",
  },
  {
    id: "sales-operations",
    items: [
      { href: "/sales/import", icon: Database, label: "Source of Sales", permissions: [{ resource: "sales" }] },
      { href: "/sales/database-mapping", icon: Database, label: "Database Mapping", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/missing-data", icon: TriangleAlert, label: "Missing Data", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/normalizer", icon: Sparkles, label: "Source Normalizer", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/monthly-closing", icon: ChartColumnBig, label: "Monthly Closing", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/customer-directory", icon: UsersRound, label: "Customer Directory", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/sales/customer-mapping", icon: MapPinned, label: "Customer Mapping", permissions: [{ action: "import", resource: "sales" }] },
      { href: "/admin/double-visit-analytics", icon: Activity, label: "Double Visit Analytics", permissions: [{ resource: "double_visit_analytics", action: "read" }] },
    ],
    label: "Sales Operations",
  },
  {
    id: "old-sales-queue",
    items: [
      { href: "/sales/queue", icon: FileUp, label: "Monthly Sales", permissions: [{ resource: "sales" }] },
      { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales Dashboard", permissions: [{ resource: "sales" }], exact: true },
    ],
    label: "Old Sales Queue",
  },
  {
    id: "weekly-sales",
    items: [
      { href: "/sales/weekly", icon: FileUp, label: "Weekly Sales Upload", permissions: [{ action: "import", resource: "weekly_sales" }] },
      { href: "/sales/weekly/dashboard", icon: ChartNoAxesColumnIncreasing, label: "Weekly Sales Dashboard", permissions: [{ resource: "weekly_sales" }] },
      { href: "/sales/weekly/branch-mapping", icon: MapPin, label: "Branch Region Mapping", permissions: [{ action: "update", resource: "weekly_sales" }] },
      { href: "/sales/weekly/product-mapping", icon: Tags, label: "Product Mapping", permissions: [{ action: "update", resource: "weekly_sales" }] },
      { href: "/sales/weekly/missing-products", icon: TriangleAlert, label: "Missing Products", permissions: [{ action: "update", resource: "weekly_sales" }] },
      { href: "/sales/weekly/assignments", icon: UsersRound, label: "Weekly Product Access", permissions: [{ action: "update", resource: "weekly_sales" }] },
    ],
    label: "Weekly Sales",
  },
  {
    id: "field-coaching",
    items: [
      { href: "/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
      { href: "/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }] },
    ],
    label: "Field Coaching",
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
      { href: "/admin/report-it", icon: ShieldAlert, label: "Reports Dashboard", roles: ["Super Admin"] },
      { href: "/admin/report-it/new", icon: ShieldAlert, label: "Report It" },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSection[];

export const employeePortalNavigationSections = [
  {
    id: "employee-portal",
    items: [
      { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/private-calendar", icon: CalendarCheck, label: "Private Calendar", permissions: [{ resource: "employee_profile" }] },
      { href: "/employee-portals/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales", excludedRoles: ["Training Manager"], permissions: [{ resource: "sales" }], exact: true },
      { href: "/employee-portals/monthly-closing", icon: CalendarRange, label: "Monthly Closing", permissions: [{ resource: "sales" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"] },
      { href: "/employee-portals/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram", action: "read" }], roles: ["National Sales Manager", "Product Manager", "Group Product Manager"] },
      { href: "/employee-portals/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies", action: "read" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager"] },
      { href: "/employee-portals/probation", icon: Hourglass, label: "Probation", permissions: [{ resource: "probation", action: "read" }], roles: ["District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Manager"] },
      { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/payslips", icon: ChartColumnBig, label: "Payroll & Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }], exact: true },
      { href: "/employee-portals/deductions", icon: ReceiptText, label: "Deductions", permissions: [{ resource: "employee_profile" }], exact: true },
      { href: "/employee-portals/contact-hr-support", icon: LifeBuoy, label: "HR Support", permissions: [{ resource: "support_requests", action: "read" }] },
      { href: "/employee-portals/expenses", icon: ReceiptText, label: "My Outstation Expenses", permissions: [{ resource: "expenses" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/expense-dashboard", icon: ReceiptText, label: "Expense Dashboard", permissions: [{ resource: "expenses" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager", "Training Manager", "Manager"] },
      { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Submit Expense", permissions: [{ resource: "outstation", action: "create" }], roles: ["District Manager", "National Sales Manager", "Product Manager", "Group Product Manager"] },
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
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Reports Dashboard", roles: ["Manager"] },
      { href: "/employee-portals/report-it", icon: ShieldAlert, label: "Report It", excludedRoles: ["Manager"] },
    ],
    label: "Pharmacovigilance",
  },
] as const satisfies readonly NavigationSection[];

export function getNavigationSections(mode: NavigationMode): readonly NavigationSection[] {
  return mode === "employee-portal" ? employeePortalNavigationSections : adminNavigationSections;
}
