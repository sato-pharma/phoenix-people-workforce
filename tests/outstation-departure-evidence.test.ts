import assert from "node:assert/strict";
import {
  cairoDateOnly,
  isWithinDepartureWindow,
  reviewDepartureEvidence,
} from "../src/lib/outstation/departure-evidence.ts";

/**
 * The departure photo's review rules (owner decisions, 2026-08-04):
 *   - distance from the arrival photo is FLAGGED, never blocking;
 *   - the window closes at the end of the trip's last day, Africa/Cairo.
 */
export function runOutstationDepartureEvidenceTests() {
  // Cairo, and ~200km away in Alexandria.
  const cairo = { lat: 30.0444, lon: 31.2357 };
  const alexandria = { lat: 31.2001, lon: 29.9187 };

  const ordinary = reviewDepartureEvidence({
    arrivalCapturedAt: "2026-10-17T06:00:00.000Z",
    arrivalLatitude: cairo.lat,
    arrivalLongitude: cairo.lon,
    departureCapturedAt: "2026-10-17T14:00:00.000Z",
    // ~1.5 km away — moving around the destination during the day.
    departureLatitude: cairo.lat + 0.012,
    departureLongitude: cairo.lon + 0.005,
    tripEndDate: "2026-10-17",
  });
  assert.deepEqual(ordinary.flags, [], "a normal day at the destination raises nothing");
  assert.equal(ordinary.isWithinTripWindow, true, "captured on the trip's last day is inside the window");
  assert.ok(
    ordinary.distanceFromArrivalKm != null && ordinary.distanceFromArrivalKm < 5,
    "moving around one city stays under the review threshold",
  );

  // ── Flagged, NOT rejected — the owner chose advisory over blocking ──────────────
  const farAway = reviewDepartureEvidence({
    arrivalCapturedAt: "2026-10-17T06:00:00.000Z",
    arrivalLatitude: cairo.lat,
    arrivalLongitude: cairo.lon,
    departureCapturedAt: "2026-10-17T14:00:00.000Z",
    departureLatitude: alexandria.lat,
    departureLongitude: alexandria.lon,
    tripEndDate: "2026-10-17",
  });
  assert.ok(farAway.flags.includes("far_from_arrival"), "a photo taken 200km away is flagged");
  assert.ok(
    farAway.distanceFromArrivalKm != null && farAway.distanceFromArrivalKm > 150,
    "and the real distance is reported, not just a boolean",
  );
  assert.match(farAway.summary, /Review:/, "the admin queue line must lead with Review");

  const bothAtOnce = reviewDepartureEvidence({
    arrivalCapturedAt: "2026-10-17T06:00:00.000Z",
    arrivalLatitude: cairo.lat,
    arrivalLongitude: cairo.lon,
    departureCapturedAt: "2026-10-17T06:02:00.000Z",
    departureLatitude: cairo.lat,
    departureLongitude: cairo.lon,
    tripEndDate: "2026-10-17",
  });
  assert.ok(
    bothAtOnce.flags.includes("too_soon_after_arrival"),
    "both photos taken two minutes apart evidence nothing and must be flagged",
  );

  // A departure stamped BEFORE the arrival is a clock or tampering problem — it must not slip
  // through as an ordinary pair just because the arithmetic goes negative.
  const timeTravel = reviewDepartureEvidence({
    arrivalCapturedAt: "2026-10-17T14:00:00.000Z",
    arrivalLatitude: cairo.lat,
    arrivalLongitude: cairo.lon,
    departureCapturedAt: "2026-10-17T06:00:00.000Z",
    departureLatitude: cairo.lat,
    departureLongitude: cairo.lon,
    tripEndDate: "2026-10-17",
  });
  assert.ok(
    timeTravel.flags.includes("too_soon_after_arrival"),
    "a departure photo older than the arrival photo must be flagged, not treated as an 8-hour gap",
  );

  // ── The window closes at the end of the trip's last Cairo day ───────────────────
  assert.equal(
    isWithinDepartureWindow({ capturedAt: "2026-10-17T20:00:00.000Z", tripEndDate: "2026-10-17" }),
    true,
    "23:00 Cairo on the last day is still inside the window",
  );
  assert.equal(
    isWithinDepartureWindow({ capturedAt: "2026-10-18T06:00:00.000Z", tripEndDate: "2026-10-17" }),
    false,
    "the morning after the trip's last day is outside it — a Super Admin must release the request",
  );

  // Egypt observes DST again since 2023, so Cairo is UTC+2 in winter and UTC+3 in summer. A
  // fixed-offset implementation mis-dates captures near midnight for half the year; these two
  // pin both sides of the year.
  assert.equal(
    cairoDateOnly("2026-10-17T21:30:00.000Z"),
    "2026-10-18",
    "21:30 UTC in October is already the next day in Cairo (UTC+3 under summer time)",
  );
  assert.equal(
    cairoDateOnly("2026-01-17T22:30:00.000Z"),
    "2026-01-18",
    "22:30 UTC in January is the next day in Cairo (UTC+2 in winter)",
  );
  assert.equal(
    isWithinDepartureWindow({ capturedAt: "2026-10-17T21:30:00.000Z", tripEndDate: "2026-10-17" }),
    false,
    "a capture that is already tomorrow in CAIRO is outside the window, even though it is still the 17th in UTC",
  );

  // ── Unknown inputs must not manufacture a late verdict ──────────────────────────
  assert.equal(
    isWithinDepartureWindow({ capturedAt: "2026-10-17T10:00:00.000Z", tripEndDate: null }),
    true,
    "a missing trip end date is OUR data problem — it must not demand an admin release from the employee",
  );

  const unknownGps = reviewDepartureEvidence({
    arrivalCapturedAt: "2026-10-17T06:00:00.000Z",
    arrivalLatitude: null,
    arrivalLongitude: null,
    departureCapturedAt: "2026-10-17T14:00:00.000Z",
    departureLatitude: cairo.lat,
    departureLongitude: cairo.lon,
    tripEndDate: "2026-10-17",
  });
  assert.equal(unknownGps.distanceFromArrivalKm, null, "an unusable coordinate yields null, never 0 km");
  assert.ok(
    !unknownGps.flags.includes("far_from_arrival"),
    "and must not be flagged as far away — unknown is not the same as distant",
  );
  assert.match(unknownGps.summary, /unknown/i, "the summary says the distance is unknown rather than implying zero");
}
