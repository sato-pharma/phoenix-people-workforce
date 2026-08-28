/**
 * Who may open the Doctor List board.
 *
 * SUPER ADMIN ONLY for now, and that is a deliberately narrow start rather than the final answer.
 * The board is destined for district managers — the owner specified it as tab one of a District
 * Manager page — but a DM must see HIS reps and nobody else's, and that scoping does not exist yet.
 * Shipping it wide before the scope exists would repeat the exact fault the owner caught on Doctor
 * Coverage on 2026-08-28: the picker offered a medical rep the names of all ~73 reps, because the
 * data was scoped and the FILTER was not. A picker is never wider than its viewer.
 *
 * So this stays on one account until the reps-per-manager scope lands with tab two. Widening it is
 * a change here plus a nav entry plus a scope filter in the loader — in that order, and the scope
 * filter is not optional.
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts `crm_visits:read`
 * through the permission matrix, which is the actual security boundary — a role list is a fast
 * explicit guard, nothing more.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

export const DOCTOR_LIST_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

export function canAccessDoctorList(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return DOCTOR_LIST_ACCESS_ROLES.includes(context.role);
}

export function assertDoctorListAccess(context: Pick<AccessContext, "role" | "scope">): void {
  if (!canAccessDoctorList(context)) {
    throw new Error(`Forbidden: ${context.role} cannot read doctor lists.`);
  }
}
