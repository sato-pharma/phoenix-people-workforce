import { isPostgresUniqueViolation, SalesWorkflowError } from "@/lib/sales/contracts";
import { detectDistributorFromBuffer } from "@/lib/sales/distributor-detection";
import {
  createSourceOfSalesUploadFromBuffer,
  isCodedSystemChannel,
  type DistributorSalesValidationResult,
  type ParsedDistributorRow,
} from "@/lib/sales/monthly-distributor-import";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { explainHeaderMismatch, type HeaderMismatchExplanation } from "@/lib/sales/normalizer/ai-explain";
import { OFFICE_DISTRIBUTOR_CODE } from "@/lib/sales/office-allocation";
import { commitOfficeAllocation, previewOfficeAllocation } from "@/lib/sales/office-upload";
import { buildPreviewBreakdowns, type PreviewBreakdowns } from "@/lib/sales/normalizer/breakdowns";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { persistNormalizedBatch } from "@/lib/sales/normalizer/service";
import type { CodedRow, NormalizeResult } from "@/lib/sales/normalizer/types";
import { RECOGNITION_ENGINE_VERSION, recognizeDistributorWorkbook, summarizePreview, type NormalizeFileResult, type NormalizePreview } from "@/lib/sales/recognize";
import { validateNormalizedUpload, type DistributorCrossCheck, type ValidationContext, type ValidationFinding, type ValidationReport, type ValidationSeverity } from "@/lib/sales/upload-validation";
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
  | { status: "ok"; preview: NormalizePreview; reconciliation: ReconciliationReceipt; breakdowns: PreviewBreakdowns; period: string | null; needsPeriod: boolean; engineVersion: string; validation: ValidationReport; isRegionOnly?: boolean }
  | { status: "header_error"; distributorName: string; missingGroups: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string }; aiExplanation?: HeaderMismatchExplanation }
  | { status: "coded_sheet"; distributorName: string };

// Current calendar month as YYYY-MM (Africa/Cairo business time — see currentCairoDateParts).
// Used by the temporal validations. A server running in UTC and a Cairo browser can otherwise
// disagree on the month near midnight Cairo time.
function currentPeriodUtc(): string {
  const { year, month } = currentCairoDateParts();
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Validated periods already imported for this distributor. Incomplete/blocked batches are ignored so
// a timed-out upload can be retried and replaced.
async function listExistingBatchPeriods(distributorCode: string): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const dist = normalizeCodeKey(distributorCode);
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("period")
      .eq("distributor_code", dist)
      .eq("template_key", "normalizer")
      .eq("status", "validated");
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
      .eq("status", "validated")
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
  // Office channel: pivot format (product name + total units, no geography). Requires a period upfront
  // for the two-step brick allocation. Route through the Office-specific path (see end of file).
  if (normalizeCodeKey(distributorCode) === normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE)) {
    return analyzeOfficeChannel(distributorCode, file, String(periodOverride ?? "").trim(), excludeProductCodes);
  }
  // Coded system channels (Direct) arrive already-coded — they can't go through the raw recognizer
  // (which rejects coded sheets). Route them through the coded importer (see end of file).
  if (isCodedSystemChannel(distributorCode)) {
    return analyzeCodedSystemChannel(distributorCode, file, String(periodOverride ?? "").trim(), excludeProductCodes);
  }
  const rec = await recognizeDistributorWorkbook(distributorCode, file);
  if (rec.status === "coded_sheet") return { status: "coded_sheet", distributorName: rec.distributorName };
  if (rec.status === "header_error") {
    // AI helper, ONLY when stuck: explain the mismatch + suggest a column mapping. No-op without an AI
    // key, and never throws — the deterministic header_error is returned regardless.
    const aiExplanation = await explainHeaderMismatch({ distributorName: rec.distributorName, observedHeaders: rec.observedHeaders, missingGroups: rec.missingGroups });
    return { status: "header_error", distributorName: rec.distributorName, missingGroups: rec.missingGroups, fingerprintWarning: rec.fingerprintWarning, aiExplanation };
  }
  const preview = summarizePreview(distributorCode, rec.distributorName, rec.result, rec.products, excludeProductCodes);
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

// Persist a raw upload. Blocks (persists nothing) when the file can't be used: unmapped rows
// (exceptions), or any validator error — a duplicate sheet, an unreadable/unrecognized file, or broken
// geography. Pure data-quality findings are advisory warnings that never block. Never a partial import.
export async function commitMonthlyUpload(input: {
  distributorCode: string;
  file: File;
  periodOverride?: string;
  uploadedBy: string;
  // Confidential products (LA003/LA004/SS001) to strip from the returned preview when the commit is
  // blocked (unmapped rows / validation failure) and nothing is persisted — same rule analyze already
  // applies, since a blocked commit still returns a raw row sample to the caller.
  excludeProductCodes?: readonly string[];
}): Promise<CommitResult> {
  const excludeProductCodes = input.excludeProductCodes ?? [];
  // Office channel: pivot allocation — always needs a period.
  if (normalizeCodeKey(input.distributorCode) === normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE)) {
    return commitOfficeChannel(input.distributorCode, input.file, String(input.periodOverride ?? "").trim(), input.uploadedBy);
  }
  // Coded system channels (Direct): persist via the coded importer — byte-identical to the legacy
  // /sales/import path (template_key "direct_orders", is_direct=true). See end of file.
  if (isCodedSystemChannel(input.distributorCode)) {
    return commitCodedSystemChannel(input.distributorCode, input.file, String(input.periodOverride ?? "").trim(), input.uploadedBy);
  }
  const rec = await recognizeDistributorWorkbook(input.distributorCode, input.file);
  if (rec.status === "coded_sheet") throw new SalesWorkflowError("coded_sheet", "This sheet is already coded — upload the raw distributor export instead.", 400);
  if (rec.status === "header_error") {
    throw new SalesWorkflowError("header_validation_error", headerErrorMessage(rec.distributorName, rec.missingGroups), 422);
  }
  const result = rec.result;
  const reconciliation = buildReconciliation(result);

  // Product-only exceptions are auto-excluded (those rows are already absent from result.coded).
  // Only brick/customer/both/blank_customer exceptions block — the operator must fix those mappings.
  const blockingExceptions = result.exceptions.filter((e) => e.reason !== "product");
  if (blockingExceptions.length > 0) {
    return { status: "blocked", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, result, rec.products, excludeProductCodes) };
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

  // Strict server-side re-validation with the FINAL resolved period (never trust the client). report.ok
  // is false only for a hard-block error (duplicate sheet, unreadable/unrecognized file, or broken
  // geography). Pure data-quality findings are warnings that never block.
  const crossCheck = await buildDistributorCrossCheck(input.distributorCode, rec.distributorName, input.file);
  const validation = await runStrictValidation(input.distributorCode, rec, stamped, period, crossCheck);
  if (!validation.ok) {
    return { status: "blocked_validation", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, result, rec.products, excludeProductCodes), validation };
  }

  // Replace-not-double-count: persistNormalizedBatch supersedes any prior batch for this
  // (distributor, month) atomically as part of finalizing THIS batch (phx_finalize_sos_batch), so
  // the old good batch is only ever removed once the new one is confirmed validated and rolled up —
  // never before. The DB partial unique index (source_of_sales_one_validated_batch_per_period)
  // remains the hard backstop: if a duplicate still races past this (or a same-month batch from
  // another template exists), the insert fails fast with 23505, surfaced below as a clear
  // "already imported" 409 rather than silently double-counting.
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

// ── Coded system channels (Direct) on the Sales Upload hub ──────────────────────────────────────
// Direct is uploaded ALREADY coded (region-only, value-from-sheet), so it can't run through the raw
// recognizer (which rejects coded sheets). These adapters route it through the proven coded importer
// (createSourceOfSalesUploadFromBuffer) and map the result into the SAME AnalyzeResult / CommitResult
// shapes the hub UI consumes. The DB write is byte-identical to the legacy /sales/import path
// (template_key "direct_orders", is_direct=true) — only the entry page changes. The breakdown tables
// run through buildPreviewBreakdowns with the same excludeProductCodes the raw path uses, so the
// confidential-products rule (LA003/LA004/SS001) is honored for non-CEO viewers here too.

type CodedParseResult = DistributorSalesValidationResult & { parsedRows: ParsedDistributorRow[] };

// Map a coded parsed row onto the recognizer's CodedRow so the shared breakdown builder runs unchanged.
function codedParsedRowToCodedRow(p: ParsedDistributorRow): CodedRow {
  return {
    areaCode: p.areaCode,
    areaName: p.areaName,
    brickId: p.brickId,
    brickName: p.brickName,
    bonusQty: p.bonusQty,
    clientCode: p.clientCode,
    clientName: p.clientName,
    clientAddress: p.clientAddress,
    discount: p.discount,
    distributorCode: p.distributorCode,
    invoiceDate: p.invoicePeriod ?? p.invoiceDate ?? "",
    invoiceNumber: p.invoiceNumber,
    isDirect: p.isDirect,
    officialLine: p.officialLine,
    productCode: p.productCode,
    productName: p.productName,
    qty: p.qty,
    // The coded path already captured the source row via rawImportRow — carry it rather than
    // dropping it here, so both import routes agree about what the file contained.
    rawRow: p.rawRow,
    rawRowNumber: p.rowNumber,
    regionCode: p.regionCode,
    regionName: p.regionName,
    value: p.value,
  };
}

function codedReconciliation(r: DistributorSalesValidationResult): ReconciliationReceipt {
  const rowsIgnored = Math.max(0, r.rowCount - r.importableRows - r.failedRows);
  return {
    rowsRead: r.rowCount,
    rowsCoded: r.importableRows,
    rowsIgnored,
    rowsBlankCustomer: 0,
    rowsBlocked: r.failedRows,
    totalQty: Number((r.totals.totalQty ?? 0).toFixed(6)),
    totalValue: Number((r.totals.totalValue ?? 0).toFixed(6)),
  };
}

// Map the coded importer's per-row issues + batch reasons into the hub's ValidationReport. `ok` mirrors
// the coded engine's authoritative gate exactly (status "validated" ⇔ no hard block), so analyze and
// commit never disagree. Per-row issues are grouped by (severity, field, message) into one finding.
function codedValidationReport(r: DistributorSalesValidationResult): ValidationReport {
  const groups = new Map<string, ValidationFinding>();
  for (const issue of r.issues) {
    const severity: ValidationSeverity = issue.severity === "failure" ? "error" : "warning";
    const key = `${severity}|${issue.field}|${issue.message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.sampleRows.length < 12 && Number.isFinite(issue.rowNumber)) existing.sampleRows.push(issue.rowNumber);
    } else {
      groups.set(key, {
        code: key,
        severity,
        title: issue.field,
        detail: issue.message,
        count: 1,
        sampleRows: Number.isFinite(issue.rowNumber) ? [issue.rowNumber] : [],
      });
    }
  }
  const findings: ValidationFinding[] = [...groups.values()];
  for (const reason of r.blockingReasons ?? []) {
    findings.push({ code: `block|${reason}`, severity: "error", title: "Upload blocked", detail: reason, count: 1, sampleRows: [] });
  }
  for (const note of r.advisories ?? []) {
    findings.push({ code: `advisory|${note}`, severity: "info", title: "Advisory", detail: note, count: 1, sampleRows: [] });
  }
  return {
    ok: r.status === "validated",
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
    infoCount: findings.filter((f) => f.severity === "info").length,
    findings,
  };
}

// Minimal NormalizePreview for a coded channel. Direct is fully ID-coded, so there are never unmapped
// items (the unknown* lists stay empty); the reconciliation receipt + breakdowns carry the real numbers.
function codedPreview(distributorCode: string, r: DistributorSalesValidationResult): NormalizePreview {
  const ignored = Math.max(0, r.rowCount - r.importableRows - r.failedRows);
  return {
    distributorCode,
    distributorName: r.distributor.name,
    period: r.period,
    periods: r.period ? [{ period: r.period, rows: r.importableRows }] : [],
    sampleCoded: [],
    summary: {
      brickResolved: r.importableRows,
      blankCustomerSkipped: 0,
      fullyCoded: r.importableRows,
      ignored,
      productResolved: r.importableRows,
      totalRows: r.rowCount,
      scannedDataRows: r.rowCount,
    },
    unknownCustomers: [],
    unknownProducts: [],
    unknownTerritories: [],
    ignoredItems: [],
    blankCustomerSkipped: 0,
    blankCustomerErrors: 0,
    darkCount: 0,
  };
}

async function analyzeCodedSystemChannel(distributorCode: string, file: File, periodOverride: string, excludeProductCodes: readonly string[]): Promise<AnalyzeResult> {
  const parsed = (await createSourceOfSalesUploadFromBuffer({
    buffer: await file.arrayBuffer(),
    distributorCode,
    fileName: file.name,
    uploadedBy: "preview",
    periodOverride,
    dryRun: true,
  })) as CodedParseResult;
  const codedRows = parsed.parsedRows
    .filter((row) => row.validationState !== "failed")
    .map(codedParsedRowToCodedRow);
  return {
    status: "ok",
    preview: codedPreview(distributorCode, parsed),
    reconciliation: codedReconciliation(parsed),
    breakdowns: buildPreviewBreakdowns(codedRows, excludeProductCodes),
    period: parsed.period,
    needsPeriod: !parsed.period,
    engineVersion: RECOGNITION_ENGINE_VERSION,
    validation: codedValidationReport(parsed),
    isRegionOnly: true,
  };
}

async function commitCodedSystemChannel(distributorCode: string, file: File, periodOverride: string, uploadedBy: string): Promise<CommitResult> {
  // persistOnlyIfValidated: a blocked result writes NOTHING (fail-closed). A duplicate validated sheet
  // throws SalesWorkflowError(409) from the coded persist, which the commit route surfaces as today.
  const result = (await createSourceOfSalesUploadFromBuffer({
    buffer: await file.arrayBuffer(),
    distributorCode,
    fileName: file.name,
    uploadedBy,
    periodOverride,
    persistOnlyIfValidated: true,
  })) as DistributorSalesValidationResult & { batchId: string | null };
  const reconciliation = codedReconciliation(result);
  if (result.status === "validated" && result.batchId) {
    return {
      status: "imported",
      batchId: result.batchId,
      period: result.period,
      importedRows: result.importableRows,
      reconciliation,
      engineVersion: RECOGNITION_ENGINE_VERSION,
      validation: codedValidationReport(result),
    };
  }
  return {
    status: "blocked_validation",
    reconciliation,
    preview: codedPreview(distributorCode, result),
    validation: codedValidationReport(result),
  };
}

// ── Office allocation channel on the Sales Upload hub ───────────────────────────────────────────
// Office is a pivot file (product name + total units, no geography). It CANNOT go through the raw
// recognizer (no normalizer profile) and is NOT a coded sheet. Instead route through
// previewOfficeAllocation / commitOfficeAllocation which do the two-step brick allocation.
// Period is mandatory upfront (the allocation uses that period's sales data as its distribution base).

function officeBreakdowns(result: DistributorSalesValidationResult, excludeProductCodes: readonly string[]): PreviewBreakdowns {
  const excluded = new Set(excludeProductCodes.map((c) => normalizeCodeKey(c)));
  const byProduct = result.byProduct
    .filter((p) => !excluded.has(normalizeCodeKey(p.productCode)))
    .map((p) => ({ code: p.productCode, label: p.productName, parent: p.officialLine || null, rowCount: p.rowCount, totalQty: p.totalQty, totalBonusQty: p.totalBonusQty, totalValue: p.totalValue }));
  const byRegion = result.byRegion.map((r) => ({ code: r.regionCode, label: r.regionName, parent: null, rowCount: r.rowCount, totalQty: r.totalQty, totalBonusQty: r.totalBonusQty, totalValue: r.totalValue }));
  const byBrick = result.byBrick.map((b) => ({ code: b.brickId, label: b.brickName, parent: b.areaCode, rowCount: b.rowCount, totalQty: b.totalQty, totalBonusQty: b.totalBonusQty, totalValue: b.totalValue }));
  const byLine = result.byLine.map((l) => ({ code: l.line, label: l.line, parent: null, rowCount: l.rowCount, totalQty: l.totalQty, totalBonusQty: l.totalBonusQty, totalValue: l.totalValue }));
  return { byProduct, byRegion, byBrick, byLine };
}

function emptyOfficePreview(distributorCode: string): NormalizePreview {
  return {
    distributorCode,
    distributorName: "Marcyrl",
    period: null,
    periods: [],
    sampleCoded: [],
    summary: { brickResolved: 0, blankCustomerSkipped: 0, fullyCoded: 0, ignored: 0, productResolved: 0, totalRows: 0, scannedDataRows: 0 },
    unknownCustomers: [],
    unknownProducts: [],
    unknownTerritories: [],
    ignoredItems: [],
    blankCustomerSkipped: 0,
    blankCustomerErrors: 0,
    darkCount: 0,
  };
}

async function analyzeOfficeChannel(distributorCode: string, file: File, periodOverride: string, excludeProductCodes: readonly string[]): Promise<AnalyzeResult> {
  if (!periodOverride) {
    return {
      status: "ok",
      preview: emptyOfficePreview(distributorCode),
      reconciliation: { rowsRead: 0, rowsCoded: 0, rowsIgnored: 0, rowsBlankCustomer: 0, rowsBlocked: 0, totalQty: 0, totalValue: 0 },
      breakdowns: { byProduct: [], byRegion: [], byBrick: [], byLine: [] },
      period: null,
      needsPeriod: true,
      engineVersion: RECOGNITION_ENGINE_VERSION,
      validation: { ok: true, errorCount: 0, warningCount: 0, infoCount: 0, findings: [] },
    };
  }
  const result = await previewOfficeAllocation({ buffer: await file.arrayBuffer(), fileName: file.name, period: periodOverride });
  return {
    status: "ok",
    preview: codedPreview(distributorCode, result),
    reconciliation: codedReconciliation(result),
    breakdowns: officeBreakdowns(result, excludeProductCodes),
    period: result.period,
    needsPeriod: false,
    engineVersion: RECOGNITION_ENGINE_VERSION,
    validation: codedValidationReport(result),
  };
}

async function commitOfficeChannel(distributorCode: string, file: File, periodOverride: string, uploadedBy: string): Promise<CommitResult> {
  if (!periodOverride) throw new SalesWorkflowError("missing_period", "Office allocation requires a period — pick the month before importing.", 400);
  const result = await commitOfficeAllocation({ buffer: await file.arrayBuffer(), fileName: file.name, period: periodOverride, uploadedBy });
  const reconciliation = codedReconciliation(result);
  if (result.status !== "validated") {
    return { status: "blocked_validation", reconciliation, preview: codedPreview(distributorCode, result), validation: codedValidationReport(result) };
  }
  if (!result.batchId) throw new SalesWorkflowError("persist_failed", "Office allocation did not return a batch ID.", 500);
  return {
    status: "imported",
    batchId: result.batchId,
    period: result.period,
    importedRows: result.importableRows,
    reconciliation,
    engineVersion: RECOGNITION_ENGINE_VERSION,
    validation: codedValidationReport(result),
  };
}
