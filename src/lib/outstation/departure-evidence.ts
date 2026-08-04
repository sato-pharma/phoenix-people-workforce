/**
 * The departure photo: the second of the two captures an outstation request must carry.
 *
 * Owner request (2026-08-04): the employee takes an ARRIVAL photo when he submits, and a
 * DEPARTURE photo before he leaves the destination. Two owner decisions shape what this module
 * does and — just as importantly — what it refuses to do:
 *
 *   - Distance is FLAGGED, never blocking. A departure photo taken 200 km from the arrival photo
 *     is accepted and surfaced for review rather than refused. The owner chose this over a hard
 *     radius so a bad GPS fix can never strand an honest employee's money. The cost is explicit:
 *     the flag only works if a human actually reads it, so it is computed on every capture and
 *     stored, not derived on demand in one screen that someone might not open.
 *
 *   - The window closes at the END OF THE TRIP'S LAST DAY, in Africa/Cairo. After that the
 *     request needs a Super Admin to release it. This stops a request sitting open forever while
 *     nothing chases it.
 *
 * Everything here is pure. The gate that consumes it lives in expense-gate.ts.
 */

// One shared haversine rather than a seventh copy — this repo already carries six. The import
// costs nothing new: geo-validate's only runtime dependency (egypt-locations) is already in the
// outstation service's graph, and its other imports are type-only and erased at build.
import { haversineKm } from "@/lib/sales/normalizer/geo-validate";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

/**
 * How far apart the two photos may be before the pair is worth a human look. Not a rejection
 * threshold — see the module note. 5 km comfortably covers moving around a destination city
 * (hotel to clinic to station) while still catching a photo taken in another governorate.
 */
export const DEPARTURE_REVIEW_DISTANCE_KM = 5;

/**
 * A departure photo taken within a couple of minutes of the arrival photo did not evidence a
 * day's work — it is the employee taking both captures at once on arrival. Accepted, flagged.
 */
export const DEPARTURE_REVIEW_MINIMUM_MINUTES = 10;

export type DepartureReviewFlag =
  | "far_from_arrival"
  | "too_soon_after_arrival"
  | "outside_trip_window";

export type DepartureEvidenceReview = {
  /** Km between the arrival and departure captures. Null when either point is unusable. */
  distanceFromArrivalKm: number | null;
  /** Wall-clock minutes between the two captures. Null when either timestamp is unusable. */
  minutesAfterArrival: number | null;
  /** Everything a reviewer should look at. Empty means the pair looks ordinary. */
  flags: DepartureReviewFlag[];
  /** False once the trip's last Cairo day has passed — a Super Admin must release it. */
  isWithinTripWindow: boolean;
  /** One line for the admin queue. Never empty. */
  summary: string;
};

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function instant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The Cairo calendar date an instant falls on, as YYYY-MM-DD.
 *
 * Formatted through Intl rather than by adding a fixed offset: Egypt observes DST again since
 * 2023, so Cairo is UTC+2 for part of the year and UTC+3 for the rest. A hardcoded offset would
 * mis-date every capture near midnight for half the year — and comparing formatted date STRINGS
 * sidesteps offset arithmetic entirely.
 */
export function cairoDateOnly(value: string | Date | null | undefined): string | null {
  const date = value instanceof Date ? value : instant(value ?? null);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : null;
}

/**
 * True while the departure photo may still be captured without an admin: any time up to the end
 * of the trip's last day, Cairo time. A capture ON the last day passes; the day after does not.
 */
export function isWithinDepartureWindow(input: {
  capturedAt: string | null | undefined;
  tripEndDate: string | null | undefined;
}): boolean {
  const capturedDay = cairoDateOnly(input.capturedAt);
  const lastDay = String(input.tripEndDate ?? "").slice(0, 10);
  if (!capturedDay || !/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) {
    // Unknown either side: do NOT declare it late. A missing trip date is our data problem, and
    // failing that onto the employee would demand an admin release for a photo taken on time.
    return true;
  }
  return capturedDay <= lastDay;
}

/**
 * Review the departure capture against the arrival capture. Never rejects — every return value
 * is advisory, by owner decision. The caller stores this alongside the photo.
 */
export function reviewDepartureEvidence(input: {
  arrivalCapturedAt: string | null | undefined;
  arrivalLatitude: number | null | undefined;
  arrivalLongitude: number | null | undefined;
  departureCapturedAt: string | null | undefined;
  departureLatitude: number | null | undefined;
  departureLongitude: number | null | undefined;
  tripEndDate: string | null | undefined;
}): DepartureEvidenceReview {
  const aLat = finiteNumber(input.arrivalLatitude);
  const aLon = finiteNumber(input.arrivalLongitude);
  const dLat = finiteNumber(input.departureLatitude);
  const dLon = finiteNumber(input.departureLongitude);

  const distanceFromArrivalKm =
    aLat != null && aLon != null && dLat != null && dLon != null
      ? Number(haversineKm(aLat, aLon, dLat, dLon).toFixed(2))
      : null;

  const arrivalAt = instant(input.arrivalCapturedAt);
  const departureAt = instant(input.departureCapturedAt);
  const minutesAfterArrival =
    arrivalAt && departureAt
      ? Math.round((departureAt.getTime() - arrivalAt.getTime()) / 60000)
      : null;

  const isWithinTripWindow = isWithinDepartureWindow({
    capturedAt: input.departureCapturedAt,
    tripEndDate: input.tripEndDate,
  });

  const flags: DepartureReviewFlag[] = [];
  if (distanceFromArrivalKm != null && distanceFromArrivalKm > DEPARTURE_REVIEW_DISTANCE_KM) {
    flags.push("far_from_arrival");
  }
  // Negative minutes (a departure stamped BEFORE the arrival) is also "too soon" — it is a
  // clock or a tampering problem either way, and must not slip through as an ordinary pair.
  if (minutesAfterArrival != null && minutesAfterArrival < DEPARTURE_REVIEW_MINIMUM_MINUTES) {
    flags.push("too_soon_after_arrival");
  }
  if (!isWithinTripWindow) flags.push("outside_trip_window");

  return {
    distanceFromArrivalKm,
    flags,
    isWithinTripWindow,
    minutesAfterArrival,
    summary: buildSummary({ distanceFromArrivalKm, flags, minutesAfterArrival }),
  };
}

function buildSummary(input: {
  distanceFromArrivalKm: number | null;
  flags: DepartureReviewFlag[];
  minutesAfterArrival: number | null;
}): string {
  const where =
    input.distanceFromArrivalKm == null
      ? "distance from the arrival photo unknown"
      : `${input.distanceFromArrivalKm} km from the arrival photo`;
  const when =
    input.minutesAfterArrival == null
      ? "gap unknown"
      : `${input.minutesAfterArrival} minute(s) after it`;

  if (input.flags.length === 0) return `Departure photo captured ${where}, ${when}.`;

  const reasons = input.flags.map((flag) => {
    if (flag === "far_from_arrival") return "taken well away from where the trip was";
    if (flag === "too_soon_after_arrival") return "taken almost immediately after the arrival photo";
    return "taken after the trip's last day";
  });
  return `Review: departure photo ${where}, ${when} — ${reasons.join("; ")}.`;
}
