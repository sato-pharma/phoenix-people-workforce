// Restore the Source-of-Sales tables from a backup folder (made by backup-source-of-sales.mjs).
//
// Usage:
//   DRY-RUN (default, writes nothing):
//     node scripts/restore-source-of-sales.mjs "F:/Phoenix Workforce/source-of-sales-backup-20260608"
//   COMMIT (actually inserts, then rebuilds the rollups):
//     node scripts/restore-source-of-sales.mjs "F:/Phoenix Workforce/source-of-sales-backup-20260608" --commit
//
// - Self-loads .env.local (service-role key stays on this machine).
// - The tables and what happens to each come from scripts/lib/source-of-sales-tables.mjs, the same
//   list the backup reads.
// - Inserts in FK-safe PARENT -> CHILD order so foreign keys always resolve. A column that points
//   at a brick is filled in once the bricks exist (LATE_COLUMNS).
// - For tables whose `id` is an auto IDENTITY column, the `id` is DROPPED so the database
//   re-assigns it (those ids are surrogate keys referenced by nothing). All other columns
//   — including FK keys like batch_id / brick_id — are preserved exactly.
// - Targets EMPTY tables (post-truncate), so it uses plain chunked INSERT (no conflicts).
// - THEN REBUILDS THE ROLLUPS. The fact, presence, customer directory, channel and distributor x
//   product rollups, marketing ROI, the split net, attribution and the import summaries are all
//   computed from the rows, so --commit runs scripts/rebuild-source-of-sales-rollups.ts after the
//   inserts. Until 2026-09-18 a restore stopped at the rows and left every screen reading rollups
//   that no longer matched them (SoS re-measure 2026-09-18, #23).

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { LATE_COLUMNS, REBUILT_TABLES, RESTORED_TABLES } from "./lib/source-of-sales-tables.mjs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "restore-source-of-sales",
  entry: import.meta.url,
  known: ["--commit", "--force"],
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
const BACKUP = process.argv[2];
const COMMIT = process.argv.includes("--commit");
const FORCE = process.argv.includes("--force"); // allow restore into non-empty tables (rare)

if (!URL || !KEY) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
if (!BACKUP) { console.error("Pass the backup folder path."); process.exit(1); }

const supabase = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// PARENT -> CHILD insert order (regions before areas before blocks before bricks; distributors
// and products before their aliases / batches; batches before rows & summaries).
const ORDER = RESTORED_TABLES.map(({ table }) => table);
const REBUILT = REBUILT_TABLES.map(({ table }) => table);

// Tables whose `id` is a database-assigned IDENTITY column (drop it on restore).
const IDENTITY_ID = new Set(RESTORED_TABLES.filter(({ dropId }) => dropId).map(({ table }) => table));

// Everything a clean restore starts from empty: the restored tables and the rollups rebuilt from them.
const TRUNCATE_HINT = `  TRUNCATE TABLE ${[...ORDER, ...REBUILT].join(", ")} RESTART IDENTITY;`;

const CHUNK = 500;

// Current row count of a table (head request — no data transfer).
async function tableCount(table) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

// The closing lock key, exactly as phx_reject_write_to_locked_closing matches it on import rows.
const lockKey = (period, line) => `${period}|${String(line ?? "").trim().toLowerCase()}`;

// ---- Pre-flight (runs in BOTH dry-run and commit): every backup file present + every target empty ----
const plan = [];
const missing = [];
const nonEmpty = [];
const rowLockKeys = new Set();
for (const table of ORDER) {
  const file = `${BACKUP}/${table}.json`;
  if (!existsSync(file)) { missing.push(table); continue; }
  const rows = JSON.parse(readFileSync(file, "utf8"));
  if (table === "source_of_sales_import_rows") {
    for (const row of rows) rowLockKeys.add(lockKey(row.invoice_period, row.official_line));
  }
  const current = await tableCount(table);
  plan.push({ table, file, backupRows: rows.length, current });
  if (current > 0) nonEmpty.push(table);
}
for (const table of REBUILT) {
  if (await tableCount(table) > 0) nonEmpty.push(table);
}

console.log("Pre-flight:");
for (const p of plan) console.log(`  ${p.table.padEnd(44)} backup=${String(p.backupRows).padStart(6)}  currentInDb=${p.current}`);
console.log(`  Rebuilt from the rows after the insert: ${REBUILT.join(", ")}`);
if (missing.length) console.log(`  MISSING backup files: ${missing.join(", ")}`);

// A partial backup folder must NEVER drive a partial restore.
if (missing.length) {
  console.error(`\nABORT: ${missing.length} expected backup file(s) missing — refusing a partial restore.`);
  console.error("A backup made before 2026-09-18 lacks the tables added to the list since; take a fresh backup.");
  process.exit(1);
}

// A locked closing refuses every import row written into it, so the restore would stop partway.
const { data: locks, error: locksError } = await supabase
  .from("monthly_closing_locks")
  .select("line, period, normalized_line")
  .is("unlocked_at", null);
if (locksError) { console.error(`\nABORT: cannot read the closing locks: ${locksError.message}`); process.exit(1); }
const lockedHits = (locks ?? []).filter((lock) => rowLockKeys.has(lockKey(lock.period, lock.normalized_line)));
if (lockedHits.length) {
  const names = lockedHits.map((lock) => `${lock.line} ${lock.period}`).sort().join(", ");
  console.error(`\nABORT: the backup holds sales for ${lockedHits.length} locked closing(s): ${names}.`);
  console.error("A locked closing refuses every row written into it. Unlocking a month is the owner's decision.");
  process.exit(1);
}

const plannedRows = plan.reduce((s, p) => s + p.backupRows, 0);

if (!COMMIT) {
  console.log(`\nDRY-RUN: would restore ${plannedRows} rows into ${plan.length} tables, then rebuild ${REBUILT.length} rollups (no changes written).`);
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
  console.error(`Run this first, then retry:\n${TRUNCATE_HINT}`);
  console.error("(or pass --force if you are certain).");
  process.exit(1);
}

// ---- Commit ----
console.log("\nNote: surrogate `id`s on identity tables are reassigned by the DB (the backup id values are not preserved); nothing references them.");
const touched = [];
const lateValues = []; // [{ late, values: [[key, value], ...] }]
let grandTotal = 0;
try {
  for (const { table, file } of plan) {
    let rows = JSON.parse(readFileSync(file, "utf8"));
    if (IDENTITY_ID.has(table)) rows = rows.map(({ id: _id, ...rest }) => rest);
    for (const late of LATE_COLUMNS.filter((entry) => entry.table === table)) {
      lateValues.push({ late, values: rows.filter((row) => row[late.column] != null).map((row) => [row[late.key], row[late.column]]) });
      rows = rows.map((row) => ({ ...row, [late.column]: null }));
    }
    touched.push(table);
    let done = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK));
      if (error) throw new Error(`${table} (chunk @${i}): ${error.message}`);
      done += Math.min(CHUNK, rows.length - i);
    }
    console.log(`RESTORED ${table.padEnd(44)} ${done}`);
    grandTotal += done;

    // Now that this table is written, fill in every column that was waiting for it.
    for (const { late, values } of lateValues.filter((entry) => entry.late.after === table)) {
      for (const [key, value] of values) {
        const { error } = await supabase.from(late.table).update({ [late.column]: value }).eq(late.key, key);
        if (error) throw new Error(`${late.table}.${late.column} for ${key}: ${error.message}`);
      }
      console.log(`RESTORED ${`${late.table}.${late.column}`.padEnd(44)} ${values.length}`);
    }
  }
  console.log(`\nRESTORED ${grandTotal} rows across ${plan.length} tables.`);
} catch (err) {
  // No cross-table transaction is possible over PostgREST, so on failure tell the operator
  // exactly how to get back to a clean empty state and retry from the same backup.
  console.error(`\nRESTORE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Tables written before the failure (now partially populated): ${touched.join(", ") || "(none)"}`);
  console.error("Return to a clean empty state, then retry, with:");
  console.error(TRUNCATE_HINT);
  process.exit(1);
}

// ---- Rebuild the rollups from the restored rows ----
// The same chain an import runs, for every validated batch. A separate process because the chain
// lives in the TypeScript domain code (src/lib/sales/source-of-sales-rollup-rebuild.ts).
const REBUILD_ARGS = [
  "--env-file-if-exists=.env.local",
  "--experimental-strip-types",
  "--experimental-specifier-resolution=node",
  "--experimental-loader",
  "./tests/alias-loader.mjs",
  "scripts/rebuild-source-of-sales-rollups.ts",
  "--apply",
];
console.log("\nRebuilding the rollups from the restored rows...");
const rebuild = spawnSync(process.execPath, REBUILD_ARGS, { stdio: "inherit" });
if (rebuild.status !== 0) {
  console.error("\nThe rows are restored, but the rollups are NOT rebuilt: every screen that reads them is out of step.");
  console.error("Re-run the rebuild alone (safe to repeat) from the repo root:");
  console.error(`  node ${REBUILD_ARGS.join(" ")}`);
  process.exit(1);
}

// What the rebuild produced against what the backup held. A difference is not always wrong (a
// refresh function may have changed since the backup), so it is reported, not refused.
const manifestFile = `${BACKUP}/_manifest.json`;
const backedUp = new Map(
  existsSync(manifestFile)
    ? JSON.parse(readFileSync(manifestFile, "utf8")).tables.map(({ table, rows }) => [table, rows])
    : [],
);
console.log("\nRebuilt rollups against the backup:");
for (const table of REBUILT) {
  const now = await tableCount(table);
  const before = backedUp.get(table);
  const note = before === undefined ? "not in the backup" : before === now ? "matches" : `DIFFERS by ${now - before}`;
  console.log(`  ${table.padEnd(44)} backup=${String(before ?? "-").padStart(7)}  rebuilt=${String(now).padStart(7)}  ${note}`);
}
