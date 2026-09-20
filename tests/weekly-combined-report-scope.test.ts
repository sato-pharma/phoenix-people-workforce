import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { buildCombinedReportExport, loadCombinedReportProducts } from "../src/lib/sales/weekly/combined-report.ts";

// 🔴 THE WEEKLY COMBINED REPORT HAD NO ACCESS SCOPE — found 2026-09-20.
//
// The three restricted products and the Head Office line are the CEO's and the Super Admin's alone, and
// every weekly export hands the viewer's scope to the rows it prints. The Upload screen's Combined Report
// (POST /api/sales/weekly/export-batches) read `weekly_sales_rows` with the service-role client and printed
// every row, and its route admits anyone holding the upload permission — the Super Admin AND the SFE
// Manager, whose scope is "full, minus the restricted products". On production that was about 88% of the
// stored weekly value, in 48 of 75 uploads.
//
// It also printed each upload's STORED row count, unit totals and stock, which add the hidden rows too, so
// hiding the product lines alone would still have told the SFE Manager how much of an upload was hidden.
//
// Judged on the EMITTED file (written, then read back). The fake answers the way PostgREST does: only the
// columns selected, `in`/`gt` filters, ascending order, a limit — so a column the read forgets to select
// arrives as undefined, exactly as it would from the database.

type Row = Record<string, unknown>;

function fakePostgrest(tables: Record<string, Row[]>) {
  const client = {
    from(table: string) {
      let columns: string[] = [];
      const filters: { column: string; op: "in" | "gt"; value: unknown }[] = [];
      let order: string | null = null;
      let limit: number | null = null;

      const compare = (a: unknown, z: unknown) => (Number(a) - Number(z) || String(a).localeCompare(String(z)));

      const execute = () => {
        let rows = [...(tables[table] ?? [])];
        for (const filter of filters) {
          rows =
            filter.op === "in"
              ? rows.filter((row) => (filter.value as unknown[]).includes(row[filter.column]))
              : rows.filter((row) => compare(row[filter.column], filter.value) > 0);
        }
        if (order) {
          const column = order;
          rows.sort((a, z) => compare(a[column], z[column]));
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

// The names are made up, and none of them is a distributor's or a product's real name. LA003, LA004 and
// SS001 are the three restricted product codes; "Head Office" is the confidential line.
const P1 = { product_code: "P1", product_name: "Product One 500 mg", official_line: "CNS", region_code: "CA" };
const P2_OTHER_REGION = { product_code: "P2", product_name: "Product Two 100 mg", official_line: "CNS", region_code: "AL" };
const RESTRICTED_A = { product_code: "LA003", product_name: "Restricted Alpha 400 g", official_line: "Pedia", region_code: "CA" };
const RESTRICTED_B = { product_code: "LA004", product_name: "Restricted Beta 200 g", official_line: "Pedia", region_code: "CA" };
const RESTRICTED_C = { product_code: "SS001", product_name: "Restricted Gamma 30 caps", official_line: "Pedia", region_code: "CA" };
const HEAD_OFFICE = { product_code: "HO9", product_name: "Head Office Delta 10 mg", official_line: "Head Office", region_code: "CA" };

const HIDDEN_NAMES = ["Restricted Alpha", "Restricted Beta", "Restricted Gamma", "Head Office Delta"];

const TABLES: Record<string, Row[]> = {
  weekly_sales_batches: [
    // Six rows: three visible to an SFE Manager (two of Product One, one of Product Two), the rest hidden.
    {
      id: "upload-mixed",
      distributor_code: "SD1",
      distributor_name: "Sample Distributor One",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 6,
      total_net_qty: 40,
      total_sales_value: 2170,
      total_stock_qty: 9,
    },
    // Restricted rows only: nothing of it is the viewer's to see.
    {
      id: "upload-hidden",
      distributor_code: "SD2",
      distributor_name: "Sample Distributor Two",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 2,
      total_net_qty: 8,
      total_sales_value: 800,
      total_stock_qty: 2,
    },
    // Product One only: the scope takes nothing from it.
    {
      id: "upload-clean",
      distributor_code: "SD3",
      distributor_name: "Sample Distributor Three",
      week_start: "2026-09-06",
      status: "published",
      total_rows: 2,
      total_net_qty: 5,
      total_sales_value: 250,
      total_stock_qty: 1,
    },
  ],
  weekly_sales_rows: [
    { id: 1, batch_id: "upload-mixed", distributor_code: "SD1", ...P1, net_qty: 10, sales_value: 500, stock_qty: 2 },
    { id: 2, batch_id: "upload-mixed", distributor_code: "SD1", ...P1, net_qty: 5, sales_value: 250, stock_qty: 1 },
    { id: 3, batch_id: "upload-mixed", distributor_code: "SD1", ...RESTRICTED_A, net_qty: 4, sales_value: 400, stock_qty: 1 },
    { id: 4, batch_id: "upload-mixed", distributor_code: "SD1", ...RESTRICTED_C, net_qty: 6, sales_value: 600, stock_qty: 1 },
    { id: 5, batch_id: "upload-mixed", distributor_code: "SD1", ...HEAD_OFFICE, net_qty: 3, sales_value: 300, stock_qty: 1 },
    { id: 6, batch_id: "upload-mixed", distributor_code: "SD1", ...P2_OTHER_REGION, net_qty: 12, sales_value: 120, stock_qty: 3 },
    { id: 7, batch_id: "upload-hidden", distributor_code: "SD2", ...RESTRICTED_B, net_qty: 7, sales_value: 700, stock_qty: 2 },
    { id: 8, batch_id: "upload-hidden", distributor_code: "SD2", ...RESTRICTED_B, net_qty: 1, sales_value: 100, stock_qty: 0 },
    { id: 9, batch_id: "upload-clean", distributor_code: "SD3", ...P1, net_qty: 2, sales_value: 100, stock_qty: 1 },
    { id: 10, batch_id: "upload-clean", distributor_code: "SD3", ...P1, net_qty: 3, sales_value: 150, stock_qty: 0 },
  ],
};

const SELECTED = ["upload-mixed", "upload-hidden", "upload-clean"];
const NOW = new Date("2026-09-20T09:00:00.000Z");

// The scopes resolveWeeklyAccessScope hands back (access.ts), spelled out.
const SUPER_ADMIN_OR_CEO: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };
const SFE_MANAGER: WeeklyAccessScope = { tier: "full", canViewRestricted: false, canViewHeadOffice: false };
// A viewer bounded to a product list that even names a restricted product: the restricted one stays hidden.
const PRODUCT_LIST: WeeklyAccessScope = { tier: "product", productCodes: new Set(["P1", "LA003"]), canViewHeadOffice: false };
const RESTRICTED_SEEN_HEAD_OFFICE_NOT: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: false };
const REGION_CA_ONLY: WeeklyAccessScope = {
  tier: "territory",
  allowedLineNames: null,
  allowedRegionCodes: new Set(["CA"]),
  allowedAreaCodes: null,
  canViewHeadOffice: false,
};
const NOTHING: WeeklyAccessScope = { tier: "none", canViewHeadOffice: false };

type Summary = { rows: unknown; value: unknown; net: unknown; stock: unknown };

async function emit(scope: WeeklyAccessScope) {
  const buffer = await buildCombinedReportExport(fakePostgrest(TABLES), SELECTED, scope, NOW);
  assert.ok(buffer, "the selected uploads exist, so there is a file");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  // Every cell of every sheet, as text — the file is judged as a person would read it, not by one column.
  const everyCell: string[] = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => row.eachCell((cell) => everyCell.push(String(cell.value ?? ""))));
  });
  const text = everyCell.join("\n");

  const summarySheet = workbook.getWorksheet("Summary");
  assert.ok(summarySheet, 'the Combined Report has a "Summary" sheet');
  const { header, body, total } = tableRows(summarySheet, "Period");
  const col = (label: string) => columnOf(summarySheet, header, label);
  const byDistributor: Record<string, Summary> = {};
  for (const row of body) {
    byDistributor[String(row.getCell(col("Distributor")).value)] = {
      rows: row.getCell(col("Rows")).value,
      value: row.getCell(col("Sales Value (EGP)")).value,
      net: row.getCell(col("Net Units")).value,
      stock: row.getCell(col("Stock Units")).value,
    };
  }

  const productsOf = (distributorName: string): Record<string, unknown> => {
    const sheet = workbook.worksheets.find((candidate) => candidate.getCell(1, 3).value === distributorName);
    assert.ok(sheet, `${distributorName} has its own sheet`);
    // An upload with no product line has the table's header and no TOTAL row under it, so this reads the
    // rows below the header up to a TOTAL or the end of the sheet, rather than requiring one.
    let headerRow = 0;
    sheet.eachRow((row, number) => {
      if (!headerRow && row.getCell(1).value === "Product") headerRow = number;
    });
    assert.ok(headerRow > 0, `${distributorName}'s sheet has a "Product" table`);
    const valueCol = columnOf(sheet, headerRow, "Sales Value (EGP)");
    const lines: [string, unknown][] = [];
    for (let n = headerRow + 1; n <= sheet.rowCount; n += 1) {
      const label = sheet.getRow(n).getCell(1).value;
      if (label === "TOTAL") break;
      if (label !== null && label !== undefined && label !== "") lines.push([String(label), sheet.getRow(n).getCell(valueCol).value]);
    }
    return Object.fromEntries(lines);
  };

  return {
    text,
    byDistributor,
    productsOf,
    totalRows: total.getCell(col("Rows")).value,
    totalValue: total.getCell(col("Sales Value (EGP)")).value,
  };
}

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

/** Comments out, so an explanation that names a call cannot satisfy or trip a route check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function assertNoneOf(text: string, names: string[], who: string) {
  for (const name of names) {
    assert.ok(!text.includes(name), `${who}: "${name}" is not the viewer's to see, so it appears nowhere in the file`);
  }
}

export async function runWeeklyCombinedReportScopeTests() {
  // ── CONTROL: the Super Admin and the CEO read everything, off the stored totals, as before ───────────
  const everything = await emit(SUPER_ADMIN_OR_CEO);
  for (const name of [...HIDDEN_NAMES, "Product One 500 mg", "Product Two 100 mg"]) {
    assert.ok(everything.text.includes(name), `Super Admin / CEO: "${name}" is in the file — the fixture really carries what the others must not see`);
  }
  assert.equal(everything.byDistributor["Sample Distributor One"].rows, 6, "Super Admin / CEO: the mixed upload prints its stored 6 rows");
  assert.equal(everything.byDistributor["Sample Distributor One"].value, 2170, "Super Admin / CEO: and its full value");
  assert.equal(everything.byDistributor["Sample Distributor Two"].value, 800, "Super Admin / CEO: the restricted-only upload prints its value");

  // ── HEADLINE: the SFE Manager, the one role below the CEO that holds the upload permission ───────────
  const sfe = await emit(SFE_MANAGER);
  assertNoneOf(sfe.text, HIDDEN_NAMES, "SFE Manager");
  assert.deepEqual(
    sfe.productsOf("Sample Distributor One"),
    { "Product One 500 mg": 750, "Product Two 100 mg": 120 },
    "SFE Manager: the mixed upload's sheet lists only the products he may see (Product One 500+250, Product Two 120)",
  );
  const mixed = sfe.byDistributor["Sample Distributor One"];
  assert.equal(mixed.rows, 3, "SFE Manager: the mixed upload's Rows is the 3 he may see, never the stored 6, which counts the hidden rows too");
  assert.equal(mixed.value, 870, "SFE Manager: its Sales Value is the 870 he may see, never the stored 2,170");
  assert.equal(mixed.net, "—", "SFE Manager: two products remain, so no unit total is printed (units of different products are never added)");
  assert.equal(mixed.stock, "—", "SFE Manager: and no stock total either");
  const hidden = sfe.byDistributor["Sample Distributor Two"];
  assert.equal(hidden.rows, 0, "SFE Manager: an upload whose rows were ALL hidden prints zero rows, never its stored 2");
  assert.equal(hidden.value, 0, "SFE Manager: and zero value, never the stored 800 — it must not fall back to the totals stored on it");
  assert.deepEqual(sfe.productsOf("Sample Distributor Two"), {}, "SFE Manager: its own sheet has no product line");
  const clean = sfe.byDistributor["Sample Distributor Three"];
  assert.deepEqual(
    [clean.rows, clean.value, clean.net, clean.stock],
    [2, 250, 5, 1],
    "SFE Manager: an upload the scope takes nothing from keeps its figures as they always were",
  );
  assert.equal(sfe.totalValue, 1120, "SFE Manager: the Summary TOTAL adds only what he may see (870 + 0 + 250)");
  assert.equal(sfe.totalRows, 5, "SFE Manager: and only the rows he may see (3 + 0 + 2)");

  // ── A stored unit total is never printed for an upload the scope cut: one visible product must show ONLY its own units ──
  const bounded = await emit(PRODUCT_LIST);
  assertNoneOf(bounded.text, [...HIDDEN_NAMES, "Product Two 100 mg"], "a viewer bounded to a product list");
  const boundedMixed = bounded.byDistributor["Sample Distributor One"];
  assert.deepEqual(
    [boundedMixed.rows, boundedMixed.value, boundedMixed.net, boundedMixed.stock],
    [2, 750, 15, 3],
    "product list: one product is visible, so the units print — Product One's own 15 and 3, never the stored 40 and 9, which add the hidden products",
  );
  assert.equal(bounded.byDistributor["Sample Distributor Two"].value, 0, "product list: a restricted product he was assigned is still hidden");

  // ── The two confidential things are independent ──────────────────────────────────────────────────────
  const noHeadOffice = await emit(RESTRICTED_SEEN_HEAD_OFFICE_NOT);
  assertNoneOf(noHeadOffice.text, ["Head Office Delta"], "a viewer who may read restricted products but not Head Office");
  assert.ok(noHeadOffice.text.includes("Restricted Alpha"), "the restricted products are still there for him");
  assert.equal(noHeadOffice.byDistributor["Sample Distributor One"].rows, 5, "Head Office's one row is out of the count (6 - 1)");
  assert.equal(noHeadOffice.byDistributor["Sample Distributor One"].value, 1870, "and out of the value (2,170 - 300)");

  // ── A territory viewer is bounded by region as well — proof that the read carries region and line ────
  const territory = await emit(REGION_CA_ONLY);
  assertNoneOf(territory.text, [...HIDDEN_NAMES, "Product Two 100 mg"], "a viewer bounded to one region");
  assert.deepEqual(
    territory.productsOf("Sample Distributor One"),
    { "Product One 500 mg": 750 },
    "territory: only the region's own rows — Product Two is in another region, the restricted and Head Office rows are stripped for every tier",
  );
  assert.equal(territory.byDistributor["Sample Distributor One"].rows, 2, "territory: two rows counted");

  // ── A viewer with no weekly access reads nothing ─────────────────────────────────────────────────────
  const none = await emit(NOTHING);
  assertNoneOf(none.text, [...HIDDEN_NAMES, "Product One 500 mg", "Product Two 100 mg"], "a viewer with no weekly access");
  assert.equal(none.totalValue, 0, "no weekly access: no value in the file");
  assert.equal(none.totalRows, 0, "no weekly access: no rows counted");

  // ── The loader's own answer: which uploads the scope cut, and exactly what is left of them ───────────
  const cut = await loadCombinedReportProducts(fakePostgrest(TABLES), SELECTED, new Map(), SFE_MANAGER);
  assert.deepEqual(
    [...cut.scopedTotals.entries()].sort(([a], [z]) => a.localeCompare(z)),
    [
      ["upload-hidden", { rows: 0, netQty: 0, stockQty: 0 }],
      ["upload-mixed", { rows: 3, netQty: 27, stockQty: 6 }],
    ],
    "the two uploads the SFE Manager's scope cut are named with what is left of them (the all-hidden one with zeros); the untouched one is absent",
  );

  // ── The route resolves the scope, hands it to the export and rate-limits it ──────────────────────────
  const route = code(readFileSync(join(process.cwd(), "app/api/sales/weekly/export-batches/route.ts"), "utf8"));
  assert.match(route, /resolveWeeklyAccessScope\(access\)/, "the export route resolves the caller's weekly access scope");
  assert.match(
    route,
    /buildCombinedReportExport\(getSupabaseAdmin\(\), batchIds, scope\)/,
    "the export route hands that scope to the Combined Report — it does not build one without",
  );
  assert.match(route, /assertExportRateLimit\(/, "the export route is rate-limited like every other weekly export");
  assert.match(route, /isApiRateLimitError\(error\)/, "and answers a limited caller with 429, not a 500");

  // A default would be a fail-open: a caller that forgot the scope would silently read everything.
  const report = code(readFileSync(join(process.cwd(), "src/lib/sales/weekly/combined-report.ts"), "utf8"));
  assert.match(report, /scope: WeeklyAccessScope,\n/, "the scope is a required argument of the export and of the loader");
  assert.doesNotMatch(report, /scope: WeeklyAccessScope\s*=/, "the scope has no default");
}
