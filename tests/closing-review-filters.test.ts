import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildClosingPerformanceReview,
  type AreaSeatAssignment,
  type ClosingPerformanceReview,
} from "../src/lib/sales/closing-performance-review.ts";
import {
  buildClosingPerformanceReviewWorkbook,
  headlinePeriodLabel,
  scopeLabel,
} from "../src/lib/sales/closing-performance-review-export.ts";
import { monthlyClosingFilterOptions } from "../src/lib/sales/monthly-closing-filter-options.ts";
import { parseCodeList } from "../src/lib/sales/monthly-closing-period-merge.ts";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingAreaRow,
  type MonthlyClosingCell,
  type MonthlyClosingColumn,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// A FILTER MUST NARROW WHAT IS SHOWN, NEVER WHAT CAN BE CHOSEN — AND A FILTERED
// OR MULTI-MONTH EXPORT MUST SAY SO ON ITS FACE.
//
// The Performance Review filters on the SERVER, because it is six views derived from the matrix and
// narrowing them in the browser would leave a rank of "3rd of 50" printed above four rows. That
// choice creates a trap the Monthly Closing screen does not have: the payload the browser gets back
// holds only the rows that SURVIVED, so a picker built from it offers only what is already selected.
// Filter to Cairo and Others vanishes from the very control that is supposed to let you switch to
// it — the reader is locked in with no visible way out but Reset. Assertion (1) is that trap.
//
// The other half is the owner's export rule: a file must match the screen, and what is left out is
// LABELLED rather than silently dropped. Two ways to break it here, both of which produce a
// perfectly plausible-looking workbook:
//
//   * `review.period` is the LATEST month of a selection, so a three-month total labelled from it
//     reads "September 2026" — one month's name over three months of money (assertion 3).
//   * A workbook narrowed to one region looks exactly like the whole line, just smaller
//     (assertion 4).

const DOT = String.fromCharCode(0x00b7);

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
  isDirect?: boolean,
): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells, isDirect, kind: "area", regionCode, regionName, rowTotal: total(cells) };
}

/**
 * Two regions, three areas.
 *
 * Dakahlia 1 carries `isDirect` while keeping its own real code and name — July 2026's direct orders
 * were restated to area grain, so a real area holding direct money is the normal case and must stay
 * offerable. The synthetic company row is the one that is not an area at all: no geography, and the
 * areaCode "DIRECT" the injector stamps on it.
 */
function matrixFor(period: string, scale: number): MonthlyClosingMatrix {
  const cairo = areaRow("CA", "Cairo", "CA1", "Cairo 1", [
    cell(100 * scale, 5_000 * scale, 6_000),
    cell(40 * scale, 3_000 * scale, 2_000),
    cell(10 * scale, 900 * scale, 1_000),
  ]);
  const dakahlia = areaRow(
    "DL",
    "Delta",
    "D21",
    "Dakahlia 1",
    [cell(30 * scale, 1_500 * scale, 1_800), cell(0, 0, null), cell(4 * scale, 260 * scale, 300)],
    true,
  );
  const companyDirect = areaRow(
    "DL",
    "Delta",
    "DIRECT",
    "Direct orders (company)",
    [cell(9 * scale, 400 * scale, null), cell(0, 0, null), cell(0, 0, null)],
    true,
  );

  const delta = [dakahlia, companyDirect];
  const deltaCells = COLUMNS.map((_column, index) => total(delta.map((row) => row.cells[index])));
  const grandCells = COLUMNS.map((_column, index) =>
    total([cairo, ...delta].map((row) => row.cells[index])),
  );

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
        subtotal: {
          cells: cairo.cells,
          kind: "regionSubtotal",
          regionCode: "CA",
          regionName: "Cairo",
          rowTotal: cairo.rowTotal,
        },
      },
      {
        areas: delta,
        regionCode: "DL",
        regionName: "Delta",
        subtotal: {
          cells: deltaCells,
          kind: "regionSubtotal",
          regionCode: "DL",
          regionName: "Delta",
          rowTotal: total(deltaCells),
        },
      },
    ],
  };
}

const SEATS = new Map<string, AreaSeatAssignment>([
  ["cns::CA1", { managerName: "Hany Adel", repIsVacant: false, repName: "Mostafa Kamel" }],
  ["cns::D21", { managerName: "Sherif Nabil", repIsVacant: false, repName: "Amr Fathy" }],
]);

/**
 * A review built the way the loader builds one: the matrix is FILTERED, the options are not.
 *
 * `selectedPeriods` is passed explicitly, exactly as `loadMergedMonthlyClosingParts` reports it.
 */
function reviewOf(options: {
  filter?: { areaCodes?: string[]; productCodes?: string[]; regionCodes?: string[]; search?: string };
  selectedPeriods: string[];
}): ClosingPerformanceReview {
  const unfiltered = matrixFor("2026-09", 2);
  // The same narrowing the loader applies — to the headline matrix AND to every month of the
  // series. Leaving the series unfiltered leaks the excluded areas straight back into the by-month
  // sheets, which is what assertion (4)'s "genuinely absent" check catches.
  const narrow = (matrix: MonthlyClosingMatrix) =>
    options.filter
      ? filterMonthlyClosingMatrix(matrix, {
          areaCodes: options.filter.areaCodes ?? [],
          productCodes: options.filter.productCodes ?? [],
          regionCodes: options.filter.regionCodes ?? [],
          search: options.filter.search ?? "",
        })
      : matrix;
  const matrix = narrow(unfiltered);
  return buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08", "2026-09"],
    // From the UNFILTERED matrix — this is the line under test in assertion (1).
    filterOptions: monthlyClosingFilterOptions(unfiltered),
    generatedAt: "2026-08-27T00:00:00.000Z",
    matrix,
    seatAssignments: SEATS,
    selectedPeriods: options.selectedPeriods,
    seriesMatrices: [
      { matrix: null, period: "2026-07" },
      { matrix: narrow(matrixFor("2026-08", 1)), period: "2026-08" },
      { matrix, period: "2026-09" },
    ],
  });
}

/** Every string the workbook renders, rich-text runs flattened, across every sheet. */
async function workbookText(buffer: Buffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const text: string[] = [];
  workbook.eachSheet((sheet) => {
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
  return text;
}

export async function runClosingReviewFilterTests() {
  // ── (1) HEADLINE · a filter narrows the ROWS, never the CHOICES ──
  //
  // Narrowed to Cairo. The rows must hold Cairo alone; the pickers must still offer Delta, or the
  // reader cannot switch to it.
  const cairoOnly = reviewOf({ filter: { regionCodes: ["CA"] }, selectedPeriods: ["2026-09"] });

  assert.deepEqual(
    cairoOnly.regions.map((group) => group.regionCode),
    ["CA"],
    "the filter really did narrow the rows, so the check below is not passing on an unfiltered payload",
  );
  assert.deepEqual(
    cairoOnly.filterOptions.regions.map((option) => option.code).sort(),
    ["CA", "DL"],
    "the Regions picker still offers Delta after filtering to Cairo - options come from the unfiltered matrix, never from the rows that survived",
  );
  assert.ok(
    cairoOnly.filterOptions.areas.some((option) => option.code === "D21"),
    "and the Areas picker still offers Dakahlia 1, which the Cairo filter has just removed from the screen",
  );

  // The same must hold for a product filter: narrowing to one product must not empty the product picker.
  const oneProduct = reviewOf({ filter: { productCodes: ["TB001"] }, selectedPeriods: ["2026-09"] });
  assert.equal(oneProduct.matrixByProduct.columns.length, 1, "the product filter narrowed the grid to one column");
  assert.deepEqual(
    oneProduct.filterOptions.products.map((option) => option.code).sort(),
    ["SS001", "TB001", "TB002"],
    "while the Products picker still offers all three",
  );

  // ── (2) What may be offered as an area ──
  const options = monthlyClosingFilterOptions(matrixFor("2026-09", 1));
  const areaCodes = options.areas.map((option) => option.code).sort();
  assert.deepEqual(
    areaCodes,
    ["CA1", "D21"],
    "a real area carrying direct money stays offerable and the synthetic company Direct row does not - reading the raw isDirect flag would drop Dakahlia 1 out of the picker entirely",
  );
  assert.deepEqual(
    options.areas.find((option) => option.code === "D21")?.regionCode,
    "DL",
    "every area carries its region, so the Areas picker can narrow itself when a region is chosen",
  );
  assert.deepEqual(monthlyClosingFilterOptions(null).areas, [], "no matrix offers nothing rather than throwing");

  // ── (3) A multi-month total is never labelled with one of its months ──
  const span = reviewOf({ selectedPeriods: ["2026-07", "2026-08", "2026-09"] });
  assert.equal(span.period, "2026-09", "the review still reports the latest month as its period, as every caller expects");
  assert.equal(
    headlinePeriodLabel(span),
    "3 months " + DOT + " July 2026 to September 2026",
    "and the headline sheets name the whole span, never the latest month alone",
  );
  assert.equal(
    headlinePeriodLabel(reviewOf({ selectedPeriods: ["2026-08", "2026-09"] })),
    "August 2026 and September 2026",
    "two months are joined by name",
  );
  assert.equal(
    headlinePeriodLabel(reviewOf({ selectedPeriods: ["2026-09"] })),
    "September 2026",
    "and a single month reads exactly as it always has",
  );

  const spanText = await workbookText(await buildClosingPerformanceReviewWorkbook(span));
  assert.ok(
    spanText.some((entry) => entry.includes("July 2026 to September 2026")),
    "the span reaches the workbook itself, not just the label helper",
  );
  assert.ok(
    !spanText.includes("CNS " + DOT + " National " + DOT + " September 2026"),
    "and the national heading is NOT the single-month wording - that exact string over three months of money is the mislabelling this guards",
  );
  assert.ok(
    spanText.includes("CNS " + DOT + " National " + DOT + " 3 months " + DOT + " July 2026 to September 2026"),
    "it names all three months instead",
  );

  // ── (4) A narrowed workbook says what it left out ──
  assert.equal(
    scopeLabel(reviewOf({ selectedPeriods: ["2026-09"] })),
    "",
    "an unfiltered workbook says nothing about scope, so its wording is untouched",
  );
  assert.equal(
    scopeLabel(cairoOnly),
    "filtered " + DOT + " 1 of 2 areas",
    "a workbook narrowed to one region states how many areas of the line it actually holds",
  );
  assert.equal(
    scopeLabel(oneProduct),
    "filtered " + DOT + " 1 of 3 products",
    "and a product filter is stated in products",
  );

  const cairoText = await workbookText(await buildClosingPerformanceReviewWorkbook(cairoOnly));
  assert.ok(
    cairoText.some((entry) => entry.includes("filtered " + DOT + " 1 of 2 areas")),
    "the scope reaches the workbook, so a filtered file cannot be mistaken for the whole line",
  );
  assert.ok(
    !cairoText.some((entry) => entry.includes("Dakahlia")),
    "and the filtered-out area is genuinely absent from the file, not merely hidden on screen",
  );

  // ── (5) The export POST sends arrays; the query string sends commas; both must read the same ──
  assert.deepEqual(
    parseCodeList(["CA1", "D21"]),
    parseCodeList("CA1,D21"),
    "an array body and a comma query produce the same filter - otherwise a workbook is narrowed differently from the screen that asked for it",
  );
  assert.deepEqual(parseCodeList(["  D21 ", "", "CA1", "D21"]), ["CA1", "D21"], "an array is trimmed, de-duplicated and ordered too");
  assert.deepEqual(parseCodeList(["CA1,D21"]), ["CA1", "D21"], "and an array holding a comma-joined entry still splits");
  assert.deepEqual(parseCodeList([]), [], "an empty array is an empty filter, never a filter on one blank code");
  assert.deepEqual(parseCodeList(undefined), [], "and a missing value is an empty filter");
}
