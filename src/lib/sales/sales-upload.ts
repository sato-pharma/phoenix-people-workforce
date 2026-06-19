import { SalesWorkflowError } from "@/lib/sales/contracts";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { persistNormalizedBatch } from "@/lib/sales/normalizer/service";
import type { NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, recognizeDistributorWorkbook, summarizePreview, type NormalizeFileResult, type NormalizePreview } from "@/lib/sales/recognize";
import { validateNormalizedUpload, type ValidationContext, type ValidationReport } from "@/lib/sales/upload-validation";
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

// Pure: builds the bucket-accounting receipt shown to the user. NOTE: the read == coded + ignored +
// blank + blocked assert here is a consistency check on summary.totalRows, which the engine DEFINES as
// exactly that sum — so it can never catch a "row scanned but never bucketed" bug. The real
// no-silent-loss guard is the independent physical counter (summary.scannedDataRows) checked in
// validateNormalizedUpload (rows_read_mismatch), which always runs before persist. Keep both.
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

// Pure: produce the exact result that will be PERSISTED for a decision. When the user consolidates a
// file under one chosen period, every row's invoiceDate is rewritten to that period — which can turn
// rows that had distinct source months into true duplicates. Validation MUST run on this consolidated
// result (not the raw one) so the duplicate/period checks see what actually gets imported.
export function applyPeriodConsolidation(result: NormalizeResult, decision: PeriodDecision): NormalizeResult {
  if (decision.kind !== "ok" || !decision.consolidate) return result;
  return { ...result, coded: result.coded.map((r) => ({ ...r, invoiceDate: decision.period })) };
}

export type AnalyzeResult =
  | { status: "ok"; preview: NormalizePreview; reconciliation: ReconciliationReceipt; period: string | null; needsPeriod: boolean; engineVersion: string; validation: ValidationReport }
  | { status: "header_error"; distributorName: string; missingGroups: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string } }
  | { status: "coded_sheet"; distributorName: string };

// Current calendar month as YYYY-MM (server clock). Used by the temporal validations. Date is safe
// here — this is server code (the validator itself stays pure; the month is part of its context).
function currentPeriodUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Periods already imported for this distributor (normalizer batches only — the set the replace logic
// in deleteOtherBatchesForPeriod actually operates on). Best-effort: a read failure returns [].
async function listExistingBatchPeriods(distributorCode: string): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const dist = normalizeCodeKey(distributorCode);
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("period")
      .eq("distributor_code", dist)
      .eq("template_key", "normalizer");
    if (error) return [];
    return [...new Set((data ?? []).map((r) => String((r as { period: unknown }).period ?? "")).filter((p) => VALID_PERIOD.test(p)))];
  } catch {
    return [];
  }
}

// Totals of the most recent EARLIER normalizer batch (period < the upload period) for this
// distributor — the baseline the period-over-period anomaly checks compare against. Best-effort.
async function getPriorPeriodTotals(distributorCode: string, resolvedPeriod: string | null): Promise<{ period: string; totalValue: number; totalQty: number } | null> {
  if (!resolvedPeriod || !VALID_PERIOD.test(resolvedPeriod)) return null;
  try {
    const supabase = getSupabaseAdmin();
    const dist = normalizeCodeKey(distributorCode);
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("period,total_value,total_qty")
      .eq("distributor_code", dist)
      .eq("template_key", "normalizer")
      .lt("period", resolvedPeriod)
      .order("period", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { period: string | null; total_value: number | null; total_qty: number | null };
    if (!row.period) return null;
    return { period: row.period, totalValue: Number(row.total_value ?? 0), totalQty: Number(row.total_qty ?? 0) };
  } catch {
    return null;
  }
}

// Assemble the (async) validation context, then run the pure strict validator over the result that
// WILL be persisted (already consolidated when the user picked a period). The SAME path runs at
// analyze and commit so the report can never differ between them.
async function runStrictValidation(distributorCode: string, rec: Extract<NormalizeFileResult, { status: "ok" }>, resultToValidate: NormalizeResult, resolvedPeriod: string | null): Promise<ValidationReport> {
  const [existingBatchPeriods, priorPeriodTotals] = await Promise.all([
    listExistingBatchPeriods(distributorCode),
    getPriorPeriodTotals(distributorCode, resolvedPeriod),
  ]);
  const ctx: ValidationContext = {
    valueSource: rec.valueSource,
    hasDateColumn: rec.hasDateColumn,
    regionOnly: rec.regionOnly,
    priceByProductCode: rec.priceByCode,
    currentPeriod: currentPeriodUtc(),
    resolvedPeriod,
    existingBatchPeriods,
    priorPeriodTotals,
  };
  return validateNormalizedUpload(resultToValidate, ctx);
}

// Dry-run: recognize + summarize + strictly validate, persist NOTHING. Backs the Sales Upload
// "Analyze" step and the Diagnostics Center. The optional period mirrors what the user will commit
// with, so the analyze report matches the commit gate exactly.
export async function analyzeMonthlyUpload(distributorCode: string, file: File, periodOverride = ""): Promise<AnalyzeResult> {
  const rec = await recognizeDistributorWorkbook(distributorCode, file);
  if (rec.status === "coded_sheet") return { status: "coded_sheet", distributorName: rec.distributorName };
  if (rec.status === "header_error") {
    return { status: "header_error", distributorName: rec.distributorName, missingGroups: rec.missingGroups, fingerprintWarning: rec.fingerprintWarning };
  }
  const preview = summarizePreview(distributorCode, rec.distributorName, rec.result, rec.products);
  const reconciliation = buildReconciliation(rec.result);
  const decision = resolveUploadPeriod(rec.result.coded.map((r) => r.invoiceDate), String(periodOverride ?? "").trim());
  const resolvedPeriod = decision.kind === "ok" ? decision.period : null;
  // Validate the rows AS THEY WILL BE PERSISTED (consolidated when a period was picked) so analyze
  // matches the commit gate exactly — including duplicates that only appear after consolidation.
  const validation = await runStrictValidation(distributorCode, rec, applyPeriodConsolidation(rec.result, decision), resolvedPeriod);
  return { status: "ok", preview, reconciliation, period: rec.period, needsPeriod: !rec.period, engineVersion: RECOGNITION_ENGINE_VERSION, validation };
}

export type CommitResult =
  | { status: "imported"; batchId: string; period: string | null; importedRows: number; reconciliation: ReconciliationReceipt; engineVersion: string; validation: ValidationReport }
  | { status: "blocked"; reconciliation: ReconciliationReceipt; preview: NormalizePreview }
  | { status: "blocked_validation"; reconciliation: ReconciliationReceipt; preview: NormalizePreview; validation: ValidationReport };

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

// Persist a raw upload. Blocks (persists nothing) if any row is unmapped, if strict validation finds
// an error, or if there are warnings the caller has not acknowledged — never a partial import.
export async function commitMonthlyUpload(input: {
  distributorCode: string;
  file: File;
  periodOverride?: string;
  uploadedBy: string;
  acknowledgeWarnings?: boolean;
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

  // Consolidate every row under the chosen month only when the user explicitly picked one. Build this
  // BEFORE validation so the strict checks run on exactly what gets persisted (consolidation can turn
  // distinct-month rows into true duplicates).
  const stamped: NormalizeResult = applyPeriodConsolidation(result, decision);

  // Strict server-side re-validation with the FINAL resolved period (never trust the client). Errors
  // always block; warnings block unless the caller explicitly acknowledged them (the strict gate).
  const validation = await runStrictValidation(input.distributorCode, rec, stamped, period);
  if (!validation.ok || (validation.warningCount > 0 && !input.acknowledgeWarnings)) {
    return { status: "blocked_validation", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, result, rec.products), validation };
  }

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
  return { status: "imported", reconciliation, engineVersion: RECOGNITION_ENGINE_VERSION, validation, ...persisted };
}
