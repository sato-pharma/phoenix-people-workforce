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

  // A PLACE case has no place to be far from.
  assert.ok(
    board.includes('placeDistanceMeters: row.subject_kind === "place"'),
    "a place case must carry a null distance, not a borrowed one",
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
  const page = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");

  assert.ok(
    page.includes("entry.placeDistanceMeters !== null ?"),
    "unknown must render as ABSENT — never as 0 m, which is a rep standing on the pin",
  );
  assert.ok(
    page.includes("from the place"),
    "the figure must say what it is measured against",
  );
  // Metres below a kilometre, kilometres above: "1483 m from the place" is not a readable number.
  assert.ok(
    page.includes("m from the place") && page.includes("km from the place"),
    "both scales must be handled",
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
