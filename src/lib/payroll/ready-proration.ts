import { parseDateOnly } from "@/lib/date-only";
import { calendarDaysInMonth } from "@/lib/payroll/copilot/proration";
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
