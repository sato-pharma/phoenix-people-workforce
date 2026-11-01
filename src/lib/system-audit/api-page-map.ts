/**
 * Which screen calls an API — so an error logged against `/api/...` can still be named by the
 * sidebar module the person was using.
 *
 * A server error carries the address of the REQUEST, and for anything a page fetches that is an API
 * route, which no sidebar row names. The audit tries the person's own page trail first (their last
 * page view before the error); this map is the fallback when there is none — a prefix of the API
 * tree, and the page that calls it in each shell. It is PROBABLE by nature, which is why the label
 * it produces is stored with source `api_map`, never `nav_exact`.
 *
 * Prefix granularity on purpose: a longest-prefix match over ~200 lines covers 1,189 route files,
 * and a new route under a known prefix needs no edit. A new TOP-LEVEL prefix does, and
 * tests/system-audit-api-page-map.test.ts walks `app/api` and fails until every route is either
 * mapped here or listed in API_NO_UI with the reason no screen owns it.
 */

export type ApiPageTargets = {
  /** The admin-shell page that calls it. */
  admin?: `/${string}`;
  /** The `/hr` seat's page, authored under the prefix the way the HR rail is. */
  hr?: `/hr${string}`;
  /** The employee-portal page. */
  portal?: `/employee-portals${string}`;
};

/** API prefix → the page(s) that call it. Longest prefix wins, on whole path segments. */
export const API_PAGE_MAP: Readonly<Record<string, ApiPageTargets>> = {
  // ── /api/admin — one admin page per tool ────────────────────────────────────────────────────────
  "/api/admin/activity": { admin: "/admin/activity-control" },
  "/api/admin/business-card-requests": { admin: "/admin/business-card-requests", hr: "/hr/admin/business-card-requests" },
  "/api/admin/ceo-email": { admin: "/admin/ceo-email" },
  "/api/admin/crm": { admin: "/admin/crm" },
  "/api/admin/daily-deductions": { admin: "/admin/daily-deductions" },
  "/api/admin/data-backup": { admin: "/admin/data-backup" },
  "/api/admin/deductions": { admin: "/admin/deductions", hr: "/hr/admin/deductions" },
  "/api/admin/distribution-lists": { admin: "/admin/distribution-lists" },
  "/api/admin/double-visit-analytics": { admin: "/admin/double-visit-analytics" },
  "/api/admin/email-ai": { admin: "/admin/email-reply-composer" },
  "/api/admin/email-aliases": { admin: "/admin/email-control-center" },
  "/api/admin/email-composer": { admin: "/admin/email-reply-composer" },
  "/api/admin/email-control-center": { admin: "/admin/email-control-center" },
  "/api/admin/email-notifications": { admin: "/admin/notifications/email" },
  "/api/admin/email-reply": { admin: "/admin/email-reply-composer" },
  "/api/admin/email-templates": { admin: "/admin/email-templates" },
  "/api/admin/field-activity": { admin: "/admin/field-activity", portal: "/employee-portals/field-activity" },
  "/api/admin/field-workforce-compliance": { admin: "/admin/field-workforce-compliance" },
  "/api/admin/logs": { admin: "/admin/logs" },
  "/api/admin/mailbox-monitor": { admin: "/admin/mailbox-monitor" },
  "/api/admin/module-locks": { admin: "/admin/module-locks" },
  "/api/admin/notification-confidence": { admin: "/admin/notification-confidence" },
  "/api/admin/notification-recipients": { admin: "/admin/notification-recipients" },
  "/api/admin/notifications": { admin: "/admin/notifications/telegram" },
  "/api/admin/outstation": { admin: "/admin/outstation/expense-command" },
  "/api/admin/permissions": { admin: "/admin/access" },
  "/api/admin/pharmacy-search": { admin: "/admin/pharmacy-search" },
  "/api/admin/phoenix-crm": { admin: "/admin/field-crm" },
  "/api/admin/pm-products": { admin: "/admin/pm-products" },
  "/api/admin/question-prompts": { admin: "/admin/screening-questions", hr: "/hr/admin/screening-questions" },
  "/api/admin/salary-flags": { admin: "/admin/system-audit" },
  "/api/admin/sato-email": { admin: "/admin/sato-email" },
  "/api/admin/scope-visibility": { admin: "/admin/scope-visibility" },
  "/api/admin/screening-questions": { admin: "/admin/screening-questions", hr: "/hr/admin/screening-questions" },
  "/api/admin/seat-view": { admin: "/admin/view-as-seat" },
  "/api/admin/sentry-check": { admin: "/admin/sentry-check" },
  "/api/admin/support-requests": { admin: "/admin/support-requests", hr: "/hr/admin/support-requests" },
  "/api/admin/synthetic-journeys": { admin: "/admin/synthetic-journeys" },
  "/api/admin/system-audit": { admin: "/admin/system-audit" },
  "/api/admin/system-cleanup": { admin: "/admin/system-cleanup" },
  "/api/admin/test-accounts": { admin: "/admin/test-accounts" },
  "/api/admin/users": { admin: "/admin/access" },
  "/api/admin/visits-report": { admin: "/admin/phoenix-crm/visit-report" },
  "/api/admin/whatsapp-auto-replies": { admin: "/recruitment/whatsapp-replies", hr: "/hr/recruitment/whatsapp-replies" },
  "/api/admin/workflow-control": { admin: "/admin/workflow-control" },
  "/api/admin/workflow-registry": { admin: "/admin/workflow-control" },

  // ── Approvals ───────────────────────────────────────────────────────────────────────────────────
  "/api/approvals/direct-orders": { admin: "/admin/direct-orders", portal: "/employee-portals/direct-orders" },
  "/api/approvals/early-bird": { admin: "/admin/early-birds", portal: "/employee-portals/early-birds" },
  "/api/approvals/excuse": { admin: "/admin/approvals/excuse", portal: "/employee-portals/approvals/excuse" },
  "/api/approvals/plan": { admin: "/admin/approvals/plan", portal: "/employee-portals/approvals/plan" },
  "/api/approvals/vacation": { admin: "/admin/approvals/vacation", portal: "/employee-portals/approvals/vacation" },
  "/api/approvals-hub": { admin: "/admin/approvals-hub", portal: "/employee-portals/approvals-hub" },

  // ── Attendance ──────────────────────────────────────────────────────────────────────────────────
  "/api/attendance": { admin: "/attendance/monthly-summary", hr: "/hr/attendance/monthly-summary", portal: "/employee-portals/fingerprint-analytics" },
  "/api/attendance/device-user-mappings": { admin: "/attendance/device-user-mapping", hr: "/hr/attendance/device-user-mapping" },
  "/api/attendance/disputes": { admin: "/attendance/disputes" },
  "/api/attendance/employee-day-report": { admin: "/attendance/employee-day-report" },
  "/api/attendance/exceptions": { admin: "/attendance/exceptions" },
  "/api/attendance/fingerprint-report": { admin: "/attendance/fingerprint-report", hr: "/hr/attendance/fingerprint-report" },
  "/api/attendance/holiday-calendar": { admin: "/attendance/holiday-calendar", hr: "/hr/attendance/holiday-calendar" },
  "/api/attendance/monthly-summary": { admin: "/attendance/monthly-summary", hr: "/hr/attendance/monthly-summary" },
  "/api/attendance/policies": { admin: "/attendance/policies", hr: "/hr/attendance/policies" },
  "/api/attendance/weekly-review": { admin: "/attendance/weekly-review" },

  // ── Payroll, deductions, disputes ───────────────────────────────────────────────────────────────
  "/api/automated-payroll": { admin: "/admin/automated-payroll" },
  "/api/automated-payroll/finance": { admin: "/admin/automated-payroll/finance" },
  "/api/payroll": { admin: "/payroll", hr: "/hr/payroll" },
  "/api/payroll/copilot": { admin: "/admin/payroll-copilot" },
  "/api/deductions": { admin: "/admin/deductions", hr: "/hr/admin/deductions", portal: "/employee-portals/deductions" },
  "/api/dispute-center": { admin: "/admin/disputes", portal: "/employee-portals/disputes" },

  // ── People, HR papers, recruitment ──────────────────────────────────────────────────────────────
  "/api/employees": { admin: "/employees", hr: "/hr/employees" },
  "/api/imports": { admin: "/employees", hr: "/hr/employees" },
  "/api/contracts": { admin: "/contracts", hr: "/hr/contracts" },
  "/api/resignations": { admin: "/resignations", hr: "/hr/resignations" },
  "/api/retention": { admin: "/retention" },
  "/api/hiring-documents": { admin: "/hiring-documents", hr: "/hr/hiring-documents" },
  "/api/hiring-pack": { admin: "/hiring-pack", hr: "/hr/hiring-pack" },
  "/api/hr-ops-reports": { hr: "/hr/hr-reports" },
  "/api/hr-reminders": { hr: "/hr/hr-reminders" },
  "/api/mailbox-offboarding": { admin: "/mailbox-offboarding", hr: "/hr/mailbox-offboarding" },
  "/api/new-hire-mailboxes": { admin: "/new-hire-mailboxes", hr: "/hr/new-hire-mailboxes" },
  "/api/offers": { admin: "/offers", hr: "/hr/offers" },
  "/api/cv-database": { admin: "/cv-database", hr: "/hr/cv-database" },
  "/api/recruitment": { admin: "/recruitment", hr: "/hr/recruitment", portal: "/employee-portals/recruitment-candidates" },
  "/api/recruitment/candidates": { admin: "/recruitment/candidates", hr: "/hr/recruitment/candidates" },
  "/api/recruitment/cv-lifecycle": { admin: "/recruitment/cv-lifecycle-sheet" },
  "/api/recruitment/cv-lookup": { admin: "/cv-lookup", hr: "/hr/cv-lookup" },
  "/api/recruitment/district-returns": { admin: "/recruitment/returned-cvs" },
  "/api/recruitment/hiring-manager": { admin: "/recruitment/candidates", hr: "/hr/recruitment/candidates", portal: "/employee-portals/recruitment-candidates" },
  "/api/recruitment/intake": { admin: "/recruitment/intake-health" },
  "/api/recruitment/interview-calendar": {
    admin: "/recruitment/interview-calendar",
    hr: "/hr/recruitment/interview-calendar",
    portal: "/employee-portals/interview-calendar",
  },
  "/api/recruitment/job-posts": { admin: "/recruitment/job-posts", hr: "/hr/recruitment/job-posts" },
  "/api/recruitment/manager-engagement": {
    admin: "/recruitment/manager-engagement",
    hr: "/hr/recruitment/manager-engagement",
    portal: "/employee-portals/recruitment-engagement",
  },
  "/api/recruitment/requisitions": { admin: "/recruitment", hr: "/hr/recruitment", portal: "/employee-portals/vacancies" },
  "/api/recruitment/whatsapp": { admin: "/recruitment/whatsapp-inbox", hr: "/hr/recruitment/whatsapp-inbox" },
  "/api/recruitment/whatsapp-applicants": { admin: "/recruitment/whatsapp-applicants", hr: "/hr/recruitment/whatsapp-applicants" },
  "/api/recruitment/whatsapp-templates": { admin: "/recruitment/whatsapp-templates", hr: "/hr/recruitment/whatsapp-templates" },
  "/api/whatsapp-inbox": { admin: "/recruitment/whatsapp-inbox", hr: "/hr/recruitment/whatsapp-inbox" },
  "/api/reports/organogram": { admin: "/organogram", hr: "/hr/organogram", portal: "/employee-portals/organogram" },
  "/api/reports/vacancies": { admin: "/reports/vacancies", hr: "/hr/reports/vacancies", portal: "/employee-portals/vacancies" },
  "/api/probation": { admin: "/probation", hr: "/hr/probation", portal: "/employee-portals/probation" },
  "/api/probation/analytics": { admin: "/probation/analytics", hr: "/hr/probation/analytics" },
  "/api/probation/config": { admin: "/admin/probation-settings" },
  "/api/probation/dashboard": { admin: "/probation/dashboard", hr: "/hr/probation/dashboard" },
  "/api/coaching": { admin: "/coaching", hr: "/hr/coaching", portal: "/employee-portals/training-manager/coaching" },
  "/api/coaching/analytics": { admin: "/coaching/analytics", hr: "/hr/coaching/analytics" },
  "/api/coaching/import": { admin: "/coaching/import" },
  "/api/devices": { admin: "/devices", hr: "/hr/devices" },
  "/api/devices/managed-play": { admin: "/devices/managed-play" },
  "/api/devices/tablets": { admin: "/devices/tablets" },

  // ── Leave, calendars, plans ─────────────────────────────────────────────────────────────────────
  "/api/vacations": {
    admin: "/leave-management/vacation-request",
    hr: "/hr/workspace/leave-management/vacation-request",
    portal: "/employee-portals/vacation-request",
  },
  "/api/vacations/control": { admin: "/leave-management/vacation-control", hr: "/hr/leave-management/vacation-control" },
  "/api/vacations/report": {
    admin: "/leave-management/vacation-report",
    hr: "/hr/leave-management/vacation-report",
    portal: "/employee-portals/vacation-report",
  },
  "/api/vacation": {
    admin: "/leave-management/vacation-report",
    hr: "/hr/leave-management/vacation-report",
    portal: "/employee-portals/vacation-report",
  },
  "/api/excuses": { admin: "/workspace/excuses", hr: "/hr/workspace/excuses", portal: "/employee-portals/excuses" },
  "/api/calendar": { admin: "/admin/company-calendar", hr: "/hr/admin/company-calendar" },
  "/api/private-calendar": {
    admin: "/admin/private-calendars",
    hr: "/hr/admin/private-calendars",
    portal: "/employee-portals/private-calendar",
  },
  "/api/private-calendar/disputes": { admin: "/admin/private-calendar-disputes" },
  "/api/weekly-plans": { admin: "/admin/weekly-plans", portal: "/employee-portals/plans" },
  "/api/weekly-plans/calendar": {
    admin: "/admin/weekly-plans/calendar",
    hr: "/hr/admin/weekly-plans/calendar",
    portal: "/employee-portals/plans/calendar",
  },
  "/api/weekly-plans/decisions": { admin: "/admin/approvals/plan", portal: "/employee-portals/approvals/plan" },

  // ── Identity cards, recognition ─────────────────────────────────────────────────────────────────
  "/api/business-card-requests": {
    admin: "/admin/business-card-requests",
    hr: "/hr/admin/business-card-requests",
    portal: "/employee-portals/business-cards",
  },
  "/api/business-cards": { admin: "/business-cards", hr: "/hr/business-cards", portal: "/employee-portals/business-cards" },
  "/api/milestones": { admin: "/milestones", hr: "/hr/milestones", portal: "/employee-portals/milestones" },
  "/api/spotlight": { admin: "/spotlight", hr: "/hr/spotlight", portal: "/employee-portals/spotlight" },
  "/api/spotlight/cheques": { admin: "/spotlight/cheques" },
  "/api/rep-ranks": { admin: "/admin/ranks", hr: "/hr/admin/ranks", portal: "/employee-portals/ranks" },
  "/api/report-it": { admin: "/admin/report-it", hr: "/hr/admin/report-it/new", portal: "/employee-portals/report-it" },
  "/api/support": { admin: "/admin/support-requests", hr: "/hr/admin/support-requests", portal: "/employee-portals/contact-hr-support" },
  "/api/company-activity-report": { admin: "/admin/company-activity-report", hr: "/hr/admin/company-activity-report" },

  // ── Field force: Phoenix CRM, iReports 360, outstation ──────────────────────────────────────────
  "/api/phoenix-crm": { admin: "/admin/field-crm", portal: "/employee-portals/field-crm" },
  "/api/phoenix-crm/double-visit-requests": {
    admin: "/admin/phoenix-crm/double-visit-requests",
    portal: "/employee-portals/double-visit-requests",
  },
  "/api/phoenix-crm/forecast": { admin: "/admin/field-crm", portal: "/employee-portals/field-crm/forecast" },
  "/api/phoenix-crm/master-list": { admin: "/admin/phoenix-crm/master-list" },
  "/api/phoenix-crm/recording": { admin: "/admin/field-crm/visit-recording", portal: "/employee-portals/field-crm" },
  "/api/phoenix-crm/refused-readings": { admin: "/admin/phoenix-crm/refused-readings", portal: "/employee-portals/field-crm" },
  "/api/phoenix-crm/validation-reviews": { admin: "/admin/field-crm/validation-reviews", portal: "/employee-portals/field-crm" },
  "/api/phoenix-crm/visit-report": { admin: "/admin/phoenix-crm/visit-report", portal: "/employee-portals/visit-report" },
  "/api/crm": { admin: "/admin/crm", portal: "/employee-portals/crm" },
  "/api/crm/early-birds": { admin: "/admin/early-birds", portal: "/employee-portals/early-birds" },
  "/api/crm/plan-verification": { admin: "/admin/plan-verification" },
  "/api/outstation": { admin: "/admin/outstation/expenses", portal: "/employee-portals/expenses" },
  "/api/outstation/medical-rep-expenses": { admin: "/admin/outstation/expenses", portal: "/employee-portals/expenses" },
  "/api/outstation/my-submissions": { admin: "/admin/outstation/expenses", portal: "/employee-portals/expense-submissions" },
  "/api/outstation/policy": { admin: "/admin/outstation/policy" },
  "/api/outstation/submit": { admin: "/admin/outstation/expenses", portal: "/employee-portals/submit-expense" },
  "/api/verified-captures": { admin: "/admin/verified-captures" },
  "/api/visual-aids": { admin: "/admin/visual-aids" },
  "/api/production-planning": { admin: "/admin/production-planning", portal: "/employee-portals/production-planning" },

  // ── Customers and pharmacies ────────────────────────────────────────────────────────────────────
  "/api/customer-360": { admin: "/customer-360" },
  "/api/customer-identity": { admin: "/admin/customer-links" },
  "/api/customer-pharmacy-mapping": { admin: "/admin/customer-pharmacy-mapping" },
  "/api/pharmacy-master": { admin: "/admin/pharmacy-master" },
  "/api/territory-management": { admin: "/sales/territory-management", portal: "/employee-portals/territory-management" },
  "/api/territory-management/area-consolidation": { admin: "/admin/master-data/area-consolidation" },

  // ── Direct orders ───────────────────────────────────────────────────────────────────────────────
  "/api/direct-orders": { admin: "/admin/direct-orders", portal: "/employee-portals/direct-orders" },
  "/api/direct-orders/caps": { admin: "/admin/direct-orders/caps" },
  "/api/direct-orders/cleanup": { admin: "/admin/direct-orders/cleanup" },
  "/api/direct-orders/held": { admin: "/admin/direct-orders/held" },
  "/api/direct-orders/pharmacies": { admin: "/admin/direct-orders/pharmacies" },
  "/api/direct-orders/pharmacy-validations": { admin: "/admin/direct-orders/validations" },
  "/api/direct-orders/rep-counters": { admin: "/admin/direct-orders/rep-counters" },
  "/api/direct-orders/report": { admin: "/admin/direct-orders/report", portal: "/employee-portals/direct-orders" },
  "/api/direct-orders/variances": { admin: "/admin/direct-orders/pharmacy-variances" },

  // ── Marketing ───────────────────────────────────────────────────────────────────────────────────
  "/api/marketing": { admin: "/admin/sales-marketing-intelligence", portal: "/employee-portals/roi" },
  "/api/market-awareness": { admin: "/admin/market-awareness", portal: "/employee-portals/market-awareness" },
  "/api/market-awareness/inbox": { admin: "/admin/market-awareness/inbox", portal: "/employee-portals/market-awareness/inbox" },
  "/api/marketing-requests": { admin: "/admin/marketing-requests", portal: "/employee-portals/marketing-requests" },
  "/api/marketing-requests/all": { admin: "/admin/marketing-requests/all", portal: "/employee-portals/marketing-requests/all" },
  "/api/marketing-requests/bulk-upload": { admin: "/admin/marketing-requests/bulk-upload" },
  "/api/marketing-requests/control": { admin: "/admin/marketing-requests/control", portal: "/employee-portals/marketing-requests/control" },
  "/api/marketing-requests/coverage-report": { admin: "/admin/marketing-requests/coverage-report", portal: "/employee-portals/roi-tracker" },
  "/api/marketing-requests/customer-database": {
    admin: "/admin/marketing-requests/customer-database",
    portal: "/employee-portals/marketing-requests/customer-database",
  },
  "/api/marketing-requests/inbox": { admin: "/admin/marketing-requests/inbox", portal: "/employee-portals/marketing-requests/inbox" },
  "/api/marketing-requests/manager-scorecard": { admin: "/admin/marketing-requests/manager-scorecard" },
  "/api/marketing-requests/roi-business-report": { admin: "/admin/marketing-roi-report" },
  "/api/marketing-requests/roi-tracker": { admin: "/admin/marketing-roi-tracker", portal: "/employee-portals/roi-tracker" },
  "/api/marketing-requests/roi-tracking": { admin: "/admin/marketing-requests/roi-tracking", portal: "/employee-portals/roi-tracker" },
  "/api/marketing-requests/validated-customers": { admin: "/admin/marketing-requests/validated-customers" },
  "/api/marketing-requests/validation": {
    admin: "/admin/marketing-requests/validation",
    portal: "/employee-portals/marketing-requests/validation",
  },

  // ── Sales ───────────────────────────────────────────────────────────────────────────────────────
  "/api/business-review": { admin: "/business-review", portal: "/employee-portals/business-review" },
  "/api/employee-portals": { portal: "/employee-portals" },
  "/api/employee-portals/crm": { portal: "/employee-portals/crm" },
  "/api/employee-portals/double-visit-report": { portal: "/employee-portals/double-visit-report" },
  "/api/employee-portals/source-of-sales": { admin: "/sales/source-of-sales-tools", portal: "/employee-portals/source-of-sales" },
  "/api/employee-portals/team-calendar": { portal: "/employee-portals/team-calendar" },
  "/api/employee-portals/territory-drilldown": { portal: "/employee-portals/territory-drilldown" },
  "/api/employee-portals/weekly-sales": { admin: "/sales/weekly", portal: "/employee-portals/weekly-sales" },
  "/api/employee-portals/weekly-stock": { admin: "/sales/weekly/stock", portal: "/employee-portals/weekly-stock" },
  "/api/sales": { admin: "/sales", portal: "/employee-portals/sales-vs-target" },
  "/api/sales/brick-moves": { admin: "/sales/territory-management", portal: "/employee-portals/territory-management" },
  "/api/sales/channels-by-rep": { admin: "/sales/weekly", portal: "/employee-portals/weekly-sales" },
  "/api/sales/closing-corrections": { admin: "/sales/closing-corrections" },
  "/api/sales/customer-directory": { admin: "/sales/customer-directory" },
  "/api/sales/customer-mapping": { admin: "/sales/customer-mapping" },
  "/api/sales/database-mapping": { admin: "/sales/database-mapping" },
  "/api/sales/diagnostics": { admin: "/sales/diagnostics" },
  "/api/sales/distributors": { admin: "/sales/distributor-profiles" },
  "/api/sales/import": { admin: "/sales/import" },
  "/api/sales/imports": { admin: "/sales/import" },
  "/api/sales/make-it-happen": { admin: "/sales/make-it-happen", portal: "/employee-portals/make-it-happen" },
  "/api/sales/mapping-audit": { admin: "/sales/mapping-database" },
  "/api/sales/mapping-database": { admin: "/sales/mapping-database" },
  "/api/sales/master-map": { admin: "/sales/mapping-database" },
  "/api/sales/master-workbook": { admin: "/sales/monthly-closing", portal: "/employee-portals/monthly-closing" },
  "/api/sales/monthly-closing": { admin: "/sales/monthly-closing", portal: "/employee-portals/monthly-closing" },
  "/api/sales/monthly-dashboard": { admin: "/sales/monthly-dashboard" },
  "/api/sales/monthly-import": { admin: "/sales/import" },
  "/api/sales/monthly-sales": { admin: "/sales/monthly-dashboard" },
  "/api/sales/normalizer": { admin: "/sales/normalizer" },
  "/api/sales/sales-upload": { admin: "/sales/upload" },
  "/api/sales/sos-dashboard": { admin: "/sales/source-of-sales-tools", portal: "/employee-portals/source-of-sales" },
  "/api/sales/source-of-sales": { admin: "/sales/source-of-sales-tools", portal: "/employee-portals/source-of-sales" },
  "/api/sales/targets": { admin: "/sales/targets", portal: "/employee-portals/targets" },
  "/api/sales/truth-check": { admin: "/sales/truth-check" },
  "/api/sales/vs-target": { admin: "/sales/vs-target", portal: "/employee-portals/sales-vs-target" },
  "/api/sales/weekly": { admin: "/sales/weekly", portal: "/employee-portals/weekly-sales" },
};

/**
 * API prefixes no sidebar screen owns, with what calls them. A row under one of these is named
 * `Not in sidebar — <reason>` with source `none`: the honest answer, never a guessed module.
 */
export const API_NO_UI: Readonly<Record<string, string>> = {
  "/api/cron": "Scheduled job",
  "/api/webhooks": "Webhook from an outside service",
  "/api/integrations": "Outside integration callback",
  "/api/mcp-source": "Outside connector",
  "/api/public": "Public page (no sign-in)",
  "/api/share": "Share link",
  "/api/email": "Email link",
  "/api/email-signature": "Email signature image link",
  "/api/sato-email": "Email media link",
  "/api/auth": "Sign-in and session",
  "/api/dev-auth": "Developer sign-in",
  "/api/employee-portal": "Portal account (activation, profile photo)",
  "/api/whatsapp": "WhatsApp connection setup",
  "/api/errors": "Error reporter",
  "/api/telemetry": "Browser timing beacon (every page)",
  "/api/health": "Health check",
  "/api/healthz": "Health check",
  "/api/readyz": "Health check",
  "/api/activity": "Page-view tracking (every page)",
  "/api/navigation": "Sidebar layout (every page)",
  "/api/employee-portals/navigation": "Sidebar layout (every page)",
  "/api/messages": "Internal messages (header menu)",
  "/api/notifications": "Notifications (header menu and scheduled sends)",
  "/api/exports": "Table export (any page)",
  "/api/admin/profile": "Admin profile (header menu)",
  "/api/attendance/agent": "Fingerprint device sync",
  "/api/attendance/digests": "Scheduled attendance digest",
  "/api/attendance/sync-now": "Fingerprint device sync",
  // Sidebar badge counts — every page polls them, so they name no module.
  "/api/approvals/badge-counts": "Sidebar badge count (every page)",
  "/api/approvals-hub/pending-count": "Sidebar badge count (every page)",
  "/api/direct-orders/needs-action-count": "Sidebar badge count (every page)",
  "/api/direct-orders/unbooked-count": "Sidebar badge count (every page)",
  "/api/market-awareness/pending-count": "Sidebar badge count (every page)",
  "/api/marketing-requests/pending-count": "Sidebar badge count (every page)",
};

export type ApiPageResolution =
  | { kind: "page"; prefix: string; targets: ApiPageTargets }
  | { kind: "no_ui"; prefix: string; reason: string };

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The longest prefix of either list that owns `path`, or null when neither does. */
export function resolveApiPage(path: string): ApiPageResolution | null {
  let best: ApiPageResolution | null = null;
  for (const [prefix, targets] of Object.entries(API_PAGE_MAP)) {
    if (matchesPrefix(path, prefix) && (!best || prefix.length > best.prefix.length)) best = { kind: "page", prefix, targets };
  }
  for (const [prefix, reason] of Object.entries(API_NO_UI)) {
    if (matchesPrefix(path, prefix) && (!best || prefix.length > best.prefix.length)) best = { kind: "no_ui", prefix, reason };
  }
  return best;
}
