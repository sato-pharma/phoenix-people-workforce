/**
 * Who may open Reps Plans, and through which door.
 *
 * WIDENED 2026-09-03, from Super Admin only to the managers who supervise the reps this board
 * scores. Until then it named every rep in the company and printed how much of their reported work
 * nothing can prove, so it stayed on one account — and the note it carried said a district manager
 * seeing his own reps was "a deliberate next step rather than an omission". This is that step.
 *
 * ## THE SCOPE IS NOT OPTIONAL, AND IT IS NOT ENFORCED HERE
 *
 * The note this file used to carry said widening was "one entry in the list below plus the `roles`
 * array on the nav item". THAT WAS WRONG IN TWO WAYS, and both would have shipped a real fault:
 *
 * 1. **The board took no viewer argument at all.** Every seat that could open it received every rep
 *    in the company. With one entry in the list that was survivable; with a district manager on it,
 *    adding the entry alone would have handed him all ~73 reps and their unproven-call figures.
 *    `buildRepsPlansBoard` now takes a `scope`, applies it to the rows AND to the rep picker built
 *    from them, and every caller must pass one — resolve it with `getDoctorCoverageScope(access)`,
 *    the same resolver the KPIs board uses, so a manager's reach cannot differ between the two
 *    screens. It is deliberately NOT re-exported from here: this module stays free of any
 *    server-only import so the nav config can read the role lists without dragging the Supabase
 *    admin client behind them.
 *
 * 2. **Two of the three roles below cannot reach the admin shell.** Regional and District Manager
 *    are PORTAL seats, and `app/(admin)/layout.tsx` redirects a portal-mode viewer out before this
 *    page's own gate could run. An entry in the list and the nav array would have been INERT —
 *    green, deployed, and reachable by nobody, which looks exactly like a feature nobody uses. They
 *    reach the identical board through the portal twin at `/employee-portals/reps-plans`.
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts `crm_visits:read`
 * through the permission matrix, which is the actual security boundary; a role list is a fast
 * explicit guard, the matrix is enforcement, and the scope is what decides whose reps come back.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

/**
 * ADMIN-SHELL seats. Company-wide by scope, and the only ones `/admin/reps-plans` can serve.
 *
 * SFE Manager joined 2026-09-03 on the owner's instruction to show the rep list, the plans and the
 * KPIs to the marketing and field-support seats. He is the ONLY one of the five roles named that
 * day who belongs here rather than in the portal list below — the other four are portal-mode, and
 * `app/(admin)/layout.tsx` redirects them out of the admin shell before this page's gate could run.
 * He already reads rep activity company-wide on Reps List and on KPIs, so this is the third door
 * onto data he holds, not a new reach.
 *
 * CEO remains absent: nobody has asked, and the KPIs board already carries the call rate for a seat
 * that wants the summary.
 */
const ADMIN_ROLES = ["Super Admin", "SFE Manager"] as const;

/**
 * PORTAL seats, each scoped by `getDoctorCoverageScope` — `team` for the two manager seats, `line`
 * for the two product seats, `company` for the two staff seats.
 *
 * WIDENED 2026-09-03, same instruction. Until then this was the two seats that supervise a named
 * rep, and the note here said a National Sales Manager was "deliberately absent: he resolves to
 * `line` basis, which on this board is most of a line's field force at once — a whole-line
 * performance league table is a different thing from a manager reading his own team, and the owner
 * has not asked for one." He has now asked for exactly that, for the marketing seats: a Product
 * Manager resolves to the same `line` basis and sees the same league table. So the reasoning is
 * superseded, not forgotten — what it turned on was that nobody had asked.
 *
 * The National Sales Manager is STILL not on this list, and that is now an asymmetry rather than a
 * principle: the owner named five roles and he was not one of them. It is worth putting to him
 * rather than closing quietly, because a Product Manager reading a whole line's performance while
 * the manager who owns that line cannot is a hard state to defend if it was not deliberate.
 */
const PORTAL_ROLES = [
  "Regional Manager",
  "District Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
] as const;

/** Every seat with any door onto the board, either shell. Used by the page gates. */
export const REPS_PLANS_ACCESS_ROLES: readonly PhoenixRole[] = [
  ...ADMIN_ROLES,
  ...PORTAL_ROLES,
] as unknown as readonly PhoenixRole[];

/**
 * The portal half, for the sidebar flag and the nav catalog entry to mirror.
 *
 * Exported so `src/lib/employee-portal/navigation.ts` and `src/config/system-navigation.ts` can
 * stay in step with the gate instead of spelling the pair out a third and fourth time — this module
 * has no server-only import precisely so those two may read it.
 */
export const REPS_PLANS_PORTAL_ROLES: readonly PhoenixRole[] = PORTAL_ROLES as unknown as readonly PhoenixRole[];

export function canAccessRepsPlans(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return REPS_PLANS_ACCESS_ROLES.includes(context.role);
}
