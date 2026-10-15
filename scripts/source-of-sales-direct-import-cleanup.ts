import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  BATCH_CASCADE_CHILD_TABLES,
  LINKED_RUN_STEP_TABLE,
  assertBackupCoversCascade,
  classifyDirectCleanupBatches,
  cleanupSafetyBanner,
} from "../src/lib/sales/direct-cleanup-safety.ts";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "source-of-sales-direct-import-cleanup",
  entry: import.meta.url,
  known: ["--out", "--backup-dir", "--apply", "--confirm-production-delete", "--help", "-h"],
});

type Options = Record<string, string | boolean>;
type SupabaseQueryResult = {
  count?: number | null;
  data?: unknown[] | null;
  error?: { message: string } | null;
};
type SupabaseQuery = PromiseLike<SupabaseQueryResult> & {
  eq: (column: string, value: unknown) => SupabaseQuery;
  ilike: (column: string, pattern: string) => SupabaseQuery;
  in: (column: string, values: readonly unknown[]) => SupabaseQuery;
  or: (filters: string) => SupabaseQuery;
  order: (column: string, options?: { ascending?: boolean }) => SupabaseQuery;
  range: (from: number, to: number) => SupabaseQuery;
};
type SupabaseQueryBuilder = (query: SupabaseQuery) => SupabaseQuery;

const productionRef = "ozucdzovmcqvepbozvqf";

function usage(): never {
  console.log(`
Source of Sales Direct import cleanup

Commands:
  preview --out outputs/sos-direct-cleanup-preview.json
  apply   --backup-dir outputs/sos-direct-cleanup-backup --apply --confirm-production-delete

Notes:
${cleanupSafetyBanner()}
  - if affected batches contain only Direct rows, apply deletes those batches and lets row/summary cascades run.
  - if affected batches contain mixed rows, apply deletes only Direct rows and keeps the mixed batches.
`);
  process.exit(1);
}

function parseArgs() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage();
  const options: Options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function optionText(options: Options, key: string, fallback = "") {
  const value = options[key];
  return typeof value === "string" ? value : fallback;
}

function loadEnvFile(fileName: string) {
  const filePath = path.resolve(process.cwd(), fileName);
  try {
    const content = readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const equals = line.indexOf("=");
      if (equals === -1) continue;
      const key = line.slice(0, equals).trim();
      let value = line.slice(equals + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Optional local file.
  }
}

function currentProjectRef() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return "";
  }
}

function supabaseClient() {
  loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function fetchAll<T>(supabase: SupabaseClient, table: string, select = "*", build?: SupabaseQueryBuilder): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(select).range(from, from + pageSize - 1) as unknown as SupabaseQuery;
    if (build) query = build(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function countRows(supabase: SupabaseClient, table: string, build: SupabaseQueryBuilder) {
  const query = build(supabase.from(table).select("*", { count: "exact", head: true }) as unknown as SupabaseQuery);
  const { count, error } = await query;
  if (error) throw new Error(`${table} count: ${error.message}`);
  return count ?? 0;
}

// Fetch every row of `table` linked to these batches.
//
// This used to swallow "does not exist" and return [], which is precisely how the backup came to be
// silently incomplete: it read `monthly_sales_runs`, a table that has never existed, caught the
// error, returned nothing, and printed a count of 0 — indistinguishable from "there were none to
// back up". A missing table is now fatal, because on this path an empty result and an absent table
// have opposite meanings and only one of them is safe to delete against.
//
// PostgREST answers a missing table with PGRST205, not 42P01, so both spellings are treated as one
// set — see AGENTS.md §2.1.
async function fetchByBatchIds<T>(supabase: SupabaseClient, table: string, batchIds: string[]): Promise<T[]> {
  if (batchIds.length === 0) return [];
  try {
    return await fetchAll<T>(supabase, table, "*", (query) => query.in("batch_id", batchIds));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not exist") || message.includes("Could not find the table") || message.includes("PGRST205")) {
      throw new Error(
        `${table} does not exist, so the cleanup cannot prove what it is about to delete. ` +
          `Refusing rather than backing up nothing and reporting success. ` +
          `(If this table was renamed, fix BATCH_CASCADE_CHILD_TABLES / LINKED_RUN_STEP_TABLE in ` +
          `src/lib/sales/direct-cleanup-safety.ts against pg_constraint — never by guessing a name.)`,
      );
    }
    throw error;
  }
}

function directRowsFilter(query: SupabaseQuery) {
  // ilike (no wildcards) on distributor_code so a stray casing variant (e.g. 'Direct') still
  // matches -- a case-sensitive eq here once meant 35 rows never surfaced as "Direct rows" at all.
  return query.or("distributor_code.ilike.DIRECT,is_direct.eq.true,region_code.eq.NATIONAL");
}

function uniqueValues(values: unknown[]) {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

async function buildSnapshot(supabase: SupabaseClient) {
  const directRows = await fetchAll<Record<string, unknown>>(
    supabase,
    "source_of_sales_import_rows",
    "*",
    (query) => directRowsFilter(query).order("invoice_period", { ascending: true }).order("id", { ascending: true }),
  );
  const directBatchIds = uniqueValues(directRows.map((row) => row.batch_id));
  const directBatches = directBatchIds.length === 0
    ? []
    : await fetchAll<Record<string, unknown>>(
      supabase,
      "source_of_sales_import_batches",
      "*",
      (query) => query.in("id", directBatchIds).order("period", { ascending: true }),
    );
  // Back up EVERY table the database removes by itself, plus the linked run steps whose FK is
  // SET NULL. Previously only rows + summaries were captured and five rollup tables were destroyed
  // by cascade into no backup at all.
  const cascade: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of [...BATCH_CASCADE_CHILD_TABLES, LINKED_RUN_STEP_TABLE]) {
    cascade[table] = await fetchByBatchIds<Record<string, unknown>>(supabase, table, directBatchIds);
  }
  const cascadeRowCounts = Object.fromEntries(
    Object.entries(cascade).map(([table, rows]) => [table, rows.length]),
  ) as Record<string, number>;

  const [affectedBatchRows, summaries, monthlyRuns] = [
    cascade["source_of_sales_import_rows"] ?? [],
    cascade["source_of_sales_import_summaries"] ?? [],
    cascade[LINKED_RUN_STEP_TABLE] ?? [],
  ];

  const [directBatchCount, directRowCount, isDirectRowCount, directAreaRowCount, nationalRowCount] = await Promise.all([
    countRows(supabase, "source_of_sales_import_batches", (query) => query.ilike("distributor_code", "DIRECT")),
    countRows(supabase, "source_of_sales_import_rows", (query) => query.ilike("distributor_code", "DIRECT")),
    countRows(supabase, "source_of_sales_import_rows", (query) => query.eq("is_direct", true)),
    countRows(supabase, "source_of_sales_import_rows", (query) => query.eq("area_code", "DIRECT")),
    countRows(supabase, "source_of_sales_import_rows", (query) => query.eq("region_code", "NATIONAL")),
  ]);
  const directRowIds = new Set(directRows.map((row) => String(row.id)));
  const nonDirectRowsInAffectedBatches = affectedBatchRows.filter((row) => !directRowIds.has(String(row.id)));
  const directRowPeriodBreakdown = summarizeRows(directRows, (row) => String(row.invoice_period || "Unassigned"));
  const directRowBatchBreakdown = summarizeRows(directRows, (row) => String(row.batch_id || "Unassigned"));
  const deletionMode = nonDirectRowsInAffectedBatches.length === 0 ? "delete_batches" : "delete_direct_rows_only";

  return {
    cascade,
    cascadeRowCounts,
    counts: {
      affectedBatchCount: directBatches.length,
      affectedBatchTotalRowCount: affectedBatchRows.length,
      directAreaRowCount,
      directBatchCount,
      directRowCount,
      directRowsMatchedForDeletion: directRows.length,
      isDirectRowCount,
      linkedMonthlyRunCount: monthlyRuns.length,
      nationalRowCount,
      nonDirectRowsInAffectedBatches: nonDirectRowsInAffectedBatches.length,
      summaryCount: summaries.length,
    },
    deletionMode,
    directBatches: directBatches.map((batch) => ({
      created_at: batch.created_at,
      distributor_code: batch.distributor_code,
      failed_rows: batch.failed_rows,
      file_name: batch.file_name,
      id: batch.id,
      importable_rows: batch.importable_rows,
      period: batch.period,
      status: batch.status,
      total_rows: batch.total_rows,
      warning_rows: batch.warning_rows,
    })),
    directRowBatchBreakdown,
    directRowPeriodBreakdown,
    monthlyRuns,
    nonDirectRowsInAffectedBatches,
    rows: directRows,
    summaries,
  };
}

function summarizeRows(rows: Array<Record<string, unknown>>, keyOf: (row: Record<string, unknown>) => string) {
  const summary = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }
  return [...summary.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ count, key }));
}

function writeJson(filePath: string, payload: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function preview(options: Options) {
  const supabase = supabaseClient();
  const snapshot = await buildSnapshot(supabase);
  const out = optionText(options, "out");
  if (out) writeJson(out, snapshot);
  console.log(JSON.stringify({
    counts: snapshot.counts,
    deletionMode: snapshot.deletionMode,
    directBatches: snapshot.directBatches,
    directRowBatchBreakdown: snapshot.directRowBatchBreakdown,
    directRowPeriodBreakdown: snapshot.directRowPeriodBreakdown,
    projectRef: currentProjectRef(),
  }, null, 2));
  if (out) console.log(`Preview written: ${out}`);
}

async function apply(options: Options) {
  if (options.apply !== true || options["confirm-production-delete"] !== true) {
    throw new Error("apply requires both --apply and --confirm-production-delete.");
  }
  loadEnvFile(".env.local");
  if (currentProjectRef() !== productionRef) {
    throw new Error(`Refusing production delete because NEXT_PUBLIC_SUPABASE_URL is ${currentProjectRef()}, expected ${productionRef}.`);
  }

  const supabase = supabaseClient();
  const snapshot = await buildSnapshot(supabase);

  // ── GUARD 1: never delete the live vintage ───────────────────────────────────────────────────
  // The row filter matches on `is_direct`, which is true for the system's own direct orders as well
  // as the retired Excel uploads. Measured on production 2026-09-05: 8 batches / 10,789,398.01 EGP
  // matched, of which 2026-08 `DirectReq` (23 rows, 293,837.57 EGP) matched ONLY via `is_direct`.
  // Deleting that destroys sales Finance has booked, in the month it booked them — AGENTS.md §4.
  const { deletable, protectedLive } = classifyDirectCleanupBatches(
    snapshot.directBatches.map((batch) => ({
      distributor_code: batch.distributor_code == null ? null : String(batch.distributor_code),
      id: String(batch.id),
      period: batch.period == null ? null : String(batch.period),
      status: batch.status == null ? null : String(batch.status),
    })),
  );

  if (protectedLive.length > 0) {
    console.log(`\nREFUSED — ${protectedLive.length} batch(es) are protected and will NOT be deleted:`);
    for (const batch of protectedLive) console.log(`  ${batch.period} ${batch.distributor_code} (${batch.id}) — ${batch.reason}`);
  }
  if (deletable.length === 0) {
    throw new Error("Nothing is safely deletable: every matched batch is protected. Refusing to run.");
  }

  const batchIds = deletable.map((batch) => String(batch.id));
  const backupDir = optionText(options, "backup-dir", "outputs/sos-direct-cleanup-backup");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `source-of-sales-direct-imports-${timestamp}.json`);
  writeJson(backupPath, snapshot);

  // ── GUARD 2: prove the backup on DISK covers the cascade, before deleting ─────────────────────
  // "Backup written" was previously printed by a call that had captured neither the five cascaded
  // rollup tables nor the run steps. A written file is not a backup of the right thing, so this
  // reads the file back and checks it row-for-row against what the delete will remove. Production
  // has no PITR; this file is the only recovery path.
  const written = JSON.parse(readFileSync(backupPath, "utf8")) as { cascade?: Record<string, unknown> };
  assertBackupCoversCascade(written.cascade ?? {}, snapshot.cascadeRowCounts);
  console.log(`Backup written and verified against the cascade: ${backupPath}`);
  console.log(`Deleting ${deletable.length} retired batch(es); ${protectedLive.length} protected.`);

  if (snapshot.deletionMode === "delete_batches") {
    for (const batchId of batchIds) {
      const { error } = await supabase.from("source_of_sales_import_batches").delete().eq("id", batchId);
      if (error) throw new Error(`delete batch ${batchId}: ${error.message}`);
    }
  } else {
    // Only rows belonging to a batch that passed GUARD 1. `snapshot.rows` spans every matched
    // batch, so iterating it directly would delete the live vintage's rows one at a time while the
    // batch-level guard reported them protected — the guard has to reach both deletion modes.
    const deletableBatchIds = new Set(batchIds);
    const rowsToDelete = snapshot.rows.filter((row) => deletableBatchIds.has(String(row.batch_id)));
    console.log(`Row mode: ${rowsToDelete.length} of ${snapshot.rows.length} matched rows are in deletable batches.`);
    for (const row of rowsToDelete) {
      const { error } = await supabase.from("source_of_sales_import_rows").delete().eq("id", row.id);
      if (error) throw new Error(`delete direct row ${row.id}: ${error.message}`);
    }
  }

  const after = await buildSnapshot(supabase);
  const deletableBatchIds = new Set(batchIds);
  console.log(JSON.stringify({
    after: after.counts,
    backupPath,
    deletedBatchIds: snapshot.deletionMode === "delete_batches" ? batchIds : [],
    deletedRowCount: snapshot.deletionMode === "delete_direct_rows_only"
      ? snapshot.rows.filter((row) => deletableBatchIds.has(String(row.batch_id))).length
      : 0,
    protectedBatches: protectedLive.map((batch) => ({ id: batch.id, period: batch.period, reason: batch.reason })),
  }, null, 2));
}

async function main() {
  const { command, options } = parseArgs();
  if (command === "preview") return preview(options);
  if (command === "apply") return apply(options);
  usage();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
