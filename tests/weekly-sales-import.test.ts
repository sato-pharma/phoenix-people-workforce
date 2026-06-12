import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";

// Synthetic master with KNOWN factory prices so we can prove the value is RECOMPUTED (Qty × price)
// and the sheet's own Sales Value column is ignored. Region pairs resolve the weekly Region IDs.
const PRICES: Record<string, number> = { SA001: 10, RO001: 20, IV001: 5, SS001: 8 };

function references(): SalesReferenceData {
  return {
    distributors: [{ code: "IS-S", name: "Ibn Sina-Sato" }],
    products: Object.entries(PRICES).map(([productCode, factoryPrice]) => ({
      productCode,
      productName: productCode === "RO001" ? "ROYAFLOXACIN 500 TAB" : productCode,
      factoryPrice,
      family: "",
      familyCode: "",
      line: productCode === "SA001" ? "CNS" : "Anti infective",
      source: "Sato",
    })),
    regions: [
      ["CA", "Cairo"],
      ["GZ", "Giza"],
      ["UE", "Upper Egypt"],
      ["AB", "Alex-BHR"],
      ["D1", "Delta (1)"],
    ].map(([regionCode, regionName]) => ({ areaCode: `${regionCode}1`, areaName: regionName, regionCode, regionName })),
  };
}

// Header mirrors the real Ibn Sina Sato "SalesAndStockReport2_DataHub" export.
const HEADER = [
  "Date", "Supplier Code", "Supplier Name", "Item Code", "Item name", "Branch Code", "Branch Name",
  "Stock", "Stock Value", "Sales Quantity", "Sales Value", "Total Sales", "Region ID", "Product ID", "Distrub ID",
];

// One sheet row. The "Sales Value" (col 11) is deliberately a WRONG number to prove it is ignored.
function row(opts: {
  date: Date;
  itemCode: string;
  itemName: string;
  branch: string;
  stock: number;
  qty: number;
  region: string;
  productId: string;
}): unknown[] {
  return [
    opts.date, "110476", "SATO", opts.itemCode, opts.itemName, "61", opts.branch,
    opts.stock, 9999, opts.qty, 123456 /* bogus sheet value */, opts.qty, opts.region, opts.productId, "IS-S",
  ];
}

async function workbook(rows: unknown[][]): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("SalesAndStockReport2_DataHub");
  sheet.addRow(HEADER);
  rows.forEach((r) => sheet.addRow(r));
  return wb.xlsx.writeBuffer();
}

const round2 = (value: number) => Number(value.toFixed(2));

export async function runWeeklySalesImportTests() {
  const week = new Date(Date.UTC(2025, 7, 1)); // 2025-08-01

  const buffer = await workbook([
    row({ date: week, itemCode: "667913", itemName: "SAGINKGO 30 CAP", branch: "Cairo A", stock: 30, qty: 7, region: "CA", productId: "SA001" }),
    row({ date: week, itemCode: "631910", itemName: "SAGINKGO 30 CAP(OLD PRICE)", branch: "Giza B", stock: 20, qty: 5, region: "GZ", productId: "SA001" }),
    row({ date: week, itemCode: "607294", itemName: "ROYAFLOXACIN 500 TAB", branch: "Upper C", stock: 50, qty: 4, region: "UE", productId: "RO001" }),
    row({ date: week, itemCode: "635171", itemName: "IVYRONC 100ML SYRUP", branch: "Alex D", stock: 12, qty: 3, region: "AB", productId: "IV001" }),
    // #N/A Product ID whose item name ALSO has no master match → unmapped, value 0, warning.
    row({ date: week, itemCode: "638105", itemName: "ROYANOXICAM 8MG 20 TAB", branch: "Delta E", stock: 23, qty: 2, region: "D1", productId: "#N/A" }),
    // Stock on hand, zero sales (drives the zero-sales-branch view).
    row({ date: week, itemCode: "639912", itemName: "SATOSLIM 30 CAP", branch: "Cairo A", stock: 16, qty: 0, region: "CA", productId: "SS001" }),
  ]);

  const parsed = await parseWeeklyWorkbookBuffer({
    buffer,
    distributorCode: "IS-S",
    distributorName: "Ibn Sina-Sato",
    fileName: "IS-S_week.xlsx",
    references: references(),
  });
  assert.equal(parsed.ok, true, "weekly file parses");
  if (!parsed.ok) return;
  const { result, rows } = parsed;

  // Week key comes from the Date column inside the sheet (not the file name).
  assert.equal(result.weekStart, "2025-08-01", "week_start from sheet Date column");
  assert.equal(result.status, "validated", "single week, no blocking");
  assert.equal(result.rowCount, 6);

  // Stock is captured as UNITS (sum of all stock cells).
  assert.equal(result.totals.stockQty, 30 + 20 + 50 + 12 + 23 + 16);

  // Value RECOMPUTED from factory price, NOT the bogus sheet "Sales Value" (123456).
  const sa = result.byProduct.find((product) => product.productCode === "SA001");
  assert.ok(sa, "SA001 present");
  assert.equal(sa?.salesQty, 12, "SA001 units = 7 + 5 (both Product IDs map to SA001)");
  assert.equal(sa?.salesValue, round2(12 * PRICES.SA001), "SA001 value = units × factory price");

  // Per-row: value = qty × price × (1 - discount); the sheet value never leaks in.
  for (const r of rows) {
    assert.equal(round2(r.salesValue), round2(r.salesQty * (PRICES[r.productCode] ?? 0) * (1 - r.discount)));
    assert.notEqual(r.salesValue, 123456, "sheet Sales Value ignored");
  }

  // Region consolidation reconciles to the total.
  const regionSum = round2(result.byRegion.reduce((acc, region) => acc + region.salesValue, 0));
  assert.equal(regionSum, result.totals.salesValue, "region split reconciles to total");
  assert.ok(result.byRegion.some((region) => region.regionName === "Cairo"), "region code resolved to name");

  // Unmapped #N/A product → value 0 + warning, never a crash or a guessed price.
  const unmapped = rows.find((r) => r.rawRow.itemName === "ROYANOXICAM 8MG 20 TAB");
  assert.ok(unmapped, "unmapped row present");
  assert.equal(unmapped?.salesValue, 0, "unmapped product value is 0");
  assert.equal(unmapped?.validationState, "warning", "unmapped product flagged");

  // Multi-week guard: two distinct dates in one file → blocked (one week per file).
  const multi = await parseWeeklyWorkbookBuffer({
    buffer: await workbook([
      row({ date: new Date(Date.UTC(2025, 6, 5)), itemCode: "667913", itemName: "SAGINKGO 30 CAP", branch: "Cairo A", stock: 30, qty: 7, region: "CA", productId: "SA001" }),
      row({ date: new Date(Date.UTC(2025, 6, 12)), itemCode: "667913", itemName: "SAGINKGO 30 CAP", branch: "Cairo A", stock: 28, qty: 9, region: "CA", productId: "SA001" }),
    ]),
    distributorCode: "IS-S",
    distributorName: "Ibn Sina-Sato",
    fileName: "two-weeks.xlsx",
    references: references(),
  });
  assert.equal(multi.ok, true);
  if (multi.ok) assert.equal(multi.result.status, "blocked", "two weeks in one file is blocked");

  // Unknown distributor → recognised as having no weekly template (not a silent empty result).
  const unsupported = await parseWeeklyWorkbookBuffer({
    buffer,
    distributorCode: "ZZ",
    distributorName: "Unknown",
    fileName: "x.xlsx",
    references: references(),
  });
  assert.equal(unsupported.ok, false, "unknown distributor has no weekly template");
  if (!unsupported.ok) assert.equal(unsupported.error.code, "unsupported_template");
}
