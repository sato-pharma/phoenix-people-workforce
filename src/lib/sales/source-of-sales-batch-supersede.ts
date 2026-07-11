import { writeAuditLog } from "@/lib/admin/audit";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupersededBatch = {
  id: unknown;
  fileName: unknown;
  distributorCode: unknown;
  period: unknown;
  status: unknown;
};

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
  const supabase = getSupabaseAdmin();

  const finalize = await supabase.rpc("phx_finalize_sos_batch", {
    p_batch_id: input.batchId,
    p_distributor_code: input.distributorCode,
    p_period: input.period,
  });
  if (finalize.error) throw finalize.error;

  const data = (finalize.data ?? {}) as { supersededBatches?: SupersededBatch[]; rowCount?: number };
  const superseded = data.supersededBatches ?? [];

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
    console.error(JSON.stringify({ event: "sos_stale_pending_cleanup_failed", error: error instanceof Error ? error.message : String(error) }));
    return 0;
  }
}
