import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildClosingPerformanceReview,
  selectSeriesPeriods,
  PERFORMANCE_REVIEW_FIRST_PERIOD,
  type AreaSeatAssignment,
  type ClosingPerformanceReview,
} from "../src/lib/sales/closing-performance-review.ts";
import { buildClosingPerformanceReviewWorkbook } from "../src/lib/sales/closing-performance-review-export.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// THE PERFORMANCE REVIEW MUST NEVER PRINT A SYSTEM STATE WHERE A NAME BELONGS,
// AND MUST NEVER ADD UNITS OF DIFFERENT PRODUCTS.
//
// Both are the owner's rules and both were broken by the sample this page replaces:
//
//  1. The sample's rep-ranking tab carried two rows literally labelled "No district manager" and
//     "Not mapped to an area". He rejected them outright — an area outside the seat model is still
//     a real place with a real name ("Main Store" is a distributor warehouse, not a missing
//     record), and a row that describes OUR bookkeeping tells the reader nothing about the
//     business. Assertion (1) scans EVERY cell of the built workbook, rich text included, so the
//     labels cannot come back through a helper, a legend, or a footnote either.
//
//  2. A rep sells seventeen products at several concentrations. "Units" across them is not a
//     quantity, so every aggregate spanning more than one product code is expressed in VALUE.
//     `unitsAreAddable` carries that decision from the domain layer to the sheet, and the workbook
//     builder REFUSES to render a units sheet over rows that say they span several products —
//     assertion (6) proves the refusal is real rather than documentation.
//
// The by-area growth tab (assertions 4 and 5) is value for exactly that reason: an area sells the
// whole line, so its units span every product code in it.

const DOT = String.fromCharCode(0x00b7);
const EM = String.fromCharCode(0x2014);
const AREA_SHEET_NAME = "Growth by Month " + DOT + " Area";
const FAMILY_GRID_SHEET_NAME = "Reps " + DOT + " Families";
const PRODUCT_GRID_SHEET_NAME = "Reps " + DOT + " Products";

const REJECTED_LABELS = ["Not mapped to an area", "No district manager"];

const COLUMNS: MonthlyClosingColumn[] = [
  { family: "Tebofortin", productCode: "TB001", productName: "Tebofortin 40mg" },
  { family: "Tebofortin", productCode: "TB002", productName: "Tebofortin 80mg" },
  { family: "Satoslim", productCode: "SS001", productName: "Satoslim" },
];

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

/**
 * One month.
 *
 * `scale` moves every number so the growth column has something real to compute, and Main Store
 * (the warehouse bucket) carries sales with NO target — the case that must stay visible instead of
 * being ranked at 0% or dropped for lacking a denominator.
 */
function matrixFor(period: string, scale: number): MonthlyClosingMatrix {
  const cairo = areaRow("CA", "Cairo", "CA1", "Cairo 1", [
    cell(100 * scale, 5_000 * scale, 6_000),
    cell(40 * scale, 3_000 * scale, 2_000),
    cell(10 * scale, 900 * scale, 1_000),
  ]);
  const mainStore = areaRow("OT", "Others", "OTMS", "Main Store", [
    cell(20 * scale, 700 * scale, null),
    cell(0, 0, null),
    cell(5 * scale, 300 * scale, null),
  ]);
  const grandCells = COLUMNS.map((_, index) => total([cairo.cells[index], mainStore.cells[index]]));
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08", "2026-09"],
    columns: COLUMNS,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: total(grandCells) },
    line: "CNS",
    period,
    regions: [
      {
        areas: [cairo],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: { cells: cairo.cells, kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: cairo.rowTotal },
      },
      {
        areas: [mainStore],
        regionCode: "OT",
        regionName: "Others",
        subtotal: { cells: mainStore.cells, kind: "regionSubtotal", regionCode: "OT", regionName: "Others", rowTotal: mainStore.rowTotal },
      },
    ],
  };
}

function buildFixture(): ClosingPerformanceReview {
  const latest = matrixFor("2026-09", 2);
  // Cairo 1 has a rep and a district manager above it. Main Store has NEITHER — it is a warehouse,
  // not a territory, so the seat model rightly knows nothing about it. That is the row assertion
  // (1) exists for.
  const seatAssignments = new Map<string, AreaSeatAssignment>([
    ["cns::CA1", { managerName: "Hany Adel", repIsVacant: false, repName: "Mostafa Kamel" }],
  ]);
  return buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08", "2026-09"],
    generatedAt: "2026-08-27T00:00:00.000Z",
    matrix: latest,
    seatAssignments,
    seriesMatrices: [
      // The first month of the series was never uploaded for this line. It must read as "not
      // uploaded", never as a zero month — a zero would put a −100% growth beside every product
      // that simply had no sheet yet. Every period here is at or above PERFORMANCE_REVIEW_FIRST_PERIOD,
      // because the series never reaches below it; the floor itself is asserted in group (9).
      { matrix: null, period: "2026-07" },
      { matrix: matrixFor("2026-08", 1), period: "2026-08" },
      { matrix: latest, period: "2026-09" },
    ],
  });
}

/** Every string the workbook renders, rich-text runs flattened, across every sheet. */
async function workbookText(buffer: Buffer): Promise<{ sheetNames: string[]; text: string[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const text: string[] = [];
  const sheetNames: string[] = [];
  workbook.eachSheet((sheet) => {
    sheetNames.push(sheet.name);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (current) => {
        const value = current.value as unknown;
        if (typeof value === "string") text.push(value);
        else if (value && typeof value === "object" && "richText" in (value as Record<string, unknown>)) {
          for (const run of (value as { richText: Array<{ text: string }> }).richText) text.push(run.text);
        }
      });
    });
  });
  return { sheetNames, text };
}

export async function runClosingPerformanceReviewTests() {
  const review = buildFixture();
  const buffer = await buildClosingPerformanceReviewWorkbook(review);
  const { sheetNames, text } = await workbookText(buffer);

  // (1) HEADLINE — neither rejected label appears anywhere in the workbook.
  for (const label of REJECTED_LABELS) {
    const hits = text.filter((value) => value.includes(label));
    assert.deepEqual(
      hits,
      [],
      `the Performance Review workbook must never print "${label}" — a row's name is a real name. ` +
        `An area the seat model does not carry keeps its OWN name ("Main Store"), and a missing ` +
        `district manager leaves the cell blank. Found ${hits.length} cell(s) carrying it.`,
    );
  }

  // (2) ...and the row that used to carry them is present, under its own name.
  const mainStore = review.areas.find((row) => row.areaCode === "OTMS");
  assert.ok(mainStore, "Main Store must appear in the ranking — it sold, so it is on the sheet");
  assert.equal(mainStore.areaName, "Main Store", "an area outside the seat model keeps its own name");
  assert.equal(mainStore.managerName, null, "no manager seat means an EMPTY manager, never a label");
  assert.equal(mainStore.repName, null, "no rep seat means an EMPTY rep, never a label");
  assert.ok(
    text.some((value) => value === "Main Store"),
    "Main Store must reach the workbook by name",
  );

  // (3) An area with no target cannot be ranked against one, so it follows the ranked block rather
  // than being scored 0% or dropped. Cairo 1 has a target; Main Store does not.
  assert.equal(review.areas[0]?.areaCode, "CA1", "the area WITH a target is ranked first");
  assert.equal(review.areas.at(-1)?.areaCode, "OTMS", "the area with no target follows the ranked block");
  assert.equal(mainStore.achievement, null, "no target means no achievement — not 0%");

  // (4) Units of different products are never added.
  const tebofortin = review.families.find((row) => row.family === "Tebofortin");
  const satoslim = review.families.find((row) => row.family === "Satoslim");
  assert.ok(tebofortin && satoslim, "both families must be present");
  assert.equal(tebofortin.productCount, 2, "Tebofortin spans two concentrations in this fixture");
  assert.equal(tebofortin.unitsAreAddable, false, "a family spanning two product codes has no addable unit total");
  assert.equal(tebofortin.salesUnits, null, "...so it reports NO units at all, rather than a wrong one");
  assert.equal(satoslim.unitsAreAddable, true, "a family that is one product code may report units");
  assert.equal(satoslim.salesUnits, 30, "Cairo 1 sold 20 and Main Store 10, at scale 2");

  // (5) The by-AREA growth tab: one row per area, in VALUE, and never claiming addable units.
  assert.ok(sheetNames.includes(AREA_SHEET_NAME), `the workbook must carry a "${AREA_SHEET_NAME}" sheet`);
  assert.deepEqual(
    [...review.areaValueByMonth].map((row) => row.key).sort(),
    ["CA1", "OTMS"],
    "the area series must carry every area on the line",
  );
  for (const row of review.areaValueByMonth) {
    assert.equal(
      row.unitsAreAddable,
      false,
      `${row.label}: an area sells the whole line, so its units span every product code and must ` +
        "never be presented as addable",
    );
  }
  const cairoSeries = review.areaValueByMonth.find((row) => row.key === "CA1");
  assert.ok(cairoSeries);
  assert.deepEqual(
    cairoSeries.perMonth,
    [null, 8_900, 17_800],
    "May was never uploaded (null, renders as a dash), June is the base month, July is double it",
  );
  assert.equal(cairoSeries.growth, 1, "17,800 over 8,900 is +100%");
  assert.equal(cairoSeries.subLabel, "Cairo", "the area series carries its region, by name");

  // A month that was never uploaded must render as a dash. A zero there would read as "sold
  // nothing" and drag every growth figure to -100%.
  assert.ok(text.includes(EM), "a month that was never uploaded renders as an em dash, never as 0");

  // (6) The refusal is real: hand the units sheet rows that span several products and the builder
  // must throw rather than print a number that is not a quantity.
  const doctored: ClosingPerformanceReview = {
    ...review,
    productUnitsByMonth: review.productUnitsByMonth.map((row) => ({ ...row, unitsAreAddable: false })),
  };
  await assert.rejects(
    () => buildClosingPerformanceReviewWorkbook(doctored),
    /units of different products are never added/i,
    "the builder must refuse a units sheet whose rows span more than one product code",
  );

  // (7) The workbook is the screen: every tab the page renders, and the two grids first.
  assert.deepEqual(
    sheetNames,
    [
      FAMILY_GRID_SHEET_NAME,
      PRODUCT_GRID_SHEET_NAME,
      "Rep Ranking",
      "Family Performance",
      "Units & Growth by Month",
      "All Products by Month",
      AREA_SHEET_NAME,
    ],
    "the workbook's tabs, in the order the page shows them",
  );

  // (7b) THE OWNER'S SHAPE: reps and areas down the side, products or families across the top.
  //
  // A grid whose row does not name a PERSON is the closing matrix again, not a review — and a grid
  // whose columns do not add up to the row total is one a reader cannot trust. Both are asserted.
  const family = review.matrixByFamily;
  const product = review.matrixByProduct;

  assert.deepEqual(
    family.columns.map((column) => column.label),
    ["Tebofortin", "Satoslim"],
    "the family grid's headers are the families, biggest first",
  );
  assert.deepEqual(
    product.columns.map((column) => column.label),
    ["Tebofortin 40mg", "Tebofortin 80mg", "Satoslim"],
    "the product grid's headers are the product codes, kept together under their family",
  );
  assert.deepEqual(
    product.columns.map((column) => column.subLabel),
    ["Tebofortin", "Tebofortin", "Satoslim"],
    "each product column carries its family, so the workbook can band them together",
  );

  const cairoFamily = family.rows.find((row) => row.areaCode === "CA1");
  assert.ok(cairoFamily, "the grid carries an area row for Cairo 1");
  assert.equal(cairoFamily.repName, "Mostafa Kamel", "the row names the rep, not just the territory");
  assert.equal(cairoFamily.managerName, "Hany Adel", "the row names the district manager above that rep");
  assert.equal(
    cairoFamily.values.reduce<number>((total, value) => total + (value ?? 0), 0),
    cairoFamily.salesValue,
    "the cells across a row add up to that row's own total",
  );

  // A family column spans two concentrations, so its units are null — never a number, never a zero.
  assert.deepEqual(
    family.columns.map((column) => column.unitsAreAddable),
    [false, true],
    "Tebofortin spans two product codes and Satoslim is one",
  );
  assert.equal(cairoFamily.units[0], null, "a family spanning two concentrations reports no unit count at all");
  assert.ok(product.columns.every((column) => column.unitsAreAddable), "every product column is a single product code");
  assert.ok(
    product.rows.every((row) => row.units.every((value) => value != null)),
    "every cell of the product grid carries a real unit quantity",
  );

  // The area with no seat keeps its own name and shows no invented rep or manager.
  const storeFamily = family.rows.find((row) => row.areaCode === "OTMS");
  assert.ok(storeFamily, "the grid carries Main Store");
  assert.equal(storeFamily.areaName, "Main Store", "Main Store keeps its own name on the grid too");
  assert.equal(storeFamily.repName, null, "an area the organogram carries no seat for shows no rep");
  assert.equal(storeFamily.managerName, null, "and no district manager");

  // Region subtotals and the national total are rows on the grid, and the national one is the
  // closing's own grand total — re-shaped, never re-derived.
  const grand = family.rows[family.rows.length - 1];
  assert.equal(grand.kind, "grandTotal", "the grid closes with the national total");
  assert.equal(grand.salesValue, 19_800, "and it is the closing's own grand total");
  assert.equal(
    family.rows.filter((row) => row.kind === "regionSubtotal").length,
    2,
    "each region closes with its own subtotal row",
  );

  // (7c) The units refusal applies to the grid too, from the other direction: a units GRID whose
  // columns span several products is the same error as a units SHEET whose rows do.
  const doctoredGrid: ClosingPerformanceReview = {
    ...review,
    matrixByProduct: {
      ...product,
      columns: product.columns.map((column) => ({ ...column, unitsAreAddable: false })),
    },
  };
  await assert.rejects(
    () => buildClosingPerformanceReviewWorkbook(doctoredGrid),
    /units of different products are never added/i,
    "the builder must refuse a units grid whose columns span more than one product code",
  );

  // (8) The national total is the closing's own grand total — the review re-shapes it, never
  // re-derives it. 17,800 (Cairo 1) + 2,000 (Main Store) at scale 2.
  assert.equal(review.totals.salesValue, 19_800, "the national total is the closing's grand total");
  assert.equal(review.totals.targetValue, 9_000, "targets sum only where a target exists");

  // (9) THE SERIES STARTS AT JULY 2026 AND NEVER REACHES BELOW IT.
  //
  // The closing holds months back to January and the selector is asked for six, so without a floor
  // it happily returned February through July — which is exactly what it did, and what the owner
  // rejected. Pre-July months carry no as-was area map (au.line_area_map has no history before
  // 2026-07-13) and are priced and targeted on a different basis, so subtracting one from the other
  // measures the regime change and not the business. Months below the floor are DROPPED, not blanked.
  const everyMonth = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

  assert.equal(
    PERFORMANCE_REVIEW_FIRST_PERIOD,
    "2026-07",
    "July 2026 is the first month any series may reach — the owner's rule",
  );
  assert.deepEqual(
    selectSeriesPeriods(everyMonth, "2026-07", 6),
    ["2026-07"],
    "asked for six months up to July, the series is July alone — it starts there, it does not reach back",
  );
  assert.deepEqual(
    selectSeriesPeriods(everyMonth, "2026-08", 6),
    ["2026-07", "2026-08"],
    "the window fills forward on its own as months close",
  );
  assert.deepEqual(
    selectSeriesPeriods(everyMonth, "2026-06", 6),
    [],
    "a month below the floor yields no series at all, rather than months that cannot be compared",
  );
  assert.ok(
    selectSeriesPeriods(everyMonth, null, 6).every((month) => month >= PERFORMANCE_REVIEW_FIRST_PERIOD),
    "even with no month selected, nothing below the floor is ever returned",
  );

  // The window still caps at the count it was given, once enough months have closed above the floor.
  const aYearOn = ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];
  assert.deepEqual(
    selectSeriesPeriods(aYearOn, "2027-01", 6),
    ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"],
    "the six-month window still slides once six months have closed above the floor",
  );

  // And the workbook says so on its face, so a short series never reads as a broken report. This is
  // the shape a July closing actually has today: one month, because the series starts at July.
  const single = matrixFor("2026-07", 2);
  const oneMonth = buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-07"],
    generatedAt: "2026-08-27T00:00:00.000Z",
    matrix: single,
    seatAssignments: new Map<string, AreaSeatAssignment>(),
    seriesMatrices: [{ matrix: single, period: "2026-07" }],
  });
  assert.deepEqual(oneMonth.months, ["2026-07"], "a July closing's series is July alone");
  const startsHere = await workbookText(await buildClosingPerformanceReviewWorkbook(oneMonth));
  assert.ok(
    startsHere.text.some((value) => value.includes("the series starts here")),
    "a one-month series states that it starts there, rather than leaving the reader to guess",
  );
}
