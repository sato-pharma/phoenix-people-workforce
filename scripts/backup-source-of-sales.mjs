// One-off backup of every Source-of-Sales table to local JSON files.
//
// Usage:
//   node scripts/backup-source-of-sales.mjs "F:/Phoenix Workforce/source-of-sales-backup-YYYYMMDD"
//
// - Self-loads .env.local (so the service-role key stays on this machine).
// - Pulls each table in full (PostgREST db-max-rows is unset on this project) with a
//   keyset fallback for very large tables, and writes <table>.json + _manifest.json.
// - Read-only: it never writes to the database.

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT = process.argv[2];

if (!URL || !KEY) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!OUT) { console.error("Pass an output folder, e.g. \"F:/Phoenix Workforce/source-of-sales-backup-20260608\""); process.exit(1); }

const supabase = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// [table, primaryKey] — ordered child -> parent so the same file list can drive a restore.
// PostgREST caps responses at 1000 rows, so EVERY table is paged by its PK (stable order,
// no skips/overlaps) until a short page is returned.
const TABLES = [
  ["source_of_sales_import_rows", "id"],
  ["source_of_sales_import_summaries", "id"],
  ["source_of_sales_import_batches", "id"],
  ["source_of_sales_customer_map", "id"],
  ["source_of_sales_territory_aliases", "id"],
  ["source_of_sales_bricks", "brick_id"],
  ["source_of_sales_blocks", "block_code"],
  ["source_of_sales_area_aliases", "id"],
  ["source_of_sales_areas", "area_code"],
  ["source_of_sales_area_regions", "area_code"],
  ["source_of_sales_region_aliases", "id"],
  ["source_of_sales_regions", "region_code"],
  ["source_of_sales_product_aliases", "id"],
  ["source_of_sales_products", "product_code"],
  ["source_of_sales_distributor_profile", "distributor_code"],
  ["source_of_sales_distributors", "distributor_code"],
  ["source_of_sales_reference_issues", "id"],
];

async function fetchAll(table, pk) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(pk, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
let total = 0;
for (const [table, pk] of TABLES) {
  const rows = await fetchAll(table, pk);
  writeFileSync(`${OUT}/${table}.json`, JSON.stringify(rows));
  manifest.push({ table, rows: rows.length });
  total += rows.length;
  console.log(`${table.padEnd(38)} ${rows.length}`);
}
writeFileSync(`${OUT}/_manifest.json`, JSON.stringify({
  exportedAtUtc: new Date().toISOString(),
  source: URL,
  totalRows: total,
  tables: manifest,
}, null, 2));
console.log(`\nTOTAL ROWS BACKED UP: ${total}`);
console.log(`Folder: ${OUT}`);
