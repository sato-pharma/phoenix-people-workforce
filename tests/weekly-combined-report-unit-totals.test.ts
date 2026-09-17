import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildBatchesExportWorkbook,
  type BatchProductItem,
  type BatchSummaryItem,
} from "../src/lib/sales/weekly/export-batches-workbook.ts";

// 🔴 THE WEEKLY SALES COMBINED REPORT'S TOTAL ROWS ADDED STOCK ACROSS WEEKS AND UNITS ACROSS PRODUCTS —
// found 2026-09-17.
//
// The upload screen's Combined Report has a Summary sheet (one row per selected upload period) and one
// sheet per period (one row per product). Both TOTAL rows added Net Units and Stock Units. Stock is a
// snapshot of one week, so the Summary counted the same stock once per period; and every unit TOTAL
// added different products, which are never added (unit-totals.ts). The owner chose blank (2026-09-17):
// the unit TOTALs are empty, and Sales Value (and the Summary's Rows) still add up.
//
// A PERIOD'S OWN Net and Stock Units add every product that upload carried, too. The owner chose a dash
// (2026-09-17): a period row prints its units only while the upload holds ONE product.
//
// Judged on the EMITTED file (written, then read back), never on the rows handed to the builder.

const PERIODS: BatchSummaryItem[] = [
  {
    id: "batch-week-1",
    distributorCode: "SD1",
    distributorName: "Sample Distributor",
    weekStart: "2026-09-06",
    status: "published",
    totalRows: 10,
    totalNetQty: 200,
    totalSalesValue: 8000,
    totalStockQty: 65,
  },
  {
    id: "batch-week-2",
    distributorCode: "SD1",
    distributorName: "Sample Distributor",
    weekStart: "2026-09-13",
    status: "published",
    totalRows: 12,
    totalNetQty: 160,
    totalSalesValue: 6500,
    totalStockQty: 50,
  },
  {
    id: "batch-week-0",
    distributorCode: "SD1",
    distributorName: "Sample Distributor",
    weekStart: "2026-08-30",
    status: "published",
    totalRows: 4,
    totalNetQty: 90,
    totalSalesValue: 4500,
    totalStockQty: 35,
  },
];

const PRODUCTS = new Map<string, BatchProductItem[]>([
  [
    "batch-week-1",
    [
      { productCode: "P1", productName: "Product One 500 mg", netQty: 120, salesValue: 6000, stockQty: 40 },
      { productCode: "P2", productName: "Product Two 250 mg", netQty: 80, salesValue: 2000, stockQty: 25 },
    ],
  ],
  [
    "batch-week-2",
    [
      { productCode: "P1", productName: "Product One 500 mg", netQty: 100, salesValue: 5000, stockQty: 30 },
      { productCode: "P2", productName: "Product Two 250 mg", netQty: 60, salesValue: 1500, stockQty: 20 },
    ],
  ],
  // The one-product upload: its own units are one product's, so they print.
  ["batch-week-0", [{ productCode: "P1", productName: "Product One 500 mg", netQty: 90, salesValue: 4500, stockQty: 35 }]],
]);

async function combinedReport(): Promise<ExcelJS.Workbook> {
  const buffer = await buildBatchesExportWorkbook(PERIODS, PRODUCTS, "2026-09-17 08:00 UTC");
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer as unknown as Parameters<typeof loaded.xlsx.load>[0]);
  return loaded;
}

/** The row whose first cell reads `label` — the table's header ("Period"/"Product") or its TOTAL row. */
function rowStartingWith(sheet: ExcelJS.Worksheet, label: string): number {
  let found = 0;
  sheet.eachRow((row, number) => {
    if (!found && row.getCell(1).value === label) found = number;
  });
  assert.ok(found > 0, `sheet "${sheet.name}" has a row starting "${label}"`);
  return found;
}

function columnOf(sheet: ExcelJS.Worksheet, headerRow: number, label: string): number {
  let found = 0;
  sheet.getRow(headerRow).eachCell((cell, col) => {
    if (cell.value === label) found = col;
  });
  assert.ok(found > 0, `sheet "${sheet.name}" has a "${label}" column`);
  return found;
}

/** A TOTAL cell that must hold no figure: no number, no formula, nothing but an empty cell. */
function assertEmptyTotal(cell: ExcelJS.Cell, message: string) {
  assert.ok(
    cell.formula === undefined && (cell.value === null || cell.value === ""),
    `${message} (found ${cell.formula ? `=${cell.formula}` : JSON.stringify(cell.value)})`,
  );
  assert.equal(cell.alignment?.horizontal, "right", `${cell.address}: the empty unit TOTAL stays right-aligned`);
}

export async function runWeeklyCombinedReportUnitTotalsTests() {
  const workbook = await combinedReport();

  // ── Summary: one row per upload period ──────────────────────────────────────────────────────────
  const summary = workbook.getWorksheet("Summary");
  assert.ok(summary, 'the Combined Report has a "Summary" sheet');
  const summaryHeader = rowStartingWith(summary, "Period");
  const summaryTotal = summary.getRow(rowStartingWith(summary, "TOTAL"));
  const netUnits = columnOf(summary, summaryHeader, "Net Units");
  const salesValue = columnOf(summary, summaryHeader, "Sales Value (EGP)");
  const stockUnits = columnOf(summary, summaryHeader, "Stock Units");
  const rows = columnOf(summary, summaryHeader, "Rows");

  // A period row's units print only for a one-product upload. The two-product periods hold a dash, and
  // the one-product period is the positive control, so the check cannot pass by dashing every row. The
  // report lists the newest period first, and the TOTAL row sits right under the last period.
  const periodRows = [summaryHeader + 1, summaryHeader + 2, summaryHeader + 3].map((n) => summary.getRow(n));
  assert.deepEqual(
    periodRows.map((row) => [row.getCell(netUnits).value, row.getCell(stockUnits).value]),
    [["—", "—"], ["—", "—"], [90, 35]],
    "Combined Report Summary: a period that holds two products must not print its units added together",
  );
  for (const row of periodRows) {
    assert.equal(row.getCell(netUnits).alignment?.horizontal, "right", `${row.getCell(netUnits).address}: Net Units stays right-aligned`);
    assert.equal(row.getCell(stockUnits).alignment?.horizontal, "right", `${row.getCell(stockUnits).address}: Stock Units stays right-aligned`);
  }
  assert.deepEqual(
    periodRows.map((row) => row.getCell(salesValue).value),
    [6500, 8000, 4500],
    "every period still prints its Sales Value",
  );
  assert.equal(summaryTotal.number, summaryHeader + 4, "the Summary's TOTAL row sits under the last period");

  // Sales Value and Rows are flows and counts: they still add up.
  assert.equal(summaryTotal.getCell(salesValue).value, 19000, "the Summary's Sales Value TOTAL adds the periods");
  assert.equal(summaryTotal.getCell(rows).value, 26, "the Summary's Rows TOTAL adds the periods");

  assertEmptyTotal(
    summaryTotal.getCell(stockUnits),
    "Combined Report Summary: the Stock Units TOTAL must not add stock across periods",
  );
  assertEmptyTotal(
    summaryTotal.getCell(netUnits),
    "Combined Report Summary: the Net Units TOTAL must not add units of different products",
  );

  // ── One sheet per period: one row per product ───────────────────────────────────────────────────
  const periodSheets = workbook.worksheets.filter((sheet) => sheet.name !== "Summary");
  assert.equal(periodSheets.length, PERIODS.length, "one sheet per selected period");
  for (const sheet of periodSheets) {
    const header = rowStartingWith(sheet, "Product");
    const total = sheet.getRow(rowStartingWith(sheet, "TOTAL"));
    const sheetNet = columnOf(sheet, header, "Net Units");
    const sheetValue = columnOf(sheet, header, "Sales Value (EGP)");
    const sheetStock = columnOf(sheet, header, "Stock Units");
    const productCount = total.number - header - 1;
    assert.ok(productCount >= 1, `sheet "${sheet.name}": lists its products`);
    const productRows = Array.from({ length: productCount }, (_, i) => sheet.getRow(header + 1 + i));

    assert.ok(
      productRows.every((row) => typeof row.getCell(sheetNet).value === "number" && typeof row.getCell(sheetStock).value === "number"),
      `sheet "${sheet.name}": each product still prints its own Net Units and Stock Units`,
    );
    const valueOfProducts = productRows.reduce((s, row) => s + Number(row.getCell(sheetValue).value), 0);
    assert.equal(total.getCell(sheetValue).value, valueOfProducts, `sheet "${sheet.name}": the Sales Value TOTAL adds its products`);

    assertEmptyTotal(
      total.getCell(sheetNet),
      `Combined Report period sheet "${sheet.name}": the Net Units TOTAL must not add units of different products`,
    );
    assertEmptyTotal(
      total.getCell(sheetStock),
      `Combined Report period sheet "${sheet.name}": the Stock Units TOTAL must not add stock of different products`,
    );
  }
}
