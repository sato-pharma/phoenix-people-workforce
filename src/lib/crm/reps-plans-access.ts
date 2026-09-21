/**
 * Who may open Reps Plans, and through which door.
 *
 * SINCE 2026-09-21 THE DOOR IS A TAB. The owner merged Reps Plans into Reps List ("merge the 2
 * modules into 1 module WHICH REPS LIST"): the board is the Call rate tab of /admin/reps-list and
 * /employee-portals/reps-list, its drill-down is at <that page>/call-rate/[rep], and the two old
 * /reps-plans addresses forward there. This list still decides who gets the tab — every role on it
 * also passes the Reps List gate, so the merge moved nobody's reach. Where the notes below say
 * "/admin/reps-plans" or "the portal twin", read the Call rate tab in that shell.
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
 * for the three line seats, `company` for the two staff seats.
 *
 * WIDENED 2026-09-03, same instruction. Until then this was the two seats that supervise a named
 * rep, and the note here said a National Sales Manager was "deliberately absent: he resolves to
 * `line` basis, which on this board is most of a line's field force at once — a whole-line
 * performance league table is a different thing from a manager reading his own team, and the owner
 * has not asked for one."
 *
 * THAT REASONING IS NOW RETIRED, and it is worth being exact about why, because it reads like a
 * principle and was not one. What it actually turned on was its own last clause — nobody had asked.
 * Adding the marketing seats settled the question by itself: a Product Manager resolves to the same
 * `line` basis and sees the same whole-line league table, so the objection could no longer explain
 * who was on the list. Leaving the National Sales Manager off would have meant a Product Manager
 * reading a whole line's performance while the manager who OWNS that line could not — an asymmetry
 * with nothing behind it. The owner was shown exactly that and answered "yes add nsm too".
 *
 * So the league table is now the accepted shape of this board for a line seat, not a hazard being
 * avoided. A future session should not reinstate the old note by reading it in the history.
 */
const PORTAL_ROLES = [
  "Regional Manager",
  "District Manager",
  "National Sales Manager",
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
 * The portal half. It drove a Reps Plans sidebar row of its own until the 2026-09-21 merge into Reps
 * List; the tab now rides on the Reps List row, and this stays exported so the tests can hold the
 * portal gate to exactly these seats.
 */
export const REPS_PLANS_PORTAL_ROLES: readonly PhoenixRole[] = PORTAL_ROLES as unknown as readonly PhoenixRole[];

export function canAccessRepsPlans(context: Pick<AccessContext, "role" | "scope">): boolean {
  if (context.scope === "system") return true;
  return REPS_PLANS_ACCESS_ROLES.includes(context.role);
}
