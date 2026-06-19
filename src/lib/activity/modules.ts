// Maps an in-app route to a human-friendly "module" grouping. This is the single
// source of truth for how raw paths (e.g. "/sales/weekly/dashboard") are bucketed
// into the modules the Activity Control Center reports on (e.g. "Weekly Sales").
//
// Resolution is longest-prefix-wins, so specific routes ("/admin/report-it")
// always beat their parents ("/admin"). Keep this list aligned with
// src/config/system-navigation.ts when routes are added.

export type ActivityModule = {
  key: string;
  label: string;
};

type ModuleRule = {
  prefix: string;
  key: string;
  label: string;
};

// Ordered loosely specific→general for readability; resolution does not depend on
// array order (it picks the longest matching prefix).
const MODULE_RULES: ModuleRule[] = [
  // ── Admin: command center & governance ────────────────────────────────────
  { prefix: "/admin/activity-control", key: "activity_control", label: "Activity Control" },
  { prefix: "/admin/sales-command", key: "sales_command", label: "Sales Command" },
  { prefix: "/admin/sales-marketing-intelligence", key: "sales_marketing_intelligence", label: "Marketing ROI & Customer Intelligence" },
  { prefix: "/admin/data-health", key: "data_health", label: "Data Health" },
  { prefix: "/admin/system-cleanup", key: "system_cleanup", label: "System Cleanup" },
  { prefix: "/admin/monitoring", key: "monitoring", label: "Monitoring" },
  { prefix: "/admin/logs", key: "audit_logs", label: "Audit Logs" },
  { prefix: "/admin/access", key: "users_access", label: "Users & Access" },
  { prefix: "/admin/workflow-control", key: "workflow_control", label: "Workflow Control" },
  { prefix: "/admin/private-calendars", key: "private_calendars", label: "Private Calendars" },
  // ── Admin: people / HR ────────────────────────────────────────────────────
  { prefix: "/admin/weekly-plans", key: "weekly_plans", label: "Weekly / Monthly Plans" },
  { prefix: "/admin/field-workforce-compliance", key: "workforce_compliance", label: "Workforce Compliance" },
  { prefix: "/admin/deductions-governance", key: "deductions_governance", label: "Deductions Governance" },
  { prefix: "/admin/support-requests", key: "hr_support_requests", label: "HR Support Requests" },
  { prefix: "/admin/payslips-center", key: "payslips_center", label: "Payslips Center" },
  // ── Admin: sales / marketing / pharmacovigilance ──────────────────────────
  { prefix: "/admin/outstation", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/admin/double-visit-analytics", key: "double_visit_analytics", label: "Double Visit Analytics" },
  { prefix: "/admin/marketing-requests", key: "marketing_requests", label: "Marketing Requests" },
  { prefix: "/admin/report-it", key: "report_it", label: "Report It" },
  // ── Admin: communication ──────────────────────────────────────────────────
  { prefix: "/admin/email-templates", key: "email_templates", label: "Email Templates" },
  { prefix: "/admin/email-reply-composer", key: "email_composer", label: "Email Composer" },
  { prefix: "/admin/notifications/telegram", key: "telegram", label: "Telegram" },
  { prefix: "/admin", key: "command_center", label: "Command Center" },

  // ── People management ─────────────────────────────────────────────────────
  { prefix: "/employees", key: "employees", label: "Employees" },
  { prefix: "/organogram", key: "organogram", label: "Organogram" },
  { prefix: "/probation", key: "probation", label: "Probation" },
  { prefix: "/contracts", key: "contracts", label: "Contract Renewal" },
  { prefix: "/resignations", key: "resignations", label: "Resignations" },
  { prefix: "/reports/vacancies", key: "vacancies_report", label: "Vacancies Report" },

  // ── Recruitment & hiring ──────────────────────────────────────────────────
  { prefix: "/recruitment", key: "recruitment", label: "Recruitment" },
  { prefix: "/cv-database", key: "cv_database", label: "CV Database" },
  { prefix: "/offers", key: "offers", label: "Offer Lifecycle" },
  { prefix: "/hiring-documents", key: "hiring_documents", label: "Hiring Documents" },

  // ── Attendance & calendar ─────────────────────────────────────────────────
  { prefix: "/attendance", key: "attendance", label: "Attendance" },
  { prefix: "/hr-calendar", key: "hr_calendar", label: "HR Calendar" },

  // ── Leave ─────────────────────────────────────────────────────────────────
  { prefix: "/leave-management", key: "leave", label: "Leave Management" },

  // ── Payroll & expenses ────────────────────────────────────────────────────
  { prefix: "/payroll/expenses", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/payroll", key: "payroll", label: "Payroll" },
  { prefix: "/payslips", key: "payslips", label: "Payroll & Payslips" },

  // ── Sales operations ──────────────────────────────────────────────────────
  { prefix: "/sales/weekly", key: "weekly_sales", label: "Weekly Sales" },
  { prefix: "/sales/import", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/sales/database-mapping", key: "database_mapping", label: "Database Mapping" },
  { prefix: "/sales/missing-data", key: "sales_missing_data", label: "Missing Data" },
  { prefix: "/sales/normalizer", key: "source_normalizer", label: "Source Normalizer" },
  { prefix: "/sales/monthly-closing", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/sales/customer-directory", key: "customer_directory", label: "Customer Directory" },
  { prefix: "/sales/customer-mapping", key: "customer_mapping", label: "Customer Mapping" },
  { prefix: "/sales/queue", key: "monthly_sales", label: "Monthly Sales" },
  { prefix: "/sales-operations/mapping", key: "sales_ops_mapping", label: "Sales Ops Mapping" },
  { prefix: "/sales-operations/upload", key: "sales_ops_upload", label: "Sales Ops Upload" },
  { prefix: "/sales-operations/diagnostics", key: "sales_ops_diagnostics", label: "Sales Ops Diagnostics" },
  { prefix: "/sales-operations", key: "sales_operations", label: "Sales Operations" },
  { prefix: "/sales", key: "sales", label: "Sales Dashboard" },

  // ── Coaching ──────────────────────────────────────────────────────────────
  { prefix: "/coaching", key: "coaching", label: "Field Coaching" },

  // ── Employee portal ───────────────────────────────────────────────────────
  { prefix: "/employee-portals/report-it", key: "report_it", label: "Report It" },
  { prefix: "/employee-portals/marketing-requests", key: "marketing_requests", label: "Marketing Requests" },
  { prefix: "/employee-portals/sales", key: "portal_sales", label: "Sales (Portal)" },
  { prefix: "/employee-portals/monthly-closing", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/employee-portals/organogram", key: "organogram", label: "Organogram" },
  { prefix: "/employee-portals/vacancies", key: "vacancies_report", label: "Vacancies Report" },
  { prefix: "/employee-portals/probation", key: "probation", label: "Probation" },
  { prefix: "/employee-portals/training-manager", key: "coaching", label: "Field Coaching" },
  { prefix: "/employee-portals/coaching", key: "coaching", label: "Field Coaching" },
  { prefix: "/employee-portals/deductions", key: "portal_deductions", label: "Deductions" },
  { prefix: "/employee-portals/contact-hr-support", key: "hr_support_requests", label: "HR Support" },
  { prefix: "/employee-portals/expense-dashboard", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/employee-portals/team-expenses", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/employee-portals/submit-expense", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/employee-portals/expenses", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/employee-portals/attendance", key: "attendance", label: "Attendance" },
  { prefix: "/employee-portals/private-calendar", key: "private_calendars", label: "Private Calendar" },
  { prefix: "/employee-portals", key: "employee_portal", label: "Employee Portal" },

  // ── Auth / public ─────────────────────────────────────────────────────────
  { prefix: "/login", key: "login", label: "Login" },
];

export const OTHER_MODULE: ActivityModule = { key: "other", label: "Other" };

/** Strip query/hash, lowercase, and drop a trailing slash (except root). */
export function normalizeActivityPath(rawPath: string | null | undefined): string {
  let path = String(rawPath ?? "").trim();
  if (!path) return "/";
  // Drop query string and hash fragment.
  const queryIndex = path.search(/[?#]/);
  if (queryIndex >= 0) path = path.slice(0, queryIndex);
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.toLowerCase();
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  return path || "/";
}

export function resolveActivityModule(rawPath: string | null | undefined): ActivityModule {
  const path = normalizeActivityPath(rawPath);
  if (path === "/") return { key: "home", label: "Home" };

  let best: ModuleRule | null = null;
  for (const rule of MODULE_RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}/`)) {
      if (!best || rule.prefix.length > best.prefix.length) {
        best = rule;
      }
    }
  }

  return best ? { key: best.key, label: best.label } : { ...OTHER_MODULE };
}
