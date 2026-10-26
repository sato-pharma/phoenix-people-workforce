import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS } from "../src/lib/export/house-xlsx-identity.ts";
import {
  buildClosingPerformanceReview,
  selectSeriesPeriods,
  PERFORMANCE_REVIEW_FIRST_PERIOD,
  type AreaSeatAssignment,
  type ClosingPerformanceReview,
} from "../src/lib/sales/closing-performance-review.ts";
import { applyAreaMapAsOf, coversAsOf, periodEndDate } from "../src/lib/sales/closing-performance-review.ts";
import { GROWTH_NO_BASE, reviewGrowthOf } from "../src/lib/sales/closing-performance-review-regions.ts";
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
const PRODUCT_MONTH_SHEET_NAME = "Reps " + DOT + " Products by Month";

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

/** Exported so a probe can emit the real workbook and look at it, rather than at the source. */
export function buildFixture(): ClosingPerformanceReview {
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

/**
 * Every SOLID fill in the emitted workbook, with where it is.
 *
 * ExcelJS reports an unfilled cell as `{ pattern: "none" }` rather than as undefined, so the filter
 * is on the pattern, not on the presence of `fill`. A check written the obvious way — "cell.fill is
 * falsy" — passes on every cell in the book and proves nothing.
 */
async function workbookFills(buffer: Buffer): Promise<Array<{ address: string; argb: string; row: number; sheet: string }>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const found: Array<{ address: string; argb: string; row: number; sheet: string }> = [];
  workbook.eachSheet((sheet) => {
    // includeEmpty on BOTH loops, or the check is blind to exactly the cells that matter: a rule row
    // is filled and carries no text, so a value-only walk reports the workbook has no rule at all.
    sheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const value = cell.fill as ExcelJS.FillPattern | undefined;
        if (!value || value.pattern !== "solid") return;
        const argb = value.fgColor?.argb;
        if (!argb) return;
        found.push({ address: cell.address, argb, row: row.number, sheet: sheet.name });
      });
    });
  });
  return found;
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
      PRODUCT_MONTH_SHEET_NAME,
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

  // (7d) THE PER-REP BY-MONTH UNITS GRID: a block per product, that product's months inside it.
  //
  // The owner's shape for this one — "Royafloxacin merged, and under it July, August, September and
  // the growth, then Saginko merged, and so on" — carried per REP rather than for the line as a
  // whole. The rule it has to respect is the same one: a block is ONE product code, so its units are
  // a real quantity and the subtotals down the column are legitimate, while the row carries NO total
  // at all, because a row spans products.
  const byRep = review.productUnitsByRepByMonth;
  assert.deepEqual(byRep.months, ["2026-07", "2026-08", "2026-09"], "the blocks carry the series' own months");
  assert.deepEqual(
    byRep.columns.map((column) => column.label),
    ["Tebofortin 40mg", "Tebofortin 80mg", "Satoslim"],
    "one block per product code, in the product grid's order — a family's concentrations together",
  );
  assert.ok(
    byRep.columns.every((column) => column.unitsAreAddable),
    "every block is a single product code, so every figure in it is a real quantity",
  );
  assert.deepEqual(
    byRep.rows.map((row) => row.kind),
    ["area", "regionSubtotal", "area", "regionSubtotal", "grandTotal"],
    "each region closes with its own subtotal and the grid closes with the national total",
  );

  const cairoByRep = byRep.rows.find((row) => row.areaCode === "CA1");
  assert.ok(cairoByRep, "the grid carries an area row for Cairo 1");
  assert.equal(cairoByRep.repName, "Mostafa Kamel", "the row names the rep, not just the territory");
  assert.equal(cairoByRep.managerName, "Hany Adel", "and the district manager above that rep");
  assert.deepEqual(
    cairoByRep.units[0],
    [null, 100, 200],
    "July was never uploaded (a dash, never a zero), August is the base month, September is double it",
  );
  assert.equal(cairoByRep.growth[0], 1, "200 units over 100 is +100%, per product, per rep");
  assert.ok(
    !("salesValue" in cairoByRep),
    "a row of this grid carries no total of any kind — adding a rep's units across products is the " +
      "one sum that is never done",
  );

  const storeByRep = byRep.rows.find((row) => row.areaCode === "OTMS");
  assert.ok(storeByRep, "the grid carries Main Store");
  assert.equal(storeByRep.areaName, "Main Store", "an area outside the seat model keeps its own name here too");
  assert.equal(storeByRep.repName, null, "and shows no invented rep");
  assert.deepEqual(storeByRep.units[1], [null, 0, 0], "a product that sold nothing is a zero, not a dash");
  assert.equal(
    storeByRep.growth[1],
    GROWTH_NO_BASE,
    "a month before that sold ZERO has no base — it prints a dash, never a percentage and never \"new\"",
  );

  const nationalByRep = byRep.rows[byRep.rows.length - 1];
  assert.deepEqual(
    nationalByRep.units[0],
    [null, 120, 240],
    "the national row sums ONE product down its own column — 100 + 20, then double",
  );
  assert.deepEqual(
    nationalByRep.units[2],
    [null, 15, 30],
    "and does the same for every other product block",
  );

  // The refusal applies here too: a units grid whose blocks claim to span several products is the
  // same error, and the builder must throw rather than print a figure that is not a quantity.
  const doctoredByRep: ClosingPerformanceReview = {
    ...review,
    productUnitsByRepByMonth: {
      ...byRep,
      columns: byRep.columns.map((column) => ({ ...column, unitsAreAddable: false })),
    },
  };
  await assert.rejects(
    () => buildClosingPerformanceReviewWorkbook(doctoredByRep),
    /units of different products are never added/i,
    "the builder must refuse a per-rep units grid whose blocks span more than one product code",
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
  //
  // 🔴 IT WAS MOVED TO JANUARY ON 2026-10-13 AND HE CORRECTED IT BACK TO JULY THE SAME DAY — the
  // first half of that exchange ("when I publish from Jan to September, since performance review is
  // no target, it's only sales. So show them the history") reads as the sales-history floor, and his
  // next word was "no show performance review in emp portal starting from july". July it is, for
  // every reader, the portal tab included.
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

  // ── (10) THE HOUSE IDENTITY, ASSERTED ON THE EMITTED FILE ──────────────────
  //
  // A 6%-tint region wash down five columns of every row is nearly invisible on screen and survives
  // review — which is how it lived here for months. So this counts every solid fill in the emitted
  // workbook and names any outside the closed set below.
  //
  // THE SET GREW BY ONE ON 2026-09-05, deliberately and at the owner's instruction. The header was
  // type on white under a rule; on a sheet whose product grids run to twenty-odd columns that does
  // not separate a header from its data, and he said so looking at a real export. The rule it came
  // from measures PAGE COVERAGE and was written for contracts that print in volume — it is a rule
  // about paper, and this is read on screen. So a header band is now allowed and NOTHING ELSE IS:
  // the region wash this test was written to catch is still a failure, and so is any other slab.
  //
  // It reads the FILE, not the source, because the file is the only place the fills exist.
  const fills = await workbookFills(buffer);
  const allowed = new Set<string>([
    HOUSE_XLSX_COLORS.blue, // the masthead rule, and the column-header band
    HOUSE_XLSX_COLORS.light, // the lighter band on a grouping strip above a header
    HOUSE_XLSX_COLORS.tint, // the 6% zebra row
  ]);
  const strays = fills.filter((entry) => !allowed.has(entry.argb));
  assert.deepEqual(
    strays.slice(0, 6),
    [],
    "colour is carried by lines, type and the header band — never by a slab behind the data. This " +
      "workbook may carry only the Brand Blue rule and header, the lighter grouping band, and the " +
      `6% zebra row. Found ${strays.length} other filled cell(s).`,
  );

  // The header band is really there, so widening the set above cannot have hidden its absence.
  assert.ok(
    fills.some((entry) => entry.argb === HOUSE_XLSX_COLORS.blue && entry.row > 5),
    "the column headers carry the Brand Blue band, not just the masthead rule on row 5",
  );

  // ...and the two that ARE allowed are really there, so the assertion above cannot pass by the
  // workbook carrying no fills at all — which is what a broken builder would also look like.
  assert.ok(
    fills.some((entry) => entry.argb === HOUSE_XLSX_COLORS.blue && entry.row === 5),
    "every sheet carries the Brand Blue rule beneath its masthead, on row 5",
  );
  assert.ok(
    fills.some((entry) => entry.argb === HOUSE_XLSX_COLORS.tint),
    "the zebra row is the format's one permitted fill, and it is in use",
  );

  // The standard identifies itself on the face of the document, as it does on paper.
  assert.ok(
    text.some((value) => value.includes(HOUSE_DOCUMENT_STANDARD)),
    `the workbook prints its document standard, "${HOUSE_DOCUMENT_STANDARD}"`,
  );

  // The identity is the COMPANY's, never the app's. A title carrying the app's name is the exact
  // regression this line exists to catch — it is how these workbooks used to read.
  const appNameOnTheFace = text.filter((value) => /phoenix/i.test(value));
  assert.deepEqual(
    appNameOnTheFace,
    [],
    "a company document wears the COMPANY's identity: the Performance Review workbook must never " +
      `print the app's name. Found: ${appNameOnTheFace.join(" | ")}`,
  );
}

/**
 * The as-of manager resolution, and the boundary that makes it correct.
 *
 * These are pure: the loader they belong to reads the database, but the two things that were WRONG
 * are arithmetic — which day a month resolves at, and which of a dated PAIR is in force on the day
 * they share.
 */
export function runClosingManagerAsOfTests() {
  // ── the day a month is resolved at ──────────────────────────────────────────
  assert.equal(periodEndDate("2026-08"), "2026-08-31");
  assert.equal(periodEndDate("2026-02"), "2026-02-28", "February is not 30 days, and not hard-coded");
  assert.equal(periodEndDate("2024-02"), "2024-02-29", "a leap February is 29");
  assert.equal(periodEndDate("2026-12"), "2026-12-31");
  assert.equal(periodEndDate(null), null);
  assert.equal(periodEndDate("2026-13"), null, "month 13 is not a month");
  assert.equal(periodEndDate("nonsense"), null);

  // ── the dated pair ──────────────────────────────────────────────────────────
  //
  // THIS IS THE DEFECT ITSELF. The five Delta (3) areas close on 2026-09-01 and reopen the same day.
  // August must see the OLD row and September the NEW one, and exactly one of them on any date.
  const oldRow = { from: "2026-07-13", to: "2026-09-01" };
  const newRow = { from: "2026-09-01", to: null };

  const inForce = (asOf: string) =>
    [
      coversAsOf(oldRow.from, oldRow.to, asOf) ? "old" : null,
      coversAsOf(newRow.from, newRow.to, asOf) ? "new" : null,
    ].filter(Boolean);

  assert.deepEqual(inForce("2026-08-31"), ["old"], "August is the manager who held the area THEN");
  assert.deepEqual(inForce("2026-09-01"), ["new"], "the move takes effect on its own date");
  assert.deepEqual(inForce("2026-09-30"), ["new"], "and stays in effect after it");
  assert.deepEqual(inForce("2026-07-12"), [], "before either row, nothing is in force");

  // Exactly one row on the shared day is the whole point: an inclusive end matches both, and which
  // one wins would depend on iteration order rather than on a decision anybody made.
  for (const day of ["2026-08-31", "2026-09-01", "2026-09-02"]) {
    assert.equal(inForce(day).length, 1, `${day}: exactly one row must be in force, got ${inForce(day).join("+")}`);
  }

  // ── one rep, two areas: CNS has a single Qena (owner, 2026-10-12) ────────────
  //
  // The map points CNS Qena 2 at Qena 1's rep seat; the seat tree knows that seat only as Qena 1's.
  // Before the fix Qena 2 printed with no rep and no manager, outside every person's figure.
  const qena = new Map([
    ["cns::UE7", { managerName: "Today's DM", repIsVacant: false, repName: "Snagik Ayman" }],
  ]);
  const qenaMap = (area: string, from: string, to: string | null) => ({
    area_code: area, dm_seat_id: "SEAT-CNS-DM-UE", effective_from: from, effective_to: to,
    line_code: "cns", rep_seat_id: "SEAT-CNS-REP-UE7",
  });
  applyAreaMapAsOf(qena, {
    asOf: "2026-09-30",
    mapRows: [qenaMap("UE7", "2026-07-13", null), qenaMap("UE8", "2026-07-14", null), qenaMap("UE8", "2026-01-01", "2026-07-13")],
    occupantOf: new Map([["SEAT-CNS-DM-UE", "Amgad Ibrahim"]]),
    pseudoSeat: new Set(),
    seatAreaOf: new Map([["SEAT-CNS-REP-UE7", "UE7"], ["SEAT-CNS-DM-UE", ""]]),
  });
  assert.deepEqual(
    qena.get("cns::UE8"),
    { managerName: "Amgad Ibrahim", repIsVacant: false, repName: "Snagik Ayman" },
    "Qena 2 is counted to the Qena rep, under the manager in force that month",
  );
  assert.equal(qena.get("cns::UE7")?.repName, "Snagik Ayman", "Qena 1 keeps its own rep");
  // An area the map gives to no other seat is left exactly as it was — nothing is invented.
  const lone = new Map<string, { managerName: string | null; repIsVacant: boolean; repName: string | null }>();
  applyAreaMapAsOf(lone, {
    asOf: "2026-09-30",
    mapRows: [{ ...qenaMap("OT7", "2026-07-13", null), rep_seat_id: null }],
    occupantOf: new Map(),
    pseudoSeat: new Set(),
    seatAreaOf: new Map(),
  });
  assert.equal(lone.size, 0, "an area with no rep seat of its own and none borrowed gets no row");

  // An open-ended row with no start is not a row.
  assert.equal(coversAsOf(null, null, "2026-08-31"), false);
  assert.equal(coversAsOf("", "2026-09-01", "2026-08-31"), false);

  // ── a seat that changed hands twice ─────────────────────────────────────────
  //
  // The real Upper Egypt 2 history, and the reason this matters beyond the Delta (3) move: a person
  // to 2026-08-03, empty until 2026-08-24, then a different person. Reading the CURRENT tree named
  // the last of the three for every earlier month — 87,587 of July credited to a manager who did not
  // hold the seat until 24 August, and Giza's 53,051 to one who started on 2 August.
  const seat = [
    { from: "2026-03-24", to: "2026-08-03", who: "Ahmed Nashaat" },
    { from: "2026-08-03", to: "2026-08-24", who: null },
    { from: "2026-08-24", to: null, who: "Weaam Mahmoud" },
  ];
  const heldOn = (asOf: string) => {
    const rows = seat.filter((r) => coversAsOf(r.from, r.to, asOf));
    assert.equal(rows.length, 1, `${asOf}: exactly one row must be in force, got ${rows.length}`);
    return rows[0]!.who;
  };

  assert.equal(heldOn("2026-07-31"), "Ahmed Nashaat", "July is the manager who held it THEN");
  assert.equal(heldOn("2026-08-02"), "Ahmed Nashaat", "his last full day counts");
  assert.equal(heldOn("2026-08-03"), null, "the seat is empty from the day he leaves it");
  assert.equal(heldOn("2026-08-23"), null, "and stays empty until the day the next person starts");
  assert.equal(heldOn("2026-08-24"), "Weaam Mahmoud", "who counts from her own first day");
  assert.equal(heldOn("2026-08-31"), "Weaam Mahmoud", "which is what August reports");

  // A manager who has since LEFT must still be nameable — his month is his. That is why the as-of
  // lookup reads the directory with `includeInactive`, and an active-only read would turn a real
  // person's month into an ordinary-looking vacancy.
  assert.equal(heldOn("2026-07-31"), "Ahmed Nashaat", "a leaver still owns the month he worked");
}

/** A matrix from loose area rows, grouped by region in the order given, every total re-derived. */
function matrixOfAreas(period: string, areas: MonthlyClosingAreaRow[]): MonthlyClosingMatrix {
  const groups = new Map<string, MonthlyClosingAreaRow[]>();
  for (const area of areas) {
    const bucket = groups.get(area.regionCode);
    if (bucket) bucket.push(area);
    else groups.set(area.regionCode, [area]);
  }
  const grandCells = COLUMNS.map((_, index) => total(areas.map((area) => area.cells[index])));
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-08", "2026-09"],
    columns: COLUMNS,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: total(grandCells) },
    line: "Pedia",
    period,
    regions: [...groups.entries()].map(([regionCode, members]) => {
      const cells = COLUMNS.map((_, index) => total(members.map((area) => area.cells[index])));
      return {
        areas: members,
        regionCode,
        regionName: members[0].regionName,
        subtotal: {
          cells,
          kind: "regionSubtotal" as const,
          regionCode,
          regionName: members[0].regionName,
          rowTotal: total(cells),
        },
      };
    }),
  };
}

/**
 * AN AREA THAT CHANGED REGION BETWEEN MONTHS IS ONE ROW, UNDER THE SELECTED MONTH'S REGION — AND
 * GROWTH OFF A BASE OF ZERO OR BELOW IS A DASH.
 *
 * Pedia, September 2026, National Sales Manager: areas moved between Upper Egypt regions. "Reps ·
 * Products by Month" grouped each month by that month's own region, so each moved area printed twice
 * — each copy carrying both months — and the bottom row added it twice: Lacto Advanced 1 6,377
 * against the closing's 5,561, Ivyronc 12,710 against 10,642, Guamusin 1,032 against 698. "Growth by
 * month · area" labelled a moved area with an old month's region. And Luxor's August Lacto Advanced 1
 * at −1 unit printed "−4938.9%" beside a month that grew.
 */
export async function runClosingPerformanceReviewRehomedAreaTests() {
  // August: Minia 1 and Luxor under the old regions; Luxor sold −1 (returns) of TB001.
  const august = matrixOfAreas("2026-08", [
    areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(80, 4_000, 5_000), cell(30, 2_000, 2_000), cell(5, 400, 500)]),
    areaRow("UE", "Upper Egypt", "MN1", "Minia 1", [cell(50, 2_500, 3_000), cell(10, 700, 800), cell(0, 0, null)]),
    areaRow("UE-2", "Upper Egypt 2", "LX1", "Luxor", [cell(-1, -40, 1_000), cell(4, 300, 300), cell(1, 80, null)]),
  ]);
  // September: Minia 1 now sits in Upper Egypt 1, Luxor in Others, and a new area opened.
  const september = matrixOfAreas("2026-09", [
    areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(100, 5_000, 5_000), cell(40, 3_000, 2_000), cell(6, 480, 500)]),
    areaRow("UE-1", "Upper Egypt 1", "MN1", "Minia 1", [cell(60, 3_000, 3_000), cell(12, 840, 800), cell(3, 240, null)]),
    areaRow("NW", "New Valley", "NV1", "New Valley 1", [cell(7, 350, null), cell(0, 0, null), cell(0, 0, null)]),
    areaRow("OT", "Others", "LX1", "Luxor", [cell(48, 1_920, 1_000), cell(5, 375, 300), cell(1, 80, null)]),
  ]);
  const review = buildClosingPerformanceReview({
    availableLines: ["Pedia"],
    availablePeriods: ["2026-08", "2026-09"],
    generatedAt: "2026-10-26T09:00:00.000Z",
    matrix: september,
    seatAssignments: new Map(),
    seriesMatrices: [
      { matrix: august, period: "2026-08" },
      { matrix: september, period: "2026-09" },
    ],
  });

  // ── (1) One row per (rep, area), under the selected month's region ────────────────────────────
  const grid = review.productUnitsByRepByMonth;
  const areaRows = grid.rows.filter((entry) => entry.kind === "area");
  for (const code of ["CA1", "MN1", "LX1", "NV1"]) {
    assert.equal(
      areaRows.filter((entry) => entry.areaCode === code).length,
      1,
      `${code} is ONE row — an area that changed region is never printed once per region it has sat in`,
    );
  }
  assert.equal(
    areaRows.find((entry) => entry.areaCode === "MN1")?.regionName,
    "Upper Egypt 1",
    "Minia 1 sits under September's region, not August's",
  );
  assert.equal(areaRows.find((entry) => entry.areaCode === "LX1")?.regionName, "Others", "and so does Luxor");
  assert.ok(
    !grid.rows.some(
      (entry) => entry.kind === "regionSubtotal" && (entry.regionCode === "UE" || entry.regionCode === "UE-2"),
    ),
    "a region only August carried has no subtotal of its own — its areas have moved on",
  );

  // ── (2) The bottom row equals the closing's own units, per product, in every month ─────────────
  const national = grid.rows[grid.rows.length - 1];
  assert.equal(national.kind, "grandTotal", "the grid closes with the national row");
  COLUMNS.forEach((column, productIndex) => {
    assert.deepEqual(
      national.units[productIndex],
      [august.grandTotal.cells[productIndex].salesUnits, september.grandTotal.cells[productIndex].salesUnits],
      `the national row of ${column.productCode} equals each month's closing units — never a moved area twice`,
    );
  });
  assert.equal(national.units[0][1], 215, "September TB001: 100 + 60 + 7 + 48, the closing's own total");

  // ── (3) "Growth by month · area" names the selected month's region ────────────────────────────
  assert.equal(
    review.areaValueByMonth.find((entry) => entry.key === "MN1")?.subLabel,
    "Upper Egypt 1",
    "the area tab labels Minia 1 with September's region",
  );
  assert.equal(
    review.areaValueByMonth.find((entry) => entry.key === "LX1")?.subLabel,
    "Others",
    "and Luxor with Others, where September puts it",
  );
  assert.equal(review.areaValueByMonth.length, 4, "and still lists each area once");

  // ── (4) Growth off a base of zero or below is a dash; an empty base is still "new" ─────────────
  assert.equal(
    areaRows.find((entry) => entry.areaCode === "LX1")?.growth[0],
    GROWTH_NO_BASE,
    "48 units over −1 is no growth figure at all — it printed −4938.9%",
  );
  assert.equal(
    areaRows.find((entry) => entry.areaCode === "MN1")?.growth[2],
    GROWTH_NO_BASE,
    "a product that sold zero the month before has no base either",
  );
  assert.equal(
    areaRows.find((entry) => entry.areaCode === "NV1")?.growth[0],
    null,
    "an area with nothing on record the month before is still \"new\"",
  );
  assert.equal(reviewGrowthOf([-1, 48]), GROWTH_NO_BASE, "the shared rule: a negative base is no base");
  assert.equal(reviewGrowthOf([0, 5]), GROWTH_NO_BASE, "a zero base is no base");
  assert.equal(reviewGrowthOf([null, 5]), null, "a missing month is new");
  assert.equal(reviewGrowthOf([5]), null, "one month alone is new");
  assert.equal(reviewGrowthOf([100, 150]), 0.5, "a real base still gives the ratio");

  // ── (5) The emitted workbook says the same thing ───────────────────────────────────────────────
  const buffer = await buildClosingPerformanceReviewWorkbook(review);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(PRODUCT_MONTH_SHEET_NAME);
  assert.ok(sheet, "the workbook carries the Reps · Products by Month sheet");
  const rowsHolding = (text: string) => {
    const found: unknown[][] = [];
    sheet.eachRow((current) => {
      const values = (current.values as unknown[]).slice(1);
      if (values.some((value) => typeof value === "string" && value.includes(text))) found.push(values);
    });
    return found;
  };
  assert.equal(rowsHolding("Minia 1").length, 1, "the emitted sheet prints Minia 1 once");
  const nationalRow = rowsHolding("NATIONAL TOTAL")[0];
  assert.ok(nationalRow, "the emitted sheet closes with NATIONAL TOTAL");
  assert.ok(nationalRow.includes(215), "its September TB001 cell is the closing's 215");
  assert.ok(!nationalRow.includes(275), "never the 275 that adding Minia 1 twice gave");
  const luxorRow = rowsHolding("Luxor")[0];
  assert.ok(luxorRow?.includes(EM), "Luxor's growth off −1 is emitted as a dash");
  assert.ok(
    !luxorRow.some((value) => typeof value === "number" && value < -1),
    "and never as a ratio like −49.39",
  );
}
