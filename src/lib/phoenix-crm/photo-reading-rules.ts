/**
 * Phoenix CRM — which reading the live camera keeps as the photo's own when two of its readings cannot
 * both be where the phone stood. No I/O: the camera (live-photo-capture.tsx) asks, the test pins it.
 *
 * WHAT HAPPENED (validated 20 Oct 2026, found 22 Oct). Dr Tharwat Milad's clinic in Dishna. The camera's
 * reading put the signboard photo in Faw Bahari, 10,070 m west, claiming ±65 m; the Capture-location pin
 * the same phone took FIVE SECONDS later read Dishna at ±20 m. Nobody covers 10 km in five seconds, so
 * one of the two was not where the phone was, and the photo's was the wrong one: the previous rep's two
 * April check-ins at this doctor in the old CRM sit 242 m and 273 m from the pin. The integrity board read
 * it as its strongest finding, a photo and a pin in different parts of the city, against a rep who had
 * stood at the door.
 *
 * WHY A PHONE DOES THIS. A location receiver that has just been switched on answers first from nearby
 * networks (Wi-Fi routers and cell towers looked up in a database) and only later from the satellites. A
 * network answer can land kilometres from the phone while claiming tens of metres: a router that moved
 * house is still filed at its old address. The camera switched its receiver on as it opened, enabled the
 * shutter on the first answer, and kept that answer, because the fresh reading taken at the shutter
 * replaced it only when it claimed to be SHARPER.
 *
 * THE RULE. Two readings CONTRADICT when they sit further apart than both of their claimed accuracies
 * together, and never on less than CONTRADICTION_FLOOR_METERS, so two honest readings a doorway apart never
 * do. When the kept reading arrived while the receiver was still COLD (its first COLD_RECEIVER_MS), a later
 * reading that contradicts it wins, whatever accuracy it claims: the cold one is the network's guess. When
 * the kept reading arrived on a warm receiver nothing here decides, and the sharper one stays exactly as
 * before. So the photo's reading changes only in the one shape that produced the Faw Bahari photo.
 *
 * 🔴 It never holds the shutter, never refuses a photo and never tells the rep anything (Golden Rule #1):
 * it only chooses between two readings the camera already had.
 */

import { PLACE_MAX_ACCURACY_METERS } from "@/lib/phoenix-crm/entry-rules";
import { distanceMeters } from "@/lib/phoenix-crm/geo";

/**
 * Two readings closer than this never contradict, whatever accuracies they claim. The place's own
 * accuracy line, so a gap the validation itself would accept is never treated as a contradiction.
 */
export const CONTRADICTION_FLOOR_METERS = PLACE_MAX_ACCURACY_METERS;

/**
 * How long a freshly switched-on receiver is treated as cold. A phone with assisted GPS usually locks in
 * 5-15 s outdoors, and a cold start can take half a minute; past this the receiver has had its chance.
 */
export const COLD_RECEIVER_MS = 30_000;

/**
 * One reading as the camera holds it. `arrivedAt` is when THIS PAGE received it (`Date.now()`), never the
 * phone's own `position.timestamp`, which some handsets stamp from another clock, so the two can be
 * compared with the moment the receiver was started.
 */
export type CameraReading = { lat: number; lon: number; accuracyMeters: number | null; arrivedAt: number };

/** Further apart than both claimed accuracies together, and further than the floor: not both true. */
export function readingsContradict(a: CameraReading, b: CameraReading): boolean {
  const apart = distanceMeters(a, b);
  return apart > Math.max(CONTRADICTION_FLOOR_METERS, (a.accuracyMeters ?? 0) + (b.accuracyMeters ?? 0));
}

/**
 * Whether a reading arrived while the receiver was still cold. No known start, or no usable arrival
 * time, counts as cold: the camera always records its own start, so that is a reading nothing vouches for.
 */
export function takenCold(reading: Pick<CameraReading, "arrivedAt">, receiverRunningSince: number | null): boolean {
  if (receiverRunningSince === null || !Number.isFinite(receiverRunningSince) || !Number.isFinite(reading.arrivedAt)) return true;
  return reading.arrivedAt - receiverRunningSince < COLD_RECEIVER_MS;
}

/** Does a later reading overrule the kept one? Only when the kept one arrived cold AND the two contradict. */
export function laterReadingOverrules(kept: CameraReading, later: CameraReading, receiverRunningSince: number | null): boolean {
  return takenCold(kept, receiverRunningSince) && readingsContradict(kept, later);
}
