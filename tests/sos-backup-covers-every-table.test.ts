import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKUP_TABLES,
  KEPT_TABLES,
  LATE_COLUMNS,
  NOT_BACKED_UP,
  REBUILT_TABLES,
  RESTORED_TABLES,
} from "../scripts/lib/source-of-sales-tables.mjs";

// The Source of Sales backup and restore (SoS re-measure 2026-09-18, #23). Both scripts kept their
// own list of seventeen tables, and both left out the fact rollup, the customer directory and
// presence rollups and the mapping audit. A restore brought the import rows back and nothing the
// dashboards and the Monthly Closing read from them, and printed RESTORED.
//
// The table set here is derived from the migrations rather than written out, so a Source of Sales
// table added later fails this test until the shared list says what happens to it.

// Live in production (pg_class, 2026-09-18) but created outside supabase/migrations, so the scan
// below cannot see them. They stay in the backup; the stale-entry check skips them.
const CREATED_OUTSIDE_MIGRATIONS = new Set(["source_of_sales_brick_move_files"]);

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** Every public source_of_sales_* / sos_* table the migrations leave standing, in migration order. */
function sourceOfSalesTablesFromMigrations(): Set<string> {
  const dir = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
  const live = new Set<string>();
  const statement =
    /\b(create\s+(?:unlogged\s+)?table|drop\s+table|alter\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)(?:\s+rename\s+to\s+"?(\w+)"?)?/gi;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = stripSqlComments(readFileSync(join(dir, file), "utf8"));
    for (const match of sql.matchAll(statement)) {
      const verb = match[1].toLowerCase().replace(/\s+/g, " ");
      const qualified = match[2].replace(/"/g, "");
      const [schema, name] = qualified.includes(".") ? qualified.split(".") : ["public", qualified];
      if (schema.toLowerCase() !== "public" || !/^(source_of_sales_|sos_)/.test(name)) continue;
      if (verb.startsWith("create")) live.add(name);
      else if (verb === "drop table") live.delete(name);
      else if (match[3]) {
        live.delete(name);
        live.add(match[3]);
      }
    }
  }
  return live;
}

export function runSosBackupCoversEveryTableTests() {
  const fromMigrations = sourceOfSalesTablesFromMigrations();
  assert.ok(fromMigrations.has("source_of_sales_import_rows"), "the migration scan finds the Source of Sales tables");

  const backedUp = BACKUP_TABLES.map(({ table }) => table);
  const skipped = NOT_BACKED_UP.map(({ table }) => table);
  const listed = [...backedUp, ...skipped];

  // ── Every Source of Sales table is backed up, or says why not ──
  for (const table of [...fromMigrations].sort()) {
    assert.ok(
      listed.includes(table),
      `every Source of Sales table is backed up: ${table} is in no list in scripts/lib/source-of-sales-tables.mjs. `
      + "Add it to RESTORED_TABLES, REBUILT_TABLES or KEPT_TABLES, or to NOT_BACKED_UP with the reason.",
    );
  }
  for (const table of listed) {
    if (CREATED_OUTSIDE_MIGRATIONS.has(table)) {
      assert.ok(!fromMigrations.has(table), `${table} now has a migration; take it off CREATED_OUTSIDE_MIGRATIONS`);
      continue;
    }
    assert.ok(fromMigrations.has(table), `${table} is listed for the backup but no migration leaves it standing`);
  }
  assert.equal(new Set(listed).size, listed.length, "no table is listed twice");

  // The four the re-measure named, by name.
  for (const table of [
    "source_of_sales_fact_rollup",
    "source_of_sales_customer_directory_rollup",
    "source_of_sales_customer_presence_rollup",
    "source_of_sales_mapping_audit",
  ]) {
    assert.ok(backedUp.includes(table), `${table} is backed up`);
  }

  for (const { table, reason } of [...KEPT_TABLES, ...NOT_BACKED_UP]) {
    assert.ok(reason.trim().length > 40, `${table} says why the restore leaves it out`);
  }
  for (const { table, key } of BACKUP_TABLES) {
    assert.ok(key.length > 0, `${table} names the key the backup pages by`);
  }

  // ── Blocks and bricks point at each other; the restore breaks the loop ──
  const order = RESTORED_TABLES.map(({ table }) => table);
  assert.ok(order.indexOf("source_of_sales_blocks") < order.indexOf("source_of_sales_bricks"), "blocks are written before bricks");
  assert.ok(
    LATE_COLUMNS.some((late) => late.table === "source_of_sales_blocks" && late.column === "master_brick_id" && late.after === "source_of_sales_bricks"),
    "a block's master brick is filled in after the bricks exist; every block names one, so the first block insert fails without this",
  );
  for (const late of LATE_COLUMNS) {
    assert.ok(order.includes(late.table) && order.includes(late.after), `${late.table}.${late.column} waits for a restored table`);
  }

  // ── The backup reads the shared list and keeps no list of its own ──
  const backup = readSource("../scripts/backup-source-of-sales.mjs");
  assert.match(backup, /import \{[^}]*\bBACKUP_TABLES\b[^}]*\} from "\.\/lib\/source-of-sales-tables\.mjs"/, "the backup imports the shared list");
  assert.match(backup, /for \(const \{ table, key \} of BACKUP_TABLES\)/, "the backup writes every table in the shared list");
  assert.doesNotMatch(backup, /const TABLES\s*=/, "the backup keeps no table list of its own");

  // ── The restore reads the shared list and rebuilds the rollups ──
  const restore = readSource("../scripts/restore-source-of-sales.mjs");
  assert.match(restore, /const ORDER = RESTORED_TABLES\.map/, "the restore writes the tables in the shared list's order");
  assert.doesNotMatch(restore, /const ORDER = \[/, "the restore keeps no table list of its own");
  const insertAt = restore.indexOf("RESTORED ${grandTotal} rows");
  const rebuildAt = restore.indexOf('"scripts/rebuild-source-of-sales-rollups.ts"');
  assert.ok(insertAt > 0 && rebuildAt > insertAt, "the restore rebuilds the rollups after it writes the rows");
  assert.match(restore, /"--apply"/, "the restore runs the rebuild for real, not as a dry run");
  assert.match(
    restore,
    /if \(rebuild\.status !== 0\) \{[\s\S]{0,400}process\.exit\(1\);/,
    "a failed rebuild makes the restore exit 1: the rows are back but every rollup is out of step",
  );
  assert.match(restore, /from\("monthly_closing_locks"\)/, "the restore checks the closing locks before it writes anything");

  // ── The rebuild runs the import's chain for every validated batch ──
  const script = readSource("../scripts/rebuild-source-of-sales-rollups.ts");
  assert.match(script, /\.eq\("status", "validated"\)/, "the rebuild covers every validated batch, the only kind with rollups");
  assert.match(script, /rebuildSourceOfSalesRollupsForBatch\(supabase, batch\.id\)/, "the rebuild runs the shared chain per batch");
  assert.match(script, /process\.exit\(1\)/, "a failed rebuild exits 1");

  const chain = readSource("../src/lib/sales/source-of-sales-rollup-rebuild.ts");
  const steps = [
    'rpc("phx_refresh_sos_fact_rollup"',
    'rpc("phx_refresh_sos_customer_directory_rollup"',
    'rpc("phx_refresh_marketing_roi_facts"',
    'rpc("phx_refresh_sos_channel_rollup"',
    'rpc("phx_refresh_sos_distributor_product_rollup"',
    "writeStoreSplitNetForBatch(supabase, batchId)",
    'rpc("phx_refresh_monthly_attribution"',
    'rpc("phx_refresh_sos_import_summaries"',
  ];
  let previous = -1;
  for (const step of steps) {
    const at = chain.indexOf(step);
    assert.ok(at > previous, `the rebuild runs ${step} after the step it reads from, as an import does`);
    previous = at;
  }
  assert.equal(
    (chain.match(/orThrow\("/g) ?? []).length,
    7,
    "every refresh in the rebuild throws on failure: a rollup that silently failed leaves a screen wrong with no error",
  );
  assert.ok(REBUILT_TABLES.length >= 5, "the rebuilt rollups are listed");
}
