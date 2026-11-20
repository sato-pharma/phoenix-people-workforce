/**
 * Phoenix CRM — the Super Admin validates a customer for a rep with a PHOTO HE UPLOADS (owner, 2026-11-20).
 *
 * His words: "must have a photo except i tell u", then "the system administrator can validate for someone and
 * upload a photo manually instead of the live", then "make a button for me to press on watch the rep while
 * capturing location. And then while this button is on, the rep will capture the location. You will capture his
 * location and put it here."
 *
 * So a place validated this way is two things and never one: the photo the Super Admin uploaded, and the REP'S
 * OWN live GPS reading, taken at the clinic while the Super Admin's watch is on. Nothing is validated without
 * both. The pure half lives here (no database, no browser) so the test can hold every rule; the server half is
 * server/admin-photo.ts.
 */

import { PLACE_MAX_ACCURACY_METERS } from "@/lib/phoenix-crm/entry-rules";

/** How long one press of "Watch the rep" stays on — long enough to phone the rep and for him to step outside. */
export const ADMIN_PHOTO_WATCH_MINUTES = 30;

/** How often the Super Admin's screen asks whether the rep's reading has arrived while the watch is on. */
export const ADMIN_PHOTO_POLL_SECONDS = 5;

export type AdminPhotoStatus = "watching" | "captured" | "validated" | "cancelled";

/** A watch is open to the rep's reading while it is watching or captured and its time has not run out. */
export function adminPhotoWatchIsOpen(row: { status: string; watchUntil: string | null }, nowMs: number = Date.now()): boolean {
  if (row.status !== "watching" && row.status !== "captured") return false;
  const until = row.watchUntil ? Date.parse(row.watchUntil) : Number.NaN;
  return Number.isFinite(until) && until > nowMs;
}

/** When a watch pressed at `nowMs` ends. */
export function adminPhotoWatchUntil(nowMs: number = Date.now()): string {
  return new Date(nowMs + ADMIN_PHOTO_WATCH_MINUTES * 60 * 1000).toISOString();
}

export type AdminPhotoReading = { lat: number; lon: number; accuracyMeters: number | null };

/**
 * Why the rep's reading cannot stand as a validated place, in words about his own phone — never a person, never
 * a check (golden rule #1). The same line a validation at the door holds: a known accuracy within
 * `PLACE_MAX_ACCURACY_METERS`. An UNKNOWN accuracy is refused here, unlike a pharmacy's pin, because this reading
 * becomes the place every later visit is measured from.
 */
export function adminPhotoReadingProblem(reading: { lat: unknown; lon: unknown; accuracyMeters: unknown }): string | null {
  const lat = Number(reading.lat);
  const lon = Number(reading.lon);
  if (reading.lat === null || reading.lon === null || reading.lat === "" || reading.lon === "") return "The location did not come. Press Capture location again.";
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
    return "The location did not come. Press Capture location again.";
  }
  const accuracy = reading.accuracyMeters === null || reading.accuracyMeters === undefined || reading.accuracyMeters === "" ? Number.NaN : Number(reading.accuracyMeters);
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > PLACE_MAX_ACCURACY_METERS) {
    return `The location needs to be accurate, within ${PLACE_MAX_ACCURACY_METERS} m. Turn on precise location in the phone's settings; if it is already on, step outside the building and wait a few seconds, then press Capture location again at the clinic.`;
  }
  return null;
}

const CAIRO_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Africa/Cairo",
});

/** An instant as the Super Admin reads it: Cairo time, "20 Nov, 14:05". Empty for no instant. */
export function adminPhotoTimeText(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? CAIRO_TIME.format(new Date(ms)) : "";
}
