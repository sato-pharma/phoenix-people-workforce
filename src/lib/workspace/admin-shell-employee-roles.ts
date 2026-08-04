import { adminShellEmployeeRoles, type PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Admin-shell workspace PAGE role sets — the pure half of admin-shell-employee.ts.
//
// Split out because that module imports `next/navigation`, which the test runner
// cannot resolve, so anything living beside the guard is untestable except by
// regex over its source text. Same split, and the same reason, as
// marketing-requests/admin-page-access.ts.
//
// Pinned by tests/ceo-marketing-approval-inbox.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const workspaceMarketingRoles = [
  "SFE Manager",
  // Finance Execution of marketing requests runs from the workspace shell. Financial Advisor is the
  // designated executor. Finance Manager is included so they can monitor requests as observers.
  "Finance Manager",
  "Financial Advisor",
  // The CEO holds `ceo_approval`, the last required rung of the marketing chain. Every decision
  // button in the admin-shell inbox links to /workspace/marketing-requests/decision/<id>, so a CEO
  // missing here can see the request but not act on it. The CEO is NOT an adminShellEmployeeRole
  // (they have no employee workspace of their own) — which is exactly why the gate below treats an
  // explicit allowedRoles list as authoritative rather than intersecting it.
  "CEO",
] as const satisfies readonly PhoenixRole[];

function includesRole(roles: readonly PhoenixRole[], role: PhoenixRole) {
  return roles.some((entry) => entry === role);
}

/**
 * Whether `role` may open an admin-shell workspace page that declares `allowedRoles`.
 *
 * `allowedRoles` is the whole answer. It defaults to adminShellEmployeeRoles, so for the pages
 * that pass nothing this is identical to the previous `isAdminShellEmployeeRole && includesRole`
 * pair. The difference is a page that passes an EXPLICIT list — that list is now authoritative
 * instead of being intersected with adminShellEmployeeRoles. The intersection silently discarded
 * any role a page named on purpose but that has no employee workspace of its own, which is how the
 * CEO ended up listed as a marketing approver everywhere and still bounced off the decision page.
 */
export function canAccessAdminShellEmployeeWorkspacePage(
  role: PhoenixRole,
  allowedRoles: readonly PhoenixRole[] = adminShellEmployeeRoles,
) {
  return role === "Super Admin" || includesRole(allowedRoles, role);
}
