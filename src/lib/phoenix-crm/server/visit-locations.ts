/**
 * Phoenix CRM — a customer's visits measured again against his places.
 *
 * Owner, 2026-09-29: a customer can be planned and visited BEFORE he is validated. Those visits save
 * with no place to measure against (`no_place`) and count in nothing; once he is validated, "his earlier
 * visits then get their distance" from the new place. And when the Super Admin or the SFE Manager moves
 * a place, every visit to that customer is measured again against where the place really is.
 *
 * The distance is computed ONCE, here, with the same `checkVisitLocation` a visit is saved with, and
 * written through `phoenix_crm_restamp_visit_locations` — so a restamped visit and a fresh one can never
 * disagree about what "far" means. None of this ever reaches the rep (Golden Rule #1): it feeds the
 * managers' place-vs-actual report and the exceptions board only.
 *
 * Best-effort by design. A validation or a move is already saved when this runs; a failure here leaves
 * the earlier visits as they were (still `no_place`, or measured against the old point), which the next
 * restamp repairs, and never costs anybody the save they made.
 */

import { logError } from "@/lib/observability/log";
import { checkVisitLocation } from "@/lib/phoenix-crm/geo";
import { callPhoenixCrm, chunk, numberOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import type { PhoenixCrmSettings } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * Which visits are measured again:
 *   - "unplaced": the ones saved before the customer had any place (validate, bring-back);
 *   - "all": every visit to him (a moved place — the old point was wrong for all of them).
 *
 * Adding a SECOND clinic deliberately restamps nothing: a visit already measured "far" from his first
 * clinic stays as it was judged, so a clinic added after the fact can never launder an earlier visit.
 */
export type RestampScope = "unplaced" | "all";

/** A place as the measurement needs it: where it is, and when it was captured at the door. */
export type MeasurablePlace = { id: string; lat: number; lon: number; capturedAt: string };

/**
 * The places ONE visit is measured against: those already captured when it happened.
 *
 * 🔴 THE GUARANTEE ABOVE WAS TRUE OF "unplaced" AND FALSE OF "all". A move restamped every visit
 * against every ACTIVE place, which includes clinics captured after the visit — so a second clinic
 * added in October, followed by any move, retroactively made a September visit "ok" from a door that
 * did not exist when the rep stood there. That is exactly the laundering the comment above says cannot
 * happen, and a move is the one event that reaches a visit nobody has touched.
 *
 * The fallback is the other half of the owner's rule and must not be dropped: a customer can be visited
 * BEFORE he is validated, and "his earlier visits then get their distance" from the place the validation
 * captured (owner, 2026-09-29). Such a visit has no place captured before it at all, so it measures
 * against the EARLIEST one — the place he was validated with — and never against a clinic added later.
 *
 * 🔴 A VISIT COPIED FROM iREPORTS360 IS MEASURED AGAINST EVERY ACTIVE PLACE (owner, 7 Nov 2026; risk review the
 * same day). The conversion measured it against the customer's validated places TODAY, all of them
 * (scripts/phoenix-crm-convert-ireports360-visits.ts through convertOldVisitLocation): its captured_at is the
 * old visit's, months before any place was captured, so the rule above would hand it the earliest place only
 * and a restamp could turn a converted visit that counted into a far one. A live Phoenix visit keeps the rule above.
 */
export function placesFor(
  visit: { capturedAt: string | null; copiedFromOldSystem?: boolean },
  places: readonly MeasurablePlace[],
): MeasurablePlace[] {
  if (visit.copiedFromOldSystem) return [...places];
  // A visit with no stamp to compare is measured as it always was, rather than silently losing its
  // distance: an absent answer must never read as "no place was there".
  if (!visit.capturedAt) return [...places];
  const captured = places.filter((place) => place.capturedAt <= visit.capturedAt!);
  if (captured.length > 0) return captured;
  const earliest = places.reduce<MeasurablePlace | null>(
    (held, place) => (held === null || place.capturedAt < held.capturedAt ? place : held),
    null,
  );
  return earliest ? [earliest] : [];
}

export type RestampInput = {
  seatId: string;
  isTest: boolean;
  customerId: string;
  actorHrId: string;
  settings: Pick<PhoenixCrmSettings, "visitFarMeters" | "weakGpsMeters">;
  scope: RestampScope;
};

/** How many visits were measured again. */
export async function restampVisitLocations(input: RestampInput): Promise<number> {
  const supabase = getSupabaseAdmin();
  const [visits, placesResult] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () => {
        let query = supabase
          .from("phoenix_crm_visits")
          .select("id, lat, lon, accuracy_meters, captured_at, place_id, distance_meters, location_flag, imported_from_ireports360_at")
          .eq("seat_id", input.seatId)
          .eq("is_test", input.isTest)
          .eq("customer_id", input.customerId);
        if (input.scope === "unplaced") query = query.eq("location_flag", "no_place");
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    supabase
      .from("phoenix_crm_places")
      .select("id, lat, lon, captured_at")
      .eq("seat_id", input.seatId)
      .eq("is_test", input.isTest)
      .eq("customer_id", input.customerId)
      .eq("status", "active"),
  ]);
  throwIfError(placesResult.error);
  const places: MeasurablePlace[] = ((placesResult.data ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    capturedAt: String(row.captured_at ?? ""),
  }));
  if (places.length === 0 || visits.length === 0) return 0;

  const items = visits.flatMap((visit) => {
    const lat = numberOrNull(visit.lat);
    const lon = numberOrNull(visit.lon);
    if (lat === null || lon === null) return [];
    const check = checkVisitLocation({
      fix: { lat, lon, accuracyMeters: numberOrNull(visit.accuracy_meters) },
      places: placesFor(
        {
          capturedAt: typeof visit.captured_at === "string" ? visit.captured_at : null,
          copiedFromOldSystem: visit.imported_from_ireports360_at != null,
        },
        places,
      ),
      farMeters: input.settings.visitFarMeters,
      weakGpsMeters: input.settings.weakGpsMeters,
    });
    // Whole metres: the database casts the distance to an integer and refuses "123.4".
    const distance = check.distanceMeters === null ? null : Math.round(check.distanceMeters);
    const unchanged =
      String(visit.place_id ?? "") === String(check.placeId ?? "") &&
      numberOrNull(visit.distance_meters) === distance &&
      visit.location_flag === check.flag;
    return unchanged ? [] : [{ visit_id: String(visit.id), place_id: check.placeId, distance_meters: distance, location_flag: check.flag }];
  });

  let restamped = 0;
  for (const part of chunk(items, 500)) {
    const result = await callPhoenixCrm<Row>("phoenix_crm_restamp_visit_locations", {
      p: { seat_id: input.seatId, actor_hr_id: input.actorHrId, is_test: input.isTest, customer_id: input.customerId, items: part },
    });
    restamped += Number(result.visits ?? 0);
  }
  return restamped;
}

/**
 * The same, never throwing: the save it follows has already happened.
 *
 * It tries TWICE. The comment at the top of this file says a failure "the next restamp repairs", and
 * for a validation that is true — the next one is the customer's next place. For a MOVE it is not: a
 * place is moved once and fixed forever, so there may never be a next restamp, and a single lost call
 * leaves every visit to that customer measured against the point the move proved was wrong. One retry
 * costs nothing on the happy path and covers the statement timeout that is the realistic failure here.
 */
export async function restampVisitLocationsQuietly(input: RestampInput): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await restampVisitLocations(input);
      return;
    } catch (error) {
      logError("Phoenix CRM visit locations not restamped", {
        labels: { event: "phoenix_crm_restamp_failed", scope: input.scope, attempt: String(attempt) },
        error,
      });
    }
  }
}
