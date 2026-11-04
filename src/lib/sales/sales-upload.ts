import { createHash } from "node:crypto";

import { isPostgresUniqueViolation, SalesWorkflowError } from "@/lib/sales/contracts";
import { invalidateClosingStoreSplitCache } from "@/lib/dashboard/invalidation";
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
import { summarizeEpdaBonusDeduction, type EpdaDeductionLine } from "@/lib/sales/import-epda-bonus-deduction";
import { buildPreviewBreakdowns, type PreviewBreakdowns } from "@/lib/sales/normalizer/breakdowns";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { describeRefusedRow, isRefusedRow, listRowLines, summarizeRefusedRows } from "@/lib/sales/normalizer/row-messages";
import { persistNormalizedBatch } from "@/lib/sales/normalizer/service";
import type { CodedRow, NormalizeException, NormalizeResult } from "@/lib/sales/normalizer/types";
import { repriceValue, type ProductPeriodPrices } from "@/lib/sales/product-period-price";
import { RECOGNITION_ENGINE_VERSION, recognizeDistributorWorkbook, summarizePreview, type NormalizeFileResult, type NormalizePreview } from "@/lib/sales/recognize";
import {
  MAX_UPLOAD_FILES,
  combineMonthReports,
  combinedFileName,
  findRepeatedSheet,
  labelFindingRows,
  labelPreviewRows,
  labelReportRows,
  mergeNormalizeResults,
  planUploadFiles,
  type UploadFileFacts,
  type UploadFileFingerprint,
  type UploadFileGroup,
} from "@/lib/sales/sales-upload-files";
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
  // Units the distributor flagged as free goods. Part of rowsIgnored, never part of totalQty — the
  // bonus is never counted as sales. Shown so the receipt's Qty and the sheet's Qty reconcile on the
  // screen instead of in someone's head.
  freeGoodsQty: number;
  rowsFreeGoods: number;
};

// Pure: builds the bucket-accounting receipt shown to the user. NOTE: the read == coded + ignored +
// blank + blocked assert here is a consistency check on summary.totalRows, which the engine DEFINES as
// exactly that sum — so it can never catch a "row scanned but never bucketed" bug. The real
// no-silent-loss guard is the independent physical counter (summary.scannedDataRows) checked in
// validateNormalizedUpload (rows_read_mismatch), which always runs before persist. Keep both.
export function buildReconciliation(
  result: NormalizeResult,
  /**
   * Confidential product codes this viewer may not see. Affects the MONEY only — see below.
   * Empty for a CEO / Super Admin, and empty by default so a caller that forgets gets the old,
   * complete receipt rather than a silently under-stated one.
   */
  excludeProductCodes: readonly string[] = [],
): ReconciliationReceipt {
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
  // The ROW COUNTS above stay whole on purpose. They answer "did we account for every row we read",
  // which is a file-integrity question, not a question about who may see which product — and the
  // assert above depends on them summing to totalRows.
  //
  // The MONEY is the opposite case. The tables rendered under this receipt already strip the
  // confidential products (buildPreviewBreakdowns takes the same list), but these totals did not —
  // so the receipt showed a Total value the tables could not account for, and the difference IS the
  // hidden figure. Those three products are 81.5% of all sales value, and SFE Manager is the only
  // role holding sales:import while not being CEO/Super Admin, so the one person who uses this
  // screen daily is exactly the one it was hiding them from.
  const hidden = new Set(
    excludeProductCodes.map((code) => String(code ?? "").trim().toUpperCase()).filter(Boolean),
  );
  const countable =
    hidden.size === 0
      ? result.coded
      : result.coded.filter((r) => !hidden.has(String(r.productCode ?? "").trim().toUpperCase()));
  const totalQty = countable.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const totalValue = countable.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
  // Free goods are excluded from sales by the owner's rule, not lost — the receipt says how many
  // units that rule took out, beside the Qty it kept. Confidential products are hidden here too.
  const freeGoods = result.ignoredRows.filter(
    (r) => r.reason === "bonus" && !hidden.has(String(r.productCode ?? "").trim().toUpperCase()),
  );
  return {
    rowsRead,
    rowsCoded: s.fullyCoded,
    rowsIgnored: s.ignored,
    rowsBlankCustomer: s.blankCustomerSkipped,
    rowsBlocked,
    totalQty: Number(totalQty.toFixed(6)),
    totalValue: Number(totalValue.toFixed(6)),
    freeGoodsQty: Number(freeGoods.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0).toFixed(6)),
    rowsFreeGoods: freeGoods.length,
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
//
// A re-dated distributor row is re-PRICED too: the engine valued it at the month the sheet gave it (or
// at the flat master price when the sheet has no date at all), and it is stored under the chosen month,
// which is the price the closing values it at — Saginko is 170.52 from 2026-10, 111.15 before. A
// direct row keeps its deal value, and a row no reprice reaches keeps its exact figure (repriceValue).
export function applyPeriodConsolidation(
  result: NormalizeResult,
  decision: PeriodDecision,
  prices?: Pick<ProductPeriodPrices, "priceFor">,
): NormalizeResult {
  if (decision.kind !== "ok" || !decision.consolidate) return result;
  return {
    ...result,
    coded: result.coded.map((r) => ({
      ...r,
      invoiceDate: decision.period,
      value: prices && !r.isDirect ? repriceValue(prices, r.productCode, r.value, r.invoiceDate, decision.period) : r.value,
    })),
  };
}

/**
 * Fold the period decision into an ANALYZE report so it says what COMMIT will do.
 *
 * Commit refuses a sheet with no resolvable period outright — it throws `missing_period` or
 * `multi_period` BEFORE validating anything. Analyze ran validation regardless, passing
 * `resolvedPeriod: null`, which also disables every period-dependent check (prior-period totals, the
 * one-batch-per-period duplicate test). So a date-less or multi-month sheet could be reported
 * "Validation passed" and then hard-rejected on import — while `analyzeMonthlyUpload`'s own comment
 * promised "the analyze report matches the commit gate exactly".
 *
 * A month the operator picked is folded in too, when it re-dates rows: see redatedRowsFinding. Pass
 * the rows as the sheet dated them, before consolidation.
 *
 * Pure, so the two paths can be proven to agree without uploading a file.
 */
export function withPeriodGateFinding(
  report: ValidationReport,
  decision: PeriodDecision,
  coded: readonly Pick<CodedRow, "invoiceDate" | "rawRowNumber">[] = [],
): ValidationReport {
  if (decision.kind === "ok") {
    const redated = redatedRowsFinding(coded, decision);
    return redated ? { ...report, warningCount: report.warningCount + 1, findings: [redated, ...report.findings] } : report;
  }
  const finding: ValidationFinding =
    decision.kind === "missing"
      ? {
          code: "period_missing",
          severity: "error",
          title: "No period — this file cannot be imported yet",
          detail:
            "This sheet has no date column, so there is no month to file it under. Importing now is refused, not merely unvalidated.",
          count: 1,
          sampleRows: [],
          fixHint: "Pick the period above, then analyze again.",
        }
      : {
          code: "period_multi",
          severity: "error",
          title: `This sheet spans ${decision.periods.length} months`,
          detail:
            `The rows carry ${decision.periods.length} different months (${decision.periods.join(", ")}). ` +
            "Importing now is refused: the import files one month at a time.",
          count: decision.periods.length,
          sampleRows: [],
          fixHint: "Pick a period above to import them all under one month, or upload one month per file.",
        };
  // Prepend: this is the reason the import will be refused, so it belongs above findings about rows
  // that will never be imported anyway.
  return {
    ok: false,
    errorCount: report.errorCount + 1,
    warningCount: report.warningCount,
    infoCount: report.infoCount,
    findings: [finding, ...report.findings],
  };
}

/**
 * The warning for rows the picked month re-dates, or null when it re-dates none.
 *
 * Filing a sheet under the month the operator picks is allowed: the multi-month refusal itself says
 * "Pick a period above to import them all under one month". But every row the sheet dated in another
 * month is then imported as the picked month's sales, and nothing said so. The strict checks run on
 * the rows after they are re-dated, so they cannot see it, and Sales Upload's own period picker, in
 * bulk import and whenever a month is chosen before Validate, gave no sign the sheet held another
 * month at all. Production, 2026-09-18: EG-HOS's August sheet carried one invoice dated 25 July, and
 * it is filed under August.
 *
 * A warning, not a block: consolidating stays the operator's choice, now made knowing which rows move.
 */
export function redatedRowsFinding(
  coded: readonly Pick<CodedRow, "invoiceDate" | "rawRowNumber">[],
  decision: PeriodDecision,
): ValidationFinding | null {
  if (decision.kind !== "ok" || !decision.consolidate) return null;
  const moved = coded.filter((r) => r.invoiceDate && r.invoiceDate !== decision.period);
  if (moved.length === 0) return null;
  const byMonth = new Map<string, number>();
  for (const r of moved) byMonth.set(r.invoiceDate, (byMonth.get(r.invoiceDate) ?? 0) + 1);
  const months = [...byMonth].sort(([a], [b]) => a.localeCompare(b));
  const parts = months.map(([month, n]) => `${month} (${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"})`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const left = months.length === 1 ? `${months[0][0]} will not include them` : "Those months will not include them";
  return {
    code: "rows_redated",
    severity: "warning",
    title: `Rows dated in another month will be filed under ${decision.period}`,
    detail: `Rows dated ${list} will be imported as ${decision.period} sales, because ${decision.period} is the month picked for this file. ${left}.`,
    count: moved.length,
    sampleRows: moved.slice(0, 12).map((r) => r.rawRowNumber),
    fixHint: "If they belong to their own month, upload one month per file. If they are meant to count in this month, there is nothing to do.",
  };
}

/**
 * Whether one exception row makes commit refuse the WHOLE file. An unknown product is the only
 * exception the import tolerates: those rows are left out and the rest imports. Any other reason
 * blocks, and commit returns "blocked" before it validates anything.
 */
export function blocksImport(exception: NormalizeException): boolean {
  return exception.reason !== "product";
}

/**
 * The one finding for the rows commit refuses that no mapping can fix (row-messages.ts's
 * REFUSED_ROW_REASONS), or null when there are none. It names each row and the cell as the sheet wrote
 * it — "Row 145: quantity "1,2OO" has letters in it" — so the person knows exactly what to correct.
 * Analyze folds it into its report; a blocked commit returns it so the refusal says the same thing.
 */
export function refusedRowsFinding(exceptions: readonly NormalizeException[]): ValidationFinding | null {
  const refused = exceptions.filter(blocksImport).filter(isRefusedRow);
  if (refused.length === 0) return null;
  return {
    code: "rows_refused",
    severity: "error",
    title: "Rows the import refuses",
    detail:
      `${summarizeRefusedRows(refused)}. ${listRowLines(refused.map(describeRefusedRow))}. ` +
      "One such row is enough for the import to refuse the whole file, not just these rows, and no mapping can fix them.",
    count: refused.length,
    // Row numbers and the refused cell only: a refused row's product name is raw sheet text, which the
    // confidential-product exclusion cannot recognise, so naming it could show a restricted viewer a
    // product they may not see.
    sampleRows: refused.slice(0, 12).map((e) => e.rawRowNumber),
    fixHint:
      "Correct these rows in the distributor's sheet, then analyze again. Arabic digits and thousands " +
      "written with spaces are read for you; a letter, a bracket or a word inside a number is never guessed.",
  };
}

/**
 * Fold the rows commit refuses into an ANALYZE report, as withPeriodGateFinding does for the period.
 *
 * Analyze never looked at them. A row with an unreadable quantity, value or discount, or a blank
 * customer where the profile treats one as an error (EGD Branch), is counted in no unmapped list and
 * tripped no strict check, so Sales Upload said "Validation passed", Diagnostics said "this file would
 * import cleanly", and the very next click imported nothing.
 *
 * Pure, so the two paths can be proven to agree without uploading a file.
 */
export function withRefusedRowsFinding(report: ValidationReport, exceptions: readonly NormalizeException[]): ValidationReport {
  const finding = refusedRowsFinding(exceptions);
  if (!finding) return report;
  return {
    ok: false,
    errorCount: report.errorCount + 1,
    warningCount: report.warningCount,
    infoCount: report.infoCount,
    findings: [finding, ...report.findings],
  };
}

export type AnalyzeResult =
  | { status: "ok"; preview: NormalizePreview; reconciliation: ReconciliationReceipt; breakdowns: PreviewBreakdowns; bonusDeduction?: EpdaDeductionLine[]; period: string | null; needsPeriod: boolean; engineVersion: string; validation: ValidationReport; isRegionOnly?: boolean; files?: UploadFileSummary[]; batches?: UploadBatchSummary[] }
  // fileName: which of several chosen files it is about (absent for one file).
  | { status: "header_error"; distributorName: string; missingGroups: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string }; aiExplanation?: HeaderMismatchExplanation; fileName?: string }
  | { status: "coded_sheet"; distributorName: string; fileName?: string };

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
  if (rec.status === "template_error") {
    // Sales Upload always posts a real distributor, so this is unreachable here — but the
    // recognizer's result is a closed union and the template's own message is the right words.
    throw new SalesWorkflowError("template_error", rec.message, 422);
  }
  const preview = summarizePreview(distributorCode, rec.distributorName, rec.result, rec.products, excludeProductCodes);
  // Same exclusion list as the preview and the breakdowns below, or the receipt total states what
  // the tables under it are hiding.
  const reconciliation = buildReconciliation(rec.result, excludeProductCodes);
  // Per-product/region/brick/line breakdown for the Validate step. Confidential products are
  // excluded for non-CEO/Super-Admin viewers (excludeProductCodes) so the tables never leak them.
  const breakdowns = buildPreviewBreakdowns(rec.result.coded, excludeProductCodes, rec.result.ignoredRows);
  const decision = resolveUploadPeriod(rec.result.coded.map((r) => r.invoiceDate), String(periodOverride ?? "").trim());
  const resolvedPeriod = decision.kind === "ok" ? decision.period : null;
  // Validate the rows AS THEY WILL BE PERSISTED (consolidated when a period was picked) so analyze
  // matches the commit gate exactly — including duplicates that only appear after consolidation.
  const crossCheck = await buildDistributorCrossCheck(distributorCode, rec.distributorName, file);
  const persisted = applyPeriodConsolidation(rec.result, decision, rec.prices);
  const bonusDeduction = summarizeEpdaBonusDeduction(persisted.coded, (r) => r.invoiceDate, excludeProductCodes);
  // ...and fold in the period gate, because commit REFUSES a missing or multi-month period before it
  // validates anything. Without this, those two cases were validated with resolvedPeriod = null —
  // which also disables the period-dependent checks — and could report "Validation passed" for a file
  // the very next click rejects. The rows commit refuses outright are folded in the same way: an
  // unknown territory or customer already shows as an unmapped item, but nothing else showed them.
  // A picked month that re-dates rows is named from the rows as the sheet dated them.
  const validation = withPeriodGateFinding(
    withRefusedRowsFinding(
      await runStrictValidation(distributorCode, rec, persisted, resolvedPeriod, crossCheck),
      rec.result.exceptions,
    ),
    decision,
    rec.result.coded,
  );
  return { status: "ok", preview, reconciliation, breakdowns, bonusDeduction, period: rec.period, needsPeriod: !rec.period, engineVersion: RECOGNITION_ENGINE_VERSION, validation };
}

export type CommitResult =
  // batches: one per month when several files were confirmed together (batchId is then the first).
  | { status: "imported"; batchId: string; period: string | null; importedRows: number; reconciliation: ReconciliationReceipt; engineVersion: string; validation: ValidationReport; batches?: { batchId: string; period: string; importedRows: number; fileNames: string[] }[] }
  // blockingRows: the rows that stopped the import (unknown products do not). refused: set when rows no
  // mapping can fix are among them, so the refusal names each one.
  | { status: "blocked"; reconciliation: ReconciliationReceipt; preview: NormalizePreview; blockingRows: number; refused: ValidationFinding | null }
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
  if (rec.status === "template_error") throw new SalesWorkflowError("template_error", rec.message, 422);
  const result = rec.result;
  // The commit receipt goes back to the same viewer as the analyze one, so it carries the same
  // exclusion. What was PERSISTED is unaffected — this is the receipt, not the import.
  const reconciliation = buildReconciliation(result, excludeProductCodes);

  // Product-only exceptions are auto-excluded (those rows are already absent from result.coded).
  // Every other exception blocks (blocksImport) — an unmapped territory or customer, a blank customer
  // where the profile makes it an error, or a quantity/value/discount that cannot be read. Analyze
  // reports the same rows through withRefusedRowsFinding.
  const blockingExceptions = result.exceptions.filter(blocksImport);
  if (blockingExceptions.length > 0) {
    return { status: "blocked", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, result, rec.products, excludeProductCodes), blockingRows: blockingExceptions.length, refused: refusedRowsFinding(blockingExceptions) };
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
  const stamped: NormalizeResult = applyPeriodConsolidation(result, decision, rec.prices);

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
  // New/changed retail rows can change which customers count as store/wholesaler and how much of
  // their sell-in the Closing Matrix redistributes — bust the cached split so the Matrix and portal
  // pick it up now rather than at the next TTL.
  invalidateClosingStoreSplitCache(`monthly closing import — ${input.distributorCode}/${period}`);
  return { status: "imported", reconciliation, engineVersion: RECOGNITION_ENGINE_VERSION, validation, ...persisted };
}

// ── Several sheets of ONE distributor, validated and confirmed once ─────────────────────────────
// The owner, 2026-10-26: "I choose 5 or 6 same distributor sheet, and then do a once validate for the
// bulk." The pure rules — how rows are combined, which files share a batch, the same-sheet-twice
// refusal, naming a row by its file — live in sales-upload-files.ts; this is the recognizing,
// validating and storing around them. One file never reaches this code: it goes through
// analyzeMonthlyUpload / commitMonthlyUpload exactly as before.

type RecognizedUpload = Extract<NormalizeFileResult, { status: "ok" }>;

/** One chosen file, as analyze reports it back. */
export type UploadFileSummary = { fileName: string; months: string[]; rows: number };
/** One batch the files will be stored as: a month and the files in it. */
export type UploadBatchSummary = { period: string | null; fileNames: string[] };

type PreparedUploadFiles =
  | { status: "header_error"; fileName: string; rec: Extract<NormalizeFileResult, { status: "header_error" }> }
  | { status: "coded_sheet"; fileName: string; distributorName: string }
  | {
      status: "ready";
      fileNames: string[];
      recognized: RecognizedUpload[];
      merged: RecognizedUpload;
      groups: UploadFileGroup[];
      files: UploadFileSummary[];
      batches: UploadBatchSummary[];
    };

function refuseUnsupportedMultiFile(distributorCode: string, count: number): void {
  if (count > MAX_UPLOAD_FILES) {
    throw new SalesWorkflowError("too_many_files", `Choose at most ${MAX_UPLOAD_FILES} files at a time (${count} were chosen).`, 400);
  }
  // The Office pivot and the coded Direct sheet are each one whole month in one file; their importers
  // take one file, and there is no second file to combine with.
  if (normalizeCodeKey(distributorCode) === normalizeCodeKey(OFFICE_DISTRIBUTOR_CODE) || isCodedSystemChannel(distributorCode)) {
    throw new SalesWorkflowError("one_file_only", "This channel is uploaded one file at a time. Choose a single file.", 400);
  }
}

// The figures one recognized sheet is fingerprinted by, for the same-sheet-twice refusal.
async function fingerprintUpload(file: File, rec: RecognizedUpload): Promise<UploadFileFingerprint> {
  const digest = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  const qty = rec.result.coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const value = rec.result.coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
  return { fileName: file.name, digest, rows: rec.result.coded.length, qty: Number(qty.toFixed(6)), value: Number(value.toFixed(6)) };
}

// The combined recognition of some of the files: their rows in one result, with the facts the
// validator reads taken so they hold for EVERY file (a date column only when every file has one).
function mergeRecognized(distributorCode: string, recognized: readonly RecognizedUpload[], members: readonly number[]): RecognizedUpload {
  return {
    ...recognized[members[0]],
    result: mergeNormalizeResults(distributorCode, members.map((i) => ({ fileIndex: i, result: recognized[i].result }))),
    period: null,
    hasDateColumn: members.every((i) => recognized[i].hasDateColumn),
    regionOnly: members.some((i) => recognized[i].regionOnly),
  };
}

// Recognize every file one by one (one workbook in memory at a time), refuse the same sheet twice, and
// decide the batches. Analyze and commit both start here, so what analyze shows is what commit stores.
async function prepareUploadFiles(distributorCode: string, files: readonly File[], periodOverride: string): Promise<PreparedUploadFiles> {
  refuseUnsupportedMultiFile(distributorCode, files.length);
  const recognized: RecognizedUpload[] = [];
  const fingerprints: UploadFileFingerprint[] = [];
  for (const file of files) {
    const rec = await recognizeDistributorWorkbook(distributorCode, file);
    if (rec.status === "coded_sheet") return { status: "coded_sheet", fileName: file.name, distributorName: rec.distributorName };
    if (rec.status === "header_error") return { status: "header_error", fileName: file.name, rec };
    if (rec.status === "template_error") throw new SalesWorkflowError("template_error", `"${file.name}": ${rec.message}`, 422);
    recognized.push(rec);
    fingerprints.push(await fingerprintUpload(file, rec));
  }
  const repeated = findRepeatedSheet(fingerprints);
  if (repeated) throw new SalesWorkflowError("repeated_sales_sheet", repeated, 422);

  const fileNames = files.map((f) => f.name);
  const facts: UploadFileFacts[] = recognized.map((rec, i) => ({
    fileName: fileNames[i],
    months: [...new Set(rec.result.coded.map((r) => r.invoiceDate).filter((p): p is string => Boolean(p)))].sort(),
    dominantMonth: rec.period,
  }));
  const plan = planUploadFiles(facts, periodOverride);
  if (!plan.ok) throw new SalesWorkflowError("mixed_month_files", plan.message, 400);
  return {
    status: "ready",
    fileNames,
    recognized,
    merged: mergeRecognized(distributorCode, recognized, recognized.map((_, i) => i)),
    groups: plan.groups,
    files: facts.map((f, i) => ({ fileName: f.fileName, months: f.months, rows: recognized[i].result.coded.length })),
    batches: plan.groups.map((g) => ({
      period: g.decision.kind === "ok" ? g.decision.period : null,
      fileNames: g.members.map((i) => fileNames[i]),
    })),
  };
}

// The verify-against-pick check over every file: the first file the detector confidently places with
// another distributor is the one reported (and named, so the person knows which file to take out);
// otherwise the first file's reading.
async function crossCheckUploadFiles(distributorCode: string, distributorName: string, files: readonly File[]): Promise<{ crossCheck: DistributorCrossCheck | null; fileName: string | null }> {
  let first: DistributorCrossCheck | null = null;
  for (const file of files) {
    const cc = await buildDistributorCrossCheck(distributorCode, distributorName, file);
    first ??= cc;
    if (cc && cc.confidence === "high" && cc.bestCode && cc.bestCode.trim().toLowerCase() !== distributorCode.trim().toLowerCase()) {
      return { crossCheck: cc, fileName: file.name };
    }
  }
  return { crossCheck: first, fileName: null };
}

function nameCrossCheckFile(report: ValidationReport, fileName: string | null): ValidationReport {
  if (!fileName) return report;
  return {
    ...report,
    findings: report.findings.map((f) => (f.code === "detector_disagrees_with_pick" ? { ...f, detail: `"${fileName}": ${f.detail}` } : f)),
  };
}

// Strict validation of one batch: the same chain one file runs at analyze (the period gate and the
// refused rows folded in), so the report says what commit will do.
async function validateUploadGroup(
  distributorCode: string,
  prepared: Extract<PreparedUploadFiles, { status: "ready" }>,
  group: UploadFileGroup,
  crossCheck: DistributorCrossCheck | null,
): Promise<{ period: string | null; stamped: NormalizeResult; report: ValidationReport }> {
  const groupRec = mergeRecognized(distributorCode, prepared.recognized, group.members);
  const period = group.decision.kind === "ok" ? group.decision.period : null;
  const stamped = applyPeriodConsolidation(groupRec.result, group.decision, groupRec.prices);
  const report = withPeriodGateFinding(
    withRefusedRowsFinding(await runStrictValidation(distributorCode, groupRec, stamped, period, crossCheck), groupRec.result.exceptions),
    group.decision,
    groupRec.result.coded,
  );
  return { period, stamped, report };
}

/** Analyze several files of one distributor as one upload. One file is analyzeMonthlyUpload, unchanged. */
export async function analyzeMonthlyUploadFiles(distributorCode: string, files: readonly File[], periodOverride = "", excludeProductCodes: readonly string[] = []): Promise<AnalyzeResult> {
  if (files.length === 1) return analyzeMonthlyUpload(distributorCode, files[0], periodOverride, excludeProductCodes);
  const prepared = await prepareUploadFiles(distributorCode, files, String(periodOverride ?? "").trim());
  if (prepared.status === "coded_sheet") return { status: "coded_sheet", distributorName: prepared.distributorName, fileName: prepared.fileName };
  if (prepared.status === "header_error") {
    const { rec } = prepared;
    const aiExplanation = await explainHeaderMismatch({ distributorName: rec.distributorName, observedHeaders: rec.observedHeaders, missingGroups: rec.missingGroups });
    return { status: "header_error", distributorName: rec.distributorName, missingGroups: rec.missingGroups, fingerprintWarning: rec.fingerprintWarning, aiExplanation, fileName: prepared.fileName };
  }
  const { merged, fileNames } = prepared;
  const preview = labelPreviewRows(summarizePreview(distributorCode, merged.distributorName, merged.result, merged.products, excludeProductCodes), fileNames);
  const reconciliation = buildReconciliation(merged.result, excludeProductCodes);
  const breakdowns = buildPreviewBreakdowns(merged.result.coded, excludeProductCodes, merged.result.ignoredRows);
  const { crossCheck, fileName: crossCheckFile } = await crossCheckUploadFiles(distributorCode, merged.distributorName, files);
  const reports: { period: string | null; report: ValidationReport }[] = [];
  const persistedRows: CodedRow[] = [];
  for (const group of prepared.groups) {
    const { period, stamped, report } = await validateUploadGroup(distributorCode, prepared, group, crossCheck);
    reports.push({ period, report });
    persistedRows.push(...stamped.coded);
  }
  const validation = labelReportRows(nameCrossCheckFile(combineMonthReports(reports), crossCheckFile), fileNames);
  const only = prepared.groups.length === 1 ? prepared.groups[0] : null;
  return {
    status: "ok",
    preview,
    reconciliation,
    breakdowns,
    bonusDeduction: summarizeEpdaBonusDeduction(persistedRows, (r) => r.invoiceDate, excludeProductCodes),
    period: only && only.decision.kind === "ok" ? only.decision.period : null,
    needsPeriod: only !== null && only.decision.kind === "missing",
    engineVersion: RECOGNITION_ENGINE_VERSION,
    validation,
    files: prepared.files,
    batches: prepared.batches,
  };
}

/**
 * Store several files of one distributor: one batch per month, every batch validated before any is
 * stored. One file is commitMonthlyUpload, unchanged.
 *
 * Files of one month are ONE batch, so a confirm never supersedes the month's other files the way six
 * separate confirms did. Different months are separate batches stored one after another; should a later
 * one fail (a race on the one-batch-per-month index), the refusal names the months already stored.
 */
export async function commitMonthlyUploadFiles(input: {
  distributorCode: string;
  files: readonly File[];
  periodOverride?: string;
  uploadedBy: string;
  excludeProductCodes?: readonly string[];
}): Promise<CommitResult> {
  const { distributorCode, files } = input;
  if (files.length === 1) {
    return commitMonthlyUpload({ distributorCode, file: files[0], periodOverride: input.periodOverride, uploadedBy: input.uploadedBy, excludeProductCodes: input.excludeProductCodes });
  }
  const excludeProductCodes = input.excludeProductCodes ?? [];
  const prepared = await prepareUploadFiles(distributorCode, files, String(input.periodOverride ?? "").trim());
  if (prepared.status === "coded_sheet") {
    throw new SalesWorkflowError("coded_sheet", `"${prepared.fileName}" is already coded — upload the raw distributor export instead.`, 400);
  }
  if (prepared.status === "header_error") {
    throw new SalesWorkflowError("header_validation_error", `"${prepared.fileName}": ${headerErrorMessage(prepared.rec.distributorName, prepared.rec.missingGroups)}`, 422);
  }
  const { merged, fileNames } = prepared;
  const reconciliation = buildReconciliation(merged.result, excludeProductCodes);
  const preview = () => labelPreviewRows(summarizePreview(distributorCode, merged.distributorName, merged.result, merged.products, excludeProductCodes), fileNames);

  const blockingExceptions = merged.result.exceptions.filter(blocksImport);
  if (blockingExceptions.length > 0) {
    const refused = refusedRowsFinding(blockingExceptions);
    return { status: "blocked", reconciliation, preview: preview(), blockingRows: blockingExceptions.length, refused: refused ? labelFindingRows(refused, fileNames) : null };
  }

  for (const group of prepared.groups) {
    if (group.decision.kind === "missing") {
      throw new SalesWorkflowError("missing_period", "At least one of these sheets has no date column — pick the period before importing.", 400);
    }
    if (group.decision.kind === "multi") {
      throw new SalesWorkflowError(
        "multi_period",
        `These sheets span ${group.decision.periods.length} months (${group.decision.periods.join(", ")}) and at least one of them holds more than one. Pick a period above to import them all under one month, or upload one month per file.`,
        400,
      );
    }
  }

  // Every batch is validated before the first is stored: a refusal in the third month must not leave
  // the first two imported.
  const { crossCheck, fileName: crossCheckFile } = await crossCheckUploadFiles(distributorCode, merged.distributorName, files);
  const checked: { group: UploadFileGroup; period: string; stamped: NormalizeResult; report: ValidationReport }[] = [];
  for (const group of prepared.groups) {
    const { period, stamped, report } = await validateUploadGroup(distributorCode, prepared, group, crossCheck);
    if (!period) throw new SalesWorkflowError("missing_period", "Pick the period before importing.", 400); // unreachable: refused above
    checked.push({ group, period, stamped, report });
  }
  const validation = labelReportRows(nameCrossCheckFile(combineMonthReports(checked), crossCheckFile), fileNames);
  if (!validation.ok) return { status: "blocked_validation", reconciliation, preview: preview(), validation };

  const stored: { batchId: string; period: string; importedRows: number; fileNames: string[] }[] = [];
  for (const { group, period, stamped } of checked) {
    const memberNames = group.members.map((i) => fileNames[i]);
    let persisted: Awaited<ReturnType<typeof persistNormalizedBatch>>;
    try {
      persisted = await persistNormalizedBatch({
        distributorCode,
        distributorName: merged.distributorName,
        fileName: combinedFileName(memberNames),
        result: stamped,
        uploadedBy: input.uploadedBy,
        period,
      });
    } catch (error) {
      const landed = stored.length > 0 ? ` Already imported: ${stored.map((s) => s.period).join(", ")}.` : "";
      if (isPostgresUniqueViolation(error)) {
        throw new SalesWorkflowError(
          "duplicate_sales_batch",
          `A validated ${merged.distributorName} sheet for ${period} is already imported. Delete it first, then re-upload — this keeps the month from being double-counted.${landed}`,
          409,
        );
      }
      if (!landed) throw error;
      // Months already stored stay stored (each is a whole, validated batch); the person needs to know
      // which, so the rest can be uploaded again without re-sending them.
      if (error instanceof SalesWorkflowError) throw new SalesWorkflowError(error.code, `${error.message}${landed}`, error.status);
      throw new SalesWorkflowError("partial_sales_import", `Storing ${period} failed.${landed} Upload the remaining months again.`, 500);
    }
    stored.push({ batchId: persisted.batchId, period, importedRows: persisted.importedRows, fileNames: memberNames });
    invalidateClosingStoreSplitCache(`monthly closing import — ${distributorCode}/${period}`);
  }
  return {
    status: "imported",
    batchId: stored[0].batchId,
    period: stored.length === 1 ? stored[0].period : null,
    importedRows: stored.reduce((n, s) => n + s.importedRows, 0),
    reconciliation,
    engineVersion: RECOGNITION_ENGINE_VERSION,
    validation,
    batches: stored,
  };
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
    // ParsedDistributorRow.invoiceDate IS the day-level ISO date (YYYY-MM-DD) — the line above
    // deliberately prefers invoicePeriod because CodedRow.invoiceDate is the PERIOD. So the real
    // date belongs here, on invoiceDay. Writing null instead would leave the Direct upload path
    // dateless, which is the exact gap this field was added to close.
    invoiceDay: p.invoiceDate,
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
    // A coded sheet carries no free-goods flag — it arrives with the distributor's rows already
    // resolved, so there is nothing here for the rule to exclude.
    freeGoodsQty: 0,
    rowsFreeGoods: 0,
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
    // Nothing is capped here because nothing is unknown: this channel arrives fully coded.
    unknownTotals: { customers: 0, products: 0, territories: 0, rows: 0 },
    ignoredItems: [],
    ignoredRows: [],
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
    // Nothing is capped here because nothing is unknown: this channel arrives fully coded.
    unknownTotals: { customers: 0, products: 0, territories: 0, rows: 0 },
    ignoredItems: [],
    ignoredRows: [],
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
      reconciliation: { rowsRead: 0, rowsCoded: 0, rowsIgnored: 0, rowsBlankCustomer: 0, rowsBlocked: 0, totalQty: 0, totalValue: 0, freeGoodsQty: 0, rowsFreeGoods: 0 },
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
