/**
 * Phoenix CRM — the TRUSTED POINT: where a customer really is, read from the reps' own readings, with no I/O.
 *
 * Owner (Super Admin), 2026-11-10, his words: "what administrator validates will be validated as follow:
 * we will search all locations for this customer in phx crm, then we will compare with the locations of
 * checkins of this customer from the old crm until we find a trusted point or trusted average location...
 * based on this location we will extract the brick, area and all what we need." He then chose: build it as
 * HIS validation, and visits are measured from that point.
 *
 * Why it exists: a doctor with no signboard (Dr Bahaa Kamal, Pedia, Giza) can never be validated at the
 * door, so he had no `phoenix_crm_places` row and none of his visits was ever measured. The reps who call
 * on him have stood at the same door for months, in Phoenix and in the old CRM — their readings ARE the
 * evidence. This file decides, from those readings alone, whether they agree on one point.
 *
 * The rule, in order:
 *   1. Drop a reading outside Egypt's field range (`isUsableFix`), and a Phoenix reading whose own accuracy
 *      is worse than the visit's line (`VISIT_MAX_ACCURACY_METERS`). An old-CRM check-in carries no accuracy.
 *   2. Seed: the per-axis median of the Phoenix readings when there are any (the module's own, sharper
 *      readings), else the reading with the most neighbours within the core radius.
 *   3. Core: every reading within `TRUSTED_CORE_METERS` of the seed. Scattered outliers (80 m to 6 km in
 *      the readings measured that day) fall outside it and are left out.
 *   4. The point is the per-axis MEDIAN of the core — never a mean, which one far reading would drag.
 *   5. Trusted only when the core holds at least `TRUSTED_MIN_READINGS` readings on at least
 *      `TRUSTED_MIN_DAYS` different Cairo days: one busy afternoon is not months of agreement.
 *
 * Admin-side only (Phoenix CRM golden rule #1): the rep's app never shows any of it.
 */

import { cairoWallClock } from "@/lib/format/cairo-zone";
import { VISIT_MAX_ACCURACY_METERS } from "@/lib/phoenix-crm/entry-rules";
import { distanceMeters, isUsableFix, type GeoPoint } from "@/lib/phoenix-crm/geo";

/** A reading belongs to the core when it lies this close to the seed. */
export const TRUSTED_CORE_METERS = 30;
/** The fewest agreeing readings a trusted point stands on. */
export const TRUSTED_MIN_READINGS = 5;
/** The fewest different Cairo days those readings were taken on. */
export const TRUSTED_MIN_DAYS = 3;

/** What every screen draws where a trusted point's photo would be — plain words, no image. */
export const TRUSTED_POINT_NO_PHOTO = "Trusted point — no photo";

export type TrustedPointSource = "phoenix" | "old_crm";

/** One reading of where a rep stood with this customer. */
export type TrustedPointReading = {
  lat: number;
  lon: number;
  /** The Cairo day it was taken, YYYY-MM-DD. */
  day: string;
  source: TrustedPointSource;
  accuracyMeters: number | null;
  repHrId: string | null;
};

export type TrustedPointFound = {
  trusted: true;
  lat: number;
  lon: number;
  /** Readings in the core. */
  readings: number;
  /** Every reading offered, usable or not. */
  of: number;
  /** Different Cairo days in the core. */
  days: number;
  /** Different reps in the core (a reading with no rep counts as none). */
  reps: number;
  sources: { phoenix: number; old_crm: number };
  /** The median and the greatest distance from the point to a core reading, in whole metres. */
  medianSpreadMeters: number;
  maxSpreadMeters: number;
  firstDay: string;
  lastDay: string;
};

export type TrustedPointMissing = {
  trusted: false;
  /** Plain English, for the Super Admin. */
  reason: string;
  /** Readings that agreed with the seed (0 when nothing was usable). */
  readings: number;
  of: number;
};

export type TrustedPointResult = TrustedPointFound | TrustedPointMissing;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function medianPoint(readings: readonly GeoPoint[]): GeoPoint {
  return { lat: median(readings.map((reading) => reading.lat)), lon: median(readings.map((reading) => reading.lon)) };
}

/** A reading the rule may use: inside Egypt, and a Phoenix reading no rougher than the visit's line. */
export function usableTrustedReading(reading: TrustedPointReading): boolean {
  if (!isUsableFix(reading.lat, reading.lon)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(reading.day ?? ""))) return false;
  if (reading.source === "phoenix" && reading.accuracyMeters !== null && !(Number(reading.accuracyMeters) <= VISIT_MAX_ACCURACY_METERS)) return false;
  return true;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function findTrustedPoint(input: readonly TrustedPointReading[]): TrustedPointResult {
  const of = input.length;
  const usable = input
    .filter(usableTrustedReading)
    .map((reading) => ({ ...reading, lat: Number(reading.lat), lon: Number(reading.lon) }));
  if (usable.length === 0) {
    return {
      trusted: false,
      reason:
        of === 0
          ? "No visit in Phoenix and no check-in in the old CRM has a location for this customer."
          : `None of the ${plural(of, "reading", "readings")} of this customer has a usable location.`,
      readings: 0,
      of,
    };
  }

  const phoenix = usable.filter((reading) => reading.source === "phoenix");
  let seed: GeoPoint;
  if (phoenix.length > 0) {
    seed = medianPoint(phoenix);
  } else {
    // The reading with the most neighbours; the earliest in the input wins a tie, so the answer is stable.
    let best = usable[0];
    let bestCount = -1;
    for (const candidate of usable) {
      const count = usable.filter((other) => distanceMeters(candidate, other) <= TRUSTED_CORE_METERS).length;
      if (count > bestCount) {
        best = candidate;
        bestCount = count;
      }
    }
    seed = { lat: best.lat, lon: best.lon };
  }

  const core = usable.filter((reading) => distanceMeters(seed, reading) <= TRUSTED_CORE_METERS);
  const days = [...new Set(core.map((reading) => reading.day))].sort();
  if (core.length < TRUSTED_MIN_READINGS) {
    return {
      trusted: false,
      reason:
        `Only ${core.length} of the ${plural(usable.length, "usable reading", "usable readings")} agree within ${TRUSTED_CORE_METERS} m of each other` +
        ` — at least ${TRUSTED_MIN_READINGS} are needed before the point can be trusted.`,
      readings: core.length,
      of,
    };
  }
  if (days.length < TRUSTED_MIN_DAYS) {
    return {
      trusted: false,
      reason:
        `The ${core.length} readings that agree were taken on only ${plural(days.length, "day", "different days")}` +
        ` — at least ${TRUSTED_MIN_DAYS} different days are needed before the point can be trusted.`,
      readings: core.length,
      of,
    };
  }

  const point = medianPoint(core);
  const spreads = core.map((reading) => distanceMeters(point, reading));
  return {
    trusted: true,
    lat: Math.round(point.lat * 1e7) / 1e7,
    lon: Math.round(point.lon * 1e7) / 1e7,
    readings: core.length,
    of,
    days: days.length,
    reps: new Set(core.map((reading) => reading.repHrId).filter((rep): rep is string => Boolean(rep))).size,
    sources: {
      phoenix: core.filter((reading) => reading.source === "phoenix").length,
      old_crm: core.filter((reading) => reading.source === "old_crm").length,
    },
    medianSpreadMeters: Math.round(median(spreads)),
    maxSpreadMeters: Math.round(Math.max(...spreads)),
    firstDay: days[0],
    lastDay: days[days.length - 1],
  };
}

// ── The readings, merged from the rows the server read (pure, so the de-duplication is tested) ──────────

type Row = Record<string, unknown>;

/** One old-CRM (iReports360) check-in, as src/lib/crm/trusted-point-checkins.ts reads it. */
export type TrustedPointOldCheckin = {
  checkinId: number | null;
  lat: number;
  lon: number;
  /** The check-in instant, ISO. */
  checkDate: string;
  agentHrId: string | null;
};

/** Where the readings came from, for the screen and the script. */
export type TrustedPointGathered = {
  readings: TrustedPointReading[];
  counts: { phoenixVisits: number; placeReadings: number; oldCrmCheckins: number; copiedVisitsSkipped: number };
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hrIdOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The Cairo day of an instant, YYYY-MM-DD; null for no instant. */
export function cairoDayOf(iso: unknown): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : cairoWallClock(value).toISOString().slice(0, 10);
}

/**
 * Every reading of where a rep stood with this customer, from three sets of rows:
 *   - `visits`: phoenix_crm_visits rows (archived ones already left out by the read);
 *   - `places`: EVERY phoenix_crm_places row of the customer, RETIRED ones included — a rejected capture is
 *     still a real GPS fix at his door. Each gives its photo's own reading (dated by the photo's capture,
 *     Cairo day) and its Capture-location pin (dated by the place's capture); a pin identical to the photo
 *     reading is that one reading again and is counted once;
 *   - `oldCheckins`: the old CRM's iReports360 check-ins — never the unified view's Phoenix mirror.
 * 🔴 A visit COPIED from iReports360 (`imported_from_ireports360_at`) is the same check-in again: skipped when
 * its check-in is among `oldCheckins`, counted as one old-CRM reading otherwise — never twice.
 */
export function mergeTrustedPointReadings(rows: {
  visits: readonly Row[];
  places: readonly Row[];
  oldCheckins: readonly TrustedPointOldCheckin[];
}): TrustedPointGathered {
  const readings: TrustedPointReading[] = [];
  const oldIds = new Set(rows.oldCheckins.map((entry) => entry.checkinId).filter((id): id is number => id !== null));
  let phoenixVisits = 0;
  let copiedVisitsSkipped = 0;
  let oldCrmCheckins = 0;
  for (const visit of rows.visits) {
    const lat = numberOrNull(visit.lat);
    const lon = numberOrNull(visit.lon);
    const day = typeof visit.visit_date === "string" ? visit.visit_date.slice(0, 10) : null;
    if (lat === null || lon === null || !day) continue;
    const rep = hrIdOf(visit.rep_hr_id) ?? hrIdOf(visit.manager_hr_id) ?? hrIdOf(visit.entered_by_hr_id);
    const copied = visit.imported_from_ireports360_at !== null && visit.imported_from_ireports360_at !== undefined;
    if (copied) {
      const checkinId = numberOrNull(visit.ireports360_checkin_id);
      if (checkinId !== null && oldIds.has(checkinId)) {
        copiedVisitsSkipped += 1;
        continue;
      }
      readings.push({ lat, lon, day, source: "old_crm", accuracyMeters: null, repHrId: rep });
      oldCrmCheckins += 1;
      continue;
    }
    readings.push({ lat, lon, day, source: "phoenix", accuracyMeters: numberOrNull(visit.accuracy_meters), repHrId: rep });
    phoenixVisits += 1;
  }

  let placeReadings = 0;
  for (const place of rows.places) {
    const rep = hrIdOf(place.created_by_hr_id);
    const photoLat = numberOrNull(place.photo_lat);
    const photoLon = numberOrNull(place.photo_lon);
    if (photoLat !== null && photoLon !== null) {
      const day = cairoDayOf(place.photo_captured_at) ?? cairoDayOf(place.captured_at);
      if (day) {
        readings.push({ lat: photoLat, lon: photoLon, day, source: "phoenix", accuracyMeters: numberOrNull(place.photo_accuracy_meters), repHrId: rep });
        placeReadings += 1;
      }
    }
    const pinLat = numberOrNull(place.pin_lat);
    const pinLon = numberOrNull(place.pin_lon);
    const pinDay = cairoDayOf(place.captured_at);
    const pinIsPhoto = photoLat !== null && photoLon !== null && pinLat === photoLat && pinLon === photoLon;
    if (pinLat !== null && pinLon !== null && pinDay && !pinIsPhoto) {
      readings.push({ lat: pinLat, lon: pinLon, day: pinDay, source: "phoenix", accuracyMeters: numberOrNull(place.pin_accuracy_meters), repHrId: rep });
      placeReadings += 1;
    }
  }

  for (const checkin of rows.oldCheckins) {
    const day = cairoDayOf(checkin.checkDate);
    if (!day) continue;
    readings.push({ lat: checkin.lat, lon: checkin.lon, day, source: "old_crm", accuracyMeters: null, repHrId: checkin.agentHrId });
    oldCrmCheckins += 1;
  }

  return { readings, counts: { phoenixVisits, placeReadings, oldCrmCheckins, copiedVisitsSkipped } };
}

/** Whether a place's point came from this rule rather than a photograph at the door. */
export function isTrustedPointSource(pointSource: unknown): boolean {
  return pointSource === "trusted";
}
