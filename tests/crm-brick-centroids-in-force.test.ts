import assert from "node:assert/strict";

import {
  buildBrickCentroids,
  resolveBrickForPoint,
  type BrickCentroidPinRow,
  type BrickInForceRow,
} from "../src/lib/crm/brick-geo.ts";
import type { BrickHistory } from "../src/lib/territory-management/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// CRM brick centroids — only bricks IN FORCE today are check-in geography (production defect,
// found 2026-10-27).
//
// loadBrickCentroids() filtered `source_of_sales_bricks` on `active` alone. A moved brick is never
// switched off — it stays `active` so closed months keep resolving it, and is retired by
// `effective_to` plus `superseded_by_brick_id` — so every move left its husk as a centroid in the
// area it LEFT. On production:
//
//   • أبنود (B209-2) and قوص (B209-8) moved from Qena 1 to Qena 2 as B209B-3 and B209B-2. The
//     successors have NO pin of their own, so the only centroid near أبنود was the Qena 1 husk, and
//     a check-in there was filed in Qena 1.
//   • فوه was a centroid twice: B200-5 (Kafr El-Sheikh 2, dated out 31 Jul, no successor) beside
//     B199-9 (Kafr El-Sheikh 1, in force from 1 Aug), on the same point to the seventh decimal —
//     whichever the array held first won.
//
// The fix reads only bricks in force and hands a pinless successor its predecessor's pin through
// the territory module's own currentBrickPins. This file exercises buildBrickCentroids — the pure
// join the cached read returns — and the resolver over its output. The read's filters themselves
// are pinned in tests/crm-brick-centroids-cache.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function point(sourceKey: string, lat: number, lng: number, provider = "google_places_hint", status = "success"): BrickCentroidPinRow {
  return { geocode_provider: provider, geocode_status: status, latitude: lat, longitude: lng, source_key: sourceKey };
}

function brick(brickId: string, name: string, areaCode: string, regionCode = "UPPER"): BrickInForceRow {
  return { area_code: areaCode, brick_id: brickId, brick_name: name, region_code: regionCode };
}

const ABNUD = { lat: 26.05098, lng: 32.788653 };
const QUS = { lat: 25.918093, lng: 32.759921 };
const FUWWAH = { lat: 31.2035483, lng: 30.5502219 };

/** The production pins of 2026-10-27 — the husks' pins are still in geo_locations. */
const PRODUCTION_POINTS: BrickCentroidPinRow[] = [
  point("B209-1", 26.155061, 32.716012, "google_places_hint", "shared_fallback"),
  point("B209B-1", 26.155061, 32.7160121, "google_places"),
  point("B209-2", ABNUD.lat, ABNUD.lng, "locationiq"),
  point("B209-8", QUS.lat, QUS.lng),
  point("B200-5", 31.203548, 30.550222),
  point("B199-9", FUWWAH.lat, FUWWAH.lng, "google_places"),
  // A pin whose brick no longer exists in the table at all.
  point("B999-9", 26.1, 32.7),
];

/** What the in-force read returns: the husks are not in it. */
const IN_FORCE: BrickInForceRow[] = [
  brick("B209B-4", "مدينة قنا", "QENA2"),
  brick("B209B-3", "أبنود", "QENA2"),
  brick("B209B-2", "قوص", "QENA2"),
  brick("B199-9", "فوه", "KFS1", "DELTA"),
];

/** What the history read returns, with its successors. */
const PRODUCTION_HISTORY: BrickHistory[] = [
  { brickId: "B200-5", successorId: "" },
  { brickId: "B209-1", successorId: "B209B-4" },
  { brickId: "B209B-1", successorId: "B209B-4" },
  { brickId: "B209-2", successorId: "B209B-3" },
  { brickId: "B209-8", successorId: "B209B-2" },
];

const AREA_NAMES = new Map([
  ["QENA1", "Qena 1"],
  ["QENA2", "Qena 2"],
  ["KFS1", "Kafr El-Sheikh 1"],
  ["KFS2", "Kafr El-Sheikh 2"],
]);
const REGION_NAMES = new Map([
  ["UPPER", "Upper Egypt"],
  ["DELTA", "Delta"],
]);

function build(bricks: readonly BrickInForceRow[], history: readonly BrickHistory[], points = PRODUCTION_POINTS) {
  return buildBrickCentroids({ areaNames: AREA_NAMES, bricks, history, points, regionNames: REGION_NAMES });
}

export function runCrmBrickCentroidsInForceTests() {
  // ── 1. The production shape: one centroid per brick in force, none for a husk ──────────────
  const centroids = build(IN_FORCE, PRODUCTION_HISTORY);
  const byId = new Map(centroids.map((c) => [c.brickId, c]));

  for (const husk of ["B209-1", "B209B-1", "B209-2", "B209-8", "B200-5"]) {
    assert.equal(byId.has(husk), false, `${husk} is history — it must never be a check-in's geography`);
  }
  assert.equal(byId.has("B999-9"), false, "a pin with no brick in force behind it is dropped, never drawn as a nameless centroid");
  assert.deepEqual(
    [...byId.keys()].sort(),
    ["B199-9", "B209B-2", "B209B-3", "B209B-4"],
    "exactly the four bricks in force — every one of them, the three pinless successors included",
  );

  const abnud = byId.get("B209B-3");
  assert.deepEqual(
    abnud && { lat: abnud.lat, lon: abnud.lon, areaName: abnud.areaName, brickName: abnud.brickName },
    { lat: ABNUD.lat, lon: ABNUD.lng, areaName: "Qena 2", brickName: "أبنود" },
    "أبنود in Qena 2 has no pin of its own and takes B209-2's — the move changed the area, not the ground",
  );
  const qus = byId.get("B209B-2");
  assert.deepEqual(qus && [qus.lat, qus.lon], [QUS.lat, QUS.lng], "قوص in Qena 2 takes B209-8's pin");
  const city = byId.get("B209B-4");
  assert.equal(city?.lon, 32.7160121, "مدينة قنا takes the `success` pin of the two bricks folded into it, never the shared fallback");
  const fuwwah = byId.get("B199-9");
  assert.deepEqual(
    fuwwah && [fuwwah.areaName, fuwwah.regionName],
    ["Kafr El-Sheikh 1", "Delta"],
    "فوه keeps its own pin and carries its area and region names through",
  );

  // ── 2. The resolver lands a real check-in in the area the brick is in NOW ───────────────────
  const atAbnud = resolveBrickForPoint(ABNUD.lat + 0.001, ABNUD.lng + 0.001, centroids);
  assert.equal(atAbnud?.brickId, "B209B-3", "a check-in at أبنود resolves to the Qena 2 brick, never the Qena 1 husk");
  assert.equal(atAbnud?.areaCode, "QENA2", "and is filed in Qena 2");
  const atFuwwah = resolveBrickForPoint(FUWWAH.lat, FUWWAH.lng, centroids);
  assert.equal(atFuwwah?.brickId, "B199-9", "a check-in at فوه resolves to Kafr El-Sheikh 1 — B200-5 was dated out 31 Jul");

  // ── 3. A successor's own pin always wins over a husk's ──────────────────────────────────────
  const placed = point("B209B-3", 26.06, 32.79, "manual");
  const withOwn = new Map(build(IN_FORCE, PRODUCTION_HISTORY, [...PRODUCTION_POINTS, placed]).map((c) => [c.brickId, c]));
  assert.deepEqual(
    [withOwn.get("B209B-3")?.lat, withOwn.get("B209B-3")?.lon],
    [26.06, 32.79],
    "a pin of the brick's own — a person's above all — is never replaced by its predecessor's",
  );

  // ── 4. A chain lands on the brick in force at its end ───────────────────────────────────────
  const chain = build(
    [brick("C-3", "Chain end", "QENA2")],
    [
      { brickId: "C-1", successorId: "C-2" },
      { brickId: "C-2", successorId: "C-3" },
    ],
    [point("C-1", 26.2, 32.6)],
  );
  assert.deepEqual(
    chain.map((c) => [c.brickId, c.lat, c.lon]),
    [["C-3", 26.2, 32.6]],
    "a brick moved twice hands its pin to the brick in force at the end of the chain, and to nothing in between",
  );

  // ── 5. A pinless brick with no predecessor stays unpinned — nothing is invented ─────────────
  const lonely = build([brick("L-1", "No pin", "QENA2")], []);
  assert.equal(lonely.length, 0, "a brick in force with no pin and no predecessor has no centroid — never a guessed one");
}
