/**
 * The Phoenix Camera seal — what its PAYLOAD must say before Phoenix lets it stand as a validated place.
 * Pure (no crypto, no database), so the test holds every rule; the signature and the phone's attestation are
 * judged in server/field-camera-seal.ts, the history and the revocation list in server/field-camera.ts.
 *
 * Owner, 20 Nov 2026: "with every precaution against fake locations and fraud". Each refusal below is one trick:
 *   - a fake-location app feeding the phone a point (Android marks the fix, and the app looks for one switched on);
 *   - a rooted phone or an emulator, which can lie about anything;
 *   - a rough or stale position: the rep never waits for the satellites (owner, 20 Nov 2026: "I don't want him to
 *     wait ... he can take the photo now, and make sure the location is accurate, at least 98%"), so the camera
 *     takes the phone's combined position (Wi-Fi, mobile network and satellites — the only one that answers inside
 *     a polyclinic) beside the satellites alone, and seals the closest good reading from ten minutes before the
 *     shutter (else the first one inside the ten minutes after it — owner, 20 Nov 2026, point 3), never wider than
 *     `SEAL_MAX_ACCURACY_METERS` (98% within about 74 m). A photo with no position at all is still sealed and sent
 *     ("no location"): the Super Admin decides, and it can never become a customer's place;
 *   - the phone's clock moved in Settings: the time is the satellites' clock (kept since the phone last saw them),
 *     else Phoenix's own clock, and only then the phone's, which the Super Admin is told; when both the satellites'
 *     and Phoenix's clocks are known they must agree — a disagreement of minutes is a spoofed satellite signal;
 *   - an old photo kept for later: a seal is used within `SEAL_MAX_AGE_HOURS`.
 * The warnings are shown to the Super Admin and decide nothing.
 */

import { isUuid } from "@/lib/http/uuid";
import { adminPhotoReadingProblem } from "@/lib/phoenix-crm/admin-photo-rules";
import { FIELD_CAMERA_PACKAGE } from "@/lib/phoenix-crm/field-camera/seal-format";

/** A sealed photo is used within this many hours of being taken: the clinic with no signal, sent from the car. */
export const SEAL_MAX_AGE_HOURS = 72;
/** A position from the satellites alone names at least this many — a fake signal or a fix from memory rarely names four. */
export const SEAL_MIN_SATELLITES = 4;
/** Where the camera's position may come from: the satellites alone, Google's combined position, or the phone's network position. */
export const SEAL_PROVIDERS = ["gps", "fused", "network"] as const;
/** Which clock the photo's time came from, best first. */
export const SEAL_TIME_SOURCES = ["satellites", "phoenix", "phone"] as const;
/**
 * The location may be at most this old when the shutter is pressed (owner, 20 Nov 2026, the clinic with no
 * network: "the photo is taken at once and stored", sealed with the closest good position from the ten minutes
 * before — the camera reads the position from the moment it opens).
 */
export const SEAL_MAX_FIX_AGE_MS = 10 * 60_000;
/** The location may lock at most this long after the shutter: "location pending" until the first good position. */
export const SEAL_MAX_FIX_AFTER_MS = 10 * 60_000;
/** How the camera found the position: within moments of the shutter, from the ten minutes before, after it, or never. */
export const SEAL_LOCATION_STATUSES = ["locked", "cached", "late", "none"] as const;
export type SealLocationStatus = (typeof SEAL_LOCATION_STATUSES)[number];
/** What the photo shows (camera 2.1.0): the clinic's own sign or door, or one of the four doctor's-name photos. */
export const SEAL_PHOTO_KINDS = ["place", "door_sign", "banner", "prescription", "business_card"] as const;
export type SealPhotoKind = (typeof SEAL_PHOTO_KINDS)[number];
/** What the rep did with the photo (camera 2.2.0): a visit, a validation alone, or a new customer. */
export const SEAL_INTENTS = ["visit", "validate", "new_customer"] as const;
export type SealIntent = (typeof SEAL_INTENTS)[number];
/** A position older than this at the shutter is told to the Super Admin. */
export const SEAL_OLD_FIX_NOTE_MS = 60_000;
/**
 * The widest the location may be: Android's accuracy (a 68% radius) of 40 m is 98% within about 74 m — the owner's
 * "at least 98% accurate". The camera seals at once at 20 m (98% within about 37 m).
 */
export const SEAL_MAX_ACCURACY_METERS = 40;
/** Android's 68% accuracy radius to the 98% radius of the same spread (2.797 / 1.5096). */
export const RADIUS_98_FACTOR = 1.853;
/** The satellites' time and Phoenix's clock (when the phone last saw it) may differ by this much at most. */
export const SEAL_MAX_NETWORK_GAP_SECONDS = 600;
/** The phone's own clock off the satellites' by more than this is reported (the satellites' time is used). */
export const SEAL_CLOCK_WARNING_SECONDS = 120;
/** A photo's time this far ahead of Phoenix's clock is impossible. */
export const SEAL_FUTURE_TOLERANCE_MS = 5 * 60_000;

export type SealPayload = {
  v: 1;
  app: string;
  appVersion: string;
  imageSha256: string;
  hrId: string;
  repName: string;
  /** Null when the camera found no position within ten minutes of the shutter (`locationStatus` "none"). */
  lat: number | null;
  lon: number | null;
  accuracyMeters: number | null;
  satellitesUsed: number | null;
  satellitesSeen: number | null;
  provider: string | null;
  fixAgeMs: number | null;
  /** Absent on seals before camera 2.1.0, which always carried a position: read as "locked". */
  locationStatus: SealLocationStatus;
  takenAtUtc: string;
  timeSource: string;
  phoneClockUtc: string;
  /** Phoenix's clock as the phone last read it, carried forward by the uptime counter; null when it never had one since boot. */
  networkTimeUtc: string | null;
  mock: boolean;
  mockAppActive: boolean;
  rooted: boolean;
  emulator: boolean;
  developerOptions: boolean;
  adb: boolean;
  deviceModel: string;
  androidSdk: number;
  nonce: string;
  /**
   * The visit the photo was taken for (camera 2.0, the rep's offline app — owner, 20 Nov 2026: "the validation
   * will register and the visit will register"). Inside the signature, so the phone cannot move a photo to
   * another customer or another visit after the shutter. Absent on a photo taken for the Super Admin's upload.
   */
  visit: SealVisit | null;
};

/** A new customer the rep added on the camera (camera 2.2.0), inside the signature. */
export type SealNewCustomer = {
  listType: string;
  name: string;
  nameParts: { first: string; middle: string; last: string } | null;
  customerType: string | null;
  speciality: string | null;
  proposedGrade: string;
  phone: string | null;
};

/** What a camera-2.0 seal binds: the territory, the customer, the visit's own id and the offline clock. */
export type SealVisit = {
  seatId: string;
  customerId: string;
  /** The visit's uuid, chosen on the phone; a resend of the same sync is the same visit. */
  visitId: string;
  /** Phoenix's time anchor and the uptime since it (`offline-clock.ts`) — never a phone timestamp. */
  offline: { anchorId: string; elapsedMs: number; bootId: string | null } | null;
  /** A visit unless the seal says otherwise; a validation alone or a new customer since camera 2.2.0. */
  intent: SealIntent;
  /** "place" unless the seal names one of the four doctor's-name photos (camera 2.1.0). */
  photoKind: SealPhotoKind;
  /** Only on `intent` "new_customer": what the rep typed, signed with the photo. */
  newCustomer: SealNewCustomer | null;
};

function parseSealNewCustomer(raw: unknown): SealNewCustomer | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "The seal's new customer cannot be read.";
  const c = raw as Record<string, unknown>;
  const optional = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  if (!isText(c.listType, 20) || !isText(c.name, 200) || !isText(c.proposedGrade, 2)) return "The seal's new customer cannot be read.";
  let nameParts: SealNewCustomer["nameParts"] = null;
  if (c.nameParts && typeof c.nameParts === "object" && !Array.isArray(c.nameParts)) {
    const parts = c.nameParts as Record<string, unknown>;
    const first = optional(parts.first, 60);
    const middle = optional(parts.middle, 60);
    const last = optional(parts.last, 60);
    if (first && middle && last) nameParts = { first, middle, last };
  }
  return {
    listType: c.listType.trim(),
    name: c.name.trim(),
    nameParts,
    customerType: optional(c.customerType, 80),
    speciality: optional(c.speciality, 120),
    proposedGrade: c.proposedGrade.trim().toUpperCase(),
    phone: optional(c.phone, 24),
  };
}


/** The visit block, null when the seal carries none, or a string naming why it cannot be read. */
function parseSealVisit(raw: unknown): SealVisit | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "The seal's visit cannot be read.";
  const v = raw as Record<string, unknown>;
  if (!isText(v.seatId, 64) || !isText(v.customerId, 36) || !isUuid(v.customerId) || !isText(v.visitId, 36) || !isUuid(v.visitId)) {
    return "The seal's visit cannot be read.";
  }
  let offline: SealVisit["offline"] = null;
  if (v.offline !== undefined && v.offline !== null) {
    const o = v.offline as Record<string, unknown>;
    if (typeof o !== "object" || !isText(o.anchorId, 36) || !isUuid(o.anchorId) || !isNumber(o.elapsedMs) || o.elapsedMs < 0) {
      return "The seal's offline clock cannot be read.";
    }
    const bootId = typeof o.bootId === "string" && o.bootId.trim() ? o.bootId.trim().slice(0, 120) : null;
    offline = { anchorId: o.anchorId.toLowerCase(), elapsedMs: Math.round(o.elapsedMs), bootId };
  }
  const intent = v.intent === undefined || v.intent === null ? "visit" : v.intent;
  if (!(SEAL_INTENTS as readonly unknown[]).includes(intent)) return "The seal's visit cannot be read.";
  const photoKind = v.photoKind === undefined || v.photoKind === null ? "place" : v.photoKind;
  if (!(SEAL_PHOTO_KINDS as readonly unknown[]).includes(photoKind)) return "The seal's visit cannot be read.";
  const newCustomer = parseSealNewCustomer(v.newCustomer);
  if (typeof newCustomer === "string") return newCustomer;
  if ((intent === "new_customer") !== (newCustomer !== null)) return "The seal's new customer cannot be read.";
  return {
    seatId: v.seatId.trim(),
    customerId: v.customerId.toLowerCase(),
    visitId: v.visitId.toLowerCase(),
    offline,
    intent: intent as SealIntent,
    photoKind: photoKind as SealPhotoKind,
    newCustomer,
  };
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** The payload, or the reason it is not one. Every field is required; an unknown shape is never guessed at. */
export function parseSealPayload(text: string): SealPayload | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "The seal's contents cannot be read.";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "The seal's contents cannot be read.";
  const p = raw as Record<string, unknown>;
  const booleans = ["mock", "mockAppActive", "rooted", "emulator", "developerOptions", "adb"] as const;
  if (p.v !== 1) return "This seal was made by a version of the Phoenix Camera Phoenix does not know.";
  if (p.app !== FIELD_CAMERA_PACKAGE) return "This seal was not made by the Phoenix Camera.";
  if (!isText(p.appVersion, 20) || !isText(p.imageSha256, 64) || !/^[0-9a-f]{64}$/.test(p.imageSha256)) return "The seal's contents cannot be read.";
  if (!isText(p.hrId, 20) || !/^[A-Za-z0-9-]+$/.test(p.hrId.trim()) || !isText(p.repName, 120)) return "The seal does not name the rep.";
  const locationStatus = p.locationStatus === undefined || p.locationStatus === null ? "locked" : p.locationStatus;
  if (!(SEAL_LOCATION_STATUSES as readonly unknown[]).includes(locationStatus)) return "The seal's location cannot be read.";
  const located = locationStatus !== "none";
  // A seal with no position carries none of its numbers; one with a position carries all of them.
  for (const key of ["lat", "lon", "accuracyMeters", "satellitesUsed", "satellitesSeen", "fixAgeMs"] as const) {
    if (located ? !isNumber(p[key]) : p[key] !== null && p[key] !== undefined) return "The seal's location cannot be read.";
  }
  if (!isNumber(p.androidSdk)) return "The seal's location cannot be read.";
  if (located ? !isText(p.provider, 20) : p.provider !== null && p.provider !== undefined && !isText(p.provider, 20)) {
    return "The seal's location cannot be read.";
  }
  if (!isText(p.timeSource, 20) || !isInstant(p.takenAtUtc) || !isInstant(p.phoneClockUtc)) {
    return "The seal's time cannot be read.";
  }
  if (p.networkTimeUtc !== null && !isInstant(p.networkTimeUtc)) return "The seal's time cannot be read.";
  for (const key of booleans) if (typeof p[key] !== "boolean") return "The seal's phone checks cannot be read.";
  if (!isText(p.deviceModel, 120) || !isText(p.nonce, 64)) return "The seal's contents cannot be read.";
  const visit = parseSealVisit(p.visit);
  if (typeof visit === "string") return visit;
  return {
    v: 1,
    app: p.app,
    appVersion: p.appVersion,
    imageSha256: p.imageSha256,
    hrId: p.hrId.trim().toUpperCase(),
    repName: p.repName.trim(),
    lat: located ? (p.lat as number) : null,
    lon: located ? (p.lon as number) : null,
    accuracyMeters: located ? (p.accuracyMeters as number) : null,
    satellitesUsed: located ? (p.satellitesUsed as number) : null,
    satellitesSeen: located ? (p.satellitesSeen as number) : null,
    provider: located ? (p.provider as string) : null,
    fixAgeMs: located ? (p.fixAgeMs as number) : null,
    locationStatus: locationStatus as SealLocationStatus,
    takenAtUtc: p.takenAtUtc,
    timeSource: p.timeSource,
    phoneClockUtc: p.phoneClockUtc,
    networkTimeUtc: (p.networkTimeUtc as string | null) ?? null,
    mock: p.mock as boolean,
    mockAppActive: p.mockAppActive as boolean,
    rooted: p.rooted as boolean,
    emulator: p.emulator as boolean,
    developerOptions: p.developerOptions as boolean,
    adb: p.adb as boolean,
    deviceModel: p.deviceModel,
    androidSdk: p.androidSdk as number,
    nonce: p.nonce,
    visit,
  };
}

function minutes(seconds: number): string {
  const whole = Math.round(seconds / 60);
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}

/**
 * What says the photo or the phone is not genuine: a fake-location app, a rooted phone, an emulator, a position
 * from nowhere, a clock that lies. The camera's own sync never refuses on these (owner, 20 Nov 2026: "Phoenix will
 * not reject anything") — they flag the item red on the Super Admin's camera page.
 */
export function sealIntegrityProblems(payload: SealPayload, nowMs: number = Date.now()): string[] {
  const problems: string[] = [];
  if (payload.mock) problems.push("The location came from a fake-location app.");
  if (payload.mockAppActive) problems.push("A fake-location app was switched on in the phone when the photo was taken.");
  if (payload.rooted) problems.push("The phone is rooted, so nothing it reports can be trusted.");
  if (payload.emulator) problems.push("The photo was not taken on a real phone.");
  if (payload.provider !== null && !(SEAL_PROVIDERS as readonly string[]).includes(payload.provider)) {
    problems.push("The location did not come from the phone's own location service.");
  }
  if (!(SEAL_TIME_SOURCES as readonly string[]).includes(payload.timeSource)) problems.push("The seal does not say which clock its time came from.");
  if (payload.provider === "gps" && payload.satellitesUsed !== null && payload.satellitesUsed < SEAL_MIN_SATELLITES) {
    problems.push(`The location was fixed from ${payload.satellitesUsed} satellites; at least ${SEAL_MIN_SATELLITES} are needed.`);
  }
  const takenAt = Date.parse(payload.takenAtUtc);
  if (takenAt > nowMs + SEAL_FUTURE_TOLERANCE_MS) problems.push("The photo's time is later than now.");
  if (payload.timeSource === "satellites" && payload.networkTimeUtc) {
    const gap = Math.abs(Date.parse(payload.networkTimeUtc) - takenAt) / 1000;
    if (gap > SEAL_MAX_NETWORK_GAP_SECONDS) {
      problems.push(`The satellites' time and Phoenix's own clock disagreed by ${minutes(gap)} — the satellite signal was not genuine.`);
    }
  }
  return problems;
}

/** Why the position cannot stand as the place's: none at all, too rough, or outside ten minutes of the shutter. */
export function sealLocationProblems(payload: SealPayload): string[] {
  if (payload.lat === null || payload.lon === null || payload.accuracyMeters === null || payload.fixAgeMs === null) {
    return [SEAL_NO_LOCATION];
  }
  const problems: string[] = [];
  if (payload.fixAgeMs > SEAL_MAX_FIX_AGE_MS) problems.push("The location was taken more than 10 minutes before the photo.");
  if (payload.fixAgeMs < -SEAL_MAX_FIX_AFTER_MS) problems.push("The location was taken more than 10 minutes after the photo.");
  if (payload.accuracyMeters > SEAL_MAX_ACCURACY_METERS) {
    problems.push(
      `The location was not exact enough: the phone was 98% sure of the place only to ${Math.round(payload.accuracyMeters * RADIUS_98_FACTOR)} m, and ${Math.round(SEAL_MAX_ACCURACY_METERS * RADIUS_98_FACTOR)} m is the most accepted.`,
    );
  }
  const reading = adminPhotoReadingProblem({ lat: payload.lat, lon: payload.lon, accuracyMeters: payload.accuracyMeters });
  if (reading) problems.push(reading);
  return problems;
}

/** The words for a seal that carries no position at all. */
export const SEAL_NO_LOCATION = "The camera found no position within ten minutes of the photo.";

/** True when the photo is older than a seal may be used for the Super Admin's own upload. */
export function sealIsStale(payload: SealPayload, nowMs: number = Date.now()): boolean {
  return Date.parse(payload.takenAtUtc) < nowMs - SEAL_MAX_AGE_HOURS * 3_600_000;
}

/** Every reason this payload cannot stand as a validated place. Empty = it may. The Super Admin's upload refuses on any. */
export function sealPayloadProblems(payload: SealPayload, nowMs: number = Date.now()): string[] {
  const stale = sealIsStale(payload, nowMs) ? [`The photo was taken more than ${SEAL_MAX_AGE_HOURS} hours ago. Ask the rep to take it again.`] : [];
  return [...stale, ...sealIntegrityProblems(payload, nowMs), ...sealLocationProblems(payload)];
}

/** What the Super Admin is told beside a seal that holds. Nothing here refuses. */
export function sealPayloadWarnings(payload: SealPayload): string[] {
  const warnings: string[] = [];
  const clock = payload.timeSource === "satellites" ? "the satellites'" : "Phoenix's";
  const clockGap = Math.abs(Date.parse(payload.phoneClockUtc) - Date.parse(payload.takenAtUtc)) / 1000;
  if (payload.timeSource !== "phone" && clockGap > SEAL_CLOCK_WARNING_SECONDS) {
    warnings.push(`The phone's own clock was ${minutes(clockGap)} off ${clock} time. ${clock.charAt(0).toUpperCase()}${clock.slice(1)} time is the one used.`);
  }
  if (payload.timeSource === "phone") {
    warnings.push("The time is the phone's own clock: the phone had seen neither the satellites nor Phoenix's clock since it was switched on. Check the time is right.");
  } else if (payload.timeSource === "satellites" && !payload.networkTimeUtc) {
    warnings.push("The phone had not seen Phoenix's clock since it was last switched on, so only the satellites' time was checked.");
  }
  if (payload.fixAgeMs !== null && payload.fixAgeMs > SEAL_OLD_FIX_NOTE_MS) {
    warnings.push(`The position was taken ${minutes(payload.fixAgeMs / 1000)} before the photo. Check the photo is of this place.`);
  }
  if (payload.fixAgeMs !== null && payload.fixAgeMs < -SEAL_OLD_FIX_NOTE_MS) {
    warnings.push(`The position was found ${minutes(-payload.fixAgeMs / 1000)} after the photo. Check the photo is of this place.`);
  }
  if (payload.developerOptions) warnings.push("Developer options are switched on in the phone.");
  if (payload.adb) warnings.push("USB debugging was switched on in the phone.");
  return warnings;
}
