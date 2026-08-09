import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
  - preview is read-only.
  - apply refuses to run without both --apply and --confirm-production-delete.
  - apply backs up affected batches, rows, summaries, and linked monthly runs before deletion.
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

async function maybeFetchByBatchIds<T>(supabase: SupabaseClient, table: string, batchIds: string[]): Promise<T[]> {
  if (batchIds.length === 0) return [];
  try {
    return await fetchAll<T>(supabase, table, "*", (query) => query.in("batch_id", batchIds));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not exist") || message.includes("Could not find the table")) return [];
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
  const [affectedBatchRows, summaries, monthlyRuns, directBatchCount, directRowCount, isDirectRowCount, directAreaRowCount, nationalRowCount] = await Promise.all([
    maybeFetchByBatchIds<Record<string, unknown>>(supabase, "source_of_sales_import_rows", directBatchIds),
    maybeFetchByBatchIds<Record<string, unknown>>(supabase, "source_of_sales_import_summaries", directBatchIds),
    maybeFetchByBatchIds<Record<string, unknown>>(supabase, "monthly_sales_runs", directBatchIds),
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
  const batchIds = snapshot.directBatches.map((batch) => String(batch.id));
  const backupDir = optionText(options, "backup-dir", "outputs/sos-direct-cleanup-backup");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `source-of-sales-direct-imports-${timestamp}.json`);
  writeJson(backupPath, snapshot);
  console.log(`Backup written: ${backupPath}`);

  if (snapshot.deletionMode === "delete_batches") {
    for (const batchId of batchIds) {
      const { error } = await supabase.from("source_of_sales_import_batches").delete().eq("id", batchId);
      if (error) throw new Error(`delete batch ${batchId}: ${error.message}`);
    }
  } else {
    for (const row of snapshot.rows) {
      const { error } = await supabase.from("source_of_sales_import_rows").delete().eq("id", row.id);
      if (error) throw new Error(`delete direct row ${row.id}: ${error.message}`);
    }
  }

  const after = await buildSnapshot(supabase);
  console.log(JSON.stringify({ after: after.counts, deletedBatchIds: snapshot.deletionMode === "delete_batches" ? batchIds : [], deletedRowCount: snapshot.deletionMode === "delete_direct_rows_only" ? snapshot.rows.length : 0 }, null, 2));
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
