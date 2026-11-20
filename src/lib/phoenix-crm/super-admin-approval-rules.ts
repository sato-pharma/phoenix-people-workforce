/**
 * Phoenix CRM — what the Super Admin approved, only the Super Admin rejects.
 *
 * 🔴 Owner, 2026-11-16: "when super admin approve something sfe or whoever cannot reject it back bec its
 * approved by admin". On 2026-11-15 the SFE Manager refused the administrator's three trusted-point
 * validations on one rep's list for a missing signboard — a trusted point has no photograph by design — and
 * the three doctors went back to To validate.
 *
 * An approval is the Super Admin's when the place's review was decided `approved` by a Super Admin, or when
 * the place itself was created by a Super Admin (a trusted point, a seat he placed); a building is his when
 * a Super Admin approved it. Anybody else may still reject what the SFE Manager or the system approved. The
 * Super Admin himself is never blocked.
 *
 * The database refuses the same thing (`phoenix_crm_is_super_admin`, migration 20261116230741, code
 * `phoenix_crm:approved_by_super_admin`); this file is the screen's and the service's half, so a button that
 * cannot work is never drawn.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * What the SFE Manager — or anybody below the Super Admin — reads wherever he tries to undo or contradict
 * what the Super Admin did, and where a button that would do it would have been.
 *
 * 🔴 Owner, 2026-11-20: "anything done by the system administrator in the system, any manual validation,
 * any approval … the SFE can never return it back. And whenever he try to do anything that return back or
 * it is the opposite of the system administrator opinion, it clearly to him that this is the system
 * administrator decision and you have no right to overcome it." One sentence, everywhere.
 */
export const SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT = "This is the system administrator's decision. You have no right to override it.";

/**
 * The list events that DECIDE where a customer stands on a list — validated, kept, brought back, moved or
 * dropped (owner, 2026-11-20). The newest of these about a customer is whose word his place on the list is:
 * when it is the Super Admin's, nobody else drops him, moves him to another rep or brings him back.
 *
 * 🔴 NEVER a bulk load (`customer_pending`, `customer_loaded`, `list_loaded`), a rename, a merge or a
 * re-measure — those are housekeeping the Super Admin runs over thousands of rows, and counting them would
 * freeze every list he ever loaded. Never a rejection of a photo either: that sends the customer back to
 * be captured again, it says nothing about whether he belongs on the list.
 */
export const LIST_STANDING_EVENTS = [
  "customer_validated",
  "validation_review_approved",
  "customer_restored",
  "customer_moved_in",
  "customer_moved_out",
  "customer_dropped",
  "customer_archived",
  "request_decided",
  "place_restored",
  "shared_place_restored",
] as const;

/**
 * The list events that DECIDE where a place is and whether it stands — added, moved, restored, seated in a
 * building, its validation approved. The newest about a place is whose word its point is: when it is the
 * Super Admin's, nobody else moves it or removes it (owner, 2026-11-20).
 */
export const PLACE_STANDING_EVENTS = [
  "place_added",
  "place_moved",
  "place_restored",
  "place_seated",
  "place_updated",
  "validation_review_approved",
] as const;

/**
 * Whether any of these people is a Super Admin — the one question behind every lock below. `superAdmins`
 * holds `canonicalHrIdKey` keys; each actor goes through the same normaliser, so either spelling matches.
 */
export function actedBySuperAdmin(actors: ReadonlyArray<unknown>, superAdmins: ReadonlySet<string>): boolean {
  return actors.some((actor) => {
    const key = canonicalHrIdKey(typeof actor === "string" ? actor : null);
    return key !== null && superAdmins.has(key);
  });
}

/**
 * Whether this viewer is refused a reject of this approval. `approvedBy` is who decided the review
 * `approved` (null when it is not an approval or nobody decided it); `placeCreatedBy` is who created the place. `superAdmins` holds `canonicalHrIdKey` keys — the one HR id
 * normaliser (trimmed, case-folded, legacy aliases resolved), so either side's spelling matches.
 */
export function approvalLockedFor(input: {
  viewerIsSuperAdmin: boolean;
  approvedBy: string | null | undefined;
  placeCreatedBy?: string | null | undefined;
  superAdmins: ReadonlySet<string>;
}): boolean {
  if (input.viewerIsSuperAdmin) return false;
  return actedBySuperAdmin([input.approvedBy, input.placeCreatedBy], input.superAdmins);
}
