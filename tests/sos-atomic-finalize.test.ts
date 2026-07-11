import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Guards the atomic SoS finalize fix: promoting a batch to validated, superseding any prior batch
// for the same distributor + period, and refreshing every rollup now happens in ONE transaction
// (phx_finalize_sos_batch) instead of 5+ separate round trips — so a failure partway through can
// never leave the old good batch deleted and the new one incomplete.
export function runSosAtomicFinalizeTests() {
  const migration = readSource("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260625180000_sos_atomic_finalize.sql");
  assert.match(migration, /create or replace function public\.phx_finalize_sos_batch/,
    "atomic finalize function is defined");
  assert.match(migration, /pg_try_advisory_xact_lock\(hashtextextended\(p_distributor_code \|\| ':' \|\| p_period, 0\)\)/,
    "finalize takes a per-distributor+period advisory lock so concurrent uploads of the same key can't race");
  assert.match(migration, /check \(status in \('pending', 'blocked', 'validated'\)\)/,
    "status check constraint is widened to include the transient 'pending' holding status");
  assert.match(migration, /v_raw_count <> v_rollup_count/,
    "finalize self-checks that raw row count and rolled-up row count reconcile before returning success");
  assert.match(migration, /create or replace function public\.phx_cleanup_stale_pending_sos_batches/,
    "stale-pending cleanup sweep is defined for batches that died mid-pipeline");

  const helper = readSource("../src/lib/sales/source-of-sales-batch-supersede.ts");
  assert.match(helper, /export async function finalizeSosBatchAndAuditSupersede/,
    "shared finalize-and-audit-log wrapper is exported");
  assert.match(helper, /phx_finalize_sos_batch/,
    "wrapper calls the atomic finalize RPC");
  assert.match(helper, /export async function cleanupStalePendingSosBatches/,
    "stale-pending cleanup wrapper is exported for the daily cron");
  assert.doesNotMatch(helper, /export async function supersedeExistingSalesBatches/,
    "the old non-atomic supersede helper is gone — superseded by phx_finalize_sos_batch");

  const importer = readSource("../src/lib/sales/monthly-distributor-import.ts");
  assert.match(importer, /finalizeSosBatchAndAuditSupersede/,
    "persistDistributorSalesUpload calls the atomic finalize wrapper");
  assert.match(importer, /status: result\.status === "validated" \? "pending" : result\.status/,
    "a batch that will become validated is inserted as 'pending' first, not 'validated' directly");
  assert.doesNotMatch(importer, /duplicate_sales_batch/,
    "the old throw-and-block duplicate guard stays removed");

  const normalizerService = readSource("../src/lib/sales/normalizer/service.ts");
  assert.match(normalizerService, /finalizeSosBatchAndAuditSupersede/,
    "persistNormalizedBatch calls the atomic finalize wrapper");
  assert.match(normalizerService, /status: "pending"/,
    "persistNormalizedBatch's initial insert uses the 'pending' holding status, not 'blocked'");

  const salesUpload = readSource("../src/lib/sales/sales-upload.ts");
  assert.doesNotMatch(salesUpload, /deleteOtherBatchesForPeriod/,
    "the pre-emptive delete-before-persist function is removed — it deleted the old good batch " +
    "before the new one was even validated, which was a wider risk window than the atomic finalize it replaces");

  const scheduledProcessing = readSource("../src/lib/notifications/scheduled-processing.ts");
  assert.match(scheduledProcessing, /cleanupStalePendingSosBatches/,
    "stale-pending SoS batch cleanup is wired into the existing daily cron, not a new one");
}
