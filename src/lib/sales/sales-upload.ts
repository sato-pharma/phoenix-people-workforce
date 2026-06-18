import { SalesWorkflowError } from "@/lib/sales/contracts";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { persistNormalizedBatch } from "@/lib/sales/normalizer/service";
import type { NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, recognizeDistributorWorkbook, summarizePreview, type NormalizePreview } from "@/lib/sales/recognize";
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

// Pure decision: which single month does this upload belong to? Never silently drops a month.
//  • a valid override → consolidate every row under it (date-less pivots + intentional consolidation)
//  • exactly one period in the sheet → use it
//  • no period at all → "missing" (caller asks for a period)
//  • multiple periods, no override → "multi" (caller refuses rather than dropping minority rows)
export type PeriodDecision =
  | { kind: "ok"; period: string; consolidate: boolean }
  | { kind: "missing" }
  | { kind: "multi"; periods: string[] };

export function resolveUploadPeriod(codedPeriods: (string | null | undefined)[], override: string): PeriodDecision {
  if (VALID_PERIOD.test(override)) return { kind: "ok", period: override, consolidate: true };
  const periods = [...new Set(codedPeriods.filter((p): p is string => Boolean(p)))].sort();
  if (periods.length === 1) return { kind: "ok", period: periods[0], consolidate: false };
  if (periods.length === 0) return { kind: "missing" };
  return { kind: "multi", periods };
}

export type AnalyzeResult =
  | { status: "ok"; preview: NormalizePreview; reconciliation: ReconciliationReceipt; period: string | null; needsPeriod: boolean; engineVersion: string }
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
  return { status: "ok", preview, reconciliation, period: rec.period, needsPeriod: !rec.period, engineVersion: RECOGNITION_ENGINE_VERSION };
}

export type CommitResult =
  | { status: "imported"; batchId: string; period: string | null; importedRows: number; reconciliation: ReconciliationReceipt; engineVersion: string }
  | { status: "blocked"; reconciliation: ReconciliationReceipt; preview: NormalizePreview };

// Delete PRIOR normalizer batches for the same (distributor, period) — EXCEPT the just-inserted one —
// so re-uploading a month replaces rather than double-counts. Runs AFTER the new batch is fully
// written: if the insert fails nothing is deleted (old data stays intact, no loss), and a rare
// post-insert delete failure self-heals on the next upload (never silent data loss). Scoped to
// template_key='normalizer' + a validated YYYY-MM period, so it can never touch unrelated data.
async function deleteOtherBatchesForPeriod(distributorCode: string, period: string, keepBatchId: string): Promise<void> {
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
  const ids = (existing.data ?? []).map((r) => String((r as { id: unknown }).id)).filter((id) => id !== keepBatchId);
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

  const decision = resolveUploadPeriod(result.coded.map((r) => r.invoiceDate), String(input.periodOverride ?? "").trim());
  if (decision.kind === "missing") {
    throw new SalesWorkflowError("missing_period", "This sheet has no date column — pick the period before importing.", 400);
  }
  if (decision.kind === "multi") {
    throw new SalesWorkflowError(
      "multi_period",
      `This sheet spans ${decision.periods.length} months (${decision.periods.join(", ")}). Pick a period above to import them all under one month, or upload one month per file.`,
      400,
    );
  }
  const period = decision.period;
  // Consolidate every row under the chosen month only when the user explicitly picked one.
  const coded = decision.consolidate ? result.coded.map((r) => ({ ...r, invoiceDate: period })) : result.coded;
  const stamped: NormalizeResult = { ...result, coded };

  // Insert the new batch FIRST (single source-of-truth period), THEN remove prior batches for the
  // same month — so a failed insert never leaves the period empty (atomic-safe ordering).
  const persisted = await persistNormalizedBatch({
    distributorCode: input.distributorCode,
    distributorName: rec.distributorName,
    fileName: input.file.name,
    result: stamped,
    uploadedBy: input.uploadedBy,
    period,
  });
  await deleteOtherBatchesForPeriod(input.distributorCode, period, persisted.batchId);
  return { status: "imported", reconciliation, engineVersion: RECOGNITION_ENGINE_VERSION, ...persisted };
}
