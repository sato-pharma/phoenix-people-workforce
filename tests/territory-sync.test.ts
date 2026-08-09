import assert from "node:assert/strict";

import { computeSyncPeriods, parseReconciliationRow } from "../src/lib/sales/territory/sync.ts";

export function runTerritorySyncTests() {
  // --- parseReconciliationRow: the sync's correctness verdict ---------------------------------

  const clean = parseReconciliationRow({
    official_line: " CNS ",
    period: "2026-07",
    rollup_total_qty: 62102,
    raw_total_qty: 62102,
    rollup_effective_units: "62101.97",
    raw_effective_units: 62101.97,
    rollup_row_count: 13639,
    raw_row_count: "13639",
  });
  assert.equal(clean.officialLine, "CNS", "official_line is trimmed");
  assert.equal(clean.reconciled, true, "identical qty/units and equal row counts reconcile");

  // Effective-units drift within epsilon (floating-point noise) still reconciles.
  const epsilonOk = parseReconciliationRow({
    official_line: "Pedia",
    period: "2026-07",
    rollup_total_qty: 100,
    raw_total_qty: 100,
    rollup_effective_units: 99.999,
    raw_effective_units: 100,
    rollup_row_count: 10,
    raw_row_count: 10,
  });
  assert.equal(epsilonOk.reconciled, true, "sub-0.01 effective-units drift is floating-point noise, not a real mismatch");

  // A quantity gap beyond epsilon is a real mismatch — the rollup does not equal source.
  const qtyGap = parseReconciliationRow({
    official_line: "CNS",
    period: "2026-06",
    rollup_total_qty: 100,
    raw_total_qty: 99,
    rollup_effective_units: 100,
    raw_effective_units: 100,
    rollup_row_count: 10,
    raw_row_count: 10,
  });
  assert.equal(qtyGap.reconciled, false, "a 1-unit qty gap exceeds epsilon and must fail reconciliation");

  // A row-count difference of even one means a row was dropped or double-counted — never tolerated,
  // regardless of how close the summed quantities happen to be.
  const rowCountGap = parseReconciliationRow({
    official_line: "Anti Infective",
    period: "2026-05",
    rollup_total_qty: 100,
    raw_total_qty: 100,
    rollup_effective_units: 100,
    raw_effective_units: 100,
    rollup_row_count: 10,
    raw_row_count: 11,
  });
  assert.equal(rowCountGap.reconciled, false, "row counts must match exactly — an off-by-one is a dropped/duplicated row");

  // Nulls (a period present on one side only, via the FULL OUTER JOIN) coerce to 0, not NaN.
  const oneSided = parseReconciliationRow({
    official_line: null,
    period: "2026-04",
    rollup_total_qty: 50,
    raw_total_qty: null,
    rollup_effective_units: 50,
    raw_effective_units: null,
    rollup_row_count: 5,
    raw_row_count: null,
  });
  assert.equal(oneSided.officialLine, "Unknown", "a null line falls back to 'Unknown', never blank");
  assert.equal(oneSided.rawTotalQty, 0, "a missing raw side coerces to 0, not NaN");
  assert.equal(oneSided.reconciled, false, "rollup present with no raw counterpart cannot reconcile");

  // --- computeSyncPeriods: the trailing window the sync re-stamps -----------------------------

  const anchor = new Date("2026-08-15T12:00:00Z");
  const twelve = computeSyncPeriods(12, anchor);
  assert.equal(twelve.length, 12, "12 months back yields 12 period keys");
  assert.equal(twelve[twelve.length - 1], "2026-08", "the window ends on the current period, oldest-first");
  assert.equal(twelve[0], "2025-09", "12 months back from 2026-08 starts at 2025-09");

  // Out-of-range requests are clamped, never trusted verbatim, so a hostile 999 can't widen the scan.
  assert.equal(computeSyncPeriods(999, anchor).length, 24, "months back is clamped to the 24-month maximum");
  assert.equal(computeSyncPeriods(0, anchor).length, 1, "a non-positive request floors to a single period");
}
