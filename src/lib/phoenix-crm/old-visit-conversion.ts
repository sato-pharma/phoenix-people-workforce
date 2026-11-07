/**
 * Phoenix CRM — an old iReports360 visit converted into a Phoenix visit, with no I/O.
 *
 * Owner, 7 Nov 2026: every old regular visit with a check-in location becomes a Phoenix visit "as if submitted
 * on Phoenix". Its check-in is its position, measured against the customer's validated place TODAY — every
 * active place, nearest first, the line `visit_far_meters` — with `checkVisitLocation`, the one distance rule a
 * new visit is saved with. A check-in carries no accuracy, so it is never "weak". A customer with no place
 * leaves the visit `no_place`: shown on the history screens and counted in no KPI. A check-in more than
 * `visit_far_meters` from the validated place is FAR. Up to OLD_VISIT_ARCHIVE_FAR_METERS (500 m) it is a normal
 * visit, counted, and flagged far on the visit reports; beyond that it is counted nowhere and archived as `far`
 * with its distance (owner, 7 Nov 2026) — the database trigger decides both, on the conversion and on any later
 * restamp. A campaign visit, and a visit with no check-in location, is never converted: it is in the visits archive.
 *
 * The database writes the position from the matched check-in itself and keeps the counted flag
 * (the conversion migration 20261107044059 and its trigger `phoenix_crm_visits_old_system_kpi`); this decides the
 * place, the distance and the flag. Account: docs/phoenix-crm-ireports360-history-import.md, "The conversion".
 */

import { checkVisitLocation, isUsableFix } from "@/lib/phoenix-crm/geo";

/**
 * The old visit's reasons for being in the visits archive, in precedence order: campaign wins over no check-in
 * location, which wins over far (a converted visit whose check-in lay more than visit_far_meters from the place).
 */
export const OLD_VISIT_ARCHIVE_REASONS = ["campaign", "no_checkin_location", "far"] as const;
export type OldVisitArchiveReason = (typeof OLD_VISIT_ARCHIVE_REASONS)[number];

/** The old system's two visit types the conversion reads: 0 is a regular visit, -8 a campaign visit. */
export const OLD_SYSTEM_REGULAR_VISIT = 0;
export const OLD_SYSTEM_CAMPAIGN_VISIT = -8;

/**
 * Why an old visit is archived, or null when it converts. Only a regular visit with a check-in location is a
 * visit: a campaign visit is retired whatever it carries (owner, 7 Nov 2026), and a visit with no located
 * check-in is not a visit ("no visits with no location").
 */
export function oldVisitArchiveReason(input: { visitType: number; hasCheckinLocation: boolean }): OldVisitArchiveReason | null {
  if (input.visitType === OLD_SYSTEM_CAMPAIGN_VISIT) return "campaign";
  if (input.visitType !== OLD_SYSTEM_REGULAR_VISIT) return "no_checkin_location";
  return input.hasCheckinLocation ? null : "no_checkin_location";
}

/**
 * 🔴 THE ARCHIVE LINE FOR A FAR OLD VISIT (owner, 7 Nov 2026: "visits upto 500 m move them to normal visits but
 * flag them"). A converted visit flagged far but no more than this many metres from the validated place counts
 * as a visit, its far flag kept; only one farther is archived. The trigger phoenix_crm_visits_old_system_kpi
 * holds the same number (20261107064148).
 */
export const OLD_VISIT_ARCHIVE_FAR_METERS = 500;

/** A converted visit is a PLANNED visit: the regular visit was on the rep's list (owner, 2026-10-29). */
export const CONVERTED_VISIT_IS_UNPLANNED = false;

export type OldVisitPlace = { id: string; lat: number; lon: number };

export type OldVisitConversion = {
  checkinId: number;
  placeId: string | null;
  distanceMeters: number | null;
  locationFlag: "ok" | "far" | "no_place";
  /** Counts in visits AND KPIs: measured ok, or far within the archive line, against a validated place. */
  kpiCounted: boolean;
  /** `far` when the check-in lay more than OLD_VISIT_ARCHIVE_FAR_METERS from the place: archived, never shown as a visit. */
  archiveReason: "far" | null;
};

/**
 * The converted visit's place, distance and flag — or null when the check-in is no usable fix (outside
 * Egypt's box), which makes the visit one with no location.
 */
export function convertOldVisitLocation(input: {
  checkin: { checkinId: number; lat: number; lon: number };
  places: ReadonlyArray<OldVisitPlace>;
  farMeters: number;
}): OldVisitConversion | null {
  const { checkin } = input;
  if (!isUsableFix(checkin.lat, checkin.lon)) return null;
  const places = input.places.filter((place) => isUsableFix(place.lat, place.lon));
  if (places.length === 0) {
    return { checkinId: checkin.checkinId, placeId: null, distanceMeters: null, locationFlag: "no_place", kpiCounted: false, archiveReason: null };
  }
  // No accuracy on an old check-in: weak GPS is never the answer, so the line below is the far line alone.
  const check = checkVisitLocation({
    fix: { lat: checkin.lat, lon: checkin.lon, accuracyMeters: null },
    places,
    farMeters: input.farMeters,
    weakGpsMeters: Number.POSITIVE_INFINITY,
  });
  const locationFlag = check.flag === "far" ? "far" : "ok";
  const distanceMeters = check.distanceMeters === null ? null : Math.round(check.distanceMeters);
  // Far within the archive line stays a visit, flagged; beyond it, archived and counted nowhere (the trigger
  // phoenix_crm_visits_old_system_kpi decides the same on the stored whole metres).
  const archived = locationFlag === "far" && (distanceMeters === null || distanceMeters > OLD_VISIT_ARCHIVE_FAR_METERS);
  return {
    checkinId: checkin.checkinId,
    placeId: check.placeId,
    distanceMeters,
    locationFlag,
    kpiCounted: check.placeId !== null && !archived,
    archiveReason: archived ? "far" : null,
  };
}
