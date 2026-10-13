import assert from "node:assert/strict";

import {
  MERGED_AREA_SPLIT_FOLD_START_PERIOD,
  applyStoreSplitToMatrix,
  foldNetOntoMergedAreas,
  matrixSalesValue,
} from "../src/lib/sales/store-split-matrix.ts";
import { areaProductKey } from "../src/lib/sales/store-sales-city-split.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A MERGED AREA ROW MUST RECEIVE BOTH HALVES OF THE SPLIT, AND THE GRAND TOTAL CANNOT CHANGE.
//
// The defect this file pins was live on production for nine weeks and measured on 2026-10-13.
//
// Pedia's closing prints Fayoum (GZ6) + Beni Suef (UE9) as ONE row, keyed GZ6, up to and including
// 2026-08 (`CLOSING_AREA_MERGES`). The store split for Pedia 2026-08 produced two instructions for
// that pair: take 25,720.02 EGP off Fayoum, add 45,559.99 to Beni Suef. `applyStoreSplitToMatrix`
// asks the net one question per row it RENDERS, so it found Fayoum's row and applied the first —
// and no row claimed `UE9`, so the second was dropped on the floor.
//
// The merged row read 53,632.99 where the closing's own inputs — the same distributor RPC and the
// same net — say 99,192.98, and because nothing received the money the LINE's August total fell by
// the whole 45,559.99. Source of Sales and `phx_sales_vs_target_range`, two surfaces that share no
// code with this one, both read 99,192.98.
//
// Skipping a delta no row claims is CORRECT and deliberate — for a FILTERED export, where the net
// covers the whole month and the sheet covers three areas. That is the case the last section keeps
// working, because the fix must not silence the disclosure a filtered workbook depends on.
//
// WHY THE INVARIANT DID NOT CATCH IT. `applied` is exactly the amount that failed to land, and
// `closing-store-split-honours-manual-split.test.ts` already asserts it is zero on an unfiltered
// export — but on a fixture where every area has a row of its own. No test put a merge rule and a
// net leg on the folded-away code in the same matrix, which is the only shape that fails.
//
// THE FOLD IS DATED, and that is the owner's own decision (2026-10-13, asked directly: "ship the
// fold fix dated from july"). An undated correction restates every month the system can still read,
// published ones included. July costs nothing earlier than it says, because the city split itself
// begins in August 2026 — so no month before it has a net to re-key.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const LACTO_ADVANCED: MonthlyClosingColumn = { family: "Lacto", productCode: "LA001", productName: "Lacto Advanced 1" };
const LACTO_ADVANCED_2: MonthlyClosingColumn = { family: "Lacto", productCode: "LA002", productName: "Lacto Advanced 2" };

function cell(salesUnits: number, salesValue: number, targetValue: number | null = null): MonthlyClosingCell {
  return {
    achievement: targetValue === null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: targetValue === null ? null : targetValue / 270,
    targetValue,
  };
}

function sum(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const targets = cells.filter((one) => one.targetValue !== null);
  return cell(
    cells.reduce((total, one) => total + one.salesUnits, 0),
    cells.reduce((total, one) => total + one.salesValue, 0),
    targets.length === 0 ? null : targets.reduce((total, one) => total + (one.targetValue ?? 0), 0),
  );
}

function areaRow(regionCode: string, regionName: string, areaCode: string, areaName: string, cells: MonthlyClosingCell[]) {
  return { areaCode, areaName, cells, kind: "area" as const, regionCode, regionName, rowTotal: sum(cells) };
}

/**
 * A month shaped like the real one: the merged row under the surviving code, plus a second area so
 * the region subtotal and the grand total are genuinely roll-ups rather than copies of one row.
 *
 * `areas` is deliberately a parameter — the filtered section below builds the same month with the
 * second area taken out, which is what a filtered export actually hands this function.
 */
function buildMatrix(input: {
  line: string;
  period: string;
  mergedRowCode?: string;
  mergedRowName?: string;
  withSecondArea?: boolean;
}): MonthlyClosingMatrix {
  const merged = areaRow(
    "GZ",
    "Giza",
    input.mergedRowCode ?? "GZ6",
    input.mergedRowName ?? "Fayoum - Beni Suef",
    [cell(300, 81_000, 90_000), cell(130, 35_100, 40_000)],
  );
  const other = areaRow("GZ", "Giza", "GZ1", "Giza 1", [cell(200, 54_000, 50_000), cell(90, 24_300, 25_000)]);
  const areas = input.withSecondArea === false ? [merged] : [merged, other];

  const subtotalCells = [
    sum(areas.map((area) => area.cells[0]!)),
    sum(areas.map((area) => area.cells[1]!)),
  ];
  const grandCells = [subtotalCells[0]!, subtotalCells[1]!];

  return {
    availableLines: [input.line],
    availablePeriods: [input.period],
    columns: [LACTO_ADVANCED, LACTO_ADVANCED_2],
    companyTotal: null,
    directNational: null,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: sum(grandCells) },
    line: input.line,
    period: input.period,
    regions: [
      {
        areas,
        regionCode: "GZ",
        regionName: "Giza",
        subtotal: { cells: subtotalCells, kind: "regionSubtotal", regionCode: "GZ", regionName: "Giza", rowTotal: sum(subtotalCells) },
      },
    ],
  };
}

/**
 * A ZERO-SUM net, which is the only kind the closing ever really applies: a store's sale leaves its
 * origin area and is shared among areas of the same city, so the net for one product across every
 * area is zero (`applyStoreSplitToMatrix`'s own "THE GRAND TOTAL CANNOT CHANGE").
 *
 * Three legs on ONE product, so they can cancel: the surviving code's own, the folded-away code's,
 * and a third on the area beside them. `keep` and `away` carry the production signs — the leg that
 * was being lost is the POSITIVE one, which is why the symptom was a merged row, and a national
 * total, reading LOWER than the closing's own inputs.
 */
function zeroSumNet(keepCode: string, awayCode: string) {
  return new Map([
    [areaProductKey(keepCode, "LA001"), { qty: -100, value: -27_000 }],
    [areaProductKey(awayCode, "LA001"), { qty: 177, value: 47_790 }],
    [areaProductKey("GZ1", "LA001"), { qty: -77, value: -20_790 }],
  ]);
}

/** What the merged row's pair keeps between them once both legs land. */
const PAIR_NET_UNITS = 77;
const PAIR_NET_VALUE = 20_790;
/** The folded-away leg — what the matrix used to drop, and the shape of the production defect. */
const AWAY_LEG_VALUE = 47_790;

export async function runClosingMergedAreaSplitFoldTests() {
  // ── 1. The owner's dated start month ──────────────────────────────────────────────────────────
  // His words, and the reason it is a constant at all. A session that moves it is restating months
  // he published, which is his call and nobody else's. It shipped at 2026-07 ("ship the fold fix
  // dated from july") and he widened it to January hours later ("widen the CNS Qena merge to January
  // too", 2026-10-13) so the CNS Qena fold could reach January inside this window — the two dates
  // are tied, and `tests/cns-qena-one-area.test.ts` pins them against each other.
  assert.equal(
    MERGED_AREA_SPLIT_FOLD_START_PERIOD,
    "2026-01",
    "the owner widened this to January (2026-10-13) — moving it restates months he can still read",
  );

  // ── 2. The real defect: both halves land on the merged row ────────────────────────────────────
  const matrix = buildMatrix({ line: "Pedia", period: "2026-08" });
  const before = matrixSalesValue(matrix);
  const { applied, cells, matrix: split } = applyStoreSplitToMatrix(matrix, zeroSumNet("GZ6", "UE9"));

  const mergedRow = split.regions[0]!.areas[0]!;
  assert.equal(mergedRow.areaCode, "GZ6", "fixture drift — the merged row must be the one keyed GZ6");
  assert.equal(
    mergedRow.cells[0]!.salesUnits,
    300 - 100 + 177,
    "the merged row must receive Beni Suef's leg as well as Fayoum's — this is the 45,559.99 EGP that was dropped",
  );
  assert.equal(
    mergedRow.rowTotal.salesValue,
    81_000 + 35_100 + PAIR_NET_VALUE,
    "the merged row's own total must move by the PAIR's net, not by the surviving code's leg alone",
  );

  // The area beside it gives the money up, so the three legs cancel.
  assert.equal(
    split.regions[0]!.areas[1]!.cells[0]!.salesValue,
    54_000 - PAIR_NET_VALUE,
    "the area the money came from must give up exactly what the merged row received",
  );

  // 🔴 THE HEADLINE. The subtotal and the grand total are adjusted by the same deltas the areas
  // were, so a leg that lands on no row is a hole in all three at once — and the grand total is the
  // number a manager quotes. A redistribution cannot change it.
  assert.equal(
    split.grandTotal.rowTotal.salesValue,
    matrix.grandTotal.rowTotal.salesValue,
    "a redistribution must not change the line's national total — it fell by the dropped leg instead",
  );
  assert.equal(
    matrixSalesValue(split),
    before,
    "every area row added together must come to exactly what it did before the split was applied",
  );

  // `applied` is what actually LANDED, and the net sums to zero, so on an unfiltered matrix it must
  // be zero too. Anything else is money that found no row — which is the whole defect, and the one
  // signal this module already computed and nobody on this path read.
  assert.deepEqual(
    applied,
    { qty: 0, value: 0 },
    "an unfiltered matrix must land every leg the net carries — a non-zero residue here IS the defect",
  );
  // Keyed the way the SHEET is, not the way the net was: the workbook's Total sheet adds each landed
  // delta to that area's Data rows, and those rows are folded by the same rule.
  assert.deepEqual(
    [...cells.keys()].sort(),
    [areaProductKey("GZ1", "LA001"), areaProductKey("GZ6", "LA001")].sort(),
    "the landed cells must carry the sheet's own area codes, with the folded-away one re-keyed",
  );
  assert.equal(
    cells.get(areaProductKey("GZ6", "LA001"))!.value,
    PAIR_NET_VALUE,
    "and the merged row's landed cell must hold BOTH legs added together, not the last one written",
  );

  // ── 3. Anti Infective's own pair, on its own start month ──────────────────────────────────────
  // Suez (OT2) + Ismailia (OT9) became one area from 2026-09, so the same hole exists on that line
  // from that month. The rule's own dating is what decides, never a hard-coded pair of codes.
  const ismailia = applyStoreSplitToMatrix(
    buildMatrix({ line: "Anti Infective", period: "2026-09", mergedRowCode: "OT2", mergedRowName: "Ismailia and Suez" }),
    zeroSumNet("OT2", "OT9"),
  );
  assert.deepEqual(
    ismailia.applied,
    { qty: 0, value: 0 },
    "Ismailia and Suez is one row from 2026-09, so its folded-away code's leg must land there too",
  );
  assert.equal(
    ismailia.matrix.regions[0]!.areas[0]!.rowTotal.salesValue,
    81_000 + 35_100 + PAIR_NET_VALUE,
    "and that row must keep the pair's whole net",
  );

  // ── 4. It folds ONLY where a rule is actually in force ────────────────────────────────────────
  // Anti Infective keeps Fayoum and Beni Suef SEPARATE — it has no GZ6/UE9 rule at all — so on that
  // line `UE9` is a real area with a row of its own, and a matrix that does not render it is a
  // filtered one. Folding by code rather than by rule would move another area's money onto Fayoum.
  const antiInfective = applyStoreSplitToMatrix(
    buildMatrix({ line: "Anti Infective", period: "2026-08" }),
    zeroSumNet("GZ6", "UE9"),
  );
  assert.equal(
    antiInfective.applied.value,
    -AWAY_LEG_VALUE,
    "Anti Infective never merges Fayoum and Beni Suef, so UE9's leg belongs to a row this matrix"
      + " does not carry and must stay unlanded",
  );
  // And Ismailia's pair is not folded on Anti Infective BEFORE its own start month.
  const augustIsmailia = applyStoreSplitToMatrix(
    buildMatrix({ line: "Anti Infective", period: "2026-08", mergedRowCode: "OT2", mergedRowName: "Suez" }),
    zeroSumNet("OT2", "OT9"),
  );
  assert.equal(
    augustIsmailia.applied.value,
    -AWAY_LEG_VALUE,
    "Suez and Ismailia are two areas in August, so August must render exactly as it was published",
  );

  // ── 5. The owner's start month holds in both directions ───────────────────────────────────────
  // A month before it renders exactly as it did — which is what keeps a published closing from
  // being restated by a deploy rather than by a decision.
  //
  // 🔴 THE MONTH HERE IS 2025-12, NOT 2026-06, AND THAT IS NOT ARBITRARY. This section read June
  // while the window opened at July; when the owner widened it to January ("widen the CNS Qena merge
  // to January too", 2026-10-13) June moved INSIDE the window and this assertion failed, correctly.
  // It must name a month genuinely outside the window, and Pedia's GZ6/UE9 rule is in force there
  // (`untilPeriod: 2026-08`), so 2025-12 is the nearest month that still exercises the boundary. A
  // session that widens the window again must move this month too, not relax the assertion.
  const beforeStart = applyStoreSplitToMatrix(
    buildMatrix({ line: "Pedia", period: "2025-12" }),
    zeroSumNet("GZ6", "UE9"),
  );
  assert.equal(
    beforeStart.applied.value,
    -AWAY_LEG_VALUE,
    "a month before the dated start must keep the numbers it was published with",
  );
  assert.equal(
    beforeStart.matrix.grandTotal.rowTotal.salesValue,
    matrix.grandTotal.rowTotal.salesValue - AWAY_LEG_VALUE,
    "and it must keep them exactly — short by the dropped leg, not partly folded",
  );

  // ── 6. A filtered export keeps its disclosure ─────────────────────────────────────────────────
  // THE CASE THE SKIP EXISTS FOR. The net always covers the whole month, so a sheet narrowed to one
  // area legitimately receives deltas for areas it does not carry. `applied` is what lets the
  // workbook say so out loud, and the fold must not turn that into a silent zero.
  const filtered = applyStoreSplitToMatrix(
    buildMatrix({ line: "Pedia", period: "2026-08", withSecondArea: false }),
    zeroSumNet("GZ6", "UE9"),
  );
  assert.equal(
    filtered.applied.value,
    PAIR_NET_VALUE,
    "a filtered sheet landed only the pair's legs, so it must still report that money crossed its"
      + " edge rather than claiming a tidy zero",
  );

  // ── 7. Nothing to fold returns the SAME map ───────────────────────────────────────────────────
  // A documented promise, and the reason every line and month without a rule in force is
  // byte-identical to before: no allocation, no re-keying, no rounding.
  const untouched = zeroSumNet("D11", "D14");
  assert.equal(
    foldNetOntoMergedAreas({ line: "Pedia", period: "2026-08" }, untouched),
    untouched,
    "a net with no folded-away area must come back as the very same map",
  );
  assert.equal(
    foldNetOntoMergedAreas({ line: "Head Office", period: "2026-08" }, zeroSumNet("GZ6", "UE9")).size,
    3,
    "a line that resolves to no target code must not be folded at all",
  );
  assert.equal(
    foldNetOntoMergedAreas({ line: "Pedia", period: "" }, zeroSumNet("GZ6", "UE9")).size,
    3,
    "a matrix with no month cannot be dated, so it falls back to not folding",
  );
}
