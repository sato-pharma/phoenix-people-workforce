import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { EGYPT_COUNTRY_CENTROID } from "@/lib/google-maps/geocode-precision";
import {
  isNullIslandCoordinate,
  isUnresolvedResidenceCoordinate,
  unresolvedResidenceFailure,
} from "@/lib/outstation/distance-failure";

/**
 * `Number(null)` is 0, and `Number.isFinite(0)` is true.
 *
 * `nullableNumber` in outstation/service.ts read every nullable column through that one-liner, so
 * a NULL `employee_locations.residence_latitude` became a real 0 — and the submit-time guard in
 * `validateCapturedLocation`, which throws "Your registered residence location is missing or
 * invalid. Please contact HR before submitting", tests `== null` and therefore never fired.
 *
 * Two employees with no stored coordinate filed nine claims worth 6,312 EGP between them, each
 * freezing (0, 0) onto the row — AI-0013 eight (5,277 EGP, September) and A-7 one (1,035 EGP,
 * July), two months apart. Google answered `"Location coordinates must not be (0, 0)"` days later,
 * so the reason an admin reads on the card is raw API JSON instead of "ask HR to set the address".
 * Measured on production 2026-09-28.
 *
 * Two halves, both pinned here: stop MAKING the zero, and explain the ones already frozen.
 */

export function runZeroResidenceCoordinateTests() {
  // --- null island is recognised ------------------------------------------------------------

  assert.equal(
    isNullIslandCoordinate(0, 0),
    true,
    "null island (0, 0) must be recognised — it is what a NULL column becomes",
  );
  assert.equal(
    isNullIslandCoordinate(0.0000001, -0.0000001),
    true,
    "null island must match at stored precision, not exact bits",
  );
  assert.equal(
    isNullIslandCoordinate(0, 31.69926),
    false,
    "a real longitude with latitude 0 is not null island",
  );
  assert.equal(
    isNullIslandCoordinate(26.54775, 0),
    false,
    "a real latitude with longitude 0 is not null island",
  );

  // 🔴 A real home must never be called unresolved — a false positive here refuses a valid claim.
  // These are the five coordinates actually set on production on 2026-09-28.
  for (const [lat, lng, who] of [
    [26.54775, 31.69926, "Weaam · Sohag"],
    [28.92142, 30.98537, "Hanan · Biba"],
    [29.30741, 30.83997, "Mohamed Khaled · Fayoum"],
    [30.05212, 31.34220, "Samaa · Nasr City"],
    [31.04246, 30.47275, "Saad · Damanhour"],
  ] as const) {
    assert.equal(
      isUnresolvedResidenceCoordinate(lat, lng),
      false,
      `${who} is a real home and must not be flagged unresolved`,
    );
  }

  // --- both unresolved shapes qualify, from opposite causes ----------------------------------

  assert.equal(
    isUnresolvedResidenceCoordinate(0, 0),
    true,
    "null island — a NULL read through arithmetic",
  );
  assert.equal(
    isUnresolvedResidenceCoordinate(EGYPT_COUNTRY_CENTROID.lat, EGYPT_COUNTRY_CENTROID.lng),
    true,
    "the Egypt centroid — a geocode that resolved only to the country",
  );

  // --- the message names the ACTUAL fault ----------------------------------------------------

  // The two need different fixes: one is a bad address, the other is a missing one. A single
  // message telling an admin to "fix the address" when there is no address at all sends them
  // looking for something to correct that was never typed.
  const nullIsland = unresolvedResidenceFailure("AI-0013", { latitude: 0, longitude: 0 });
  assert.equal(nullIsland.status, 422);
  assert.equal(nullIsland.error, "residence_not_geocoded");
  assert.ok(
    nullIsland.message.includes("No home coordinate was ever stored"),
    "the (0, 0) message must say the coordinate is MISSING, not wrong",
  );
  assert.ok(
    !nullIsland.message.includes("geographic centre of Egypt"),
    "it must not blame the centroid for a fault that is not the centroid",
  );

  const centroid = unresolvedResidenceFailure("B-1", {
    latitude: EGYPT_COUNTRY_CENTROID.lat,
    longitude: EGYPT_COUNTRY_CENTROID.lng,
  });
  assert.ok(centroid.message.includes("geographic centre of Egypt"));

  // Backward compatible: the existing caller shape (no coordinate) keeps the centroid wording.
  const legacy = unresolvedResidenceFailure("B-1");
  assert.ok(
    legacy.message.includes("geographic centre of Egypt"),
    "omitting the coordinate must not change the message an existing caller produced",
  );

  // Both name the person, so an admin knows whose record to open.
  assert.ok(nullIsland.message.includes("AI-0013"));
  assert.ok(centroid.message.includes("B-1"));

  // --- 🔴 the root cause: nullableNumber must not turn NULL into 0 ----------------------------

  const service = readFileSync(
    new URL("../src/lib/outstation/service.ts", import.meta.url),
    "utf8",
  );
  const fnStart = service.indexOf("function nullableNumber(value: unknown) {");
  assert.ok(fnStart > 0, "nullableNumber must still exist");
  const fnBody = service.slice(fnStart, service.indexOf("\n}", fnStart));

  assert.ok(
    fnBody.includes("value === null || value === undefined"),
    "nullableNumber must return null for a NULL column — Number(null) is 0, which silently "
    + "defeats every `x == null` guard downstream",
  );
  assert.ok(
    fnBody.includes('value.trim() === ""'),
    'Number("") and Number("  ") are also 0 — an empty string must return null too',
  );
  // Order matters: both guards must precede the arithmetic, or they never run.
  assert.ok(
    fnBody.indexOf("value === null") < fnBody.indexOf("Number(value)"),
    "the null guard must run BEFORE Number(value), not after it",
  );
  assert.ok(
    fnBody.indexOf('value.trim() === ""') < fnBody.indexOf("Number(value)"),
    "the empty-string guard must run BEFORE Number(value)",
  );
  // A genuine numeric zero is still a zero — this fix must not erase real data.
  assert.ok(
    fnBody.includes("Number.isFinite(parsed) ? parsed : null"),
    "a real 0 in the column must still return 0; only 'nothing was there' becomes null",
  );

  // --- the caller passes the coordinate, or the message cannot be specific --------------------

  const route = readFileSync(
    new URL("../app/api/admin/outstation/calculate-manager-distance/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    route.includes("unresolvedResidenceFailure(managerHrId, {"),
    "the route must pass the coordinate so the admin is told which fault it is",
  );
}
