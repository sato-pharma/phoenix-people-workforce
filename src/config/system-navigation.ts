import {
  BellRing,
  BriefcaseBusiness,
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
  LayoutDashboard,
  Mail,
  MapPinned,
  Megaphone,
  Network,
  PlusCircle,
  Radar,
  ReceiptText,
  ScrollText,
  Settings2,
  ShieldCheck,
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
      { href: "/admin/monitoring", icon: Radar, label: "Monitoring", permissions: [{ resource: "admin" }] },
      { href: "/admin/logs", icon: ScrollText, label: "Audit Logs", permissions: [{ resource: "admin" }] },
    ],
    label: "Command Center",
  },
  {
    id: "people-management",
    items: [
      { href: "/employees", icon: UsersRound, label: "Employees", permissions: [{ resource: "employees" }] },
      { href: "/organogram", icon: Network, label: "Organogram", permissions: [{ resource: "organogram" }] },
      { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies Report", permissions: [{ resource: "vacancies" }] },
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
      { href: "/attendance/device-user-mapping", icon: Fingerprint, label: "Device User Mapping", excludedRoles: ["HR Specialist"], permissions: [{ resource: "employees", action: "update" }] },
      { href: "/attendance/policies", icon: CalendarClock, label: "Attendance Policies", excludedRoles: ["HR Specialist"], permissions: [{ resource: "employees", action: "update" }] },
      { href: "/hr-calendar", icon: CalendarDays, label: "HR Calendar", permissions: [{ resource: "hr_calendar" }] },
    ],
    label: "Attendance Management",
  },
  {
    id: "sales-performance",
    items: [
      { href: "/sales/import", icon: Database, label: "Source of Sales", permissions: [{ resource: "sales" }] },
      { href: "/sales/queue", icon: FileUp, label: "Monthly Sales", permissions: [{ resource: "sales" }] },
      { href: "/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales Dashboard", permissions: [{ resource: "sales" }] },
      { href: "/coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }] },
      { href: "/coaching/analytics", icon: ChartColumnBig, label: "Coaching Analytics", permissions: [{ resource: "coaching" }] },
    ],
    label: "Sales & Performance",
  },
  {
    id: "marketing-requests",
    items: [
      { href: "/admin/marketing-requests/validation", icon: ShieldCheck, label: "HCP / PH Validation", roles: ["District Manager", "SFE Manager", "Super Admin"] },
      { href: "/admin/marketing-requests", icon: Megaphone, label: "Marketing Requests", roles: ["District Manager", "SFE Manager", "Super Admin"] },
      { href: "/admin/marketing-requests/control", icon: Settings2, label: "Marketing Control", roles: ["District Manager", "SFE Manager", "Super Admin"] },
      { href: "/admin/marketing-requests/customer-database", icon: Database, label: "SCP / PH Database", roles: ["Super Admin"] },
    ],
    label: "Marketing Requests",
  },
  {
    id: "payroll",
    items: [
      { href: "/payroll", icon: FileSpreadsheet, label: "Payroll Report", permissions: [{ resource: "payroll" }] },
      { href: "/admin/payslips-center", icon: ScrollText, label: "Payslips Center", permissions: [{ resource: "payslips" }], roles: ["Super Admin"] },
      { href: "/payslips", icon: ScrollText, label: "My Payslips", permissions: [{ resource: "payslips" }], roles: ["HR Specialist"] },
    ],
    label: "Payroll Management",
  },
  {
    id: "expenses-outstation",
    items: [
      { href: "/payroll/expenses/dashboard", icon: ChartColumnBig, label: "Outstation Expenses", permissions: [{ resource: "expenses" }] },
      { href: "/payroll/expenses", icon: FileSpreadsheet, label: "Historical Upload", permissions: [{ resource: "expenses" }] },
      { href: "/admin/outstation/requests", icon: MapPinned, label: "Expense Requests", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
      { href: "/admin/outstation/requests?action=create-manager-expense", icon: PlusCircle, label: "Add Manual Expense", permissions: [{ resource: "outstation", action: "approve" }], roles: ["Super Admin", "Finance Manager", "CEO"] },
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
    ],
    label: "Leave Management",
  },
  {
    id: "access-communication",
    items: [
      { href: "/admin/access", icon: ShieldCheck, label: "Users & Access", permissions: [{ resource: "admin_access" }] },
      { href: "/admin/email-reply-composer", icon: Mail, label: "Email Composer", permissions: [{ resource: "communication" }] },
      { href: "/admin/email-templates", icon: BellRing, label: "Email Templates", permissions: [{ resource: "communication" }] },
      { href: "/admin/workflow-registry", icon: Settings2, label: "Workflow Registry", permissions: [{ resource: "workflow_registry" }], roles: ["Super Admin"] },
    ],
    label: "Access & Communication",
  },
] as const satisfies readonly NavigationSection[];

export const employeePortalNavigationSections = [
  {
    id: "employee-portal",
    items: [
      { href: "/employee-portals", icon: LayoutDashboard, label: "Overview", excludedRoles: ["Training Manager"], permissions: [{ resource: "employee_profile" }] },
      { href: "/employee-portals/sales", icon: ChartNoAxesColumnIncreasing, label: "Sales", excludedRoles: ["Training Manager"], permissions: [{ resource: "sales" }] },
      { href: "/employee-portals/training-manager", icon: ChartColumnBig, label: "Coaching Dashboard", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "Create Coaching Report", permissions: [{ resource: "coaching", action: "create" }], roles: ["Training Manager"] },
      { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching", permissions: [{ resource: "coaching" }], roles: ["Training Manager"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "My Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["Medical Rep"] },
      { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Team Coaching Reports", permissions: [{ resource: "coaching" }], roles: ["District Manager", "National Sales Manager"] },
      { href: "/payslips", icon: ChartColumnBig, label: "Payroll & Payslips", permissions: [{ resource: "payroll" }, { resource: "payslips" }] },
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
        label: "HCP / PH Validation",
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
        href: "/employee-portals/marketing-requests/control",
        icon: Settings2,
        label: "Marketing Control",
        roles: ["SFE Manager", "Super Admin"],
      },
      {
        href: "/employee-portals/marketing-requests/customer-database",
        icon: Database,
        label: "SCP / PH Database",
        roles: ["Super Admin"],
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
    ],
    label: "Leave Management",
  },
] as const satisfies readonly NavigationSection[];

export function getNavigationSections(mode: NavigationMode): readonly NavigationSection[] {
  return mode === "employee-portal" ? employeePortalNavigationSections : adminNavigationSections;
}
