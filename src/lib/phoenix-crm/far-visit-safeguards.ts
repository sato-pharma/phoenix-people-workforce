/**
 * Phoenix CRM — the four safeguards around a customer's place and the visits measured against it, with
 * no I/O (owner, 2026-11-10).
 *
 * WHY THEY EXIST. On 10 November 2026 Momen Fathy validated Dr. Doria Darraz indoors, on a stairwell. With
 * no sky his phone placed him by nearby Wi-Fi in Moharam Bek — 8.3 km from the clinic in El Raml — and
 * claimed 46 m. The photo's reading and the Capture-location pin were the SAME wrong point, to the seventh
 * decimal, so the two-reading check caught nothing, and 46 m is inside the place's 250 m line. Five minutes
 * earlier his visit to Al Hilal Hospital had saved in El Raml: crossing 8.3 km in 5.3 minutes is 93 km/h
 * through a city at midday. Every visit to that doctor afterwards was refused as "away from the place",
 * 51 times, while he stood at her door. He asked: "how to avoid these issues so they never happen again?",
 * and chose all four answers:
 *
 *   A · REFUSE IMPOSSIBLE LOCATIONS — a place reading the rep could not have reached from his own last
 *       saved visit, or one that repeats a point already refused as impossible, is refused at validation.
 *   B · ALERT ON A STUCK REP — five far refusals from one tight spot on one customer in one day tell the
 *       Super Admin and the SFE Manager, once, in-app and on Telegram, never by email.
 *   C · HOLD, DON'T REFUSE — after those five, the next visit from the same spot is SAVED and held for the
 *       SFE: it counts in nothing until the SFE approves it. This bends his 2026-10-20 refuse rule.
 *   D · A WIDER LINE FOR AN ACCOUNT — a hospital or pharmacy account (AM) refuses a visit only past 500 m;
 *       a doctor's clinic (PM) stays at the settings' 300 m.
 *
 * Measured on production before the numbers were chosen (30 days to 10 Nov 2026): of 12,244 consecutive
 * readings within an hour of each other (accuracy 50 m or better), 5 pairs implied more than 60 km/h over
 * 3 km or more — Momen's 93 km/h among them. And EXACT-duplicate coordinates are common on honest visits
 * (53 pairs from 7 reps), so "repeats any earlier point" would refuse honest reps: only a point ALREADY
 * refused as impossible is remembered.
 */

import { distanceMeters, isUsableFix } from "@/lib/phoenix-crm/geo";

// ── A · an impossible location at validation ────────────────────────────────────────────────────

/** Never reaches back: a place validated before this Cairo visit day is never re-judged (owner: "from today"). */
export const IMPOSSIBLE_LOCATION_FROM_DAY = "2026-11-10";

/** Below this distance nothing is impossible: a rep who drove across a district is still in it. */
export const IMPOSSIBLE_TRAVEL_MIN_METERS = 3000;

/** Faster than this through a city, between his last saved visit and this reading, is not travel. */
export const IMPOSSIBLE_TRAVEL_KMH = 80;

/** Only a visit saved in the last hour is an anchor: an older one says nothing about where he is now. */
export const IMPOSSIBLE_TRAVEL_LOOKBACK_MINUTES = 60;

/** An anchor must itself be a sharp reading: a rough visit is no proof of where he stood. */
export const ANCHOR_MAX_ACCURACY_METERS = 50;

/** A point refused as impossible is refused again, exactly, for this long — a Wi-Fi guess repeats itself. */
export const IMPOSSIBLE_POINT_MEMORY_HOURS = 6;

/**
 * What the rep reads. His own work and the way out, never the check, a distance or a speed — the same
 * advice the rough-reading refusal gives (Golden Rule #1): the reading indoors has not settled.
 */
export const IMPOSSIBLE_LOCATION_REFUSED =
  "Your location has not settled yet. Step outside the building, wait a moment for the location to settle, then capture the location again.";

export function impossibleLocationApplies(day: string): boolean {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= IMPOSSIBLE_LOCATION_FROM_DAY;
}

/** One of the rep's own saved visits, with the server's instant it was saved at. */
export type TimedReading = { lat: number; lon: number; accuracyMeters: number | null; at: string };

export type ImpossibleLocationVerdict =
  | { impossible: false }
  | {
      impossible: true;
      /** `travel`: unreachable from his last saved visit. `repeat`: the exact point already refused as impossible. */
      why: "travel" | "repeat";
      /** Metres from the anchor visit; null for a repeat with no anchor in the hour. */
      metres: number | null;
      minutes: number | null;
    };

/**
 * Could the rep have been at this reading now?
 *
 * 🔴 THE ANCHOR IS HIS LATEST SAVED VISIT, NEVER A PLACE PIN AND NEVER A REFUSED TRY. A visit saved since
 * 2026-10-20 was taken within 300 m of a validated place, so it is the best proof of where he stood; a pin
 * is what is being judged here, and a wrong pin used as an anchor would refuse every honest validation after
 * it. The anchor's time is the SERVER's save time, and this reading's is now — a queued save only makes the
 * computed speed HIGHER than the real one, which is why the bar is high (3 km and 80 km/h) and why the
 * refusal passes by itself within minutes (8.3 km is reachable again after about six).
 *
 * 🔴 THE REPEAT RULE IS WHAT CATCHES THE SECOND TRY. A Wi-Fi guess hands back the identical coordinate,
 * and by the second try the speed alone may have passed: so a point already refused as impossible is
 * refused again, compared EXACTLY (the same float twice), for six hours.
 */
export function judgeImpossibleLocation(input: {
  reading: { lat: number; lon: number };
  now: Date;
  anchors: readonly TimedReading[];
  refusedPoints: ReadonlyArray<{ lat: number; lon: number }>;
}): ImpossibleLocationVerdict {
  const { reading } = input;
  if (!isUsableFix(reading.lat, reading.lon)) return { impossible: false };
  const nowMs = input.now.getTime();
  const lookbackMs = IMPOSSIBLE_TRAVEL_LOOKBACK_MINUTES * 60 * 1000;
  let latest: { reading: TimedReading; atMs: number } | null = null;
  for (const anchor of input.anchors) {
    if (!isUsableFix(anchor.lat, anchor.lon)) continue;
    if (anchor.accuracyMeters === null || !Number.isFinite(anchor.accuracyMeters) || anchor.accuracyMeters > ANCHOR_MAX_ACCURACY_METERS) continue;
    const atMs = Date.parse(anchor.at);
    if (!Number.isFinite(atMs) || atMs > nowMs || nowMs - atMs > lookbackMs) continue;
    if (latest === null || atMs > latest.atMs) latest = { reading: anchor, atMs };
  }
  const metres = latest ? distanceMeters(reading, latest.reading) : null;
  const minutes = latest ? (nowMs - latest.atMs) / 60000 : null;
  if (latest && metres !== null && minutes !== null && metres >= IMPOSSIBLE_TRAVEL_MIN_METERS) {
    const kmh = minutes <= 0 ? Number.POSITIVE_INFINITY : metres / 1000 / (minutes / 60);
    if (kmh > IMPOSSIBLE_TRAVEL_KMH) return { impossible: true, why: "travel", metres, minutes };
  }
  if (input.refusedPoints.some((point) => point.lat === reading.lat && point.lon === reading.lon)) {
    return { impossible: true, why: "repeat", metres, minutes };
  }
  return { impossible: false };
}

// ── E · two readings of one capture that cannot both be the door ───────────────────────────────

/**
 * 🔴 A PLACE WHOSE PIN AND PHOTO READING CANNOT BOTH BE THE DOOR IS NOT SAVED (owner, 2026-11-11, "Build
 * all six fixes"). Until now the door judged the PIN's accuracy alone (`placeReadingsPrecise`) and then
 * fixed the place on the PHOTO's reading whenever that one claimed 250 m or better (`pickPlacePoint`); the
 * gap between the two was only filed, silently, after the save. Measured on production that day: 34 active
 * places hold a pin and a photo reading more than 250 m apart — Kristina Samy 65.9 km, Tharwat Milad
 * 10.1 km, Ashmoun Fever Hospital 869 m with all eight visits at the pin and none at the saved point — and
 * 23 of them were captured AFTER the camera's own cold-reading fix of 22 October.
 *
 * The rule is the camera's own (`readingsContradict`, photo-reading-rules.ts): further apart than both
 * claimed accuracies together, and never on less than the place's own line. It asks ONLY when the photo's
 * reading is the one that would fix the point — a rough photo reading (iPhone Safari's 650–2,000 m) never
 * fixes it, so a sharp pin still validates beside it exactly as his 2026-10-11 ruling says. On every
 * capture ever saved this refuses 35 of 5,599, and 3 of the last fortnight's 1,691.
 */
export const READINGS_APART_FLOOR_METERS = 250;

/**
 * What the rep reads. His own work and the way out — the photo AND the location again, because either
 * reading may be the stale one — never the check or a distance (Golden Rule #1).
 */
export const READINGS_APART_REFUSED =
  "Your location has not settled yet. Step outside the building, wait a moment for the location to settle, then take the photo and capture the location again.";

/** What the door needs of a draft to ask: the pin (`lat`/`lon`) and the photo's own reading. */
export type TwoReadings = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  photoLat: number | null;
  photoLon: number | null;
  photoAccuracyMeters: number | null;
};

function knownAccuracy(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The metres between the two readings when they cannot both be the door; null when they can, or one is missing. */
export function readingsApartMeters(place: TwoReadings): number | null {
  if (place.photoLat === null || place.photoLon === null) return null;
  if (!isUsableFix(place.lat, place.lon) || !isUsableFix(place.photoLat, place.photoLon)) return null;
  // A photo reading rougher than the place's line never fixes the point, so it cannot put it wrong.
  const photoAccuracy = place.photoAccuracyMeters;
  if (photoAccuracy !== null && Number.isFinite(photoAccuracy) && photoAccuracy > READINGS_APART_FLOOR_METERS) return null;
  const metres = distanceMeters({ lat: place.lat, lon: place.lon }, { lat: place.photoLat, lon: place.photoLon });
  const line = Math.max(READINGS_APART_FLOOR_METERS, knownAccuracy(place.accuracyMeters) + knownAccuracy(photoAccuracy));
  return metres > line ? metres : null;
}

// ── B and C · a rep stuck at one spot ──────────────────────────────────────────────────────────

/** Five far refusals on one customer, from one spot, mean the PLACE is wrong — not the rep. */
export const STUCK_MIN_TRIES = 5;

/**
 * How many Cairo days of far tries are read together (owner, 2026-11-11). One day was the first rule, and
 * it missed the rep who gives up after two or three tries and comes back the next day: 74 customer-days on
 * production stopped at two to four refusals, and 15 places were refused on two or more days.
 */
export const STUCK_LOOKBACK_DAYS = 7;

/** "One spot": every try within this distance of the first one's neighbourhood. */
export const STUCK_SPREAD_METERS = 50;

/** Only a sharp try counts towards being stuck — a rough reading is no proof of where he stood. */
export const STUCK_MAX_ACCURACY_METERS = 30;

export type FarTry = { lat: number; lon: number; accuracyMeters: number | null };

export type StuckVerdict = {
  stuck: boolean;
  /** How many sharp tries sit together at the spot. */
  tries: number;
  /** The middle of the spot — where the rep stands, which is where the place should probably be. */
  centre: { lat: number; lon: number } | null;
};

function sharp(entry: FarTry): boolean {
  return (
    isUsableFix(entry.lat, entry.lon) &&
    entry.accuracyMeters !== null &&
    Number.isFinite(entry.accuracyMeters) &&
    entry.accuracyMeters <= STUCK_MAX_ACCURACY_METERS
  );
}

/**
 * Is the rep stuck at one spot? The largest group of sharp tries that sit within 50 m of one of them
 * decides: five or more is stuck. Pure, so the alert (B) and the hold (C) can never disagree about it.
 */
export function stuckAtOneSpot(tries: readonly FarTry[]): StuckVerdict {
  const usable = tries.filter(sharp);
  let best: FarTry[] = [];
  for (const candidate of usable) {
    const group = usable.filter((entry) => distanceMeters(candidate, entry) <= STUCK_SPREAD_METERS);
    if (group.length > best.length) best = group;
  }
  if (best.length === 0) return { stuck: false, tries: 0, centre: null };
  const centre = {
    lat: best.reduce((sum, entry) => sum + entry.lat, 0) / best.length,
    lon: best.reduce((sum, entry) => sum + entry.lon, 0) / best.length,
  };
  return { stuck: best.length >= STUCK_MIN_TRIES, tries: best.length, centre };
}

/**
 * C · is THIS visit saved and held instead of refused? Only when the tries BEFORE it already make him
 * stuck, and this reading is itself sharp and at the same spot — a rep who walks off somewhere else is
 * refused as before.
 */
export function holdInsteadOfRefuse(earlierTries: readonly FarTry[], reading: FarTry): StuckVerdict & { hold: boolean } {
  const verdict = stuckAtOneSpot(earlierTries);
  const atTheSpot =
    verdict.stuck && verdict.centre !== null && sharp(reading) && distanceMeters(verdict.centre, reading) <= STUCK_SPREAD_METERS;
  return { ...verdict, hold: atTheSpot };
}

// ── F · a visit logged before the customer had a place ─────────────────────────────────────────

/**
 * 🔴 A VISIT LOGGED BEFORE THE CUSTOMER HAD A PLACE IS MEASURED WHEN HE GETS ONE, AND HELD IF IT IS PAST
 * THE LINE (owner, 2026-11-11, "Build all six fixes"). A customer can be visited before he is validated
 * (owner, 2026-09-29): the visit saves with nothing to measure against, and the day he is validated it
 * starts counting. The far rule of 20 October lives only in the save, so such a visit was never asked
 * where it was taken — measured on production that day, 45 rep visits since 20 October sat past the line
 * of the place the customer was later validated at, and every one of them counted.
 *
 * It is HELD for the SFE, exactly as C holds one — never refused and never deleted: the rep may have stood
 * at the right door with the place then saved at the wrong one, and only a person can tell. Only the visit
 * the save itself would have refused: the rep's own entry, on or after the far rule's first day, never a
 * copied old visit and never an archived one.
 */
export type FarVisitHoldBasis = "stuck" | "before_place";

/** An unread or unknown basis is the first rule's — the only one a row written before 2026-11-11 can hold. */
export function parseFarVisitHoldBasis(value: unknown): FarVisitHoldBasis {
  return value === "before_place" ? "before_place" : "stuck";
}

export function visitHeldBeforePlace(input: {
  /** The far rule applies to the visit's own day (`farVisitRefusalApplies`). */
  farRuleApplies: boolean;
  enteredByRep: boolean;
  copiedFromOldSystem: boolean;
  archived: boolean;
  /** Past the refusal's own line of the place it is now measured against (`visitAwayFromValidatedPlace`). */
  pastTheLine: boolean;
}): boolean {
  return input.farRuleApplies && input.enteredByRep && !input.copiedFromOldSystem && !input.archived && input.pastTheLine;
}

// ── G · the places worth a second look ─────────────────────────────────────────────────────────

/** How far back the re-check list reads refusals and visits. */
export const RECHECK_LOOKBACK_DAYS = 30;

/**
 * Three sharp refusals from one spot in a month put a place on the re-check list — below the five that
 * hold a visit, because a rep who gives up at three never reaches five (74 customer-days on production).
 */
export const RECHECK_MIN_TRIES = 3;

/** A place with this many measured visits and not one of them inside the line is on the list. */
export const RECHECK_MIN_FAR_VISITS = 2;

/** What the rep reads on a held visit: it is saved, and when it counts. Never why, never a distance. */
export const FAR_VISIT_HELD_NOTE = "Saved. This visit counts once SFE approves it.";

/** The SFE's decision on a held visit, and the hold's own state. */
export type FarVisitHoldStatus = "sfe_pending" | "approved" | "refused";

export function parseFarVisitHoldStatus(value: unknown): FarVisitHoldStatus | null {
  return value === "sfe_pending" || value === "approved" || value === "refused" ? value : null;
}

// ── D · the far line of an account ──────────────────────────────────────────────────────────────

/** A hospital or a pharmacy account is a big building: its visit is refused only past this (owner, "500 m"). */
export const ACCOUNT_FAR_LINE_METERS = 500;

/**
 * The line a rep's visit is REFUSED at, for this customer. An AM customer (a hospital or an account) gets
 * at least 500 m; a PM doctor's clinic keeps the settings' line (300 m). Only the refusal reads this: the
 * visit's own `location_flag` and every board keep the settings' line, so nothing already measured moves.
 */
export function farRefusalLineFor(listType: unknown, settingsFarMeters: number): number {
  const line = Number.isFinite(settingsFarMeters) && settingsFarMeters > 0 ? settingsFarMeters : 300;
  return listType === "AM" ? Math.max(line, ACCOUNT_FAR_LINE_METERS) : line;
}
