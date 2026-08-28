/**
 * Who may open the Doctor List board, and whose reps they see.
 *
 * WIDENED 2026-08-28 from Super Admin only to the district managers the owner asked for. The note
 * this file carried until then set the condition for widening in plain words: "this stays on one
 * account until the reps-per-manager scope lands with tab two. Widening it is a change here plus a
 * nav entry plus a scope filter in the loader — in that order, and the scope filter is not
 * optional." That scope now exists in `manager-scope.ts`, and `getDoctorListBoard` filters the rep
 * picker through it. All three landed together, which is the only order that is safe.
 *
 * WHY THE SCOPE FILTER IS THE POINT. The fault the owner caught on Doctor Coverage on 2026-08-28 was
 * not that the data was wide — it was that the data was scoped and the PICKER was not, so a medical
 * rep was offered the names of all ~73 reps. A picker is never wider than its viewer. Here the same
 * scope that filters the rows filters the picker, from one call, so the two cannot drift.
 *
 * ## A longer list than the Plans tab, on purpose
 *
 * This board is READ-ONLY: a rep's assigned doctors, as the CRM holds them. The Plans tab beside it
 * carries a button that writes an approval into the customer's CRM. So the Plans tab's role list is
 * deliberately shorter, and the two lists are kept in separate files rather than shared — sharing
 * would grant the write by granting the read, silently, on the next edit.
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts `crm_visits:read`
 * through the permission matrix, which is the actual security boundary — a role list is a fast
 * explicit guard, nothing more.
 */

import { getManagerScope, type CrmManagerScope, type CrmScopeBasis } from "@/lib/crm/manager-scope";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

/**
 * Whole-company reach.
 *
 * Wider than the Plans tab's company list by two seats. SFE Manager and Marketing Manager read rep
 * activity company-wide on Doctor Coverage already, and this board is the same kind of read — the
 * list a rep was given. Neither seat supervises a rep, which is exactly why neither appears on the
 * Plans tab's list.
 */
const COMPANY_ROLES = ["Super Admin", "CEO", "National Sales Manager", "SFE Manager"] as const;

/** Own management subtree. The district manager is the seat the owner asked for. */
const TEAM_ROLES = ["Regional Manager", "District Manager"] as const;

const BASIS_BY_ROLE = new Map<string, CrmScopeBasis>([
  ...COMPANY_ROLES.map((role) => [role, "company"] as const),
  ...TEAM_ROLES.map((role) => [role, "team"] as const),
]);

export const DOCTOR_LIST_ACCESS_ROLES: readonly PhoenixRole[] = [
  ...COMPANY_ROLES,
  ...TEAM_ROLES,
] as unknown as readonly PhoenixRole[];

export function canAccessDoctorList(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return BASIS_BY_ROLE.has(context.role);
}

export function assertDoctorListAccess(context: Pick<AccessContext, "role" | "scope">): void {
  if (!canAccessDoctorList(context)) {
    throw new Error(`Forbidden: ${context.role} cannot read doctor lists.`);
  }
}

/** `null` → this role has no access to the doctor list at all. */
export function doctorListBasisForRole(role: string): CrmScopeBasis | null {
  return BASIS_BY_ROLE.get(role) ?? null;
}

/**
 * Which reps' lists the viewer may see.
 *
 * Passed straight into `getDoctorListBoard`, which uses it for BOTH the rows and the picker.
 */
export async function getDoctorListScope(access: AccessContext): Promise<CrmManagerScope> {
  const basis = doctorListBasisForRole(access.role);
  if (!basis && access.scope !== "system") {
    return { kind: "none", reason: `Doctor lists are not available to the ${access.role} role.` };
  }
  return getManagerScope({
    basis: basis ?? "company",
    label: basis === "team" ? `${access.role} · own team` : `${access.role} · all reps`,
    viewerHrId: access.hrId,
  });
}
