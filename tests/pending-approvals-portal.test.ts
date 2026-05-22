import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const portalServiceSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
const portalDashboardSource = readFileSync("src/components/employee-portal/employee-portal-dashboard.tsx", "utf8");
const pendingApprovalsServiceSource = readFileSync("src/lib/pending-approvals/service.ts", "utf8");
const pendingApprovalsWorkspaceSource = readFileSync("src/components/pending-approvals/pending-approvals-workspace.tsx", "utf8");
const notificationRouteSource = readFileSync("app/api/notifications/in-app/route.ts", "utf8");
const notificationsPageSource = readFileSync("app/notifications/page.tsx", "utf8");
const pendingNotificationSource = readFileSync("src/lib/pending-approvals/notifications.ts", "utf8");

export function runPendingApprovalsPortalTests() {
  assert.match(
    portalServiceSource,
    /import \{ listPendingApprovals \} from "@\/lib\/pending-approvals\/service"/,
    "Employee portal dashboard data must use the unified pending approvals service.",
  );
  assert.match(
    portalServiceSource,
    /const pendingApprovalCount = pendingApprovalItems\.length/,
    "Employee portal pending approval count must come from assigned pending approvals, not expenses only.",
  );
  assert.match(
    portalServiceSource,
    /href: "\/pending-approvals"[\s\S]*?id: "pending-approvals"[\s\S]*?label: "Pending approvals waiting"/,
    "Employee portal action must route assigned approvals to the shared /pending-approvals page.",
  );
  assert.match(
    portalServiceSource,
    /const pendingExpenseApprovalCount = pendingApprovalItems\.filter\(\(item\) => item\.workflow === "expense"\)\.length/,
    "Employee portal expense action count must come from expense approvals, not broad expense dashboard rows.",
  );
  assert.match(
    portalServiceSource,
    /href: "\/pending-approvals\?type=expense"[\s\S]*?id: "expense-actions"[\s\S]*?label: "Expense approvals waiting"/,
    "Employee portal expense action must deep-link to the Expense filter on Pending Approvals.",
  );
  assert.match(
    portalDashboardSource,
    /data\.workforce\.pendingApprovals > 0/,
    "Employee portal quick action must show when the unified pending approval count is nonzero.",
  );
  assert.match(
    pendingApprovalsServiceSource,
    /item\.canDecide !== false/,
    "Decision mutations must ignore read-only pending requests submitted by the same user.",
  );
  assert.match(
    pendingApprovalsServiceSource,
    /Waiting for outstation approval/,
    "Employee portal pending approvals must include the user's own submitted outstation requests as read-only status items.",
  );
  assert.match(
    pendingApprovalsServiceSource,
    /canViewOwnOutstationStatus/,
    "Employee portal pending approvals must allow employees to see their own submitted outstation status without approval authority.",
  );
  assert.match(
    pendingApprovalsWorkspaceSource,
    /const canDecide = item\.canDecide !== false/,
    "Pending approvals UI must hide approve/reject actions for read-only status items.",
  );
  assert.match(
    pendingApprovalsWorkspaceSource,
    /initialTypeFilter/,
    "Pending approvals UI must support initial workflow filtering from the page URL.",
  );
  assert.match(
    notificationRouteSource,
    /mergePendingApprovalNotifications/,
    "In-app notification API must merge assigned pending approvals into the bell response.",
  );
  assert.match(
    notificationsPageSource,
    /mergePendingApprovalNotifications/,
    "Notification history must include assigned pending approvals.",
  );
  assert.match(
    pendingNotificationSource,
    /category: "pending_approval"/,
    "Synthetic approval notifications must be categorized separately from stored events.",
  );
  assert.match(
    pendingNotificationSource,
    /href: "\/pending-approvals"/,
    "Synthetic approval notifications must open the shared pending approvals link.",
  );
}
