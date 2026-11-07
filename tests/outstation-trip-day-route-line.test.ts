import assert from "node:assert/strict";
import { join } from "node:path";

import { approverTripRoute, dayRouteLine } from "../src/lib/outstation/day-route-line.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// The Expense Approvals day maps draw the route, not loose dots (owner, 2026-11-07: "on map now only
// appears a dot but doesn't appear خط السير").
//
// THE HOLE. Each day's map pinned the arrival and departure photos, the journey stops and the GPS
// check-ins, but joined only the check-ins, and was handed `route={null}`. A day whose points were a
// photo and a stop — Weaam Gweed's 5 Oct train trip from Sohag had no check-in at all — was a dot or
// two with no line, though 237 of the 296 trips store their road route from home when priced.
//
// WHY THE SHAPE. The order and the route chosen are pure and pinned on behaviour; the wiring that
// carries them to Google Maps cannot run here, so it is pinned on comment-stripped source.

const ROOT = process.cwd();

function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

export function runOutstationTripDayRouteLineTests() {
  // -- the day's line, in the order it happened ----------------------------------------------------
  // A CRM check-in's time is Cairo wall clock with no offset; a photo's is a real instant. Cairo is
  // on summer time on 5 Oct 2026 (UTC+3), so the arrival photo at 07:30Z is 10:30 Cairo — read raw it
  // would sort before the 09:00 check-in.
  const line = dayRouteLine(
    [
      { checkDate: "2026-10-05T11:00:00", lat: 30.1, lon: 31.4 },
      { checkDate: "2026-10-05T09:00:00", lat: 30.0, lon: 31.3 },
      { checkDate: "2026-10-05T10:00:00", lat: null, lon: null },
    ],
    [
      { at: "2026-10-05T07:30:00.000Z", lat: 26.5, lon: 31.7 },
      { at: "2026-10-05T13:00:00.000Z", lat: 30.2, lon: 31.5 },
      { at: null, lat: 29.0, lon: 31.0 },
    ],
  );
  assert.deepEqual(
    line,
    [
      { lat: 30.0, lng: 31.3 },
      { lat: 26.5, lng: 31.7 },
      { lat: 30.1, lng: 31.4 },
      { lat: 30.2, lng: 31.5 },
    ],
    "HEADLINE: check-ins, photos and stops join in the order they happened, each read on Cairo's clock",
  );
  assert.equal(line.length, 4, "a point with no position or no time is pinned, never guessed into the line");
  assert.deepEqual(dayRouteLine([], [{ at: "2026-10-05T07:30:00.000Z", lat: 1, lon: 2 }]), [{ lat: 1, lng: 2 }]);

  // -- the trip's own road route --------------------------------------------------------------------
  const base = {
    distanceFromResidenceKm: 518,
    residenceArea: "Sohag 1",
    residenceCity: "Sohag",
    residenceLatitude: 26.55,
    residenceLongitude: 31.69,
    routePolyline: "stored_line",
  };
  const stored = approverTripRoute(base);
  assert.equal(stored?.encodedPolyline, "stored_line", "HEADLINE: the stored route reaches the map");
  assert.equal(stored?.distanceKm, 518);
  assert.deepEqual(stored?.home, { label: "Sohag 1, Sohag", lat: 26.55, lon: 31.69 }, "the route starts at home");
  assert.equal(
    approverTripRoute({
      ...base,
      routeAlternatives: [
        { distanceKm: 530, encodedPolyline: "other", isSelected: false },
        { distanceKm: 521, encodedPolyline: "chosen", isSelected: true },
      ],
    })?.encodedPolyline,
    "chosen",
    "the route chosen when the claim was priced wins over the stored fallback",
  );
  assert.equal(approverTripRoute({ ...base, routePolyline: null }), null, "no stored route, nothing drawn");
  assert.equal(approverTripRoute({ ...base, routePolyline: "  " }), null);
  assert.equal(approverTripRoute({ ...base, residenceLatitude: null })?.home, null, "no home pin without home coordinates");

  // -- the wiring -----------------------------------------------------------------------------------
  const route = code("app/api/admin/outstation/[id]/attachments/route.ts");
  assert.match(route, /tripRoute: approverTripRoute\(requestRow\)/, "the attachments read sends the trip's route");

  const map = code("src/components/field-workforce-compliance/field-workforce-route-map.tsx");
  assert.match(map, /const tripPath = tripRoute\?\.encodedPolyline \? decodePolyline\(tripRoute\.encodedPolyline\) : \[\];/);
  assert.match(map, /path: tripPath,/, "the map draws the trip's route as its own line");
  assert.match(map, /markers\.some\(\(marker\) => marker\.at\) \? dayRouteLine\(points, markers\) : null/, "timed pins join the day's line");

  const review = code("src/components/outstation/expense-approvals/trip-review.tsx");
  assert.equal((review.match(/tripRoute=\{routeFor\(/g) ?? []).length, 2, "both day-map mounts receive the trip's route");
  assert.match(review, /dayKey === firstDay \|\| dayKey === lastDay/, "the way out and back: first and last day");
  assert.match(review, /\{ at: photo\.capturedAt \?\? null, id: photo\.kind/, "a photo pin carries its time");
  assert.match(review, /at: stop\.capturedAt,/, "a stop pin carries its time");
}
