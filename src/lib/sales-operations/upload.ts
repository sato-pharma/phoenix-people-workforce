// Sales Operations Module — analyze / commit orchestration.
//
// Both analyze (dry-run) and commit (persist) run through the SAME recognizer + SAME validator, so
// what the analyzer recognizes the upload always accepts (the prime directive). Errors always block;
// warnings block until the caller acknowledges; nothing persists while exceptions exist.

import { SalesWorkflowError } from "@/lib/sales/contracts";
import type { OfficeBrickShare, OfficeRegionShare } from "@/lib/sales-operations/office";
import { persistSalesOpsBatch } from "@/lib/sales-operations/persist";
import {
  recognizeSalesOpsWorkbook,
  SALES_OPS_ENGINE_VERSION,
  type HeaderGroup,
  type SalesOpsRecognizeResult,
} from "@/lib/sales-operations/recognize";
import type { BrickLookupStrategy, CodedRow, NormalizeResult } from "@/lib/sales-operations/types";
import { validateSalesOpsUpload, type PriorPeriodTotals, type SalesOpsValidationContext, type ValidationReport } from "@/lib/sales-operations/validation";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const VALID_PERIOD = /^\d{4}-\d{2}$/;

// ── Pure period decision ───────────────────────────────────────────────────────────────────────
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

// Pure: the exact result that WILL be persisted. Consolidating under one chosen period can turn
// distinct-month rows into true duplicates, so validation must run on this (not the raw) result.
export function applyPeriodConsolidation(result: NormalizeResult, decision: PeriodDecision): NormalizeResult {
  if (decision.kind !== "ok" || !decision.consolidate) return result;
  return { ...result, coded: result.coded.map((r) => ({ ...r, invoiceDate: decision.period })) };
}

// ── Pure reconciliation receipt ──────────────────────────────────────────────────────────────
export type ReconciliationReceipt = {
  rowsRead: number;
  rowsCoded: number;
  rowsExcluded: number;
  rowsBlankKey: number;
  rowsBlocked: number;
  totalQty: number;
  totalValue: number;
};

// The user-facing accounting receipt. The real no-silent-loss guard is the scannedDataRows reconcile
// in persist (assertReconciles) / the validator's rows_read_mismatch.
export function buildReconciliation(result: NormalizeResult): ReconciliationReceipt {
  const s = result.summary;
  const totalQty = result.coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const totalValue = result.coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
  return {
    rowsRead: s.scannedDataRows,
    rowsCoded: s.fullyCoded,
    rowsExcluded: s.excludedBonus,
    rowsBlankKey: s.blankKeySkipped,
    rowsBlocked: result.exceptions.length,
    totalQty: Number(totalQty.toFixed(6)),
    totalValue: Number(totalValue.toFixed(6)),
  };
}

// ── Pure validation-context builder (the wiring the adversarial review required) ─────────────────
export function buildSalesOpsValidationContext(
  rec: { hasDateColumn: boolean; brickLookup: BrickLookupStrategy; regionOnly: boolean; nationalUnits?: number; nationalProducts?: string[] },
  extra: { currentPeriod: string; resolvedPeriod: string | null; existingBatchPeriods: string[]; priorPeriodTotals: PriorPeriodTotals | null },
): SalesOpsValidationContext {
  const isOffice = rec.brickLookup === "office-allocation";
  return {
    hasDateColumn: rec.hasDateColumn,
    isOfficeAllocation: isOffice,
    officeNationalUnits: isOffice ? rec.nationalUnits : undefined,
    officeNationalProducts: isOffice ? rec.nationalProducts : undefined,
    regionOnly: rec.regionOnly,
    currentPeriod: extra.currentPeriod,
    resolvedPeriod: extra.resolvedPeriod,
    existingBatchPeriods: extra.existingBatchPeriods,
    priorPeriodTotals: extra.priorPeriodTotals,
  };
}

// ── Preview ──────────────────────────────────────────────────────────────────────────────────
export type DistinctUnknown = { value: string; count: number };
export type SalesOpsPreview = {
  distributorCode: string;
  distributorName: string;
  period: string | null;
  periods: { period: string; rows: number }[];
  sampleCoded: CodedRow[];
  summary: NormalizeResult["summary"];
  unknownProducts: DistinctUnknown[];
  unknownBricks: DistinctUnknown[];
  blockedCount: number;
};

function distinct(values: string[]): DistinctUnknown[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count).slice(0, 500);
}

function summarizePreview(distributorCode: string, distributorName: string, result: NormalizeResult, period: string | null): SalesOpsPreview {
  const periodCounts = new Map<string, number>();
  for (const r of result.coded) if (r.invoiceDate) periodCounts.set(r.invoiceDate, (periodCounts.get(r.invoiceDate) ?? 0) + 1);
  const unknownProducts = distinct(result.exceptions.filter((e) => e.reason === "product" || e.reason === "both").map((e) => e.rawProductName || e.rawProduct));
  const unknownBricks = distinct(result.exceptions.filter((e) => e.reason === "brick" || e.reason === "both").map((e) => e.rawBrickName || e.rawCustomerCode));
  return {
    distributorCode,
    distributorName,
    period,
    periods: [...periodCounts.entries()].map(([p, rows]) => ({ period: p, rows })).sort((a, b) => a.period.localeCompare(b.period)),
    sampleCoded: result.coded.slice(0, 50),
    summary: result.summary,
    unknownProducts,
    unknownBricks,
    blockedCount: result.exceptions.length,
  };
}

// ── Async context helpers (best-effort; failures degrade gracefully) ─────────────────────────────
function currentPeriodUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function listExistingBatchPeriods(distributorCode: string): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("sales_ops_import_batches")
      .select("period")
      .eq("distributor_code", distributorCode)
      .eq("is_current", true)
      .eq("status", "validated");
    if (error) return [];
    return [...new Set((data ?? []).map((r) => String((r as { period: unknown }).period ?? "")).filter((p) => VALID_PERIOD.test(p)))];
  } catch {
    return [];
  }
}

async function getPriorPeriodTotals(distributorCode: string, resolvedPeriod: string | null): Promise<PriorPeriodTotals | null> {
  if (!resolvedPeriod || !VALID_PERIOD.test(resolvedPeriod)) return null;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("sales_ops_import_batches")
      .select("period,total_value,total_qty")
      .eq("distributor_code", distributorCode)
      .eq("is_current", true)
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

// Office contribution base for a period: how every OTHER channel sold each product (region + brick
// share), derived from the committed leaf rollup. Best-effort (empty before the migration / data).
async function loadOfficeSharesFromRollups(period: string): Promise<{ regionShare: OfficeRegionShare[]; brickShare: OfficeBrickShare[] }> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("sales_ops_rollup_leaf")
      .select("product_code,region_code,area_code,brick_id,total_qty")
      .eq("period", period)
      .neq("distributor_code", "Office");
    if (error || !data) return { regionShare: [], brickShare: [] };
    const regionMap = new Map<string, OfficeRegionShare>();
    const brickMap = new Map<string, OfficeBrickShare>();
    for (const r of data as Array<{ product_code: string; region_code: string; area_code: string; brick_id: string; total_qty: number | string }>) {
      const pc = String(r.product_code ?? "");
      const rc = String(r.region_code ?? "");
      const qty = Number(r.total_qty ?? 0);
      if (!pc || !rc) continue;
      const rkey = `${pc}|${rc}`;
      const rs = regionMap.get(rkey) ?? { productCode: pc, regionCode: rc, units: 0 };
      rs.units += qty;
      regionMap.set(rkey, rs);
      const bid = String(r.brick_id ?? "");
      if (bid) {
        const bkey = `${pc}|${bid}`;
        const bs = brickMap.get(bkey) ?? { productCode: pc, brickId: bid, areaCode: String(r.area_code ?? ""), regionCode: rc, units: 0 };
        bs.units += qty;
        brickMap.set(bkey, bs);
      }
    }
    return { regionShare: [...regionMap.values()], brickShare: [...brickMap.values()] };
  } catch {
    return { regionShare: [], brickShare: [] };
  }
}

// Assemble context + run the pure validator over the result that WILL be persisted. Same at analyze
// and commit.
async function runStrictValidation(distributorCode: string, rec: Extract<SalesOpsRecognizeResult, { status: "ok" }>, resultToValidate: NormalizeResult, resolvedPeriod: string | null): Promise<ValidationReport> {
  const [existingBatchPeriods, priorPeriodTotals] = await Promise.all([
    listExistingBatchPeriods(distributorCode),
    getPriorPeriodTotals(distributorCode, resolvedPeriod),
  ]);
  const ctx = buildSalesOpsValidationContext(rec, {
    currentPeriod: currentPeriodUtc(),
    resolvedPeriod,
    existingBatchPeriods,
    priorPeriodTotals,
  });
  return validateSalesOpsUpload(resultToValidate, ctx);
}

// ── Public API ─────────────────────────────────────────────────────────────────────────────────
export type AnalyzeResult =
  | { status: "ok"; preview: SalesOpsPreview; reconciliation: ReconciliationReceipt; period: string | null; needsPeriod: boolean; hasDateColumn: boolean; engineVersion: string; validation: ValidationReport }
  | { status: "header_error"; distributorName: string; missingGroups: HeaderGroup[]; fingerprintWarning?: { likelyCode: string; likelyName: string } }
  | { status: "coded_sheet"; distributorName: string };

export async function analyzeSalesOpsUpload(distributorCode: string, file: File, periodOverride = ""): Promise<AnalyzeResult> {
  const override = String(periodOverride ?? "").trim();
  const rec = await recognizeSalesOpsWorkbook(distributorCode, file, { period: override || undefined, loadOfficeShares: loadOfficeSharesFromRollups });
  if (rec.status === "coded_sheet") return { status: "coded_sheet", distributorName: rec.distributorName };
  if (rec.status === "header_error") return { status: "header_error", distributorName: rec.distributorName, missingGroups: rec.missingGroups, fingerprintWarning: rec.fingerprintWarning };

  const reconciliation = buildReconciliation(rec.result);
  const decision = resolveUploadPeriod(rec.result.coded.map((r) => r.invoiceDate), override);
  const resolvedPeriod = decision.kind === "ok" ? decision.period : rec.period;
  const validation = await runStrictValidation(distributorCode, rec, applyPeriodConsolidation(rec.result, decision), resolvedPeriod);
  return {
    status: "ok",
    preview: summarizePreview(distributorCode, rec.distributorName, rec.result, rec.period),
    reconciliation,
    period: rec.period,
    needsPeriod: !rec.period,
    hasDateColumn: rec.hasDateColumn,
    engineVersion: SALES_OPS_ENGINE_VERSION,
    validation,
  };
}

export type CommitResult =
  | { status: "imported"; batchId: string; period: string; importedRows: number; reconciliation: ReconciliationReceipt; engineVersion: string; validation: ValidationReport }
  | { status: "blocked"; reconciliation: ReconciliationReceipt; preview: SalesOpsPreview }
  | { status: "blocked_validation"; reconciliation: ReconciliationReceipt; preview: SalesOpsPreview; validation: ValidationReport };

export async function commitSalesOpsUpload(input: { distributorCode: string; file: File; periodOverride?: string; uploadedBy: string; acknowledgeWarnings?: boolean }): Promise<CommitResult> {
  const override = String(input.periodOverride ?? "").trim();
  const rec = await recognizeSalesOpsWorkbook(input.distributorCode, input.file, { period: override || undefined, loadOfficeShares: loadOfficeSharesFromRollups });
  if (rec.status === "coded_sheet") throw new SalesWorkflowError("coded_sheet", "This sheet is already coded — upload the raw distributor export instead.", 400);
  if (rec.status === "header_error") throw new SalesWorkflowError("header_validation_error", `Sheet is missing required columns: ${rec.missingGroups.join(", ")}.`, 422);

  const isOffice = rec.brickLookup === "office-allocation";
  const reconciliation = buildReconciliation(rec.result);
  if (rec.result.exceptions.length > 0) {
    return { status: "blocked", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, rec.result, rec.period) };
  }

  const decision = resolveUploadPeriod(rec.result.coded.map((r) => r.invoiceDate), override);
  if (decision.kind === "missing") throw new SalesWorkflowError("missing_period", "This sheet has no date column — pick the period before importing.", 400);
  if (decision.kind === "multi") throw new SalesWorkflowError("multi_period", `This sheet spans ${decision.periods.length} months (${decision.periods.join(", ")}). Pick a period to import them all under one month, or upload one month per file.`, 400);
  const period = decision.period;

  const stamped = applyPeriodConsolidation(rec.result, decision);
  const validation = await runStrictValidation(input.distributorCode, rec, stamped, period);
  if (!validation.ok || (validation.warningCount > 0 && !input.acknowledgeWarnings)) {
    return { status: "blocked_validation", reconciliation, preview: summarizePreview(input.distributorCode, rec.distributorName, rec.result, rec.period), validation };
  }

  const persisted = await persistSalesOpsBatch({
    distributorCode: input.distributorCode,
    distributorName: rec.distributorName,
    fileName: input.file.name,
    result: stamped,
    period,
    uploadedBy: input.uploadedBy,
    engineVersion: SALES_OPS_ENGINE_VERSION,
    isOffice,
  });
  return { status: "imported", reconciliation, engineVersion: SALES_OPS_ENGINE_VERSION, validation, ...persisted };
}
