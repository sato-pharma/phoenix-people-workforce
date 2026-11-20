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
 *     a polyclinic) beside the satellites alone, and seals the most accurate reading from two minutes before the
 *     shutter to thirty seconds after it, never wider than `SEAL_MAX_ACCURACY_METERS` (98% within about 74 m);
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
/** The location may be at most this old when the shutter is pressed. */
export const SEAL_MAX_FIX_AGE_MS = 2 * 60_000;
/** The location may lock at most this long after the shutter: the photo is taken at once and the location settles after. */
export const SEAL_MAX_FIX_AFTER_MS = 30_000;
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
  lat: number;
  lon: number;
  accuracyMeters: number;
  satellitesUsed: number;
  satellitesSeen: number;
  provider: string;
  fixAgeMs: number;
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

/** What a camera-2.0 seal binds: the territory, the customer, the visit's own id and the offline clock. */
export type SealVisit = {
  seatId: string;
  customerId: string;
  /** The visit's uuid, chosen on the phone; a resend of the same sync is the same visit. */
  visitId: string;
  /** Phoenix's time anchor and the uptime since it (`offline-clock.ts`) — never a phone timestamp. */
  offline: { anchorId: string; elapsedMs: number; bootId: string | null } | null;
};


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
  return { seatId: v.seatId.trim(), customerId: v.customerId.toLowerCase(), visitId: v.visitId.toLowerCase(), offline };
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
  for (const key of ["lat", "lon", "accuracyMeters", "satellitesUsed", "satellitesSeen", "fixAgeMs", "androidSdk"] as const) {
    if (!isNumber(p[key])) return "The seal's location cannot be read.";
  }
  if (!isText(p.provider, 20) || !isText(p.timeSource, 20) || !isInstant(p.takenAtUtc) || !isInstant(p.phoneClockUtc)) {
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
    lat: p.lat as number,
    lon: p.lon as number,
    accuracyMeters: p.accuracyMeters as number,
    satellitesUsed: p.satellitesUsed as number,
    satellitesSeen: p.satellitesSeen as number,
    provider: p.provider,
    fixAgeMs: p.fixAgeMs as number,
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

/** Every reason this payload cannot stand as a validated place. Empty = it may. */
export function sealPayloadProblems(payload: SealPayload, nowMs: number = Date.now()): string[] {
  const problems: string[] = [];
  if (payload.mock) problems.push("The location came from a fake-location app.");
  if (payload.mockAppActive) problems.push("A fake-location app was switched on in the phone when the photo was taken.");
  if (payload.rooted) problems.push("The phone is rooted, so nothing it reports can be trusted.");
  if (payload.emulator) problems.push("The photo was not taken on a real phone.");
  if (!(SEAL_PROVIDERS as readonly string[]).includes(payload.provider)) problems.push("The location did not come from the phone's own location service.");
  if (!(SEAL_TIME_SOURCES as readonly string[]).includes(payload.timeSource)) problems.push("The seal does not say which clock its time came from.");
  if (payload.provider === "gps" && payload.satellitesUsed < SEAL_MIN_SATELLITES) {
    problems.push(`The location was fixed from ${payload.satellitesUsed} satellites; at least ${SEAL_MIN_SATELLITES} are needed.`);
  }
  if (payload.fixAgeMs > SEAL_MAX_FIX_AGE_MS) problems.push("The location was taken more than 2 minutes before the photo.");
  if (payload.fixAgeMs < -SEAL_MAX_FIX_AFTER_MS) problems.push("The location was taken more than 30 seconds after the photo.");
  if (payload.accuracyMeters > SEAL_MAX_ACCURACY_METERS) {
    problems.push(
      `The location was not exact enough: the phone was 98% sure of the place only to ${Math.round(payload.accuracyMeters * RADIUS_98_FACTOR)} m, and ${Math.round(SEAL_MAX_ACCURACY_METERS * RADIUS_98_FACTOR)} m is the most accepted.`,
    );
  }
  const reading = adminPhotoReadingProblem({ lat: payload.lat, lon: payload.lon, accuracyMeters: payload.accuracyMeters });
  if (reading) problems.push(reading);

  const takenAt = Date.parse(payload.takenAtUtc);
  if (takenAt > nowMs + SEAL_FUTURE_TOLERANCE_MS) problems.push("The photo's time is later than now.");
  if (takenAt < nowMs - SEAL_MAX_AGE_HOURS * 3_600_000) {
    problems.push(`The photo was taken more than ${SEAL_MAX_AGE_HOURS} hours ago. Ask the rep to take it again.`);
  }
  if (payload.timeSource === "satellites" && payload.networkTimeUtc) {
    const gap = Math.abs(Date.parse(payload.networkTimeUtc) - takenAt) / 1000;
    if (gap > SEAL_MAX_NETWORK_GAP_SECONDS) {
      problems.push(`The satellites' time and Phoenix's own clock disagreed by ${minutes(gap)} — the satellite signal was not genuine.`);
    }
  }
  return problems;
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
  if (payload.fixAgeMs > SEAL_OLD_FIX_NOTE_MS) {
    warnings.push(`The position was taken ${minutes(payload.fixAgeMs / 1000)} before the photo. Check the photo is of this place.`);
  }
  if (payload.developerOptions) warnings.push("Developer options are switched on in the phone.");
  if (payload.adb) warnings.push("USB debugging was switched on in the phone.");
  return warnings;
}
