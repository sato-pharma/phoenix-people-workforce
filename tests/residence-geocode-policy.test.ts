import assert from "node:assert/strict";

import {
  residenceCoordinateColumns,
  residenceGeocodeQuery,
  residenceUnchanged,
} from "../src/lib/employees/residence-geocode-policy.ts";

// Regression guard for the 2026-08-01 Maps billing failure, which made every employee save
// silently destroy that person's stored home GPS. Three separate defects combined:
//
//   1. the skip guard tested `=== undefined`, but the form sends `null`
//   2. the geocode query collapsed to bare "Egypt" and stored the country centroid
//   3. a failed geocode sent `null` under merge-duplicates, OVERWRITING a good coordinate
//
// (3) is the destructive one and has no recovery path: nothing in the system can re-derive a
// residence coordinate once it is gone.
export function runResidenceGeocodePolicyTests() {
  // --- 1. the skip guard ------------------------------------------------------------------
  // The Employee Management form always sends all three residence fields, as null, on every
  // save. An `=== undefined` check therefore never fired and a salary edit re-geocoded.
  assert.equal(
    residenceUnchanged({ residenceAddress: null, residenceArea: null, residenceCity: null }),
    true,
    "all-null residence fields must count as UNCHANGED — this is what the form actually sends, and treating it as a change is what made every save re-geocode",
  );
  assert.equal(residenceUnchanged({}), true, "omitted residence fields must count as unchanged");
  assert.equal(
    residenceUnchanged({ residenceAddress: "12 Nile St", residenceArea: null, residenceCity: null }),
    false,
    "a present address is a real change and must not be skipped",
  );
  assert.equal(
    residenceUnchanged({ residenceAddress: null, residenceArea: null, residenceCity: "Giza" }),
    false,
    "a change to any single residence field must not be skipped",
  );

  // --- 2. the query must never collapse to bare "Egypt" -----------------------------------
  // "Egypt" geocodes SUCCESSFULLY, to the country centroid. The original code joined first and
  // tested the joined string, so empty parts produced a valid-looking lookup whose result was
  // then stored as the employee's home.
  assert.equal(
    residenceGeocodeQuery([null, null, null]),
    null,
    'with no address parts the query must be null, never bare "Egypt" — "Egypt" resolves to the country centroid and would be stored as a real home address',
  );
  assert.equal(residenceGeocodeQuery([undefined, "", null]), null, "empty strings are not address parts");
  assert.equal(
    residenceGeocodeQuery(["12 Nile St", null, "Giza"]),
    "12 Nile St, Giza, Egypt",
    "present parts are joined in order with the country suffix",
  );

  // --- 3. the destructive one: never send null coordinates --------------------------------
  const failed = residenceCoordinateColumns(null);
  assert.equal(
    Object.keys(failed).length,
    0,
    "a failed geocode must contribute NO coordinate columns — under Prefer: resolution=merge-duplicates any key present in the payload is written, so a null here overwrites a good stored coordinate with NULL and nothing can re-derive it",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(failed, "residence_latitude"),
    false,
    "residence_latitude must be ABSENT, not null — present-and-null is exactly the bug",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(failed, "residence_longitude"),
    false,
    "residence_longitude must be ABSENT, not null",
  );

  // A real result still writes both columns — the fix must not stop legitimate updates.
  assert.deepEqual(
    residenceCoordinateColumns({ lat: 30.0444, lng: 31.2357 }),
    { residence_latitude: 30.0444, residence_longitude: 31.2357 },
    "a successful geocode must still write both coordinate columns",
  );

  // Guard the serialisation too: JSON.stringify drops undefined but KEEPS null, so a regression
  // that returns `{residence_latitude: null}` would still reach PostgREST as an explicit null.
  assert.equal(
    JSON.stringify({ employee_hr_id: "HR-1", ...residenceCoordinateColumns(null) }),
    '{"employee_hr_id":"HR-1"}',
    "the serialised upsert body must contain no coordinate keys at all when the geocode failed",
  );
}
