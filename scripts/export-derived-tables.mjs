/**
 * Exports SoS-derived tables (fact rollup, customer directory, customer presence).
 * Saves JSON per table + one combined XLSX.
 * Usage: node scripts/export-derived-tables.mjs
 */

import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { config } from "dotenv";

import { refuseArguments } from "./lib/refuse-arguments.mjs";

// This script takes no arguments, so it says so instead of ignoring one (scripts/lib/refuse-arguments.mjs).
refuseArguments({
  name: "export-derived-tables",
  usage: `export-derived-tables: export the SoS-derived tables as JSON plus one combined XLSX.

  node scripts/export-derived-tables.mjs      run the export
  node scripts/export-derived-tables.mjs -h   this text

It takes no arguments: TABLES at the top of the file is the set it exports.`,
  hints: [
    "TABLES at the top of this file is the set — edit it, do not pass a table name",
  ],
});

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// `pkType: "int"` is a unique ascending id, walked by cursor. The two composite-key tables carry no
// unique single column (client_code repeats across batches and products, so a cursor on it skips every
// row that shares the last one's code), so `orderBy` is their whole primary key, walked by offset.
const TABLES = [
  { table: "source_of_sales_fact_rollup",              pkCol: "id", pkType: "int", color: "F97316" },
  { table: "source_of_sales_customer_directory_rollup", orderBy: ["batch_id", "period", "distributor_code", "client_code", "product_code", "is_direct"], color: "FB923C" },
  { table: "source_of_sales_customer_presence_rollup",  orderBy: ["batch_id", "period", "client_code", "official_line", "region_code"], color: "FED7AA" },
];

const PAGE_SIZE = 500;

function safeValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
  return v;
}

async function fetchCursor(table, pkCol, pkType) {
  const rows = [];
  let cursor = pkType === "int" ? -1 : null;
  while (true) {
    let q = supabase.from(table).select("*").order(pkCol, { ascending: true }).limit(PAGE_SIZE);
    if (cursor !== null) q = q.gt(pkCol, cursor);
    const { data, error } = await q;
    // A failed page is never the end of the data: an export that stops quietly is a short backup.
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    process.stdout.write(`\r  ${table}: ${rows.length.toLocaleString()} rows`);
    if (batch.length < PAGE_SIZE) break;
    const last = batch[batch.length - 1][pkCol];
    if (last === undefined || last === null) break;
    cursor = last;
  }
  return rows;
}

async function fetchOffset(table, orderBy) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = supabase.from(table).select("*");
    for (const column of orderBy) q = q.order(column, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    process.stdout.write(`\r  ${table}: ${rows.length.toLocaleString()} rows`);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = resolve("backups");
  const jsonDir = join(outDir, "json");
  mkdirSync(jsonDir, { recursive: true });

  console.log("\nPhoenix — SoS Derived Tables Export");
  console.log(`Tables: ${TABLES.length}\n`);

  const datasets = [];

  for (const { table, pkCol, pkType, orderBy, color } of TABLES) {
    process.stdout.write(`  ${table}: fetching...`);
    const rows = orderBy ? await fetchOffset(table, orderBy) : await fetchCursor(table, pkCol, pkType);
    const normalized = rows.map(row => {
      const r = {};
      for (const [k, v] of Object.entries(row)) r[k] = safeValue(v);
      return r;
    });
    datasets.push({ table, color, rows: normalized });
    writeFileSync(join(jsonDir, `${table}.json`), JSON.stringify(normalized, null, 2), "utf-8");
    process.stdout.write(`\r  ✓ ${table}: ${normalized.length.toLocaleString()} rows\n`);
  }

  // XLSX — streaming
  const xlsxPath = join(outDir, `phoenix-backup-sos-derived-${stamp}.xlsx`);
  console.log(`\nBuilding XLSX...`);

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: xlsxPath, useStyles: true, useSharedStrings: false });

  // Contents sheet
  const contents = wb.addWorksheet("Contents", { properties: { tabColor: { argb: "FF1E293B" } } });
  contents.columns = [{ header: "Table", key: "table", width: 55 }, { header: "Rows", key: "rows", width: 12 }];
  const ch = contents.getRow(1);
  ch.font = { bold: true, color: { argb: "FFFFFFFF" } };
  ch.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
  ch.commit();

  for (const { table, color, rows } of datasets) {
    contents.addRow({ table, rows: rows.length }).commit();

    const sheet = wb.addWorksheet(table.slice(0, 31), { properties: { tabColor: { argb: `FF${color}` } } });
    if (rows.length === 0) { sheet.addRow(["(no rows)"]).commit(); await sheet.commit(); continue; }

    const headers = [...new Set(rows.flatMap(r => Object.keys(r)))].sort();
    sheet.columns = headers.map(h => ({ key: h, header: h, width: Math.max(12, Math.min(60, h.length + 4)) }));

    const hr = sheet.getRow(1);
    headers.forEach((h, i) => { hr.getCell(i + 1).value = h; });
    hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
    hr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
    hr.commit();

    for (const row of rows) {
      sheet.addRow(headers.map(h => { const v = row[h]; return (v === null || v === undefined) ? "" : v; })).commit();
    }
    await sheet.commit();
    console.log(`  ✓ Sheet: ${table}`);
  }

  await contents.commit();
  await wb.commit();

  const total = datasets.reduce((s, d) => s + d.rows.length, 0);
  console.log(`\n✓ XLSX saved: backups/phoenix-backup-sos-derived-${stamp}.xlsx`);
  console.log(`✓ JSON saved: backups/json/ (${TABLES.length} files)`);
  console.log(`✓ Total rows: ${total.toLocaleString()}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
