import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEPARTURE_PHOTO_NO_GPS_NOTE, approverTripPhotos } from "../src/lib/outstation/trip-evidence-photos.ts";
import type { OutstationDepartureEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A departure photo on file with no GPS position says so to the approver, in three words.
//
// Owner, 2026-09-18, on Saad Salama's 1 September departure photo, saved with no position:
// "the system must record the reason". The approver saw only "Location unavailable". The same day
// the owner ruled "Refuse the photo" (#4007): a departure photo with no location is refused at
// capture and nothing is stored, so no new one can reach an approver. What is left is the one
// already on file, whose reason nothing recorded. It says only the fact, never a history or a guess.
// ─────────────────────────────────────────────────────────────────────────────

const PHOTOS_COMPONENT = "src/components/outstation/trip-evidence-photos.tsx";

/** Saad Salama's departure metadata as production holds it: no position, no reason. */
function saadDeparture(overrides: Partial<OutstationDepartureEvidenceMetadata> = {}): OutstationDepartureEvidenceMetadata {
  return {
    capturedAt: "2026-09-01T14:30:58.158Z",
    capturedLatitude: null,
    capturedLocationLabel: "Location unavailable",
    capturedLongitude: null,
    distanceFromArrivalKm: null,
    flags: [],
    minutesAfterArrival: 201,
    previousVersions: [],
    source: "live_camera",
    summary: "Departure photo captured distance from the arrival photo unknown, 201 minute(s) after it.",
    version: 1,
    ...overrides,
  };
}

function departurePhoto(meta: OutstationDepartureEvidenceMetadata | null, path: string | null = "departure/B-119/112.jpg") {
  const [, departure] = approverTripPhotos({
    carEvidenceImagePath: "car/B-119/arrival.jpg",
    carEvidenceImageUrl: "https://storage.example/arrival.jpg",
    carEvidenceMetadata: null,
    departureEvidenceImagePath: path,
    departureEvidenceImageUrl: path ? "https://storage.example/departure.jpg" : null,
    departureEvidenceMetadata: meta,
    employeeRole: "District Manager",
    evidenceGateStatus: "complete",
  });
  return departure;
}

export function runOutstationDepartureGpsReasonTests() {
  // ── Headline: Saad Salama's photo tells the approver there is no GPS ─────────────
  const saad = departurePhoto(saadDeparture());
  assert.equal(
    saad.gpsMissingReason,
    DEPARTURE_PHOTO_NO_GPS_NOTE,
    "a departure photo on file with no position tells the approver there is no GPS",
  );
  assert.equal(saad.locationLabel, null, "and not the bare 'Location unavailable' beside it");
  assert.ok(saad.url, "the photo itself is still shown");
  // Owner, 2026-09-18: "tell the short and the benefit only". The fact, no history, no guessed cause.
  assert.equal(DEPARTURE_PHOTO_NO_GPS_NOTE, "No GPS location.", "the note is the fact only, no story");

  // "No position" is the domain's own: half a pair and the old failed-fix 0,0 count too.
  assert.equal(
    departurePhoto(saadDeparture({ capturedLatitude: 0, capturedLongitude: 0 })).gpsMissingReason,
    DEPARTURE_PHOTO_NO_GPS_NOTE,
    "a photo stored at exactly 0,0 (the old failed-fix marker) has no GPS",
  );
  assert.equal(
    departurePhoto(saadDeparture({ capturedLatitude: 31.2 })).gpsMissingReason,
    DEPARTURE_PHOTO_NO_GPS_NOTE,
    "half a pair is no position",
  );

  // A photo WITH a position carries no note and keeps its place.
  const fixed = departurePhoto(
    saadDeparture({ capturedLatitude: 31.2, capturedLocationLabel: "Mahatet El Raml, Alexandria", capturedLongitude: 29.9 }),
  );
  assert.equal(fixed.gpsMissingReason, null, "a photo with a position has no missing-GPS note");
  assert.equal(fixed.locationLabel, "Mahatet El Raml, Alexandria", "and keeps its place label");

  // No photo, no note: a missing photo is its own note, not a GPS problem.
  assert.equal(departurePhoto(null, null).gpsMissingReason, null, "no departure photo means no GPS note");
  const [arrival] = approverTripPhotos({ departureEvidenceMetadata: saadDeparture() });
  assert.equal(arrival.gpsMissingReason, null, "the arrival photo never carries the departure note");

  // ── Both approver screens render it (they share one component) ───────────────────
  assert.match(
    stripComments(readFileSync(PHOTOS_COMPONENT, "utf8")),
    /\{photo\.gpsMissingReason\}/,
    "the photo component shows the missing-GPS note",
  );
}
