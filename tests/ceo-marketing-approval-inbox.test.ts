import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { canAccessMarketingAdminPage } from "../src/lib/marketing-requests/admin-page-access.ts";
import {
  adminNavigationSections,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  createAccessContext,
  permissionActions,
  permissionMatrix,
  permissionResources,
  resolveNavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  canAccessAdminShellEmployeeWorkspacePage,
  workspaceMarketingRoles,
} from "../src/lib/workspace/admin-shell-employee-roles.ts";

const ADMIN_INBOX_HREF = "/admin/marketing-requests/inbox";

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const rolePermissions = permissionMatrix[role];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function adminHrefsFor(role: PhoenixRole): string[] {
  return getSections(adminNavigationSections as readonly NavigationSection[], "admin", lookupForRole(role), role)
    .flatMap((navSection) => navSection.items.map((navItem) => navItem.href));
}

/**
 * The CEO must be able to DECIDE a marketing request, not merely be named as its approver.
 *
 * `ceo_approval` is sequence 4 of the live chain (Manager → SFE Validation → Marketing Review →
 * CEO Approval) and the last required rung, so no marketing spend is ever approved without it.
 * The data layer had always been right — the step carries the CEO's own HR_ID and
 * marketingInboxRoles has always listed "CEO" — but every route to it was shut:
 *
 *   - resolveNavigationMode pins the CEO to the ADMIN shell, so every
 *     /employee-portals/marketing-requests page redirected them to /overview;
 *   - the admin inbox guard's allow-set omitted "CEO" and redirected them BACK to
 *     /employee-portals/marketing-requests — the page that had just rejected them;
 *   - the sidebar never rendered the link, so there was nothing to click either way;
 *   - and the inbox's Approve/Return/Reject buttons point at
 *     /workspace/marketing-requests/decision, whose guard intersected its explicit
 *     allowedRoles with adminShellEmployeeRoles — a set the CEO is deliberately not in.
 *
 * Found live on 2026-08-04: MKT-REQ-20260802-DCF31EC4 (5,500 EGP) cleared Marketing Review at
 * 13:30 Cairo, the CEO was notified at 13:31 on email/in-app/push, and every one of those links
 * resolved to a page that redirected him away. The chain's final rung was unreachable by design,
 * not by accident of data. Each assertion below pins one of the four doors; any one of them
 * closing again reproduces the outage.
 */
export function runCeoMarketingApprovalInboxTests() {
  const ceo = createAccessContext({ hrId: "AA", role: "CEO" });

  // ── The premise: the CEO has exactly ONE shell, so admin-shell access is not optional ────────
  assert.equal(
    resolveNavigationMode(ceo),
    "admin",
    "CEO is an admin-shell executive — the employee portal is never a fallback route to their inbox",
  );

  // ── Door 1: the admin inbox page guard ──────────────────────────────────────────────────────
  assert.equal(
    canAccessMarketingAdminPage("CEO", { approvalInbox: true }),
    true,
    "the CEO holds the final required rung and must be able to open the marketing approval inbox",
  );

  // …and the page must actually ASK for that opt-in. The predicate being right is worthless if
  // the inbox still calls the guard bare, which is exactly how it shipped.
  const adminInboxPageSource = readFileSync("app/(admin)/admin/marketing-requests/inbox/page.tsx", "utf8");
  assert.match(
    adminInboxPageSource,
    /assertMarketingAdminPageAccess\(\{\s*approvalInbox:\s*true\s*\}\)/,
    "the admin approval inbox page must request the approvalInbox gate, or the CEO is redirected out of it again",
  );

  // ── Door 2: the sidebar link that leads there ───────────────────────────────────────────────
  const ceoAdminHrefs = adminHrefsFor("CEO");
  assert.equal(
    ceoAdminHrefs.includes(ADMIN_INBOX_HREF),
    true,
    "the CEO must see the Marketing Approval Inbox in the admin sidebar — an unreachable page is the same as no page",
  );

  // ── Door 3: the decision page every Approve/Return/Reject button links to ────────────────────
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("CEO", workspaceMarketingRoles),
    true,
    "the CEO must reach /workspace/marketing-requests/decision — seeing the request without deciding it is not approval",
  );

  // ── The inbox flag is a scalpel, not a widening ──────────────────────────────────────────────
  // The CEO approves marketing spend; they do not run customer validation, bulk upload, or the raw
  // customer database (live photos, addresses, phone numbers). Those pages call the guard with no
  // options, and must keep bouncing the CEO.
  assert.equal(
    canAccessMarketingAdminPage("CEO"),
    false,
    "the inbox opt-in must not hand the CEO the marketing workflow/validation pages",
  );
  assert.equal(
    canAccessMarketingAdminPage("Medical Rep", { approvalInbox: true }),
    false,
    "the inbox opt-in admits the CEO specifically, never every role",
  );

  // The roles the guard already admitted must be unaffected by the new flag, in both directions.
  for (const role of ["SFE Manager", "Super Admin", "Marketing Manager", "Product Manager", "Group Product Manager"]) {
    assert.equal(canAccessMarketingAdminPage(role), true, `${role} keeps its existing marketing admin access`);
    assert.equal(
      canAccessMarketingAdminPage(role, { approvalInbox: true }),
      true,
      `${role} still reaches the approval inbox`,
    );
  }
  // allowCompanyOversight stays read-only ROI surfaces: it must not become a second inbox key for
  // the finance roles, which hold no rung on the chain.
  assert.equal(canAccessMarketingAdminPage("Finance Manager", { allowCompanyOversight: true }), true);
  assert.equal(
    canAccessMarketingAdminPage("Finance Manager", { approvalInbox: true }),
    false,
    "approvalInbox is the CEO's rung, not a company-oversight alias",
  );

  // ── The workspace gate now trusts an explicit allowedRoles list — verify it did not fail open ─
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("Talent Acquisition", workspaceMarketingRoles),
    false,
    "an admin-shell employee role NOT named by the page is still denied — the list is authoritative, not additive",
  );
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("Medical Rep", workspaceMarketingRoles),
    false,
    "a portal role never reaches the admin-shell marketing decision page",
  );
  for (const role of ["SFE Manager", "Finance Manager", "Financial Advisor"] as const) {
    assert.equal(
      canAccessAdminShellEmployeeWorkspacePage(role, workspaceMarketingRoles),
      true,
      `${role} keeps the workspace marketing access it already had`,
    );
  }
  // Default list (the 18 pages that pass no allowedRoles) must behave exactly as before.
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("Talent Acquisition"),
    true,
    "the default allowedRoles is still adminShellEmployeeRoles",
  );
  assert.equal(canAccessAdminShellEmployeeWorkspacePage("CEO"), false, "the CEO gains no general employee workspace");
  assert.equal(
    canAccessAdminShellEmployeeWorkspacePage("Super Admin", workspaceMarketingRoles),
    true,
    "Super Admin's blanket bypass survives the rewrite",
  );
}
