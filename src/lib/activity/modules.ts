// Maps an in-app route to a human-friendly "module" grouping. This is the single
// source of truth for how raw paths (e.g. "/sales/weekly/dashboard") are bucketed
// into the modules the Activity Control Center reports on (e.g. "Weekly Sales").
//
// Three stages, in order:
//
//  1. SHELL STRIP. The same feature is served under several shells — "/admin",
//     "/hr", "/workspace", "/employee-portals" (and "/hr/admin/..." nests two).
//     The shell is stripped first, so "/admin/direct-orders" and
//     "/employee-portals/direct-orders" both report as ONE module, "Direct
//     Orders", instead of drowning inside "Command Center" / "Employee Portal".
//     A bare shell path ("/admin") still reports as the shell's own landing.
//
//  2. FEATURE RULES, longest-prefix-wins on what is left. Rules exist where the
//     route slug would read wrongly on its own, or where several routes are
//     genuinely one module. Keep the labels aligned with the sidebar names in
//     src/config/system-navigation.ts.
//
//  3. DERIVED NAME. Anything with no rule is named from its own path segments
//     (dynamic ids dropped, acronyms respected) rather than being dumped into
//     "Other" — so a page added tomorrow reports under its real name with no
//     edit here. "Other" is reserved for a path with no nameable segment at all.
//
// Resolution is pure and cheap, so the Activity Control Center re-resolves the
// stored path on READ. Rows written before a rule existed are re-labelled the
// moment this file changes; no backfill is needed.

import { isUuid } from "@/lib/http/uuid";

export type ActivityModule = {
  key: string;
  label: string;
};

type ModuleRule = {
  prefix: string;
  key: string;
  label: string;
  /**
   * Match this prefix ONLY as a whole path, never as a parent. Used for an area
   * root like "/sales", whose children ("/sales/diagnostics") are separate
   * modules in their own right rather than more of the landing page.
   */
  exact?: boolean;
};

/** Route prefixes that are a shell, not a module. Stripped before matching. */
const SHELL_RULES: ModuleRule[] = [
  { prefix: "/admin", key: "command_center", label: "Command Center" },
  { prefix: "/employee-portals", key: "employee_portal", label: "Employee Portal" },
  { prefix: "/workspace", key: "my_workspace", label: "My Workspace" },
  { prefix: "/hr", key: "hr_workspace", label: "HR Workspace" },
  { prefix: "/employee", key: "employee_portal", label: "Employee Portal" },
];

// Ordered loosely specific→general for readability; resolution does not depend on
// array order (it picks the longest matching prefix).
const MODULE_RULES: ModuleRule[] = [
  // ── Landings & governance ─────────────────────────────────────────────────
  { prefix: "/ceo-command-center", key: "ceo_command_center", label: "CEO Command Center" },
  { prefix: "/sfe-command-center", key: "sfe_command_center", label: "SFE Manager Overview" },
  { prefix: "/hr-command-center", key: "hr_command_center", label: "HR Command Center" },
  { prefix: "/finance-command-center", key: "finance_command_center", label: "Finance Overview" },
  { prefix: "/action-center", key: "action_center", label: "Action Center" },
  { prefix: "/overview", key: "overview", label: "Overview" },
  { prefix: "/activity-control", key: "activity_control", label: "Activity Control" },
  { prefix: "/company-activity-report", key: "activity_report", label: "Activity Report" },
  { prefix: "/access", key: "users_access", label: "Users & Access" },
  { prefix: "/access-communication", key: "users_access", label: "Users & Access" },
  { prefix: "/scope-visibility", key: "users_access", label: "Users & Access" },
  { prefix: "/module-locks", key: "users_access", label: "Users & Access" },
  { prefix: "/logs", key: "audit_logs", label: "Audit Logs" },
  // System Audit replaced Error Monitor, System Issues, Monitoring and Data Health on 23 Oct 2026.
  // Their old addresses redirect to it, so their history reads as System Audit too.
  { prefix: "/system-audit", key: "system_audit", label: "System Audit" },
  { prefix: "/error-monitor", key: "system_audit", label: "System Audit" },
  { prefix: "/system-issues", key: "system_audit", label: "System Audit" },
  { prefix: "/monitoring", key: "system_audit", label: "System Audit" },
  { prefix: "/data-health", key: "system_audit", label: "System Audit" },
  { prefix: "/notification-confidence", key: "monitoring", label: "Monitoring" },
  { prefix: "/synthetic-journeys", key: "monitoring", label: "Monitoring" },
  { prefix: "/workflow-control", key: "workflow_control", label: "Workflow Control" },
  { prefix: "/workflow-registry", key: "workflow_control", label: "Workflow Control" },
  { prefix: "/cron-control", key: "cron_control", label: "Cron Control" },
  { prefix: "/sidebar-layout", key: "sidebar_layout", label: "Sidebar Layout" },
  { prefix: "/dev-preview", key: "dev_preview", label: "Dev Preview" },
  { prefix: "/dev", key: "dev_preview", label: "Dev Preview" },
  { prefix: "/admin-tools", key: "admin_tools", label: "Admin Tools" },
  { prefix: "/master-data", key: "master_data", label: "Master Data" },
  { prefix: "/data-backup", key: "data_backup", label: "Data Backup" },
  { prefix: "/system-cleanup", key: "system_cleanup", label: "System Cleanup" },
  { prefix: "/profile", key: "profile", label: "My Profile" },

  // ── Approvals ─────────────────────────────────────────────────────────────
  { prefix: "/approvals", key: "approvals", label: "Approvals" },
  { prefix: "/approvals-hub", key: "approvals", label: "Approvals" },
  { prefix: "/approvals/direct-orders", key: "direct_orders", label: "Direct Orders" },
  { prefix: "/approvals/vacation", key: "leave", label: "Leave Management" },
  { prefix: "/approvals/vacation-day-work", key: "leave", label: "Leave Management" },
  { prefix: "/approvals/excuse", key: "excuses", label: "Excuses" },
  { prefix: "/approvals/plan", key: "plans", label: "Weekly / Monthly Plans" },
  { prefix: "/approvals/early-bird", key: "early_birds", label: "Early Birds" },

  // ── People & org ──────────────────────────────────────────────────────────
  { prefix: "/employees", key: "employees", label: "Employee Directory" },
  { prefix: "/people-management", key: "employees", label: "Employee Directory" },
  { prefix: "/employee-360", key: "employee_360", label: "Employee 360" },
  { prefix: "/customer-360", key: "customer_360", label: "Customer 360" },
  { prefix: "/organogram", key: "organogram", label: "Organogram" },
  { prefix: "/probation", key: "probation", label: "Probation" },
  { prefix: "/probation-tools", key: "probation", label: "Probation" },
  { prefix: "/probation-settings", key: "probation", label: "Probation" },
  { prefix: "/ceo-probation", key: "probation", label: "Probation" },
  { prefix: "/contracts", key: "contracts", label: "Contract Renewal" },
  { prefix: "/resignations", key: "resignations", label: "Resignations" },
  { prefix: "/retention", key: "retention", label: "Retention Register" },
  { prefix: "/reports/vacancies", key: "vacancies_report", label: "Vacancies Report" },
  { prefix: "/vacancies", key: "vacancies_report", label: "Vacancies Report" },
  { prefix: "/milestones", key: "milestones", label: "Milestones" },
  { prefix: "/spotlight", key: "spotlight", label: "Spotlight" },
  { prefix: "/business-cards", key: "business_cards", label: "Business Cards" },
  { prefix: "/devices", key: "devices", label: "Device Custody" },
  { prefix: "/support-requests", key: "hr_support", label: "HR Support" },
  { prefix: "/contact-hr-support", key: "hr_support", label: "HR Support" },
  { prefix: "/distribution-lists", key: "distribution_lists", label: "Distribution Lists" },
  { prefix: "/screening-questions", key: "screening_questions", label: "Screening Questions" },

  // ── Recruitment & hiring ──────────────────────────────────────────────────
  { prefix: "/recruitment", key: "recruitment", label: "Recruitment" },
  { prefix: "/recruitment-hiring", key: "recruitment", label: "Recruitment" },
  { prefix: "/recruitment/candidates", key: "my_candidates", label: "My Candidates" },
  { prefix: "/recruitment-candidates", key: "my_candidates", label: "My Candidates" },
  { prefix: "/recruitment/manager-engagement", key: "manager_cv_engagement", label: "Manager CV Engagement" },
  { prefix: "/recruitment-engagement", key: "manager_cv_engagement", label: "Manager CV Engagement" },
  { prefix: "/recruitment/interview-calendar", key: "interview_calendar", label: "Interview Calendar" },
  { prefix: "/interview-calendar", key: "interview_calendar", label: "Interview Calendar" },
  { prefix: "/recruitment/intake-health", key: "intake_health", label: "Intake Health" },
  { prefix: "/intake-health", key: "intake_health", label: "Intake Health" },
  { prefix: "/recruitment/contact-review", key: "contact_review", label: "Contact Review" },
  { prefix: "/contact-review", key: "contact_review", label: "Contact Review" },
  { prefix: "/cv-database", key: "cv_database", label: "CV Database" },
  // Its own key, never folded into cv_database above: they are two different authorities over the
  // same people — the database is the pool, CV Lookup is a search box for a seat that may not have
  // the pool (owner, 2026-09-30). Sharing a key would make "who opened the CV database" unanswerable.
  { prefix: "/cv-lookup", key: "cv_lookup", label: "CV Lookup" },
  { prefix: "/hiring-documents", key: "hiring_documents", label: "Hiring Documents" },
  { prefix: "/hiring-pack", key: "hr_forms", label: "HR Forms" },
  { prefix: "/offers", key: "offers", label: "Job Offers" },

  // ── Attendance & calendars ────────────────────────────────────────────────
  { prefix: "/attendance", key: "attendance", label: "Attendance" },
  { prefix: "/attendance/fingerprint-report", key: "fingerprint_report", label: "Fingerprint Report" },
  { prefix: "/fingerprint-report", key: "fingerprint_report", label: "Fingerprint Report" },
  { prefix: "/fingerprint-analytics", key: "fingerprint_report", label: "Fingerprint Report" },
  { prefix: "/hr-calendar", key: "company_calendar", label: "Company Calendar" },
  { prefix: "/hr-reminders", key: "hr_reminders", label: "HR Reminders" },
  { prefix: "/hr-reports", key: "hr_ops_reports", label: "Daily & Weekly Reports" },
  { prefix: "/company-calendar", key: "company_calendar", label: "Company Calendar" },
  { prefix: "/private-calendar", key: "private_calendars", label: "Private Calendars" },
  { prefix: "/private-calendars", key: "private_calendars", label: "Private Calendars" },
  { prefix: "/private-calendar-disputes", key: "private_calendars", label: "Private Calendars" },
  { prefix: "/team-calendar", key: "team_calendar", label: "Team Calendar" },
  { prefix: "/field-absence", key: "field_absence", label: "Field Absence Calendar" },
  { prefix: "/early-birds", key: "early_birds", label: "Early Birds" },
  { prefix: "/excuses", key: "excuses", label: "Excuses" },
  { prefix: "/field-workforce-compliance", key: "workforce_compliance", label: "Workforce Compliance" },

  // ── Leave ─────────────────────────────────────────────────────────────────
  { prefix: "/leave-management", key: "leave", label: "Leave Management" },
  { prefix: "/finance-leave-management", key: "leave", label: "Leave Management" },
  { prefix: "/vacation-request", key: "leave", label: "Leave Management" },
  { prefix: "/vacation-report", key: "leave", label: "Leave Management" },
  { prefix: "/vacation-control", key: "leave", label: "Leave Management" },

  // ── Payroll, payslips & expenses ──────────────────────────────────────────
  { prefix: "/payroll", key: "payroll", label: "Payroll" },
  { prefix: "/payroll-management", key: "payroll", label: "Payroll" },
  { prefix: "/payroll-copilot", key: "payroll", label: "Payroll" },
  { prefix: "/automated-payroll", key: "payroll", label: "Payroll" },
  { prefix: "/m-payroll", key: "payroll", label: "Payroll" },
  { prefix: "/payslips", key: "payslips", label: "Payslips" },
  { prefix: "/payslips-center", key: "payslips", label: "Payslips" },
  { prefix: "/deductions", key: "deductions", label: "Deductions" },
  { prefix: "/daily-deductions", key: "deductions", label: "Deductions" },
  { prefix: "/incentive", key: "incentive", label: "Incentive" },
  { prefix: "/outstation", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/outstation-expenses", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/expenses", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/expense-dashboard", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/expense-submissions", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/submit-expense", key: "outstation", label: "Outstation Expenses" },
  { prefix: "/team-expenses", key: "outstation", label: "Outstation Expenses" },

  // ── Sales ─────────────────────────────────────────────────────────────────
  { prefix: "/sales", key: "sales", label: "Sales Dashboard", exact: true },
  { prefix: "/sales/weekly", key: "weekly_sales", label: "Weekly Sales" },
  { prefix: "/sales/weekly-tools", key: "weekly_sales", label: "Weekly Sales" },
  { prefix: "/weekly-sales", key: "weekly_sales", label: "Weekly Sales" },
  { prefix: "/field-sales/weekly-sales", key: "weekly_sales", label: "Weekly Sales" },
  { prefix: "/sales/weekly/stock", key: "weekly_stock", label: "Weekly Stock" },
  { prefix: "/weekly-stock", key: "weekly_stock", label: "Weekly Stock" },
  { prefix: "/sales/monthly-closing", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/monthly-closing", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/analytics/monthly-closing", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/sales-analytics/monthly-closing", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/sales/closing-corrections", key: "monthly_closing", label: "Monthly Closing" },
  { prefix: "/sales/import", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/sales/upload", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/sales/source-of-sales-tools", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/source-of-sales", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/field-sales/source-of-sales", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/sales-analytics/source-sales", key: "source_of_sales", label: "Source of Sales" },
  { prefix: "/sales/normalizer", key: "source_normalizer", label: "Source Normalizer" },
  { prefix: "/sales/database-mapping", key: "database_mapping", label: "Database Mapping" },
  { prefix: "/sales/mapping-database", key: "database_mapping", label: "Database Mapping" },
  { prefix: "/sales/customer-mapping", key: "customer_mapping", label: "Customer Mapping" },
  { prefix: "/customer-pharmacy-mapping", key: "customer_mapping", label: "Customer Mapping" },
  { prefix: "/sales/customer-directory", key: "customers_database", label: "Customers Database" },
  { prefix: "/customers-database", key: "customers_database", label: "Customers Database" },
  { prefix: "/customer-database", key: "customers_database", label: "Customers Database" },
  { prefix: "/pharmacy-master", key: "pharmacy_master", label: "Pharmacy Master" },
  { prefix: "/pharmacy-search", key: "pharmacy_master", label: "Pharmacy Master" },
  { prefix: "/sales/missing-data", key: "sales_missing_data", label: "Missing Data" },
  { prefix: "/sales/targets", key: "targets", label: "Targets" },
  { prefix: "/targets", key: "targets", label: "Targets" },
  { prefix: "/sales/vs-target", key: "sales_vs_target", label: "Sales vs Target" },
  { prefix: "/sales-vs-target", key: "sales_vs_target", label: "Sales vs Target" },
  { prefix: "/vs-target", key: "sales_vs_target", label: "Sales vs Target" },
  { prefix: "/sales/territory-management", key: "territory_management", label: "Territory Management" },
  { prefix: "/territory-management", key: "territory_management", label: "Territory Management" },
  { prefix: "/territory-drilldown", key: "sales_drilldown", label: "Sales Drilldown" },
  { prefix: "/sales/make-it-happen", key: "make_it_happen", label: "Make It Happen" },
  { prefix: "/make-it-happen", key: "make_it_happen", label: "Make It Happen" },
  { prefix: "/sales-analytics", key: "sales_analytics", label: "Sales Analytics" },
  { prefix: "/monthly-dashboard", key: "sales_analytics", label: "Sales Analytics" },
  { prefix: "/business-review", key: "business_review", label: "Business Review" },
  { prefix: "/business-review-s1", key: "business_review", label: "Business Review" },
  { prefix: "/direct-orders", key: "direct_orders", label: "Direct Orders" },
  { prefix: "/direct-orders-in-my-area", key: "direct_orders", label: "Direct Orders" },
  { prefix: "/pm-products", key: "pm_products", label: "PM Products" },
  { prefix: "/visual-aids", key: "visual_aids", label: "Visual Aids" },
  { prefix: "/market-awareness", key: "market_awareness", label: "Market Awareness" },
  { prefix: "/marketing-functions", key: "marketing_functions", label: "Marketing Functions" },
  { prefix: "/marketing-feedback", key: "marketing_field_feedback", label: "Marketing Field Feedback" },

  // ── Marketing ─────────────────────────────────────────────────────────────
  { prefix: "/marketing-requests", key: "marketing_requests", label: "Marketing Requests" },
  { prefix: "/archived-marketing-requests", key: "marketing_requests", label: "Marketing Requests" },
  { prefix: "/marketing-roi", key: "marketing_roi", label: "Marketing ROI" },
  { prefix: "/marketing-roi-report", key: "marketing_roi", label: "Marketing ROI" },
  { prefix: "/marketing-roi-tracker", key: "marketing_roi", label: "Marketing ROI" },
  { prefix: "/roi", key: "marketing_roi", label: "Marketing ROI" },
  { prefix: "/roi-tracker", key: "marketing_roi", label: "Marketing ROI" },
  { prefix: "/sales-marketing-intelligence", key: "marketing_roi", label: "Marketing ROI" },

  // ── Field force & CRM ─────────────────────────────────────────────────────
  { prefix: "/crm", key: "crm", label: "CRM" },
  { prefix: "/crm-tools", key: "crm", label: "CRM" },
  { prefix: "/crm-integrity", key: "crm", label: "CRM" },
  { prefix: "/field-crm", key: "phoenix_crm", label: "Phoenix CRM" },
  { prefix: "/phoenix-crm", key: "phoenix_crm", label: "Phoenix CRM" },
  { prefix: "/visits", key: "visits", label: "Visits" },
  { prefix: "/visit-entry", key: "visits", label: "Visits" },
  { prefix: "/verified-captures", key: "verified_captures", label: "Verified Captures" },
  { prefix: "/doctor-coverage", key: "doctor_coverage", label: "Doctor Coverage" },
  { prefix: "/doctor-coverage-settings", key: "doctor_coverage", label: "Doctor Coverage" },
  { prefix: "/doctor-list", key: "doctor_coverage", label: "Doctor Coverage" },
  { prefix: "/doctor-list-changes", key: "doctor_coverage", label: "Doctor Coverage" },
  { prefix: "/rep-doctor-lists", key: "doctor_coverage", label: "Doctor Coverage" },
  { prefix: "/my-list", key: "doctor_coverage", label: "Doctor Coverage" },
  { prefix: "/brick-coverage", key: "brick_coverage", label: "Brick Coverage" },
  { prefix: "/double-visit-analytics", key: "double_visit", label: "Double Visit" },
  { prefix: "/double-visit-report", key: "double_visit", label: "Double Visit" },
  { prefix: "/double-visit-data-integrity", key: "double_visit", label: "Double Visit" },
  { prefix: "/dv-planner", key: "double_visit", label: "Double Visit" },
  { prefix: "/kpis", key: "kpis", label: "KPIs" },
  { prefix: "/reps-list", key: "reps_list", label: "Reps List" },
  { prefix: "/plans", key: "plans", label: "Weekly / Monthly Plans" },
  { prefix: "/reps-plans", key: "plans", label: "Weekly / Monthly Plans" },
  { prefix: "/weekly-plans", key: "plans", label: "Weekly / Monthly Plans" },
  { prefix: "/plan-verification", key: "plans", label: "Weekly / Monthly Plans" },
  { prefix: "/team-performance", key: "team_performance", label: "Team Performance" },
  { prefix: "/med-reps-performance", key: "team_performance", label: "Team Performance" },
  { prefix: "/dsms-performance", key: "team_performance", label: "Team Performance" },
  { prefix: "/field-sales/med-reps-performance", key: "team_performance", label: "Team Performance" },
  { prefix: "/field-sales/dsm-performance", key: "team_performance", label: "Team Performance" },
  { prefix: "/coaching", key: "coaching", label: "Field Coaching" },
  { prefix: "/field-coaching", key: "coaching", label: "Field Coaching" },
  { prefix: "/coaching-analytics", key: "coaching", label: "Field Coaching" },
  { prefix: "/training-manager", key: "coaching", label: "Field Coaching" },

  // ── Pharmacovigilance & Report It ─────────────────────────────────────────
  { prefix: "/report-it", key: "report_it", label: "Report It" },
  { prefix: "/pharmacovigilance", key: "pharmacovigilance", label: "Pharmacovigilance" },

  // ── Email, Telegram & mailboxes ───────────────────────────────────────────
  { prefix: "/notifications/telegram", key: "telegram", label: "Telegram" },
  { prefix: "/notifications/email", key: "email", label: "Email" },
  { prefix: "/notifications/email-tracking", key: "email", label: "Email" },
  { prefix: "/email-templates", key: "email", label: "Email" },
  { prefix: "/email-reply-composer", key: "email", label: "Email" },
  { prefix: "/email-control-center", key: "email", label: "Email" },
  { prefix: "/email-notifications", key: "email", label: "Email" },
  { prefix: "/notification-recipients", key: "email", label: "Email" },
  { prefix: "/notification-types", key: "email", label: "Email" },
  { prefix: "/sato-email", key: "sato_email", label: "Sato Email Composer" },
  { prefix: "/mailbox-monitor", key: "mailbox_monitor", label: "Mailbox Monitor" },
  { prefix: "/mailbox-offboarding", key: "mailbox_revocation", label: "Mailbox Revocation" },
  { prefix: "/new-hire-mailboxes", key: "new_hire_mailboxes", label: "New Hire Mailboxes" },
  { prefix: "/whatsapp-connect", key: "whatsapp", label: "WhatsApp" },

  // ── Auth / public ─────────────────────────────────────────────────────────
  { prefix: "/login", key: "login", label: "Login" },
  { prefix: "/password-setup", key: "login", label: "Login" },
  { prefix: "/privacy", key: "public_pages", label: "Public Pages" },
  { prefix: "/terms", key: "public_pages", label: "Public Pages" },
  { prefix: "/share", key: "shared_links", label: "Shared Links" },
  { prefix: "/print", key: "print", label: "Print" },
];

export const OTHER_MODULE: ActivityModule = { key: "other", label: "Other" };

/**
 * First segments that are an AREA rather than a module, so a derived name takes
 * two segments ("/sales/diagnostics" → "Sales · Diagnostics", not "Sales").
 */
const AREA_SEGMENTS = new Set([
  "analytics",
  "approvals",
  "attendance",
  "coaching",
  "devices",
  "direct-orders",
  "field-sales",
  "leave-management",
  "marketing-requests",
  "master-data",
  "notifications",
  "outstation",
  "payroll-copilot",
  "phoenix-crm",
  "plans",
  "probation",
  "recruitment",
  "reports",
  "sales",
  "sales-analytics",
  "spotlight",
  "training-manager",
  "weekly-plans",
]);

/** Words that must not be title-cased letter-by-letter when a name is derived. */
const ACRONYMS: Record<string, string> = {
  ai: "AI",
  am: "AM",
  bi: "BI",
  ceo: "CEO",
  crm: "CRM",
  cv: "CV",
  cvs: "CVs",
  dm: "DM",
  dsm: "DSM",
  dsms: "DSMs",
  dv: "DV",
  hr: "HR",
  id: "ID",
  ip: "IP",
  it: "IT",
  kpi: "KPI",
  kpis: "KPIs",
  nsm: "NSM",
  pm: "PM",
  pms: "PMs",
  pv: "PV",
  qa: "QA",
  roi: "ROI",
  rsm: "RSM",
  s1: "S1",
  s2: "S2",
  sfe: "SFE",
  sos: "SoS",
  ui: "UI",
};

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

/**
 * A path segment carrying an identity rather than a name: a uuid, a row number,
 * an HR_ID ("b-10", "ai-0007"), a date, or a Next.js dynamic placeholder. These
 * are dropped before a module name is derived, so one person's Employee 360 page
 * never becomes its own module.
 */
function isDynamicSegment(segment: string): boolean {
  if (!segment) return true;
  if (segment.startsWith("[")) return true;
  if (/^\d+$/.test(segment)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(segment)) return true;
  if (isUuid(segment)) return true;
  if (/^[0-9a-f]{24,}$/.test(segment)) return true;
  if (/^[a-z]{1,3}-\d{1,6}$/.test(segment)) return true; // HR_ID: b-10, ai-0007
  return false;
}

function titleSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((word) => ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Peel every shell prefix off a path. Returns the innermost shell it sat in. */
function splitShell(path: string): { shell: ModuleRule | null; rest: string } {
  let rest = path;
  let shell: ModuleRule | null = null;

  for (;;) {
    const match = SHELL_RULES.find((rule) => rest === rule.prefix || rest.startsWith(`${rule.prefix}/`));
    if (!match) break;
    shell = match;
    rest = rest.slice(match.prefix.length) || "/";
    if (rest === "/") break;
  }

  return { shell, rest };
}

function matchRule(path: string): ModuleRule | null {
  let best: ModuleRule | null = null;
  for (const rule of MODULE_RULES) {
    if (path === rule.prefix || (!rule.exact && path.startsWith(`${rule.prefix}/`))) {
      if (!best || rule.prefix.length > best.prefix.length) {
        best = rule;
      }
    }
  }
  return best;
}

/** Name a route that has no rule, from its own segments. */
function deriveModule(path: string): ActivityModule | null {
  const segments = path.split("/").filter((segment) => segment && !isDynamicSegment(segment));
  if (segments.length === 0) return null;

  const take = AREA_SEGMENTS.has(segments[0]) && segments.length > 1 ? 2 : 1;
  const used = segments.slice(0, take);

  return {
    key: used.join("_").replace(/-/g, "_"),
    label: used.map(titleSegment).join(" · "),
  };
}

export function resolveActivityModule(rawPath: string | null | undefined): ActivityModule {
  const path = normalizeActivityPath(rawPath);
  if (path === "/") return { key: "home", label: "Home" };

  const { shell, rest } = splitShell(path);

  const rule = matchRule(rest);
  if (rule) return { key: rule.key, label: rule.label };

  // A bare shell path ("/admin", "/employee-portals") is the shell's own landing.
  if (rest === "/") {
    return shell ? { key: shell.key, label: shell.label } : { key: "home", label: "Home" };
  }

  const derived = deriveModule(rest);
  if (derived) return derived;

  // Nothing nameable is left (e.g. "/employee-portals/8f1c…"): fall back to the
  // shell it sat in before giving up on "Other".
  if (shell) return { key: shell.key, label: shell.label };
  return { ...OTHER_MODULE };
}
