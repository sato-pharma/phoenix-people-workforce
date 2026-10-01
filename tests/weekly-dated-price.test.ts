import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { productPeriodPricesFromRows } from "../src/lib/sales/product-period-price.ts";
import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import {
  buildCombinedReportExport,
  loadCombinedReportDatedPrices,
  loadCombinedReportProducts,
} from "../src/lib/sales/weekly/combined-report.ts";
import { livePriceMap, liveSalesValue, weeklyRowPeriod } from "../src/lib/sales/weekly/live-price.ts";

// WEEKLY SAGINKO IS PRICED AT 170.52 FROM OCTOBER, LIKE THE CLOSING — owner, 2026-10-01.
//
// Every weekly surface prices a row at TODAY's Product Master price (live-price.ts), so a price edit
// reaches every week without a re-upload. Saginko (SA001) is the one product whose price is DATED:
// 111.15 through 2026-09 and 170.52 from 2026-10, while its master price stays 111.15 on purpose. So
// "today's price" alone printed October's weekly Saginko at 111.15 beside a closing at 170.52.
//
// A row is now priced at the dated price that covers its month — its cycle month, else the month its
// week starts in — on both places that price weekly rows: the dashboard (and everything built from it)
// and the Upload screen's Combined Report. Every product with no dated price, every September row,
// and every Direct row is priced exactly as before. Judged on the EMITTED file (written, then read back).

type Row = Record<string, unknown>;

// Answers the way PostgREST does: only the columns selected, `in`/`gt` filters, ascending order, a limit.
function fakePostgrest(tables: Record<string, Row[]>, failing: string[] = []) {
  const client = {
    from(table: string) {
      let columns: string[] = [];
      const filters: { column: string; op: "in" | "gt"; value: unknown }[] = [];
      let order: string | null = null;
      let limit: number | null = null;

      const execute = () => {
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
  return client as unknown as Parameters<typeof buildCombinedReportExport>[0];
}

const SAGINKO = "SA001";
const OVERRIDES = [{ productCode: SAGINKO, effectivePeriod: "2026-10", factoryPrice: 170.52 }];
const MASTER = [
  { productCode: SAGINKO, factoryPrice: 111.15 },
  { productCode: "RO001", factoryPrice: 60.7 },
];

const batch = (id: string, distributorName: string, weekStart: string, code = "SD1") => ({
  id,
  distributor_code: code,
  distributor_name: distributorName,
  week_start: weekStart,
  status: "validated",
  total_rows: 1,
  total_net_qty: 10,
  total_sales_value: 0,
  total_stock_qty: 0,
});

const row = (id: number, batchId: string, code: string, product: string, netQty: number, stored: number, cycleMonth: string | null, weekStart: string) => ({
  id,
  batch_id: batchId,
  week_start: weekStart,
  cycle_month: cycleMonth,
  distributor_code: code,
  product_code: product,
  product_name: product === SAGINKO ? "Saginko 1 g" : "Royafloxacin 500 mg",
  net_qty: netQty,
  sales_value: stored,
  stock_qty: 0,
  official_line: "Anti Infective",
  region_code: "CA",
  area_code: "CA1",
});

// Every sheet stored its value at the master's 111.15 / 60.7 on the day it was imported.
const TABLES: Record<string, Row[]> = {
  source_of_sales_products: [
    { product_code: SAGINKO, factory_price: 111.15, active: true },
    { product_code: "RO001", factory_price: 60.7, active: true },
  ],
  source_of_sales_product_price_history: [{ product_code: SAGINKO, effective_period: "2026-10", factory_price: 170.52 }],
  weekly_sales_batches: [
    batch("upload-september", "September Sheet", "2026-09-20"),
    // Its week starts on 28 September, but the sheet is October's cycle: the cycle month decides.
    batch("upload-october", "October Sheet", "2026-09-28"),
    batch("upload-untagged", "Untagged Sheet", "2026-10-05"),
    batch("upload-direct", "Direct Orders", "2026-10-05", "DIRECT"),
  ],
  weekly_sales_rows: [
    row(1, "upload-september", "SD1", SAGINKO, 10, 1_111.5, "2026-09-01", "2026-09-20"),
    row(2, "upload-october", "SD1", SAGINKO, 10, 1_111.5, "2026-10-01", "2026-09-28"),
    row(3, "upload-october", "SD1", "RO001", 10, 607, "2026-10-01", "2026-09-28"),
    row(4, "upload-untagged", "SD1", SAGINKO, 5, 555.75, null, "2026-10-05"),
    row(5, "upload-direct", "DIRECT", SAGINKO, 5, 400, "2026-10-01", "2026-10-05"),
  ],
};

const SELECTED = ["upload-september", "upload-october", "upload-untagged", "upload-direct"];
const SEES_EVERYTHING: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };

function tableRows(sheet: ExcelJS.Worksheet, header: string): { header: number; body: ExcelJS.Row[] } {
  let headerRow = 0;
  let totalRow = 0;
  sheet.eachRow((sheetRow, number) => {
    const first = sheetRow.getCell(1).value;
    if (!headerRow && first === header) headerRow = number;
    else if (headerRow && !totalRow && first === "TOTAL") totalRow = number;
  });
  assert.ok(headerRow > 0 && totalRow > headerRow, `sheet "${sheet.name}" has a "${header}" table with a TOTAL row`);
  const body: ExcelJS.Row[] = [];
  for (let n = headerRow + 1; n < totalRow; n += 1) body.push(sheet.getRow(n));
  return { header: headerRow, body };
}

function columnOf(sheet: ExcelJS.Worksheet, headerRow: number, label: string): number {
  let found = 0;
  sheet.getRow(headerRow).eachCell((cell, col) => {
    if (cell.value === label) found = col;
  });
  assert.ok(found > 0, `sheet "${sheet.name}" has a "${label}" column`);
  return found;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

export async function runWeeklyDatedPriceTests() {
  // ── 1. The month a weekly row is reported under ──────────────────────────────────────────────────
  assert.equal(weeklyRowPeriod("2026-10-01", "2026-09-28"), "2026-10", "the cycle month decides, even when the week starts in the month before");
  assert.equal(weeklyRowPeriod("", "2026-10-05"), "2026-10", "an untagged row falls back to the month its week starts in");
  assert.equal(weeklyRowPeriod(null, null), null, "a row with neither has no month, so it takes today's price");

  // ── 2. The shared rule ─────────────────────────────────────────────────────────────────────────────
  const prices = livePriceMap(MASTER);
  const dated = productPeriodPricesFromRows(MASTER, OVERRIDES);
  const sell = (period: string | null, productCode = SAGINKO, netQty = 10, distributorCode = "SD1") =>
    liveSalesValue({ distributorCode, productCode, netQty, storedValue: 1, period }, prices, dated);
  assert.equal(sell("2026-10"), 1_705.2, "an October Saginko row is priced at 170.52 — the price the closing values October at");
  assert.equal(sell("2026-11"), 1_705.2, "and every month after it");
  assert.equal(sell("2026-09"), 1_111.5, "a September row keeps 111.15 — no earlier month moves");
  assert.equal(sell(null), 1_111.5, "a row with no month takes today's master price, as it always did");
  assert.equal(sell("2026-10", "RO001"), 607, "a product with no dated price is priced at today's master price, as before");
  assert.equal(sell("2026-10", SAGINKO, -2), -341.04, "a return in October reprices at 170.52 too");
  assert.equal(sell("2026-10", SAGINKO, 10, " direct "), 1, "Direct keeps its own sheet value (locked invariant), dated price or not");
  assert.equal(
    liveSalesValue({ distributorCode: "SD1", productCode: SAGINKO, netQty: 10, storedValue: 1, period: "2026-10" }, prices),
    1_111.5,
    "control: without the dated prices the master's 111.15 is all there is — the rule above really comes from them",
  );

  // ── 3. The Combined Report reads the dated list ──────────────────────────────────────────────────
  const listed = await loadCombinedReportDatedPrices(fakePostgrest(TABLES), new Map([[SAGINKO, 111.15], ["RO001", 60.7]]));
  assert.equal(listed.priceFor(SAGINKO, "2026-10"), 170.52, "the Combined Report reads the dated price for October");
  assert.equal(listed.priceFor(SAGINKO, "2026-09"), 111.15, "and September stays on the master price");

  const loaded = await loadCombinedReportProducts(
    fakePostgrest(TABLES),
    SELECTED,
    prices,
    SEES_EVERYTHING,
    dated,
  );
  const valueOf = (batchId: string, productCode: string) =>
    loaded.productsByBatch.get(batchId)?.find((product) => product.productCode === productCode)?.salesValue;
  assert.equal(valueOf("upload-october", SAGINKO), 1_705.2, "Combined Report: October's Saginko is priced at 170.52, never the 1,111.50 stored on import");
  assert.equal(valueOf("upload-september", SAGINKO), 1_111.5, "September's Saginko stays at 111.15");
  assert.equal(valueOf("upload-october", "RO001"), 607, "a product with no dated price is unchanged in October");
  assert.equal(valueOf("upload-untagged", SAGINKO), 852.6, "an untagged sheet whose week starts in October is priced at October's 170.52");
  assert.equal(valueOf("upload-direct", SAGINKO), 400, "Direct keeps its sheet value");

  // ── 4. The emitted file: the Summary's upload totals carry the same figures ─────────────────────
  const buffer = await buildCombinedReportExport(fakePostgrest(TABLES), SELECTED, SEES_EVERYTHING, new Date("2026-10-01T09:00:00.000Z"));
  assert.ok(buffer, "the selected uploads exist, so there is a file");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const summary = workbook.getWorksheet("Summary");
  assert.ok(summary, 'the Combined Report has a "Summary" sheet');
  const periods = tableRows(summary, "Period");
  const distributorCol = columnOf(summary, periods.header, "Distributor");
  const valueCol = columnOf(summary, periods.header, "Sales Value (EGP)");
  const totals = Object.fromEntries(periods.body.map((r) => [r.getCell(distributorCol).value, r.getCell(valueCol).value]));
  assert.equal(totals["October Sheet"], 2_312.2, "Combined Report Summary: October's upload is 1,705.20 of Saginko plus 607 of Royafloxacin");
  assert.equal(totals["September Sheet"], 1_111.5, "September's upload is unchanged");
  assert.equal(totals["Untagged Sheet"], 852.6, "the untagged October sheet is priced at October's price");
  assert.equal(totals["Direct Orders"], 400, "Direct keeps its sheet value");

  // ── 5. A dated list that cannot be read fails the export; it never prints the old price instead ─
  await assert.rejects(
    buildCombinedReportExport(fakePostgrest(TABLES, ["source_of_sales_product_price_history"]), SELECTED, SEES_EVERYTHING),
    (error: Error & { code?: string }) => /dated Product Master prices could not be read/.test(error.message) && error.code === "load_failed",
    "with no readable dated list the Combined Report refuses, rather than print October's Saginko at 111.15",
  );

  // ── 6. The dashboard, which every weekly screen, export and the portal read, prices the same way ──
  const service = stripComments(readFileSync(new URL("../src/lib/sales/weekly/service.ts", import.meta.url), "utf8"));
  assert.match(
    service,
    /datedPrices = productPeriodPricesFromRows\(reference\.products, reference\.productPriceOverrides/,
    "the dashboard builds the dated prices from the same reference load as today's prices",
  );
  assert.match(
    service,
    /row\.salesValue = liveSalesValue\(\s*\{[^}]*period: weeklyRowPeriod\(row\.cycleMonth, row\.weekStart\),?\s*\},\s*priceMap,\s*datedPrices,?\s*\)/,
    "the dashboard prices each row at the dated price of its cycle month",
  );
  const report = stripComments(readFileSync(new URL("../src/lib/sales/weekly/combined-report.ts", import.meta.url), "utf8"));
  assert.match(
    report,
    /loadCombinedReportProducts\(supabase, batchIds, prices, scope, datedPrices\)/,
    "the Combined Report export hands the dated prices to its row read",
  );
}
