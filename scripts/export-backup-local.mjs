/**
 * Local backup export script — runs on your machine, no Vercel timeout.
 * Saves every table as .json + combined .xlsx to backups/ folder.
 *
 * Usage:  node scripts/export-backup-local.mjs
 */

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { config } from "dotenv";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "export-backup-local",
  usage: `export-backup-local: save every table as .json plus one combined .xlsx under backups/.

  node scripts/export-backup-local.mjs      run the export
  node scripts/export-backup-local.mjs -h   this text

It takes no arguments, and it reads PRODUCTION Supabase through .env.local.`,
  hints: [
    "it writes under backups/ and takes no table or date filter — the set is a constant here",
  ],
});

config({ path: ".env.local" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Table list ───────────────────────────────────────────────────────────────
// Each entry: { table, pkCol } — pkCol is used for cursor-based pagination
// to avoid slow OFFSET scans on large tables.

const TABLES = [
  // Source of Sales
  { table: "source_of_sales_import_batches",     module: "sales",     pkCol: "id",              pkType: "uuid" },
  { table: "source_of_sales_import_rows",        module: "sales",     pkCol: "id",              pkType: "int" },
  { table: "source_of_sales_import_summaries",   module: "sales",     pkCol: "id",              pkType: "int" },
  { table: "source_of_sales_customer_map",       module: "sales",     pkCol: "id",              pkType: "int" },
  { table: "source_of_sales_distributor_profile",module: "sales",     pkCol: "distributor_code", pkType: "text" },
  { table: "source_of_sales_product_aliases",    module: "sales",     pkCol: "id",              pkType: "int" },
  { table: "source_of_sales_products",           module: "sales",     pkCol: "product_code",    pkType: "text" },
  { table: "source_of_sales_distributors",       module: "sales",     pkCol: "distributor_code", pkType: "text" },
  { table: "source_of_sales_regions",            module: "sales",     pkCol: "region_code",     pkType: "text" },
  { table: "source_of_sales_areas",              module: "sales",     pkCol: "area_code",       pkType: "text" },
  { table: "source_of_sales_blocks",             module: "sales",     pkCol: "block_code",      pkType: "text" },
  { table: "source_of_sales_bricks",             module: "sales",     pkCol: "brick_id",        pkType: "text" },
  // Weekly Sales
  { table: "weekly_sales_batches",                    module: "weekly",    pkCol: "id",              pkType: "uuid" },
  { table: "weekly_sales_rows",                       module: "weekly",    pkCol: "id",              pkType: "int" },
  { table: "weekly_sales_distributor_column_profile", module: "weekly",    pkCol: "distributor_code", pkType: "text" },
  { table: "weekly_sales_branch_region_map",          module: "weekly",    pkCol: "id",              pkType: "uuid" },
  { table: "weekly_sales_pos_region_mappings",        module: "weekly",    pkCol: "id",              pkType: "uuid" },
  { table: "weekly_sales_product_scope",              module: "weekly",    pkCol: "id",              pkType: "uuid" },
  { table: "weekly_sales_product_aliases",            module: "weekly",    pkCol: "id",              pkType: "uuid" },
  // Marketing Requests
  { table: "marketing_requests",                      module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_request_products",              module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_request_pharmacies",            module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_request_approval_steps",        module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_request_finance_requirements",  module: "marketing", pkCol: "request_id",      pkType: "uuid" },
  { table: "marketing_customers",                     module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_customer_contacts",             module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_customer_pharmacies",           module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_pharmacies",                    module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_pharmacy_distributor_codes",    module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_pharmacy_code_references",      module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_evidence_files",                module: "marketing", pkCol: "id",              pkType: "uuid" },
  { table: "marketing_request_types",                 module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_distributors",                  module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_products",                      module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_workflow_steps",                module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_review_routing",                module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_control_settings",              module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_request_facts",             module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_product_facts",             module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_trend_facts",               module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_line_facts",                module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_region_facts",              module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_distributor_facts",         module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_customer_facts",            module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_distributor_rollup",        module: "marketing", pkCol: "sos_distributor_code", pkType: "text" },
  { table: "marketing_roi_export_audit",              module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_filter_presets",            module: "marketing", pkCol: "id",              pkType: "int" },
  { table: "marketing_roi_refresh_runs",              module: "marketing", pkCol: "id",              pkType: "int" },
];

const PAGE_SIZE = 500;

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function safeValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v;
}

async function fetchTableCursor(table, pkCol, pkType) {
  const rows = [];
  let cursor = pkType === "int" ? -1 : null; // int: start below 0; text/uuid: start null (get all)
  let page = 0;

  while (true) {
    let query = supabase.from(table).select("*").order(pkCol, { ascending: true }).limit(PAGE_SIZE);

    if (pkType === "int" && cursor !== null) {
      query = query.gt(pkCol, cursor);
    } else if ((pkType === "uuid" || pkType === "text") && cursor !== null) {
      query = query.gt(pkCol, cursor);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`\n  ✗ ${table} page ${page}: ${error.message}`);
      // For timeout errors on large tables, return what we have so far
      if (error.message.includes("timeout") || error.message.includes("statement")) {
        console.error(`  ⚠ Partial data saved for ${table} (${rows.length} rows before timeout)`);
      }
      break;
    }

    const batch = data ?? [];
    rows.push(...batch);
    process.stdout.write(`\r  ${table}: ${rows.length} rows`);

    if (batch.length < PAGE_SIZE) break;

    // Advance cursor to last row's PK value
    const lastRow = batch[batch.length - 1];
    cursor = lastRow[pkCol];
    if (cursor === undefined || cursor === null) break;
    page++;
  }

  return rows;
}

// ─── XLSX builder ─────────────────────────────────────────────────────────────

const MODULE_COLORS = {
  sales:     { tab: "F97316", header: "F97316" },
  weekly:    { tab: "3B82F6", header: "3B82F6" },
  marketing: { tab: "10B981", header: "10B981" },
};

function sanitizeSheetName(name) {
  return name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Data";
}

async function buildXlsx(datasets, outPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce Local Export";
  wb.created = new Date();

  const usedNames = new Set();
  function uniqueName(base) {
    let name = sanitizeSheetName(base);
    let i = 1;
    while (usedNames.has(name)) {
      const suffix = `-${i++}`;
      name = sanitizeSheetName(base).slice(0, 31 - suffix.length) + suffix;
    }
    usedNames.add(name);
    return name;
  }

  // Contents sheet
  const contents = wb.addWorksheet(uniqueName("Contents"));
  contents.properties.tabColor = { argb: "FF1E293B" };
  contents.columns = [
    { header: "Module", key: "module", width: 22 },
    { header: "Table", key: "table", width: 44 },
    { header: "Rows", key: "rows", width: 12 },
  ];
  contents.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  contents.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };

  let lastMod = "";
  for (const ds of datasets) {
    if (ds.module !== lastMod) {
      const color = MODULE_COLORS[ds.module];
      const r = contents.addRow({ module: ds.module.toUpperCase(), table: "", rows: "" });
      r.font = { bold: true, color: { argb: "FFFFFFFF" } };
      r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color?.header ?? "334155"}` } };
      lastMod = ds.module;
    }
    contents.addRow({ module: ds.module, table: ds.name, rows: ds.rows.length });
  }
  contents.views = [{ state: "frozen", ySplit: 1 }];

  // Data sheets
  for (const ds of datasets) {
    const color = MODULE_COLORS[ds.module];
    const sheet = wb.addWorksheet(uniqueName(ds.name));
    sheet.properties.tabColor = { argb: `FF${color?.tab ?? "334155"}` };

    if (ds.rows.length === 0) {
      sheet.addRow(["(no rows)"]);
      continue;
    }

    const headers = [...new Set(ds.rows.flatMap(r => Object.keys(r)))].sort();
    sheet.addRow(headers);
    const hRow = sheet.getRow(1);
    hRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    hRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color?.header ?? "334155"}` } };

    for (const row of ds.rows) {
      sheet.addRow(headers.map(h => safeValue(row[h])));
    }

    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: { column: 1, row: 1 }, to: { column: headers.length, row: ds.rows.length + 1 } };
    sheet.columns = headers.map(h => ({ key: h, header: h, width: Math.max(12, Math.min(60, h.length + 4)) }));
  }

  await wb.xlsx.writeFile(outPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = resolve("backups");
  const jsonDir = join(outDir, "json");
  mkdirSync(jsonDir, { recursive: true });

  console.log(`\nPhoenix Workforce — Local Data Export`);
  console.log(`Output: ${outDir}`);
  console.log(`Tables: ${TABLES.length}\n`);

  const datasets = [];
  const summary = [];

  for (const { table, module, pkCol, pkType } of TABLES) {
    process.stdout.write(`  ${table}: fetching...`);

    let rows = [];
    try {
      rows = await fetchTableCursor(table, pkCol, pkType);
    } catch (err) {
      console.error(`\n  ✗ ${table}: ${err.message}`);
      summary.push({ table, module, rows: 0, status: "error", error: err.message });
      continue;
    }

    // Normalize values
    const normalized = rows.map(row => {
      const r = {};
      for (const [k, v] of Object.entries(row)) r[k] = safeValue(v);
      return r;
    });

    datasets.push({ module, name: table, rows: normalized });
    summary.push({ table, module, rows: normalized.length, status: "ok" });

    // Save individual JSON
    const jsonPath = join(jsonDir, `${table}.json`);
    writeFileSync(jsonPath, JSON.stringify(normalized, null, 2), "utf-8");
    process.stdout.write(`\r  ✓ ${table}: ${normalized.length.toLocaleString()} rows\n`);
  }

  // Save combined JSON
  const combinedJson = { exportedAt: new Date().toISOString(), tables: TABLES.length, datasets };
  const combinedJsonPath = join(outDir, `phoenix-backup-${stamp}.json`);
  writeFileSync(combinedJsonPath, JSON.stringify(combinedJson), "utf-8");
  console.log(`\n✓ JSON saved: backups/phoenix-backup-${stamp}.json`);
  console.log(`✓ Per-table JSON saved in: backups/json/`);

  // Save XLSX
  const xlsxPath = join(outDir, `phoenix-backup-${stamp}.xlsx`);
  console.log(`\nBuilding XLSX...`);
  await buildXlsx(datasets, xlsxPath);
  console.log(`✓ XLSX saved: backups/phoenix-backup-${stamp}.xlsx`);

  // Summary table
  const total = summary.reduce((s, r) => s + r.rows, 0);
  const errors = summary.filter(r => r.status === "error");

  console.log(`\n${"─".repeat(62)}`);
  console.log(`  Tables exported : ${summary.filter(r => r.status === "ok").length}/${TABLES.length}`);
  console.log(`  Total rows      : ${total.toLocaleString()}`);
  if (errors.length > 0) {
    console.log(`  Errors          : ${errors.length} table(s) failed`);
    for (const e of errors) console.log(`    ✗ ${e.table}: ${e.error}`);
  }
  console.log(`${"─".repeat(62)}\n`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
