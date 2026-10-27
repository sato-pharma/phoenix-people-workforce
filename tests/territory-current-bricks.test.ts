import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  brickHistoryFilter,
  brickInForceFilter,
  coordinateKey,
  currentBrickPins,
  sharedCoordinateKeys,
  type BrickHistory,
  type BrickPin,
} from "../src/lib/territory-management/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management — only bricks in force are drawn (production defect, found 2026-10-27).
//
// The owner reported bricks allocated to the wrong areas. A moved brick is never deleted or
// switched off — it stays `active` so closed months keep resolving it, and is retired by
// `effective_to` plus `superseded_by_brick_id`. Every brick read in the module filtered on
// `active` alone, so each move left its husk on the map in the area it LEFT. On production:
//
//   • Qena 1 showed 12 bricks against the nine he ruled on 13 Oct 2026 — مدينة قنا (B209-1),
//     أبنود (B209-2) and قوص (B209-8) drawn at their old pins, while their successors in Qena 2
//     (B209B-4, B209B-3, B209B-2) had NO pin of their own and sat in "location unknown".
//   • فوه was drawn in BOTH Kafr El-Sheikh areas: B200-5 (Kafr El-Sheikh 2, dated out 31 Jul, no
//     successor recorded) beside B199-9 (Kafr El-Sheikh 1, in force from 1 Aug).
//
// What this file pins:
//   1. A history brick's pin is dropped, and a successor with no pin takes its predecessor's —
//      a `success` one over a demoted one, through a chain, never over the successor's own.
//   2. A husk no longer makes its successor look shared to the shared-pin guard.
//   3. The in-force and history filters are complements on the same day boundary.
//   4. Every area read of `source_of_sales_bricks` in the module carries the in-force filter.
// ─────────────────────────────────────────────────────────────────────────────

function pin(lat: number, lng: number, provider = "google_places_hint", status = "success"): BrickPin {
  return { lat, lng, provider, status };
}

/** The production pins of 2026-10-27, keyed by brick. */
const QENA_CITY_HUSK_1 = pin(26.155061, 32.716012, "google_places_hint", "shared_fallback"); // B209-1
const QENA_CITY_HUSK_2 = pin(26.155061, 32.7160121, "google_places"); // B209B-1
const ABNUD = pin(26.05098, 32.788653, "locationiq"); // B209-2
const QUS = pin(25.918093, 32.759921); // B209-8
const FUWWAH_OLD = pin(31.203548, 30.550222); // B200-5
const FUWWAH = pin(31.2035483, 30.5502219, "google_places"); // B199-9

const PRODUCTION_HISTORY: BrickHistory[] = [
  { brickId: "B170-1", successorId: "" },
  { brickId: "B170-2", successorId: "" },
  { brickId: "B200-5", successorId: "" },
  { brickId: "B209-1", successorId: "B209B-4" },
  { brickId: "B209B-1", successorId: "B209B-4" },
  { brickId: "B209-2", successorId: "B209B-3" },
  { brickId: "B209-8", successorId: "B209B-2" },
];

export function runTerritoryCurrentBricksTests() {
  // ── 1. The production shape ────────────────────────────────────────────────
  const stored = new Map<string, BrickPin>([
    ["B209-1", QENA_CITY_HUSK_1],
    ["B209B-1", QENA_CITY_HUSK_2],
    ["B209-2", ABNUD],
    ["B209-8", QUS],
    ["B200-5", FUWWAH_OLD],
    ["B199-9", FUWWAH],
  ]);
  const pins = currentBrickPins(stored, PRODUCTION_HISTORY);

  for (const husk of ["B209-1", "B209B-1", "B209-2", "B209-8", "B200-5"]) {
    assert.equal(pins.has(husk), false, `${husk} is history — its pin must not be drawn in the area it left`);
  }
  assert.deepEqual(pins.get("B209B-3"), ABNUD, "أبنود in Qena 2 takes its own old pin — the move changed the area, not the ground");
  assert.deepEqual(pins.get("B209B-2"), QUS, "قوص in Qena 2 takes its own old pin");
  assert.deepEqual(
    pins.get("B209B-4"),
    QENA_CITY_HUSK_2,
    "مدينة قنا takes the `success` pin of the two bricks folded into it, never the shared fallback",
  );
  assert.deepEqual(pins.get("B199-9"), FUWWAH, "فوه in Kafr El-Sheikh 1 keeps its own pin");
  assert.equal(pins.size, 4, "exactly the four bricks in force, and nothing invented around them");

  // The order the history arrives in must not decide which pin the city brick inherits.
  const reversed = currentBrickPins(stored, [...PRODUCTION_HISTORY].reverse());
  assert.deepEqual(reversed.get("B209B-4"), QENA_CITY_HUSK_2, "a `success` predecessor wins whichever arrives first");

  // ── 2. A successor's own pin always wins ───────────────────────────────────
  const placed = pin(26.16, 32.72, "manual");
  const withOwn = currentBrickPins(new Map([...stored, ["B209B-4", placed]]), PRODUCTION_HISTORY);
  assert.deepEqual(withOwn.get("B209B-4"), placed, "a pin of the brick's own — a person's above all — is never replaced by a husk's");

  // ── 3. A chain lands on the brick in force; a dead end lands nowhere ───────
  const chain = currentBrickPins(new Map([["A", pin(30, 31)]]), [
    { brickId: "A", successorId: "B" },
    { brickId: "B", successorId: "C" },
  ]);
  assert.deepEqual([...chain.keys()], ["C"], "A moved to B and B to C: the pin is drawn at C only");

  const deadEnd = currentBrickPins(new Map([["A", pin(30, 31)]]), [
    { brickId: "A", successorId: "B" },
    { brickId: "B", successorId: "" },
  ]);
  assert.equal(deadEnd.size, 0, "a chain ending at a retired brick draws nothing");

  const loop = currentBrickPins(new Map([["A", pin(30, 31)]]), [
    { brickId: "A", successorId: "B" },
    { brickId: "B", successorId: "A" },
  ]);
  assert.equal(loop.size, 0, "a loop in the history ends, and draws nothing");

  // ── 4. The shared-pin guard sees only bricks in force ──────────────────────
  const twins = new Map<string, BrickPin>([
    ["OLD", pin(27.1, 31.1)],
    ["NEW", pin(27.1, 31.1)],
  ]);
  assert.equal(sharedCoordinateKeys(twins.values()).size, 1, "control: two live pins on one point are shared");
  const afterMove = currentBrickPins(twins, [{ brickId: "OLD", successorId: "NEW" }]);
  assert.equal(
    sharedCoordinateKeys(afterMove.values()).has(coordinateKey(27.1, 31.1)),
    false,
    "a husk and its successor on one point are the same place — the husk must not demote the brick that replaced it",
  );

  // ── 5. In force and history are complements on the same day ───────────────
  assert.equal(brickInForceFilter("2026-10-27"), "effective_to.is.null,effective_to.gte.2026-10-27");
  assert.equal(
    brickHistoryFilter("2026-10-27"),
    "active.not.is.true,superseded_by_brick_id.not.is.null,effective_to.lt.2026-10-27",
    "`effective_to` is the brick's LAST day (its successor starts the next): in force through it, history after it",
  );

  // ── 6. Every area read in the module is in force only ──────────────────────
  const service = readFileSync(new URL("../src/lib/territory-management/service.ts", import.meta.url), "utf8");
  const reads = service.split('.from("source_of_sales_bricks")').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf(";")));
  const areaReads = reads.filter((read) => read.includes('.eq("active", true)'));
  assert.equal(areaReads.length, 3, "the scope count, the map and the search are the module's three area reads of the brick master");
  for (const read of areaReads) {
    assert.ok(
      read.includes('.is("superseded_by_brick_id", null)') && read.includes(".or(brickInForceFilter("),
      `a brick read filtered on \`active\` alone draws every moved brick in the area it left:\n${read.slice(0, 200)}`,
    );
  }
}
