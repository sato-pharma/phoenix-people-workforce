import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupersededBatch = {
  id: unknown;
  fileName: unknown;
  distributorCode: unknown;
  period: unknown;
  status: unknown;
};

/**
 * How long the finalize call may wait. `phx_finalize_sos_batch` runs with a 120-second statement
 * timeout, so the client waits a little longer than the database can: the default 15-second abort
 * used to give up on a finalize that then COMMITTED on its own, which skipped the split-net and
 * attribution tail and reported a failure for an upload that had in fact landed (audit P4-03).
 */
export const FINALIZE_REQUEST_TIMEOUT_MS = 130_000;

type FinalizeClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => unknown;
};

type BatchStatusReader = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => PromiseLike<{ data: { status?: unknown } | null; error: unknown }>;
    };
  };
};

/**
 * Run the finalize and, when the call itself fails, ask the database what actually happened. A
 * finalize that committed after the call gave up (a dropped connection, a proxy timeout) leaves the
 * batch `validated`; that is a landed upload, so it is returned as one — `recovered: true` — and the
 * caller runs the rest of its tail exactly as for a clean finalize. Anything else is the original
 * failure, thrown unchanged. Pure apart from the client handed in, so it is testable with a fake.
 */
export async function runFinalizeWithRecovery(
  client: FinalizeClient,
  input: { batchId: string; distributorCode: string; period: string },
): Promise<{ data: unknown; recovered: boolean }> {
  let finalize: { data: unknown; error: unknown };
  try {
    finalize = await client.rpc("phx_finalize_sos_batch", {
      p_batch_id: input.batchId,
      p_distributor_code: input.distributorCode,
      p_period: input.period,
    });
  } catch (error) {
    finalize = { data: null, error };
  }
  if (!finalize.error) return { data: finalize.data, recovered: false };

  let status: string | null = null;
  try {
    const table = client.from("source_of_sales_import_batches") as BatchStatusReader;
    const read = await table.select("status").eq("id", input.batchId).maybeSingle();
    if (!read.error && read.data) status = String(read.data.status ?? "");
  } catch {
    status = null;
  }
  if (status !== "validated") throw finalize.error;
  logWarning("A sales import's finalize reported a failure but had committed; the upload is treated as landed.", {
    context: { batchId: input.batchId, distributorCode: input.distributorCode, period: input.period },
    error: finalize.error,
    labels: { event: "sos_finalize_committed_after_error" },
  });
  return { data: null, recovered: true };
}

// Calls phx_finalize_sos_batch (supabase/_migrations_archive/pre-baseline-2026-07-11/20260625180000_sos_atomic_finalize.sql), the
// single atomic transaction that supersedes any other batch for this distributor + period,
// promotes this batch to validated, and refreshes every dependent rollup — then audit-logs
// whatever the RPC superseded. The RPC itself, not this function, is what makes the supersede +
// promote + refresh sequence all-or-nothing; this is just the thin caller + audit-log step.
export async function finalizeSosBatchAndAuditSupersede(input: {
  batchId: string;
  distributorCode: string;
  period: string;
  actorLoginId: string;
}): Promise<{ supersededCount: number; rowCount: number }> {
  const supabase = getSupabaseAdmin({ requestTimeoutMs: FINALIZE_REQUEST_TIMEOUT_MS });

  const finalize = await runFinalizeWithRecovery(supabase as unknown as FinalizeClient, input);

  const data = (finalize.data ?? {}) as { supersededBatches?: SupersededBatch[]; rowCount?: number };
  const superseded = data.supersededBatches ?? [];

  if (finalize.recovered) {
    // The finalize committed but its answer was lost, so which earlier file it replaced is unknown
    // here. The trail still records that this upload landed through the recovery.
    await writeAuditLog({
      actorLoginId: input.actorLoginId,
      entityId: input.batchId,
      entityType: "sales_import_batch",
      newValues: { distributorCode: input.distributorCode, period: input.period, recoveredAfterFinalizeError: true, source: "source_of_sales" },
      summary: "Source of Sales upload finalized; the finalize answer was lost, so any file it replaced is not listed here.",
    });
  }

  for (const row of superseded) {
    await writeAuditLog({
      actorLoginId: input.actorLoginId,
      entityId: String(row.id),
      entityType: "sales_import_batch",
      oldValues: {
        distributorCode: row.distributorCode,
        fileName: row.fileName,
        period: row.period,
        source: "source_of_sales",
        status: row.status,
      },
      summary: "Source of Sales uploaded sheet superseded by a new upload for the same period.",
    });
  }

  // The finalize RPC just refreshed every SoS + marketing rollup for this distributor + period;
  // bust the cached dashboards so the new numbers show immediately (not after the 300s TTL).
  invalidateSalesDashboardCache("source of sales batch finalized");

  return { supersededCount: superseded.length, rowCount: Number(data.rowCount ?? 0) };
}

// Maintenance sweep for batches that died mid-pipeline (the request crashed between the row insert
// and the finalize call, so they never reached 'validated'). Wired into the existing daily
// notifications cron — never throws, so one bad run never breaks the rest of that cron's work.
export async function cleanupStalePendingSosBatches(): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.rpc("phx_cleanup_stale_pending_sos_batches");
    if (error) throw error;
    return Number(data ?? 0);
  } catch (error) {
    logError("Stale pending SoS batch cleanup failed", {
      labels: { event: "sos_stale_pending_cleanup_failed" },
      error,
    });
    return 0;
  }
}
