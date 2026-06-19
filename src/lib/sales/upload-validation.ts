import type { NormalizeResult } from "@/lib/sales/normalizer/types";

// ── Strict post-analyze validation ─────────────────────────────────────────────────────────────
// After the recognizer codes a raw distributor sheet (analyze), this layer runs EVERY data-quality
// check that can be computed from the coded rows + batch context, and produces one structured
// report. The SAME function runs at commit (server-side), so analyze and commit can never disagree
// (the prime directive). It is pure — the async caller assembles the context (price map, existing
// periods, current month, prior-period totals) and passes it in — so it stays fully unit-testable.
//
// Severity model:
//   "error"   → blocks import (data is broken / nothing to import). Cannot be acknowledged away.
//   "warning" → import allowed only after the user explicitly acknowledges (the "strict" gate).
//   "info"    → advisory; never blocks.
//
// The catalog was vetted by an adversarial design review against the real engine. Notes baked in:
//   • Unmapped product/brick rows (exceptions), period missing/multi, header validation and
//     coded-sheet rejection are gated by the upload flow itself and are NOT duplicated here — this
//     report covers the quality of the rows that DID code plus batch-level context.
//   • Date-aware checks are guarded by ctx.hasDateColumn so a legitimately date-less pivot (CP, period
//     from the picker) never trips "missing date" findings.

export type ValidationSeverity = "error" | "warning" | "info";

export type ValidationFinding = {
  code: string;
  severity: ValidationSeverity;
  title: string;
  detail: string;
  count: number; // affected rows / entities, or 1 for a batch-level finding
  sampleRows: number[]; // up to SAMPLE_LIMIT raw row numbers for drill-down
  fixHint?: string;
};

export type ValidationReport = {
  ok: boolean; // no error-severity findings (warnings/info do not clear ok=false)
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: ValidationFinding[];
};

export type PriorPeriodTotals = { period: string; totalValue: number; totalQty: number };

export type ValidationContext = {
  valueSource: "recompute" | "sheet";
  hasDateColumn: boolean; // false → the profile carries no date (period from the picker); skip date checks
  regionOnly?: boolean; // true → resolving to region/area only is expected, not a gap
  priceByProductCode?: Map<string, number>; // master factory price (sheet unit-price sanity)
  currentPeriod?: string; // "YYYY-MM" of today (assembled server-side)
  resolvedPeriod?: string | null; // the single period this upload will be stored under
  existingBatchPeriods?: string[]; // periods already imported for THIS distributor
  priorPeriodTotals?: PriorPeriodTotals | null; // most recent earlier batch's totals (anomaly checks)
};

// ── Tunable thresholds (named so the rationale is explicit and the tests pin them) ──
const SAMPLE_LIMIT = 12;
const LOW_RECOGNITION_RATE = 0.85; // < 85% of the rows that SHOULD code → quality warning
const HIGH_BLANK_CUSTOMER_RATE = 0.2; // > 20% of rows skipped for no customer → warning
const HIGH_IGNORED_RATE = 0.3; // > 30% of rows intentionally ignored → warning
const STALE_PERIOD_MONTHS = 24; // backfill older than 2 years → info
const RETURNS_DOMINATE_RATE = 0.25; // returns > 25% of positive qty → escalate to warning
const UNIT_PRICE_HIGH_FACTOR = 3; // sheet unit price > 3x master price → warning
const UNIT_PRICE_LOW_FACTOR = 1 / 3; // sheet unit price < 1/3 master price → warning
const BLANK_DATE_ERROR_RATE = 0.5; // > 50% of coded rows with no parseable date → escalate to error
const ANOMALY_SPIKE_FACTOR = 3; // current >= 3x prior → spike
const ANOMALY_COLLAPSE_FACTOR = 1 / 3; // current <= 1/3 prior → collapse
const ANOMALY_VALUE_FLOOR = 1000; // ignore tiny prior value baselines
const ANOMALY_QTY_FLOOR = 100; // ignore tiny prior qty baselines

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
export function validateNormalizedUpload(result: NormalizeResult, ctx: ValidationContext): ValidationReport {
  const findings: ValidationFinding[] = [];
  const coded = result.coded;
  const s = result.summary;
  const add = (f: ValidationFinding) => findings.push(f);

  // ── Structural integrity ───────────────────────────────────────────────────────────────────────
  // Real no-silent-loss guard: every non-empty row the engine scanned must land in exactly one
  // bucket. (buildReconciliation compares against summary.totalRows, but totalRows is DEFINED as that
  // sum, so it can never fail. scannedDataRows is an independent physical counter.)
  if (typeof s.scannedDataRows === "number") {
    const accounted = s.fullyCoded + s.ignored + s.blankCustomerSkipped + result.exceptions.length;
    if (s.scannedDataRows !== accounted) {
      add({
        code: "rows_read_mismatch",
        severity: "error",
        title: "Rows read do not reconcile",
        detail: `The engine scanned ${s.scannedDataRows.toLocaleString()} data rows but only ${accounted.toLocaleString()} were accounted for (coded + ignored + blank + blocked). Importing could silently lose rows.`,
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
      fixHint: "Confirm you picked the right distributor and uploaded the raw sales export. Map unknown products/customers in Mapping Database, then re-analyze.",
    });
  }

  // Every readable row was intentionally ignored — almost always a real product mass-mapped to IGNORE.
  const readable = s.totalRows - s.blankCustomerSkipped;
  if (readable > 0 && s.ignored >= readable && s.fullyCoded === 0) {
    add({
      code: "all_rows_ignored",
      severity: "error",
      title: "Every readable row was ignored",
      detail: `All ${readable.toLocaleString()} readable row(s) mapped to "ignore", so nothing codes. A real product was likely mass-mapped to IGNORE.`,
      count: s.ignored,
      sampleRows: sampleRows(result.ignoredRows),
      fixHint: "Review this distributor's IGNORE mappings in Mapping Database, or confirm you uploaded the right sheet.",
    });
  }

  // "Dark" blocked rows — a brick failure with no raw territory AND no raw customer code. There is
  // nothing the mapping UI can act on; it is the signature of a column mismatch (the profile reads the
  // wrong columns), so the whole file is being mis-parsed.
  const darkRows = result.exceptions.filter((e) => (e.reason === "brick" || e.reason === "both") && !e.rawTerritory && !e.rawCustomerCode);
  if (darkRows.length > 0) {
    add({
      code: "dark_exceptions",
      severity: "error",
      title: "Unreadable rows (column mismatch)",
      detail: `${darkRows.length.toLocaleString()} blocked row(s) carry no territory and no customer code — the signature of a wrong column mapping, so the file is being mis-read.`,
      count: darkRows.length,
      sampleRows: sampleRows(darkRows),
      fixHint: "Re-check the distributor profile's territory/customer columns against this sheet's headers, or confirm the export format, then re-analyze.",
    });
  }

  if (s.totalRows > 0 && coded.length > 0) {
    const denom = s.totalRows - s.ignored - s.blankCustomerSkipped; // rows that SHOULD have coded
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
          fixHint: "Open Missing Data: most loss is unmapped products or customers. Map the distinct unknowns, then re-analyze.",
        });
      }
    }
  }

  if (s.totalRows > 0 && s.blankCustomerSkipped / s.totalRows > HIGH_BLANK_CUSTOMER_RATE) {
    add({
      code: "high_blank_customer",
      severity: "warning",
      title: "Many rows have no customer",
      detail: `${s.blankCustomerSkipped.toLocaleString()} row(s) (${pct(s.blankCustomerSkipped / s.totalRows)}%) were skipped for carrying no customer, territory, or brick — they will NOT be imported.`,
      count: s.blankCustomerSkipped,
      sampleRows: sampleRows(result.blankCustomerRows),
      fixHint: "If these are real sales, the customer/territory column mapping is likely wrong — check the profile. If they are summary rows, this is expected.",
    });
  }

  if (s.totalRows > 0 && s.ignored / s.totalRows > HIGH_IGNORED_RATE) {
    add({
      code: "high_ignored",
      severity: "warning",
      title: "High share of ignored rows",
      detail: `${s.ignored.toLocaleString()} row(s) (${pct(s.ignored / s.totalRows)}%) mapped to "ignore" and were dropped on purpose. A spike can mean a real product was wrongly set to IGNORE.`,
      count: s.ignored,
      sampleRows: sampleRows(result.ignoredRows),
      fixHint: "Review the distinct ignored products; if any is a real Phoenix product, fix its mapping in Mapping Database.",
    });
  }

  if (result.ignoredRows.length > 0) {
    const units = result.ignoredRows.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    add({
      code: "ignored_units",
      severity: "info",
      title: "Intentionally excluded items",
      detail: `${result.ignoredRows.length.toLocaleString()} row(s) (${units.toLocaleString()} units) are mapped as "ignore" and excluded from sales on purpose.`,
      count: result.ignoredRows.length,
      sampleRows: sampleRows(result.ignoredRows),
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

  // Negative value NOT explained by a negative qty (a return). For recompute this means discount > 1.
  const negativeValue = coded.filter((r) => r.value < 0 && r.qty >= 0);
  if (negativeValue.length > 0) {
    add({
      code: "negative_value",
      severity: "warning",
      title: "Negative value on a non-return line",
      detail: `${negativeValue.length.toLocaleString()} row(s) have a negative value while quantity is not negative — usually a discount above 100% (recompute) or a bad sheet value.`,
      count: negativeValue.length,
      sampleRows: sampleRows(negativeValue),
      fixHint: "Fix the discount or value cell. A genuine credit should normally carry a negative quantity too.",
    });
  }

  const zeroValueWithQty = coded.filter((r) => r.qty > 0 && r.value === 0);
  if (zeroValueWithQty.length > 0) {
    add({
      code: "zero_value_with_qty",
      severity: "warning",
      title: "Sold units with zero value",
      detail: `${zeroValueWithQty.length.toLocaleString()} row(s) have a positive quantity but a value of zero — usually a missing factory price or a 100% discount.`,
      count: zeroValueWithQty.length,
      sampleRows: sampleRows(zeroValueWithQty),
      fixHint: ctx.valueSource === "sheet"
        ? "Check the value column in the source sheet for these rows."
        : "Add the product's factory price in Master Data & Profiles, and check the discount column.",
    });
  }

  // Entire batch values to zero while units exist — catastrophic (missing whole price set / unmapped
  // value column). Warning (not error) so a deliberately-unpriced new catalog can be acknowledged.
  if (coded.length > 0) {
    const totalValue = coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
    const totalQty = coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    if (Math.abs(totalValue) < 1e-9 && Math.abs(totalQty) > 1e-9) {
      add({
        code: "all_zero_value_batch",
        severity: "warning",
        title: "Whole batch has zero value",
        detail: `Every coded row resolved but the total value is zero while ${totalQty.toLocaleString()} units were sold. The product prices (recompute) or the value column (sheet) are missing.`,
        count: coded.length,
        sampleRows: [],
        fixHint: ctx.valueSource === "sheet"
          ? "Confirm the value column is mapped in the distributor profile."
          : "Populate factory prices for these products in Master Data & Profiles before importing.",
      });
    }
  }

  const badDiscount = coded.filter((r) => r.discount < 0 || r.discount > 1);
  if (badDiscount.length > 0) {
    add({
      code: "discount_out_of_range",
      severity: "warning",
      title: "Discount outside 0–100%",
      detail: `${badDiscount.length.toLocaleString()} row(s) have a discount below 0% or above 100%, which distorts the computed value (a discount above 100% flips it negative).`,
      count: badDiscount.length,
      sampleRows: sampleRows(badDiscount),
      fixHint: "Fix the discount column in the source sheet (50 and 0.5 both mean 50%; 150 or a negative is a typo).",
    });
  }

  const fractionalQty = coded.filter((r) => Number.isFinite(r.qty) && r.qty !== 0 && !Number.isInteger(r.qty));
  if (fractionalQty.length > 0) {
    add({
      code: "non_integer_qty",
      severity: "info",
      title: "Fractional quantities",
      detail: `${fractionalQty.length.toLocaleString()} row(s) have a non-whole quantity — usually a decimal/thousands-separator misread or a value placed in the quantity column.`,
      count: fractionalQty.length,
      sampleRows: sampleRows(fractionalQty),
      fixHint: "Check the source for a comma/period separator issue. Leave genuinely fractional product lines as-is.",
    });
  }

  // Unit-price sanity for sheet/Direct distributors (recompute derives value from the master price, so
  // its unit price is correct by construction and not checked here).
  if (ctx.valueSource === "sheet" && ctx.priceByProductCode && ctx.priceByProductCode.size > 0) {
    const extreme = coded.filter((r) => {
      if (r.qty <= 0 || r.value <= 0) return false;
      // A 100%+ discount makes the net divisor ~0 (a known degenerate handled by zero_value/discount
      // checks) — skip it here so the clamp below never manufactures a fake "extreme" unit price.
      if (r.discount >= 1) return false;
      const price = ctx.priceByProductCode?.get(r.productCode);
      if (!price || price <= 0) return false;
      // Clamp the discount to [0, 0.999] purely to avoid divide-by-zero; rows at/above 100% are
      // already excluded above, and negative discounts are handled by discount_out_of_range.
      const unit = r.value / (r.qty * (1 - Math.min(Math.max(r.discount, 0), 0.999)));
      return unit > price * UNIT_PRICE_HIGH_FACTOR || unit < price * UNIT_PRICE_LOW_FACTOR;
    });
    if (extreme.length > 0) {
      add({
        code: "extreme_unit_price",
        severity: "warning",
        title: "Unit price far from master price",
        detail: `${extreme.length.toLocaleString()} row(s) have a per-unit value far above or below the product's master factory price — a possible units/value column swap, missing separator, or wrong product.`,
        count: extreme.length,
        sampleRows: sampleRows(extreme),
        fixHint: "Spot-check these rows against the distributor's invoice; verify the value and quantity columns. Acknowledge genuine tender pricing.",
      });
    }
  }

  // ── Duplicates / double-count ────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const duplicateRows: { rawRowNumber: number }[] = [];
  for (const r of coded) {
    const key = `${r.clientCode ?? r.clientName ?? ""}|${r.productCode}|${r.invoiceDate}|${r.qty}|${r.value}|${r.discount}`;
    if (seen.has(key)) duplicateRows.push({ rawRowNumber: r.rawRowNumber });
    else seen.add(key);
  }
  if (duplicateRows.length > 0) {
    add({
      code: "duplicate_rows",
      severity: "warning",
      title: "Duplicate sales lines",
      detail: `${duplicateRows.length.toLocaleString()} redundant row(s) repeat an earlier line exactly (same customer, product, month, quantity, value and discount). These extra copies would double-count sales — the first occurrence of each is kept.`,
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
    if (!brickByCustomer.has(r.clientCode)) { brickByCustomer.set(r.clientCode, new Set()); customerRows.set(r.clientCode, []); }
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
    if (!regionByBrick.has(r.brickId)) { regionByBrick.set(r.brickId, new Set()); brickRows.set(r.brickId, []); }
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
      fixHint: "Investigate these rows (a geography-master gap); map their territory/customer to a valid brick or region and re-analyze.",
    });
  }

  // Brick-less rows (region/area only). Expected for region-only distributors → not flagged there.
  if (!ctx.regionOnly) {
    const brickless = coded.filter((r) => !r.brickId && (r.regionCode || r.areaCode));
    if (brickless.length > 0) {
      add({
        code: "geography_brick_missing",
        severity: "warning",
        title: "Rows resolved to region/area only",
        detail: `${brickless.length.toLocaleString()} coded row(s) resolved to a region/area but no brick, so brick-level heatmaps and rollups will miss them.`,
        count: brickless.length,
        sampleRows: sampleRows(brickless),
        fixHint: "Map the affected customers/territories down to a specific brick in Mapping Database for complete brick-level reporting.",
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
        fixHint: "Check the date column and the distributor profile's dateFormat, then re-upload.",
      });
    }
    const resolvedIdx = periodIndex(ctx.resolvedPeriod);
    // Date-less pivot with a future period picked (no per-row dates to flag above).
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

  // Coded rows with no parseable date — only meaningful when the profile HAS a date column (a date-less
  // pivot like CP legitimately has blank invoiceDate and takes its period from the picker).
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
        fixHint: "Check the profile's date column and date format match this sheet, and fix unparseable date cells, then re-upload.",
      });
    }
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

  // ── Cross-batch anomaly vs the previous period (totals are stored on the batch) ──────────────────
  if (ctx.priorPeriodTotals && coded.length > 0) {
    const prior = ctx.priorPeriodTotals;
    const curVal = coded.reduce((sum, r) => sum + (Number.isFinite(r.value) ? r.value : 0), 0);
    const curQty = coded.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    // Only compare positive net totals: a negative/zero net (a pure-returns or unpriced month) is out
    // of anomaly scope — otherwise a negative ratio would always satisfy the "collapse" test.
    if (curVal > 0 && prior.totalValue >= ANOMALY_VALUE_FLOOR) {
      const ratio = curVal / prior.totalValue;
      if (ratio >= ANOMALY_SPIKE_FACTOR || ratio <= ANOMALY_COLLAPSE_FACTOR) {
        add({
          code: ratio >= ANOMALY_SPIKE_FACTOR ? "value_spike_vs_prior" : "value_collapse_vs_prior",
          severity: "warning",
          title: ratio >= ANOMALY_SPIKE_FACTOR ? "Total value much higher than last period" : "Total value much lower than last period",
          detail: `This upload's total value is ${ratio >= 1 ? `${ratio.toFixed(1)}x` : `${pct(ratio)}% of`} ${prior.period} (${Math.round(prior.totalValue).toLocaleString()}). A large swing can mean a pasted block, a wrong month, or a price/discount problem.`,
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

  // ── Always-on coverage summary (frames every other finding) ────────────────────────────────────
  if (s.totalRows > 0) {
    const denom = Math.max(1, s.totalRows - s.ignored - s.blankCustomerSkipped);
    add({
      code: "recognition_coverage_summary",
      severity: "info",
      title: "Recognition coverage",
      detail: `${s.fullyCoded.toLocaleString()} coded · ${result.exceptions.length.toLocaleString()} blocked · ${s.ignored.toLocaleString()} ignored · ${s.blankCustomerSkipped.toLocaleString()} blank of ${s.totalRows.toLocaleString()} rows (${pct(s.fullyCoded / denom)}% of expected rows coded).`,
      count: s.fullyCoded,
      sampleRows: [],
    });
  }

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  return { ok: errorCount === 0, errorCount, warningCount, infoCount, findings };
}
