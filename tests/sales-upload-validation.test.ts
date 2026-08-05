import assert from "node:assert/strict";

import { validateNormalizedUpload, type ValidationContext, type ValidationReport } from "../src/lib/sales/upload-validation.ts";
import { applyPeriodConsolidation } from "../src/lib/sales/sales-upload.ts";
import type { CodedRow, NormalizeException, NormalizeIgnoredRow, NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

// ── builders ──────────────────────────────────────────────────────────────────────────────────
function row(over: Partial<CodedRow> = {}): CodedRow {
  return {
    areaCode: "A1", areaName: "Area 1", brickId: "B1", brickName: "Brick 1",
    bonusQty: 0, clientCode: "C1", clientName: "Client 1", clientAddress: null,
    discount: 0, distributorCode: "PS", invoiceDate: "2026-05", invoiceDay: null, invoiceNumber: null, isDirect: false,
    officialLine: "Line A", productCode: "P1", productName: "Product 1",
    qty: 10, rawRow: {}, rawRowNumber: 2, regionCode: "R1", regionName: "Region 1", value: 100,
    ...over,
  };
}

function result(rows: CodedRow[], over: { exceptions?: NormalizeException[]; ignoredRows?: NormalizeIgnoredRow[]; blankCustomerRows?: NormalizeIgnoredRow[]; scannedDataRows?: number } = {}): NormalizeResult {
  const exceptions = over.exceptions ?? [];
  const ignoredRows = over.ignoredRows ?? [];
  const blankCustomerRows = over.blankCustomerRows ?? [];
  const ignored = ignoredRows.length;
  const blankCustomerSkipped = blankCustomerRows.length;
  const fullyCoded = rows.length;
  const totalRows = fullyCoded + exceptions.length + ignored + blankCustomerSkipped;
  return {
    coded: rows,
    distributorCode: "PS",
    exceptions,
    ignoredRows,
    blankCustomerRows,
    customerBrickCorrections: [],
    summary: {
      brickResolved: fullyCoded, blankCustomerSkipped, fullyCoded, ignored,
      productResolved: fullyCoded, totalRows,
      scannedDataRows: over.scannedDataRows ?? totalRows,
    },
  };
}

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  return { valueSource: "recompute", hasDateColumn: true, currentPeriod: "2026-06", ...over };
}

function darkException(): NormalizeException {
  return { rawProduct: "X", rawProductName: "", rawTerritory: "", rawCustomerCode: "", rawCustomerName: "", rawCustomerAddress: "", rawRowNumber: 9, reason: "brick" };
}

function ignoredRow(rawRowNumber: number): NormalizeIgnoredRow {
  return { rawProduct: "IGN", rawProductName: "Ignored", rawRowNumber, qty: 5 };
}

const has = (r: ValidationReport, code: string) => r.findings.some((f) => f.code === code);
const sev = (r: ValidationReport, code: string) => r.findings.find((f) => f.code === code)?.severity;

// ── tests ─────────────────────────────────────────────────────────────────────────────────────
//
// Owner rule baked into these tests: an upload is BLOCKED only when the system cannot read/recognize
// the file or importing would corrupt/double-count data — i.e. unmapped rows (gated by the flow), a
// duplicate sheet, an unreadable/unrecognized file (column mismatch, nothing coded, rows that don't
// reconcile), or broken geography. Every PURE data-quality finding is an advisory warning that never
// sets ok=false (duplicate lines, odd values, anomalies, future-dated rows, blank dates, …).

function cleanBatchPasses() {
  const r = validateNormalizedUpload(result([row({ clientCode: "C1" }), row({ clientCode: "C2", rawRowNumber: 3 })]), ctx());
  assert.equal(r.errorCount, 0);
  assert.equal(r.warningCount, 0);
  assert.equal(r.ok, true);
  assert.ok(has(r, "recognition_coverage_summary"));
}

// ── Hard blocks: can't read / recognize the file, or would corrupt data ─────────────────────────

function noCodedRowsBlocks() {
  const r = validateNormalizedUpload(result([]), ctx());
  assert.ok(has(r, "no_coded_rows"));
  assert.equal(sev(r, "no_coded_rows"), "error");
  assert.equal(r.ok, false);
}

function allRowsIgnoredBlocks() {
  // zero coded, all readable rows ignored → nothing recognized
  const r = validateNormalizedUpload(result([], { ignoredRows: [ignoredRow(2), ignoredRow(3)] }), ctx());
  assert.ok(has(r, "all_rows_ignored"));
  assert.equal(sev(r, "all_rows_ignored"), "error");
  assert.equal(r.ok, false);
}

function darkExceptionsBlock() {
  const r = validateNormalizedUpload(result([row()], { exceptions: [darkException()] }), ctx());
  assert.equal(sev(r, "dark_exceptions"), "error");
  assert.equal(r.ok, false);
}

function rowsReadMismatchBlocks() {
  const r = result([row(), row({ clientCode: "C2", rawRowNumber: 3 })]);
  r.summary.scannedDataRows = (r.summary.scannedDataRows ?? 0) + 1; // physical counter disagrees
  const report = validateNormalizedUpload(r, ctx());
  assert.equal(sev(report, "rows_read_mismatch"), "error");
  assert.equal(report.ok, false);
}

function brickToRegionInconsistentBlocks() {
  const r = validateNormalizedUpload(result([row({ brickId: "B1", regionCode: "R1" }), row({ brickId: "B1", regionCode: "R2", clientCode: "C2", qty: 20, value: 200, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(r, "brick_to_region_inconsistent"), "error");
  assert.equal(r.ok, false);
}

function blankGeographyBlocks() {
  const r = validateNormalizedUpload(result([row({ brickId: "", areaCode: "", regionCode: "" })]), ctx());
  assert.equal(sev(r, "blank_geography"), "error");
  assert.equal(r.ok, false);
}

function duplicateSheetBlocks() {
  const r = validateNormalizedUpload(result([row()]), ctx({ resolvedPeriod: "2026-05", existingBatchPeriods: ["2026-05", "2026-04"] }));
  assert.equal(sev(r, "period_replace"), "error");
  assert.equal(r.ok, false);
  // a not-yet-imported period must NOT block
  const fresh = validateNormalizedUpload(result([row()]), ctx({ resolvedPeriod: "2026-05", existingBatchPeriods: ["2026-04"] }));
  assert.equal(has(fresh, "period_replace"), false);
  assert.equal(fresh.ok, true);
}

// ── Advisory warnings: never block (the owner's "data quality = warn, not block") ───────────────

function duplicateRowsWarnNeverBlock() {
  // Same invoice number + all other fields match → genuine duplicate → warn
  const r = validateNormalizedUpload(result([row({ rawRowNumber: 2, invoiceNumber: "INV-001" }), row({ rawRowNumber: 3, invoiceNumber: "INV-001" })]), ctx());
  assert.equal(sev(r, "duplicate_rows"), "warning");
  assert.equal(r.ok, true); // duplicate LINES are advisory — only a duplicate SHEET blocks

  // No invoice number → can't distinguish separate orders → never warn
  const noInv = validateNormalizedUpload(result([row({ rawRowNumber: 2 }), row({ rawRowNumber: 3 })]), ctx());
  assert.equal(has(noInv, "duplicate_rows"), false);
}

function futureDatedRowsWarnNeverBlock() {
  const r = validateNormalizedUpload(result([row({ invoiceDate: "2026-12" })]), ctx());
  assert.equal(sev(r, "future_dated_rows"), "warning");
  assert.equal(r.ok, true); // a future date is a data-quality note — never blocks
}

function negativeQtyOnlyWarnsWhenReturnsDominate() {
  // routine returns are normal (credit notes) → NOT flagged at all
  const small = validateNormalizedUpload(result([row({ qty: -2, value: -20 }), row({ clientCode: "C2", qty: 100, value: 1000, rawRowNumber: 3 })]), ctx());
  assert.equal(has(small, "negative_qty"), false);
  // returns dominate (offset > 25% of positive units) → warning (likely wrong file/period)
  const big = validateNormalizedUpload(result([row({ qty: -50, value: -500 }), row({ clientCode: "C2", qty: 10, value: 100, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(big, "negative_qty"), "warning");
}

function negativeValueExcludesReturns() {
  // value<0 with qty>=0 → flagged
  const flagged = validateNormalizedUpload(result([row({ qty: 5, value: -50 }), row({ clientCode: "C2", value: 100, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(flagged, "negative_value"), "warning");
  // value<0 BUT qty<0 → a return, must NOT be flagged as negative_value
  const ret = validateNormalizedUpload(result([row({ qty: -5, value: -50 }), row({ clientCode: "C2", qty: 100, value: 1000, rawRowNumber: 3 })]), ctx());
  assert.equal(has(ret, "negative_value"), false);
}

function zeroQtyIsInfoZeroValueWarns() {
  const zq = validateNormalizedUpload(result([row({ qty: 0, value: 0 }), row({ clientCode: "C2", value: 100, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(zq, "zero_qty"), "info"); // zero-qty is harmless → advisory
  const zv = validateNormalizedUpload(result([row({ value: 0 }), row({ clientCode: "C2", value: 100, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(zv, "zero_value_with_qty"), "warning");
}

function discountOutOfRangeWarns() {
  const r = validateNormalizedUpload(result([row({ discount: 1.5 }), row({ clientCode: "C2", discount: -0.2, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(r, "discount_out_of_range"), "warning");
  assert.equal(r.findings.find((f) => f.code === "discount_out_of_range")?.count, 2);
}

function allZeroValueBatchWarns() {
  const r = validateNormalizedUpload(result([row({ value: 0 }), row({ clientCode: "C2", value: 0, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(r, "all_zero_value_batch"), "warning");
}

function fractionalQtyNotFlagged() {
  // Pharma: customers buy partial packs (a strip or two, not the full box), so a fractional quantity
  // is legitimate data and must NOT be flagged.
  const r = validateNormalizedUpload(result([row({ qty: 12.5, value: 125 })]), ctx());
  assert.equal(r.findings.some((f) => f.code === "non_integer_qty"), false, "fractional quantity must not be flagged");
}

// The critical date-less-profile guard: a CP-style pivot (no date column) must NOT be flagged for
// blank dates; a dated profile with unparseable dates is flagged, but only ever as a (non-blocking)
// warning now — it never escalates to an error.
function blankDateGuardedByHasDateColumn() {
  const dateless = validateNormalizedUpload(result([row({ invoiceDate: "" })]), ctx({ hasDateColumn: false }));
  assert.equal(has(dateless, "blank_invoice_date"), false);
  const someBlank = validateNormalizedUpload(result([row({ invoiceDate: "" }), row({ clientCode: "C2", invoiceDate: "2026-05", rawRowNumber: 3 })]), ctx({ hasDateColumn: true }));
  assert.equal(sev(someBlank, "blank_invoice_date"), "warning");
  const allBlank = validateNormalizedUpload(result([row({ invoiceDate: "" }), row({ clientCode: "C2", invoiceDate: "", rawRowNumber: 3 })]), ctx({ hasDateColumn: true }));
  assert.equal(sev(allBlank, "blank_invoice_date"), "warning"); // never escalates to error
  assert.equal(allBlank.ok, true);
}

function customerInconsistentBrickWarns() {
  // same customer C1 → two different bricks (qty differs so it is NOT a duplicate)
  const r = validateNormalizedUpload(result([row({ clientCode: "C1", brickId: "B1" }), row({ clientCode: "C1", brickId: "B2", qty: 20, value: 200, rawRowNumber: 3 })]), ctx());
  assert.equal(sev(r, "customer_inconsistent_brick"), "warning");
}

function geographyBrickMissingRespectsRegionOnly() {
  const flagged = validateNormalizedUpload(result([row({ brickId: "", regionCode: "R1", areaCode: "A1" })]), ctx({ regionOnly: false }));
  assert.equal(sev(flagged, "geography_brick_missing"), "warning");
  const regionOnly = validateNormalizedUpload(result([row({ brickId: "", regionCode: "R1", areaCode: "A1" })]), ctx({ regionOnly: true }));
  assert.equal(has(regionOnly, "geography_brick_missing"), false);
}

function unknownLineWarns() {
  const r = validateNormalizedUpload(result([row({ officialLine: "Unknown" })]), ctx());
  assert.equal(sev(r, "unknown_official_line"), "warning");
}

function highIgnoredWarns() {
  // 1 coded + 4 ignored = 5 rows, 80% ignored
  const r = validateNormalizedUpload(result([row()], { ignoredRows: [ignoredRow(3), ignoredRow(4), ignoredRow(5), ignoredRow(6)] }), ctx());
  assert.equal(sev(r, "high_ignored"), "warning");
  assert.equal(sev(r, "ignored_units"), "info");
}

function priorPeriodSpikeWarns() {
  const r = validateNormalizedUpload(result([row({ qty: 100, value: 8000 })]), ctx({ resolvedPeriod: "2026-05", priorPeriodTotals: { period: "2026-04", totalValue: 2000, totalQty: 100 } }));
  assert.equal(sev(r, "value_spike_vs_prior"), "warning");
}

function extremeUnitPriceOnlyForSheet() {
  const price = new Map([["P1", 10]]);
  // recompute: not checked even if value is wild
  const recompute = validateNormalizedUpload(result([row({ qty: 1, value: 1000 })]), ctx({ valueSource: "recompute", priceByProductCode: price }));
  assert.equal(has(recompute, "extreme_unit_price"), false);
  // sheet: unit price 1000 vs master 10 → flagged
  const sheet = validateNormalizedUpload(result([row({ qty: 1, value: 1000, isDirect: true })]), ctx({ valueSource: "sheet", priceByProductCode: price }));
  assert.equal(sev(sheet, "extreme_unit_price"), "warning");
}

// Regression for the consolidation double-count: two rows from DIFFERENT source months that are
// otherwise identical are NOT duplicates raw, but BECOME duplicates once consolidated under one
// picked period — validation must run on the consolidated result so the warning fires.
function consolidationSurfacesCrossPeriodDuplicates() {
  // Rows with matching invoice numbers from different months: distinct before consolidation,
  // genuine duplicate after — the same invoice appearing twice under one period.
  const rows = [row({ invoiceDate: "2026-04", invoiceNumber: "INV-001" }), row({ invoiceDate: "2026-05", invoiceNumber: "INV-001", rawRowNumber: 3 })];
  const raw = result(rows);
  const rawReport = validateNormalizedUpload(raw, ctx({ resolvedPeriod: null }));
  assert.equal(has(rawReport, "duplicate_rows"), false); // distinct months → not duplicates yet
  const consolidated = applyPeriodConsolidation(raw, { kind: "ok", period: "2026-05", consolidate: true });
  assert.ok(consolidated.coded.every((r) => r.invoiceDate === "2026-05"));
  const report = validateNormalizedUpload(consolidated, ctx({ resolvedPeriod: "2026-05" }));
  assert.equal(sev(report, "duplicate_rows"), "warning"); // same invoice number → genuine duplicate
}

// Returns-only / negative-net batch must NOT trip a false "collapse" anomaly warning.
function negativeNetBatchDoesNotFalseCollapse() {
  const rows = [row({ qty: -5, value: -500 }), row({ clientCode: "C2", qty: -3, value: -100, rawRowNumber: 3 })];
  const report = validateNormalizedUpload(result(rows), ctx({ resolvedPeriod: "2026-05", priorPeriodTotals: { period: "2026-04", totalValue: 5000, totalQty: 500 } }));
  assert.equal(has(report, "value_collapse_vs_prior"), false);
  assert.equal(has(report, "qty_anomaly_vs_prior"), false);
}

// Verify-against-pick cross-check: warn ONLY when the auto-detector is confident the file is a
// different distributor than the one picked. Low/none/ambiguous/same-code must NOT cry wolf.
function detectorDisagreementWarnsOnlyWhenConfident() {
  const base = result([row()]);
  const warn = validateNormalizedUpload(base, ctx({ detectorCrossCheck: { pickedCode: "PS", pickedName: "Pharma Soft", bestCode: "EG", bestName: "EGD", confidence: "high", ambiguous: false } }));
  assert.equal(sev(warn, "detector_disagrees_with_pick"), "warning");
  assert.equal(warn.ok, true); // a warning is advisory — it never hard-blocks
  // same distributor (case-insensitive) → no finding
  assert.equal(has(validateNormalizedUpload(base, ctx({ detectorCrossCheck: { pickedCode: "PS", bestCode: "ps", bestName: "Pharma Soft", confidence: "high", ambiguous: false } })), "detector_disagrees_with_pick"), false);
  // low confidence → no finding
  assert.equal(has(validateNormalizedUpload(base, ctx({ detectorCrossCheck: { pickedCode: "PS", bestCode: "EG", bestName: "EGD", confidence: "low", ambiguous: false } })), "detector_disagrees_with_pick"), false);
  // none / null best → no finding
  assert.equal(has(validateNormalizedUpload(base, ctx({ detectorCrossCheck: { pickedCode: "PS", bestCode: null, bestName: null, confidence: "none", ambiguous: false } })), "detector_disagrees_with_pick"), false);
  // no cross-check supplied → no finding (back-compat)
  assert.equal(has(validateNormalizedUpload(base, ctx()), "detector_disagrees_with_pick"), false);
}

// The core owner rule, end to end. A batch that trips many DATA-QUALITY findings at once (duplicate
// lines + future dates + an out-of-range discount) still imports — ok stays true. Each "can't read /
// would corrupt" case (unreadable file, broken geography, duplicate sheet) flips ok=false.
function onlyHardBlocksBlockDataQualityIsAdvisory() {
  const noisy = result([
    row({ invoiceDate: "2026-12", discount: 1.5, rawRowNumber: 2, invoiceNumber: "INV-001" }),
    row({ invoiceDate: "2026-12", discount: 1.5, rawRowNumber: 3, invoiceNumber: "INV-001" }), // same invoice number → duplicate line; future-dated; bad discount
  ]);
  const report = validateNormalizedUpload(noisy, ctx());
  assert.ok(has(report, "duplicate_rows"));
  assert.ok(has(report, "future_dated_rows"));
  assert.ok(has(report, "discount_out_of_range"));
  assert.equal(report.errorCount, 0, "pure data-quality findings must never be errors");
  assert.equal(report.ok, true, "data-quality warnings never block the upload");

  // Each hard block flips ok=false:
  const unreadable = validateNormalizedUpload(result([row()], { exceptions: [darkException()] }), ctx());
  assert.equal(unreadable.ok, false);
  const brokenGeo = validateNormalizedUpload(result([row({ brickId: "B1", regionCode: "R1" }), row({ brickId: "B1", regionCode: "R2", clientCode: "C2", qty: 20, value: 200, rawRowNumber: 3 })]), ctx());
  assert.equal(brokenGeo.ok, false);
  const dupSheet = validateNormalizedUpload(result([row()]), ctx({ resolvedPeriod: "2026-05", existingBatchPeriods: ["2026-05"] }));
  assert.equal(dupSheet.ok, false);
}

export function runSalesUploadValidationTests() {
  cleanBatchPasses();
  noCodedRowsBlocks();
  allRowsIgnoredBlocks();
  darkExceptionsBlock();
  rowsReadMismatchBlocks();
  brickToRegionInconsistentBlocks();
  blankGeographyBlocks();
  duplicateSheetBlocks();
  duplicateRowsWarnNeverBlock();
  futureDatedRowsWarnNeverBlock();
  negativeQtyOnlyWarnsWhenReturnsDominate();
  negativeValueExcludesReturns();
  zeroQtyIsInfoZeroValueWarns();
  discountOutOfRangeWarns();
  allZeroValueBatchWarns();
  fractionalQtyNotFlagged();
  blankDateGuardedByHasDateColumn();
  customerInconsistentBrickWarns();
  geographyBrickMissingRespectsRegionOnly();
  unknownLineWarns();
  highIgnoredWarns();
  priorPeriodSpikeWarns();
  extremeUnitPriceOnlyForSheet();
  consolidationSurfacesCrossPeriodDuplicates();
  negativeNetBatchDoesNotFalseCollapse();
  detectorDisagreementWarnsOnlyWhenConfident();
  onlyHardBlocksBlockDataQualityIsAdvisory();
}
