/**
 * Builds XLSX files from the saved JSON backups.
 * Uses ExcelJS streaming writer so even 100k+ row tables work.
 * Run AFTER export-backup-local.mjs has saved the JSON files.
 *
 * Usage:  node scripts/build-xlsx-from-json.mjs
 */

import ExcelJS from "exceljs";
import { readFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "build-xlsx-from-json",
  usage: `build-xlsx-from-json: build the XLSX workbooks from the JSON backups already on disk.

  node scripts/build-xlsx-from-json.mjs      build them (run export-backup-local.mjs first)
  node scripts/build-xlsx-from-json.mjs -h   this text

It takes no arguments: TABLES at the top of the file is the set, and the input is whatever
export-backup-local.mjs last wrote.`,
  hints: [
    "run node scripts/export-backup-local.mjs first — this one only reads what that wrote",
  ],
});

const MODULE_COLORS = {
  sales:     { tab: "F97316", header: "F97316" },
  weekly:    { tab: "3B82F6", header: "3B82F6" },
  marketing: { tab: "10B981", header: "10B981" },
};

// Same order as the export script
const TABLES = [
  { table: "source_of_sales_import_batches",      module: "sales" },
  { table: "source_of_sales_import_rows",         module: "sales" },
  { table: "source_of_sales_import_summaries",    module: "sales" },
  { table: "source_of_sales_customer_map",        module: "sales" },
  { table: "source_of_sales_distributor_profile", module: "sales" },
  { table: "source_of_sales_product_aliases",     module: "sales" },
  { table: "source_of_sales_products",            module: "sales" },
  { table: "source_of_sales_distributors",        module: "sales" },
  { table: "source_of_sales_regions",             module: "sales" },
  { table: "source_of_sales_areas",               module: "sales" },
  { table: "source_of_sales_blocks",              module: "sales" },
  { table: "source_of_sales_bricks",              module: "sales" },
  { table: "weekly_sales_batches",                    module: "weekly" },
  { table: "weekly_sales_rows",                       module: "weekly" },
  { table: "weekly_sales_distributor_column_profile", module: "weekly" },
  { table: "weekly_sales_branch_region_map",          module: "weekly" },
  { table: "weekly_sales_pos_region_mappings",        module: "weekly" },
  { table: "weekly_sales_product_scope",              module: "weekly" },
  { table: "weekly_sales_product_aliases",            module: "weekly" },
  { table: "marketing_requests",                      module: "marketing" },
  { table: "marketing_request_products",              module: "marketing" },
  { table: "marketing_request_pharmacies",            module: "marketing" },
  { table: "marketing_request_approval_steps",        module: "marketing" },
  { table: "marketing_request_finance_requirements",  module: "marketing" },
  { table: "marketing_customers",                     module: "marketing" },
  { table: "marketing_customer_contacts",             module: "marketing" },
  { table: "marketing_customer_pharmacies",           module: "marketing" },
  { table: "marketing_pharmacies",                    module: "marketing" },
  { table: "marketing_pharmacy_distributor_codes",    module: "marketing" },
  { table: "marketing_pharmacy_code_references",      module: "marketing" },
  { table: "marketing_evidence_files",                module: "marketing" },
  { table: "marketing_request_types",                 module: "marketing" },
  { table: "marketing_distributors",                  module: "marketing" },
  { table: "marketing_products",                      module: "marketing" },
  { table: "marketing_workflow_steps",                module: "marketing" },
  { table: "marketing_review_routing",                module: "marketing" },
  { table: "marketing_control_settings",              module: "marketing" },
  { table: "marketing_roi_request_facts",             module: "marketing" },
  { table: "marketing_roi_product_facts",             module: "marketing" },
  { table: "marketing_roi_trend_facts",               module: "marketing" },
  { table: "marketing_roi_line_facts",                module: "marketing" },
  { table: "marketing_roi_region_facts",              module: "marketing" },
  { table: "marketing_roi_distributor_facts",         module: "marketing" },
  { table: "marketing_roi_customer_facts",            module: "marketing" },
  { table: "marketing_roi_distributor_rollup",        module: "marketing" },
  { table: "marketing_roi_export_audit",              module: "marketing" },
  { table: "marketing_roi_filter_presets",            module: "marketing" },
  { table: "marketing_roi_refresh_runs",              module: "marketing" },
];

function sanitize(name) {
  return name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Data";
}

async function buildModuleXlsx(moduleName, tables, jsonDir, outPath) {
  const color = MODULE_COLORS[moduleName];

  // Use streaming workbook writer — writes to disk as rows are added
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outPath,
    useStyles: true,
    useSharedStrings: false,
  });

  // Contents sheet
  const contents = wb.addWorksheet("Contents", {
    properties: { tabColor: { argb: "FF1E293B" } },
  });
  contents.columns = [
    { header: "Table", key: "table", width: 50 },
    { header: "Rows", key: "rows", width: 12 },
  ];
  const hRow = contents.getRow(1);
  hRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
  hRow.commit();

  const summary = [];

  for (const { table } of tables) {
    const jsonPath = join(jsonDir, `${table}.json`);
    let rows = [];
    try {
      rows = JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch {
      console.log(`  ⚠ Skipping ${table} — JSON file not found`);
      continue;
    }

    process.stdout.write(`  ${table}: ${rows.length.toLocaleString()} rows → writing...`);

    const sheetName = sanitize(table);
    const sheet = wb.addWorksheet(sheetName, {
      properties: { tabColor: { argb: `FF${color?.tab ?? "334155"}` } },
    });

    if (rows.length === 0) {
      sheet.addRow(["(no rows)"]).commit();
      await sheet.commit();
      summary.push({ table, rows: 0 });
      process.stdout.write(` done\n`);
      continue;
    }

    const headers = [...new Set(rows.flatMap(r => Object.keys(r)))].sort();
    sheet.columns = headers.map(h => ({ key: h, header: h, width: Math.max(12, Math.min(60, h.length + 4)) }));

    // Header row
    const headerRow = sheet.getRow(1);
    headers.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color?.header ?? "334155"}` } };
    headerRow.commit();

    // Data rows — streamed one by one
    for (const row of rows) {
      const r = sheet.addRow(headers.map(h => {
        const v = row[h];
        if (v === null || v === undefined) return "";
        return v;
      }));
      r.commit();
    }

    await sheet.commit();
    summary.push({ table, rows: rows.length });
    process.stdout.write(` ✓\n`);
  }

  // Fill contents sheet
  for (const s of summary) {
    const r = contents.addRow({ table: s.table, rows: s.rows });
    r.commit();
  }
  await contents.commit();
  await wb.commit();

  return summary;
}

async function main() {
  const outDir = resolve("backups");
  const jsonDir = join(outDir, "json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  mkdirSync(outDir, { recursive: true });

  const modules = ["sales", "weekly", "marketing"];

  let grand = 0;
  for (const mod of modules) {
    const tables = TABLES.filter(t => t.module === mod);
    const outPath = join(outDir, `phoenix-backup-${mod}-${stamp}.xlsx`);
    console.log(`\nBuilding ${mod}.xlsx (${tables.length} tables)...`);
    const summary = await buildModuleXlsx(mod, tables, jsonDir, outPath);
    const total = summary.reduce((s, r) => s + r.rows, 0);
    grand += total;
    console.log(`✓ Saved: backups/phoenix-backup-${mod}-${stamp}.xlsx  (${total.toLocaleString()} rows)`);
  }

  console.log(`\n✓ All done — ${grand.toLocaleString()} total rows across 3 XLSX files in backups/\n`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
