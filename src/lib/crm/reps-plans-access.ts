/**
 * Who may open Reps Plans.
 *
 * SUPER ADMIN ONLY, following the same posture as Rep Doctor Lists next door
 * (see rep-doctor-lists-access.ts). This board names every rep and shows how
 * much of their reported work carries no proof at all — a performance surface
 * built on a signal nobody in the business has seen before. It stays on one
 * account until the owner decides who else should see it.
 *
 * The "for now" is real: widening this is one entry in the list below plus the
 * `roles` array on the nav item. Prefer that over scattering role checks into
 * the page, so the two can never drift apart.
 *
 * This is the SECOND gate, not the only one. The page also asserts
 * `crm_visits:read` through the permission matrix, which is the actual security
 * boundary — a role list is a fast explicit guard, the matrix is enforcement.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

export const REPS_PLANS_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

export function canAccessRepsPlans(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return REPS_PLANS_ACCESS_ROLES.includes(context.role);
}
