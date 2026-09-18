/**
 * Reading a GPS position off an outstation request body — the one reader every outstation route
 * uses, for the arrival capture, the departure photo and the destination an admin types in on an
 * employee's behalf alike.
 *
 * Deliberately NOT `Number(body.capturedLatitude)`. `Number(null)`, `Number("")` and `Number(" ")`
 * are all 0, which is finite, so a client with no GPS fix sailed past every `Number.isFinite`
 * check and was stored at 0°N 0°E, in the Gulf of Guinea. Only a real number or a non-blank
 * numeric string is a coordinate here; each value is read by src/lib/geo/coordinate-input.ts,
 * which direct orders shares.
 *
 * What "no position" MEANS is the caller's decision, not this module's: the departure photo is
 * optional and records its distance as unknown (the owner flags that photo, never blocks it),
 * the arrival location is required and its routes refuse with "Captured coordinates are
 * required.", and an admin edit refuses with "Provided destination must have valid coordinates."
 *
 * Pure, so a route can call it before it touches the database.
 */

import { readCoordinateInput } from "@/lib/geo/coordinate-input";

export type CapturedPosition = { latitude: number; longitude: number };

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A usable position, or null. Both halves must be finite numbers, and the exact pair 0,0 is no
 * position at all: it is what a failed browser geolocation writes, never a real Egyptian capture
 * (the same rule captured-location.ts applies before resolving a brick). A single 0 on its own is
 * still a real coordinate and passes.
 */
export function usablePosition(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): CapturedPosition | null {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat == null || lon == null) return null;
  if (lat === 0 && lon === 0) return null;
  return { latitude: lat, longitude: lon };
}

/**
 * The position a client posted, or null when it posted none. The web wizard sends nulls when the
 * browser has no fix and the Android app leaves the keys out; both read as null. Half a pair is
 * no position either, and is dropped whole rather than half-stored.
 */
export function readCapturedPosition(latitude: unknown, longitude: unknown): CapturedPosition | null {
  return usablePosition(readCoordinateInput(latitude), readCoordinateInput(longitude));
}
