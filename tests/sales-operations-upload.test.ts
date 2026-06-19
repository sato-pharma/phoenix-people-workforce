import assert from "node:assert/strict";

import type { CodedRow, NormalizeResult } from "../src/lib/sales-operations/types.ts";
import {
  applyPeriodConsolidation,
  buildReconciliation,
  buildSalesOpsValidationContext,
  resolveUploadPeriod,
} from "../src/lib/sales-operations/upload.ts";
import { validateSalesOpsUpload } from "../src/lib/sales-operations/validation.ts";

function row(over: Partial<CodedRow> = {}): CodedRow {
  return {
    areaCode: "A1", areaName: "Area One", brickId: "B1", brickName: "Brick One",
    clientCode: "C1", clientName: "Cust", clientAddress: null, distributorCode: "PS",
    family: "F", invoiceDate: "2026-04", officialLine: "OTC", productCode: "1001",
    productName: "Panadol", qty: 5, rawRowNumber: 2, regionCode: "CA", regionName: "Cairo", value: 50, ...over,
  };
}

function makeResult(coded: CodedRow[], over: Partial<NormalizeResult["summary"]> = {}): NormalizeResult {
  return {
    distributorCode: "PS",
    coded,
    exceptions: [],
    excluded: [],
    summary: { scannedDataRows: coded.length, fullyCoded: coded.length, productResolved: coded.length, productByCodeFallback: 0, brickResolved: coded.length, excludedBonus: 0, blankKeySkipped: 0, exceptions: 0, ...over },
  };
}

export async function runSalesOperationsUploadTests() {
  // ── resolveUploadPeriod ──────────────────────────────────────────────────────────────────────
  assert.deepEqual(resolveUploadPeriod(["2026-04", "2026-05"], "2026-06"), { kind: "ok", period: "2026-06", consolidate: true }, "override → consolidate");
  assert.deepEqual(resolveUploadPeriod(["2026-04", "2026-04"], ""), { kind: "ok", period: "2026-04", consolidate: false }, "single period → use it");
  assert.deepEqual(resolveUploadPeriod([], ""), { kind: "missing" }, "no period → missing");
  assert.deepEqual(resolveUploadPeriod(["2026-05", "2026-04"], ""), { kind: "multi", periods: ["2026-04", "2026-05"] }, "multi → refuse (sorted)");

  // ── applyPeriodConsolidation ─────────────────────────────────────────────────────────────────
  const raw = makeResult([row({ invoiceDate: "2026-03" }), row({ rawRowNumber: 3, invoiceDate: "2026-04" })]);
  const consolidated = applyPeriodConsolidation(raw, { kind: "ok", period: "2026-06", consolidate: true });
  assert.equal(consolidated.coded.every((r) => r.invoiceDate === "2026-06"), true, "consolidate rewrites every invoiceDate");
  const untouched = applyPeriodConsolidation(raw, { kind: "ok", period: "2026-04", consolidate: false });
  assert.equal(untouched, raw, "no consolidation → same result reference");

  // ── buildReconciliation ──────────────────────────────────────────────────────────────────────
  const recon = buildReconciliation(makeResult([row({ qty: 5, value: 50 }), row({ rawRowNumber: 3, qty: 3, value: 30 })]));
  assert.equal(recon.rowsRead, 2);
  assert.equal(recon.rowsCoded, 2);
  assert.equal(recon.totalQty, 8);
  assert.equal(recon.totalValue, 80);

  // ── buildSalesOpsValidationContext: maps recognize result → context ──────────────────────────
  const extra = { currentPeriod: "2026-06", resolvedPeriod: "2026-04", existingBatchPeriods: [], priorPeriodTotals: null };
  const psCtx = buildSalesOpsValidationContext({ hasDateColumn: true, brickLookup: "customer-code", regionOnly: false }, extra);
  assert.equal(psCtx.isOfficeAllocation, false);
  assert.equal(psCtx.officeNationalUnits, undefined);
  assert.equal(psCtx.regionOnly, false);
  const cpCtx = buildSalesOpsValidationContext({ hasDateColumn: false, brickLookup: "brick-name", regionOnly: true }, extra);
  assert.equal(cpCtx.regionOnly, true, "CP region-only flag threads through");
  const officeCtx = buildSalesOpsValidationContext({ hasDateColumn: false, brickLookup: "office-allocation", regionOnly: false, nationalUnits: 7, nationalProducts: ["Panadol"] }, extra);
  assert.equal(officeCtx.isOfficeAllocation, true);
  assert.equal(officeCtx.officeNationalUnits, 7);

  // ── REGRESSION (per the review): office context → validator fires office_allocation_residual ──
  const officeResult = makeResult([row({ distributorCode: "Office", regionCode: "NATIONAL", brickId: "", areaCode: "" })], { scannedDataRows: 1 });
  const report = validateSalesOpsUpload(officeResult, officeCtx);
  const residual = report.findings.find((x) => x.code === "office_allocation_residual");
  assert.equal(residual?.severity, "warning", "wiring nationalUnits!=0 through the context makes the residual check fire");
  // and the one-pivot-row→many-slices reconcile must NOT block (defensive office gate)
  assert.equal(report.findings.find((x) => x.code === "rows_read_mismatch"), undefined);
}
