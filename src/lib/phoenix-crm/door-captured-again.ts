/**
 * Phoenix CRM — "captured again at this door", the third reason "Approve it after all" stops (owner,
 * 14 Nov 2026, "Stop and say why"), asked BEFORE the button is drawn. Pure, no I/O.
 *
 * `phoenix_crm_restore_validation` refuses a take-back with `phoenix_crm:restore_door_captured_again` when
 * the customer already has ANOTHER ACTIVE place at the same door: in the same building, or within 150 m
 * of the rejected place. The board used to ask only "is the place still retired?", so it offered the
 * button on such a row and the Super Admin met the refusal only after pressing it (19 Nov 2026). This is
 * the same test, made on the board, so the row says so instead and offers nothing to press.
 *
 * 🔴 KEEP IT THE DATABASE'S TEST, WORD FOR WORD — another place of the same customer, active, and either
 * the same `shared_place_id` or within 150 m by the same great-circle formula, never rounded first. A
 * looser test here hides a take-back the database would allow; a tighter one draws a button it refuses.
 */

import { haversineKm } from "@/lib/pharmacy-search/geo";

/** The line the Google check draws round a door, as the restore function uses it. */
export const DOOR_CAPTURED_AGAIN_METERS = 150;

/** What the row says where "Approve it after all" would be. A fact, never a promise, and no name. */
export const DOOR_CAPTURED_AGAIN_TEXT =
  "Captured again at this door since the refusal. The place in use stands, so there is nothing to bring back.";

export type DoorPlace = {
  id: string;
  customerId: string;
  lat: number | null;
  lon: number | null;
  sharedPlaceId: string | null;
};

/**
 * Whether `place` (the rejected, retired one) has been captured again: another of `activePlaces` — the
 * customer's ACTIVE places — sits in the same building or within 150 m of it.
 */
export function doorCapturedAgain(place: DoorPlace, activePlaces: ReadonlyArray<DoorPlace>): boolean {
  return activePlaces.some((other) => {
    if (other.customerId !== place.customerId || other.id === place.id) return false;
    if (place.sharedPlaceId !== null && other.sharedPlaceId === place.sharedPlaceId) return true;
    if (place.lat === null || place.lon === null || other.lat === null || other.lon === null) return false;
    const meters = haversineKm({ latitude: place.lat, longitude: place.lon }, { latitude: other.lat, longitude: other.lon }) * 1000;
    return meters <= DOOR_CAPTURED_AGAIN_METERS;
  });
}
