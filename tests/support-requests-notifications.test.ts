import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runSupportRequestsNotificationsTests() {
  const service = source("src/lib/support-requests/service.ts");
  const governance = source("src/lib/notifications/telegram-governance.ts");
  const navigation = source("src/lib/employee-portal/navigation.ts");

  // ── Contact HR Support graduated from Beta: visible to every portal user ───────────
  assert.match(
    navigation,
    /showSupportTab: true,/,
    "Contact HR Support must be a full module (showSupportTab: true), not Beta-gated",
  );

  // ── Telegram governance must allow the support module (else HR gets no Telegram) ───
  assert.match(
    governance,
    /module: "support_requests"[\s\S]*?enabled: true/,
    "support_requests must be Telegram-enabled in governance so HR is alerted",
  );

  // ── HR notification wired on ticket creation ───────────────────────────────────────
  assert.match(service, /createSystemNotification/, "support service must use the unified notification engine");
  assert.match(service, /async function resolveHrSupportRecipients/, "HR recipient resolver must exist");
  assert.match(service, /\.in\("role", \["HR Specialist", "Super Admin"\]\)/, "HR audience must include HR Specialist + Super Admin accounts");
  assert.match(service, /HR Manager|Admin HR/i, "HR audience must include HR Manager / Admin HR titled employees");
  assert.match(service, /async function notifyHrOfSupportRequest/, "support service must alert HR on creation");
  assert.match(service, /module: "support_requests"/, "support notification must use the support_requests module");
  assert.match(
    service,
    /channels: \(normalizeHrId\(recipient\.hrId\) \|\| recipient\.userId \|\| ""\) === primaryKey \? \["in_app", "email", "telegram"\] : \["in_app", "telegram"\]/,
    "support notification should route email to only the primary HR recipient",
  );
  assert.match(service, /priority: "high"/, "a new support ticket is action-required (high priority)");
  assert.match(service, /eventType: "support_request_created"/, "support notification eventType");
  assert.match(service, /support_request:\$\{request\.id\}:created:/, "support notification must carry a per-recipient idempotency key");
  assert.match(service, /!sameHrId\(recipient\.hrId, request\.hrId\)/, "the submitter must not be notified of their own ticket");

  // ── Failure isolation: notifying HR must never break ticket creation ───────────────
  assert.match(service, /Promise\.allSettled/, "HR fan-out must use allSettled");
  assert.match(
    service,
    /const notification = await notifyHrOfSupportRequest\(created\);\r?\n {2}return \{ notification, row: created \};/,
    "creation must persist the ticket first, then alert HR best-effort while bubbling delivery status",
  );

  // ── Silent-fail audit: HR recipient lookup must not swallow errors to [] ──────────
  assert.doesNotMatch(
    service,
    /Failed to resolve HR support recipients[\s\S]*?return \[\];/,
    "resolveHrSupportRecipients must surface failures, not silently return []",
  );
  assert.match(
    service,
    /async function resolveSuperAdminFallbackRecipients/,
    "Super Admin fallback path must exist for when the primary HR lookup fails or returns 0",
  );
  assert.match(
    service,
    /resolveSuperAdminFallbackRecipients\(\)/,
    "notifyHrOfSupportRequest must invoke the Super Admin fallback when the primary lookup yields no recipients",
  );
  assert.match(
    service,
    /export type SupportNotificationStatus = \{[\s\S]*?errored: boolean;[\s\S]*?fellBackToSuperAdmin: boolean;[\s\S]*?recipientCount: number;[\s\S]*?\};/,
    "SupportNotificationStatus must expose errored / fellBackToSuperAdmin / recipientCount to the API surface",
  );
  assert.match(
    service,
    /Promise<CreateSupportRequestResult>/,
    "createSupportRequest must return { row, notification } so the route can render a delivery diagnostic",
  );

  // ── API route forwards the delivery diagnostic so the UI can render a banner ──────
  const submitRoute = source("app/api/support/requests/route.ts");
  assert.match(
    submitRoute,
    /NextResponse\.json\(\{ item: row, notification \}/,
    "submit route must surface notification status alongside the saved ticket",
  );

  // ── Admin management surface: list-all + status update, server-enforced ────────────
  assert.match(service, /export async function listAllSupportRequests/, "admin list service must exist");
  assert.match(service, /export async function updateSupportRequestStatus/, "status-update service must exist");
  assert.match(
    service,
    /listAllSupportRequests[\s\S]*?assertPermission\(access, "support_requests", "read"\)/,
    "admin list must enforce support_requests:read on the server",
  );
  assert.match(
    service,
    /updateSupportRequestStatus[\s\S]*?assertPermission\(access, "support_requests", "update"\)/,
    "status update must enforce support_requests:update on the server",
  );
  assert.match(service, /SUPPORT_REQUEST_STATUSES\.includes\(status\)/, "status update must validate the target status");

  // API route enforces auth + maps forbidden → 403.
  const route = source("app/api/admin/support-requests/route.ts");
  assert.match(route, /export async function GET/, "admin route must expose GET (list)");
  assert.match(route, /export async function PATCH/, "admin route must expose PATCH (status update)");
  assert.match(route, /resolveAccessContext\(request\)/, "admin route must resolve the caller");
  assert.match(route, /isForbiddenError\(error\)[\s\S]*?status: 403/, "admin route must map forbidden → 403");

  // Admin page guards read access and renders the workspace.
  const page = source("app/(admin)/admin/support-requests/page.tsx");
  assert.match(page, /canAccess\(access, "support_requests", "read"\)/, "admin page must guard support_requests:read");
  assert.match(page, /canAccess\(access, "support_requests", "update"\)/, "admin page must compute manage capability");
  assert.match(page, /SupportRequestsWorkspace/, "admin page must render the workspace");

  // Workspace only exposes the status control to managers (update permission).
  const workspace = source("src/components/admin/support-requests-workspace.tsx");
  assert.match(workspace, /canManage \?/, "workspace must gate the status control behind canManage");
  assert.match(workspace, /method: "PATCH"/, "workspace must update status via the PATCH endpoint");

  // Nav surfaces the admin entry behind the support_requests permission.
  const systemNavigation = source("src/config/system-navigation.ts");
  assert.match(
    systemNavigation,
    /href: "\/admin\/support-requests"[\s\S]*?resource: "support_requests"/,
    "admin nav must expose HR Support Requests gated by the support_requests permission",
  );
}
