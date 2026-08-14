import { parseDateOnly } from "@/lib/date-only";
import { calendarDaysInMonth, computeResignationSettlement } from "@/lib/payroll/copilot/proration";
import { roundCurrency } from "@/lib/payroll/money";

/**
 * Ready-Payroll partial-month proration for joiners and leavers.
 *
 * THE RULE (owner-confirmed, and already stated in
 * src/lib/payroll/copilot/proration.ts): any daily rate is always
 * `Base Salary ÷ actual calendar days in the month`. ECOL and Fuel are extras,
 * never part of the rate.
 *
 * WHY THIS MODULE EXISTS: this arithmetic used to sit inline in
 * app/api/payroll/template/route.ts and hardcoded a 30-day month. That silently
 * charged a full-month February worker. The "worked the whole month, deduct
 * nothing" guard compared the last working day against 30, and a 28- or 29-day
 * February can never reach 30 — so an employee who resigned on 28 Feb having
 * worked every single day was deducted 2 days of salary (666.67 EGP on a
 * 10,000 EGP base). The route could not be imported by a test because it pulls
 * in ExcelJS, next/server and Supabase, so the only guard the rule ever had was
 * a source-regex assertion — which happily matched the buggy `30 - hireDay + 1`
 * and asserted the fixed-30 month was *correct*. Keeping the math here, pure and
 * I/O-free, is what makes it verifiable.
 *
 * The Excel formulas written into the workbook must stay in step with these
 * functions: the sheet recalculates client-side, so a server-side fix alone
 * would leave the downloaded workbook disagreeing with the stored figure.
 * `payrollDaysInMonth` is therefore also interpolated into those formulas.
 */

/** Real calendar length of the payroll month (28-31) — never a fixed 30. */
export function payrollDaysInMonth(month: number, year: number): number {
  return calendarDaysInMonth({ month, year });
}

/** True when a date-only string falls inside the payroll month/year. */
export function payrollMonthMatches(value: string | null, month: number, year: number) {
  if (!value) return false;
  const date = parseDateOnly(value);
  return Boolean(
    date &&
      date.getFullYear() === year &&
      date.getMonth() + 1 === month,
  );
}

/** Day-of-month (1-31) for a date-only string, or null when unparseable. */
export function payrollHireDay(value: string | null) {
  const date = parseDateOnly(value);
  return date ? date.getDate() : null;
}

/** First paid day: the hire day when hired inside this month, else day 1. */
export function prorationStartDay(hireDate: string | null, month: number, year: number) {
  return payrollMonthMatches(hireDate, month, year) ? payrollHireDay(hireDate) ?? 1 : 1;
}

/**
 * Last paid day: the last working day when leaving inside this month, else the
 * final calendar day. Clamped to the real month length so 31 in a 30-day month
 * still reads as "worked to the end".
 */
export function prorationEndDay(lastWorkingDate: string | null, month: number, year: number) {
  const daysInMonth = payrollDaysInMonth(month, year);
  if (!payrollMonthMatches(lastWorkingDate, month, year)) return daysInMonth;
  const lastWorkingDay = payrollHireDay(lastWorkingDate) ?? daysInMonth;
  return Math.min(daysInMonth, Math.max(1, lastWorkingDay));
}

/**
 * Hire-month-only proration deduction (Base Salary only), written into Other
 * Deductions. Returns 0 when the employee was not hired inside this month.
 */
export function calculateBaseProrationDeduction(
  baseSalary: number,
  hireDate: string | null,
  month: number,
  year: number,
) {
  if (!payrollMonthMatches(hireDate, month, year)) return 0;

  const hireDay = payrollHireDay(hireDate);
  if (!hireDay) return 0;

  const daysInMonth = payrollDaysInMonth(month, year);
  const eligibleDays = Math.max(0, daysInMonth - hireDay + 1);
  return roundCurrency(Math.max(0, baseSalary - (baseSalary / daysInMonth) * eligibleDays));
}

/**
 * Full lifecycle proration: charges the unworked days at either end of the
 * month for joiners and leavers alike. An employee present for the whole
 * calendar month is deducted nothing — including in a 28- or 29-day February.
 */
export function calculateBaseLifecycleProrationDeduction(
  baseSalary: number,
  hireDate: string | null,
  lastWorkingDate: string | null,
  month: number,
  year: number,
) {
  const daysInMonth = payrollDaysInMonth(month, year);
  const startDay = prorationStartDay(hireDate, month, year);
  const endDay = prorationEndDay(lastWorkingDate, month, year);

  if (startDay <= 1 && endDay >= daysInMonth) return 0;

  const eligibleDays = Math.max(0, endDay - startDay + 1);
  return roundCurrency(Math.max(0, baseSalary - (baseSalary / daysInMonth) * eligibleDays));
}

/**
 * The last paid day actually charged for, AFTER Resignation Rule 1's >25th waiver.
 *
 * A leaver after the 25th is paid base in full, which in day terms means "treated as
 * having worked to month end". Expressing the waiver as an end DAY rather than as a
 * special-cased zero is what lets the Excel formula and the stored value stay in step:
 * both interpolate the same number, and a mid-month hire in the same row still charges
 * its own start-of-month days instead of being handed a full month it did not work.
 */
export function prorationEffectiveEndDay(
  lastWorkingDate: string | null,
  month: number,
  year: number,
) {
  const daysInMonth = payrollDaysInMonth(month, year);
  if (!payrollMonthMatches(lastWorkingDate, month, year)) return daysInMonth;
  const lastWorkingDay = payrollHireDay(lastWorkingDate);
  if (lastWorkingDay != null && lastWorkingDay > RESIGNATION_FULL_PAY_AFTER_DAY) return daysInMonth;
  return prorationEndDay(lastWorkingDate, month, year);
}

/**
 * The day-of-month after which a leaver is paid in full. Mirrors the canonical
 * threshold in src/lib/payroll/copilot/proration.ts (computeResignationSettlement);
 * the settlement below still asks that function for the verdict, so this constant only
 * exists for the Excel-formula path, which cannot call it.
 */
const RESIGNATION_FULL_PAY_AFTER_DAY = 25;

/**
 * Which lifecycle branch a Ready-Payroll row falls in. Drives the Base
 * proration, the ECOL/Fuel verdict and the row's Comment together, so the
 * three can never disagree with each other.
 */
export type ReadyLifecycleBranch =
  | "none"
  | "joiner"
  | "leaver_on_or_before_25"
  | "leaver_after_25"
  | "leaver_non_resignation";

export type ReadyLifecycleSettlement = {
  branch: ReadyLifecycleBranch;
  /** Goes into Other Deductions. Base Salary only — never touches allowances. */
  baseProrationDeduction: number;
  /** Post-rule ECOL for this row. */
  extraCostOfLiving: number;
  /** Post-rule Fuel for this row. */
  fuelAllowance: number;
  /** The last paid day actually charged for, after the >25th waiver. */
  effectiveEndDay: number;
};

/**
 * RESIGNATION RULE 1 (owner-confirmed), applied to the Ready-Payroll sheet.
 *
 *   last working day ≤ 25th → Base prorated to the days worked. NO ECOL, NO Fuel.
 *   last working day > 25th → Base paid in FULL. ECOL in FULL, Fuel in FULL.
 *
 * The rule already existed in src/lib/payroll/copilot/proration.ts
 * (computeResignationSettlement) and drives Automated Payroll. It had never
 * existed here, so the sheet HR actually uploads contradicted it twice over: it
 * zeroed ECOL and Fuel for EVERY leaver regardless of date, and it prorated the
 * base for a leaver who by rule should be paid in full. A rep resigning on the
 * 28th lost both allowances outright AND was docked several days of base. The
 * row's Comment even shipped the wrong rule into the workbook as though it were
 * policy.
 *
 * The 25-day threshold and the ECOL/Fuel verdict are taken from the canonical
 * function rather than re-tested here, so the two engines cannot drift.
 *
 * ONE DELIBERATE REFINEMENT over calling it outright: the >25th branch pays the
 * base "in full", which is correct for the ordinary leaver who was employed all
 * month. Someone HIRED this same month and leaving after the 25th did not work
 * the whole month, and paying them a full base would overpay. So the waiver is
 * applied to the LEAVING end only — the row is treated as worked-to-month-end,
 * while a mid-month hire still charges its own start-of-month days. For the
 * ordinary leaver (hired long ago) that is exactly "base in full"; for the rare
 * hired-and-left-in-one-month row it is the honest number instead of a windfall.
 *
 * JOINER ECOL/FUEL: owner decision 2026-08-09 — the Ready sheet keeps paying
 * BOTH IN FULL. The canonical computeJoinerPay halves them after the 15th, and
 * this module deliberately does NOT adopt that here, because it would reduce a
 * real person's pay. Revisit only on an explicit owner instruction.
 *
 * RESIGNATION ONLY (owner ruling 2026-08-14): Rule 1's >25th generosity — base
 * paid in full, both allowances kept — applies ONLY to genuine resignations.
 * A `terminated` (dismissed) or `inactive` (deactivated) leaver is NOT a
 * resignation, so `isResignation` gates the whole rule: a non-resignation leaver
 * keeps NEITHER allowance and has base prorated to the days actually worked, with
 * NO >25th waiver — exactly what the sheet did for every leaver before Rule 1,
 * now scoped so it can no longer hand a late-month dismissal a full month of base
 * plus both allowances. The canonical automated engine likewise keys its leavers
 * off the resignation workflow (employee_resignations), never the broad
 * employmentStatus set, so gating here keeps the two engines from diverging on
 * WHO counts as a resignation.
 */
export function resolveReadyLifecycleSettlement(input: {
  baseSalary: number;
  /** Standard ECOL for the row, BEFORE any lifecycle rule is applied. */
  extraCostOfLiving: number;
  /** Standard Fuel for the row, BEFORE any lifecycle rule is applied. */
  fuelAllowance: number;
  hireDate: string | null;
  /** True only for a genuine resignation. Termination/deactivation is false. */
  isResignation: boolean;
  lastWorkingDate: string | null;
  month: number;
  year: number;
}): ReadyLifecycleSettlement {
  const { baseSalary, extraCostOfLiving, fuelAllowance, hireDate, isResignation, lastWorkingDate, month, year } = input;
  const daysInMonth = payrollDaysInMonth(month, year);
  const leavingThisMonth = payrollMonthMatches(lastWorkingDate, month, year);
  const joiningThisMonth = payrollMonthMatches(hireDate, month, year);

  if (leavingThisMonth && !isResignation) {
    // Termination / deactivation, NOT a resignation: no Rule 1 generosity. Base
    // prorated to the days actually worked (both ends, no >25th waiver) and both
    // allowances withheld — the pre-Rule-1 leaver treatment, now scoped to
    // non-resignations so it can no longer overpay a late-month dismissal.
    return {
      branch: "leaver_non_resignation",
      baseProrationDeduction: calculateBaseLifecycleProrationDeduction(
        baseSalary,
        hireDate,
        lastWorkingDate,
        month,
        year,
      ),
      effectiveEndDay: prorationEndDay(lastWorkingDate, month, year),
      extraCostOfLiving: 0,
      fuelAllowance: 0,
    };
  }

  if (leavingThisMonth) {
    // isResignation is necessarily true here — the non-resignation leaver returned above.
    const settlement = computeResignationSettlement({
      baseSalary,
      extraCostOfLiving,
      fuelAllowance,
      lastWorkingDate: String(lastWorkingDate),
      otherAdditions: 0,
      otherDeductions: 0,
      period: { month, year },
      unpaidDaysInSpan: 0,
    });

    if (settlement) {
      const paidToMonthEnd = settlement.branch === "after_25";
      // Waive the LEAVING end only (see the refinement note above) by charging as
      // though the employee stayed to month end; a same-month hire still pays for
      // its own unworked start-of-month days. Same helper the Excel formula uses.
      const effectiveEndDay = prorationEffectiveEndDay(lastWorkingDate, month, year);
      const startDay = prorationStartDay(hireDate, month, year);
      const eligibleDays = Math.max(0, effectiveEndDay - startDay + 1);
      const baseProrationDeduction =
        startDay <= 1 && effectiveEndDay >= daysInMonth
          ? 0
          : roundCurrency(Math.max(0, baseSalary - (baseSalary / daysInMonth) * eligibleDays));

      return {
        branch: paidToMonthEnd ? "leaver_after_25" : "leaver_on_or_before_25",
        baseProrationDeduction,
        effectiveEndDay,
        extraCostOfLiving: settlement.ecolPaid,
        fuelAllowance: settlement.fuelPaid,
      };
    }
  }

  // Joiner, or an ordinary full-month row. Allowances pass through untouched.
  return {
    branch: joiningThisMonth ? "joiner" : "none",
    baseProrationDeduction: calculateBaseLifecycleProrationDeduction(
      baseSalary,
      hireDate,
      lastWorkingDate,
      month,
      year,
    ),
    effectiveEndDay: prorationEndDay(lastWorkingDate, month, year),
    extraCostOfLiving: roundCurrency(extraCostOfLiving),
    fuelAllowance: roundCurrency(fuelAllowance),
  };
}

/**
 * The row's Comment, derived from the SAME settlement that moved the money.
 *
 * The comment is not decoration — it is shipped inside the workbook and read as the
 * statement of policy. It used to be written independently of the calculation and said
 * "Cost of living and fuel are zero; base salary is prorated through last working date."
 * for EVERY leaver, which was the wrong rule for anyone leaving after the 25th and
 * described numbers the sheet had not actually produced. Deriving it from the branch
 * makes the two impossible to contradict.
 *
 * Returns null when no lifecycle rule applied, so the caller supplies its own default.
 */
export function readyLifecycleComment(settlement: ReadyLifecycleSettlement): string | null {
  switch (settlement.branch) {
    case "leaver_after_25":
      return "Resignation payroll row. Last working day after the 25th: base salary paid in full, plus cost of living and fuel in full.";
    case "leaver_on_or_before_25":
      return "Resignation payroll row. Last working day on or before the 25th: base salary prorated to the days worked; no cost of living and no fuel.";
    case "leaver_non_resignation":
      return "Termination/deactivation payroll row (not a resignation): base salary prorated to the last working day; no cost of living and no fuel.";
    case "joiner":
      return "Partial-month hire. Base salary prorated from the hire date on the month's real calendar days; cost of living and fuel paid in full.";
    default:
      return null;
  }
}
