/**
 * Plan Verification — WHO may open the board.
 *
 * The org walk itself is not here. It lives in `manager-scope.ts` and is shared with the Doctor List
 * tab beside this one, because both tabs answer the same question about the same org tree. What
 * stays local is the ROLE POLICY, and it is local on purpose: this board carries a button that
 * writes into the customer's CRM, so its role list is deliberately shorter than the doctor list's.
 * Sharing one list would grant the write by granting the read.
 *
 * Two different questions, kept apart:
 *
 *  - WHO MAY OPEN THE BOARD (`planVerificationBasisForRole`) — a role question, answered here.
 *  - WHOSE PLANS THEY SEE (`getPlanVerificationScope`) — an org-tree question, delegated.
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts `crm_visits:update`
 * through the permission matrix, which is the actual security boundary — a role list is a fast
 * explicit guard, nothing more.
 */

import { getManagerScope, scopeAllowsAgent, type CrmManagerScope, type CrmScopeBasis } from "@/lib/crm/manager-scope";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * Whole-company reach. Deliberately SHORT.
 *
 * Super Admin and CEO only. Doctor Coverage also grants company reach to SFE Manager and Marketing
 * Manager, and that is right for a coverage REPORT — but neither of those seats supervises a medical
 * rep. Reading a rep's numbers and signing off his plan are not the same authority.
 */
const COMPANY_ROLES = ["Super Admin", "CEO"] as const;

/**
 * Own management subtree — every rep beneath the seat, however many levels down.
 *
 * The district manager is the seat the owner asked for. The regional manager is included because he
 * sits directly above the DM in the same tree, so a plan a DM may verify is already inside an RM's
 * subtree; excluding him would mean a plan goes unverified whenever a district seat is vacant, which
 * is precisely when someone above needs to act. The National Sales Manager is NOT here — his reach
 * on Doctor Coverage is a product LINE, not a management subtree, and a line is not a supervisory
 * relationship over a named rep.
 */
const TEAM_ROLES = ["Regional Manager", "District Manager"] as const;

const BASIS_BY_ROLE = new Map<string, CrmScopeBasis>([
  ...COMPANY_ROLES.map((role) => [role, "company"] as const),
  ...TEAM_ROLES.map((role) => [role, "team"] as const),
]);

/** Every role with any access to plan verification. */
export const PLAN_VERIFICATION_ROLES: readonly string[] = Array.from(BASIS_BY_ROLE.keys());

/** `null` → this role has no access to plan verification at all. */
export function planVerificationBasisForRole(role: string): CrmScopeBasis | null {
  return BASIS_BY_ROLE.get(role) ?? null;
}

/** Convenience predicate for nav config and page gates. Reads only the map above — no IO. */
export function canAccessPlanVerification(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return BASIS_BY_ROLE.has(context.role);
}

/** The plans board's scope is an ordinary manager scope; the alias exists so callers read plainly. */
export type PlanVerificationScope = CrmManagerScope;

/**
 * Resolve the viewer's reach.
 *
 * `access.role` must come from the live AccessContext and never from client input.
 */
export async function getPlanVerificationScope(access: AccessContext): Promise<PlanVerificationScope> {
  const basis = planVerificationBasisForRole(access.role);
  // `scope === "system"` is the server's own context (cron, internal callers), not a person.
  if (!basis && access.scope !== "system") {
    return { kind: "none", reason: `Plan verification is not available to the ${access.role} role.` };
  }
  return getManagerScope({
    basis: basis ?? "company",
    label: basis === "team" ? `${access.role} · own team` : `${access.role} · all reps`,
    viewerHrId: access.hrId,
  });
}

/** Re-exported so a caller holding a scope and an agent can ask the one question without importing
 * two modules. The answer lives in `manager-scope.ts`; this is only a convenience. */
export { scopeAllowsAgent };
