import assert from "node:assert/strict";

import type { CodedRow, NormalizeException, NormalizeResult } from "../src/lib/sales-operations/types.ts";
import { validateSalesOpsUpload, type SalesOpsValidationContext } from "../src/lib/sales-operations/validation.ts";

function row(over: Partial<CodedRow> = {}): CodedRow {
  return {
    areaCode: "A1",
    areaName: "Area One",
    brickId: "B1",
    brickName: "Brick One",
    clientCode: "C1",
    clientName: "Cust",
    clientAddress: null,
    distributorCode: "PS",
    family: "Analgesics",
    invoiceDate: "2026-04",
    officialLine: "OTC",
    productCode: "1001",
    productName: "Panadol",
    qty: 5,
    rawRowNumber: 2,
    regionCode: "CA",
    regionName: "Cairo",
    value: 50,
    ...over,
  };
}

function exc(over: Partial<NormalizeException> = {}): NormalizeException {
  return { rawProduct: "", rawProductName: "", rawBrickName: "", rawCustomerCode: "", rawCustomerName: "", rawRowNumber: 3, reason: "brick", ...over };
}

function makeResult(p: {
  coded?: CodedRow[];
  exceptions?: NormalizeException[];
  excluded?: NormalizeResult["excluded"];
  scannedDataRows?: number;
  productResolved?: number;
  productByCodeFallback?: number;
  blankKeySkipped?: number;
}): NormalizeResult {
  const coded = p.coded ?? [];
  const exceptions = p.exceptions ?? [];
  const excluded = p.excluded ?? [];
  return {
    distributorCode: "PS",
    coded,
    exceptions,
    excluded,
    summary: {
      scannedDataRows: p.scannedDataRows ?? coded.length + exceptions.length + excluded.length,
      fullyCoded: coded.length,
      productResolved: p.productResolved ?? coded.length,
      productByCodeFallback: p.productByCodeFallback ?? 0,
      brickResolved: coded.length,
      excludedBonus: excluded.length,
      blankKeySkipped: p.blankKeySkipped ?? 0,
      exceptions: exceptions.length,
    },
  };
}

const f = (r: ReturnType<typeof validateSalesOpsUpload>, code: string) => r.findings.find((x) => x.code === code);
const ctx = (over: Partial<SalesOpsValidationContext> = {}): SalesOpsValidationContext => ({ hasDateColumn: true, ...over });

export async function runSalesOperationsValidationTests() {
  // ── clean batch: ok, no errors ──────────────────────────────────────────────────────────────
  const clean = validateSalesOpsUpload(makeResult({ coded: [row(), row({ rawRowNumber: 3, clientCode: "C2", productCode: "2002" })] }), ctx());
  assert.equal(clean.ok, true);
  assert.equal(clean.errorCount, 0);
  assert.ok(f(clean, "recognition_coverage_summary"), "always-on coverage summary");

  // ── rows_read_mismatch (no-silent-loss) ─────────────────────────────────────────────────────
  const mismatch = validateSalesOpsUpload(makeResult({ coded: [row()], scannedDataRows: 5 }), ctx());
  assert.equal(mismatch.ok, false);
  assert.equal(f(mismatch, "rows_read_mismatch")?.severity, "error");

  // ── no_coded_rows ───────────────────────────────────────────────────────────────────────────
  const empty = validateSalesOpsUpload(makeResult({ coded: [] }), ctx());
  assert.equal(f(empty, "no_coded_rows")?.severity, "error");

  // ── dark_exceptions (column mismatch signature) ─────────────────────────────────────────────
  const dark = validateSalesOpsUpload(makeResult({ coded: [row()], exceptions: [exc({ reason: "brick" })] }), ctx());
  assert.equal(f(dark, "dark_exceptions")?.severity, "error");

  // ── low_recognition_rate ────────────────────────────────────────────────────────────────────
  const lowRec = validateSalesOpsUpload(
    makeResult({ coded: [row(), row({ rawRowNumber: 3 })], exceptions: Array.from({ length: 8 }, (_, i) => exc({ rawCustomerCode: "C9", reason: "product", rawRowNumber: i + 4 })), scannedDataRows: 10 }),
    ctx(),
  );
  assert.equal(f(lowRec, "low_recognition_rate")?.severity, "warning");

  // ── zero_qty / zero_value_with_qty ──────────────────────────────────────────────────────────
  const zeroQ = validateSalesOpsUpload(makeResult({ coded: [row({ qty: 0, value: 0 })] }), ctx());
  assert.equal(f(zeroQ, "zero_qty")?.severity, "warning");
  const zeroVal = validateSalesOpsUpload(makeResult({ coded: [row({ qty: 5, value: 0 }), row({ rawRowNumber: 3, qty: 3, value: 30 })] }), ctx());
  assert.equal(f(zeroVal, "zero_value_with_qty")?.severity, "warning");

  // ── duplicate_rows (key now includes brick, drops discount) ─────────────────────────────────
  const dup = validateSalesOpsUpload(makeResult({ coded: [row({ rawRowNumber: 2 }), row({ rawRowNumber: 3 })] }), ctx());
  assert.equal(f(dup, "duplicate_rows")?.count, 1);

  // ── brick_to_region_inconsistent (error) ────────────────────────────────────────────────────
  const brickConflict = validateSalesOpsUpload(makeResult({ coded: [row({ rawRowNumber: 2 }), row({ rawRowNumber: 3, regionCode: "GZ", areaCode: "A2" })] }), ctx());
  assert.equal(f(brickConflict, "brick_to_region_inconsistent")?.severity, "error");

  // ── blank_geography (error) ─────────────────────────────────────────────────────────────────
  const noGeo = validateSalesOpsUpload(makeResult({ coded: [row({ brickId: "", areaCode: "", regionCode: "" })] }), ctx());
  assert.equal(f(noGeo, "blank_geography")?.severity, "error");

  // ── future_dated_rows (error) ───────────────────────────────────────────────────────────────
  const future = validateSalesOpsUpload(makeResult({ coded: [row({ invoiceDate: "2026-08" })] }), ctx({ currentPeriod: "2026-04" }));
  assert.equal(f(future, "future_dated_rows")?.severity, "error");

  // ── blank_invoice_date gated by hasDateColumn ───────────────────────────────────────────────
  const dateLess = validateSalesOpsUpload(makeResult({ coded: [row({ invoiceDate: "" })] }), ctx({ hasDateColumn: false }));
  assert.equal(f(dateLess, "blank_invoice_date"), undefined, "date-less pivot never trips a blank-date finding");
  const blankDates = validateSalesOpsUpload(makeResult({ coded: [row({ invoiceDate: "" }), row({ rawRowNumber: 3, invoiceDate: "" })] }), ctx({ hasDateColumn: true }));
  assert.equal(f(blankDates, "blank_invoice_date")?.severity, "error", "all blank + dated channel → error");

  // ── period_replace (warning) ────────────────────────────────────────────────────────────────
  const replace = validateSalesOpsUpload(makeResult({ coded: [row()] }), ctx({ resolvedPeriod: "2026-04", existingBatchPeriods: ["2026-04"] }));
  assert.equal(f(replace, "period_replace")?.severity, "warning");

  // ── NEW: name_first_fallback_to_code (info) ─────────────────────────────────────────────────
  const codeFallback = validateSalesOpsUpload(makeResult({ coded: [row()], productResolved: 10, productByCodeFallback: 3 }), ctx());
  assert.equal(f(codeFallback, "name_first_fallback_to_code")?.severity, "info");

  // ── anomaly vs prior period (warning) ───────────────────────────────────────────────────────
  const spike = validateSalesOpsUpload(makeResult({ coded: [row({ value: 100000 })] }), ctx({ priorPeriodTotals: { period: "2026-03", totalValue: 5000, totalQty: 500 } }));
  assert.equal(f(spike, "value_spike_vs_prior")?.severity, "warning");

  // ── Office gating: row-count reconcile + duplicate + brick-less are skipped; residual fires ──
  const officeResidual = validateSalesOpsUpload(
    makeResult({ coded: [row({ regionCode: "NATIONAL", brickId: "", areaCode: "" })], scannedDataRows: 1 }),
    ctx({ hasDateColumn: false, isOfficeAllocation: true, officeResidualUnits: 5 }),
  );
  assert.equal(f(officeResidual, "office_allocation_residual")?.severity, "warning");
  // one pivot row → many slices must NOT trip rows_read_mismatch for Office
  const officeSlices = validateSalesOpsUpload(
    makeResult({ coded: [row({ rawRowNumber: 2 }), row({ rawRowNumber: 2 }), row({ rawRowNumber: 2 })], scannedDataRows: 1 }),
    ctx({ hasDateColumn: false, isOfficeAllocation: true }),
  );
  assert.equal(f(officeSlices, "rows_read_mismatch"), undefined, "office: one pivot row → many slices is expected");
  assert.equal(f(officeSlices, "duplicate_rows"), undefined, "office: same-product slices are not duplicates");
  assert.equal(officeSlices.ok, true);

  // dropped checks no longer exist
  const anyResult = validateSalesOpsUpload(makeResult({ coded: [row({ value: -10, qty: 3 })] }), ctx());
  assert.equal(f(anyResult, "negative_value"), undefined, "negative_value dropped (no discount model)");
  assert.equal(f(anyResult, "discount_out_of_range"), undefined, "discount_out_of_range dropped");
  assert.equal(f(anyResult, "extreme_unit_price"), undefined, "extreme_unit_price dropped (recompute-only)");
}
