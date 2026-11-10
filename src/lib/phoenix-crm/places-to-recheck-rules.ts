/**
 * Phoenix CRM — the places worth a second look, with no I/O (owner, 2026-11-11, "Build all six fixes").
 *
 * WHY IT EXISTS. A place is captured once and fixed for good, and every visit afterwards is measured
 * against it — so a place saved in the wrong spot keeps refusing an honest rep until a person moves it.
 * The audit of 11 November 2026 found the evidence already sitting in the tables with nobody reading it:
 * 34 active places whose pin and photo reading were more than 250 m apart, 181 places behind 722 far
 * refusals since 20 October, and seated places visited again and again and never once at the building.
 * The held-visits page only ever showed a place after FIVE refusals in ONE day.
 *
 * This is the list the Super Admin and the SFE Manager read, and nothing here ever reaches the rep
 * (Golden Rule #1). It accuses nobody: each row says what the readings show and where the place may
 * belong, and a person decides.
 *
 * A place lands on it for any of three reasons:
 *   - `readings_apart`   — its pin and its photo reading cannot both be the door (`readingsApartMeters`,
 *                          the same rule that now refuses such a capture at the door);
 *   - `refused_one_spot` — three or more sharp far refusals in the last 30 days from one tight spot;
 *   - `never_inside`     — two or more visits measured against it in the last 30 days, none inside its line.
 *
 * 🔴 A PLACE A PERSON HAS ALREADY MOVED OR PUT ON A TRUSTED POINT IS NOT LISTED FOR ITS READINGS, and a
 * refusal or a visit from BEFORE its move says nothing about where it sits now — both are left out, or the
 * list would keep asking about a place somebody already answered.
 */

import {
  RECHECK_MIN_FAR_VISITS,
  RECHECK_MIN_TRIES,
  readingsApartMeters,
  stuckAtOneSpot,
  type FarTry,
} from "@/lib/phoenix-crm/far-visit-safeguards";
import { distanceMeters } from "@/lib/phoenix-crm/geo";

export type RecheckReason = "readings_apart" | "refused_one_spot" | "never_inside";

/** An active place as the list reads it. */
export type RecheckPlace = {
  id: string;
  customerId: string;
  seatId: string;
  lat: number;
  lon: number;
  pinLat: number | null;
  pinLon: number | null;
  pinAccuracyMeters: number | null;
  photoLat: number | null;
  photoLon: number | null;
  photoAccuracyMeters: number | null;
  /** `photo` when the place is fixed on the photo's reading; anything else is the pin. */
  pointSource: string | null;
  /** When a person moved it, or null. */
  movedAt: string | null;
  /** Set when a person placed it on a trusted point. */
  trusted: boolean;
};

/** One far refusal of a visit, with the place it was measured to. */
export type RecheckRefusal = FarTry & { placeId: string | null; refusedAt: string };

/** One saved visit that was measured against a place. */
export type RecheckVisit = { placeId: string | null; far: boolean; capturedAt: string | null };

export type RecheckFinding = {
  reason: RecheckReason;
  /** Metres: between the two readings, or from the spot to the saved place. Null for `never_inside`. */
  metres: number | null;
  /** How many refusals sit at the spot, or how many visits were measured. Null for `readings_apart`. */
  count: number | null;
};

export type PlaceToRecheck = {
  placeId: string;
  customerId: string;
  seatId: string;
  findings: RecheckFinding[];
  /** Where the place may belong, when the readings point at one spot; null when they do not. */
  candidate: { lat: number; lon: number } | null;
  /** What `candidate` is, in words the page prints beside its marker. */
  candidateLabel: string | null;
};

function sinceMove(place: RecheckPlace, at: string | null): boolean {
  if (!place.movedAt) return true;
  return typeof at === "string" && at > place.movedAt;
}

/**
 * The list, most refused first. Pure, so the page and the nightly check can never disagree about which
 * places are on it.
 */
export function placesToRecheck(input: {
  places: readonly RecheckPlace[];
  refusals: readonly RecheckRefusal[];
  visits: readonly RecheckVisit[];
}): PlaceToRecheck[] {
  const refusalsByPlace = new Map<string, RecheckRefusal[]>();
  for (const refusal of input.refusals) {
    if (!refusal.placeId) continue;
    const held = refusalsByPlace.get(refusal.placeId) ?? [];
    held.push(refusal);
    refusalsByPlace.set(refusal.placeId, held);
  }
  const visitsByPlace = new Map<string, RecheckVisit[]>();
  for (const visit of input.visits) {
    if (!visit.placeId) continue;
    const held = visitsByPlace.get(visit.placeId) ?? [];
    held.push(visit);
    visitsByPlace.set(visit.placeId, held);
  }

  const out: PlaceToRecheck[] = [];
  for (const place of input.places) {
    const findings: RecheckFinding[] = [];
    let candidate: PlaceToRecheck["candidate"] = null;
    let candidateLabel: string | null = null;

    const spot = stuckAtOneSpot((refusalsByPlace.get(place.id) ?? []).filter((refusal) => sinceMove(place, refusal.refusedAt)));
    if (spot.centre && spot.tries >= RECHECK_MIN_TRIES) {
      findings.push({ reason: "refused_one_spot", metres: distanceMeters(spot.centre, place), count: spot.tries });
      candidate = spot.centre;
      candidateLabel = "Where the rep stood";
    }

    if (!place.movedAt && !place.trusted) {
      const pinLat = place.pinLat ?? place.lat;
      const pinLon = place.pinLon ?? place.lon;
      const apart = readingsApartMeters({
        lat: pinLat,
        lon: pinLon,
        accuracyMeters: place.pinAccuracyMeters,
        photoLat: place.photoLat,
        photoLon: place.photoLon,
        photoAccuracyMeters: place.photoAccuracyMeters,
      });
      if (apart !== null && place.photoLat !== null && place.photoLon !== null) {
        findings.push({ reason: "readings_apart", metres: apart, count: null });
        if (!candidate) {
          // The reading the place is NOT fixed on is the other candidate for the door.
          const onPhoto = place.pointSource === "photo";
          candidate = onPhoto ? { lat: pinLat, lon: pinLon } : { lat: place.photoLat, lon: place.photoLon };
          candidateLabel = onPhoto ? "The Capture location pin" : "The photo's own reading";
        }
      }
    }

    const measured = (visitsByPlace.get(place.id) ?? []).filter((visit) => sinceMove(place, visit.capturedAt));
    if (measured.length >= RECHECK_MIN_FAR_VISITS && measured.every((visit) => visit.far)) {
      findings.push({ reason: "never_inside", metres: null, count: measured.length });
    }

    if (findings.length > 0) {
      out.push({ placeId: place.id, customerId: place.customerId, seatId: place.seatId, findings, candidate, candidateLabel });
    }
  }
  const weight = (entry: PlaceToRecheck) =>
    entry.findings.reduce((most, finding) => Math.max(most, finding.reason === "refused_one_spot" ? 1000 + (finding.count ?? 0) : finding.reason === "readings_apart" ? 500 : 100), 0);
  return out.sort((a, b) => weight(b) - weight(a) || a.placeId.localeCompare(b.placeId));
}

function distanceWords(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}

/** One finding in plain English, for the SFE. Never an accusation: what the readings show. */
export function recheckSentence(finding: RecheckFinding, lookbackDays: number): string {
  if (finding.reason === "readings_apart") {
    return `The Capture location pin and the photo's own reading are ${distanceWords(finding.metres ?? 0)} apart, so one of them is not the door.`;
  }
  if (finding.reason === "refused_one_spot") {
    const away = finding.metres === null ? "away from" : `${distanceWords(finding.metres)} from`;
    return `Visits were refused ${finding.count ?? 0} times in the last ${lookbackDays} days from one spot, ${away} the saved place.`;
  }
  return `${finding.count ?? 0} visits in the last ${lookbackDays} days were measured against this place and none was inside its line.`;
}
