// ─────────────────────────────────────────────────────────────────────────────
// The semester achievement a MANAGER is scored on — read from the published closing.
//
// A medical rep is scored on his own sales rows. A manager is scored on his line (the NSM) or on his
// seat's areas (a DM, an RM), and the closing already totals exactly that: every sales page prints
// the line's achievement from the engine rows, published months only, direct orders and vacant seats
// included. The incentive tab used to total a DIFFERENT set for a manager — the portal's per-person
// sales rows for the line, de-duplicated per (person, area, period, product) — and so printed 60.5%
// beside a closing that said 55.8% for the same line and the same three months. The owner's golden
// rule is that every sales and target figure equals the published closing; this is that rule for the
// number that decides a manager's pay.
//
// Pure: rows and the window are passed in. The rows come from `loadPublishedClosingRowsForViewer`
// (src/lib/employee-portal/sos-team-performance.ts), already cut to the viewer's bound.
//
// SATO is measured over the same rows and the same graded periods as the total, so the two halves of
// the Pedia split can never be scored on different months.
// ─────────────────────────────────────────────────────────────────────────────

import type { PediaAchievementMeasurement } from "@/lib/incentives/pedia-achievement";
import { isPediaSatoProductCode } from "@/lib/incentives/pedia-split";
import type { PeriodKey } from "@/lib/incentives/semester";
import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { gradedPeriodsOf, totalRows } from "@/lib/sales/vs-target";

/** The periods the closing holds sales for, ascending — the input `resolveIncentiveWindow` wants. */
export function closingPeriodsOf(rows: readonly AchievementRow[]): PeriodKey[] {
  return Array.from(new Set(rows.filter((row) => row.hasActual).map((row) => row.period))).sort();
}

/**
 * Total and Sato over the semester window, as the closing totals them.
 *
 * Achievement is the engine's own `totalRows` figure (graded sales ÷ target), not a re-division, so it
 * equals what Monthly Closing prints for the same rows. The Sato half uses the periods the WHOLE
 * line has a target in (the owner's ruling of 2026-09-26, the Business Review's rule), so a month
 * carrying a target for one product is graded for every product.
 */
export function measureClosingSemesterAchievement(input: {
  rows: readonly AchievementRow[];
  windowPeriods: readonly PeriodKey[];
}): PediaAchievementMeasurement {
  const inWindow = new Set(input.windowPeriods);
  const rows = input.rows.filter((row) => inWindow.has(row.period));
  const graded = gradedPeriodsOf(rows);

  const total = totalRows(rows, graded);
  const sato = totalRows(rows.filter((row) => isPediaSatoProductCode(row.productCode)), graded);

  return {
    satoAchievementPercent: sato.achievementValue != null ? sato.achievementValue * 100 : 0,
    satoSales: sato.actualValue,
    satoTarget: sato.targetValue,
    totalAchievementPercent: total.achievementValue != null ? total.achievementValue * 100 : 0,
    totalSales: total.actualValue,
    totalTarget: total.targetValue,
  };
}
