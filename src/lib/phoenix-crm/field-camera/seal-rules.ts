/**
 * The Phoenix Camera seal — what its PAYLOAD must say before Phoenix lets it stand as a validated place.
 * Pure (no crypto, no database), so the test holds every rule; the signature and the phone's attestation are
 * judged in server/field-camera-seal.ts, the history and the revocation list in server/field-camera.ts.
 *
 * Owner, 20 Nov 2026: "with every precaution against fake locations and fraud". Each refusal below is one trick:
 *   - a fake-location app feeding the phone a point (Android marks the fix, and the app looks for one switched on);
 *   - a rooted phone or an emulator, which can lie about anything;
 *   - a location from Wi-Fi or the network instead of the satellites, or a fix older than a minute;
 *   - the phone's clock moved in Settings: the time that counts is the satellites', and when the phone last saw
 *     Phoenix's own clock the two must agree — a disagreement of minutes is a spoofed satellite signal;
 *   - an old photo kept for later: a seal is used within `SEAL_MAX_AGE_HOURS`.
 * The warnings are shown to the Super Admin and decide nothing.
 */

import { adminPhotoReadingProblem } from "@/lib/phoenix-crm/admin-photo-rules";
import { FIELD_CAMERA_PACKAGE } from "@/lib/phoenix-crm/field-camera/seal-format";

/** A sealed photo is used within this many hours of being taken: the clinic with no signal, sent from the car. */
export const SEAL_MAX_AGE_HOURS = 72;
/** At least this many satellites in the fix — a fake signal or a fix from memory rarely names four. */
export const SEAL_MIN_SATELLITES = 4;
/** The location may be at most this old when the shutter is pressed. */
export const SEAL_MAX_FIX_AGE_MS = 60_000;
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
};

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
  };
}

function minutes(seconds: number): string {
  const whole = Math.round(seconds / 60);
  return whole === 1 ? "1 minute" : `${whole} minutes`;
}

/** Every reason this payload cannot stand as a validated place. Empty = it may. */
export function sealPayloadProblems(payload: SealPayload, nowMs: number = Date.now()): string[] {
  const problems: string[] = [];
  if (payload.mock) problems.push("The location came from a fake-location app, not from the satellites.");
  if (payload.mockAppActive) problems.push("A fake-location app was switched on in the phone when the photo was taken.");
  if (payload.rooted) problems.push("The phone is rooted, so nothing it reports can be trusted.");
  if (payload.emulator) problems.push("The photo was not taken on a real phone.");
  if (payload.provider !== "gps" || payload.timeSource !== "satellites") problems.push("The location and time did not come from the satellites.");
  if (payload.satellitesUsed < SEAL_MIN_SATELLITES) {
    problems.push(`The location was fixed from ${payload.satellitesUsed} satellites; at least ${SEAL_MIN_SATELLITES} are needed.`);
  }
  if (payload.fixAgeMs < 0 || payload.fixAgeMs > SEAL_MAX_FIX_AGE_MS) problems.push("The location was more than a minute old when the photo was taken.");
  const reading = adminPhotoReadingProblem({ lat: payload.lat, lon: payload.lon, accuracyMeters: payload.accuracyMeters });
  if (reading) problems.push(reading);

  const takenAt = Date.parse(payload.takenAtUtc);
  if (takenAt > nowMs + SEAL_FUTURE_TOLERANCE_MS) problems.push("The photo's time is later than now.");
  if (takenAt < nowMs - SEAL_MAX_AGE_HOURS * 3_600_000) {
    problems.push(`The photo was taken more than ${SEAL_MAX_AGE_HOURS} hours ago. Ask the rep to take it again.`);
  }
  if (payload.networkTimeUtc) {
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
  const clockGap = Math.abs(Date.parse(payload.phoneClockUtc) - Date.parse(payload.takenAtUtc)) / 1000;
  if (clockGap > SEAL_CLOCK_WARNING_SECONDS) {
    warnings.push(`The phone's own clock was ${minutes(clockGap)} off the satellites' time. The satellites' time is the one used.`);
  }
  if (!payload.networkTimeUtc) warnings.push("The phone had not seen Phoenix's clock since it was last switched on, so only the satellites' time was checked.");
  if (payload.developerOptions) warnings.push("Developer options are switched on in the phone.");
  if (payload.adb) warnings.push("USB debugging was switched on in the phone.");
  return warnings;
}
