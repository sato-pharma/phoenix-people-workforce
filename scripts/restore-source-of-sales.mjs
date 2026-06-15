// Restore the Source-of-Sales tables from a backup folder (made by backup-source-of-sales.mjs).
//
// Usage:
//   DRY-RUN (default, writes nothing):
//     node scripts/restore-source-of-sales.mjs "F:/Phoenix Workforce/source-of-sales-backup-20260608"
//   COMMIT (actually inserts):
//     node scripts/restore-source-of-sales.mjs "F:/Phoenix Workforce/source-of-sales-backup-20260608" --commit
//
// - Self-loads .env.local (service-role key stays on this machine).
// - Inserts in FK-safe PARENT -> CHILD order so foreign keys always resolve.
// - For tables whose `id` is an auto IDENTITY column, the `id` is DROPPED so the database
//   re-assigns it (those ids are surrogate keys referenced by nothing). All other columns
//   — including FK keys like batch_id / brick_id — are preserved exactly.
// - Targets EMPTY tables (post-truncate), so it uses plain chunked INSERT (no conflicts).

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
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
const BACKUP = process.argv[2];
const COMMIT = process.argv.includes("--commit");
const FORCE = process.argv.includes("--force"); // allow restore into non-empty tables (rare)

if (!URL || !KEY) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!BACKUP) { console.error("Pass the backup folder path."); process.exit(1); }

const supabase = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// PARENT -> CHILD insert order (regions before areas before blocks before bricks; distributors
// and products before their aliases / batches; batches before rows & summaries).
const ORDER = [
  "source_of_sales_regions",
  "source_of_sales_areas",
  "source_of_sales_blocks",
  "source_of_sales_bricks",
  "source_of_sales_distributors",
  "source_of_sales_products",
  "source_of_sales_area_regions",
  "source_of_sales_distributor_profile",
  "source_of_sales_region_aliases",
  "source_of_sales_area_aliases",
  "source_of_sales_product_aliases",
  "source_of_sales_territory_aliases",
  "source_of_sales_customer_map",
  "source_of_sales_import_batches",
  "source_of_sales_import_rows",
  "source_of_sales_import_summaries",
  "source_of_sales_reference_issues",
];

// Tables whose `id` is a database-assigned IDENTITY column (drop it on restore).
const IDENTITY_ID = new Set([
  "source_of_sales_region_aliases",
  "source_of_sales_area_aliases",
  "source_of_sales_product_aliases",
  "source_of_sales_territory_aliases",
  "source_of_sales_customer_map",
  "source_of_sales_import_rows",
  "source_of_sales_import_summaries",
  "source_of_sales_reference_issues",
]);

const CHUNK = 500;

// Current row count of a table (head request — no data transfer).
async function tableCount(table) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

// ---- Pre-flight (runs in BOTH dry-run and commit): every backup file present + every target empty ----
const plan = [];
const missing = [];
const nonEmpty = [];
for (const table of ORDER) {
  const file = `${BACKUP}/${table}.json`;
  if (!existsSync(file)) { missing.push(table); continue; }
  const backupRows = JSON.parse(readFileSync(file, "utf8")).length;
  const current = await tableCount(table);
  plan.push({ table, file, backupRows, current });
  if (current > 0) nonEmpty.push(table);
}

console.log("Pre-flight:");
for (const p of plan) console.log(`  ${p.table.padEnd(38)} backup=${String(p.backupRows).padStart(6)}  currentInDb=${p.current}`);
if (missing.length) console.log(`  MISSING backup files: ${missing.join(", ")}`);

// A partial backup folder must NEVER drive a partial restore.
if (missing.length) {
  console.error(`\nABORT: ${missing.length} expected backup file(s) missing — refusing a partial restore.`);
  process.exit(1);
}

const plannedRows = plan.reduce((s, p) => s + p.backupRows, 0);

if (!COMMIT) {
  console.log(`\nDRY-RUN: would restore ${plannedRows} rows into ${plan.length} tables (no changes written).`);
  if (nonEmpty.length) {
    console.log(`WARNING: ${nonEmpty.length} target table(s) already hold data: ${nonEmpty.join(", ")}.`);
    console.log("Restore expects EMPTY tables; running --commit now would DUPLICATE rows. Truncate first (or use --force).");
  } else {
    console.log("All target tables are empty — safe to re-run with --commit.");
  }
  process.exit(0);
}

if (nonEmpty.length && !FORCE) {
  console.error(`\nABORT: ${nonEmpty.length} target table(s) are NOT empty: ${nonEmpty.join(", ")}.`);
  console.error("Restore expects freshly-truncated tables — re-running would DUPLICATE identity rows.");
  console.error(`Run this first, then retry:\n  TRUNCATE TABLE ${ORDER.join(", ")} RESTART IDENTITY;`);
  console.error("(or pass --force if you are certain).");
  process.exit(1);
}

// ---- Commit ----
console.log("\nNote: surrogate `id`s on identity tables are reassigned by the DB (the backup id values are not preserved); nothing references them.");
const touched = [];
let grandTotal = 0;
try {
  for (const { table, file } of plan) {
    let rows = JSON.parse(readFileSync(file, "utf8"));
    if (IDENTITY_ID.has(table)) rows = rows.map(({ id: _id, ...rest }) => rest);
    touched.push(table);
    let done = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK));
      if (error) throw new Error(`${table} (chunk @${i}): ${error.message}`);
      done += Math.min(CHUNK, rows.length - i);
    }
    console.log(`RESTORED ${table.padEnd(38)} ${done}`);
    grandTotal += done;
  }
  console.log(`\nRESTORED ${grandTotal} rows across ${plan.length} tables.`);
} catch (err) {
  // No cross-table transaction is possible over PostgREST, so on failure tell the operator
  // exactly how to get back to a clean empty state and retry from the same backup.
  console.error(`\nRESTORE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Tables written before the failure (now partially populated): ${touched.join(", ") || "(none)"}`);
  console.error("Return to a clean empty state, then retry, with:");
  console.error(`  TRUNCATE TABLE ${ORDER.join(", ")} RESTART IDENTITY;`);
  process.exit(1);
}
