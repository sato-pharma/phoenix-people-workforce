import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";

// Synthetic master with KNOWN xfactor fallback values so we can prove the value is RECOMPUTED (Qty x xfactor)
// and the sheet's own Sales Value column is ignored. Region pairs resolve the weekly Region IDs.
const XFACTORS: Record<string, number> = { SA001: 10, RO001: 20, IV001: 5, SS001: 8, LA004: 100 };

function references(): SalesReferenceData {
  return {
    distributors: [{ code: "IS", name: "Ibn sina" }, { code: "PS", name: "overseas" }],
    products: Object.entries(XFACTORS).map(([productCode, factoryPrice]) => ({
      productCode,
      productName:
        productCode === "RO001"
          ? "ROYAFLOXACIN 500 TAB"
          : productCode === "LA004"
            ? "LACTO BASIC 30 CAP"
            : productCode === "SS001"
              ? "SATOSLIM"
              : productCode,
      factoryPrice,
      family: "",
      familyCode: "",
      line: productCode === "SA001" ? "CNS" : productCode === "LA004" ? "Lacto" : "Anti infective",
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

// Header mirrors the real Ibn Sina "SalesAndStockReport2_DataHub" export.
const HEADER = [
  "Date", "Supplier Code", "Supplier Name", "Item Code", "Item name", "Branch Code", "Branch Name",
  "Stock", "Stock Value", "Sales Quantity", "Sales Value", "Total Sales", "Region ID", "Product ID", "Distrub ID",
];

const XFACTOR_HEADER = [...HEADER, "XFactor"];

const PAS_RAW_HEADER = [
  "Date", "Supplier Code", "Supplier Name", "Item Code", "Item Name", "Branch Code", "Branch Name",
  "Stock", "Stock Value", "Sales Quantity", "Sales Value", "Total Sales",
];

const PAS_RAW_MIN_HEADER = [
  "Date", "Item Code", "Item Name", "Branch Code", "Branch Name",
  "Stock", "Stock Value", "Sales Quantity", "Sales Value", "Total Sales",
];

const PAS_RAW_NO_DATE_HEADER = [
  "Supplier Code", "Supplier Name", "Item Code", "Item Name", "Branch Code", "Branch Name",
  "Stock", "Stock Value", "Sales Quantity", "Sales Value", "Total Sales",
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
  xfactor?: number;
}): unknown[] {
  const cells = [
    opts.date, "110476", "SATO", opts.itemCode, opts.itemName, "61", opts.branch,
    opts.stock, 9999, opts.qty, 123456 /* bogus sheet value */, opts.qty, opts.region, opts.productId, "IS",
  ];
  if (opts.xfactor !== undefined) cells.push(opts.xfactor);
  return cells;
}

async function workbook(rows: unknown[][]): Promise<ExcelJS.Buffer> {
  return buildWeeklyWorkbook(HEADER, rows);
}

async function buildWeeklyWorkbook(header: readonly string[], rows: unknown[][]): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("SalesAndStockReport2_DataHub");
  sheet.addRow(header);
  rows.forEach((r) => sheet.addRow(r));
  return wb.xlsx.writeBuffer();
}

async function workbookPasRaw(rows: unknown[][]): Promise<ExcelJS.Buffer> {
  return buildWeeklyWorkbook(PAS_RAW_HEADER, rows);
}

async function workbookPasRawWithTitleAndMinimalHeader(rows: unknown[][]): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("SalesAndStockReport2_DataHub");
  const title = "Weekly Sales and stock For SATO PHARMA (PAS)  Sales and Stock";
  const titleCells = sheet.getRow(1);
  for (let col = 1; col <= PAS_RAW_MIN_HEADER.length; col += 1) {
    titleCells.getCell(col).value = { richText: [{ text: title }] };
  }
  sheet.addRow(PAS_RAW_MIN_HEADER);
  rows.forEach((row) => sheet.addRow(row));
  return wb.xlsx.writeBuffer();
}

async function workbookPasRawNoDate(rows: unknown[][]): Promise<ExcelJS.Buffer> {
  return buildWeeklyWorkbook(PAS_RAW_NO_DATE_HEADER, rows);
}

async function workbookOverseasPosMatrix(): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Data");
  sheet.addRow(["Phoenix overseas POS"]);
  sheet.addRow([
    "Mat. Group",
    "Date",
    "Mat. Group Desc.",
    "Mat. Code",
    "Mat. Desc.",
    "Product ID",
    "Retail Cairo_\u0643",
    "Super KA Delta_\u0643",
    "Total Qty.",
    "Bonus Qty.",
    "Total Val.",
  ]);
  sheet.addRow([
    "Lacto",
    new Date(Date.UTC(2026, 5, 6)),
    "Lacto Egypt",
    "1001",
    "LACTO BASIC 30 CAP",
    "LA004",
    5,
    -2,
    6,
    3,
    99999,
  ]);
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
    // #N/A Product ID whose item name ALSO has no master match — unmapped, value 0, warning.
    row({ date: week, itemCode: "638105", itemName: "ROYANOXICAM 8MG 20 TAB", branch: "Delta E", stock: 23, qty: 2, region: "D1", productId: "#N/A" }),
    // Blank Product ID can still resolve by item-name prefix after dropping "(OLD PRICE)".
    row({ date: week, itemCode: "639911", itemName: "SATOSLIM 30 CAP(OLD PRICE)", branch: "Cairo A", stock: 10, qty: 6, region: "CA", productId: "" }),
    // Stock on hand, zero sales (drives the zero-sales-branch view).
    row({ date: week, itemCode: "639912", itemName: "SATOSLIM 30 CAP", branch: "Cairo A", stock: 16, qty: 0, region: "CA", productId: "SS001" }),
  ]);

  const parsed = await parseWeeklyWorkbookBuffer({
    buffer,
    distributorCode: "IS",
    distributorName: "Ibn sina",
    fileName: "IS_week.xlsx",
    references: references(),
  });
  assert.equal(parsed.ok, true, "weekly file parses");
  if (!parsed.ok) return;
  const { result, rows } = parsed;

  // Week key comes from the Date column inside the sheet (not the file name).
  assert.equal(result.weekStart, "2025-08-01", "week_start from sheet Date column");
  assert.equal(result.status, "validated", "single week, no blocking");
  assert.equal(result.rowCount, 7);

  // Stock is captured as UNITS (sum of all stock cells).
  assert.equal(result.totals.stockQty, 30 + 20 + 50 + 12 + 23 + 10 + 16);

  // Value RECOMPUTED from xfactor, NOT the bogus sheet "Sales Value" (123456).
  const sa = result.byProduct.find((product) => product.productCode === "SA001");
  assert.ok(sa, "SA001 present");
  assert.equal(sa?.salesQty, 12, "SA001 units = 7 + 5 (both Product IDs map to SA001)");
  assert.equal(sa?.salesValue, round2(12 * XFACTORS.SA001), "SA001 value = units x xfactor");

  // Per-row: value = qty x xfactor x (1 - discount); the sheet value never leaks in.
  for (const r of rows) {
    assert.equal(round2(r.salesValue), round2(r.salesQty * (XFACTORS[r.productCode] ?? 0) * (1 - r.discount)));
    assert.notEqual(r.salesValue, 123456, "sheet Sales Value ignored");
  }

  const satoslimOldPrice = rows.find((r) => r.rawRow.itemName === "SATOSLIM 30 CAP(OLD PRICE)");
  assert.ok(satoslimOldPrice, "Satoslim old-price row present");
  assert.equal(satoslimOldPrice?.productCode, "SS001", "blank Product ID resolves SATOSLIM old-price item name to SS001");
  assert.equal(satoslimOldPrice?.salesValue, round2(6 * XFACTORS.SS001), "Satoslim old-price value uses resolved product xfactor");
  assert.equal(satoslimOldPrice?.validationState, "valid", "Satoslim old-price row is no longer a product warning");

  const sheetXfactor = await parseWeeklyWorkbookBuffer({
    buffer: await buildWeeklyWorkbook(XFACTOR_HEADER, [
      row({ date: week, itemCode: "667913", itemName: "SAGINKGO 30 CAP", branch: "Cairo A", stock: 30, qty: 7, region: "CA", productId: "SA001", xfactor: 2.5 }),
    ]),
    distributorCode: "IS",
    distributorName: "Ibn sina",
    fileName: "IS_week_xfactor.xlsx",
    references: references(),
  });
  assert.equal(sheetXfactor.ok, true, "weekly file with XFactor parses");
  if (sheetXfactor.ok) {
    assert.equal(sheetXfactor.result.totals.salesQty, 7, "XFactor row units are kept");
    assert.equal(sheetXfactor.result.totals.salesValue, round2(7 * 2.5), "value uses uploaded XFactor instead of product fallback");
    assert.equal(sheetXfactor.rows[0].rawRow.xfactorSource, "sheet", "raw row records uploaded XFactor source");
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
    distributorCode: "IS",
    distributorName: "Ibn sina",
    fileName: "two-weeks.xlsx",
    references: references(),
  });
  assert.equal(multi.ok, true);
  if (multi.ok) assert.equal(multi.result.status, "blocked", "two weeks in one file is blocked");

  // PAS raw layout (no Region ID / Product ID / Distrub ID columns) should still match the dedicated
  // IS-S raw template.
  const pasRaw = await parseWeeklyWorkbookBuffer({
    buffer: await workbookPasRaw([
      [new Date(Date.UTC(2025, 7, 1)), "CA", "Ibn Sina Branch", "SA001", "SAGINKGO 30 CAP", "61", "Cairo A", 14, 2000, 4, 0, 0],
      [new Date(Date.UTC(2025, 7, 1)), "GZ", "Ibn Sina Branch", "RO001", "ROYAFLOXACIN 500 TAB", "62", "Giza B", 7, 1200, 2, 0, 0],
    ]),
    distributorCode: "IS-S",
    distributorName: "Ibn Sina Sato",
    fileName: "IS-S_pas_raw.xlsx",
    references: references(),
  });
  assert.equal(pasRaw.ok, true, "PAS raw header layout is recognised for IS-S");
  if (pasRaw.ok) {
    assert.equal(pasRaw.result.templateKey, "ibn_sina_weekly_pas_raw", "PAS raw variant is selected");
    assert.equal(pasRaw.result.rowCount, 2, "PAS raw parse keeps both rows");
    assert.equal(pasRaw.rows[0].productCode, "SA001", "raw Item Code resolves to product from master");
    assert.equal(pasRaw.rows[0].regionCode, "CA", "raw Supplier Code resolves as region code");
    assert.equal(pasRaw.rows[0].validationState, "valid", "raw mapped row is valid");
    assert.equal(pasRaw.result.totals.stockQty, 21, "raw total stock qty is correct");
  }

  const pasRawWithTitle = await parseWeeklyWorkbookBuffer({
    buffer: await workbookPasRawWithTitleAndMinimalHeader([
      [new Date(Date.UTC(2025, 7, 1)), "SA001", "SAGINKGO 30 CAP", "61", "Cairo A", 14, 2000, 4, 0, 0],
      [new Date(Date.UTC(2025, 7, 1)), "RO001", "ROYAFLOXACIN 500 TAB", "62", "Giza B", 7, 1200, 2, 0, 0],
    ]),
    distributorCode: "IS-S",
    distributorName: "Ibn Sina Sato",
    fileName: "IS-S_pas_raw_minimal.xlsx",
    references: references(),
  });
  assert.equal(pasRawWithTitle.ok, true, "title-row + PAS minimal raw layout is recognised for IS-S");
  if (pasRawWithTitle.ok) {
    assert.equal(pasRawWithTitle.result.templateKey, "ibn_sina_weekly_pas_raw", "PAS minimal raw variant is selected");
    assert.equal(pasRawWithTitle.result.rowCount, 2, "PAS minimal raw parse keeps both rows");
    assert.equal(pasRawWithTitle.rows[1].productCode, "RO001", "minimal layout maps product from Item Code");
    assert.equal(pasRawWithTitle.rows[0].regionCode, "", "missing region is accepted as a blank region code");
  }

  const pasRawNoDate = await parseWeeklyWorkbookBuffer({
    buffer: await workbookPasRawNoDate([
      ["110476", "SATO", "SA001", "SAGINKGO 30 CAP", "61", "Cairo A", 14, 2000, 4, 0, 0],
      ["GZ", "SATO", "RO001", "ROYAFLOXACIN 500 TAB", "62", "Giza B", 7, 1200, 2, 0, 0],
    ]),
    distributorCode: "IS-S",
    distributorName: "Ibn Sina Sato",
    fileName: "Weekly_Sales_and_Stock_For_SATO_PHARMA_(PAS)20250712120407.xlsx",
    references: references(),
  });
  assert.equal(pasRawNoDate.ok, true, "PAS raw without Date column is recognised for IS-S");
  if (pasRawNoDate.ok) {
    assert.equal(pasRawNoDate.result.templateKey, "ibn_sina_weekly_pas_raw_no_date", "no-Date PAS layout selects the fallback template");
    assert.equal(pasRawNoDate.result.rowCount, 2, "no-Date PAS raw layout keeps both rows");
    assert.equal(pasRawNoDate.result.weekStart, "2025-07-12", "missing Date column is restored from filename date");
    assert.equal(pasRawNoDate.rows[0].weekStart, "2025-07-12", "row weekStart restored from filename");
  }

  // Overseas POS matrix layout (header row + outlet quantity columns) should be recognised for PS.
  const overseasPos = await parseWeeklyWorkbookBuffer({
    buffer: await workbookOverseasPosMatrix(),
    distributorCode: "PS",
    distributorName: "overseas",
    fileName: "POS 6 June.xlsx",
    posRegionMappings: [
      { distributorCode: "PS", rawColumnName: "Retail Cairo", normalizedColumnName: "retail cairo", regionCode: "CA" },
      { distributorCode: "PS", rawColumnName: "Super KA Delta", normalizedColumnName: "super ka delta", regionCode: "D1" },
    ],
    references: references(),
  });
  assert.equal(overseasPos.ok, true, "overseas POS matrix layout is recognised for PS");
  if (overseasPos.ok) {
    assert.equal(overseasPos.result.templateKey, "overseas_pos_weekly_matrix", "overseas POS matrix template is selected");
    assert.equal(overseasPos.result.weekStart, "2026-06-06", "overseas POS week comes from Date column");
    assert.equal(overseasPos.result.totals.salesQty, 6, "overseas POS trusts Total Qty after adding unallocated difference");
    assert.equal(overseasPos.result.totals.bonusQty, 0, "overseas POS product-level bonus is not imported into sales facts");
    assert.equal(overseasPos.result.totals.salesValue, 600, "overseas POS value = Total Qty x fallback xfactor");
    assert.notEqual(overseasPos.result.totals.salesValue, 99999, "overseas POS uploaded Total Val is ignored");
    assert.ok(overseasPos.result.byBranch.some((branch) => branch.branchName === "Retail Cairo"), "outlet columns become branches");
    assert.ok(overseasPos.result.byRegion.some((region) => region.regionName === "Cairo"), "Cairo outlet columns map to Cairo region");
    assert.ok(overseasPos.result.byRegion.some((region) => region.regionName.includes("Delta")), "Delta outlet columns map to Delta region");
    assert.ok(overseasPos.rows.some((row) => row.rawRow.quantitySource === "unallocatedDifference"), "quantity mismatch is retained as an unallocated row");
    assert.ok(overseasPos.result.issues.some((issue) => issue.message.includes("Total Qty.")), "quantity mismatch is flagged");
  }
  // Unknown distributor has no weekly template (not a silent empty result).
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
