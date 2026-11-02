/**
 * WHAT A READER IS TOLD ABOUT A VISIT'S LOCATION, and how much of it his tier earns.
 *
 * Lifted out of `server/visits.ts` on 2026-10-07, unchanged, for ONE reason: that file reaches
 * `getSupabaseAdmin` and a hundred other server modules, so anything importing it is server-only — and
 * from 2026-10-07 the old CRM's admin reports print these same sentences (owner: "everything, GPS and
 * evidence included"). A report's shaper that pulled in `server/visits.ts` would drag the service-role
 * client into any client bundle that touched it. `server/visits.ts` re-exports every name below, so no
 * existing caller changes and there is still exactly ONE wording.
 *
 * The three tiers are the owner's own, set 2026-10-02 and narrowed further on 2026-09-29. They are
 * NOT a presentation choice and nothing here may be relaxed to make a report read better:
 *
 *   - `none`     — a reader on his OWN row as its rep: nothing measured at all (Golden Rule #1).
 *   - `distance` — every manager below the Super Admin and the SFE Manager: the distance and the
 *                  far / at-the-place wording. A weak reading reads as its plain distance — the
 *                  accuracy and the phone-was-not-sure sentence are not his.
 *   - `full`     — the Super Admin and the SFE Manager: every sentence, the accuracy included.
 */
import { formatDistance } from "@/lib/phoenix-crm/geo";

/** How much of the integrity half this reader may read. Mirrors `locationSight`'s own return type. */
export type VisitLocationSight = "none" | "distance" | "full";

export type VisitLocationFlag = "ok" | "far" | "weak_gps" | "no_place";

/**
 * What a MANAGER reads about a visit's location — plain and measured, never a verdict: the usual cause
 * of a long distance is a place saved from the wrong doorway, not a rep who was not there.
 *
 * 🔴 Never the rep's. The owner's polite sign on the rep's own visit (2026-09-26) was REMOVED on
 * 2026-09-29: the rep sees no distance, no flag and no check of any kind (Golden Rule #1). His rows
 * carry `BLIND_LOCATION` instead.
 *
 * 🔴 `no_place` IS ABOUT THE CUSTOMER, NOT THE READING, and it read as "nothing was captured" (owner,
 * 2026-11-02). A visit to a customer with no validated place still carries the rep's location, so it now
 * says so — but only when the row really holds one. A visit copied from the old system is `no_place`
 * with no coordinates (69,046 of them on production that day), so `hasReading` defaults to false and
 * such a row never claims a capture that did not happen.
 */
export function visitLocationLabel(flag: VisitLocationFlag, distanceMeters: number | null, accuracyMeters: number | null, hasReading = false): string {
  if (flag === "far") return `About ${formatDistance(distanceMeters)} from this customer's saved place`;
  if (flag === "weak_gps") return `The phone was not sure where it was (within ${formatDistance(accuracyMeters)})`;
  if (flag === "no_place") return hasReading ? "Location captured; no saved place to compare it with yet" : "No place saved for this customer yet";
  return distanceMeters === null ? "At the saved place" : `At the saved place (${formatDistance(distanceMeters)})`;
}

/**
 * The location fields on the REP's own visit: kept in the response so a caller one release behind
 * still reads a well-formed row, and saying nothing — no distance, no flag, no check.
 */
export const BLIND_LOCATION: { locationFlag: VisitLocationFlag; locationLabel: string } = { locationFlag: "ok", locationLabel: "Visit saved" };

/** What a manager reads where a location would be, on a visit the Super Admin entered for the rep. */
export const MISSED_VISIT_LOCATION_LABEL = "No location: entered later by the Super Admin";

/** A visit's location, as this reader may read it — the three tiers in the file header. */
export function visitLocationFor(
  sight: VisitLocationSight,
  flag: VisitLocationFlag,
  distanceMeters: number | null,
  accuracyMeters: number | null,
  enteredByAdmin = false,
  hasReading = false,
): { locationFlag: VisitLocationFlag; locationLabel: string } {
  if (sight === "none") return BLIND_LOCATION;
  const shown: VisitLocationFlag = sight === "distance" && flag === "weak_gps" ? "ok" : flag;
  return {
    locationFlag: shown,
    // Entered later by the Super Admin, from wherever he was: there is no reading to describe, and "no
    // place saved for this customer" would be a sentence about the wrong thing.
    locationLabel: enteredByAdmin
      ? MISSED_VISIT_LOCATION_LABEL
      : visitLocationLabel(shown, distanceMeters, sight === "full" ? accuracyMeters : null, hasReading),
  };
}
