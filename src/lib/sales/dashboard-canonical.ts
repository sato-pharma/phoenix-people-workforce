// ─────────────────────────────────────────────────────────────────────────────
// The ADMIN sales dashboard's rows, sourced from SoS Monthly Closing.
//
// getSalesDashboard used to page through `sales_records` — the closing-sheet import table —
// and every surface hanging off it (the monthly dashboard page, its API and XLSX export, the
// /admin Total Sales KPI, the CEO health tile, the SFE targets widget) therefore quoted the
// legacy engine's numbers. Measured 2026-08-13, that engine reads 8% low company-wide for H1
// and 34% HIGH for individual reps against SoS Monthly Closing, which is the only sales truth
// in this system. This module produces the same row shape from the canonical engine so those
// surfaces move without every aggregation below them being rewritten.
//
// It is the admin twin of employee-portal/portal-sales-canonical.ts. Both go through the same
// three steps — loadAchievementRange -> applyAchievementAreaMerges -> the uploaded-period gate
// — so the portal and the admin dashboard cannot quote different numbers for the same person.
// They differ in exactly ONE deliberate way, and it is the reason this file exists separately:
//
//   THE PORTAL DROPS UNATTRIBUTED ROWS; THIS KEEPS THEM. A row the engine could not tie to an
//   occupied seat belongs to the area, not to a person, so crediting it to whoever the portal
//   asked about would be wrong. But the ADMIN total is the company's total: dropping a vacant
//   area's sales would quietly under-report the company by exactly the sales nobody was hired
//   to make. Those rows are kept here with no employee HR id, and classifySalesOwnership sorts
//   them into vacant / non-assignable / line-level buckets that stay inside the company total.
//
// Three more things that are load-bearing:
//
//   1. COVERED SALES ARE TRACKED SEPARATELY. Only sales sitting on a (line, area, product) key
//      that HAS a target may be divided by that target. Summing every sale over the targets
//      that happen to exist reads as over-achievement nobody earned — the same defect fixed on
//      the portal's incentive tab. `salesValue` is every sale; `coveredSalesValue` is the part
//      an achievement % is allowed to use.
//
//   2. A MONTH WITH NO DISTRIBUTOR UPLOAD IS EXCLUDED. August 2026 holds one direct order
//      (1,309.50 EGP) against a 17,508,935 EGP target. `has_actual` cannot tell a landed month
//      from a stray order; the distributor batch ledger can.
//
//   3. THERE IS NO SALES TYPE AND NO IMPORT BATCH in the canonical engine. Both are legacy
//      import concepts, and both are left honestly blank rather than fabricated — see
//      CANONICAL_SALES_TYPE and CANONICAL_BATCH_ID.
// ─────────────────────────────────────────────────────────────────────────────

import { cache } from "react";

import { currentCairoDateParts } from "@/lib/i18n/format";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import {
  lineName,
  loadAreaNameMap,
  loadEmployeeNameMap,
  loadProductFamilyMap,
  loadProductNameMap,
  loadProductPriceMap,
} from "@/lib/sales/monthly-targets";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import type { SalesRecordInput } from "@/lib/sales/types";
import {
  SALES_HISTORY_FLOOR,
  loadAchievementRange,
  loadUploadedPeriodsInRange,
} from "@/lib/sales/vs-target";

/**
 * Structurally the ScopedRecord getSalesDashboard already aggregates, plus one field.
 *
 * `coveredSalesValue` is the part of `salesValue` that sits on a key carrying a target. Every
 * achievement % on the dashboard divides THIS by the target, never the full `salesValue`.
 */
export type CanonicalDashboardRecord = SalesRecordInput & {
  batchId: string;
  period: string;
  coveredSalesValue: number;
};

/**
 * The canonical engine has no Retail/Stores split, so there is nothing honest to put here.
 *
 * Blank on purpose. The dashboard's channel-mix chart and sales-type filter are both built
 * from the rows themselves, so a blank leaves the chart on its "No channel data." empty state
 * and offers no filter option — which is the truth. A fabricated token ("Retail") would put a
 * control on screen that silently discards data and a pie chart asserting a split that the
 * closing does not record.
 */
const CANONICAL_SALES_TYPE = "";

/**
 * A provenance token, not a batch id.
 *
 * `ScopedRecord.batchId` exists because the legacy dashboard had to pick the current batch out
 * of a table holding every upload ever. The canonical engine has no such problem — the RPC
 * returns the current truth — so nothing groups on this any more. It is a constant so that a
 * stray `record.batchId === someBatch.id` comparison can never accidentally match a real row
 * in `sales_import_batches`.
 */
const CANONICAL_BATCH_ID = "sos-monthly-closing";

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export type CanonicalDashboardAggregate = {
  /** Upper-cased, or null when the engine could not attribute the row to an occupied seat. */
  repHrId: string | null;
  dmHrId: string | null;
  lineCode: string | null;
  areaCode: string;
  productCode: string;
  period: string;
  salesUnits: number;
  salesValue: number;
  /** Sales on a key the engine says carries a target. The only actual an achievement may use. */
  coveredSalesValue: number;
  targetUnits: number;
  targetValue: number;
};

/**
 * Fold canonical rows into one aggregate per (rep, period, area, product). PURE.
 *
 * Unattributed rows are KEPT under a null rep — see the header. Rows for a month whose
 * distributor upload has not landed are dropped, because a month that is not in yet is not a
 * 0% month.
 */
export function aggregateCanonicalDashboardRows(
  rows: readonly AchievementRow[],
  uploadedPeriods: ReadonlySet<string>,
): CanonicalDashboardAggregate[] {
  const byKey = new Map<string, CanonicalDashboardAggregate>();
  for (const row of rows) {
    if (!uploadedPeriods.has(row.period)) continue;

    const repHrId = upper(row.repHrId) || null;
    const dmHrId = upper(row.dmHrId) || null;
    const areaCode = upper(row.areaCode);
    const productCode = upper(row.productCode);
    const covered = row.hasTarget ? row.actualValue : 0;

    const key = `${repHrId ?? ""}|${dmHrId ?? ""}|${row.lineCode ?? ""}|${row.period}|${areaCode}|${productCode}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.salesUnits += row.actualUnits;
      existing.salesValue += row.actualValue;
      existing.coveredSalesValue += covered;
      existing.targetUnits += row.targetUnits ?? 0;
      existing.targetValue += row.targetValue ?? 0;
      continue;
    }
    byKey.set(key, {
      repHrId,
      dmHrId,
      lineCode: row.lineCode,
      areaCode,
      productCode,
      period: row.period,
      salesUnits: row.actualUnits,
      salesValue: row.actualValue,
      coveredSalesValue: covered,
      targetUnits: row.targetUnits ?? 0,
      targetValue: row.targetValue ?? 0,
    });
  }
  return [...byKey.values()];
}

/**
 * Every canonical dashboard row in the reportable window. UNFILTERED and viewer-independent.
 *
 * Six round trips: the achievement range, the upload ledger, and four display-name maps. The
 * range is ONE call for every month — never loop a per-period RPC over it, each one crosses
 * the Atlantic to eu-central-1.
 *
 * Memoized per request because a single admin render asks for the dashboard more than once
 * (the page, the platform KPI, and the SFE targets widget all call getSalesDashboard). Scoping
 * to a viewer happens after, in filterSalesRecordsForAccess, so there is nothing to leak here.
 */
const loadAllCanonicalDashboardRecords = cache(async (): Promise<CanonicalDashboardRecord[]> => {
  const { year, month } = currentCairoDateParts();
  const to = `${year}-${String(month).padStart(2, "0")}`;

  const [rows, uploadedPeriods, productNames, productFamilies, productPrices, areaNames, employeeNames] =
    await Promise.all([
      loadAchievementRange(SALES_HISTORY_FLOOR, to),
      loadUploadedPeriodsInRange(SALES_HISTORY_FLOOR, to),
      loadProductNameMap(),
      loadProductFamilyMap(),
      loadProductPriceMap(),
      loadAreaNameMap(),
      loadEmployeeNameMap(),
    ]);

  // Merge Fayoum/Beni Suef BEFORE aggregating so the two codes land in one bucket and are
  // summed, rather than arriving downstream as two rows sharing a key.
  const merged = applyAchievementAreaMerges(rows);
  const aggregates = aggregateCanonicalDashboardRows(merged, uploadedPeriods);

  // The name map is keyed on the HR id exactly as `employees` stores it; the engine returns it
  // lower-cased. Try both rather than showing a rep as "Unassigned" over a casing difference.
  const employeeName = (hrId: string | null): string | null => {
    if (!hrId) return null;
    return employeeNames.get(hrId) ?? employeeNames.get(lower(hrId)) ?? null;
  };

  return aggregates.map((aggregate, index) => {
    const [yearPart, monthPart] = aggregate.period.split("-");
    return {
      batchId: CANONICAL_BATCH_ID,
      period: aggregate.period,
      rowNumber: index + 1,
      employeeHrId: aggregate.repHrId,
      employeeCrmId: null,
      employeeLookupKey: null,
      employeeName: employeeName(aggregate.repHrId),
      managerHrId: aggregate.dmHrId,
      line: lineName(aggregate.lineCode),
      territory: areaNames.get(aggregate.areaCode) ?? aggregate.areaCode,
      salesType: CANONICAL_SALES_TYPE,
      family: productFamilies.get(aggregate.productCode) ?? "",
      product: productNames.get(aggregate.productCode) ?? aggregate.productCode,
      factoryPrice: productPrices.get(aggregate.productCode) ?? 0,
      month: Number(monthPart) || 0,
      year: Number(yearPart) || 0,
      salesUnits: aggregate.salesUnits,
      salesValue: aggregate.salesValue,
      coveredSalesValue: aggregate.coveredSalesValue,
      targetUnits: aggregate.targetUnits,
      targetValue: aggregate.targetValue,
      // The canonical engine has no validation queue: a row exists because the closing says it
      // does. "valid" is the honest state, and it keeps the linkage summary from discarding
      // every row as failed.
      validationState: "valid" as const,
      validationNotes: [],
      linkStatus: (aggregate.repHrId ? "linked" : "unlinked") as SalesRecordInput["linkStatus"],
      linkConfidence: aggregate.repHrId ? 1 : 0,
    };
  });
});

/** Every canonical dashboard row in the reportable window, memoized for the request. */
export async function loadCanonicalDashboardRecords(): Promise<CanonicalDashboardRecord[]> {
  return loadAllCanonicalDashboardRecords();
}
