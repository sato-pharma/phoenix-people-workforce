import assert from "node:assert/strict";

import { summarizeBrickCentroidCoverage } from "../src/lib/sales/normalizer/brick-centroids.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Brick centroid coverage — the numerator and the denominator must count the SAME population.
//
// `geo_locations` keeps a `brick_centroid` row after its brick is retired. In production 446 of
// the 1,142 rows are such orphans, against 698 active bricks. `getBrickCentroidCoverage` used to
// count `success`/`cached`/`mismatch` over the raw table while taking `totalBricks` from the live
// brick list, so the two halves came from different populations.
//
// The visible symptom was in src/components/sales/normalizer-workspace.tsx:583, which renders the
// pair directly:
//
//     Geo readiness: 949 / 698 bricks located (13 flagged)
//
// — more bricks located than exist, and all 13 "flagged" belonged to bricks that no longer exist.
// The functional symptom was worse: line 584 gates the "Build geo index" button on
// `success < totalBricks`. With 949 < 698 false, the button never rendered, and it is the ONLY UI
// route to buildBrickCentroids() — which is on no cron. So the 4 live bricks that still have no
// centroid could not be geocoded from the interface at all. The broken counter hid the work the
// counter exists to prompt.
//
// The headline invariant, and the one that fires if this regresses:
//   a coverage summary may NEVER report more located bricks than there are bricks.
// ─────────────────────────────────────────────────────────────────────────────

type Row = { geocode_status: string | null; source_key: string | null };

/** Production's shape, scaled down: live bricks, plus orphan rows whose brick is gone. */
function productionShape(): { brickIds: string[]; rows: Row[] } {
  const brickIds: string[] = [];
  const rows: Row[] = [];

  // 10 live bricks: 7 located, 2 shared_fallback, 1 with no centroid row at all.
  for (let i = 0; i < 10; i += 1) brickIds.push(`B100-${i}`);
  for (let i = 0; i < 7; i += 1) rows.push({ geocode_status: "success", source_key: `B100-${i}` });
  rows.push({ geocode_status: "shared_fallback", source_key: "B100-7" });
  rows.push({ geocode_status: "shared_fallback", source_key: "B100-8" });
  // B100-9 deliberately has no row.

  // 6 orphans — bricks that no longer exist. These are what inflated every count.
  for (let i = 0; i < 4; i += 1) rows.push({ geocode_status: "success", source_key: `GONE-${i}` });
  rows.push({ geocode_status: "region_mismatch", source_key: "GONE-4" });
  rows.push({ geocode_status: "region_mismatch", source_key: "GONE-5" });

  return { brickIds, rows };
}

export function runBrickCentroidCoverageTests() {
  const { brickIds, rows } = productionShape();
  const summary = summarizeBrickCentroidCoverage(brickIds, rows);

  // ── THE HEADLINE ──────────────────────────────────────────────────────────
  // Before the fix this read 11 success against 10 bricks. It is the assertion that must fire.
  assert.ok(
    summary.success <= summary.totalBricks,
    `coverage reported ${summary.success} located of ${summary.totalBricks} bricks — a summary may ` +
      "never locate more bricks than exist; orphan centroid rows are being counted in the numerator",
  );
  assert.ok(
    summary.cached <= summary.totalBricks,
    `cached ${summary.cached} exceeds ${summary.totalBricks} bricks — orphans are being counted`,
  );

  // ── the exact figures ─────────────────────────────────────────────────────
  assert.equal(summary.success, 7, "only centroids belonging to a live brick count as located");
  assert.equal(summary.cached, 9, "9 of the 10 live bricks have a centroid row");
  assert.equal(summary.totalBricks, 10, "denominator is the live brick list");
  assert.equal(
    summary.mismatch,
    0,
    "both region_mismatch rows belong to retired bricks, so neither is a live flag",
  );

  // ── the gate the workspace actually uses for the Build geo index button ────
  assert.ok(
    summary.success < summary.totalBricks,
    "with a live brick still unlocated, the Build geo index button must render",
  );

  // ── no orphans at all: nothing is lost, the summary is unchanged ───────────
  const clean = summarizeBrickCentroidCoverage(
    brickIds,
    rows.filter((row) => !String(row.source_key).startsWith("GONE-")),
  );
  assert.deepEqual(clean, summary, "dropping orphan rows must not change any figure");

  // ── every brick located: the gate closes and the green label shows ─────────
  const full = summarizeBrickCentroidCoverage(
    ["A-1", "A-2"],
    [
      { geocode_status: "success", source_key: "A-1" },
      { geocode_status: "success", source_key: "A-2" },
      { geocode_status: "success", source_key: "ORPHAN" },
    ],
  );
  assert.equal(full.success, 2, "an orphan may not push a fully-located estate past 100%");
  assert.equal(full.success < full.totalBricks, false, "fully located means the button is hidden");

  // ── empty inputs stay coherent rather than dividing by nothing ────────────
  const empty = summarizeBrickCentroidCoverage([], []);
  assert.deepEqual(empty, { cached: 0, mismatch: 0, success: 0, totalBricks: 0 });

  // ── a null source_key is an orphan, not a match for a null-ish brick id ────
  const nullish = summarizeBrickCentroidCoverage(
    ["B-1"],
    [{ geocode_status: "success", source_key: null }],
  );
  assert.equal(nullish.success, 0, "a row with no source_key belongs to no brick");
}
