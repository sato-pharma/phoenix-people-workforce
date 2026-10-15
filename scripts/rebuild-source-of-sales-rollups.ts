/**
 * Rebuild every Source of Sales rollup from the import rows, one validated batch at a time.
 *
 * scripts/restore-source-of-sales.mjs runs this after it writes the rows back, because a restore
 * inserts rows and nothing derived from them (SoS re-measure 2026-09-18, #23). It runs the same
 * refresh chain an import runs (src/lib/sales/source-of-sales-rollup-rebuild.ts), for every
 * validated batch, since only a validated batch has rollups.
 *
 * Safe to run again from the start: every step replaces what it wrote for the batch.
 *
 * A LOCKED CLOSING REFUSES IT. The lock trigger rejects any change to a locked month's rollups, so
 * a batch in a locked month would stop the run partway. It checks first and names the locked
 * closings instead. Unlocking a month is the owner's decision.
 *
 * Usage (from the repo root; it reads and writes the database .env.local points at, which is
 * PRODUCTION):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/rebuild-source-of-sales-rollups.ts [--apply] [batch id ...]
 *
 * Without --apply it lists the batches it would rebuild and writes NOTHING. With batch ids it
 * rebuilds only those.
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { rebuildSourceOfSalesRollupsForBatch } from "@/lib/sales/source-of-sales-rollup-rebuild";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "rebuild-source-of-sales-rollups",
  entry: import.meta.url,
  known: ["--apply"],
});

type BatchRow = { id: string; period: string | null; distributor_code: string | null };
type LockRow = { line: string | null; period: string | null };

const apply = process.argv.includes("--apply");
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const supabase = getSupabaseAdmin();

async function validatedBatches(): Promise<BatchRow[]> {
  const rows: BatchRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("id, period, distributor_code")
      .eq("status", "validated")
      .order("period", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`reading the batches: ${error.message}`);
    rows.push(...((data ?? []) as BatchRow[]));
    if (!data || data.length < pageSize) break;
  }
  if (requested.length === 0) return rows;
  const known = new Set(rows.map((row) => row.id));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Not a validated batch: ${unknown.join(", ")}`);
  return rows.filter((row) => requested.includes(row.id));
}

async function openLocks(): Promise<LockRow[]> {
  const { data, error } = await supabase
    .from("monthly_closing_locks")
    .select("line, period")
    .is("unlocked_at", null);
  if (error) throw new Error(`reading the closing locks: ${error.message}`);
  return (data ?? []) as LockRow[];
}

async function main(): Promise<void> {
  const batches = await validatedBatches();
  const locks = await openLocks();
  const lockedPeriods = new Set(locks.map((lock) => String(lock.period ?? "")));
  const blocked = batches.filter((batch) => lockedPeriods.has(String(batch.period ?? "")));

  console.log(`${apply ? "REBUILDING" : "DRY RUN, nothing will be written"}: ${batches.length} validated batch(es)`);
  if (blocked.length > 0) {
    const names = locks
      .filter((lock) => blocked.some((batch) => batch.period === lock.period))
      .map((lock) => `${lock.line} ${lock.period}`)
      .sort();
    console.error(`\n${blocked.length} batch(es) fall in a locked closing: ${names.join(", ")}.`);
    console.error("A locked closing refuses any change to its rollups, so the rebuild would stop partway.");
    console.error("Unlocking a month is the owner's decision. Nothing was written.");
    process.exit(1);
  }
  if (!apply) {
    for (const batch of batches) console.log(`  ${batch.period ?? "(no period)"}  ${batch.distributor_code ?? "?"}  ${batch.id}`);
    console.log("\nRe-run with --apply to rebuild.");
    return;
  }

  for (const [index, batch] of batches.entries()) {
    const startedAt = Date.now();
    await rebuildSourceOfSalesRollupsForBatch(supabase, batch.id);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[${index + 1}/${batches.length}] ${batch.period ?? "(no period)"}  ${batch.distributor_code ?? "?"}  ${batch.id}  ${seconds}s`);
  }
  console.log(`\nREBUILT the rollups of ${batches.length} batch(es).`);
}

main().catch((error: unknown) => {
  console.error(`\nREBUILD FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error("It is safe to run again from the start: every step replaces what it wrote.");
  process.exit(1);
});
