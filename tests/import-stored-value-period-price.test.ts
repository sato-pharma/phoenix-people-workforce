import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { pickDuplicateUploadClash, repriceableUploadRow, totalValueAtPeriod } from "../src/lib/sales/import-duplicate-guard.ts";
import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { normalizeRows } from "../src/lib/sales/normalizer/engine.ts";
import { rawProfileForDistributor } from "../src/lib/sales/normalizer/profiles.ts";
import { normalizeAliasKey, normalizeCodeKey } from "../src/lib/sales/normalizer/resolvers.ts";
import type { CodedRow, Crosswalks, NormalizeResult } from "../src/lib/sales/normalizer/types.ts";
import { productPeriodPricesFromRows, repriceValue } from "../src/lib/sales/product-period-price.ts";
import { applyPeriodConsolidation } from "../src/lib/sales/sales-upload.ts";

// THE IMPORTER STORES EACH ROW'S VALUE AT THE PRICE OF ITS OWN MONTH — 2026-10-01.
//
// Saginko (SA001) is 111.15 through 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28), and the
// product master stays 111.15. The closing already values every month at its own price; the import
// still stored `source_of_sales_import_rows.value` as units x the master's FLAT price, on both paths
// that write it (the Monthly Import parser and the Normalizer engine). Those stored values feed the
// Source of Sales dashboard, the import summaries and the workbook's Sheet Value, so the first October
// file would have shown Saginko there at 111.15 beside a closing at 170.52 — at August's 2,983 units,
// 331,560.45 against 508,661.16.
//
// Two follow-ons had to move with it or the fix would have broken something that works today:
//   • A date-less sheet is valued at the flat price and then filed under the month the operator
//     picks (applyPeriodConsolidation), so the re-dated row is re-priced to that month.
//   • The duplicate-upload guard matches a re-dated file by its figures. With each month at its own
//     price, September's file loaded again as October would carry a different total and walk past
//     it, so a stored batch is compared on its own month's price basis.
//
// Nothing before October moves: the only override starts 2026-10, and repriceValue leaves a value
// untouched to the last digit wherever the two prices agree.

const SAGINKO = "SA001";
const UNITS = 2_983;
const OCTOBER_VALUE = 508_661.16; // 2,983 x 170.52
const SEPTEMBER_VALUE = 331_560.45; // 2,983 x 111.15
const OVERRIDES = [{ productCode: SAGINKO, effectivePeriod: "2026-10", factoryPrice: 170.52 }];

const round2 = (value: number) => Number(value.toFixed(2));

// ── 1. The Monthly Import parser ─────────────────────────────────────────────────────────────────
const references: SalesReferenceData = {
  distributors: [{ code: "PS", name: "Overseas" }],
  products: [
    { factoryPrice: 111.15, family: "Saginko", familyCode: "SA", line: "Anti Infective", productCode: SAGINKO, productName: "Saginko", source: "Phoenix" },
    { factoryPrice: 60.7, family: "Royafloxacin", familyCode: "RO", line: "Anti Infective", productCode: "RO001", productName: "Royafloxacin", source: "Phoenix" },
  ],
  productPriceOverrides: OVERRIDES,
  regions: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  areas: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  blocks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" }],
  bricks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
};

async function overseasWorkbook(invoiceDate: string, productCode: string, qty: number) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Customer", "Invoice Date", "Qty", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"]);
  sheet.addRow(["C-1", new Date(`${invoiceDate}T00:00:00Z`), qty, productCode, "B-1", "A1", "CA", "PS"]);
  return workbook.xlsx.writeBuffer();
}

async function parserValue(invoiceDate: string, productCode = SAGINKO, qty = UNITS, refs = references) {
  const result = await validateDistributorSalesWorkbookBuffer({
    buffer: (await overseasWorkbook(invoiceDate, productCode, qty)) as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "overseas.xlsx",
    references: refs,
  });
  assert.equal(result.status, "validated", `control: the ${invoiceDate} fixture validates`);
  return round2(result.totals.totalValue);
}

// ── 2. The Normalizer engine (the path most production rows take) ────────────────────────────────
function qemaCrosswalks(withPrices: boolean): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([["CA101", {
      areaCode: "CA1", areaName: "Cairo 1", blockCode: "CA1-1", brickId: "CA101", brickName: "Marg",
      regionCode: "CA", regionName: "Cairo",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map([[`${normalizeCodeKey("QM")} ${normalizeCodeKey("1001")}`, "CA101"]]),
    prices: withPrices ? productPeriodPricesFromRows([{ productCode: SAGINKO, factoryPrice: 111.15 }], OVERRIDES) : undefined,
    productAliasByKey: new Map([[`${normalizeCodeKey("QM")} ${normalizeAliasKey("Saginko")}`, SAGINKO]]),
    productByCanonicalCode: new Map(),
    productByCode: new Map([[SAGINKO, { productCode: SAGINKO, productName: "Saginko", factoryPrice: 111.15, line: "Anti Infective" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map(),
  };
}

function qemaRows(withPrices: boolean): CodedRow[] {
  const sheet = new ExcelJS.Workbook().addWorksheet("Sheet1");
  sheet.addRow(["رقم الفاتورة", "التاريخ", "ACCOUNT_ID", "الاسم", "رقم الصنف", "الصنف", "الكمية", "بونص", "اجمالى جمهور", "الاجمالى"]);
  sheet.addRow(["9001", "15-09-2026", "1001", "صيدلية النور", "5754", "Saginko", UNITS, 0, 0, 0]);
  sheet.addRow(["9002", "15-10-2026", "1001", "صيدلية النور", "5754", "Saginko", UNITS, 0, 0, 0]);
  const profile = rawProfileForDistributor("QM");
  assert.ok(profile, "control: the El Qema profile exists — this test reads the real one");
  return normalizeRows(sheet, profile, qemaCrosswalks(withPrices)).coded;
}

/** The source text of a function, comments stripped, for the wiring the behaviour cannot reach. */
function sourceOf(file: string, signature: string): string {
  const text = readFileSync(new URL(`../src/lib/sales/${file}`, import.meta.url), "utf8");
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `control: ${signature} is still in ${file}`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end > start ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

export async function runImportStoredValuePeriodPriceTests() {
  // ── 1. Monthly Import parser ────────────────────────────────────────────────────────────────────
  assert.equal(
    await parserValue("2026-10-15"),
    OCTOBER_VALUE,
    "an October Saginko row is stored at 170.52 — the price the closing values October at, never the master's 111.15",
  );
  assert.equal(await parserValue("2026-09-15"), SEPTEMBER_VALUE, "a September row keeps 111.15 — no earlier month moves");
  assert.equal(await parserValue("2026-10-15", "RO001", 100), 6_070, "a product with no override is stored at its master price in October too");
  assert.equal(
    await parserValue("2026-10-15", SAGINKO, UNITS, { ...references, productPriceOverrides: undefined }),
    SEPTEMBER_VALUE,
    "control: without the overrides the flat price is all there is — the fixture really does carry them",
  );

  // ── 2. Normalizer engine ────────────────────────────────────────────────────────────────────────
  const [september, october] = qemaRows(true);
  assert.equal(september?.invoiceDate, "2026-09", "control: the first El Qema row is dated September");
  assert.equal(october?.invoiceDate, "2026-10", "control: the second is dated October");
  assert.equal(
    round2(october!.value),
    OCTOBER_VALUE,
    "the Normalizer stores an October Saginko row at 170.52 — the path most production rows take",
  );
  assert.equal(round2(september!.value), SEPTEMBER_VALUE, "and a September row at 111.15");
  const [, flatOctober] = qemaRows(false);
  assert.equal(round2(flatOctober!.value), SEPTEMBER_VALUE, "control: a crosswalk with no prices falls back to the flat price");

  // ── 3. A date-less sheet filed under the month the operator picks ─────────────────────────────
  const prices = productPeriodPricesFromRows(references.products, OVERRIDES);
  const undated: NormalizeResult = {
    coded: [
      { ...october!, invoiceDate: "", value: UNITS * 111.15 },
      { ...october!, invoiceDate: "", isDirect: true, value: 66_960 },
    ],
    distributorCode: "QM",
    exceptions: [],
    ignoredRows: [],
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: 2, blankCustomerSkipped: 0, fullyCoded: 2, ignored: 0, productResolved: 2, totalRows: 2, scannedDataRows: 2 },
  };
  const filed = applyPeriodConsolidation(undated, { kind: "ok", period: "2026-10", consolidate: true }, prices);
  assert.equal(filed.coded[0].invoiceDate, "2026-10", "control: the row is filed under the picked month");
  assert.equal(
    round2(filed.coded[0].value),
    OCTOBER_VALUE,
    "a date-less row filed under October is re-priced to October's 170.52, not left at the flat price it was read at",
  );
  assert.equal(filed.coded[1].value, 66_960, "a direct row filed under October keeps its deal value");
  assert.equal(
    applyPeriodConsolidation(undated, { kind: "ok", period: "2026-09", consolidate: true }, prices).coded[0].value,
    UNITS * 111.15,
    "filed under September it keeps its exact figure — repriceValue moves nothing the prices agree on",
  );

  assert.equal(repriceValue(prices, SAGINKO, 0, "2026-09", "2026-10"), 0, "a value of 0 stays 0");
  assert.equal(repriceValue(prices, "ZZ999", 500, "2026-09", "2026-10"), 500, "an unknown product is never moved");

  // ── 4. The duplicate-upload guard across the reprice ──────────────────────────────────────────
  // September's file was stored at 111.15. The SAME file loaded again as October values at 170.52.
  const storedSeptember = {
    id: "batch-sep",
    period: "2026-09",
    file_name: "overseas.xlsx",
    status: "validated",
    total_rows: 1,
    total_qty: UNITS,
    total_value: SEPTEMBER_VALUE,
  };
  const octoberRows = [
    repriceableUploadRow({ distributorCode: "PS", isDirect: false, period: "2026-10", productCode: SAGINKO, value: UNITS * 170.52 }),
  ];
  const candidate = { fileName: "overseas.xlsx", period: "2026-10", totalRows: 1, totalQty: UNITS, totalValue: OCTOBER_VALUE };
  assert.equal(
    pickDuplicateUploadClash([storedSeptember], candidate),
    null,
    "control: compared at face value the re-dated file slips past — this is the hole the reprice opens",
  );
  assert.equal(
    pickDuplicateUploadClash([storedSeptember], {
      ...candidate,
      totalValueAt: (period) => totalValueAtPeriod(octoberRows, prices, period),
    })?.id,
    "batch-sep",
    "September's file loaded again as October is still caught — the stored batch is compared on its own month's price",
  );
  assert.equal(
    pickDuplicateUploadClash([{ ...storedSeptember, total_value: SEPTEMBER_VALUE + 1 }], {
      ...candidate,
      totalValueAt: (period) => totalValueAtPeriod(octoberRows, prices, period),
    }),
    null,
    "and a different file is still a different file — the figures still have to agree",
  );

  // An Office file is units × the MASTER price in EVERY month (the owner's locked Office rule,
  // office-allocation.ts), so the same Office pivot loaded again as October carries September's very
  // total. Re-pricing it to September would shrink it to 216,120.95 and let it walk past (review of
  // #5030, 2026-10-01) — it is compared at face value, exactly as before this change.
  const officeRow = { distributorCode: "Office", isDirect: false, period: "2026-10", productCode: SAGINKO, value: SEPTEMBER_VALUE };
  const officeOctober = [repriceableUploadRow(officeRow)];
  assert.equal(
    pickDuplicateUploadClash([{ ...storedSeptember, file_name: "office.xlsx" }], {
      ...candidate,
      fileName: "office.xlsx",
      totalValue: SEPTEMBER_VALUE,
      totalValueAt: (period) => totalValueAtPeriod(officeOctober, prices, period),
    })?.id,
    "batch-sep",
    "an Office file, valued at the master price in every month, loaded again as October is still caught",
  );
  assert.equal(repriceableUploadRow({ ...officeRow, distributorCode: " office " }).keepsValue, true, "Office is read case-blind");
  assert.equal(repriceableUploadRow({ ...officeRow, distributorCode: "Direct", isDirect: true }).keepsValue, true, "a direct deal keeps its value");
  assert.equal(octoberRows[0].keepsValue, false, "control: a distributor's row follows its month's price");

  // ── 5. Wiring the behaviour above cannot see: every production path hands the prices on ────────
  const loader = sourceOf("monthly-distributor-import.ts", "export async function loadSalesReferenceData(");
  assert.match(loader, /\.from\("source_of_sales_product_price_history"\)/, "loadSalesReferenceData reads the dated overrides");
  assert.match(loader, /productPriceOverrides:/, "and hands them to every import that loads references");
  assert.match(loader, /if \(priceOverridesResult\.error\) throw/, "and fails loudly when it cannot read them");
  assert.match(
    sourceOf("normalizer/crosswalks.ts", "export async function loadCrosswalks("),
    /productPeriodPricesFromRows\(refs\.products, refs\.productPriceOverrides/,
    "the Normalizer's crosswalks carry the period prices the engine values rows with",
  );
  // Since REC-008 (14 Nov 2026) both writers compare through the one door (import-store-rules.ts).
  const door = sourceOf("import-store-rules.ts", "export async function applyImportStoreRules<");
  assert.match(door, /totalValueAt: \(atPeriod\) => totalValueAtPeriod\(repriceableAt\(atPeriod\), prices, atPeriod\)/, "the door compares stored batches on their own month's price");
  assert.match(door, /repriceableUploadRow\(\{\s*distributorCode:/, "and lets Direct and Office rows keep their value");
  assert.match(door, /isDirect: Boolean\(row\.isDirect\)/, "a Direct row is never repriced");
  for (const [file, signature, month, distributor] of [
    ["monthly-distributor-import.ts", "export async function persistDistributorSalesUpload(", /priceMonthOf: \(row\) => row\.invoicePeriod,/, /priceDistributorOf: \(row\) => row\.distributorCode,/],
    ["normalizer/service.ts", "export async function persistNormalizedBatch(", /priceMonthOf: \(r\) => r\.invoiceDate,/, /priceDistributorOf: \(\) => input\.distributorCode,/],
  ] as const) {
    const step = sourceOf(file, signature);
    assert.match(step, /applyImportStoreRules\(/, `${signature} compares stored batches on their own month's price`);
    assert.match(step, month, `${signature} prices each row by its own month`);
    assert.match(step, distributor, `${signature} prices each row as its distributor`);
  }
  const upload = readFileSync(new URL("../src/lib/sales/sales-upload.ts", import.meta.url), "utf8");
  assert.equal(
    (upload.match(/applyPeriodConsolidation\([^)]*rec\.prices\)/g) ?? []).length,
    2,
    "both the analyze and the commit step re-price what they file under a picked month",
  );
}
