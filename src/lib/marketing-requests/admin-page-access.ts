import type { PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing admin-shell PAGE role gate — the pure half of
// app/(admin)/admin/marketing-requests/admin-access.ts.
//
// It lives here, not next to the guard, because the guard imports
// `next/navigation` and reports failure by throwing a redirect — neither of
// which a unit test can resolve or read a role decision out of. Same split, and
// the same reason, as coverage-report-access.ts.
//
// That file's header already states the rule this module exists to honour: a
// page's admin-shell role set must contain every approver whose
// resolveNavigationMode() is "admin", "or that role has NO working route at
// all" — assertEmployeePortalMarketingPageAccess redirects any non-portal role
// away from every /employee-portals/** page. The Coverage Report applied it;
// the Approval Inbox did not, and the CEO paid for it.
//
// Pinned by tests/ceo-marketing-approval-inbox.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles that operate the marketing workflow pages (requests, validation, bulk upload, control). */
const marketingAdminWorkflowRoles = new Set<PhoenixRole>([
  "SFE Manager",
  "Super Admin",
  "Marketing Manager",
  "Product Manager",
  "Group Product Manager",
]);

/**
 * Read-only ROI surfaces (ROI Tracking + its View Sales drill-down) additionally admit the
 * company-wide oversight roles — most importantly the CEO, the executive audience the ROI report
 * is built for. These roles are already treated as company-wide by the ROI service
 * (companyMarketingRoles), so this only aligns the page guard with the data layer; it does NOT
 * widen access to the marketing workflow pages (validation / requests / bulk upload).
 */
const marketingAdminCompanyOversightRoles = new Set<PhoenixRole>([
  "CEO",
  "Finance Manager",
  "Financial Advisor",
]);

/**
 * The Approval Inbox additionally admits the CEO, who holds `ceo_approval` — sequence 4 of the
 * live chain (Manager → SFE Validation → Marketing Review → CEO Approval) and the LAST required
 * rung, so nothing is ever approved without them.
 *
 * Deliberately its own set rather than folding the CEO into the workflow roles above: the CEO
 * decides marketing spend, they do not run customer validation, bulk upload, or the raw customer
 * database (live photos, addresses, phone numbers). And deliberately not reusing
 * `allowCompanyOversight` either — the finance roles in that set hold no rung on the chain, so
 * an inbox is not theirs to open.
 */
const marketingAdminApprovalInboxRoles = new Set<PhoenixRole>(["CEO"]);

export type MarketingAdminPageOptions = {
  customerDatabase?: boolean;
  systemAdministratorOnly?: boolean;
  allowCompanyOversight?: boolean;
  approvalInbox?: boolean;
};

/**
 * Whether `role` may open a marketing admin-shell page requested with `options`.
 *
 * Does not cover the `customerDatabase` / `systemAdministratorOnly` branch — that one defers
 * wholesale to canAccessSystemAdministratorWorkspace, which needs the full AccessContext (it
 * honours `scope === "system"`, not just the role label).
 */
export function canAccessMarketingAdminPage(
  role: string | null | undefined,
  options?: MarketingAdminPageOptions,
): boolean {
  if (!role) return false;
  const phoenixRole = role as PhoenixRole;
  if (marketingAdminWorkflowRoles.has(phoenixRole)) return true;
  if (options?.allowCompanyOversight && marketingAdminCompanyOversightRoles.has(phoenixRole)) return true;
  if (options?.approvalInbox && marketingAdminApprovalInboxRoles.has(phoenixRole)) return true;
  return false;
}
