import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { buildCombinedReportExport, loadCombinedReportPrices } from "../src/lib/sales/weekly/combined-report.ts";
import { livePriceMap, liveSalesValue } from "../src/lib/sales/weekly/live-price.ts";

// 🔴 THE COMBINED REPORT PRINTED EACH ROW'S STORED SALES VALUE, WHILE THE DASHBOARD PRICES IT TODAY.
//
// SoS audit, confirmed high (import-service.ts:471): the resync meant to rewrite stored weekly values after
// a factory-price edit called a function that has never existed. The dashboard repriced rows live from the
// Product Master, so it was right; the Upload screen's Combined Report read `weekly_sales_rows.sales_value`
// straight from the table, so it printed the price on the day each sheet was imported. On production on
// 2026-09-18 that was 36 of 67 uploads and 4,072 rows: 343,832,783.69 EGP stored against 356,978,442.97
// at today's prices, a 13.1 million EGP disagreement between two screens reading the same uploads.
//
// The Combined Report now prices through the same rule as the dashboard (live-price.ts). Judged on the
// EMITTED file (written, then read back).

type Row = Record<string, unknown>;

// Answers the way PostgREST does: only the columns selected, `in`/`gt` filters, ascending order, a limit.
function fakePostgrest(tables: Record<string, Row[]>, failing: string[] = []) {
  const reads: string[] = [];
  const client = {
    from(table: string) {
      let columns: string[] = [];
      const filters: { column: string; op: "in" | "gt"; value: unknown }[] = [];
      let order: string | null = null;
      let limit: number | null = null;

      const execute = () => {
        reads.push(table);
        if (failing.includes(table)) return { data: null, error: { message: `permission denied for table ${table}` } };
        let rows = [...(tables[table] ?? [])];
        for (const filter of filters) {
          rows =
            filter.op === "in"
              ? rows.filter((row) => (filter.value as unknown[]).includes(row[filter.column]))
              : rows.filter((row) => String(row[filter.column]) > String(filter.value));
        }
        if (order) {
          const column = order;
          rows.sort((a, z) => (String(a[column]) < String(z[column]) ? -1 : String(a[column]) > String(z[column]) ? 1 : 0));
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return { data: rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))), error: null };
      };

      const builder = {
        select(list: string) {
          columns = list.split(",").map((column) => column.trim());
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push({ column, op: "in", value: values });
          return builder;
        },
        gt(column: string, value: unknown) {
          filters.push({ column, op: "gt", value });
          return builder;
        },
        order(column: string) {
          order = column;
          return builder;
        },
        limit(count: number) {
          limit = count;
          return builder;
        },
        then<T>(resolve: (value: ReturnType<typeof execute>) => T, reject?: (reason: unknown) => T) {
          return Promise.resolve().then(execute).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as Parameters<typeof buildCombinedReportExport>[0], reads };
}

// One distributor upload imported when Product One cost 50 a unit; the Product Master says 60 today.
// Product Two has no positive price today and Product Three is retired (inactive), so neither can be
// repriced and both keep what the sheet was stored at. One Direct upload keeps its own sheet value.
const TABLES: Record<string, Row[]> = {
  source_of_sales_products: [
    { product_code: "P1", factory_price: 60, active: true },
    { product_code: "P2", factory_price: 0, active: true },
    { product_code: "P3", factory_price: 999, active: false },
  ],
  weekly_sales_batches: [
    {
      id: "upload-distributor",
      distributor_code: "SD1",
      distributor_name: "Sample Distributor One",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 3,
      total_net_qty: 16,
      total_sales_value: 610,
      total_stock_qty: 6,
    },
    {
      id: "upload-direct",
      distributor_code: "DIRECT",
      distributor_name: "Direct Orders",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 1,
      total_net_qty: 5,
      total_sales_value: 400,
      total_stock_qty: 0,
    },
  ],
  weekly_sales_rows: [
    { id: 1, batch_id: "upload-distributor", distributor_code: "SD1", product_code: "P1", product_name: "Product One 500 mg", net_qty: 10, sales_value: 500, stock_qty: 2 },
    { id: 2, batch_id: "upload-distributor", distributor_code: "SD1", product_code: "P2", product_name: "Product Two 100 mg", net_qty: 4, sales_value: 80, stock_qty: 2 },
    { id: 3, batch_id: "upload-distributor", distributor_code: "SD1", product_code: "P3", product_name: "Product Three 250 mg", net_qty: 2, sales_value: 30, stock_qty: 2 },
    { id: 4, batch_id: "upload-direct", distributor_code: "DIRECT", product_code: "P1", product_name: "Product One 500 mg", net_qty: 5, sales_value: 400, stock_qty: 0 },
  ],
};

const SELECTED = ["upload-distributor", "upload-direct"];

// Judged for a viewer who may see every row (the Super Admin's scope); what the scope hides from everyone
// else is weekly-combined-report-scope.test.ts.
const SEES_EVERYTHING: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };

function tableRows(sheet: ExcelJS.Worksheet, header: string): { header: number; body: ExcelJS.Row[]; total: ExcelJS.Row } {
  let headerRow = 0;
  let totalRow = 0;
  sheet.eachRow((row, number) => {
    const first = row.getCell(1).value;
    if (!headerRow && first === header) headerRow = number;
    else if (headerRow && !totalRow && first === "TOTAL") totalRow = number;
  });
  assert.ok(headerRow > 0 && totalRow > headerRow, `sheet "${sheet.name}" has a "${header}" table with a TOTAL row`);
  const body: ExcelJS.Row[] = [];
  for (let n = headerRow + 1; n < totalRow; n += 1) body.push(sheet.getRow(n));
  return { header: headerRow, body, total: sheet.getRow(totalRow) };
}

function columnOf(sheet: ExcelJS.Worksheet, headerRow: number, label: string): number {
  let found = 0;
  sheet.getRow(headerRow).eachCell((cell, col) => {
    if (cell.value === label) found = col;
  });
  assert.ok(found > 0, `sheet "${sheet.name}" has a "${label}" column`);
  return found;
}

export async function runWeeklyCombinedReportLivePriceTests() {
  const exported = fakePostgrest(TABLES);
  const buffer = await buildCombinedReportExport(exported.client, SELECTED, SEES_EVERYTHING, new Date("2026-09-18T12:00:00.000Z"));
  assert.ok(buffer, "the selected uploads exist, so there is a file");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  // ── HEADLINE: the per-upload sheet prices Product One at today's 60, not the stored 50 ───────────────
  const distributorSheet = workbook.worksheets.find((sheet) => sheet.getCell(1, 3).value === "Sample Distributor One");
  assert.ok(distributorSheet, "the distributor upload has its own sheet");
  const byProduct = tableRows(distributorSheet, "Product");
  const valueCol = columnOf(distributorSheet, byProduct.header, "Sales Value (EGP)");
  const values = Object.fromEntries(byProduct.body.map((row) => [row.getCell(1).value, row.getCell(valueCol).value]));
  assert.equal(
    values["Product One 500 mg"],
    600,
    "Combined Report: a row imported at an old price is priced at today's Product Master price (10 units × 60 = 600), " +
      "the same figure the dashboard shows — never the 500 stored on import day",
  );
  assert.equal(values["Product Two 100 mg"], 80, "a product with no positive price today keeps its stored value, never zero");
  assert.equal(values["Product Three 250 mg"], 30, "a retired (inactive) product's price is not used; the row keeps its stored value");
  assert.equal(byProduct.total.getCell(valueCol).value, 710, "the per-upload TOTAL adds the repriced rows");

  // ── The Summary's upload total is repriced too, so it agrees with the upload's own sheet ─────────────
  const summary = workbook.getWorksheet("Summary");
  assert.ok(summary, 'the Combined Report has a "Summary" sheet');
  const periods = tableRows(summary, "Period");
  const distributorCol = columnOf(summary, periods.header, "Distributor");
  const summaryValueCol = columnOf(summary, periods.header, "Sales Value (EGP)");
  const totals = Object.fromEntries(
    periods.body.map((row) => [row.getCell(distributorCol).value, row.getCell(summaryValueCol).value]),
  );
  assert.equal(
    totals["Sample Distributor One"],
    710,
    "Combined Report Summary: an upload's Sales Value is the sum of its rows at today's prices (710), never the stored 610",
  );
  assert.equal(totals["Direct Orders"], 400, "Direct keeps its own sheet value (locked invariant), even where the product has a price today");
  assert.equal(periods.total.getCell(summaryValueCol).value, 1110, "the Summary TOTAL adds the repriced upload totals");

  // ── A price list that cannot be read fails the export; it never prints the stored values instead ─────
  const blind = fakePostgrest(TABLES, ["source_of_sales_products"]);
  await assert.rejects(
    buildCombinedReportExport(blind.client, SELECTED, SEES_EVERYTHING),
    (error: Error & { code?: string }) =>
      /Product Master prices could not be read/.test(error.message) && error.code === "load_failed",
    "with no readable price list the Combined Report refuses, rather than print import-day values as if current",
  );
  const pricesOnly = fakePostgrest(TABLES);
  assert.deepEqual(
    [...(await loadCombinedReportPrices(pricesOnly.client)).entries()],
    [["P1", 60]],
    "the price list is the ACTIVE products with a positive price, as the dashboard reads it",
  );

  // ── The shared rule ──────────────────────────────────────────────────────────────────────────────────
  const prices = livePriceMap([
    { productCode: " p1 ", factoryPrice: "60" },
    { productCode: "P2", factoryPrice: null },
    { productCode: "P4", factoryPrice: -5 },
  ]);
  assert.deepEqual([...prices.entries()], [["P1", 60]], "codes are matched trimmed and case-blind; a blank or non-positive price is no price");
  assert.equal(liveSalesValue({ distributorCode: "sd1", productCode: "p1", netQty: 3, storedValue: 1 }, prices), 180);
  assert.equal(liveSalesValue({ distributorCode: " direct ", productCode: "P1", netQty: 3, storedValue: 7 }, prices), 7);
  assert.equal(liveSalesValue({ distributorCode: "SD1", productCode: "P2", netQty: 3, storedValue: 7 }, prices), 7);
  assert.equal(liveSalesValue({ distributorCode: "SD1", productCode: "P1", netQty: -2, storedValue: 0 }, prices), -120, "a return reprices too");

  // ── Both weekly surfaces price through that one rule ─────────────────────────────────────────────────
  const service = readFileSync(new URL("../src/lib/sales/weekly/service.ts", import.meta.url), "utf8");
  assert.match(service, /row\.salesValue = liveSalesValue\(/, "the dashboard prices rows through liveSalesValue");
  const report = readFileSync(new URL("../src/lib/sales/weekly/combined-report.ts", import.meta.url), "utf8");
  assert.match(report, /const salesValue = liveSalesValue\(/, "the Combined Report prices rows through liveSalesValue");
}
