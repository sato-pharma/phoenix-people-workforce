import assert from "node:assert/strict";

import { syntheticTripId } from "../src/lib/outstation/expense-import.ts";

// R1: rows with no real TripID must get a CONTENT-derived synthetic id, not a
// sheet-position `ROW-<n>` that collides across uploads (the ledger upserts on
// the `trip_id` unique key, so a collision silently overwrote the earlier row).
// Distinct rows -> distinct ids; identical rows -> identical id (idempotent).
export function runOutstationExpenseImportTripIdTests() {
  const base = {
    hrId: "B-155",
    specialist: "Ahmed Sharaf",
    date: "2026-07-01",
    to: "Assiut",
    location: "Assiut",
    total: 500,
    travelCost: 300,
    meetingAmount: 100,
    allowance: 100,
    rowNumber: 5,
  };

  // Shape: ROW- prefix + 12 uppercase hex chars.
  assert.match(syntheticTripId(base), /^ROW-[0-9A-F]{12}$/, "synthetic id is ROW- + 12 hex chars");

  // Identical content -> identical id (a re-uploaded identical row stays idempotent).
  assert.equal(syntheticTripId(base), syntheticTripId({ ...base }), "same content yields the same id");

  // The core R1 fix: different content at the SAME row position must NOT collide.
  assert.notEqual(
    syntheticTripId(base),
    syntheticTripId({ ...base, to: "Sohag", location: "Sohag" }),
    "a different destination at the same row position must not collide",
  );
  assert.notEqual(
    syntheticTripId(base),
    syntheticTripId({ ...base, hrId: "B-200" }),
    "a different employee must not collide",
  );
  assert.notEqual(
    syntheticTripId(base),
    syntheticTripId({ ...base, total: 750, travelCost: 550 }),
    "a different amount must not collide",
  );

  // Row position still disambiguates two rows that happen to share content.
  assert.notEqual(
    syntheticTripId(base),
    syntheticTripId({ ...base, rowNumber: 6 }),
    "row position still disambiguates",
  );

  // Null hrId (unmapped employee) is tolerated and stable.
  assert.equal(
    syntheticTripId({ ...base, hrId: null }),
    syntheticTripId({ ...base, hrId: null }),
    "null hrId is handled and stable",
  );
}
