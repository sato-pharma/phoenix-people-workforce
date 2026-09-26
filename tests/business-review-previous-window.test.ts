import assert from "node:assert/strict";

import { REVIEW_FLOOR } from "@/lib/business-review/period";
import {
  comparisonBasisFor,
  deltaPct,
  deltaPoints,
  formatDelta,
  shiftPeriod,
} from "@/lib/business-review/previous-window";

/**
 * What the Business Review compares a window against.
 *
 * 🔴 The trap this file exists for: `REVIEW_FLOOR` is July 2026, so for the window the page shows
 * TODAY — Jul–Aug 2026 — there is no previous window at all. An implementation that simply
 * subtracted the window length would ask for May–Jun, get nothing back, and render "0%" or "—"
 * against every tile on the page. Zero is not "no data", and a manager reading a flat 0% concludes
 * his line stood still.
 */
export function runBusinessReviewPreviousWindowTests() {
  // ------------------------------------------------------------------ 1. period arithmetic
  {
    assert.equal(shiftPeriod("2026-07", -1), "2026-06");
    assert.equal(shiftPeriod("2026-01", -1), "2025-12", "across a year boundary");
    assert.equal(shiftPeriod("2026-03", -12), "2025-03");
    assert.equal(shiftPeriod("2026-11", 2), "2027-01", "and forwards");
    assert.equal(shiftPeriod("not-a-period", -1), "not-a-period", "a bad input comes back unchanged, never NaN-NaN");
  }

  // ------------------------------------------------------------------ 2. today: no previous window
  {
    // The live figure window. May–Jun 2026 is below the floor, so the equal-length span is refused
    // and the comparison falls back to the month before the last one, INSIDE the window.
    const basis = comparisonBasisFor(["2026-07", "2026-08"], REVIEW_FLOOR);
    assert.equal(basis.kind, "previous-month", "May–Jun is below the July floor, so it is not offered");
    assert.deepEqual(basis.kind === "previous-month" ? basis.periods : null, ["2026-07"]);
    assert.equal(basis.label, "Jul 2026", "and the label names the basis, so the delta cannot mislead");
  }

  // ------------------------------------------------------------------ 3. once the data reaches back
  {
    const basis = comparisonBasisFor(["2026-10", "2026-11"], REVIEW_FLOOR);
    assert.equal(basis.kind, "previous-window", "Aug–Sep sits entirely above the floor");
    assert.deepEqual(basis.kind === "previous-window" ? basis.periods : null, ["2026-08", "2026-09"]);
    assert.equal(basis.label, "Aug – Sep 2026");

    const three = comparisonBasisFor(["2026-10", "2026-11", "2026-12"], REVIEW_FLOOR);
    assert.equal(three.kind, "previous-window");
    assert.deepEqual(three.kind === "previous-window" ? three.periods : null, ["2026-07", "2026-08", "2026-09"]);
  }

  // ------------------------------------------------------------------ 4. the boundary is exact
  {
    // A two-month window starting September CAN reach Jul–Aug, which is exactly the floor.
    const atFloor = comparisonBasisFor(["2026-09", "2026-10"], REVIEW_FLOOR);
    assert.equal(atFloor.kind, "previous-window", "a basis that starts ON the floor is allowed");
    assert.deepEqual(atFloor.kind === "previous-window" ? atFloor.periods : null, ["2026-07", "2026-08"]);

    // One month earlier and it reaches June, which the review may not read.
    const belowFloor = comparisonBasisFor(["2026-08", "2026-09"], REVIEW_FLOOR);
    assert.equal(belowFloor.kind, "previous-month", "one month below the floor disqualifies the whole span");
  }

  // ------------------------------------------------------------------ 5. nothing to compare
  {
    const single = comparisonBasisFor(["2026-07"], REVIEW_FLOOR);
    assert.equal(single.kind, "none", "a single month AT the floor has nothing above it to compare against");
    assert.match(
      single.kind === "none" ? single.reason : "",
      /single month/,
      "and it says why, rather than rendering an empty column",
    );

    const empty = comparisonBasisFor([], REVIEW_FLOOR);
    assert.equal(empty.kind, "none");
  }

  // ------------------------------------------------------------------ 6. deltas never invent a number
  {
    assert.equal(deltaPct(130, 100), 30);
    assert.equal(deltaPct(75, 100), -25);
    assert.equal(
      deltaPct(4_000, 0),
      null,
      "a zero base has no percentage to grow BY — '+100%' off nothing is how one invoice reads as a doubling",
    );
    assert.equal(deltaPct(100, null), null, "and a missing earlier figure is not a zero");
    assert.equal(deltaPct(null, 100), null);

    // 74.3 - 68.2 is 6.099999999999994 in IEEE doubles. The function deliberately does NOT round:
    // it is a raw difference, and `formatDelta` is the one place a figure is fixed to a decimal.
    // Rounding here would round twice and drift.
    const points = deltaPoints(74.3, 68.2);
    assert.ok(
      points != null && Math.abs(points - 6.1) < 1e-9,
      `an achievement moves in POINTS, never in percent of a percent — got ${points}`,
    );
    assert.equal(formatDelta(points, "pts"), "▲ 6.1 pts", "and it reads cleanly once formatted");
    assert.equal(deltaPoints(74.3, null), null);
  }

  // ------------------------------------------------------------------ 7. how it reads
  {
    assert.equal(formatDelta(6.1, "pts"), "▲ 6.1 pts");
    assert.equal(formatDelta(-11.42, "%"), "▼ 11.4%", "no space before the percent sign");
    assert.equal(formatDelta(null, "pts"), "—", "no comparison shows an em dash, never a zero");
    assert.equal(formatDelta(0.01, "pts"), "level", "a change nobody can act on reads as level, not as a direction");
    assert.equal(formatDelta(-0.0, "%"), "level");
  }
}
