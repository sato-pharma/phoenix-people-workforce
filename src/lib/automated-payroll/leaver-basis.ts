import {
  calendarDaysInMonth,
  computeResignationSettlement,
  type ResignationSettlement,
} from "@/lib/payroll/copilot/proration.ts";
import { roundCurrency } from "@/lib/payroll/money";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model.ts";

import type { DraftRow, PayrollPeriod } from "./types.ts";

/**
 * THE ONE LEAVER RULE — days worked and the day rate, resolved once and read by
 * every Part 1 tab that settles or deducts from a leaver.
 *
 * WHY THIS FILE EXISTS (owner, 2026-08-30, in his words): *"the rule must be
 * synced everywhere in the module. I don't have to make the rule every tab."*
 *
 * He was describing two real defects, both of which came from the same absence
 * of a shared answer:
 *
 *  1. DAYS WORKED DISAGREED BETWEEN TABS. He confirms a leaver's days on the
 *     Resignations step; the Resignations CRM step showed a different number.
 *     Neither tab was reading the other. The Resignations tab divided the saved
 *     `base_for_month` back out by a Base day-rate; the CRM tab ignored the
 *     draft entirely and recounted calendar days from the last working date. On
 *     the live August 2026 run, 7 of 20 settled leavers disagreed, the worst by
 *     28 days (B-34: 12 confirmed, 28 shown) — and because the CRM tab caps
 *     Working + Non-Working days at ITS OWN figure, a man who worked 12 days
 *     could be marked non-working for 28.
 *
 *  2. THE CRM DEDUCTION PRICED A DAY DIFFERENTLY FROM THE SETTLEMENT. The
 *     settlement pays Net ÷ calendar days (owner rule 2026-08-29: *"in the
 *     resignations, prorate the full net salary, not the base"*), while the
 *     leaver CRM deduction still charged Base ÷ calendar days. One no-activity
 *     day therefore cost LESS than one day of the pay it was meant to cancel —
 *     the two halves of the same day were valued differently. Owner, same
 *     message: *"in the CRM, it must prorate the net salary."*
 *
 * So both the COUNT and the RATE live here, and nothing else may compute either
 * one. A tab that needs a leaver's days calls `resolveLeaverBasis` and uses what
 * it returns.
 *
 * "Net" throughout is Base + Extra Cost of Living + Fuel — `calculateNetSalary`
 * in the owner-locked policy.ts, and the identical quantity
 * `computeResignationSettlement` calls `netForMonth`. It is NOT the
 * after-deductions take-home; no proration or deduction rule in this module has
 * ever meant that by "net".
 */

/** Everything a Part 1 leaver tab needs, resolved once from the same inputs. */
export type LeaverBasis = {
  /** Calendar days in the run's month (28-31) — the divisor for every figure here. */
  monthDays: number;
  /**
   * The day count every tab must use: HR's CONFIRMED figure when there is one,
   * otherwise the settlement's own calendar count. This is the number that used
   * to differ between the Resignations and Resignations CRM tabs.
   */
  daysWorked: number;
  /** The system's own count, before any confirmation — what the row recommends. */
  recommendedDaysWorked: number;
  /** True when `daysWorked` came from a saved confirmation rather than the calendar. */
  confirmed: boolean;
  baseSalary: number;
  extraCostOfLiving: number;
  fuelAllowance: number;
  /** Base + ECoL + Fuel for a whole month. */
  netSalary: number;
  /**
   * Net / monthDays — THE leaver day rate. One day of pay and one day of CRM
   * no-activity deduction are the same amount of money, by construction.
   */
  dailyRate: number;
  /** The unedited settlement, for the fields this basis does not replace. */
  settlement: ResignationSettlement;
};

/** What a given number of worked days is worth, split the way every consumer displays it. */
export type LeaverProratedNet = {
  baseForMonth: number;
  ecolPaid: number;
  fuelPaid: number;
  netForMonth: number;
};

function positive(value: number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? roundCurrency(parsed) : 0;
}

/**
 * A saved day count is trusted only when it is a real number inside the month.
 *
 * Rejecting an out-of-range value (rather than clamping it) is deliberate and
 * predates this file: a stored count above the month's length can only be the
 * pre-2026-07-26 whole-month bug — 22 saved against a 9-day leaver — and
 * re-recommending self-heals that stale draft with no database write. Clamping
 * would instead freeze a wrong number at the boundary and make it look chosen.
 */
function confirmedDaysWorked(draft: DraftRow | undefined, monthDays: number): number | null {
  const stored = draft?.daysWorked;
  if (stored == null || !Number.isFinite(stored)) return null;
  if (stored < 0 || stored > monthDays) return null;
  return Math.round(stored * 100) / 100;
}

/**
 * Resolve one leaver's day count and day rate. Returns null only when the last
 * working date cannot be parsed — the same condition under which
 * `computeResignationSettlement` declines to settle at all.
 */
export function resolveLeaverBasis(input: {
  source: PayrollSalarySource | null | undefined;
  lastWorkingDate: string;
  period: PayrollPeriod;
  unpaidDaysInSpan: number;
  draft: DraftRow | undefined;
}): LeaverBasis | null {
  const baseSalary = positive(input.source?.baseSalary);
  const extraCostOfLiving = positive(input.source?.extraCostOfLiving);
  const fuelAllowance = positive(input.source?.fuelAllowance);

  const settlement = computeResignationSettlement({
    baseSalary,
    extraCostOfLiving,
    fuelAllowance,
    lastWorkingDate: input.lastWorkingDate,
    period: input.period,
    unpaidDaysInSpan: input.unpaidDaysInSpan,
    otherAdditions: 0,
    otherDeductions: 0,
  });
  if (!settlement) return null;

  const monthDays = calendarDaysInMonth(input.period);
  const recommendedDaysWorked = Math.max(0, settlement.daysWorked);
  const stored = confirmedDaysWorked(input.draft, monthDays);

  // Net is summed from the three components rather than read from
  // source.netSalary so it can never disagree with what the settlement prorates.
  // They are the same quantity by definition (calculateNetSalary = base + ecol +
  // fuel), but only one of them is derived from the numbers actually in play here.
  const netSalary = roundCurrency(baseSalary + extraCostOfLiving + fuelAllowance);

  return {
    monthDays,
    daysWorked: stored ?? recommendedDaysWorked,
    recommendedDaysWorked,
    confirmed: stored != null,
    baseSalary,
    extraCostOfLiving,
    fuelAllowance,
    netSalary,
    dailyRate: monthDays > 0 ? netSalary / monthDays : 0,
    settlement,
  };
}

/**
 * What `days` worked are worth — Base, ECoL and Fuel each at the same day share.
 *
 * This is `computeResignationSettlement`'s ≤25th branch re-expressed against an
 * arbitrary day count, so that CORRECTING the days on the Resignations step
 * re-prorates all three components exactly as the system's own recommendation
 * did. Before 2026-08-30 only Base moved: HR typed the real days, Base
 * recalculated, and ECoL and Fuel silently kept the figures belonging to the
 * calendar count — which quietly un-did the owner's 2026-08-29 "prorate the
 * whole net" rule the moment anyone used the editable field it was paired with.
 *
 * The >25th branch is NOT re-derived here. It pays every component in full and
 * has no day count in it; a caller in that branch keeps the settlement's figures.
 * Each component is rounded separately so the three always add to the total the
 * screens display.
 */
export function prorateLeaverNet(basis: LeaverBasis, days: number): LeaverProratedNet {
  const share = basis.monthDays > 0 ? Math.max(0, days) / basis.monthDays : 0;
  const baseForMonth = roundCurrency(basis.baseSalary * share);
  const ecolPaid = roundCurrency(basis.extraCostOfLiving * share);
  const fuelPaid = roundCurrency(basis.fuelAllowance * share);
  return {
    baseForMonth,
    ecolPaid,
    fuelPaid,
    netForMonth: roundCurrency(baseForMonth + ecolPaid + fuelPaid),
  };
}

/**
 * A leaver's day-based deduction: `days` charged at the SAME rate his pay is
 * prorated at (owner rule 2026-08-30 — "in the CRM, it must prorate the net
 * salary"). Never /30, and never off the Base alone.
 *
 * Deliberately not clamped to days worked — the CAP is the caller's business and
 * the tabs enforce it against `basis.daysWorked`. Pricing and bounding are two
 * different rules and conflating them is what let the CRM tab bound a leaver's
 * non-working days by a figure nobody had confirmed.
 */
export function leaverDayDeduction(basis: LeaverBasis, days: number): number {
  if (days <= 0 || basis.dailyRate <= 0) return 0;
  return roundCurrency(basis.dailyRate * days);
}
