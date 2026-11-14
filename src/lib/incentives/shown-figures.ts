import { createHash } from "node:crypto";

import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

// ─────────────────────────────────────────────────────────────────────────────
// THE INCENTIVE FIGURE A PERSON WAS SHOWN, AS A RECORD (enterprise audit REC-066, F-PAY-007; 14 Nov 2026).
//
// The Incentive tab works its figure out on every read, so what a person saw last month could not be
// told apart from what the same screen says after a price fix or a restated closing. The owner chose
// (14 Nov 2026) "when first shown": the first time a person's OWN tab shows a figure it is stored with
// its inputs, and stored again only when the figure changes. He reads the history; nobody else does,
// and nothing pays from it.
//
// This file is PURE: it reads the tab's own payload, never recalculates it. The locked scheme
// (`scheme-2026.ts`) and the Pedia split are not touched. The write is `shown-figures-store.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** One stored figure: exactly what the tab put in front of the person, and the inputs it came from. */
export type ShownIncentiveFigure = {
  hrId: string;
  semesterLabel: string;
  periods: string[];
  line: string | null;
  salesScope: string | null;
  achievementPercent: number;
  semesterSales: number;
  semesterTarget: number;
  basicSalary: number;
  payoutEgp: number;
  payoutPercentage: number | null;
  pediaSplit: {
    satoAchievementPercent: number;
    satoSales: number;
    satoTarget: number;
    satoHalfAmount: number;
    satoHalfWithheld: boolean;
    totalHalfAmount: number;
  } | null;
  windowNotice: string | null;
};

/** Money and percentages rounded once, so a float's last digit cannot read as a new figure. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

/**
 * The figure the tab showed, or null when it showed none: no linked profile, a manager's closing that
 * could not be read, no semester, or no target yet ("No target yet" is not a figure).
 */
export function shownIncentiveFigure(data: MedicalRepPortalData): ShownIncentiveFigure | null {
  if (data.empty.profile) return null;
  const sales = data.sales;
  if (sales.incentiveClosingUnread) return null;
  if (!sales.incentiveSemesterLabel || !(sales.incentiveSemesterTarget > 0)) return null;
  const hrId = String(data.employee.hrId ?? "").trim();
  if (!hrId) return null;
  const split = sales.pediaSplit;
  return {
    hrId,
    semesterLabel: sales.incentiveSemesterLabel,
    periods: [...(sales.incentiveSemesterPeriods ?? [])].sort(),
    line: data.employee.line ?? null,
    salesScope: sales.viewerSalesScope ?? null,
    achievementPercent: round(sales.overviewAchievementPercent, 2),
    semesterSales: round(sales.incentiveSemesterSales, 2),
    semesterTarget: round(sales.incentiveSemesterTarget, 2),
    basicSalary: round(data.payroll.basicSalary, 2),
    payoutEgp: round(data.payroll.incentive, 2),
    payoutPercentage: split ? round(split.payoutPercentage, 2) : null,
    pediaSplit: split
      ? {
          satoAchievementPercent: round(split.satoAchievementPercent, 2),
          satoSales: round(split.satoSales, 2),
          satoTarget: round(split.satoTarget, 2),
          satoHalfAmount: round(split.satoHalfAmount, 2),
          satoHalfWithheld: split.satoHalfWithheld,
          totalHalfAmount: round(split.totalHalfAmount, 2),
        }
      : null,
    windowNotice: sales.incentiveWindowNotice ?? null,
  };
}

/** Every field but the person, in a fixed order: the same figure always hashes alike. */
export function shownIncentiveFingerprint(figure: ShownIncentiveFigure): string {
  const { hrId: _person, ...rest } = figure;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const split = figure.pediaSplit ? JSON.stringify(figure.pediaSplit, Object.keys(figure.pediaSplit).sort()) : "null";
  return createHash("sha256").update(`${canonical}|${split}`).digest("hex");
}
