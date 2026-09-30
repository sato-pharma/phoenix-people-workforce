import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runBusinessCardRequestsTests() {
  const types = source("src/lib/business-cards/request-types.ts");
  const service = source("src/lib/business-cards/request-service.ts");
  const permissions = source("src/lib/auth/permissions.ts");
  const governance = source("src/lib/notifications/telegram-governance.ts");
  const templates = source("src/lib/notifications/telegram-templates.ts");
  const moduleCatalog = source("src/lib/navigation/module-catalog.ts");
  const employeePage = source("app/employee-portals/business-cards/page.tsx");
  const employeeComponent = source("src/components/business-cards/employee-business-card.tsx");
  const adminPage = source("app/(admin)/admin/business-card-requests/page.tsx");
  const adminComponent = source("src/components/business-cards/business-card-requests-queue.tsx");
  const employeeRoute = source("app/api/business-card-requests/route.ts");
  const adminRoute = source("app/api/admin/business-card-requests/route.ts");
  const navRegistry = source("src/components/employee-portal/employee-portal-nav-registry.ts");
  const portalLayout = source("src/components/employee-portal/employee-portal-layout.tsx");
  const nativeDirectory = source("src/lib/employee-portal/native-module-directory.ts");
  const systemNavigation = source("src/config/system-navigation.ts");
  const accessRegistry = source("src/lib/security/access-registry.ts");

  // ── Status set is exactly the four business-card lifecycle states ──────────────────
  assert.match(
    types,
    /BUSINESS_CARD_REQUEST_STATUSES = \["Pending", "In Progress", "Printed", "Cancelled"\] as const/,
    "business card requests have exactly four statuses",
  );

  // ── The employee may correct ONLY name and mobile; email is never sent by them ─────
  // (owner, 2026-09-30: "they can edit name or number email never").
  assert.match(
    types,
    /export type CreateBusinessCardRequestInput = \{[\s\S]*?cardMobile: string;[\s\S]*?cardName: string;[\s\S]*?note\?: string \| null;[\s\S]*?\};/,
    "the request input carries only name, mobile and an optional note — never an email",
  );
  assert.doesNotMatch(
    types,
    /export type CreateBusinessCardRequestInput = \{[^}]*email/,
    "the request input must not accept an email from the client",
  );
  // The service resolves email/title/line·area from the register, not the request body.
  assert.match(
    service,
    /card_email: own\.email \|\| null/,
    "the printed email is snapshotted from the employee record, never from the request body",
  );
  assert.match(
    service,
    /card_title: own\.title \|\| null/,
    "the printed job title is taken from the record server-side",
  );
  assert.doesNotMatch(
    service,
    /card_email: (clean|cleanLine)?\(?input\./,
    "the email must never be set from input",
  );

  // ── The request never writes back to the employees record ──────────────────────────
  assert.doesNotMatch(
    service,
    /\.from\("employees"\)[\s\S]*?\.update/,
    "a business card request must not mutate the employees record",
  );

  // ── Permission wiring: a new resource shaped exactly like support_requests ─────────
  assert.match(permissions, /\| "business_card_requests"/, "business_card_requests is a PermissionResource");
  assert.match(
    permissions,
    /case "business_card_requests":[\s\S]*?isHrAuthorityRole\(role\) \? hrSupportStaffActions : supportRequestSenderActions/,
    "every employee may create, HR staff read/update — the support_requests shape",
  );
  assert.match(
    permissions,
    /resource === "support_requests" \|\| resource === "business_card_requests"/,
    "the sender-create grant must survive the hard-boundary via the same special-case as support_requests",
  );
  // Sender actions are create-only; the boundary sets it directly so create is granted to all roles.
  assert.match(permissions, /supportRequestSenderActions: PermissionAction\[\] = \["create"\]/, "sender action is create-only");

  // ── Service: server-enforced permissions on every path ─────────────────────────────
  assert.match(
    service,
    /createBusinessCardRequest[\s\S]*?assertPermission\(access, "business_card_requests", "create"\)/,
    "create must enforce business_card_requests:create",
  );
  assert.match(
    service,
    /listAllBusinessCardRequests[\s\S]*?assertPermission\(access, "business_card_requests", "read"\)/,
    "the HR queue list must enforce business_card_requests:read",
  );
  assert.match(
    service,
    /updateBusinessCardRequestStatus[\s\S]*?assertPermission\(access, "business_card_requests", "update"\)/,
    "status update must enforce business_card_requests:update",
  );
  // The viewer's own list is scoped by hr_id, not gated by a read grant they do not hold.
  assert.match(
    service,
    /listBusinessCardRequestsForViewer[\s\S]*?\.eq\("hr_id", hrId\)/,
    "the employee's own request list is scoped to their hr_id",
  );

  // ── Notification: to B-10 AND HR-009, in-app + email + telegram, requester deduped ─
  assert.match(
    service,
    /BUSINESS_CARD_REQUEST_RECIPIENT_HR_IDS = \["B-10", "HR-009"\] as const/,
    "the owner (B-10) and HR Operations (HR-009) are the two recipients",
  );
  assert.match(
    service,
    /channels: \["in_app", "email", "telegram"\]/,
    "the request notifies by in-app, email and telegram (owner, 2026-09-30)",
  );
  assert.match(service, /module: "business_card_requests"/, "notification uses the business_card_requests module");
  assert.match(service, /createSystemNotificationForRecipients/, "notification fans out to the fixed recipient pair");
  assert.match(
    service,
    /!hrIdsMatch\(hrId, request\.hrId\)/,
    "the requester is not notified of their own request",
  );
  // Persist first, then alert best-effort so a notification failure never loses the request.
  assert.match(
    service,
    /const notification = await notifyBusinessCardRecipients\(created\);\r?\n {2}return \{ notification, row: created \};/,
    "the request is saved first, then HR is alerted best-effort",
  );

  // ── Telegram governance + template register the new module (else telegram is dropped)
  assert.match(
    governance,
    /module: "business_card_requests"[\s\S]*?enabled: true/,
    "business_card_requests must be Telegram-enabled or the fail-safe drops it",
  );
  assert.match(templates, /module: "business_card_requests"/, "a Telegram template must exist for the module");
  assert.match(templates, /\| "business_card_requests"/, "the module is in the Telegram workflow-key union");

  // ── The module label map is exhaustive over PermissionResource ─────────────────────
  assert.match(moduleCatalog, /business_card_requests: "Business Card Requests"/, "the module has a human label");

  // ── Employee page: reachable by every employee, gated by business_card_requests:create
  assert.match(
    employeePage,
    /assertPermission\(access, "business_card_requests", "create"\)/,
    "the portal page gate must match the nav registry permission (B6)",
  );
  assert.match(employeePage, /EmployeeBusinessCard/, "the portal page renders the employee card component");

  // ── Employee component: email shown but not editable ───────────────────────────────
  assert.match(
    employeeComponent,
    /disabled\s+id="business-card-email"/,
    "the email field is shown to the employee but disabled",
  );
  assert.match(employeeComponent, /cardName: trimmedName, cardMobile: mobile\.trim\(\)/, "only name and mobile are submitted");
  assert.doesNotMatch(
    employeeComponent,
    /body: JSON\.stringify\(\{[^}]*email/,
    "the employee component must not submit an email",
  );

  // ── Admin queue: server-guarded read + a manage capability gate ────────────────────
  assert.match(adminPage, /canAccess\(access, "business_card_requests", "read"\)/, "admin page guards read");
  assert.match(adminPage, /canAccess\(access, "business_card_requests", "update"\)/, "admin page computes manage");
  assert.match(adminPage, /BusinessCardRequestsQueue/, "admin page renders the queue");
  assert.match(adminComponent, /canManage \?/, "the queue gates the status control behind canManage");
  assert.match(adminComponent, /method: "PATCH"/, "the queue updates status via PATCH");

  // ── API routes ─────────────────────────────────────────────────────────────────────
  assert.match(employeeRoute, /export async function GET/, "employee route exposes GET (own list)");
  assert.match(employeeRoute, /export async function POST/, "employee route exposes POST (create)");
  assert.match(employeeRoute, /assertSameOriginMutation\(request\)/, "employee create is CSRF-guarded");
  assert.match(adminRoute, /export async function PATCH/, "admin route exposes PATCH (status)");
  assert.match(adminRoute, /isForbiddenError\(error\)[\s\S]*?status: 403/, "admin route maps forbidden → 403");

  // ── Navigation is wired on every surface its tests enforce ─────────────────────────
  assert.match(
    navRegistry,
    /href: "\/employee-portals\/business-cards"[\s\S]*?resource: "business_card_requests", action: "create"/,
    "the bottom-nav registry entry permission must match the page gate",
  );
  assert.match(portalLayout, /href: "\/employee-portals\/business-cards"/, "the portal sidebar lists the page for everyone");
  assert.match(
    nativeDirectory,
    /"\/employee-portals\/business-cards": \{ icon: "id-card-outline", section: "My Workspace" \}/,
    "the native module directory places the page in My Workspace, matching the sidebar section",
  );
  assert.match(
    systemNavigation,
    /href: "\/admin\/business-card-requests"[\s\S]*?resource: "business_card_requests"[\s\S]*?roles: hrAuthorityNavigationRoles/,
    "the admin queue is exposed only to HR authority roles",
  );
  assert.match(
    accessRegistry,
    /pattern: "\/api\/admin\/business-card-requests", permission: \{ resource: "business_card_requests", action: "read" \}/,
    "the admin API route is registered in the access registry",
  );
  assert.match(
    accessRegistry,
    /pattern: "\/api\/business-card-requests", permission: \{ resource: "business_card_requests", action: "create" \}/,
    "the employee API route is registered in the access registry",
  );
}
