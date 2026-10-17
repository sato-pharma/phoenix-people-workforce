import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { PortalWeeklyScopeView } from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import { buildPortalWeeklyWorkbook } from "../src/lib/sales/weekly/portal-weekly-export.ts";
import type { WeeklyDashboard } from "../src/lib/sales/weekly/types.ts";
import { sampleDashboard } from "./weekly-export-workbook.test.ts";

// 🔴 THE WEEK COMPARISON'S TOTAL ROW ADDED STOCK ACROSS WEEKS — found 2026-09-17.
//
// The managers' Weekly Sales export has a Week Comparison sheet with one row per week, and
// addPhoenixTableSheet appends a TOTAL row that SUMs every numeric column. Sales Value and Sales Units
// are flows, so their weeks add up. Stock Units is not: each week's figure is a snapshot of what is on
// hand, so the SUM counted the same stock once per week — the multiplication service.ts's
// latestStockOnly exists to keep off the screen. The column now stays out of the TOTAL row and its TOTAL
// cell is empty: a row labelled TOTAL must not show one week's stock either.
//
// Judged on the EMITTED file (written, then read back), never on the rows handed to the builder.

const SCOPE: PortalWeeklyScopeView = {
  role: "National Sales Manager",
  visibility: { month: true, weekNumber: true, line: false, region: true, product: true, distributor: true },
  scopeSummary: "Anti Infective · every region",
  isSingleRegion: false,
  canDownloadNsmDsmExport: true,
};

const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;

/**
 * The sample dashboard with a filter pinned to ONE product, so the Week Comparison carries its unit
 * columns (unit-totals.ts), and stock on hand in both of its weeks.
 */
function onePinnedProductWithTwoStockWeeks(): WeeklyDashboard {
  const base = sampleDashboard();
  const [first, second] = base.weekComparison;
  assert.ok(first && second, "fixture: the sample dashboard compares two weeks");
  return {
    ...base,
    kpis: { ...base.kpis, productCount: 1 },
    products: base.products.slice(0, 1),
    appliedFilters: { ...base.appliedFilters, productCode: "SAG", productCodes: ["SAG"] },
    weekComparison: [
      { ...first, stockUnits: 40 },
      { ...second, stockUnits: 30 },
    ],
  };
}

async function weekComparisonSheet(data: WeeklyDashboard): Promise<ExcelJS.Worksheet> {
  const buffer = await buildPortalWeeklyWorkbook(data, SCOPE).xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer as unknown as Parameters<typeof loaded.xlsx.load>[0]);
  const sheet = loaded.getWorksheet("Week Comparison");
  assert.ok(sheet, 'the export has a "Week Comparison" sheet');
  return sheet;
}

function columnOf(sheet: ExcelJS.Worksheet, label: string): number {
  let found = 0;
  sheet.getRow(HEADER_ROW).eachCell((cell, col) => {
    if (cell.value === label) found = col;
  });
  assert.ok(found > 0, `the Week Comparison has a "${label}" column`);
  return found;
}

export async function runWeeklyWeekComparisonStockTotalTests() {
  const data = onePinnedProductWithTwoStockWeeks();
  const sheet = await weekComparisonSheet(data);
  const weeks = data.weekComparison.length;
  const lastWeekRow = FIRST_DATA_ROW + weeks - 1;
  const totalRow = sheet.getRow(lastWeekRow + 1);

  const salesValue = columnOf(sheet, "Sales Value (EGP)");
  const salesUnits = columnOf(sheet, "Sales Units");
  const stockUnits = columnOf(sheet, "Stock Units");
  const letter = (col: number) => sheet.getColumn(col).letter;
  const sumOfTheWeeks = (col: number) => `SUM(${letter(col)}${FIRST_DATA_ROW}:${letter(col)}${lastWeekRow})`;

  // Positive controls: the TOTAL row sits under the last week, and both weeks really print stock, so the
  // checks below cannot pass on a sheet too thin to break.
  assert.equal(totalRow.getCell(1).value, "TOTAL", "the TOTAL row sits under the last week");
  assert.deepEqual(
    [sheet.getRow(FIRST_DATA_ROW).getCell(stockUnits).value, sheet.getRow(lastWeekRow).getCell(stockUnits).value],
    [40, 30],
    "each week still prints its own stock on hand",
  );

  // Sales are flows: their TOTAL is still the live SUM of the weeks above it.
  assert.equal(totalRow.getCell(salesValue).formula, sumOfTheWeeks(salesValue), "Sales Value's TOTAL is the SUM of its weeks");
  assert.equal(totalRow.getCell(salesUnits).formula, sumOfTheWeeks(salesUnits), "Sales Units' TOTAL is the SUM of its weeks");

  // Stock is a snapshot: its TOTAL cell holds no SUM, no other formula and no figure.
  const stockTotal = totalRow.getCell(stockUnits);
  assert.equal(
    stockTotal.formula,
    undefined,
    `Stock Units' TOTAL must not add the weeks' stock together (found =${stockTotal.formula})`,
  );
  assert.ok(
    stockTotal.value === null || stockTotal.value === "",
    `Stock Units' TOTAL is empty, never one week's stock under TOTAL (found ${JSON.stringify(stockTotal.value)})`,
  );

  // Nor does any other cell on the sheet add up the stock column by another route.
  const readsStock = new RegExp(`\\b${letter(stockUnits)}\\$?\\d+`);
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      const formula = cell.formula;
      if (formula) assert.ok(!readsStock.test(formula), `${cell.address} reads the Stock Units column: =${formula}`);
    });
  });

  // The column still reads as a number: right-aligned in its head and in every week.
  assert.equal(sheet.getRow(HEADER_ROW).getCell(stockUnits).alignment?.horizontal, "right", "the Stock Units head stays right-aligned");
  for (let row = FIRST_DATA_ROW; row <= lastWeekRow; row += 1) {
    assert.equal(
      sheet.getRow(row).getCell(stockUnits).alignment?.horizontal,
      "right",
      `week row ${row}'s stock stays right-aligned`,
    );
  }
}
