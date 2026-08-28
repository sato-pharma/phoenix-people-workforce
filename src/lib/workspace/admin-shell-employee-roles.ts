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
  // Finance Execution of marketing requests runs from the workspace shell. The Finance Manager is
  // the EXECUTOR as of 2026-08-10, not an observer: the owner activated the `finance_execution`
  // step and pointed it at that role ("Ahmed is the next step after CEO"), making him the terminal
  // rung. (This comment previously named Financial Advisor as the designated executor — that was
  // true until the step was re-pointed, and there has never been a Financial Advisor login;
  // app_auth_users_role_check does not even permit the value.)
  "Finance Manager",
  "Financial Advisor",
  // The CEO holds `ceo_approval`, the last required rung of the marketing chain. Every decision
  // button in the admin-shell inbox links to /workspace/marketing-requests/decision/<id>, so a CEO
  // missing here can see the request but not act on it. The CEO is NOT an adminShellEmployeeRole
  // (they have no employee workspace of their own) — which is exactly why the gate below treats an
  // explicit allowedRoles list as authoritative rather than intersecting it.
  "CEO",
] as const satisfies readonly PhoenixRole[];

/**
 * Who may open /workspace/expense-dashboard — adminShellEmployeeRoles MINUS the Finance Manager.
 *
 * Exists solely to close a leak the 2026-08-10 removal would otherwise have left open. The owner's
 * instruction was "exclude him 100% from outstation or expenses", and his `outstation` key was
 * deleted — but `expenses: ["read"]` had to survive because that one permission also gates the
 * whole /api/marketing-requests/** namespace, including the decision route he executes the terminal
 * `finance_execution` rung from. That residual grant is exactly what this page checks
 * (`requireAdminShellEmployeeWorkspaceAccess({ resource: "expenses" })`), and he IS an
 * adminShellEmployeeRole, so both default gates would have passed and the Outstation Expense
 * Dashboard would still have opened for him by URL.
 *
 * getExpensesScope returns SELF for the role now, so the page would have rendered empty rather than
 * leaking anyone's claims — but an empty expense dashboard is still an expense surface, and "100%"
 * means the door does not open. An explicit allowedRoles list is authoritative here (see
 * canAccessAdminShellEmployeeWorkspacePage below), so naming the set is the fix.
 *
 * Delete this constant and revert the page to the default the moment the marketing routes move off
 * `expenses` onto a marketing-specific resource — at that point the `expenses` key leaves his matrix
 * entirely and the default gate closes on its own.
 */
export const workspaceExpenseDashboardRoles = [
  "SFE Manager",
  "Financial Advisor",
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
