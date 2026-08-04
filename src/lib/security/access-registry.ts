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
  // Biometric (passkey) sign-in. The two /login/* routes are credential bootstrap exactly like
  // /api/auth/login — no session exists yet, and the WebAuthn signature IS the credential. The
  // /register/* and /credentials routes are self-service and validate the active Phoenix session
  // cookie directly via resolveSessionState, exactly like /api/auth/change-password above.
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/login/options", reason: "Credential bootstrap endpoint; no existing Phoenix session is expected. Returns only an opaque challenge and deliberately reveals nothing about which accounts have biometrics enrolled." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/login/verify", reason: "Credential bootstrap endpoint; the verified WebAuthn assertion replaces the password check, then the route re-applies every gate /api/auth/login applies (is_active, terminal employment, lockout, IP blocklist, force_password_reset)." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/register/options", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState before issuing an enrollment challenge." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/register/verify", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState before storing a device public key." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "DELETE"], pattern: "/api/auth/biometric/credentials", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState and is scoped to the caller's own login_id, so it cannot read or revoke another person's devices." }),
  tokenApi({ authMode: "dev-only", methods: ["GET"], pattern: "/api/dev-auth", reason: "Development-only local preview authentication helper." }),
  // Super Admin only, on top of the same dev-only env+localhost gate as /api/dev-auth above
  // (see isLocalDevelopmentRequest): auto-picks a real active employee for a role+line and
  // swaps the caller's own session for a dev-preview session as that employee. Role gate is
  // in-route (domain-helper) rather than a permission resource, matching /api/admin/system-issues.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: readOnly, pattern: "/api/dev-auth/preview", permission: null, guard: "domain-helper" }),
  // Same Super Admin + dev-only gate as the preview route above: read-only candidate listing
  // that powers the picker's Line -> Region -> Area -> Name cascade client-side.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/dev-auth/candidates", permission: null, guard: "domain-helper" }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/webhooks/resend", reason: "Resend webhook signature/secret protected." }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/webhooks/brevo", reason: "Brevo transactional webhook is protected by a shared secret token (?token= / x-brevo-token) verified against BREVO_WEBHOOK_SECRET." }),
  tokenApi({ authMode: "webhook-secret", methods: ["GET", "POST"], pattern: "/api/webhooks/whatsapp", reason: "GET is Meta's one-time verify-token handshake; POST is protected by the X-Hub-Signature-256 HMAC verified against WHATSAPP_APP_SECRET. Recruitment inbound CV intake." }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/integrations/telegram/webhook", reason: "Telegram bot webhook is protected by the Telegram secret-token header." }),
  tokenApi({ authMode: "machine-token", methods: ["POST"], pattern: "/api/attendance/raw-punches", reason: "Local attendance agent bearer-token ingestion route." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/excuses/:id/decision", reason: "Manager excuse decision email link is protected by a one-time token; POST is explicitly unsupported." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/birthdays", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/contract-renewals", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/holiday-confirmation", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/daily", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-sync", reason: "Scheduled iReports360 visits sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-reconcile", reason: "Scheduled wide iReports360 reconciliation sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-live-sync", reason: "Scheduled high-frequency morning iReports360 visits sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/background-jobs", reason: "Durable background-job worker drain guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/recruitment-email-intake", reason: "Scheduled IMAP poll for inbound recruitment CV intake, guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/inbound-intake", reason: "Durable inbound-CV intake queue worker drain, guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/brevo-keepalive", reason: "Resets Brevo's 90-day inactivity expiry on the email failover key and reports a revoked key; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/reconciliation-check", reason: "Read-only reconciliation harness comparing each domain service against an independent derivation; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/health/email", reason: "Unauthenticated health check; reports env-var presence only, no secrets or PII." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/healthz", reason: "Unauthenticated Cloud Run liveness probe; returns status/revision only, no data or secrets." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/readyz", reason: "Unauthenticated readiness probe; returns dependency booleans + missing-env NAMES only, never values." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/email/unsubscribe/:token", reason: "RFC 8058 one-click unsubscribe protected by a signed, expiring HMAC token; write-only suppression action, exposes no data." }),

  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "PATCH"], pattern: "/api/admin/users/**", permission: [{ resource: "admin_access", action: "read" }, { resource: "user_admin", action: "update" }] }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/admin/permissions", permission: [{ resource: "admin_access", action: "read" }, { resource: "permission_admin", action: "update" }] }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/modules-control", permission: { resource: "module_control", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/admin/modules-control", permission: { resource: "module_control", action: "update" } }),
  // PM product master: Super Admin writes, CEO/SFE Manager/Super Admin read — enforced
  // in-route by role (domain-helper), like the system-issues admin routes.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/pm-products", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/logs", permission: { resource: "admin", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/errors", permission: { resource: "admin", action: "read" } }),
  // System Issues dashboard is CEO + Super Admin (checks access.role === "CEO" ||
  // canAccessSystemAdministratorWorkspace(access) directly) rather than the "admin"
  // permission resource, which is hard-locked to Super Admin only.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/attempts", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/repro-trail", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/security", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/notify-user", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/timeline", permission: null, guard: "domain-helper" }),
  // Super-Admin-only: blocking/unblocking a login IP changes who can authenticate.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/block-ip", permission: null, guard: "domain-helper", csrfRequired: true }),
  // AI triage — POSTs that call OpenAI (cost); CEO + Super Admin only, rate-limited in-route.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/explain", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/summary", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Cron Control dashboard: view = CEO + Super Admin (inline role check in-route, like
  // system-issues above); all 4 mutations = Super Admin only — pausing or rescheduling a cron
  // that drives payroll/notification SLAs is at least as consequential as an IP block.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/cron-control", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/cron-control/*/pause", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/cron-control/*/resume", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/cron-control/*/run", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/cron-control/*/schedule", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Pure local computation (no GCP call, no state mutation) but still POST, so proxy.ts's
  // blanket same-origin check for DELETE/PATCH/POST/PUT applies regardless — csrfRequired here
  // just makes the registry's own description match that real, unconditional enforcement.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/cron-control/preview-schedule", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Notification Recipients editor (which roles get told about a cron-triggered system
  // notification): Super Admin only end-to-end, both view and edit — unlike cron-control's
  // CEO+SA view, there's no equivalent "CEO needs to see this" oversight story for internal
  // notification-routing plumbing.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/notification-recipients", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/notification-recipients/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Email Control Center: a read-only rollup over the 3 systems above plus email-templates —
  // view = CEO + Super Admin (matches cron-control), edit = Super Admin only (matches
  // notification-recipients), since every write here dispatches straight into those systems'
  // own existing update functions rather than a new mechanism of its own.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/email-control-center", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/admin/email-control-center/**", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/workflow-control/**", permission: { resource: "workflow_registry", action: "update" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/workflow-registry/**", permission: { resource: "workflow_registry", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/email-templates/**", permission: { resource: "communication", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/email-composer/**", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notifications/telegram/templates", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "PATCH"], pattern: "/api/admin/notifications/telegram/templates", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notifications/telegram", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "PATCH"], pattern: "/api/admin/notifications/telegram", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/email-reply/send", permission: { resource: "communication", action: "update" } }),
  // Super-Admin-only via assertSystemAdministratorWorkspaceAccess (direct role check), not
  // the permission matrix — same pattern as the visits-report/backfill entry below.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/vacation/company-report/export", permission: null, guard: "domain-helper" }),
  // Converts one CRM-signal row into a real, balance-deducting vacation_requests row —
  // Super-Admin-only, same direct-role-check pattern as the export route above. Individual,
  // human-reviewed decisions only; never a bulk write.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/vacation/company-report/approve", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/monitoring/events-csv", permission: { resource: "admin", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/data-backup", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["GET"], pattern: "/api/admin/data-backup/status/:jobId", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/data-backup/download/:jobId", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/exports/table", permission: { resource: "overview", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Company-wide unscoped iReports360 data sync utility; checks access.role === "Super Admin"
  // directly rather than the permission matrix. Both routes now back the CRM hub (/admin/crm)
  // directly — the curated visits-report/export route was retired when its page merged into the
  // hub's own (superset) master-export.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/visits-report/backfill", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/visits-report/resolve-identity", permission: null, guard: "domain-helper", csrfRequired: true }),
  // CRM master table XLSX export: returns all rows for the current dataset+filters. Super-Admin-gated
  // inline (same as the /admin/crm page), so guarded by the domain helper, not the permission matrix.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/crm/master-export", permission: null, guard: "domain-helper" }),
  // Portal-scoped CRM export — the portal twin of the admin route above. Enforces crm_visits:read
  // plus the per-viewer row scope (isPortalCrmRole + resolvePortalCrmScope) inside the handler, so
  // like its admin sibling the fine gate is the domain helper, not the permission matrix alone.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/crm/master-export", permission: { resource: "crm_visits", action: "read" }, guard: "domain-helper" }),
  // Region Mapping tab resolver: assigns a CRM region to a real Phoenix brick. Same posture as
  // resolve-identity above — checks access.role === "Super Admin" directly.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/resolve-region", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Region Mapping bulk download/upload template — same Super-Admin-gated posture as the
  // single-row resolver above.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/crm/region-mapping/template", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/region-mapping/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Customer Mapping tab: one level finer than Region Mapping above (CRM customer/contact -> brick,
  // not CRM region -> brick). Same Super-Admin-gated posture, checks access.role directly.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/resolve-customer", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/crm/customer-mapping/template", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/customer-mapping/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/field-workforce-compliance/**", permission: { resource: "hr_calendar", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/decisions", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/finalize", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/export", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/payroll-import", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions-governance/payroll-preview", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions-governance/sync/**", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/deductions-governance/**", permission: { resource: "deductions", action: "read" } }),
  // Unified Deductions module (replaces deductions-governance once proven — see the approved
  // Phase 1-6 plan). Every route self-gates with assertPermission + the Super-Admin-only
  // assertDeductionsDecisionActor for mutations; the registry entry is the coarse baseline gate.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/candidates", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/export", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/decisions", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/summary/employee", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/summary/company", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/collect", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/manual", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/publish", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/publish", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
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
  // guard: "domain-helper" — gated via assertFingerprintReportPermission (CEO gets a
  // page-scoped exception to the employees hard boundary; see src/lib/auth/permissions.ts).
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/fingerprint-report/export", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/employee-fingerprint-export", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/monthly-summary/export", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/sync-now", permission: { resource: "employees", action: "update" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/employee-attendance", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/exceptions", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/exceptions", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: ["PATCH", "DELETE"], pattern: "/api/attendance/exceptions/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/holiday-calendar", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/holiday-calendar", permission: { resource: "employees", action: "update" }, guard: "domain-helper", csrfRequired: true }),

  // S1 business-review workbook export. Gated by a direct allow-list of CEO / SFE Manager /
  // Super Admin rather than the permission matrix — the same direct-role-check pattern as the
  // vacation company-report export above — because the module is a fixed executive surface,
  // not a permissioned resource. Reads only its own bundled snapshot, never a Phoenix table.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/business-review-s1/export", permission: null, guard: "domain-helper" }),

  sessionApi({ methods: allMethods, pattern: "/api/coaching/**", permission: { resource: "coaching", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/contracts/**", permission: { resource: "contracts", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/coaching/reports/export", permission: { resource: "coaching", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/cv-database/**", permission: { resource: "vacancies", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/cv-database/template", permission: { resource: "vacancies", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/employees/template", permission: { resource: "employees", action: "export" } }),
  sessionApi({ methods: allMethods, pattern: "/api/employees/**", permission: { resource: "employees", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/employee-portal/profile-photo", permission: { resource: "employee_profile", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/employee-portal/account-activation", permission: [{ resource: "account_activation", action: "read" }, { resource: "account_activation", action: "update" }], csrfRequired: true }),
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
  // Direct Orders module — the service enforces the precise permission + per-step approver binding (domain-helper guard).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/submit", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/decision", permission: { resource: "direct_orders", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/reverse", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Sales month is Finance-owned: the registry permission is only `read` because the real gate
  // is an identity check inside setDirectOrderSalesMonth (Ahmed El Maraghy / Super Admin), not a
  // role action — the CEO holds direct_orders:approve but must NOT be able to move a month.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/sales-month", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/pharmacies", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Pharmacy registry — pre-register a pharmacy so a later order is recognised. Registry
  // permission is only `read` because the real gate is a role check inside the service
  // (Super Admin + SFE Manager); every sales role holds direct_orders:read and must NOT be
  // able to mint a pre-confirmed pharmacy. The `confirm` action routes to the Super-Admin-only
  // acknowledgeDirectOrderPharmacy, so SFE reaching it gets a 403 by design.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/pharmacies/registry", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Type-ahead over the distributor's customer catalogue for the new-pharmacy picker. Read-only,
  // so no CSRF; the territory bound lives in searchDistributorCustomers, which clamps every
  // result to the caller's own areas rather than trusting the query string.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/customers", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  // Acknowledging a hand-entered pharmacy. Registry permission is only `read` because the real
  // gate is a Super-Admin identity check inside acknowledgeDirectOrderPharmacy — an approver
  // holds direct_orders:approve but must NOT be able to self-clear an unverified pharmacy.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/pharmacies/:id/acknowledge", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/direct-orders/report/export", permission: { resource: "direct_orders", action: "export" }, guard: "domain-helper", csrfExemptReason: "read-only report export; request body carries no mutation" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/caps", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/variances", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/coverage-report/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only Coverage Report export: serialises the role-scoped, filtered report into a styled XLSX; performs no state mutation." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/coverage-report", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only filtered Coverage Report; uses POST only to carry a complex filter body, persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/marketing-requests/coverage-report/presets", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/decision", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/comment", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/resubmit", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Super-Admin-only direct-sales tracking toggle (Phase D). GET reads the flag; POST is
  // the mutation (Super-Admin gate enforced in the service). csrf is applied to the POST.
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/marketing-requests/:id/track-direct-sales", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
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
  sessionApi({ methods: ["GET"], pattern: "/api/notifications/push/context", permission: { resource: "employee_profile", action: "read" } }),
  // No audit classification: this fires on every authenticated page load and every
  // browser subscription-change event, not a deliberate user action like Telegram
  // connect/disconnect — an audit-log row per ping would just be noise.
  sessionApi({ methods: ["POST"], pattern: "/api/notifications/push/register", permission: { resource: "employee_profile", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/notifications/push/test", permission: { resource: "employee_profile", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/process", permission: { resource: "admin", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/test", permission: { resource: "admin", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/outstation/workload-evidence", permission: { resource: "outstation", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/outstation/**", permission: { resource: "outstation", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/outstation/expenses", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/outstation/expenses", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/outstation/expenses/analyze", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/outstation/expenses/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PUT", "DELETE"], pattern: "/api/admin/outstation/expenses/reports/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/outstation/expenses/export", permission: null, guard: "domain-helper" }),
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
  // Automated Payroll — HR-owned monthly salary wizard. The role gate lives in the domain
  // service (assertAutomatedPayroll*Actor: Super Admin builds/publishes; CEO/Financial Advisor/
  // Finance Manager download the locked finance sheet), so guard: "domain-helper" — the same
  // pattern as the Payroll Copilot routes above. A separate namespace from /api/payroll/**.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/cancel", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/reconcile", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/population-diff", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/data-quality", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/publish", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/sheet", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PUT"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey/confirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey/export", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part1/confirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part1/unconfirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part2/confirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Non-Employees Payroll — free-form list, no employee/HR_ID record; same domain-helper gate.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/automated-payroll/runs/:runId/non-employees", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PUT", "DELETE"], pattern: "/api/automated-payroll/runs/:runId/non-employees/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance/download", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance/fab-download", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance/cib-download", permission: null, guard: "domain-helper" }),
  // Employee Day-by-Day Report deduction decisions — replaced the standalone Fingerprint
  // Deductions page (retired 2026-07-24); this is now the one place a fingerprint deduction
  // gets confirmed/rejected. Super Admin gate enforced in-route (matches the page itself).
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/attendance/employee-day-report/decisions", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/attendance/employee-day-report/decisions", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/attendance/employee-day-report/all-summary", permission: null, guard: "domain-helper" }),
  // Probation Decision Intelligence routes are gated at probation:read at the middleware; each
  // route enforces its exact permission / row-level ownership / decision-role check in-handler
  // (findAccessRegistryEntry picks the longest matching pattern, so these override the blanket
  // below). Without these, the /api/probation/** blanket would require Super-Admin-only
  // probation:update and lock out managers / SFE / CEO / TM who legitimately hold probation:read.
  sessionApi({ methods: readOnly, pattern: "/api/probation/feedback-tasks", permission: { resource: "probation", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/probation/dashboard", permission: { resource: "probation", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/probation/analytics", permission: { resource: "probation", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/cases/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/dv/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/dv-feedback/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/development-actions/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  // Config editor stays admin-only (probation:update).
  sessionApi({ methods: allMethods, pattern: "/api/probation/config", permission: { resource: "probation", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/**", permission: { resource: "probation", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/requisitions/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/intake/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/applications/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/candidates/template", permission: { resource: "candidates", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/candidates/**", permission: { resource: "candidates", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/interviews/**", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/recruitment/files/**", permission: { resource: "candidates", action: "read" }, csrfRequired: true }),
  // Deliberately gated on the narrow `hiring_interviews` resource, not `recruitment`/
  // `candidates` (both hard-boundary-locked to HR authority roles) — so a hiring-manager-type
  // role like District Manager can view/act on only their own assigned candidate's CV,
  // interview, and outcome, without a broader recruitment grant. See
  // src/lib/recruitment/hiring-manager-view.ts for the full rationale and per-record scoping.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/hiring-manager/candidates/**", permission: { resource: "hiring_interviews", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/hiring-manager/applications/**", permission: { resource: "hiring_interviews", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/hiring-manager/interviews/**", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
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
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/reassign", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
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
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/private-calendar/disputes", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/private-calendar/disputes/pending", permission: { resource: "attendance", action: "approve" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/private-calendar/disputes/:id/decide", permission: { resource: "attendance", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notification-confidence", permission: { resource: "communication", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notification-confidence/pending", permission: { resource: "communication", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/notification-confidence/:id/approve", permission: { resource: "communication", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/notification-confidence/:id/discard", permission: { resource: "communication", action: "update" }, guard: "domain-helper", csrfRequired: true }),
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
  // Had no entry of its own and fell through to the /api/sales/** blanket below, which carries no
  // audit classification — so this download escaped the export-audit guard twice over (the guard's
  // own regex also required a slash-delimited "template", missing the hyphenated name). The file is
  // a BLANK per-distributor layout with no customer data, but download routes are audited here as a
  // rule. Guarded on sales:import, matching the route's own assertPermission.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/source-of-sales/raw-template", permission: { resource: "sales", action: "import" } }),
  // Territory Management — read-only geographic view of brick allocation per line.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/filters", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/scope", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/map", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/search", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/territory-management/pin", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated Super-Admin-only JSON write: stores one hand-placed brick coordinate after a server-side role check and an Egypt bounding-box validation." }),
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
  // Monthly sales batch approvals (/sales/import?tab=approvals) — separate module from
  // Source of Sales and Weekly Sales above; its own upload template only.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/import/template", permission: { resource: "sales", action: "import" } }),
  // Monthly Sales (Achievement) Dashboard detailed workbook — available to everyone who can
  // already read the dashboard (no extra CEO/Super Admin gate, unlike the SoS BI workbook below).
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/monthly-dashboard/export", permission: { resource: "sales", action: "export" } }),
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
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/territory-drilldown", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/territory-drilldown/area/:areaCode", permission: { resource: "sales", action: "read" } }),
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
  // Sales Targets (au monthly targets/achievement) — Super Admin + SFE Manager via sales:import.
  // The per-area drill-down READ is sales:read so the scoped read-only Targets view can expand a
  // row, but it additionally enforces assertTargetsAreaInScope on the caller-supplied `area` — the
  // permission alone would let any DM enumerate another area's distributor/brick/customer detail.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/sales/targets/breakdown", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/targets/breakdown/export", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/targets/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/targets/save", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only targets upsert (sales:import); map-or-reject validated server-side, rejects confidential products." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/targets/upload", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin targets XLSX import (sales:import); parsed + map-or-reject validated server-side before persist." }),
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
  // Batched replacement for the pending-count polls below plus
  // /api/marketing-requests/pending-count (covered by the /api/marketing-requests/** entry, whose
  // domain-helper guard is the same model its sibling /inbox already uses — marketing has no
  // permission resource, so the badge is scoped by the caller's own assigned_hr_id instead). They
  // all stay registered and live for other consumers; each sub-count enforces its own domain guard.
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/badge-counts", permission: [{ resource: "leave", action: "read" }, { resource: "weekly_plans", action: "read" }, { resource: "direct_orders", action: "read" }] }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/vacation/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/excuse/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/plan/pending-count", permission: { resource: "weekly_plans", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/direct-orders/pending-count", permission: { resource: "direct_orders", action: "read" } }),
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
  // Employee 360 — consolidated per-employee profile (visits/check-ins in v1). Gated by
  // employee_profile:read; the page enforces per-row visibility via canSeeEmployee. Lives at
  // /employee-360 (the (admin) route group adds no URL segment), so it matches neither the
  // /admin/** nor /employee-portals/** catch-alls and needs its own explicit entries.
  { ...sessionApi({ methods: readOnly, pattern: "/employee-360", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-360/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/workspace/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/**", permission: { resource: "admin", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-portals/**", permission: { resource: "employee_profile", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/attendance/exceptions", permission: null, guard: "domain-helper" }), surface: "page" },
  // Approvals Hub › Vacation & Excuse approval pages — gated by leave:read so the confirmed
  // approver set (incl. CEO / Finance Manager / Financial Advisor) is not blocked by the
  // /admin/** admin:read catch-all. (Replaces the removed Vacation Action Center page.)
  { ...sessionApi({ methods: readOnly, pattern: "/admin/approvals/**", permission: { resource: "leave", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-portals/approvals/**", permission: { resource: "leave", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/outstation/expenses", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/outstation/expenses/dashboard", permission: null, guard: "domain-helper" }), surface: "page" },
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
