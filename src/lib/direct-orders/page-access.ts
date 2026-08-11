import { redirect } from "next/navigation";

import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

/**
 * The page-level gate for every Direct Orders route, in both shells.
 *
 * WHY THIS EXISTS. Found by the Phase E role sweep (2026-08-11): six of the eight direct-order
 * pages had no page-level permission check. A role holding no `direct_orders` grant — Employee,
 * Medical Rep, Training Manager, Marketing Manager, Talent Acquisition, Manager — reached the
 * portal workspace and got **HTTP 200 carrying an error boundary** whose visible text was
 * `Forbidden: Medical Rep cannot read direct_orders`.
 *
 * THIS IS NOT THE SECURITY BOUNDARY AND MUST NOT BE MISTAKEN FOR ONE. The services are, and they
 * held: the same sweep confirmed those responses carried zero workspace markers, zero order codes
 * and leaked nothing. `assertPermission` inside `getDirectOrderWorkspaceData` had already refused
 * before any data was read. What was wrong was the SHAPE of the refusal — an internal error message
 * rendered to a user, at a 200, on a page they should simply not land on.
 *
 * ONE HELPER, NOT SIX COPIES. The admin workspace already had this check inline; copying it into
 * the other seven pages would have rebuilt in miniature exactly the duplication the 2026-08-10
 * consolidation removed, and a gate that exists in six places is a gate that will disagree with
 * itself. `tests/direct-orders-page-access.test.ts` asserts every direct-order page calls this.
 *
 * Sends the caller to their OWN landing page rather than a fixed shell root: a Medical Rep bounced
 * to `/admin` would only be redirected again, and `resolveLandingPathForRole` is the one definition
 * of where a role belongs.
 */
export async function assertDirectOrdersPageAccess(access: AccessContext): Promise<void> {
  if (await canAccess(access, "direct_orders", "read")) return;
  redirect(resolveLandingPathForRole(access.role));
}
