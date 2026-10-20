import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

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
  // The viewer's own list is scoped by hr_id, not gated by a read grant they do not hold. Matched on
  // EVERY spelling of his id since 2026-10-03 (`hrIdLookupKeys`), because the column is now persisted
  // in the stored uppercase form while `access.hrId` is the lowercase comparison key — a single `.eq`
  // on one of them returns nothing at all. The self-scope is unchanged: still his own id and no other.
  assert.match(
    service,
    /listBusinessCardRequestsForViewer[\s\S]*?const keys = hrIdLookupKeys\(access\.hrId\);[\s\S]*?\.in\("hr_id", keys\)/,
    "the employee's own request list is scoped to their hr_id, in every spelling of it",
  );

  // ── Notification: to the owner AND the HR Generalist seat, in-app + email + telegram, requester deduped ─
  // Owner, 2026-10-20: "Both to you until the hire". The second recipient is the SEAT, resolved at
  // send time, so no person's HR id is written here; while the seat is empty its stand-in is the
  // Super Admin, who collapses into the owner's own copy. tests/vacant-seat-recipients.test.ts pins
  // the resolution itself.
  assert.match(service, /const BUSINESS_CARD_REQUEST_OWNER_HR_ID = "B-10";/, "the owner is the fixed recipient");
  assert.match(
    service,
    /const BUSINESS_CARD_REQUEST_SEAT = HR_GENERALIST_SEAT;/,
    "the second recipient is the HR Generalist seat, never a named person",
  );
  assert.match(
    service,
    /await resolveSeatOrStandInHrIds\(BUSINESS_CARD_REQUEST_SEAT, /,
    "the seat is resolved to its people when the request is sent",
  );
  assert.ok(!/["']HR-\d/.test(stripComments(service)), "no employee but the owner is named by HR id");
  assert.match(
    service,
    /channels: \["in_app", "email", "telegram"\]/,
    "the request notifies by in-app, email and telegram (owner, 2026-09-30)",
  );
  assert.match(service, /module: "business_card_requests"/, "notification uses the business_card_requests module");
  assert.match(service, /createSystemNotificationForRecipients/, "notification fans out to the owner and the seat's people");
  assert.match(
    service,
    /!hrIdsMatch\(hrId, requesterHrId\)/,
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
    /"\/employee-portals\/business-cards": \{ icon: "id-card-outline", section: "Social" \}/,
    "the native module directory places the page in the Social band, matching the sidebar section",
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

  // ── hr_id IS PERSISTED IN THE STORED FORM, NEVER THE COMPARISON KEY ────────────────
  // `AccessContext.hrId` is `canonicalHrIdKey` — LOWERCASE — which is right for matching and wrong
  // for persisting; writing it is what left ~37,000 lowercase actor ids across 52 columns
  // (src/lib/hr-id.ts). This service wrote that key straight into `business_card_requests.hr_id`,
  // and the table had no row until 2026-10-03, so the defect was latent: the FIRST request ever sent
  // would have stored `ph-0123` where `employees.hr_id` holds `PH-0123` (measured on production: 204
  // of 205 employee rows uppercase), and any exact-match join to the register would have returned
  // nothing at all rather than something wrong. Both halves are pinned — the write goes through
  // `hrIdForStorage`, and the viewer's own list matches EVERY spelling so a row written before the
  // fix is still his.
  assert.match(service, /import \{ hrIdForStorage, hrIdLookupKeys \} from "@\/lib\/hr-id"/, "the service uses the hr-id storage helpers");
  assert.match(service, /hr_id: storedHrId,/, "the insert persists the stored (uppercase) form of the id");
  assert.match(service, /const storedHrId = hrIdForStorage\(access\.hrId\);/, "the stored form comes from hrIdForStorage, not the access key");
  assert.doesNotMatch(service, /hr_id: hrId,/, "the lowercase comparison key is never written to the table");
  assert.match(
    service,
    /\.in\("hr_id", keys\)/,
    "the viewer's own list matches every spelling of his id, not one bare .eq",
  );
  assert.doesNotMatch(service, /\.eq\("hr_id", hrId\)/, "a single-spelling .eq would silently return nothing");
}
