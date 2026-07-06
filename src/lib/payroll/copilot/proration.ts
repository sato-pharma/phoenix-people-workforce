import { roundCurrency } from "@/lib/payroll/money";

import type { CopilotPeriod } from "./types.ts";

/**
 * Pure proration/settlement math for joiners, leavers, and unpaid leave.
 *
 * Universal principle (owner-confirmed): any daily rate is always
 * `Base Salary ÷ actual calendar days in the month` — ECOL and Fuel are
 * "extras," never part of the rate, in any scenario. Deterministic and
 * I/O-free so it's trivially unit-testable, mirroring statutory/calculator.ts.
 */

export function calendarDaysInMonth(period: CopilotPeriod): number {
  return new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
}

/** True when a YYYY-MM-DD date string falls within the given month/year. */
export function isInPeriod(dateText: string | null, period: CopilotPeriod): boolean {
  if (!dateText) return false;
  const match = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!match) return false;
  return Number(match[1]) === period.year && Number(match[2]) === period.month;
}

export function dailyRate(baseSalary: number, period: CopilotPeriod): number {
  const days = calendarDaysInMonth(period);
  return days > 0 ? baseSalary / days : 0;
}

/** Day-of-month (1-31) from an ISO date string, or null if unparseable. */
export function dayOfMonth(dateIso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso.trim());
  if (!match) return null;
  const day = Number(match[3]);
  return Number.isFinite(day) && day >= 1 && day <= 31 ? day : null;
}

export type ResignationSettlementInput = {
  baseSalary: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  lastWorkingDate: string;
  period: CopilotPeriod;
  unpaidDaysInSpan: number;
  otherAdditions: number;
  otherDeductions: number;
};

export type ResignationSettlement = {
  branch: "on_or_before_25" | "after_25";
  daysWorked: number;
  /** This month's Base — prorated (≤25th branch) or the full base (>25th). */
  baseForMonth: number;
  ecolPaid: number;
  fuelPaid: number;
  /** baseForMonth + ecolPaid + fuelPaid (this month's Net, before other adjustments). */
  netForMonth: number;
  /** netForMonth ± otherAdditions/otherDeductions — the final settlement to split. */
  total: number;
};

/**
 * Resignation Rule 1 (owner-confirmed):
 *  - last working day ≤ 25th: Base-only day-rate proration for the days
 *    actually worked (minus any unpaid-leave days inside that span). No ECOL,
 *    no Fuel at all.
 *  - last working day > 25th: Base paid in FULL (unprorated) + ECOL in full +
 *    Fuel in full. No proration in this branch.
 * Either way, other additions/deductions apply on top of the result.
 */
export function computeResignationSettlement(
  input: ResignationSettlementInput,
): ResignationSettlement | null {
  const day = dayOfMonth(input.lastWorkingDate);
  if (day == null) return null;

  const netAdjustment = input.otherAdditions - input.otherDeductions;

  if (day <= 25) {
    const daysWorked = Math.max(0, day - input.unpaidDaysInSpan);
    const baseForMonth = roundCurrency(dailyRate(input.baseSalary, input.period) * daysWorked);
    return {
      branch: "on_or_before_25",
      daysWorked,
      baseForMonth,
      ecolPaid: 0,
      fuelPaid: 0,
      netForMonth: baseForMonth,
      total: roundCurrency(baseForMonth + netAdjustment),
    };
  }

  const baseForMonth = roundCurrency(input.baseSalary);
  const ecolPaid = roundCurrency(input.extraCostOfLiving);
  const fuelPaid = roundCurrency(input.fuelAllowance);
  const netForMonth = roundCurrency(baseForMonth + ecolPaid + fuelPaid);
  return {
    branch: "after_25",
    daysWorked: day,
    baseForMonth,
    ecolPaid,
    fuelPaid,
    netForMonth,
    total: roundCurrency(netForMonth + netAdjustment),
  };
}

export type JoinerPayInput = {
  baseSalary: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  hireDate: string;
  period: CopilotPeriod;
};

export type JoinerPay = {
  daysWorked: number;
  baseForMonth: number;
  ecolPaid: number;
  fuelPaid: number;
  netForMonth: number;
};

/**
 * Joiner ECOL/Fuel rule (owner-confirmed): hired on/before the 15th → full
 * ECOL+Fuel; hired after the 15th → half. Base always follows the universal
 * day-rate proration; the hire date itself counts as a paid day.
 */
export function computeJoinerPay(input: JoinerPayInput): JoinerPay | null {
  const hireDay = dayOfMonth(input.hireDate);
  if (hireDay == null) return null;

  const totalDays = calendarDaysInMonth(input.period);
  const daysWorked = Math.max(0, Math.min(totalDays, totalDays - hireDay + 1));
  const baseForMonth = roundCurrency(dailyRate(input.baseSalary, input.period) * daysWorked);
  const fullEcolFuel = hireDay <= 15;
  const ecolPaid = roundCurrency(fullEcolFuel ? input.extraCostOfLiving : input.extraCostOfLiving / 2);
  const fuelPaid = roundCurrency(fullEcolFuel ? input.fuelAllowance : input.fuelAllowance / 2);
  return {
    daysWorked,
    baseForMonth,
    ecolPaid,
    fuelPaid,
    netForMonth: roundCurrency(baseForMonth + ecolPaid + fuelPaid),
  };
}

export type ResignationPartsSplit = { firstPart: number; secondPart: number };

/**
 * Resignation Rule 2 (owner-confirmed, two-part payment mode only): Part 1
 * stays at the normal fixed Basic Salary anchor unless the settlement total
 * is smaller, in which case Part 1 absorbs the whole total and Part 2 is 0.
 *
 * Deliberately not routed through calculatePayrollParts — that function's
 * single baseSalary input does double duty (both the 70% anchor and a
 * netSalary-derivation fallback), which would force decoupled, fragile inputs
 * for this one case. This is the ~2-line equivalent, kept self-contained and
 * independently testable.
 */
export function applyResignationPartsSplit(input: {
  totalPayable: number;
  basicSalary: number;
}): ResignationPartsSplit {
  const firstPart = roundCurrency(Math.min(input.basicSalary, input.totalPayable));
  const secondPart = roundCurrency(Math.max(0, input.totalPayable - firstPart));
  return { firstPart, secondPart };
}
