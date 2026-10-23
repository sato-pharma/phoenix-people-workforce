import { roundCurrency } from "@/lib/payroll/money";

import type { CopilotPeriod } from "./types.ts";

/**
 * Pure proration/settlement math for joiners, leavers, and unpaid leave.
 *
 * ONE DAY-RATE for both lifecycle branches, as of 2026-08-29:
 * `Net Salary ÷ actual calendar days in the month`, Net being Base + ECOL +
 * Fuel. A partial month pays exactly `Net × days ÷ calendar days`, whichever
 * end of the month the partial-ness comes from.
 *
 *  - JOINER (owner instruction, 2026-08-29, morning): replaced a rule that
 *    prorated the base and paid ECOL/Fuel as whole-month extras (halved after
 *    the 15th). computeJoinerPay records what changed and why.
 *
 *  - LEAVER (owner instruction, 2026-08-29, same day, later): *"in the
 *    resignations, prorate the full net salary, not the base."* This replaced
 *    Resignation Rule 1's ≤25th treatment, which prorated the base and paid
 *    NEITHER allowance at all. computeResignationSettlement records the detail.
 *
 * These two were deliberately DIFFERENT for one day, and this comment said so
 * — "folding allowances into the leaver rate would silently rewrite a separate
 * confirmed rule". The owner has now made that rewrite explicitly. Do not
 * restore the split on the strength of an older comment elsewhere in the repo.
 *
 * STILL BASE-ONLY, deliberately: unpaid leave, holiday bridging and vacation
 * settlement. None of them is a partial month of employment — they price days
 * NOT worked inside a month the employee is otherwise employed for in full, so
 * the allowances are not in question. The owner named resignations only.
 *
 * Deterministic and I/O-free so it's trivially unit-testable, mirroring
 * statutory/calculator.ts.
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
  otherAdditions: number;
  otherDeductions: number;
  /**
   * True only for a genuine resignation — see `isResignationEmploymentStatus`.
   *
   * REQUIRED, deliberately. It was not a parameter at all until 2026-09-11, and every caller
   * therefore settled a dismissal as a resignation. Making it optional with a friendly default
   * would recreate exactly that: the default would be "resignation", and the one caller who
   * forgot would hand a dismissal a full month of Base plus both allowances with nothing to
   * notice it by. A required field makes each surface state which kind of departure it is looking
   * at, in the open.
   */
  isResignation: boolean;
  /**
   * The employee's hire date, when the settlement should start later than the 1st.
   *
   * A PERSON CAN JOIN AND LEAVE IN THE SAME MONTH, and five have on production. They are
   * classified as a leaver only — the leaver branch returns before the joiner branch is reached —
   * and this calculation counted days from the 1st, so it paid for days before they were hired.
   * Somebody hired on 20 August on 18,000 and resigning on the 24th was recommended 18,000 x 24/31
   * = 13,935.48 for five days of work instead of 2,903.23.
   *
   * Optional because most leavers were hired in an earlier month, where it is simply absent and
   * the span already starts on the 1st. A date outside this period is ignored for the same reason.
   *
   * NOTHING HAS BEEN OVERPAID: all three August cases were excluded from the run by hand, which
   * looks like HR working around exactly this.
   */
  hireDate?: string | null;
};

export type ResignationSettlement = {
  /**
   * `non_resignation` is the company-ended departure: Base prorated to the days worked, neither
   * allowance, and no >25th waiver. It is a branch of its own rather than a flag on the others so
   * that a screen or an export showing the branch says what treatment was applied.
   */
  branch: "on_or_before_25" | "after_25" | "non_resignation";
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
 *  - last working day ≤ 25th: NET day-rate proration for the days actually
 *    worked (minus any unpaid-leave days inside that span). Base, ECOL and Fuel
 *    each prorate by the same day share.
 *  - last working day > 25th: Base paid in FULL (unprorated) + ECOL in full +
 *    Fuel in full. No proration in this branch.
 * Either way, other additions/deductions apply on top of the result.
 *
 * THE ≤25th BRANCH CHANGED 2026-08-29 on the owner's instruction: *"in the
 * resignations, prorate the full net salary, not the base."* It previously
 * prorated the base and paid NEITHER allowance — a resignation on the 9th of a
 * 31-day month received 9/31 of base and nothing else. It now receives 9/31 of
 * Base + ECOL + Fuel, so the rule matches the joiner rule set the same morning
 * and a partial month means the same thing at both ends of the calendar.
 *
 * This RAISES what every affected leaver is paid — the allowances went from
 * withheld to prorated, and nothing went down. That direction is the opposite
 * of the joiner change and is intended: the two rules were never symmetrical
 * before, which is what the owner was correcting.
 *
 * The >25th branch is untouched. It already pays every component in full, so
 * "prorate the net" is a no-op there — a full month IS the full net.
 *
 * NOT extended to a NON-resignation leaver. A `terminated` or `inactive` leaver keeps neither
 * allowance by the owner's separate ruling of 2026-08-14: Base prorates to the days actually
 * worked and there is no >25th waiver.
 *
 * THAT GATE NOW LIVES HERE, not only in the Ready sheet. This comment used to say the automated
 * engine "never sees one, because its feeder keys leavers off the employee_resignations workflow".
 * It does see one. The exit workflow is how EVERY departure is recorded, dismissals included:
 * production carries a `terminated` employee with an `employee_resignations` row at
 * `exit_status = completed`. The workflow describes the process, never the reason, so it could
 * never have answered this question — and the comment asserting otherwise is why no caller
 * checked. Both terminations on record left before the 25th, so nothing has been overpaid yet.
 */
export function computeResignationSettlement(
  input: ResignationSettlementInput,
): ResignationSettlement | null {
  const day = dayOfMonth(input.lastWorkingDate);
  if (day == null) return null;

  const netAdjustment = input.otherAdditions - input.otherDeductions;
  const totalDaysInMonth = calendarDaysInMonth(input.period);

  // THE SPAN STARTS AT THE HIRE DATE WHEN THE HIRE IS THIS MONTH, exactly as the Ready sheet's
  // `prorationStartDay` does. 1 otherwise, which is every ordinary leaver.
  const startDay =
    input.hireDate && isInPeriod(input.hireDate, input.period)
      ? (dayOfMonth(input.hireDate) ?? 1)
      : 1;
  /** Calendar days actually on payroll this month: hire date to last working day, inclusive. */
  const spanFrom = (endDay: number) => Math.max(0, Math.min(totalDaysInMonth, endDay) - startDay + 1);

  // A company-ended departure: Base prorated to the days actually worked, NEITHER allowance, and
  // no >25th waiver — the treatment every leaver got before Rule 1 existed, now scoped to the
  // departures Rule 1 was never meant to cover.
  if (!input.isResignation) {
    const daysWorked = spanFrom(day);
    const share = totalDaysInMonth > 0 ? daysWorked / totalDaysInMonth : 0;
    const baseForMonth = roundCurrency(input.baseSalary * share);
    return {
      branch: "non_resignation",
      daysWorked,
      baseForMonth,
      ecolPaid: 0,
      fuelPaid: 0,
      netForMonth: baseForMonth,
      total: roundCurrency(baseForMonth + netAdjustment),
    };
  }

  if (day <= 25) {
    // DAYS WORKED IS THE CALENDAR COUNT TO THE LAST WORKING DAY. Nothing is netted out of it here.
    //
    // This used to be `day - unpaidDaysInSpan`, which charged a leaver's approved unpaid leave a
    // SECOND time: the Deductions module already raises an unpaid-vacation candidate from the very
    // same `v2_vacation_requests` rows, and payroll charges it on the Unpaid Vacation tab. Both
    // sides read the same approved requests, so the days came off the pay and the money came off
    // again as a deduction.
    //
    // Unified on the admin-facing figure (owner, 2026-09-11: "we must unify... what really wins,
    // admin edit outputs"). The deduction is the one a human sees, reviews and can change; the
    // subtraction here was invisible arithmetic that also silently moved the Days Worked figure the
    // admin is asked to correct by hand.
    //
    // It also ENDS a disagreement that already existed. Of the four callers of this function, two —
    // the Ready sheet and the resignations service — already passed 0 and never subtracted, so the
    // same leaver's days worked differed depending on which surface asked. Now all four agree.
    const daysWorked = spanFrom(day);
    const workedShare = totalDaysInMonth > 0 ? daysWorked / totalDaysInMonth : 0;
    // Each component is rounded separately, matching computeJoinerPay: a row's
    // three parts must always add up to the row's own total, because every
    // consumer displays the parts and sums them.
    const baseForMonth = roundCurrency(input.baseSalary * workedShare);
    const ecolPaid = roundCurrency(input.extraCostOfLiving * workedShare);
    const fuelPaid = roundCurrency(input.fuelAllowance * workedShare);
    const netForMonth = roundCurrency(baseForMonth + ecolPaid + fuelPaid);
    return {
      branch: "on_or_before_25",
      daysWorked,
      baseForMonth,
      ecolPaid,
      fuelPaid,
      netForMonth,
      total: roundCurrency(netForMonth + netAdjustment),
    };
  }

  // THE >25th WAIVER WAIVES THE LEAVING END, NEVER THE JOINING ONE. Somebody who resigned after
  // the 25th is paid to month end; somebody HIRED this month still pays for the days before they
  // were hired. Same rule the Ready sheet states in as many words ("a same-month hire still pays
  // for its own unworked start-of-month days"), so the two surfaces cannot disagree. With no
  // same-month hire `startDay` is 1, `eligibleShare` is exactly 1, and this is the full month it
  // has always been.
  const eligibleDays = Math.max(0, totalDaysInMonth - startDay + 1);
  const eligibleShare = totalDaysInMonth > 0 ? eligibleDays / totalDaysInMonth : 0;
  const baseForMonth = roundCurrency(input.baseSalary * eligibleShare);
  const ecolPaid = roundCurrency(input.extraCostOfLiving * eligibleShare);
  const fuelPaid = roundCurrency(input.fuelAllowance * eligibleShare);
  const netForMonth = roundCurrency(baseForMonth + ecolPaid + fuelPaid);
  return {
    branch: "after_25",
    daysWorked: spanFrom(day),
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
 * JOINER PAY — owner instruction, 2026-08-29, in his words: "change this rule
 * to prorate also the cost of living and fuel allowance. So when you are
 * dividing, you divide the net salary, not [the base]."
 *
 * Every component is prorated by the same day share, so the month's pay is
 * exactly `Net ÷ calendar days × days worked`. The hire date itself counts as a
 * paid day.
 *
 * WHY THE >15th HALVING IS GONE, and why restoring it would be a bug. The
 * previous rule prorated Base only and paid ECOL+Fuel whole when hired on or
 * before the 15th, half after — a step function approximating "you were only
 * here for part of the month". Prorating the allowances by actual days measures
 * that same thing exactly, so keeping the halving on top would charge a
 * late-month joiner twice for one absence. It is deliberately not carried over.
 *
 * The owner chose this with the alternatives in front of him. For a hire on
 * 24 August 2026 with Base 16,000 + ECOL 1,500 + Fuel 500, the old automated
 * rule paid 5,129.03 and the old Ready-sheet rule paid 6,129.03; this rule pays
 * 18,000 ÷ 31 × 8 = 4,645.16. He was told it reduces pay for every mid-month
 * joiner and confirmed it anyway.
 *
 * netForMonth is the sum of the three ROUNDED components, not a separately
 * rounded `Net × share`. Consumers (automated-payroll/recommend.ts) add the
 * components up themselves to display a total, so deriving it any other way
 * could render a row whose parts visibly fail to add up to its own total.
 */
export function computeJoinerPay(input: JoinerPayInput): JoinerPay | null {
  const hireDay = dayOfMonth(input.hireDate);
  if (hireDay == null) return null;

  const totalDays = calendarDaysInMonth(input.period);
  const daysWorked = Math.max(0, Math.min(totalDays, totalDays - hireDay + 1));
  const workedShare = totalDays > 0 ? daysWorked / totalDays : 0;

  const baseForMonth = roundCurrency(input.baseSalary * workedShare);
  const ecolPaid = roundCurrency(input.extraCostOfLiving * workedShare);
  const fuelPaid = roundCurrency(input.fuelAllowance * workedShare);
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
  // A settlement below zero pays nothing in either instalment — the same floor the one-part branch in
  // assemble.ts already applies. Without it Math.min handed the negative total straight to Part 1, so a
  // leaver who owed 800 showed a First Part of -800 (audit 2026-10-23, S-PAY-01).
  const firstPart = roundCurrency(Math.max(0, Math.min(input.basicSalary, input.totalPayable)));
  const secondPart = roundCurrency(Math.max(0, input.totalPayable - firstPart));
  return { firstPart, secondPart };
}
