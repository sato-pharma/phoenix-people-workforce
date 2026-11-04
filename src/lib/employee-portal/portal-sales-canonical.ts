// ─────────────────────────────────────────────────────────────────────────────
// The portal's sales rows, sourced from SoS Monthly Closing instead of sales_records.
//
// Every portal surface that shows a person's sales — the incentive tab, the MR hero, the
// 4-month trend, my-dashboard, Top Achievers — reaches them through fetchPortalSalesRecords,
// which read the legacy view `v_employee_portal_sales`. This module produces the SAME row
// shape from the canonical engine, so those surfaces move onto Rule #1's single source of
// truth without every consumer downstream being rewritten.
//
// Four things here are load-bearing and easy to get wrong:
//
//   1. ONE LOAD, THEN FILTER IN MEMORY. The engine answers a whole range in a single RPC,
//      and the caller needs the same rows twice — once for the people it asked about, once
//      for the seat-continuity pass. Loading per-person would turn one Atlantic round trip
//      into several for rows we already hold. loadCanonicalPortalSalesRows returns the whole
//      window; selectCanonicalRowsForHrIds narrows it for free.
//
//   2. ROWS ARE PRE-AGGREGATED per (rep, period, area, product). buildPortalSalesDashboardMetrics
//      (src/lib/sales/metrics.ts — the live builder; the similarly-named buildEmployeeSalesDashboard
//      in employee-portal/service.ts has no callers at all)
//      deduplicates targets by taking the MAX per (employee, territory, period, product) —
//      correct for the legacy view, where each territory emitted a Retail row carrying the
//      target and a Stores row carrying 0. Canonical rows have no such duplication, but
//      applyAchievementAreaMerges rewrites Fayoum/Beni Suef onto one area code WITHOUT
//      summing, so two rows can legitimately share a key. Handed over raw, MAX would keep
//      the larger target and silently DROP the other. Summing here first makes that dedupe
//      a no-op instead of a data loss.
//
//   3. A MONTH WITH NO DISTRIBUTOR UPLOAD IS EXCLUDED. August 2026 holds one direct order
//      (1,309.50 EGP) against a 17,508,935 EGP target. Emitting it as a data point puts a
//      0.0% month on the rep's own trend. `has_actual` cannot tell the two apart; the
//      distributor batch ledger can, and it is what /sales-vs-target already trusts.
//
//   4. THERE IS NO SALES TYPE HERE, so the sales-type filter is IGNORED rather than applied.
//      Applying it would match nothing and blank the page. See CANONICAL_SALES_TYPE.
// ─────────────────────────────────────────────────────────────────────────────

import { cache } from "react";

import { currentCairoDateParts } from "@/lib/i18n/format";
import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import { lineName, loadAreaNameMap, loadProductFamilyMap, loadProductNameMap } from "@/lib/sales/monthly-targets";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleased, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import {
  SALES_HISTORY_FLOOR,
  loadAchievementRange,
  loadUploadedPeriodsInRange,
} from "@/lib/sales/vs-target";

/** Structurally identical to the portal's PortalSalesNormalized, so consumers are unchanged. */
export type CanonicalPortalSalesRow = {
  hrId: string;
  managerHrId: string | null;
  family: string;
  line: string | null;
  month: number | null;
  period: string;
  product: string;
  /**
   * The product's CODE, upper-cased — `GU001`, `LA002`, … — carried alongside the display name.
   *
   * Added for the Pedia split incentive, which has to tell two Sato products from two outsource
   * ones (src/lib/incentives/pedia-split.ts). `product` above is a display NAME resolved through
   * loadProductNameMap and is editable; matching money rules on it would move a payout the day
   * somebody renames a label. The code is what the closing engine itself joins on, so it is the
   * only safe key for a rule that decides what a rep is paid.
   */
  productCode: string;
  salesType: string;
  salesUnits: number;
  salesValue: number;
  targetValue: number;
  territory: string;
  year: number | null;
};

/** The already-normalized filter bag resolveSalesFilterValues produces. */
export type CanonicalPortalSalesFilters = {
  family?: string;
  month?: number | null;
  period?: string;
  product?: string;
  products?: string[];
  territory?: string;
  year?: string;
  /** Line names AND their aliases — "CNS", "cns", "O-3", "anti infective", … */
  line?: string[];
};

/**
 * The canonical engine has no Retail/Stores split, so there is nothing honest to put here.
 *
 * Blank on purpose, and it has to stay blank: the portal builds its sales-type dropdown from
 * the records themselves and drops falsy values, so an empty string makes the filter offer no
 * options and never fire — which is the truth. A made-up token would put a control on screen
 * that silently discards half the data.
 */
const CANONICAL_SALES_TYPE = "";

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export type CanonicalPortalAggregate = {
  repHrId: string;
  dmHrId: string | null;
  lineCode: string | null;
  areaCode: string;
  productCode: string;
  period: string;
  salesUnits: number;
  salesValue: number;
  targetValue: number;
};

/**
 * Fold canonical rows into one aggregate per (rep, period, area, product). PURE.
 *
 * Rows for a month whose distributor upload has not landed are dropped, and rows the engine
 * could not attribute to an occupant belong to the area rather than to a person — crediting
 * them to whoever is nearby is exactly the error reconcileUnattributed exists to prevent.
 */
export function aggregateCanonicalPortalRows(
  rows: readonly AchievementRow[],
  uploadedPeriods: ReadonlySet<string>,
): CanonicalPortalAggregate[] {
  const byKey = new Map<string, CanonicalPortalAggregate>();
  for (const row of rows) {
    if (!uploadedPeriods.has(row.period)) continue;
    const repHrId = lower(row.repHrId);
    if (!repHrId) continue;
    const dmHrId = lower(row.dmHrId);

    const areaCode = upper(row.areaCode);
    const productCode = upper(row.productCode);
    const key = `${repHrId}|${row.period}|${areaCode}|${productCode}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.salesUnits += row.actualUnits;
      existing.salesValue += row.actualValue;
      existing.targetValue += row.targetValue ?? 0;
      continue;
    }
    byKey.set(key, {
      repHrId,
      dmHrId: dmHrId || null,
      lineCode: row.lineCode,
      areaCode,
      productCode,
      period: row.period,
      salesUnits: row.actualUnits,
      salesValue: row.actualValue,
      targetValue: row.targetValue ?? 0,
    });
  }
  return [...byKey.values()];
}

/**
 * Apply the portal's already-normalized filters. PURE.
 *
 * `line` arrives as a name plus its aliases ("CNS", "cns", "O-3"), matched case-insensitively
 * — the same reach the legacy `ilike` had. `salesType` is deliberately absent; see above.
 */
export function filterCanonicalPortalRows(
  rows: readonly CanonicalPortalSalesRow[],
  filters: CanonicalPortalSalesFilters,
): CanonicalPortalSalesRow[] {
  const lineNames = new Set((filters.line ?? []).map(lower).filter(Boolean));
  const products = new Set((filters.products ?? []).map(lower).filter(Boolean));
  return rows.filter((row) => {
    if (filters.period && row.period !== filters.period) return false;
    if (filters.month != null && row.month !== filters.month) return false;
    if (filters.year && String(row.year ?? "") !== String(filters.year)) return false;
    if (filters.family && lower(row.family) !== lower(filters.family)) return false;
    if (filters.product && lower(row.product) !== lower(filters.product)) return false;
    if (products.size > 0 && !products.has(lower(row.product))) return false;
    if (filters.territory && lower(row.territory) !== lower(filters.territory)) return false;
    if (lineNames.size > 0 && !lineNames.has(lower(row.line))) return false;
    return true;
  });
}

/**
 * Keep the rows belonging to these people. PURE.
 *
 * A row matches when the rep OR the DM is one of them — the same reach the legacy query had
 * with `hr_id.eq.X or manager_hr_id.eq.X`, so a manager still sees their reports' rows and
 * each row still carries the REP as its owner.
 */
export function selectCanonicalRowsForHrIds(
  rows: readonly CanonicalPortalSalesRow[],
  hrIds: readonly string[],
): CanonicalPortalSalesRow[] {
  const wanted = new Set(hrIds.map(lower).filter(Boolean));
  if (wanted.size === 0) return [];
  return rows.filter(
    (row) => wanted.has(lower(row.hrId)) || (row.managerHrId ? wanted.has(lower(row.managerHrId)) : false),
  );
}

/**
 * Every canonical portal row in the reportable window, for every rep. UNFILTERED.
 *
 * Five round trips: the achievement range, the upload ledger, and the three display-name maps.
 *
 * Memoized per request because the portal asks for the same window several times in one render
 * — Top Achievers alone calls once per line, and team ranking calls again. The rows are
 * company-wide and viewer-independent, so there is nothing scope-sensitive to leak; the
 * narrowing to a person happens after. React cache() is request-scoped, which is what
 * getEmployeePortalShellData in this same module already relies on.
 */
const loadAllCanonicalPortalSalesRows = cache(async (): Promise<CanonicalPortalSalesRow[]> => {
  const { year, month } = currentCairoDateParts();
  const to = `${year}-${String(month).padStart(2, "0")}`;

  const [rows, uploadedPeriods, publishedKeys, productNames, productFamilies, areaNames] = await Promise.all([
    loadAchievementRange(SALES_HISTORY_FLOOR, to),
    loadUploadedPeriodsInRange(SALES_HISTORY_FLOOR, to),
    loadSalesReleaseKeys(),
    loadProductNameMap(),
    loadProductFamilyMap(),
    loadAreaNameMap(),
  ]);

  // Sales of an unpublished month appear nowhere (owner, 2026-11-04). Per line, because each line
  // publishes on its own day. These rows are what a portal payload and the rep's Incentive tab are
  // built from, so nothing downstream can add an unpublished sale back.
  const released = rows.filter((row) => isSalesPeriodReleased(row.period, row.lineCode, publishedKeys));

  // Merge Fayoum/Beni Suef BEFORE aggregating, so the two codes land in one bucket and are
  // summed here rather than silently deduplicated downstream.
  const merged = applyAchievementAreaMerges(released);
  const aggregates = aggregateCanonicalPortalRows(merged, uploadedPeriods);

  return aggregates
    .map((aggregate) => {
      const [yearPart, monthPart] = aggregate.period.split("-");
      return {
        hrId: upper(aggregate.repHrId),
        managerHrId: aggregate.dmHrId ? upper(aggregate.dmHrId) : null,
        family: productFamilies.get(aggregate.productCode) ?? "",
        line: aggregate.lineCode ? lineName(aggregate.lineCode) : null,
        month: Number(monthPart) || null,
        period: aggregate.period,
        product: productNames.get(aggregate.productCode) ?? aggregate.productCode,
        productCode: aggregate.productCode,
        salesType: CANONICAL_SALES_TYPE,
        salesUnits: aggregate.salesUnits,
        salesValue: aggregate.salesValue,
        targetValue: aggregate.targetValue,
        territory:
          getMergedAreaName(aggregate.lineCode, aggregate.areaCode) ??
          areaNames.get(aggregate.areaCode) ??
          aggregate.areaCode,
        year: Number(yearPart) || null,
      };
    })
    // Newest first, matching the order the legacy query returned.
    .sort(
      (left, right) =>
        (right.year ?? 0) * 12 + (right.month ?? 0) - ((left.year ?? 0) * 12 + (left.month ?? 0)),
    );
});

/**
 * The canonical portal rows matching these filters. Callers narrow to a person afterwards
 * with selectCanonicalRowsForHrIds rather than loading again.
 */
export async function loadCanonicalPortalSalesRows(
  filters: CanonicalPortalSalesFilters = {},
): Promise<CanonicalPortalSalesRow[]> {
  return filterCanonicalPortalRows(await loadAllCanonicalPortalSalesRows(), filters);
}
