import assert from "node:assert/strict";

import {
  EGYPT_CHECKIN_BOUNDS,
  isPlausibleCheckinCoordinate,
  sanitizeCheckinCoordinates,
} from "../src/lib/crm/checkin-coords.ts";
import { CRM_VISIT_COLUMNS } from "../src/lib/crm/master.ts";

// The production incident this pins, verified against the live mirror 2026-08-21:
// crm_checkin_id 472272, rep B-140. The rep checked in from Asyut at 15:23 Cairo, from "Najaf,
// Iraq" at 17:05, and from Asyut again at 18:23 — 1,300km each way, i.e. ~760km/h out and
// ~1,000km/h back. A lost satellite fix, not a business trip. It mattered because check-in
// matching keys on rep + contact + day and NOT on distance, so the bad fix stood as GPS
// proof-of-presence for that visit.
const NAJAF_GLITCH = { lat: 32.0008354, lon: 44.3697281 };

// Real Egyptian check-ins — the first three are the same rep's own fixes from the same three days,
// and the last four are the extremes of the entire 105,413-row production mirror. None may ever be
// rejected; a guard with false positives here would delete real proof that a rep did the work.
const REAL_EGYPTIAN_FIXES = [
  { label: "Asyut city", lat: 27.17861, lon: 31.1895 },
  { label: "Manfalut", lat: 27.31218, lon: 30.9648 },
  { label: "El Qusiya", lat: 27.44083, lon: 30.82626 },
  { label: "northernmost of the live mirror", lat: 31.8, lon: 31.0 },
  { label: "southernmost of the live mirror", lat: 21.9, lon: 31.0 },
  { label: "westernmost of the live mirror", lat: 27.0, lon: 24.6 },
  { label: "easternmost of the live mirror", lat: 27.0, lon: 37.0 },
];

// Each of these violates EXACTLY ONE bound, so breaking any single bound fails a named assertion.
// Without them the Najaf case alone proves almost nothing: its latitude (32.0008) clears maxLat by
// 0.0008°, so widening maxLon from 37.5 all the way to 50 still left the suite green — the real 7°
// longitude violation was never the thing being tested. Caught by deliberately breaking the guard.
const SINGLE_BOUND_VIOLATIONS = [
  { label: "Najaf's longitude at a valid Egyptian latitude (maxLon)", lat: 27.0, lon: 44.3697281 },
  { label: "the Mediterranean north of the Delta (maxLat)", lat: 32.5, lon: 31.0 },
  { label: "Sudan, south of Lake Nasser (minLat)", lat: 20.5, lon: 31.0 },
  { label: "Libya, west of the Western Desert (minLon)", lat: 27.0, lon: 22.5 },
];

export function runCrmCheckinCoordGuardTests() {
  // The headline assertion: the Najaf reading is refused.
  assert.equal(
    isPlausibleCheckinCoordinate(NAJAF_GLITCH.lat, NAJAF_GLITCH.lon),
    false,
    "the Najaf GPS glitch (crm_checkin_id 472272) must be rejected as an impossible check-in position",
  );

  // Every bound must be load-bearing on its own.
  for (const violation of SINGLE_BOUND_VIOLATIONS) {
    assert.equal(
      isPlausibleCheckinCoordinate(violation.lat, violation.lon),
      false,
      `${violation.label} — (${violation.lat}, ${violation.lon}) is outside Egypt and must be rejected`,
    );
  }

  // Rejecting it must take the address with it. The vendor sent `address: ""` — "Najaf, Iraq" was
  // Phoenix's OWN reverse-geocode of the broken reading, so it is exactly as wrong as the reading.
  const rejected = sanitizeCheckinCoordinates(
    NAJAF_GLITCH.lat,
    NAJAF_GLITCH.lon,
    "2929+8VQ، شارع ثابت، Najaf, Najaf Governorate, Iraq",
  );
  assert.equal(rejected.lat, null, "a rejected coordinate must null lat");
  assert.equal(rejected.lon, null, "a rejected coordinate must null lon");
  assert.equal(rejected.address, null, "an address geocoded FROM a rejected coordinate must go with it");
  assert.equal(rejected.rejected, true, "a rejection must report itself, or the sync cannot log it");

  // No false positives on real field data.
  for (const fix of REAL_EGYPTIAN_FIXES) {
    assert.equal(
      isPlausibleCheckinCoordinate(fix.lat, fix.lon),
      true,
      `${fix.label} (${fix.lat}, ${fix.lon}) is a real Egyptian check-in and must be accepted`,
    );
  }
  const kept = sanitizeCheckinCoordinates(27.17861, 31.1895, "Asyut, Egypt");
  assert.equal(kept.lat, 27.17861, "a plausible coordinate must pass through untouched");
  assert.equal(kept.lon, 31.1895, "a plausible coordinate must pass through untouched");
  assert.equal(kept.address, "Asyut, Egypt", "a plausible coordinate keeps its address");
  assert.equal(kept.rejected, false, "a plausible coordinate is not a rejection");

  // (0, 0) is the classic "no satellite fix" sentinel, not a position in the Gulf of Guinea.
  assert.equal(isPlausibleCheckinCoordinate(0, 0), false, "(0, 0) is a missing fix and must be rejected");

  // A check-in with NO coordinates is ordinary, not a rejection. Many legitimately arrive without
  // GPS, and counting those would bury the one signal the sync's warning exists to surface.
  const missingCoordCases: Array<[number | null | undefined, number | null | undefined]> = [
    [null, null],
    [undefined, undefined],
    [27.1, null],
    [Number.NaN, 31.1],
  ];
  for (const [lat, lon] of missingCoordCases) {
    const missing = sanitizeCheckinCoordinates(lat, lon, "Asyut, Egypt");
    assert.equal(
      missing.rejected,
      false,
      `absent coordinates (${String(lat)}, ${String(lon)}) must not count as a rejection`,
    );
    assert.equal(missing.lat, null, "absent coordinates normalize to null");
    assert.equal(missing.address, "Asyut, Egypt", "a check-in with no GPS still keeps whatever address it has");
  }

  // The bounds must actually contain Egypt (land extent ~21.99–31.67 N, ~24.70–36.90 E). A later
  // edit that tightens them past a real border town should fail here, not in production.
  assert.ok(
    EGYPT_CHECKIN_BOUNDS.minLat <= 21.99 && EGYPT_CHECKIN_BOUNDS.maxLat >= 31.67,
    "the bounds must span Egypt's full latitude range",
  );
  assert.ok(
    EGYPT_CHECKIN_BOUNDS.minLon <= 24.7 && EGYPT_CHECKIN_BOUNDS.maxLon >= 36.9,
    "the bounds must span Egypt's full longitude range",
  );

  // The vendor's dead `attendance` field must stay out of the CRM master table and export. Across
  // all 122,814 production visits it is 0 (120,922) or NULL (1,892) and has never once been 1, so
  // the column read as "every rep was absent on every visit, all year". Still synced and stored —
  // see the comment in master.ts — just not shown until it varies.
  assert.equal(
    CRM_VISIT_COLUMNS.some((column) => column.key === "attendance"),
    false,
    "the vendor's constant-zero `attendance` field must not be a visible CRM master column",
  );

  // Same for the vendor's `customer_name` ("Facility name"), measured the same day: empty on ALL
  // 122,814 visits - 88,132 NULL and 34,682 empty string, never once populated since January.
  // Campaign visits never carry one by design (campaign-account.ts reads the account out of the
  // comment because of it), so the column rendered as a wall of placeholders sitting right next
  // to the Contact Name that actually answers "who was visited". Unlike `attendance` it is still
  // SELECTed - recognition scoring and the search filter read it - so only the display is gone.
  assert.equal(
    CRM_VISIT_COLUMNS.some((column) => column.key === "customer_name"),
    false,
    "the vendor's always-empty `customer_name` field must not be a visible CRM master column",
  );
}
