// One-off backup of every Source-of-Sales table to local JSON files.
//
// Usage:
//   node scripts/backup-source-of-sales.mjs "F:/Phoenix Workforce/source-of-sales-backup-YYYYMMDD"
//
// - Self-loads .env.local (so the service-role key stays on this machine).
// - Pulls every table in scripts/lib/source-of-sales-tables.mjs in full, the rollups included,
//   and writes <table>.json + _manifest.json.
// - Read-only: it never writes to the database.

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { BACKUP_TABLES, NOT_BACKED_UP } from "./lib/source-of-sales-tables.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "backup-source-of-sales",
  entry: import.meta.url,
  known: [],
  hints: [
    "its one argument is the output path: node scripts/backup-source-of-sales.mjs <out>",
  ],
});

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

// Every table the restore needs, from the one shared list (scripts/lib/source-of-sales-tables.mjs).
// Until 2026-09-18 this file kept its own list of seventeen tables and left out every rollup the
// dashboards and the closing read, so a restore could not bring them back.
//
// PostgREST caps responses at 1000 rows, so EVERY table is paged in a stable order until a short
// page comes back: by its key when that is one column, and by every key column with offsets when
// the key spans several.
async function fetchAll(table, key) {
  return key.length === 1 ? fetchByKeyset(table, key[0]) : fetchByOffset(table, key);
}

async function fetchByKeyset(table, pk) {
  const rows = [];
  const pageSize = 1000;
  let lastPk = null;
  for (;;) {
    let query = supabase
      .from(table)
      .select("*")
      .order(pk, { ascending: true })
      .limit(pageSize);
    if (lastPk !== null) query = query.gt(pk, lastPk);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (data && data.length > 0) lastPk = data[data.length - 1][pk];
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function fetchByOffset(table, key) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select("*");
    for (const column of key) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
let total = 0;
for (const { table, key } of BACKUP_TABLES) {
  const rows = await fetchAll(table, key);
  writeFileSync(`${OUT}/${table}.json`, JSON.stringify(rows));
  manifest.push({ table, rows: rows.length });
  total += rows.length;
  console.log(`${table.padEnd(44)} ${rows.length}`);
}
writeFileSync(`${OUT}/_manifest.json`, JSON.stringify({
  exportedAtUtc: new Date().toISOString(),
  source: URL,
  totalRows: total,
  tables: manifest,
  notBackedUp: NOT_BACKED_UP,
}, null, 2));
console.log(`\nTOTAL ROWS BACKED UP: ${total}`);
console.log(`Folder: ${OUT}`);
