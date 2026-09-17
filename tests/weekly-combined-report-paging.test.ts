import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import {
  buildCombinedReportExport,
  loadCombinedReportProducts,
} from "../src/lib/sales/weekly/combined-report.ts";

// 🔴 THE WEEKLY SALES COMBINED REPORT STOPPED READING AT 1,000 PRODUCT ROWS, AND PRINTED ITS TIME IN UTC —
// found 2026-09-17.
//
// The Upload screen's Combined Report read every selected upload's `weekly_sales_rows` in ONE request.
// PostgREST answers at most 1,000 rows per request and says nothing when it stops, and one weekly upload
// routinely holds more. So the per-product sheets under-reported Sales Value and units with no warning,
// and an upload cut short could look like it held ONE product — the list that decides whether a unit
// total may be printed, because units of different products are never added. Its "Generated" line was
// raw UTC; the owner reads every time in Cairo.
//
// The fake below answers the way PostgREST does: it returns only the columns selected, and never more
// than 1,000 rows, whatever was asked. Judged on the EMITTED file (written, then read back).

const DB_MAX_ROWS = 1000;

type Row = Record<string, unknown>;

type RecordedRequest = {
  table: string;
  filters: { column: string; op: "in" | "gt"; value: unknown }[];
  order: string | null;
  limit: number | null;
};

function fakePostgrest(tables: Record<string, Row[]>) {
  const requests: RecordedRequest[] = [];

  const client = {
    from(table: string) {
      const request: RecordedRequest = { table, filters: [], order: null, limit: null };
      let columns: string[] = [];
      let range: [number, number] | null = null;

      const execute = () => {
        requests.push(request);
        let rows = [...(tables[table] ?? [])];
        for (const filter of request.filters) {
          rows =
            filter.op === "in"
              ? rows.filter((row) => (filter.value as unknown[]).includes(row[filter.column]))
              : rows.filter((row) => Number(row[filter.column]) > Number(filter.value));
        }
        if (request.order) {
          const column = request.order;
          rows.sort((a, z) => Number(a[column]) - Number(z[column]));
        }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        if (request.limit !== null) rows = rows.slice(0, request.limit);
        rows = rows.slice(0, DB_MAX_ROWS);
        const data = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
        return { data, error: null };
      };

      const builder = {
        select(list: string) {
          columns = list.split(",").map((column) => column.trim());
          return builder;
        },
        in(column: string, values: unknown[]) {
          request.filters.push({ column, op: "in", value: values });
          return builder;
        },
        gt(column: string, value: unknown) {
          request.filters.push({ column, op: "gt", value });
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          assert.notEqual(options?.ascending, false, "the fake only orders ascending");
          request.order = column;
          return builder;
        },
        limit(count: number) {
          request.limit = count;
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          return builder;
        },
        then<T>(resolve: (value: ReturnType<typeof execute>) => T, reject?: (reason: unknown) => T) {
          return Promise.resolve().then(execute).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return { client: client as unknown as Parameters<typeof buildCombinedReportExport>[0], requests };
}

// Two uploads, 2,400 product rows between them, stored in id order the way an import writes them. The
// second upload's rows run from the 901st to the 2,400th: a single read stops inside it, keeping 100
// rows of its first product and none of its second.
function productRows(batchId: string, fromId: number, count: number, product: Row): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: fromId + i, batch_id: batchId, row_number: i + 1, ...product }));
}

const PRODUCT_ONE = { product_code: "P1", product_name: "Product One 500 mg", net_qty: 2, sales_value: 100, stock_qty: 1 };
const PRODUCT_THREE = { product_code: "P3", product_name: "Product Three 100 mg", net_qty: 1, sales_value: 50, stock_qty: 3 };
const PRODUCT_FOUR = { product_code: "P4", product_name: "Product Four 250 mg", net_qty: 3, sales_value: 40, stock_qty: 2 };

const TABLES: Record<string, Row[]> = {
  weekly_sales_batches: [
    {
      id: "upload-first",
      distributor_code: "SD1",
      distributor_name: "Sample Distributor One",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 900,
      total_net_qty: 1800,
      total_sales_value: 90000,
      total_stock_qty: 900,
    },
    {
      id: "upload-second",
      distributor_code: "SD2",
      distributor_name: "Sample Distributor Two",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 1500,
      total_net_qty: 3300,
      total_sales_value: 66000,
      total_stock_qty: 3600,
    },
    {
      id: "upload-not-selected",
      distributor_code: "SD3",
      distributor_name: "Sample Distributor Three",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 100,
      total_net_qty: 100,
      total_sales_value: 5000,
      total_stock_qty: 100,
    },
  ],
  weekly_sales_rows: [
    ...productRows("upload-first", 1, 900, PRODUCT_ONE),
    ...productRows("upload-second", 901, 600, PRODUCT_THREE),
    ...productRows("upload-second", 1501, 900, PRODUCT_FOUR),
    ...productRows("upload-not-selected", 2401, 100, PRODUCT_ONE),
  ],
};

const SELECTED = ["upload-first", "upload-second"];

/** The rows under a table's header ("Product"/"Period") down to its TOTAL row, as [label, ...numbers]. */
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

/** Comments out, so an explanation that names the removed read cannot trip the route check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export async function runWeeklyCombinedReportPagingTests() {
  // ── The read: every product row, however many requests it takes ─────────────────────────────────
  const read = fakePostgrest(TABLES);
  const products = await loadCombinedReportProducts(read.client, SELECTED);

  const byCode = (batchId: string) =>
    Object.fromEntries((products.get(batchId) ?? []).map((p) => [p.productCode, [p.netQty, p.salesValue, p.stockQty]]));
  assert.deepEqual(
    byCode("upload-second"),
    { P3: [600, 30000, 1800], P4: [2700, 36000, 1800] },
    "Combined Report: an upload's product rows past PostgREST's 1,000-row cap are read too — every product, and each product's full Net Units, Sales Value and Stock Units",
  );
  assert.deepEqual(byCode("upload-first"), { P1: [1800, 90000, 900] }, "the upload under the cap is read whole");
  assert.equal(products.has("upload-not-selected"), false, "an upload that was not selected is never read");

  const rowReads = read.requests.filter((request) => request.table === "weekly_sales_rows");
  assert.ok(rowReads.length >= 3, `2,400 rows take at least three requests at 1,000 a page (took ${rowReads.length})`);
  for (const request of rowReads) {
    assert.equal(request.order, "id", "every page is ordered on id, so no row is skipped or read twice between pages");
    assert.ok(request.limit !== null && request.limit <= DB_MAX_ROWS, "every page asks for at most 1,000 rows");
    assert.deepEqual(
      request.filters.find((filter) => filter.op === "in"),
      { column: "batch_id", op: "in", value: SELECTED },
      "every page stays inside the selected uploads",
    );
  }

  // ── The emitted file ──────────────────────────────────────────────────────────────────────────────
  // 22:15 UTC on 16 July is 01:15 on 17 July in Cairo (UTC+3 in summer): a UTC label is wrong by the hour
  // AND the day.
  const exported = fakePostgrest(TABLES);
  const buffer = await buildCombinedReportExport(exported.client, SELECTED, new Date("2026-07-16T22:15:00.000Z"));
  assert.ok(buffer, "the selected uploads exist, so there is a file");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const secondSheet = workbook.worksheets.find((sheet) => sheet.getCell(1, 3).value === "Sample Distributor Two");
  assert.ok(secondSheet, "the second upload has its own sheet");
  const second = tableRows(secondSheet, "Product");
  const productCol = 1;
  const netCol = columnOf(secondSheet, second.header, "Net Units");
  const valueCol = columnOf(secondSheet, second.header, "Sales Value (EGP)");
  const stockCol = columnOf(secondSheet, second.header, "Stock Units");
  assert.deepEqual(
    second.body.map((row) => [row.getCell(productCol).value, row.getCell(netCol).value, row.getCell(valueCol).value, row.getCell(stockCol).value]),
    [
      ["Product Four 250 mg", 2700, 36000, 1800],
      ["Product Three 100 mg", 600, 30000, 1800],
    ],
    "Combined Report per-upload sheet: both products are listed with their full units and value, not the first 1,000 rows of the selection",
  );
  assert.equal(
    second.total.getCell(valueCol).value,
    66000,
    "the per-upload sheet's Sales Value TOTAL matches that upload's own total on the Summary",
  );

  const summary = workbook.getWorksheet("Summary");
  assert.ok(summary, 'the Combined Report has a "Summary" sheet');
  // A set, because the provenance block is a merged range and every cell of it reads the same text. The
  // whitespace is folded because current ICU puts a narrow no-break space before "AM".
  const stamps = new Set<string>();
  summary.getRow(1).eachCell((cell) => {
    if (typeof cell.value === "string" && cell.value.includes("Generated")) stamps.add(cell.value.replace(/\s+/g, " "));
  });
  const provenance = [...stamps];
  assert.equal(provenance.length, 1, "the Summary's masthead carries one Generated line");
  assert.ok(
    provenance[0].includes("Generated 17 Jul 2026, 1:15 AM (Cairo)"),
    `Combined Report: "Generated" is Cairo local time, never raw UTC (found ${JSON.stringify(provenance[0])})`,
  );
  assert.doesNotMatch(provenance[0], /UTC/, "the Generated line never says UTC");

  const nothing = fakePostgrest(TABLES);
  assert.equal(await buildCombinedReportExport(nothing.client, ["upload-that-does-not-exist"]), null, "no uploads found, no file");

  // ── The route: it hands the work to the paged export and reads nothing itself ─────────────────────
  const route = code(readFileSync(join(process.cwd(), "app/api/sales/weekly/export-batches/route.ts"), "utf8"));
  assert.match(route, /buildCombinedReportExport\(/, "the export route builds the Combined Report through the paged domain export");
  assert.doesNotMatch(route, /\.from\(/, "the export route reads no table itself, so it cannot bring back a single unpaged read");
  assert.doesNotMatch(route, /toISOString|UTC/, "the export route stamps no UTC time of its own");
}
