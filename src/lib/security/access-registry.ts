import type { PermissionAction, PermissionResource } from "@/lib/auth/permissions";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type AuthMode =
  | "session"
  | "public-token"
  | "webhook-secret"
  | "cron-secret"
  | "machine-token"
  | "dev-only";

export type PermissionRequirement = {
  action: PermissionAction;
  resource: PermissionResource;
};

export type AccessRegistryEntry = {
  audit: {
    classification?: "access-read" | "export" | "mutation" | "public-token" | "machine" | "webhook" | "cron";
    required: boolean;
  };
  authMode: AuthMode;
  csrf: {
    exemptReason?: string;
    required: boolean;
  };
  exceptionReason?: string;
  guard?: "assert-permission" | "domain-helper" | "secret" | "public-token" | "dev-only";
  methods: readonly HttpMethod[];
  pattern: string;
  permission: PermissionRequirement | readonly PermissionRequirement[] | null;
  serviceRole: {
    allowed: boolean;
    reason?: string;
  };
  surface: "api" | "page" | "export";
};

export type SecurityPreflightResult = {
  checkedAt: string;
  environment: "local" | "staging" | "production";
  failures: string[];
  passed: boolean;
  warnings: string[];
};

const readOnly: readonly HttpMethod[] = ["GET"];
const allMethods: readonly HttpMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

function sessionApi(input: {
  audit?: AccessRegistryEntry["audit"];
  csrfExemptReason?: string;
  csrfRequired?: boolean;
  guard?: AccessRegistryEntry["guard"];
  methods?: readonly HttpMethod[];
  pattern: string;
  permission: AccessRegistryEntry["permission"];
  serviceRoleReason?: string;
}): AccessRegistryEntry {
  return {
    audit: input.audit ?? { required: false },
    authMode: "session",
    csrf: {
      exemptReason: input.csrfRequired ? undefined : input.csrfExemptReason ?? "Protected session route; mutation does not accept cross-site form semantics.",
      required: Boolean(input.csrfRequired),
    },
    guard: input.guard ?? "assert-permission",
    methods: input.methods ?? allMethods,
    pattern: input.pattern,
    permission: input.permission,
    serviceRole: {
      allowed: true,
      reason: input.serviceRoleReason ?? "Server route uses guarded application authorization before service-role data access.",
    },
    surface: "api",
  };
}

function tokenApi(input: {
  authMode: Exclude<AuthMode, "session">;
  methods?: readonly HttpMethod[];
  pattern: string;
  reason: string;
}): AccessRegistryEntry {
  return {
    audit: { classification: input.authMode === "public-token" ? "public-token" : input.authMode === "webhook-secret" ? "webhook" : input.authMode === "cron-secret" ? "cron" : input.authMode === "machine-token" ? "machine" : undefined, required: input.authMode !== "dev-only" },
    authMode: input.authMode,
    csrf: {
      exemptReason: input.reason,
      required: false,
    },
    exceptionReason: input.reason,
    guard: input.authMode === "dev-only" ? "dev-only" : input.authMode === "public-token" ? "public-token" : "secret",
    methods: input.methods ?? allMethods,
    pattern: input.pattern,
    permission: null,
    serviceRole: {
      allowed: input.authMode !== "dev-only",
      reason: input.reason,
    },
    surface: "api",
  };
}

export const accessRegistry = [
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/login", reason: "Credential bootstrap endpoint; no existing Phoenix session is expected." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/logout", reason: "Session teardown endpoint accepts an existing cookie but does not expose data." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/heartbeat", reason: "Session heartbeat endpoint validates the Phoenix session token directly." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/password-setup/:token", reason: "Password setup/reset is protected by a one-time token." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/change-password", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState before allowing password change." }),
  tokenApi({ authMode: "dev-only", methods: ["GET"], pattern: "/api/dev-auth", reason: "Development-only local preview authentication helper." }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/webhooks/resend", reason: "Resend webhook signature/secret protected." }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/integrations/telegram/webhook", reason: "Telegram bot webhook is protected by the Telegram secret-token header." }),
  tokenApi({ authMode: "machine-token", methods: ["POST"], pattern: "/api/attendance/raw-punches", reason: "Local attendance agent bearer-token ingestion route." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/excuses/:id/decision", reason: "Manager excuse decision email link is protected by a one-time token; POST is explicitly unsupported." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/birthdays", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/contract-renewals", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/holiday-confirmation", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/daily", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-sync", reason: "Scheduled iReports360 visits sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-reconcile", reason: "Scheduled wide iReports360 reconciliation sync route guarded by cron controls." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/offers/:offerRef/accept", reason: "Candidate offer acceptance uses a secure offer token." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/offers/:offerRef/reject", reason: "Candidate offer rejection uses a secure offer token." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/offers/:offerRef/negotiate", reason: "Candidate offer negotiation request uses a secure offer token; write-only, flags the offer for HR." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/recruitment/apply/:token", reason: "Public job application submission protected by the posting token and IP rate limit; write-only, exposes no data." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/health/email", reason: "Unauthenticated health check; reports env-var presence only, no secrets or PII." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/email/unsubscribe/:token", reason: "RFC 8058 one-click unsubscribe protected by a signed, expiring HMAC token; write-only suppression action, exposes no data." }),

  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "PATCH"], pattern: "/api/admin/users/**", permission: [{ resource: "admin_access", action: "read" }, { resource: "user_admin", action: "update" }] }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/admin/permissions", permission: [{ resource: "admin_access", action: "read" }, { resource: "permission_admin", action: "update" }] }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/modules-control", permission: { resource: "module_control", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/admin/modules-control", permission: { resource: "module_control", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/logs", permission: { resource: "admin", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/errors", permission: { resource: "admin", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/workflow-control/**", permission: { resource: "workflow_registry", action: "update" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/workflow-registry/**", permission: { resource: "workflow_registry", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/email-templates/**", permission: { resource: "communication", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/email-composer/**", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notifications/telegram/templates", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "PATCH"], pattern: "/api/admin/notifications/telegram/templates", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notifications/telegram", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "PATCH"], pattern: "/api/admin/notifications/telegram", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/email-reply/send", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/field-workforce-compliance/archive/:id/recommendations/export", permission: { resource: "hr_calendar", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/field-workforce-compliance/archive/:id/export", permission: { resource: "hr_calendar", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/monitoring/events-csv", permission: { resource: "admin", action: "export" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/exports/table", permission: { resource: "overview", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Company-wide unscoped iReports360 data sync utility; checks access.role === "Super Admin"
  // directly rather than the permission matrix.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/visits-report/backfill", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/visits-report/export", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/visits-report/resolve-identity", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/field-workforce-compliance/**", permission: { resource: "hr_calendar", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/decisions", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/finalize", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/export", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/payroll-import", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions-governance/payroll-preview", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/sync/**", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/deductions-governance/**", permission: { resource: "deductions", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/deductions/comments", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/double-visit-analytics/export", permission: { resource: "double_visit_analytics", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/admin/double-visit-analytics/**", permission: { resource: "double_visit_analytics", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/outstation/expense-command/export", permission: { resource: "outstation", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/outstation/**", permission: { resource: "outstation", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/system-cleanup/**", permission: { resource: "system_cleanup", action: "delete" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: allMethods, pattern: "/api/admin/profile", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/admin/support-requests", permission: { resource: "support_requests", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/activity/timeline", permission: { resource: "user_activity", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/activity/export", permission: { resource: "user_activity", action: "export" } }),
  sessionApi({ audit: { classification: "access-read", required: false }, methods: readOnly, pattern: "/api/admin/activity/live", permission: { resource: "user_activity", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/activity/force-logout", permission: { resource: "user_activity", action: "export" }, csrfRequired: true }),
  tokenApi({ authMode: "machine-token", methods: ["POST"], pattern: "/api/admin/synthetic-journeys/ingest", reason: "Synthetic journey runner bearer-token ingestion route; protected by SYNTHETIC_INGEST_TOKEN." }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/**", permission: { resource: "admin", action: "read" } }),

  sessionApi({ methods: allMethods, pattern: "/api/attendance/agent/**", permission: { resource: "employees", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/device-user-mappings/template", permission: { resource: "employees", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/attendance/device-user-mappings/**", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/attendance/policies", permission: { resource: "employees", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/attendance/digest-settings", permission: { resource: "employees", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/fingerprint-report/export", permission: { resource: "employees", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/employee-fingerprint-export", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/monthly-summary/export", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/sync-now", permission: { resource: "employees", action: "update" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/employee-attendance", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/exceptions", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/exceptions", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: ["PATCH", "DELETE"], pattern: "/api/attendance/exceptions/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/digests", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/digests/:id", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/digests/:id/confirm", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/digests/:id/dispute", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  // Dispute review authorization is data-driven (attendance_digest_settings.approver_hr_ids),
  // not resource/action-expressible — assertPermission is the coarse baseline;
  // isAuthorizedDisputeReviewer (in-route + re-checked in the service) is the real gate.
  sessionApi({ methods: readOnly, pattern: "/api/attendance/disputes", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/disputes/:lineId/review", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  // Digest review gate: a deduction-bearing digest routes here before it ever reaches
  // the employee. Same data-driven "either approver" authorization as dispute review.
  sessionApi({ methods: readOnly, pattern: "/api/attendance/digest-review", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/digest-review/:id/approve", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/digest-review/:id/void", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/digests/:id/missing-punch", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/missing-punch", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/missing-punch/:id/decide", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/settlement-dashboard", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/settlement-dashboard/remind-all", permission: { resource: "employees", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/settlement-ledger", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/holiday-calendar", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/holiday-calendar", permission: { resource: "employees", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/passport/:hrId", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/hr-pattern-insights", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),

  sessionApi({ methods: allMethods, pattern: "/api/coaching/**", permission: { resource: "coaching", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/contracts/**", permission: { resource: "contracts", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/coaching/reports/export", permission: { resource: "coaching", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/cv-database/**", permission: { resource: "vacancies", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/cv-database/template", permission: { resource: "vacancies", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/employees/template", permission: { resource: "employees", action: "export" } }),
  sessionApi({ methods: allMethods, pattern: "/api/employees/**", permission: { resource: "employees", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/employee-portal/profile-photo", permission: { resource: "employee_profile", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/excuses/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/exports", permission: { resource: "probation", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/hiring-documents/**", permission: { resource: "employee_documents", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/imports/**", permission: { resource: "imports", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/users/bulk", permission: { resource: "user_admin", action: "export" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/marketing/roi-refresh", permission: { resource: "overview", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing/roi-refresh", permission: { resource: "overview", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/roi-tracking/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only ROI report export: serialises the role-scoped, filtered report into a styled XLSX; performs no state mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/marketing-requests/:id/view-sales/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/marketing-requests/control", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/finance-evidence", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/drafts", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/bulk-upload", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/reverse-geocode", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only: resolves caller-supplied coordinates via the Google reverse-geocode proxy and persists nothing." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/roi-tracking", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only filtered ROI report; uses POST only to carry a complex filter body, persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/validation", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/marketing-requests/roi-tracking/presets", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/coverage-report/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only Coverage Report export: serialises the role-scoped, filtered report into a styled XLSX; performs no state mutation." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/coverage-report", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only filtered Coverage Report; uses POST only to carry a complex filter body, persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/marketing-requests/coverage-report/presets", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/decision", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/comment", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/resubmit", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/marketing-requests/**", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  // Customer Pharmacy Mapping — standalone read-only master-data governance. Role gate lives in the
  // domain helper (assertCustomerPharmacyMappingAccess); Phase 1 is Super Admin + CEO only.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/customer-pharmacy-mapping", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/customer-pharmacy-mapping/:id/decision", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Pharmacy Master / Distributor Matching — standalone read-only candidate-review report
  // (Phase 1, no write actions). Role gate lives in the domain helper
  // (assertPharmacyMasterAccess); Super Admin + CEO only.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/pharmacy-master/candidates", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/messages/**", permission: { resource: "communication", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/in-app", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/notifications/settings", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/notifications/settings", permission: { resource: "employee_profile", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/integrations/telegram/connect", permission: { resource: "employee_profile", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/integrations/telegram/disconnect", permission: { resource: "employee_profile", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/integrations/telegram/test", permission: { resource: "employee_profile", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/process", permission: { resource: "admin", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/test", permission: { resource: "admin", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/offers/**", permission: { resource: "offers", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/outstation/workload-evidence", permission: { resource: "outstation", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/outstation/**", permission: { resource: "outstation", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/expenses", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/expenses", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/expenses/analyze", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/expenses/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PUT", "DELETE"], pattern: "/api/payroll/expenses/reports/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/start", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/message", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/actions", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/materialize", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/cancel", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/fingerprint", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/fingerprint", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/crm", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/crm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/vacation", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/vacation", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/expenses", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/expenses", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/holiday-bridging", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/holiday-bridging", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/statutory/insurance-wages/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/payroll/**", permission: { resource: "payroll", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/**", permission: { resource: "probation", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/requisitions/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/applications/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/candidates/template", permission: { resource: "candidates", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/candidates/**", permission: { resource: "candidates", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/interviews/**", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/onboarding/**", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/offers/**", permission: { resource: "offers", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/offer-letter/**", permission: { resource: "offers", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/salary-summary/**", permission: { resource: "offers", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/recruitment/files/**", permission: { resource: "candidates", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/reports/vacancies", permission: { resource: "vacancies", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/reports/**", permission: { resource: "organogram", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/resignations/**", permission: { resource: "resignations", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans", permission: { resource: "weekly_plans", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/export", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/calendar", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/conflicts", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/prefill", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/weekly-plans/:id", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/decision", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/:id/comments", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/comments", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/request-visit-details", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/visit-details", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/acknowledge", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/cancel", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/request-edit", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/edit-request-decision", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/decisions/batch", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/private-calendar/export", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/private-calendar", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/calendar", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/calendar", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/calendar/:id", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/database-mapping/:master/export", permission: { resource: "sales", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/database-mapping/validation/customer-map/export", permission: { resource: "sales", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-runs the closing matrix + distributor comparison for the requested line+period and serialises to XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/customer-directory/export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-runs the directory query under the caller's filters and serialises it to a styled XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/customer-mapping/export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-runs the customer-mapping consolidation under the caller's filters and serialises it to XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/preview", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only: normalizes the uploaded raw distributor sheet in memory against the alias crosswalks and returns a coverage preview; persists nothing." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/download", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: normalizes the uploaded raw sheet and serialises the coded rows to XLSX; persists nothing." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/ai-suggest", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Suggestion-only JSON request: uses submitted unknown labels to suggest Phoenix matches and persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/bootstrap", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: learns source-of-sales aliases from a cleaned distributor workbook." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/learn", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: learns source-of-sales aliases from a completed unmapped-list workbook." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/save", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only mapping save: writes selected product, territory, and customer aliases after server-side permission checks." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/template", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: lists the distinct unmapped codes from the uploaded raw sheet as a fill-in XLSX; persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/import-validated", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: normalizes the uploaded raw sheet, builds the coded workbook in memory, and persists ONLY when it passes the Source-of-Sales validator." }),
  // Source of Sales — mapping templates + AI-assisted onboarding surfaced inside /sales/import.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/product-mapping/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/territory-mapping/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/product-mapping", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: validates the filled product-mapping XLSX against the product master and upserts product aliases." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/customer-mapping/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/customer-mapping/add", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON add: maps one customer code to a brick after server-side validation." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/customer-mapping", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: validates the filled customer->brick XLSX against the brick master and upserts the customer map." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/bootstrap", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: learns product + customer->brick aliases from a previously coded distributor workbook." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/missing", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only: normalizes the uploaded raw sheet in memory and returns coverage + distinct unknowns; persists nothing." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/ai-suggest", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Suggestion-only JSON request: uses submitted unknown labels to suggest Phoenix matches and persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/save-mappings", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON mapping save: writes selected product/territory aliases after server-side permission checks." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/import-coverage", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/detect", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only distributor detection: parses only the uploaded sheet's header row to suggest the matching distributor; persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/accept-mappings", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON write: persists confirmed customer→brick suggestions to the mapping sheet via the audited addCustomerMapRow." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/preview", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Dry-run preview: validates the uploaded sheet in memory and returns the import-preview diff; persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/commit", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: persists the previewed Source of Sales upload after server-side validation." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/cancel", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Discards an abandoned large-file preview by deleting its temporary Storage object; persists no business data." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/master-workbook/export", permission: { resource: "sales", action: "export" } }),
  // Sales Queue (/sales/queue, monthly closing-sheet upload) — separate module from
  // Source of Sales and Weekly Sales above; its own upload template only.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/queue/template", permission: { resource: "sales", action: "import" } }),
  // Flagship SoS BI workbook — the route additionally hard-gates to CEO / Super Admin via
  // canExportSosDashboard() on top of the sales:export permission asserted here.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/sos-dashboard/export", permission: { resource: "sales", action: "export" } }),
  // Manual on-demand trigger that emails the same workbook to CEO / Super Admin — same hard
  // role gate as the export route above.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/sos-dashboard/email-report", permission: { resource: "sales", action: "export" }, csrfRequired: true }),
  sessionApi({
    audit: { classification: "mutation", required: true },
    methods: ["POST"],
    pattern: "/api/sales/weekly/validate",
    permission: { resource: "weekly_sales", action: "import" },
    csrfExemptReason: "Authenticated weekly sales upload endpoint; validates file content and persists only when accepted.",
  }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/batches", permission: { resource: "weekly_sales", action: "import" } }),
  sessionApi({ methods: ["DELETE"], pattern: "/api/sales/weekly/batches", permission: { resource: "weekly_sales", action: "import" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/dashboard", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/source-of-sales", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/source-of-sales/export", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/weekly-sales", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/export", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/employee-portals/double-visit-report/export", permission: { resource: "double_visit_analytics", action: "export" }, guard: "domain-helper" }),
  // Team Calendar rep-day visits drill-down. Role-checked in the handler (National Sales
  // Manager only) plus a per-line scope guard (isHrIdInNsmTeamScope) rather than a matrix
  // resource, so it registers as a domain-helper guard with no matrix permission.
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/team-calendar/visits", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/export", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/sales/weekly/product-scope", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/branch-mapping/template", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/branch-mapping", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/branch-mapping", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated weekly branch->region mapping upsert/import; server validates distributor + master region before write." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/product-mapping/template", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/product-mapping", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/product-mapping", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated weekly product alias upsert/import; server validates each product_code against the Source-of-Sales master before write." }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/mapping", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/mapping/export", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/mapping/import", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated weekly distributor mapping upsert/import; server validates each mapping row before write." }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/missing", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/missing/export", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/sales/weekly/pos-region-mappings", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/pos-region-mappings/template", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/sales/**", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/report-it/list", permission: { resource: "report_it", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/report-it/submit", permission: { resource: "report_it", action: "create" }, guard: "domain-helper", csrfExemptReason: "JSON-only employee ADR submission; all authenticated roles can submit their own reports." }),
  sessionApi({ methods: ["GET"], pattern: "/api/report-it/:id", permission: { resource: "report_it", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/support/**", permission: { resource: "support_requests", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/vacations/**", permission: { resource: "leave", action: "read" }, csrfRequired: true, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/activity/track", permission: null, guard: "domain-helper", csrfExemptReason: "Fire-and-forget activity beacon: records ONLY the authenticated caller's own page view. Identity is taken from the session cookie, never the request body, so there is no cross-site mutation surface." }),
  // Self-hosted crash-report beacon (Error Monitor). Must also accept guests
  // (e.g. a crash on the login page before any session exists) — identity is
  // read from the session cookie when present, never trusted from the body.
  sessionApi({ methods: ["POST"], pattern: "/api/errors/client", permission: null, guard: "domain-helper", csrfExemptReason: "Fire-and-forget crash-report beacon, open to guests too. Identity comes only from the session cookie (or is absent for guests), never the request body; writes only a truncated error message/stack to app_error_events, so there is no state-changing or cross-site mutation surface." }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/vacation/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/excuse/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/plan/pending-count", permission: { resource: "weekly_plans", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/employee-context", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/hub-data", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/managers", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/historical", permission: { resource: "leave", action: "read" } }),
  // Legacy action-center paths kept for backwards compat (old bookmarks / mobile clients)
  sessionApi({ methods: ["GET"], pattern: "/api/action-center/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/action-center/employee-context", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/action-center/hub-data", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/action-center/managers", permission: { resource: "employees", action: "read" } }),

  { ...sessionApi({ methods: readOnly, pattern: "/admin/weekly-plans", permission: { resource: "weekly_plans", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/modules-control", permission: { resource: "module_control", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/weekly-plans/calendar", permission: { resource: "weekly_plans", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/private-calendars", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/marketing-requests/control", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/double-visit-analytics", permission: { resource: "double_visit_analytics", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/workspace/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/**", permission: { resource: "admin", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-portals/**", permission: { resource: "employee_profile", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/attendance/exceptions", permission: null, guard: "domain-helper" }), surface: "page" },
  // Approvals Hub › Vacation & Excuse approval pages — gated by leave:read so the confirmed
  // approver set (incl. CEO / Finance Manager / Financial Advisor) is not blocked by the
  // /admin/** admin:read catch-all. (Replaces the removed Vacation Action Center page.)
  { ...sessionApi({ methods: readOnly, pattern: "/admin/approvals/**", permission: { resource: "leave", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-portals/approvals/**", permission: { resource: "leave", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/payroll/expenses", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/payroll/expenses/dashboard", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/payroll/**", permission: { resource: "payroll", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/assignments", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/dashboard", permission: { resource: "weekly_sales", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/mapping", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/branch-mapping", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/product-mapping", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly", permission: { resource: "weekly_sales", action: "import" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/**", permission: { resource: "sales", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/reports/**", permission: { resource: "vacancies", action: "read" } }), surface: "page" },
] as const satisfies readonly AccessRegistryEntry[];

export function normalizeRoutePattern(input: string) {
  return input
    .replace(/\\/g, "/")
    .replace(/^app\/api/, "/api")
    .replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function registryPatternToRegex(pattern: string) {
  const segments = pattern.split("/").map((segment) => {
    if (segment === "**") return ".*";
    if (segment === "*") return "[^/]+";
    if (segment.startsWith(":")) return "[^/]+";
    return escapeRegex(segment);
  });
  return new RegExp(`^${segments.join("/")}$`);
}

function routeMatchesPattern(route: string, pattern: string) {
  if (pattern.endsWith("/**") && route === pattern.slice(0, -3)) return true;
  return registryPatternToRegex(pattern).test(route);
}

export function findAccessRegistryEntry(route: string, method?: HttpMethod) {
  const matches = accessRegistry.filter((entry) => {
    if (entry.surface !== "api") return false;
    if (method && !(entry.methods as readonly HttpMethod[]).includes(method)) return false;
    return routeMatchesPattern(route, entry.pattern);
  });
  return matches.sort((left, right) => right.pattern.length - left.pattern.length)[0] ?? null;
}

export function createSecurityPreflightResult(input: Omit<SecurityPreflightResult, "checkedAt" | "passed">): SecurityPreflightResult {
  return {
    ...input,
    checkedAt: new Date().toISOString(),
    passed: input.failures.length === 0,
  };
}
