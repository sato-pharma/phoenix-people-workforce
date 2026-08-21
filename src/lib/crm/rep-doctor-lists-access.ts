/**
 * Who may open Rep Doctor Lists.
 *
 * SUPER ADMIN ONLY, on the owner's instruction 2026-08-21 ("in admin account only for now"). The
 * board names every rep, every doctor on their list, and exactly which ones they never reached —
 * a performance surface, and one built on a data source nobody in the business has used yet. It
 * stays on one account until the owner decides who else should see it.
 *
 * The "for now" is real: widening this is a one-line change here plus a nav entry. Prefer adding a
 * role to this list over scattering role checks into the page and the route — both ask this
 * module, so they cannot drift apart, which is the failure Doctor Coverage had before
 * doctor-coverage-scope.ts existed (page and portal twin each kept their own hardcoded set and
 * neither scoped the data).
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts
 * `crm_visits:read` through the permission matrix, because a role list is a fast explicit guard
 * and the matrix is the security boundary.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

export const REP_DOCTOR_LISTS_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

export function canAccessRepDoctorLists(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return REP_DOCTOR_LISTS_ACCESS_ROLES.includes(context.role);
}

export function assertRepDoctorListsAccess(context: Pick<AccessContext, "role" | "scope">): void {
  if (!canAccessRepDoctorLists(context)) {
    throw new Error(`Forbidden: ${context.role} cannot read rep doctor lists.`);
  }
}
