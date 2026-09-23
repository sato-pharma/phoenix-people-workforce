// ─────────────────────────────────────────────────────────────────────────────
// The two achievements the Pedia split incentive is scored on — SATO and TOTAL.
//
// src/lib/incentives/pedia-split.ts turns two percentages into money. This module is where those
// two percentages come from: the same per-(rep, period, area, product) sales rows the portal's
// trend is already built from, summed over the semester window, once for the two Sato products and
// once for all four.
//
// THE DE-DUPLICATION RULE IS COPIED DELIBERATELY, NOT SIMPLIFIED. buildPortalSalesDashboardMetrics
// (src/lib/sales/metrics.ts) takes the MAX target per (employee, territory, period, product) and
// counts it ONCE, because the legacy view echoed the same target across several rows for one key.
// Canonical rows carry no such echo, so on today's data a raw sum gives the same answer — but the
// TOTAL computed here sits on screen beside `incentiveSemesterTarget`, which comes from that
// builder. If the two ever drifted apart, a rep would read two different "total achievement"
// figures on one tab, and the one that decides his money would be the one nobody could reconcile.
// Matching the rule exactly is what makes them the same number by construction rather than by luck.
//
// SALES ARE SUMMED RAW. Every row's value is real money the rep sold; only the TARGET echoes.
// This is the same asymmetry the trend builder has.
//
// ⚠ A SATO MONTH WITH NO SATO TARGET INFLATES THE SATO HALF, exactly as an untargeted month
// inflates the total — the same live shape, now with a second denominator that can develop the same
// hole independently. It is honoured literally here rather than carved out, for the reason the
// service already gives for the total: the fix belongs in loading the missing target, not in
// quietly redefining the owner's formula. `satoTarget` is returned so a caller can tell a 0% from
// an absent one, and the tab must read it before rendering a percentage.
//
// Pure: no clock, no database. Rows and the window are passed in.
// ─────────────────────────────────────────────────────────────────────────────

import { isPediaSatoProductCode } from "@/lib/incentives/pedia-split";
import type { PeriodKey } from "@/lib/incentives/semester";

/**
 * The parts of a portal sales row this measurement needs.
 *
 * Structural rather than an import of PortalSalesNormalized, so the module stays pure and testable
 * with plain objects and carries no dependency on the portal service.
 */
export type PediaAchievementRow = {
  hrId?: string | null;
  territory?: string | null;
  period: string;
  productCode: string;
  salesValue: number;
  targetValue: number;
};

export type PediaAchievementMeasurement = {
  /** Sales on GU001 + IV001 over the window. */
  satoSales: number;
  /** Target on GU001 + IV001 over the window, de-duplicated per (rep, area, period, product). */
  satoTarget: number;
  /** Sales on all four products over the window. */
  totalSales: number;
  /** Target on all four, same de-duplication. */
  totalTarget: number;
  /** `satoSales / satoTarget * 100`, or 0 when there is no Sato target — read `satoTarget` to tell
   * a genuine 0% from "no target loaded yet". */
  satoAchievementPercent: number;
  /** The same for the line total. */
  totalAchievementPercent: number;
};

function numberOf(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function keyOf(row: PediaAchievementRow): string {
  const hrId = String(row.hrId ?? "").trim().toUpperCase() || "unassigned";
  const territory = String(row.territory ?? "").trim() || "Unassigned";
  const productCode = String(row.productCode ?? "").trim().toUpperCase();
  return `${hrId}::${territory}::${row.period}::${productCode}`;
}

/**
 * Measure Sato and Total over one semester window.
 *
 * `windowPeriods` is the set of periods that actually count — `IncentiveWindow.present`, the months
 * of the declared calendar semester this rep has data for. Rows outside it are dropped rather than
 * clamped: a closed semester's months belong to a payout that has already been made.
 */
export function measurePediaAchievement(input: {
  rows: readonly PediaAchievementRow[];
  windowPeriods: readonly PeriodKey[];
}): PediaAchievementMeasurement {
  const inWindow = new Set(input.windowPeriods);
  const rows = input.rows.filter((row) => inWindow.has(row.period));

  // Pass one: the MAX target per key, matching the trend builder.
  const maxTargetByKey = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    maxTargetByKey.set(key, Math.max(numberOf(row.targetValue), maxTargetByKey.get(key) ?? 0));
  }

  // Pass two: every row's SALES, but each key's target only once.
  const countedTargetKeys = new Set<string>();
  let satoSales = 0;
  let satoTarget = 0;
  let totalSales = 0;
  let totalTarget = 0;

  for (const row of rows) {
    const key = keyOf(row);
    const sales = numberOf(row.salesValue);
    const target = countedTargetKeys.has(key) ? 0 : (maxTargetByKey.get(key) ?? 0);
    countedTargetKeys.add(key);

    totalSales += sales;
    totalTarget += target;

    if (isPediaSatoProductCode(row.productCode)) {
      satoSales += sales;
      satoTarget += target;
    }
  }

  return {
    satoAchievementPercent: satoTarget > 0 ? (satoSales / satoTarget) * 100 : 0,
    satoSales,
    satoTarget,
    totalAchievementPercent: totalTarget > 0 ? (totalSales / totalTarget) * 100 : 0,
    totalSales,
    totalTarget,
  };
}
