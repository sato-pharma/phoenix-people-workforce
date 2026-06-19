// Sales Operations Module — persistence.
//
// Writes a coded batch into the new sales_ops_* fact tables, then calls sales_ops_commit_batch to
// SUPERSEDE any prior batch for the same (distributor, period) and RECOMPUTE that period's rollups +
// snapshot in one transaction (replace-not-merge; the DB function asserts Σ rollup == Σ fact).
//
// Ordering is deliberate: the batch is staged is_current=false / status='blocked', the fact rows are
// inserted, THEN commit_batch flips it current+validated — so the partial unique index can never
// conflict with the existing current batch, and a failed insert never leaves a half-written month.

import { SalesWorkflowError } from "@/lib/sales/contracts";
import type { NormalizeResult } from "@/lib/sales-operations/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const CHUNK = 500;

function round6(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 1_000_000) / 1_000_000;
}

export type PersistSalesOpsInput = {
  distributorCode: string;
  distributorName: string;
  fileName: string;
  sheetName?: string;
  result: NormalizeResult; // already consolidated to `period`
  period: string;
  uploadedBy: string;
  engineVersion: string;
  isOffice: boolean;
};

export type PersistSalesOpsResult = { batchId: string; period: string; importedRows: number };

// Pure no-silent-loss reconcile. Row strategies must balance scanned == coded+excluded+blank+blocked.
// Office maps one pivot row → many slices (unit reconciliation is done by the DB Σ check instead), so
// it is exempt from the row-count identity.
export function assertReconciles(result: NormalizeResult, isOffice: boolean): void {
  if (isOffice) return;
  const s = result.summary;
  const accounted = s.fullyCoded + s.excludedBonus + s.blankKeySkipped + result.exceptions.length;
  if (s.scannedDataRows !== accounted) {
    throw new SalesWorkflowError(
      "reconciliation_mismatch",
      `Row reconciliation mismatch: scanned ${s.scannedDataRows} but accounted ${accounted}. Aborting to avoid silent data loss.`,
      500,
    );
  }
}

export async function persistSalesOpsBatch(input: PersistSalesOpsInput): Promise<PersistSalesOpsResult> {
  const { result, period } = input;
  assertReconciles(result, input.isOffice);

  const coded = result.coded;
  const totalQty = round6(coded.reduce((a, r) => a + (Number.isFinite(r.qty) ? r.qty : 0), 0));
  const totalValue = round6(coded.reduce((a, r) => a + (Number.isFinite(r.value) ? r.value : 0), 0));

  const supabase = getSupabaseAdmin();

  // 1) Stage the batch (is_current=false, status='blocked') so the partial unique index never
  //    conflicts with the existing current batch; commit_batch flips it to current+validated.
  const batchInsert = await supabase
    .from("sales_ops_import_batches")
    .insert({
      distributor_code: input.distributorCode,
      distributor_name: input.distributorName,
      period,
      template_key: "sales_ops",
      file_name: input.fileName,
      sheet_name: input.sheetName ?? "",
      status: "blocked",
      is_current: false,
      scanned_data_rows: result.summary.scannedDataRows,
      fully_coded_rows: result.summary.fullyCoded,
      exception_rows: result.exceptions.length,
      excluded_bonus_rows: result.summary.excludedBonus,
      blank_key_rows: result.summary.blankKeySkipped,
      inserted_fact_rows: coded.length,
      total_qty: totalQty,
      total_value: totalValue,
      recognition_engine_version: input.engineVersion,
      uploaded_by: input.uploadedBy,
    })
    .select("id")
    .single();
  if (batchInsert.error) throw batchInsert.error;
  const batchId = String((batchInsert.data as { id: unknown }).id);

  // 2) Insert fact rows in chunks. Office shares one pivot rawRowNumber across slices, so assign a
  //    monotonic per-batch number to satisfy unique(batch_id, raw_row_number).
  const factRows = coded.map((r, i) => ({
    batch_id: batchId,
    raw_row_number: input.isOffice ? i + 1 : r.rawRowNumber,
    distributor_code: r.distributorCode,
    period,
    official_line: r.officialLine,
    region_code: r.regionCode,
    region_name: r.regionName,
    area_code: r.areaCode || null,
    area_name: r.areaName || null,
    brick_id: r.brickId || null,
    brick_name: r.brickName || null,
    product_code: r.productCode,
    product_name: r.productName,
    family: r.family,
    client_code: r.clientCode,
    client_name: r.clientName,
    client_address: r.clientAddress,
    qty: r.qty,
    value: r.value,
  }));
  for (let i = 0; i < factRows.length; i += CHUNK) {
    const ins = await supabase.from("sales_ops_fact_rows").insert(factRows.slice(i, i + CHUNK));
    if (ins.error) {
      await supabase.from("sales_ops_import_batches").delete().eq("id", batchId); // remove the orphan stage
      throw ins.error;
    }
  }

  // 3) Commit: supersede prior + recompute this period's rollups/snapshot (atomic, asserts Σ).
  const commit = await supabase.rpc("sales_ops_commit_batch", { p_batch_id: batchId });
  if (commit.error) {
    await supabase.from("sales_ops_import_batches").delete().eq("id", batchId);
    throw commit.error;
  }

  return { batchId, period, importedRows: coded.length };
}
