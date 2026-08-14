import assert from "node:assert/strict";

import {
  matrixCellsFromDistributorRows,
  officeCellsFromDistributorRows,
  type MonthlyClosingAggregateCell,
} from "../src/lib/sales/monthly-distributor-import.ts";

/**
 * The headline Closing Matrix is now DERIVED, not fetched a second time.
 *
 * phx_monthly_closing_matrix and phx_closing_distributor_product select identical rows under
 * identical filters and differ ONLY in GROUP BY grain — the matrix groups by (area, product), the
 * distributor read adds (distributor, region). So the matrix is the Σ of the distributor read over
 * (distributor, region), and buildMonthlyClosingData now folds the ONE distributor read it already
 * makes (for the "of which Office" slice) into the headline grid instead of issuing the matrix RPC's
 * second, identical scan of source_of_sales_fact_rollup. Proven piastre-identical across every
 * validated (line, period) slice on production (28/28 slices, 0 rows different either way, 2026-08-15).
 *
 * matrixCellsFromDistributorRows is that fold. This database-free test pins the two ways it could
 * silently go wrong, both of which would move the closing's headline numbers:
 *   1. FILTERING to Office (copying officeCellsFromDistributorRows too literally) — the headline
 *      would collapse to the Office component and every real distributor's sell-out would vanish.
 *   2. OVERWRITING instead of SUMMING the (distributor, region) rows of one (area, product) — every
 *      contributor but the last would be dropped.
 * The Office fold is exercised on the SAME input as the counterpart: it IS the Office-only subset, so
 * it must stay a strict component of the matrix fold, cell for cell.
 */

// One (area, product) reached by several distributors across several regions — exactly the shape
// phx_closing_distributor_product returns. Reused verbatim by both folds so the subset relationship
// is tested on identical input.
const RPC_ROWS: Record<string, unknown>[] = [
  { distributor_code: "Office", region_code: "R1", area_code: "A1", product_code: "P1", units: 250, value: 2_500 },
  { distributor_code: "Office", region_code: "R2", area_code: "A1", product_code: "P1", units: 150, value: 1_500 },
  { distributor_code: "IS", region_code: "R1", area_code: "A1", product_code: "P1", units: 600, value: 6_000 },
  { distributor_code: "RM", region_code: "R1", area_code: "A2", product_code: "P1", units: 450, value: 4_500 },
  { distributor_code: "office", region_code: "R1", area_code: "A2", product_code: "P1", units: 150, value: 1_500 },
  // A product whose factory price is 0 — present with real units but zero value. Presence is by row,
  // never by value, exactly as the matrix RPC's GROUP BY keeps the (area, product) key regardless of
  // coalesce(factory_price, 0).
  { distributor_code: "IS", region_code: "R1", area_code: "A3", product_code: "P2", units: 100, value: 0 },
];

const cellOf = (cells: MonthlyClosingAggregateCell[], area: string, product: string) =>
  cells.find((c) => c.areaCode === area && c.productCode === product);

export function runClosingMatrixFoldTests() {
  const matrix = matrixCellsFromDistributorRows(RPC_ROWS);

  // ── 1. every distributor is summed, across every region — the identity ──────────────────────
  // (A1, P1) is reached by Office/R1 250 + Office/R2 150 + IS/R1 600 = 1,000. An Office FILTER makes
  // it 400; an OVERWRITE makes it 600 (the last row). Only summing all three gives 1,000.
  const a1p1 = cellOf(matrix, "A1", "P1");
  assert.equal(a1p1?.salesUnits, 1_000, "matrix cell must SUM every distributor and region for (A1,P1)");
  assert.equal(a1p1?.salesValue, 10_000, "and the value likewise (2,500 + 1,500 + 6,000)");

  const a2p1 = cellOf(matrix, "A2", "P1");
  assert.equal(a2p1?.salesUnits, 600, "(A2,P1) = RM 450 + office 150");
  assert.equal(a2p1?.salesValue, 6_000);

  // ── 2. nothing is dropped: total folded == total input ──────────────────────────────────────
  // The defining property of a fold that only re-groups (never filters): the grand total is
  // conserved. This is precisely what an Office filter would break.
  const inputUnits = RPC_ROWS.reduce((s, r) => s + Number(r.units), 0); // 1,700
  const inputValue = RPC_ROWS.reduce((s, r) => s + Number(r.value), 0); // 16,000
  assert.equal(
    matrix.reduce((s, c) => s + c.salesUnits, 0),
    inputUnits,
    "no row may be filtered out — the matrix fold conserves the grand total of units",
  );
  assert.equal(
    matrix.reduce((s, c) => s + c.salesValue, 0),
    inputValue,
    "and of value",
  );

  // ── 3. presence is by row, not by value ─────────────────────────────────────────────────────
  // (A3, P2) sums to 0 value (its factory price is 0) but is still a real cell, because a row exists —
  // the same reason the matrix RPC's GROUP BY keeps the key regardless of value.
  const a3p2 = cellOf(matrix, "A3", "P2");
  assert.ok(a3p2, "a (area, product) with rows must appear even when its value is 0");
  assert.equal(a3p2?.salesUnits, 100);
  assert.equal(a3p2?.salesValue, 0);

  // exactly one cell per distinct (area, product): (A1,P1), (A2,P1), (A3,P2)
  assert.equal(matrix.length, 3, "the fold collapses to exactly one cell per (area, product)");

  // ── 4. the Office fold is a strict component of the matrix fold, cell for cell ───────────────
  // Same input, Office-only. Every Office cell must be ≤ its matrix cell — that is what makes the
  // "of which Office" column readable, and it ties the two folds to the one source read.
  const office = officeCellsFromDistributorRows(RPC_ROWS);
  for (const oc of office) {
    const mc = cellOf(matrix, oc.areaCode, oc.productCode);
    assert.ok(mc, `every Office cell must have a matrix cell beside it (${oc.areaCode}/${oc.productCode})`);
    assert.ok(
      oc.salesUnits <= (mc?.salesUnits ?? 0) + 1e-9,
      `Office units for ${oc.areaCode}/${oc.productCode} exceed the matrix total they annotate`,
    );
    assert.ok(
      oc.salesValue <= (mc?.salesValue ?? 0) + 1e-9,
      `Office value for ${oc.areaCode}/${oc.productCode} exceeds the matrix total they annotate`,
    );
  }
  // The Office component of (A1,P1) is 250 + 150 = 400 of the 1,000 total — a component, never all.
  assert.equal(
    cellOf(office, "A1", "P1")?.salesUnits,
    400,
    "Office is a component (400) of the matrix cell (1,000), never the whole of it",
  );
}
