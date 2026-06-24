import { writeAuditLog } from "@/lib/admin/audit";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Supersede-on-upload: a new upload for (distributorCode, period) is about to become the single
// source of truth for that month. Delete any OTHER existing batch row(s) for the same
// distributor_code + period (regardless of status — validated or blocked) so the new batch is the
// only one left standing. Cascading FKs (source_of_sales_import_rows, source_of_sales_fact_rollup,
// source_of_sales_customer_directory_rollup / presence rollup — all `on delete cascade`) clean up
// every dependent row automatically; nothing else needs to be deleted by hand.
//
// Call this AFTER the new upload's own validity is already known (validated, or about to be marked
// validated) and BEFORE the row that makes it official is written — never before, so an upload that
// itself turns out blocked/invalid can never destroy a good existing batch.
export async function supersedeExistingSalesBatches(input: {
  distributorCode: string;
  period: string;
  excludeBatchId?: string;
  actorLoginId: string;
}): Promise<{ deletedCount: number }> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("source_of_sales_import_batches")
    .select("id,file_name,distributor_code,period,status")
    .eq("distributor_code", input.distributorCode)
    .eq("period", input.period);
  if (input.excludeBatchId) {
    query = query.neq("id", input.excludeBatchId);
  }
  const existing = await query;
  if (existing.error) throw existing.error;

  const rows = (existing.data ?? []) as {
    id: unknown;
    file_name: unknown;
    distributor_code: unknown;
    period: unknown;
    status: unknown;
  }[];
  if (rows.length === 0) return { deletedCount: 0 };

  const ids = rows.map((row) => String(row.id));
  const { error } = await supabase.from("source_of_sales_import_batches").delete().in("id", ids);
  if (error) throw error;

  for (const row of rows) {
    await writeAuditLog({
      actorLoginId: input.actorLoginId,
      entityId: String(row.id),
      entityType: "sales_import_batch",
      oldValues: {
        distributorCode: row.distributor_code,
        fileName: row.file_name,
        period: row.period,
        source: "source_of_sales",
        status: row.status,
      },
      summary: "Source of Sales uploaded sheet superseded by a new upload for the same period.",
    });
  }

  return { deletedCount: ids.length };
}
