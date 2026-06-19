import { OFFICE_DISTRIBUTOR_CODE } from "@/lib/sales-operations/office";
import type { NormalizeResult } from "@/lib/sales-operations/types";

// ── Strict post-analyze validation (Sales Operations) ──────────────────────────────────────────
// After the recognizer codes a raw distributor sheet (analyze), this layer runs EVERY data-quality
// check computable from the coded rows + batch context and produces one structured report. The SAME
// function runs at commit (server-side), so analyze and commit can never disagree. It is pure — the
// async caller assembles the context and passes it in — so it stays fully unit-testable.
//
// Adapted from the old Source-of-Sales validator to the new model:
//   • value = qty × factory price (NO discount, bonus EXCLUDED) → dropped negative_value,
//     discount_out_of_range, extreme_unit_price (recompute-only: unit price is correct by
//     construction; there is no discount field).
//   • product resolved NAME-first → added name_first_fallback_to_code (surfaces missing name aliases).
//   • Office is a contribution allocation (one pivot row → many slices, fractional qty, NATIONAL
//     bucket) → row-count / fractional / brick-less checks are gated off for Office and replaced by
//     office_allocation_residual.
//   • Date-aware checks are gated by ctx.hasDateColumn so a date-less pivot (CP/Office, period from the
//     picker) never trips "missing date" findings.

export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationFinding = {
  code: string;
  severity: ValidationSeverity;
  title: string;
  detail: string;
  count: number;
  sampleRows: number[];
  fixHint?: string;
};

export type ValidationReport = {
  ok: boolean; // no error-severity findings
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: ValidationFinding[];
};

export type PriorPeriodTotals = { period: string; totalValue: number; totalQty: number };

export type SalesOpsValidationContext = {
  hasDateColumn: boolean; // false → period from the picker; skip date checks
  isOfficeAllocation?: boolean; // true → Office: skip row-count/fractional/brick-less checks
  officeNationalUnits?: number; // Office units placed in the NATIONAL bucket (no brick placement)
  officeNationalProducts?: string[]; // products that fell to the NATIONAL bucket
  regionOnly?: boolean; // true → region/area-only resolution is expected, not a gap
  currentPeriod?: string; // "YYYY-MM" of today
  resolvedPeriod?: string | null; // the single period this upload will be stored under
  existingBatchPeriods?: string[]; // periods already imported for THIS distributor
  priorPeriodTotals?: PriorPeriodTotals | null; // most recent earlier batch's totals
};

// ── Tunable thresholds (named so the rationale is explicit and the tests pin them) ──
const SAMPLE_LIMIT = 12;
const LOW_RECOGNITION_RATE = 0.85;
const HIGH_BLANK_KEY_RATE = 0.2;
const HIGH_EXCLUDED_RATE = 0.3;
const STALE_PERIOD_MONTHS = 24;
const RETURNS_DOMINATE_RATE = 0.25;
const BLANK_DATE_ERROR_RATE = 0.5;
const CODE_FALLBACK_RATE = 0.15; // > 15% of products matched by code, not name → info
const ANOMALY_SPIKE_FACTOR = 3;
const ANOMALY_COLLAPSE_FACTOR = 1 / 3;
const ANOMALY_VALUE_FLOOR = 1000;
const ANOMALY_QTY_FLOOR = 100;

const VALID_PERIOD = /^\d{4}-\d{2}$/;

function periodIndex(period: string | null | undefined): number | null {
  if (!period || !VALID_PERIOD.test(period)) return null;
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7));
}

function sampleRows(rows: { rawRowNumber: number }[]): number[] {
  return rows.slice(0, SAMPLE_LIMIT).map((r) => r.rawRowNumber);
}

function pct(n: number): number {
  return Math.round(n * 100);
}

// Pure: returns the full strict-validation report for a coded upload.
export function validateSalesOpsUpload(result: NormalizeResult, ctx: SalesOpsValidationContext): ValidationReport {
  const findings: ValidationFinding[] = [];
  const coded = result.coded;
  const s = result.summary;
  // Office gate is caller-supplied, but derive it defensively from the coded data too so a forgotten
  // ctx flag can never falsely BLOCK a valid Office upload (one pivot row → many slices).
  const isOffice = Boolean(ctx.isOfficeAllocation)
    || result.distributorCode === OFFICE_DISTRIBUTOR_CODE
    || coded.some((r) => r.distributorCode === OFFICE_DISTRIBUTOR_CODE);
  const add = (f: ValidationFinding) => findings.push(f);

  // ── Structural integrity: no-silent-loss reconcile (row strategies only) ───────────────────────
  // Office maps one pivot row → many slices, so a row-count reconcile does not apply (it uses unit
  // reconciliation via office_allocation_residual instead).
  if (!isOffice) {
    const accounted = s.fullyCoded + s.excludedBonus + s.blankKeySkipped + result.exceptions.length;
    if (s.scannedDataRows !== accounted) {
      add({
        code: "rows_read_mismatch",
        severity: "error",
        title: "Rows read do not reconcile",
        detail: `The engine scanned ${s.scannedDataRows.toLocaleString()} data rows but only ${accounted.toLocaleString()} were accounted for (coded + excluded + blank + blocked). Importing could silently lose rows.`,
        count: Math.abs(s.scannedDataRows - accounted),
        sampleRows: [],
        fixHint: "This indicates an engine/profile defect — report the file and distributor; do not import.",
      });
    }
  }

  // ── Coverage / completeness ──────────────────────────────────────────────────────────────────
  if (coded.length === 0) {
    add({
      code: "no_coded_rows",
      severity: "error",
      title: "No sales rows could be coded",
      detail: "Not a single row in this sheet produced a coded sales line, so there is nothing to import.",
      count: 0,
      sampleRows: [],
      fixHint: "Confirm you picked the right distributor and uploaded the raw sales export. Map unknown products/customers, then re-analyze.",
    });
  }

  // Every readable row was a bonus/free-goods row → nothing real codes.
  if (!isOffice) {
    const readable = s.scannedDataRows - s.blankKeySkipped;
    if (readable > 0 && s.excludedBonus >= readable && s.fullyCoded === 0) {
      add({
        code: "all_rows_excluded",
        severity: "error",
        title: "Every readable row was excluded as bonus",
        detail: `All ${readable.toLocaleString()} readable row(s) were flagged as free goods and excluded, so nothing codes.`,
        count: s.excludedBonus,
        sampleRows: sampleRows(result.excluded),
        fixHint: "Confirm the bonus/free-unit column is mapped correctly, or that you uploaded the right sheet.",
      });
    }
  }

  // "Dark" blocked rows — a brick failure with no raw brick name AND no raw customer code. Nothing the
  // mapping UI can act on; the signature of a column mismatch (the profile reads the wrong columns).
  const darkRows = result.exceptions.filter((e) => (e.reason === "brick" || e.reason === "both") && !e.rawBrickName && !e.rawCustomerCode);
  if (darkRows.length > 0) {
    add({
      code: "dark_exceptions",
      severity: "error",
      title: "Unreadable rows (column mismatch)",
      detail: `${darkRows.length.toLocaleString()} blocked row(s) carry no brick name and no customer code — the signature of a wrong column mapping, so the file is being mis-read.`,
      count: darkRows.length,
      sampleRows: sampleRows(darkRows),
      fixHint: "Re-check the distributor template's brick/customer columns against this sheet's headers, then re-analyze.",
    });
  }

  if (s.scannedDataRows > 0 && coded.length > 0) {
    const denom = s.scannedDataRows - s.excludedBonus - s.blankKeySkipped; // rows that SHOULD have coded
    if (denom > 0) {
      const rate = s.fullyCoded / denom;
      if (rate < LOW_RECOGNITION_RATE) {
        add({
          code: "low_recognition_rate",
          severity: "warning",
          title: "Low recognition rate",
          detail: `Only ${pct(rate)}% of the rows that should have coded did (${s.fullyCoded.toLocaleString()} of ${denom.toLocaleString()}). The rest are blocked as unmapped.`,
          count: denom - s.fullyCoded,
          sampleRows: [],
          fixHint: "Most loss is unmapped products or customers. Map the distinct unknowns, then re-analyze.",
        });
      }
    }
  }

  if (!isOffice && s.scannedDataRows > 0 && s.blankKeySkipped / s.scannedDataRows > HIGH_BLANK_KEY_RATE) {
    add({
      code: "high_blank_customer",
      severity: "warning",
      title: "Many rows have no key",
      detail: `${s.blankKeySkipped.toLocaleString()} row(s) (${pct(s.blankKeySkipped / s.scannedDataRows)}%) were skipped for carrying no customer, brick, or product key — they will NOT be imported.`,
      count: s.blankKeySkipped,
      sampleRows: [],
      fixHint: "If these are real sales, the key column mapping is likely wrong — check the template. If they are summary rows, this is expected.",
    });
  }

  if (!isOffice && s.scannedDataRows > 0 && s.excludedBonus / s.scannedDataRows > HIGH_EXCLUDED_RATE) {
    add({
      code: "high_excluded",
      severity: "warning",
      title: "High share of excluded (bonus) rows",
      detail: `${s.excludedBonus.toLocaleString()} row(s) (${pct(s.excludedBonus / s.scannedDataRows)}%) were flagged as free goods and dropped. A spike can mean the bonus column is misread.`,
      count: s.excludedBonus,
      sampleRows: sampleRows(result.excluded),
      fixHint: "Review the bonus/free-unit column mapping for this distributor.",
    });
  }

  if (result.excluded.length > 0) {
    const units = result.excluded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    add({
      code: "excluded_units",
      severity: "info",
      title: "Excluded free units",
      detail: `${result.excluded.length.toLocaleString()} row(s) (${units.toLocaleString()} units) were excluded as bonus/free goods on purpose.`,
      count: result.excluded.length,
      sampleRows: sampleRows(result.excluded),
    });
  }

  // ── Product resolution policy: name-first health ───────────────────────────────────────────────
  if (!isOffice && s.productResolved > 0 && s.productByCodeFallback / s.productResolved > CODE_FALLBACK_RATE) {
    add({
      code: "name_first_fallback_to_code",
      severity: "info",
      title: "Products matched by code, not name",
      detail: `${s.productByCodeFallback.toLocaleString()} of ${s.productResolved.toLocaleString()} coded product(s) (${pct(s.productByCodeFallback / s.productResolved)}%) matched by the distributor code, not the product name. The rule is name-first; a high share means product-name aliases are missing.`,
      count: s.productByCodeFallback,
      sampleRows: [],
      fixHint: "Add product-name aliases for this distributor so products resolve by name as intended.",
    });
  }

  // ── Quantity & value data quality (coded rows) ──────────────────────────────────────────────────
  const negativeQty = coded.filter((r) => r.qty < 0);
  if (negativeQty.length > 0) {
    const negSum = Math.abs(negativeQty.reduce((sum, r) => sum + r.qty, 0));
    const posSum = coded.reduce((sum, r) => (r.qty > 0 ? sum + r.qty : sum), 0);
    const dominate = posSum > 0 && negSum / posSum > RETURNS_DOMINATE_RATE;
    add({
      code: "negative_qty",
      severity: dominate ? "warning" : "info",
      title: dominate ? "Returns dominate this batch" : "Negative quantities (returns)",
      detail: dominate
        ? `${negativeQty.length.toLocaleString()} row(s) have a negative quantity and they offset ${pct(negSum / posSum)}% of the positive units — unusually high for a sales month.`
        : `${negativeQty.length.toLocaleString()} row(s) have a negative quantity — usually returns or credit notes, which are kept.`,
      count: negativeQty.length,
      sampleRows: sampleRows(negativeQty),
      fixHint: "Confirm these are genuine returns. If a sale was entered with a stray minus sign, fix the source cell and re-upload.",
    });
  }

  const zeroQty = coded.filter((r) => r.qty === 0);
  if (zeroQty.length > 0) {
    add({
      code: "zero_qty",
      severity: "warning",
      title: "Zero-quantity rows",
      detail: `${zeroQty.length.toLocaleString()} row(s) have a quantity of zero — they add nothing to sales and may be placeholders or a non-numeric quantity cell read as zero.`,
      count: zeroQty.length,
      sampleRows: sampleRows(zeroQty),
      fixHint: "Check the quantity column for these rows in the source sheet.",
    });
  }

  const zeroValueWithQty = coded.filter((r) => r.qty > 0 && r.value === 0);
  if (zeroValueWithQty.length > 0) {
    add({
      code: "zero_value_with_qty",
      severity: "warning",
      title: "Sold units with zero value",
      detail: `${zeroValueWithQty.length.toLocaleString()} row(s) have a positive quantity but a value of zero — the product is missing a factory price.`,
      count: zeroValueWithQty.length,
      sampleRows: sampleRows(zeroValueWithQty),
      fixHint: "Add the product's factory price in the product master, then re-analyze.",
    });
  }

  // Entire batch values to zero while units exist — catastrophic (whole price set missing).
  if (coded.length > 0) {
    const totalValue = coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
    const totalQty = coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    if (Math.abs(totalValue) < 1e-9 && Math.abs(totalQty) > 1e-9) {
      add({
        code: "all_zero_value_batch",
        severity: "warning",
        title: "Whole batch has zero value",
        detail: `Every coded row resolved but the total value is zero while ${totalQty.toLocaleString()} units were sold. The product factory prices are missing.`,
        count: coded.length,
        sampleRows: [],
        fixHint: "Populate factory prices for these products in the product master before importing.",
      });
    }
  }

  // Fractional quantities — a decimal/separator misread (NOT meaningful for Office, which allocates
  // fractional units by design).
  if (!isOffice) {
    const fractionalQty = coded.filter((r) => Number.isFinite(r.qty) && r.qty !== 0 && !Number.isInteger(r.qty));
    if (fractionalQty.length > 0) {
      add({
        code: "non_integer_qty",
        severity: "info",
        title: "Fractional quantities",
        detail: `${fractionalQty.length.toLocaleString()} row(s) have a non-whole quantity — usually a decimal/thousands-separator misread or a value placed in the quantity column.`,
        count: fractionalQty.length,
        sampleRows: sampleRows(fractionalQty),
        fixHint: "Check the source for a comma/period separator issue.",
      });
    }
  }

  // ── Duplicates / double-count ────────────────────────────────────────────────────────────────
  // Key includes brickId (Office slices share product/qty but differ by brick — avoids false dupes),
  // and drops discount (no discount field in this model).
  const seen = new Set<string>();
  const duplicateRows: { rawRowNumber: number }[] = [];
  for (const r of coded) {
    const key = `${r.clientCode ?? r.clientName ?? ""}|${r.productCode}|${r.brickId}|${r.invoiceDate}|${r.qty}|${r.value}`;
    if (seen.has(key)) duplicateRows.push({ rawRowNumber: r.rawRowNumber });
    else seen.add(key);
  }
  if (!isOffice && duplicateRows.length > 0) {
    add({
      code: "duplicate_rows",
      severity: "warning",
      title: "Duplicate sales lines",
      detail: `${duplicateRows.length.toLocaleString()} redundant row(s) repeat an earlier line exactly (same customer, product, brick, month, quantity and value). These extra copies would double-count sales — the first occurrence of each is kept.`,
      count: duplicateRows.length,
      sampleRows: sampleRows(duplicateRows),
      fixHint: "Confirm these are genuinely separate invoices; otherwise remove the duplicate rows from the source sheet.",
    });
  }

  // ── Master-data / geography consistency ────────────────────────────────────────────────────────
  const unknownLine = coded.filter((r) => !r.officialLine || r.officialLine.trim().toLowerCase() === "unknown");
  if (unknownLine.length > 0) {
    const products = new Set(unknownLine.map((r) => r.productCode));
    add({
      code: "unknown_official_line",
      severity: "warning",
      title: "Products with no product line",
      detail: `${unknownLine.length.toLocaleString()} row(s) across ${products.size.toLocaleString()} product(s) have no product line, so every line-level report will under-count them.`,
      count: unknownLine.length,
      sampleRows: sampleRows(unknownLine),
      fixHint: "Set the product line for these product codes in the product master, then re-analyze.",
    });
  }

  // Same customer code resolving to more than one brick within the batch → a wrong customer→brick
  // resolution (often the leading-zero/canonical fallback grabbing a different brick).
  const brickByCustomer = new Map<string, Set<string>>();
  const customerRows = new Map<string, { rawRowNumber: number }[]>();
  for (const r of coded) {
    if (!r.clientCode || !r.brickId) continue;
    if (!brickByCustomer.has(r.clientCode)) {
      brickByCustomer.set(r.clientCode, new Set());
      customerRows.set(r.clientCode, []);
    }
    brickByCustomer.get(r.clientCode)!.add(r.brickId);
    customerRows.get(r.clientCode)!.push({ rawRowNumber: r.rawRowNumber });
  }
  const conflictedCustomers = [...brickByCustomer.entries()].filter(([, bricks]) => bricks.size > 1);
  if (conflictedCustomers.length > 0) {
    const rows = conflictedCustomers.flatMap(([code]) => customerRows.get(code) ?? []);
    add({
      code: "customer_inconsistent_brick",
      severity: "warning",
      title: "Customer mapped to multiple bricks",
      detail: `${conflictedCustomers.length.toLocaleString()} customer code(s) resolved to more than one brick in this batch — at least one mapping is wrong (often a leading-zero fallback).`,
      count: conflictedCustomers.length,
      sampleRows: sampleRows(rows),
      fixHint: "Fix the customer→brick mapping so each customer points at a single brick; re-analyze.",
    });
  }

  // Same brick resolving to conflicting region/area → the geography master itself is inconsistent.
  const regionByBrick = new Map<string, Set<string>>();
  const brickRows = new Map<string, { rawRowNumber: number }[]>();
  for (const r of coded) {
    if (!r.brickId) continue;
    if (!regionByBrick.has(r.brickId)) {
      regionByBrick.set(r.brickId, new Set());
      brickRows.set(r.brickId, []);
    }
    regionByBrick.get(r.brickId)!.add(`${r.regionCode}|${r.areaCode}`);
    brickRows.get(r.brickId)!.push({ rawRowNumber: r.rawRowNumber });
  }
  const conflictedBricks = [...regionByBrick.entries()].filter(([, geos]) => geos.size > 1);
  if (conflictedBricks.length > 0) {
    const rows = conflictedBricks.flatMap(([id]) => brickRows.get(id) ?? []);
    add({
      code: "brick_to_region_inconsistent",
      severity: "error",
      title: "Brick maps to conflicting regions",
      detail: `${conflictedBricks.length.toLocaleString()} brick(s) resolved to more than one region/area in this batch — the geography master is internally inconsistent and would corrupt every regional rollup.`,
      count: conflictedBricks.length,
      sampleRows: sampleRows(rows),
      fixHint: "Repair the brick→area→region hierarchy in the geography master so each brick maps to one region/area; re-analyze.",
    });
  }

  // Coded row with no geography at all (should be impossible — resolveBrick returns null → exception).
  const noGeography = coded.filter((r) => !r.brickId && !r.areaCode && !r.regionCode);
  if (noGeography.length > 0) {
    add({
      code: "blank_geography",
      severity: "error",
      title: "Coded rows with no geography",
      detail: `${noGeography.length.toLocaleString()} coded row(s) have no brick, area, or region — they would import with no geography and pollute every regional total.`,
      count: noGeography.length,
      sampleRows: sampleRows(noGeography),
      fixHint: "Investigate these rows (a geography-master gap); map their brick/customer to a valid brick or region and re-analyze.",
    });
  }

  // Brick-less rows (region/area only). Expected for region-only distributors and Office NATIONAL.
  if (!ctx.regionOnly && !isOffice) {
    const brickless = coded.filter((r) => !r.brickId && (r.regionCode || r.areaCode));
    if (brickless.length > 0) {
      add({
        code: "geography_brick_missing",
        severity: "warning",
        title: "Rows resolved to region/area only",
        detail: `${brickless.length.toLocaleString()} coded row(s) resolved to a region/area but no brick, so brick-level heatmaps and rollups will miss them.`,
        count: brickless.length,
        sampleRows: sampleRows(brickless),
        fixHint: "Map the affected customers/territories down to a specific brick for complete brick-level reporting.",
      });
    }
  }

  // Display label degraded to the bare code (master name missing). Cosmetic — info.
  const labelMissing = coded.filter((r) => r.productName && r.productCode && r.productName.trim().toLowerCase() === r.productCode.trim().toLowerCase());
  if (labelMissing.length > 0) {
    const products = new Set(labelMissing.map((r) => r.productCode));
    add({
      code: "master_label_missing",
      severity: "info",
      title: "Product name missing (shows the code)",
      detail: `${products.size.toLocaleString()} product(s) have no human-readable name, so reports show the raw code. Totals are unaffected.`,
      count: labelMissing.length,
      sampleRows: sampleRows(labelMissing),
      fixHint: "Add a product name for these codes in the product master.",
    });
  }

  // ── Temporal ─────────────────────────────────────────────────────────────────────────────────
  const currentIdx = periodIndex(ctx.currentPeriod);
  if (currentIdx != null) {
    const future = coded.filter((r) => {
      const idx = periodIndex(r.invoiceDate);
      return idx != null && idx > currentIdx;
    });
    if (future.length > 0) {
      add({
        code: "future_dated_rows",
        severity: "error",
        title: "Future-dated sales",
        detail: `${future.length.toLocaleString()} row(s) are dated in a month later than ${ctx.currentPeriod}. A sale cannot occur in a month that has not happened — usually a date-orientation misread (DD-MM vs MM-DD) or a year typo.`,
        count: future.length,
        sampleRows: sampleRows(future),
        fixHint: "Check the date column and the template's date format, then re-upload.",
      });
    }
    const resolvedIdx = periodIndex(ctx.resolvedPeriod);
    if (resolvedIdx != null && resolvedIdx > currentIdx && coded.every((r) => periodIndex(r.invoiceDate) == null)) {
      add({
        code: "future_period",
        severity: "warning",
        title: "Future upload period",
        detail: `The chosen period ${ctx.resolvedPeriod} is in the future.`,
        count: 1,
        sampleRows: [],
        fixHint: "Pick the correct month before importing.",
      });
    }
    if (resolvedIdx != null && currentIdx - resolvedIdx > STALE_PERIOD_MONTHS) {
      add({
        code: "stale_period",
        severity: "info",
        title: "Old backfill period",
        detail: `The chosen period ${ctx.resolvedPeriod} is more than ${STALE_PERIOD_MONTHS} months old — watch for a wrong-year typo.`,
        count: 1,
        sampleRows: [],
        fixHint: "Confirm this historical backfill is intended.",
      });
    }
  }

  // Coded rows with no parseable date — only when the template HAS a date column.
  if (ctx.hasDateColumn && coded.length > 0) {
    const blankDate = coded.filter((r) => !r.invoiceDate);
    if (blankDate.length > 0) {
      const allBlank = blankDate.length / coded.length > BLANK_DATE_ERROR_RATE;
      add({
        code: "blank_invoice_date",
        severity: allBlank ? "error" : "warning",
        title: "Coded rows with no date",
        detail: `${blankDate.length.toLocaleString()} coded row(s) have no parseable invoice date${allBlank ? " — the date column is likely unmapped or malformed" : ""}, so their sales would land in no month.`,
        count: blankDate.length,
        sampleRows: sampleRows(blankDate),
        fixHint: "Check the template's date column and date format match this sheet, then re-upload.",
      });
    }
  }

  // ── Office allocation residual: units that could not be placed on a brick (fell to NATIONAL) ────
  if (isOffice && typeof ctx.officeNationalUnits === "number" && Math.abs(ctx.officeNationalUnits) > 1e-6) {
    add({
      code: "office_allocation_residual",
      severity: "warning",
      title: "Office units not placed on a brick",
      detail: `${Math.abs(ctx.officeNationalUnits).toLocaleString()} office unit(s) could not be placed on a brick and went to the National bucket — the contribution base (other channels' sales) may be incomplete for this period.`,
      count: 1,
      sampleRows: [],
      fixHint: "Confirm other channels' sales for this period are imported first (they provide the allocation shares).",
    });
  }

  // ── Re-upload / replace (double-count prevention) ──────────────────────────────────────────────
  if (ctx.resolvedPeriod && (ctx.existingBatchPeriods ?? []).includes(ctx.resolvedPeriod)) {
    add({
      code: "period_replace",
      severity: "warning",
      title: "This period is already imported",
      detail: `A batch for ${ctx.resolvedPeriod} already exists for this distributor. Importing REPLACES it — the previous upload for this month is discarded (no double-count). If this file is partial, the month's totals will shrink.`,
      count: 1,
      sampleRows: [],
      fixHint: "This is expected for a corrected re-upload. Acknowledge to replace. If you meant to ADD to the month, stop — this overwrites, it does not merge.",
    });
  }

  // ── Cross-batch anomaly vs the previous period ─────────────────────────────────────────────────
  if (ctx.priorPeriodTotals && coded.length > 0) {
    const prior = ctx.priorPeriodTotals;
    const curVal = coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
    const curQty = coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    if (curVal > 0 && prior.totalValue >= ANOMALY_VALUE_FLOOR) {
      const ratio = curVal / prior.totalValue;
      if (ratio >= ANOMALY_SPIKE_FACTOR || ratio <= ANOMALY_COLLAPSE_FACTOR) {
        add({
          code: ratio >= ANOMALY_SPIKE_FACTOR ? "value_spike_vs_prior" : "value_collapse_vs_prior",
          severity: "warning",
          title: ratio >= ANOMALY_SPIKE_FACTOR ? "Total value much higher than last period" : "Total value much lower than last period",
          detail: `This upload's total value is ${ratio >= 1 ? `${ratio.toFixed(1)}x` : `${pct(ratio)}% of`} ${prior.period} (${Math.round(prior.totalValue).toLocaleString()}). A large swing can mean a pasted block, a wrong month, or a price problem.`,
          count: 1,
          sampleRows: [],
          fixHint: "Confirm the period and that the file was not pasted twice or partially exported. Acknowledge a genuine promo/slow month.",
        });
      }
    }
    if (curQty > 0 && prior.totalQty >= ANOMALY_QTY_FLOOR) {
      const qtyRatio = curQty / prior.totalQty;
      if (qtyRatio >= ANOMALY_SPIKE_FACTOR || qtyRatio <= ANOMALY_COLLAPSE_FACTOR) {
        add({
          code: "qty_anomaly_vs_prior",
          severity: "warning",
          title: "Total quantity much different from last period",
          detail: `This upload's unit total is ${qtyRatio >= 1 ? `${qtyRatio.toFixed(1)}x` : `${pct(qtyRatio)}% of`} ${prior.period}. A qty/value divergence points to a price or unit problem rather than a volume change.`,
          count: 1,
          sampleRows: [],
          fixHint: "Compare unit totals with the distributor's expectation; verify the quantity column and the period.",
        });
      }
    }
  }

  // ── Always-on coverage summary ─────────────────────────────────────────────────────────────────
  if (s.scannedDataRows > 0) {
    const denom = Math.max(1, s.scannedDataRows - s.excludedBonus - s.blankKeySkipped);
    add({
      code: "recognition_coverage_summary",
      severity: "info",
      title: "Recognition coverage",
      detail: `${s.fullyCoded.toLocaleString()} coded · ${result.exceptions.length.toLocaleString()} blocked · ${s.excludedBonus.toLocaleString()} excluded · ${s.blankKeySkipped.toLocaleString()} blank of ${s.scannedDataRows.toLocaleString()} rows (${pct(s.fullyCoded / denom)}% of expected rows coded).`,
      count: s.fullyCoded,
      sampleRows: [],
    });
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  return { ok: errorCount === 0, errorCount, warningCount, infoCount, findings };
}
