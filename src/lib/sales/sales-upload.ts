import { SalesWorkflowError } from "@/lib/sales/contracts";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { persistNormalizedBatch } from "@/lib/sales/normalizer/service";
import type { NormalizeResult } from "@/lib/sales/normalizer/types";
import { dominantPeriod, recognizeDistributorWorkbook, summarizePreview, type NormalizePreview } from "@/lib/sales/recognize";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ── E3: the single raw-only upload pipeline ────────────────────────────────────────────────────
// Sales Upload's analyze (dry-run) and commit (persist) BOTH run through recognizeDistributorWorkbook
// — the same recognizer the Normalizer/Missing Data use — so what the analyzer recognizes the upload
// always accepts (the prime directive). No coded-template path, raw sheets only.

export type ReconciliationReceipt = {
  rowsRead: number;
  rowsCoded: number;
  rowsIgnored: number;
  rowsBlankCustomer: number;
  rowsBlocked: number; // exceptions — unmapped product/territory
  totalQty: number;
  totalValue: number;
};

// Pure: every input row is accounted for. Asserts read == coded + ignored + blank + blocked so a
// row can never silently vanish (a mismatch is a hard error, not a quiet pass).
export function buildReconciliation(result: NormalizeResult): ReconciliationReceipt {
  const s = result.summary;
  const rowsBlocked = result.exceptions.length;
  const rowsRead = s.totalRows;
  const accounted = s.fullyCoded + s.ignored + s.blankCustomerSkipped + rowsBlocked;
  if (accounted !== rowsRead) {
    throw new SalesWorkflowError(
      "reconciliation_mismatch",
      `Row reconciliation mismatch: read ${rowsRead} but accounted ${accounted}. Aborting to avoid silent data loss.`,
      500,
    );
  }
  const totalQty = result.coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const totalValue = result.coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
  return {
    rowsRead,
    rowsCoded: s.fullyCoded,
    rowsIgnored: s.ignored,
    rowsBlankCustomer: s.blankCustomerSkipped,
    rowsBlocked,
    totalQty: Number(totalQty.toFixed(6)),
    totalValue: Number(totalValue.toFixed(6)),
  };
}

const VALID_PERIOD = /^\d{4}-\d{2}$/;

export type AnalyzeResult =
  | { status: "ok"; preview: NormalizePreview; reconciliation: ReconciliationReceipt; period: string | null; needsPeriod: boolean }
  | { status: "header_error"; distributorName: string; missingGroups: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string } }
  | { status: "coded_sheet"; distributorName: string };

// Dry-run: recognize + summarize, persist NOTHING. Backs the Sales Upload "Analyze" step and the
// Diagnostics Center.
export async function analyzeMonthlyUpload(distributorCode: string, file: File): Promise<AnalyzeResult> {
  const rec = await recognizeDistributorWorkbook(distributorCode, file);
  if (rec.status === "coded_sheet") return { status: "coded_sheet", distributorName: rec.distributorName };
  if (rec.status === "header_error") {
    return { status: "header_error", distributorName: rec.distributorName, missingGroups: rec.missingGroups, fingerprintWarning: rec.fingerprintWarning };
  }
  const preview = summarizePreview(distributorCode, rec.distributorName, rec.result, rec.products);
  const reconciliation = buildReconciliation(rec.result);
  return { status: "ok", preview, reconciliation, period: rec.period, needsPeriod: !rec.period };
}

export type CommitResult =
  | { status: "imported"; batchId: string; period: string | null; importedRows: number; reconciliation: ReconciliationReceipt }
  | { status: "blocked"; reconciliation: ReconciliationReceipt; preview: NormalizePreview };

// Delete prior normalizer batches for the same (distributor, period) so re-uploading a month
// REPLACES rather than double-counts. Scoped to template_key='normalizer' (this pipeline's batches)
// and a validated YYYY-MM period, so it can never touch unrelated data.
async function replaceExistingPeriod(distributorCode: string, period: string): Promise<void> {
  if (!VALID_PERIOD.test(period)) return;
  const supabase = getSupabaseAdmin();
  const dist = normalizeCodeKey(distributorCode);
  const existing = await supabase
    .from("source_of_sales_import_batches")
    .select("id")
    .eq("distributor_code", dist)
    .eq("period", period)
    .eq("template_key", "normalizer");
  if (existing.error) throw existing.error;
  const ids = (existing.data ?? []).map((r) => String((r as { id: unknown }).id));
  if (ids.length === 0) return;
  const rowsDel = await supabase.from("source_of_sales_import_rows").delete().in("batch_id", ids);
  if (rowsDel.error) throw rowsDel.error;
  const batchDel = await supabase.from("source_of_sales_import_batches").delete().in("id", ids);
  if (batchDel.error) throw batchDel.error;
}

// Persist a raw upload. Blocks (persists nothing) if any row is unmapped — never a partial import.
export async function commitMonthlyUpload(input: {
  distributorCode: string;
  file: File;
  periodOverride?: string;
  uploadedBy: string;
}): Promise<CommitResult> {
  const rec = await recognizeDistributorWorkbook(input.distributorCode, input.file);
  if (rec.status === "coded_sheet") throw new SalesWorkflowError("coded_sheet", "This sheet is already coded — upload the raw distributor export instead.", 400);
  if (rec.status === "header_error") {
    throw new SalesWorkflowError("header_validation_error", `Sheet is missing required columns: ${rec.missingGroups.map((g) => g.label).join(", ")}.`, 422);
  }
  const result = rec.result;
  const reconciliation = buildReconciliation(result);

  if (result.exceptions.length > 0) {
    return { status: "blocked", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, result, rec.products) };
  }

  const override = String(input.periodOverride ?? "").trim();
  const period = VALID_PERIOD.test(override) ? override : dominantPeriod(result.coded);
  if (!period) {
    throw new SalesWorkflowError("missing_period", "This sheet has no date column — pick the period before importing.", 400);
  }
  // Stamp the chosen period onto rows that carry no date (e.g. CP pivot) so they persist under it.
  const stamped: NormalizeResult = { ...result, coded: result.coded.map((r) => (r.invoiceDate ? r : { ...r, invoiceDate: period })) };

  await replaceExistingPeriod(input.distributorCode, period);
  const persisted = await persistNormalizedBatch({
    distributorCode: input.distributorCode,
    distributorName: rec.distributorName,
    fileName: input.file.name,
    result: stamped,
    uploadedBy: input.uploadedBy,
  });
  return { status: "imported", reconciliation, ...persisted };
}
