/**
 * A departure photo must carry the place it was taken.
 *
 * Owner ruling, 2026-09-18, asked in chat as multiple choice and answered "Refuse the photo": a
 * departure photo with no location is REFUSED, exactly as an arrival photo with no GPS already is
 * (car-evidence.ts). Nothing is stored. The employee turns location on and takes it again.
 *
 * Before this, a device that could not get a fix still submitted: the photo was stamped "no GPS
 * fix", its distance from the arrival photo was recorded as unknown, and no flag was raised, so it
 * cost the employee nothing. One production departure photo, captured 2026-09-01, is exactly that.
 *
 * This refuses the ABSENCE of a position only. A position that is far from the arrival photo, or
 * inaccurate, is still accepted and flagged, never blocked (departure-evidence.ts, owner
 * 2026-08-04). "No position" is what the domain already calls it: nothing, half a pair, or the
 * exact 0,0 a failed geolocation writes (captured-coordinates.ts). No range check is added.
 *
 * Pure and client-safe. The service calls it as the rule; the portal card and the Android app
 * refuse before they upload, which is courtesy, not the security boundary.
 */

import { usablePosition } from "@/lib/outstation/captured-coordinates";

/**
 * What the employee reads. It carries the word "required", which the departure-photo route maps
 * to a 400, so the refusal reaches the phone as this sentence and never as an opaque 500.
 */
export const DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE =
  "Your location is required for the departure photo, and this device did not report one. Turn on location for Phoenix, then take the photo again.";

/** The refusal for a departure photo with no usable position, or null when it has one. */
export function departurePhotoLocationRefusal(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string | null {
  return usablePosition(latitude, longitude) ? null : DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE;
}
