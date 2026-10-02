/**
 * Phoenix CRM — "Directions" to a customer's SAVED place, with no I/O.
 *
 * Owner, 2026-10-02: a rep standing outside one clinic needs the way to the next one, and the place
 * is already on file — validated once, fixed for good (the photo's reading, else the pin; see
 * `placePoint` in entry-rules.ts). So every screen that names the customer he is about to see — the
 * visit flow's customer card, the visit form's header and his planned day on the landing page —
 * carries one link that opens Google Maps with that place as the DESTINATION.
 *
 *   - The destination only. No origin is written: the maps app on his phone works out where he is
 *     by itself, so Phoenix reads nothing about him to build the link and stores nothing either.
 *   - No key and no paid service (the owner's standing rule: never buy a map API). It is a plain
 *     link — `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lon>` — in a new tab.
 *   - A place with no usable point gets NO link at all, never a link to nowhere: a customer not
 *     validated yet has no place, and a (0, 0) reading is not a clinic.
 *
 * GOLDEN RULE #1: this is the way to HIS OWN customer, his own work. It carries no reading of his
 * position, no comparison and nothing that checks him.
 */

import { isUsableFix } from "@/lib/phoenix-crm/geo";

/** Google Maps' public directions address — the destination is appended. */
export const DIRECTIONS_BASE_URL = "https://www.google.com/maps/dir/?api=1&destination=";

/** What the link needs from a place: its fixed point. */
export type DirectionsPoint = { lat: unknown; lon: unknown };

/** Six decimals is about 11 cm on the ground — the address stays short and loses nothing a door needs. */
function coordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** The directions link to a saved place, or null when it has no usable point. */
export function directionsUrl(point: DirectionsPoint | null | undefined): string | null {
  if (!point || !isUsableFix(point.lat, point.lon)) return null;
  return `${DIRECTIONS_BASE_URL}${coordinate(Number(point.lat))},${coordinate(Number(point.lon))}`;
}

/**
 * Which of his places the link opens: the first that receives today, else the first with a usable
 * point. A customer has at most five places and usually one; with two (a morning hospital, an evening
 * clinic) the one he can actually be seen at today is the one worth driving to.
 */
export function directionsPlace<T extends DirectionsPoint>(places: readonly T[], receivesToday: (place: T) => boolean = () => false): T | null {
  const usable = places.filter((place) => directionsUrl(place) !== null);
  return usable.find(receivesToday) ?? usable[0] ?? null;
}
