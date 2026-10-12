import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// HOW FAR A VISIT WAS SAVED FROM ITS PLACE, on the Super Admin integrity board (owner, 2026-09-29).
//
// Phoenix CRM already had this number: `phoenix_crm_visits.distance_meters` is written at capture
// and the place-vs-actual report prints it for the DM, SFE, NSM and Super Admin. What it did not
// have was that number BESIDE the mock-location, replay and jitter flags, so reading one capture
// meant reading two screens.
//
// Three ways this could go quietly wrong, all pinned here:
//
//   1. RECOMPUTING the distance instead of reading the stored one. Two derivations of one number
//      drift, and then this board and the place-vs-actual report disagree about the same visit —
//      with no way for a reader to know which is right.
//   2. Rendering an UNKNOWN distance as 0 m. A rep standing exactly on the pin reads 0; a visit
//      whose row is gone reads null. Showing both as "0 m from the place" invents a fact.
//   3. Widening who can open the board. It is Super Admin only, and golden rule #1 turns on that.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function runLoaderTests() {
  const board = read("../src/lib/phoenix-crm/server/integrity-board.ts");

  // READ, never derive.
  assert.ok(
    board.includes('.select("id, distance_meters, location_flag")'),
    "the board must read the visit's stored distance",
  );
  assert.ok(
    !/haversine|EARTH_RADIUS|Math\.asin/.test(board),
    "the board must NOT recompute the distance — two derivations of one number drift apart",
  );
  assert.ok(
    !board.includes("assessCaptureTrust"),
    "CRM stores one position per visit, so there is no photo-vs-pin pair to assess here",
  );

  // A case that is not about a VISIT has no place to be far from. Asserted POSITIVELY since the
  // silent detectors landed: `subject_kind` now also admits `shared_place` and `customer`, and the
  // old negative form (`=== "place" ? null : read it`) would have handed a venue and a cadence
  // finding whatever the distance map happened to hold under their ids. Only a visit's own row
  // carries the figure, so only a visit may read it.
  assert.ok(
    board.includes('placeDistanceMeters: row.subject_kind === "visit"'),
    "only a visit may read the stored distance — every other subject kind carries null",
  );
  assert.ok(
    !board.includes('row.subject_kind === "place" ? null'),
    "the distance must not be excluded by naming `place` — that borrows a distance for a venue or a customer",
  );

  // Chunked, or a long board silently reads as "everyone was at their place".
  assert.ok(
    /index \+= 50/.test(board) && board.includes("visitIds.slice(index, index + 50)"),
    "the visit lookup must be chunked — an over-long .in() returns an empty set with no error",
  );

  // Non-fatal: the board exists for the flags, and a missing distance must never blank it.
  assert.ok(
    board.includes("if (visitError) break;"),
    "a failed distance lookup must not take the whole board down with it",
  );
}

function runRenderTests() {
  // 🔴 THE `Position` COMPONENT MOVED TO THE CLIENT VIEW ON 2026-10-13 and this pin followed it. The
  // page still reads the board and gates it; the three case lists, and every figure in them, are
  // rendered by `integrity-board-view.tsx`.
  const view = read("../src/components/crm-integrity/integrity-board-view.tsx");

  assert.ok(
    view.includes("entry.placeDistanceMeters !== null ?"),
    "unknown must render as ABSENT — never as 0 m, which is a rep standing on the pin",
  );
  assert.ok(
    view.includes("from the place"),
    "the figure must say what it is measured against",
  );
  // Metres below a kilometre, kilometres above: "1483 m from the place" is not a readable number.
  assert.ok(
    view.includes("m from the place") && view.includes("km from the place"),
    "both scales must be handled",
  );
  // 🔴 AND THE DISTANCE IS STILL READ, NEVER COMPUTED, ON THE SCREEN SIDE TOO. The view measures the
  // metres BETWEEN a case's own readings (that is what the map is for), but how far a VISIT fell from
  // the place it names is the visit row's own `distance_meters` — the same figure the
  // place-vs-actual report prints, so the two can never disagree about one visit.
  assert.ok(
    !/distanceMeters\(\s*\{[^}]*placeLat/.test(view),
    "the board must not re-measure a visit's distance from its place — that number is written at capture",
  );
}

function runAccessTests() {
  // Unchanged by this PR. Golden rule #1 turns on this board staying the narrowest surface in CRM:
  // a flag is where to look, never a verdict, and the fewer people who can read one the longer the
  // detection keeps working. Widening it is the owner's call, never a side effect of adding a field.
  const page = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");
  assert.ok(
    /isSuperAdmin|Super Admin/.test(page),
    "the integrity board must still gate on the Super Admin",
  );
  const board = read("../src/lib/phoenix-crm/server/integrity-board.ts");
  assert.ok(
    board.includes("is_test") && board.includes("viewer.isSuperAdmin"),
    "test captures stay the Super Admin's — the SFE reads the real field, not his trial entries",
  );
}

export function runCrmIntegrityPlaceDistanceTests() {
  runLoaderTests();
  runRenderTests();
  runAccessTests();
}
