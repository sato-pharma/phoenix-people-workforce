/**
 * Who may open Reps Plans.
 *
 * SUPER ADMIN ONLY, following the posture of Rep Doctor Lists next door (see
 * rep-doctor-lists-access.ts). This board names every rep and prints how much of
 * their reported work nothing can prove — a performance signal nobody in the
 * business has seen before. It stays on one account until the owner decides who
 * else should see it, and a district manager seeing his own reps here is a
 * deliberate next step rather than an omission.
 *
 * Widening it is one entry in the list below plus the `roles` array on the nav
 * item — do that rather than scattering role checks into the page, so the two
 * can never drift apart.
 *
 * This is the SECOND gate, not the only one. The page also asserts
 * `crm_visits:read` through the permission matrix, which is the actual security
 * boundary; a role list is a fast explicit guard, the matrix is enforcement.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

export const REPS_PLANS_ACCESS_ROLES: readonly PhoenixRole[] = ["Super Admin"];

export function canAccessRepsPlans(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return REPS_PLANS_ACCESS_ROLES.includes(context.role);
}
