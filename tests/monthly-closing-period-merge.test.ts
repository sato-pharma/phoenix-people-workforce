import assert from "node:assert/strict";

import {
  describePeriodSelection,
  isMultiPeriodMatrix,
  mergeMonthlyClosingMatrices,
  parseCodeList,
  parsePeriodSelection,
  periodLabel,
} from "../src/lib/sales/monthly-closing-period-merge.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// MERGING MONTHS MUST NEVER ADD ONE PRODUCT'S UNITS TO ANOTHER'S.
//
// Two months do not carry the same closing columns. A product that sold nothing in July is simply
// absent from July's matrix, so July's third column can be Rispadex while August's third column is
// Dopaminict. A merge that walked the columns by POSITION would add one product's units to the
// other's — the owner's rule against adding units of different products, broken silently, with a
// perfectly plausible number coming out the far side.
//
// The fixture below is built so a positional merge CANNOT pass: the two months carry the same three
// products in DIFFERENT ORDERS, and a fourth product exists in one month only. Assertion (2) is the
// one that fires.
//
// Adding units across months is legitimate and is the reason this merge may sum units at all —
// July's Tebofortin 40mg and August's Tebofortin 40mg are the same physical pack counted twice over.

const TB40: MonthlyClosingColumn = { family: "Tebofortin", productCode: "TB001", productName: "Tebofortin 40mg" };
const TB80: MonthlyClosingColumn = { family: "Tebofortin", productCode: "TB002", productName: "Tebofortin 80mg" };
const SATO: MonthlyClosingColumn = { family: "Satoslim", productCode: "SS001", productName: "Satoslim" };
const DOLA: MonthlyClosingColumn = { family: "Dolabactin", productCode: "DB001", productName: "Dolabactin" };

function cell(salesUnits: number, salesValue: number, targetValue: number | null): MonthlyClosingCell {
  return {
    achievement: targetValue == null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: null,
    targetValue,
  };
}

function total(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  let salesUnits = 0;
  let salesValue = 0;
  let targetValue: number | null = null;
  for (const entry of cells) {
    salesUnits += entry.salesUnits;
    salesValue += entry.salesValue;
    if (entry.targetValue != null) targetValue = (targetValue ?? 0) + entry.targetValue;
  }
  return {
    achievement: targetValue == null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: null,
    targetValue,
  };
}

function areaRow(
  regionCode: string,
  regionName: string,
  areaCode: string,
  areaName: string,
  cells: MonthlyClosingCell[],
): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells, kind: "area", regionCode, regionName, rowTotal: total(cells) };
}

function matrixOf(
  period: string,
  columns: MonthlyClosingColumn[],
  areas: Array<{ areaCode: string; areaName: string; cells: MonthlyClosingCell[]; regionCode: string; regionName: string }>,
): MonthlyClosingMatrix {
  const rows = areas.map((area) => areaRow(area.regionCode, area.regionName, area.areaCode, area.areaName, area.cells));
  const byRegion = new Map<string, MonthlyClosingAreaRow[]>();
  rows.forEach((row) => {
    const bucket = byRegion.get(row.regionCode) ?? [];
    bucket.push(row);
    byRegion.set(row.regionCode, bucket);
  });
  const grandCells = columns.map((_column, index) => total(rows.map((row) => row.cells[index])));
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08", "2026-09"],
    columns,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: total(grandCells) },
    line: "CNS",
    period,
    regions: [...byRegion.entries()].map(([regionCode, group]) => {
      const subtotalCells = columns.map((_column, index) => total(group.map((row) => row.cells[index])));
      return {
        areas: group,
        regionCode,
        regionName: group[0].regionName,
        subtotal: {
          cells: subtotalCells,
          kind: "regionSubtotal" as const,
          regionCode,
          regionName: group[0].regionName,
          rowTotal: total(subtotalCells),
        },
      };
    }),
  };
}

/** July: Tebofortin 40, Tebofortin 80, Satoslim — in that order. Cairo 1 carries a target, Main Store none. */
function july(): MonthlyClosingMatrix {
  return matrixOf("2026-07", [TB40, TB80, SATO], [
    {
      areaCode: "CA1",
      areaName: "Cairo 1",
      cells: [cell(100, 5_000, 6_000), cell(40, 3_000, 2_000), cell(10, 900, 1_000)],
      regionCode: "CA",
      regionName: "Cairo",
    },
    {
      areaCode: "OTMS",
      areaName: "Main Store",
      cells: [cell(20, 700, null), cell(0, 0, null), cell(5, 300, null)],
      regionCode: "OT",
      regionName: "Others",
    },
  ]);
}

/**
 * August: the SAME three products in a DIFFERENT order, plus a fourth that July never had.
 *
 * Cairo 1 has no target this month, so the merged target must be July's alone rather than null —
 * and Main Store still has none at all, so its merged target must stay null rather than becoming 0.
 */
function august(): MonthlyClosingMatrix {
  return matrixOf("2026-08", [SATO, TB80, TB40, DOLA], [
    {
      areaCode: "CA1",
      areaName: "Cairo 1",
      cells: [cell(7, 630, null), cell(20, 1_500, null), cell(50, 2_500, null), cell(3, 210, null)],
      regionCode: "CA",
      regionName: "Cairo",
    },
    {
      areaCode: "OTMS",
      areaName: "Main Store",
      cells: [cell(1, 60, null), cell(0, 0, null), cell(9, 315, null), cell(0, 0, null)],
      regionCode: "OT",
      regionName: "Others",
    },
  ]);
}

export async function runMonthlyClosingPeriodMergeTests() {
  // ── (1) A single month comes back as itself, carrying only its own period ──
  const alone = mergeMonthlyClosingMatrices([july()]);
  assert.equal(alone.columns.length, 3, "a one-month selection keeps that month's own columns");
  assert.deepEqual(alone.periods, ["2026-07"], "a one-month selection still states which month it is");
  assert.equal(isMultiPeriodMatrix(alone), false, "one month is not a multi-month matrix");
  assert.equal(
    alone.grandTotal.rowTotal.salesValue,
    july().grandTotal.rowTotal.salesValue,
    "merging one month changes none of its numbers",
  );

  // ── (2) THE HEADLINE: cells merge by PRODUCT CODE, never by column position ──
  const merged = mergeMonthlyClosingMatrices([july(), august()]);
  assert.equal(isMultiPeriodMatrix(merged), true, "two months is a multi-month matrix");
  assert.deepEqual(
    merged.columns.map((column) => column.productCode),
    ["TB001", "TB002", "SS001", "DB001"],
    "the merged columns are the union of both months, first-seen order, with August's extra product last",
  );

  const cairo = merged.regions.find((region) => region.regionCode === "CA")?.areas.find((area) => area.areaCode === "CA1");
  assert.ok(cairo, "Cairo 1 survives the merge");

  const byCode = new Map(merged.columns.map((column, index) => [column.productCode, cairo.cells[index]]));

  // July's TB001 was 100 units / 5,000; August's was 50 / 2,500 — even though TB001 sat in column 0
  // in July and column 2 in August. A positional merge would have added August's Satoslim here.
  assert.equal(byCode.get("TB001")?.salesUnits, 150, "Tebofortin 40mg adds its own two months, not another product's");
  assert.equal(byCode.get("TB001")?.salesValue, 7_500, "Tebofortin 40mg's value adds across the two months");
  assert.equal(byCode.get("TB002")?.salesUnits, 60, "Tebofortin 80mg adds its own two months");
  assert.equal(byCode.get("SS001")?.salesUnits, 17, "Satoslim adds its own two months despite moving column");
  assert.equal(byCode.get("DB001")?.salesUnits, 3, "a product only August had carries August's figure alone");

  // ── (3) A missing target is absent, never zero ──
  assert.equal(
    byCode.get("TB001")?.targetValue,
    6_000,
    "a month with no target contributes nothing to the target rather than dragging it down",
  );
  const mainStore = merged.regions.find((region) => region.regionCode === "OT")?.areas.find((area) => area.areaCode === "OTMS");
  assert.ok(mainStore, "Main Store survives the merge");
  assert.equal(
    mainStore.rowTotal.targetValue,
    null,
    "an area with no target in ANY month stays null so the screen renders a dash, never a zero",
  );
  assert.equal(mainStore.rowTotal.achievement, null, "no target means no achievement, never a division by nothing");

  // ── (4) Achievement is re-derived from the summed value over the summed target ──
  assert.equal(
    cairo.rowTotal.salesValue,
    5_000 + 3_000 + 900 + 630 + 1_500 + 2_500 + 210,
    "the row total is every product across both months",
  );
  assert.equal(cairo.rowTotal.targetValue, 9_000, "the row target is July's three targets, August having none");
  assert.equal(
    cairo.rowTotal.achievement,
    cairo.rowTotal.salesValue / 9_000,
    "achievement is summed value over summed target — never the average of the two months' percentages",
  );

  // ── (5) Region subtotals and the national total come from the AREA rows ──
  const cairoRegion = merged.regions.find((region) => region.regionCode === "CA");
  assert.ok(cairoRegion, "the Cairo region survives");
  assert.equal(
    cairoRegion.subtotal.rowTotal.salesValue,
    cairo.rowTotal.salesValue,
    "a region holding one area subtotals to exactly that area",
  );
  assert.equal(
    merged.grandTotal.rowTotal.salesValue,
    july().grandTotal.rowTotal.salesValue + august().grandTotal.rowTotal.salesValue,
    "the national total across months equals the two months' own national totals added",
  );

  // ── (6) Identity: latest month is the period, every month is listed ──
  assert.equal(merged.period, "2026-08", "the merged matrix's period is the LATEST month it covers");
  assert.deepEqual(merged.periods, ["2026-07", "2026-08"], "and it lists every month it folded in, oldest first");

  // Order of arrival must not change the answer.
  const reversed = mergeMonthlyClosingMatrices([august(), july()]);
  assert.equal(
    reversed.grandTotal.rowTotal.salesValue,
    merged.grandTotal.rowTotal.salesValue,
    "merging the same months in the other order gives the same total",
  );
  assert.deepEqual(reversed.periods, ["2026-07", "2026-08"], "and still lists them oldest first");

  // ── (7) An empty merge is a bug, not an empty closing ──
  assert.throws(
    () => mergeMonthlyClosingMatrices([]),
    /Cannot merge an empty list/,
    "merging nothing throws rather than returning a closing that reads as a real all-zero month",
  );

  // ── (8) Parsing and labelling ──
  assert.deepEqual(parsePeriodSelection("2026-08,2026-07,2026-08"), ["2026-07", "2026-08"], "the parser de-duplicates and orders");
  assert.deepEqual(parsePeriodSelection(""), [], "an empty parameter is an empty selection, not a selection of one blank");
  assert.deepEqual(parsePeriodSelection(null), [], "a missing parameter is an empty selection");
  assert.deepEqual(parseCodeList(" CA1 , CA2 ,, CA1 "), ["CA1", "CA2"], "the list reader trims, drops blanks and de-duplicates");

  assert.equal(periodLabel("2026-07"), "July 2026", "a period is named as a month, never as a code");
  assert.equal(periodLabel("not-a-period"), "not-a-period", "an unparseable period is handed back rather than guessed at");
  assert.equal(describePeriodSelection(["2026-07"]), "July 2026", "one month is named plainly");
  assert.equal(describePeriodSelection(["2026-07", "2026-08"]), "July 2026 and August 2026", "two months are joined");
  assert.equal(
    describePeriodSelection(["2026-07", "2026-08", "2026-09"]),
    "3 months " + String.fromCharCode(0x00b7) + " July 2026 to September 2026",
    "three or more state the count first, because the count is what a reader needs before trusting the total",
  );
}
