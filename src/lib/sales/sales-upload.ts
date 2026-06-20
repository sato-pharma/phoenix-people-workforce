import { isPostgresUniqueViolation, SalesWorkflowError } from "@/lib/sales/contracts";
import { detectDistributorFromBuffer } from "@/lib/sales/distributor-detection";
import { explainHeaderMismatch, type HeaderMismatchExplanation } from "@/lib/sales/normalizer/ai-explain";
import { buildPreviewBreakdowns, type PreviewBreakdowns } from "@/lib/sales/normalizer/breakdowns";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { persistNormalizedBatch } from "@/lib/sales/normalizer/service";
import type { NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, recognizeDistributorWorkbook, summarizePreview, type NormalizeFileResult, type NormalizePreview } from "@/lib/sales/recognize";
import { unacknowledgedWarningCodes, validateNormalizedUpload, type DistributorCrossCheck, type ValidationContext, type ValidationReport } from "@/lib/sales/upload-validation";
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
  | { status: "ok"; preview: NormalizePreview; reconciliation: ReconciliationReceipt; breakdowns: PreviewBreakdowns; period: string | null; needsPeriod: boolean; engineVersion: string; validation: ValidationReport }
  | { status: "header_error"; distributorName: string; missingGroups: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string }; aiExplanation?: HeaderMismatchExplanation }
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
async function runStrictValidation(distributorCode: string, rec: Extract<NormalizeFileResult, { status: "ok" }>, resultToValidate: NormalizeResult, resolvedPeriod: string | null, crossCheck: DistributorCrossCheck | null = null): Promise<ValidationReport> {
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
    detectorCrossCheck: crossCheck,
  };
  return validateNormalizedUpload(resultToValidate, ctx);
}

// Run the auto-detector against the uploaded file and compare its top match to the PICKED distributor,
// for the verify-against-pick cross-check warning. Best-effort: a detector failure NEVER blocks the
// upload — it just means no cross-check warning (the strict header gate already validated the pick).
async function buildDistributorCrossCheck(distributorCode: string, distributorName: string, file: File): Promise<DistributorCrossCheck | null> {
  try {
    const detection = await detectDistributorFromBuffer(await file.arrayBuffer());
    return {
      pickedCode: distributorCode,
      pickedName: distributorName,
      bestCode: detection.best?.distributorCode ?? null,
      bestName: detection.best?.distributorName ?? null,
      confidence: detection.confidence,
      ambiguous: detection.ambiguous,
    };
  } catch {
    return null;
  }
}

// Build a precise "no deviation" rejection message naming the exact expected header per failing field.
export function headerErrorMessage(distributorName: string, missingGroups: { label: string; expected: string[] }[]): string {
  const parts = missingGroups.map((g) => `${g.label} (expected "${g.expected.join('" / "')}")`);
  return `This ${distributorName} sheet doesn't match the required template. Missing or renamed required column(s): ${parts.join("; ")}. Do not rename or remove the template's required columns.`;
}

// Dry-run: recognize + summarize + strictly validate, persist NOTHING. Backs the Sales Upload
// "Analyze" step and the Diagnostics Center. The optional period mirrors what the user will commit
// with, so the analyze report matches the commit gate exactly.
export async function analyzeMonthlyUpload(distributorCode: string, file: File, periodOverride = "", excludeProductCodes: readonly string[] = []): Promise<AnalyzeResult> {
  const rec = await recognizeDistributorWorkbook(distributorCode, file);
  if (rec.status === "coded_sheet") return { status: "coded_sheet", distributorName: rec.distributorName };
  if (rec.status === "header_error") {
    // AI helper, ONLY when stuck: explain the mismatch + suggest a column mapping. No-op without an AI
    // key, and never throws — the deterministic header_error is returned regardless.
    const aiExplanation = await explainHeaderMismatch({ distributorName: rec.distributorName, observedHeaders: rec.observedHeaders, missingGroups: rec.missingGroups });
    return { status: "header_error", distributorName: rec.distributorName, missingGroups: rec.missingGroups, fingerprintWarning: rec.fingerprintWarning, aiExplanation };
  }
  const preview = summarizePreview(distributorCode, rec.distributorName, rec.result, rec.products);
  const reconciliation = buildReconciliation(rec.result);
  // Per-product/region/brick/line breakdown for the Validate step. Confidential products are
  // excluded for non-CEO/Super-Admin viewers (excludeProductCodes) so the tables never leak them.
  const breakdowns = buildPreviewBreakdowns(rec.result.coded, excludeProductCodes);
  const decision = resolveUploadPeriod(rec.result.coded.map((r) => r.invoiceDate), String(periodOverride ?? "").trim());
  const resolvedPeriod = decision.kind === "ok" ? decision.period : null;
  // Validate the rows AS THEY WILL BE PERSISTED (consolidated when a period was picked) so analyze
  // matches the commit gate exactly — including duplicates that only appear after consolidation.
  const crossCheck = await buildDistributorCrossCheck(distributorCode, rec.distributorName, file);
  const validation = await runStrictValidation(distributorCode, rec, applyPeriodConsolidation(rec.result, decision), resolvedPeriod, crossCheck);
  return { status: "ok", preview, reconciliation, breakdowns, period: rec.period, needsPeriod: !rec.period, engineVersion: RECOGNITION_ENGINE_VERSION, validation };
}

export type CommitResult =
  | { status: "imported"; batchId: string; period: string | null; importedRows: number; reconciliation: ReconciliationReceipt; engineVersion: string; validation: ValidationReport }
  | { status: "blocked"; reconciliation: ReconciliationReceipt; preview: NormalizePreview }
  | { status: "blocked_validation"; reconciliation: ReconciliationReceipt; preview: NormalizePreview; validation: ValidationReport };

// Delete PRIOR normalizer batches for the same (distributor, period) so re-uploading a month replaces
// rather than double-counts. Called BEFORE inserting the replacement (delete-then-insert) so two
// validated batches for one month never coexist — the DB partial unique index
// (source_of_sales_one_validated_batch_per_period) is the hard backstop if anything still races past
// this. Pass keepBatchId to spare a specific batch; omit it to clear all prior batches for the month.
// Scoped to template_key='normalizer' + a validated YYYY-MM period, so it can never touch unrelated data.
async function deleteOtherBatchesForPeriod(distributorCode: string, period: string, keepBatchId?: string): Promise<void> {
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
  // PER-FINDING acknowledgement: the warning codes the operator explicitly ticked. Commit blocks
  // unless EVERY emitted warning code is in this list (errors always block). Replaces the old
  // single-boolean "acknowledge all".
  acknowledgedWarningCodes?: readonly string[];
}): Promise<CommitResult> {
  const rec = await recognizeDistributorWorkbook(input.distributorCode, input.file);
  if (rec.status === "coded_sheet") throw new SalesWorkflowError("coded_sheet", "This sheet is already coded — upload the raw distributor export instead.", 400);
  if (rec.status === "header_error") {
    throw new SalesWorkflowError("header_validation_error", headerErrorMessage(rec.distributorName, rec.missingGroups), 422);
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
  const crossCheck = await buildDistributorCrossCheck(input.distributorCode, rec.distributorName, input.file);
  const validation = await runStrictValidation(input.distributorCode, rec, stamped, period, crossCheck);
  // Errors always block; each warning blocks until its own code is acknowledged (no blanket override).
  const unacknowledged = unacknowledgedWarningCodes(validation, input.acknowledgedWarningCodes ?? []);
  if (!validation.ok || unacknowledged.length > 0) {
    return { status: "blocked_validation", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, result, rec.products), validation };
  }

  // Replace-not-double-count: remove any prior validated batch for this (distributor, month) BEFORE
  // inserting the replacement. This keeps two validated batches for one month from ever coexisting
  // (the old insert-then-delete ordering could leave both during a race → ROI/dashboard double-count).
  // The DB partial unique index (source_of_sales_one_validated_batch_per_period) is the hard backstop:
  // if a duplicate still races past this delete (or a same-month batch from another template exists),
  // the insert fails fast with 23505, which we surface as a clear "already imported" 409 rather than
  // silently double-counting. The upload already passed strict validation above, so an insert failure
  // here is a rare DB error; the month self-heals on the next re-upload.
  await deleteOtherBatchesForPeriod(input.distributorCode, period);
  let persisted: Awaited<ReturnType<typeof persistNormalizedBatch>>;
  try {
    persisted = await persistNormalizedBatch({
      distributorCode: input.distributorCode,
      distributorName: rec.distributorName,
      fileName: input.file.name,
      result: stamped,
      uploadedBy: input.uploadedBy,
      period,
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new SalesWorkflowError(
        "duplicate_sales_batch",
        `A validated ${rec.distributorName} sheet for ${period} is already imported. Delete it first, then re-upload — this keeps the month from being double-counted.`,
        409,
      );
    }
    throw error;
  }
  return { status: "imported", reconciliation, engineVersion: RECOGNITION_ENGINE_VERSION, validation, ...persisted };
}
