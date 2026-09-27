/**
 * Phoenix CRM — one place of a customer as the rep fills it in on the phone: the live photo, the days
 * and hours, and the place's name. The location is NOT here.
 *
 * The pure half of the web `place-editor.tsx` (emptyPlaceDraft, placeDraftProblem, placePayload,
 * ramadanHoursNote), transcribed so the phone names a gap before the save leaves and builds the same
 * body the routes read. Owner, 2026-09-23: the address, the part of town and the brick are resolved on
 * the server from the captured coordinates and frozen — the phone never sends them, and an edit reaches
 * only the place's name and its days and hours.
 */

import { dayLabelWithYear } from "@/lib/crm/format";
import type { CrmCapturedPhoto, CrmStoredPhoto } from "@/lib/crm/photo";
import { parseTimings, timingsToDrafts } from "@/lib/crm/timings";
import type { CrmTiming, PlacePayload } from "@/lib/crm/types";

export type PlaceDraftState = {
  photo: CrmCapturedPhoto | null;
  label: string;
  timings: CrmTiming[];
};

export function emptyPlaceDraft(): PlaceDraftState {
  return { photo: null, label: "", timings: [] };
}

/** The server's own checks, so a gap is named before the save leaves the phone. */
export function placeDraftProblem(draft: PlaceDraftState, options: { needsPhoto: boolean }): string | null {
  if (options.needsPhoto && !draft.photo) return "Take a live photo of the clinic sign or door.";
  const checked = parseTimings(timingsToDrafts(draft.timings));
  return checked.ok ? null : checked.error;
}

/**
 * The place as /api/phoenix-crm/list/validate and /list/places read it: the photo, the raw fix, the
 * name and the timings. No address, no part of town, no brick — the server resolves the whole location
 * from these coordinates and writes it once (owner, 2026-09-23).
 */
export function placePayload(photo: CrmStoredPhoto, draft: PlaceDraftState): PlacePayload {
  return {
    photoPath: photo.path,
    lat: photo.lat,
    lon: photo.lon,
    accuracyMeters: photo.accuracyMeters,
    deviceCapturedAt: photo.deviceCapturedAt,
    deviceMocked: photo.deviceMocked,
    label: draft.label.trim() || null,
    timings: timingsToDrafts(draft.timings),
  };
}

/** "Ramadan runs Mon 8 Feb 2027 to Mon 8 Mar 2027 …" for the timings editor. */
export function ramadanHoursNote(ramadan: { startsOn: string; endsOn: string } | null, cairoToday: string): string | null {
  if (!ramadan) return null;
  const inForce = cairoToday >= ramadan.startsOn && cairoToday <= ramadan.endsOn;
  return `${inForce ? "Ramadan runs" : "The next Ramadan runs"} ${dayLabelWithYear(ramadan.startsOn)} to ${dayLabelWithYear(
    ramadan.endsOn,
  )}. Ramadan hours are used on those days.`;
}
