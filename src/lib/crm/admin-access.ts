// ─────────────────────────────────────────────────────────────────────────────
// Who may use the admin CRM workspace.
//
// This used to be an inline `access.role !== "Super Admin"` check repeated across two pages and
// seven API routes. Owner decision (2026-08-02): the SFE Manager is responsible for sales and CRM,
// so he gets the workspace too. One predicate rather than nine copies — a role list that lives in
// nine places drifts, and a page granted without its own API routes just yields buttons that 403.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

/**
 * The admin CRM workspace: the raw company-wide mirror, visit/check-in integrity, unmapped
 * identity resolution, and the customer/region mapping tools.
 *
 * Super Admin holds it as platform owner. The SFE Manager holds it because CRM data quality —
 * which visits are real, which agents and customers are mapped — is the substance of his job.
 */
const ADMIN_CRM_WORKSPACE_ROLES = new Set<PhoenixRole>(["Super Admin", "SFE Manager"]);

export function canUseAdminCrmWorkspace(access: Pick<AccessContext, "role" | "scope">): boolean {
  if (access.scope === "system") return true;
  return ADMIN_CRM_WORKSPACE_ROLES.has(access.role);
}
