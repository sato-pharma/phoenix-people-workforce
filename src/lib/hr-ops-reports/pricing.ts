// HR Daily & Weekly Reports — what a row's days would cost. THE HR MANAGER'S VIEW ONLY.
//
// Her screens never call this, and the one route that does (`GET /api/hr-ops-reports/[id]/priced`)
// asserts `hr_ops_reports:approve` — which only the Super Admin holds — and refuses a salary-blind
// seat on top, so the amount never reaches her even if the matrix were widened by mistake.
//
// A day is priced the way every day-based deduction is (and the way bridge.ts prices the day it
// hands to the weekly attendance review): base salary ÷ the work month's calendar days × days.
// The figure is a preview for the decision; the payroll run prices the deduction itself.
//
// UNAVAILABLE IS NEVER ZERO. The salary feeder (getBaseSalaryMap) swallows a failed read and hands
// back an EMPTY map, so an empty map is read as "the salary list could not be read": every row is
// "Not priced", and the total is null — never "EGP 0.00" — whenever any row with days could not be
// priced. A row the weekly review never lists ("Not carried") and an exempt person have no amount by
// design, and are said so; neither is a zero.

import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { isDeductionExemptEmployee } from "@/lib/deductions/exempt-employees";
import { compactHrKey, getBaseSalaryMap } from "@/lib/payroll/copilot/feeders";

import { defaultDecisionDays, isCarried, reachesWeeklyReview } from "./rules";
import { toDays, type HrOpsReportLineRow } from "./types";

/**
 *   priced      — `amount` is the figure.
 *   nothing     — no days to price (rejected, zero, carried from another report, or no figure yet).
 *   not_carried — an office day the weekly attendance review never lists: nothing of it reaches payroll.
 *   exempt      — the person is out of every automated deduction.
 *   not_priced  — there are days, but no figure could be worked out (no salary, or the list unread).
 */
export type HrOpsPriceStatus = "priced" | "nothing" | "not_carried" | "exempt" | "not_priced";

export type HrOpsLinePrice = {
  lineId: string;
  /** The days the figure prices: the decided days, else the days an Approve would start from. */
  days: number | null;
  /** EGP, only when `status` is `priced`. Never 0 for a row that could not be priced. */
  amount: number | null;
  status: HrOpsPriceStatus;
  /** Why there is no amount, in words; null when there is one (or nothing to price). */
  note: string | null;
};

export type HrOpsReportPrices = {
  prices: HrOpsLinePrice[];
  /** The sum of the priced rows; NULL whenever any row with days could not be priced. */
  total: number | null;
  /** Why there is no total, in words; null when there is one. */
  totalNote: string | null;
};

export type PricedLine = Pick<
  HrOpsReportLineRow,
  | "id"
  | "hr_id"
  | "work_date"
  | "section"
  | "flags"
  | "decision"
  | "decided_days"
  | "review_action"
  | "recommended_days"
  | "suggested_days"
  | "carried_from_line_id"
  | "decided_elsewhere"
>;

export const NOT_CARRIED_PRICE_NOTE = "Not carried to payroll — the weekly attendance review never lists this day, so it has no amount.";
export const SALARY_LIST_UNREAD_NOTE = "Not priced: the salary list could not be read.";

/**
 * The days a row's figure is for. A rejected row prices nothing, and neither does a row CARRIED from
 * another report — that day is priced where it was decided, never twice.
 */
export function daysToPrice(line: PricedLine): number | null {
  if (isCarried(line)) return null;
  if (line.decision === "rejected") return null;
  if (line.decision === "approved") return toDays(line.decided_days);
  return defaultDecisionDays(line);
}

function salaryFor(salaries: ReadonlyMap<string, number>, hrId: string): number | null {
  const keys = [compactDeductionsHrId(hrId), compactHrKey(hrId)].filter((key): key is string => Boolean(key));
  for (const key of keys) {
    const salary = salaries.get(key);
    if (typeof salary === "number" && salary > 0) return salary;
  }
  return null;
}

/**
 * Pure: price each row against a salary map. `null` — or an EMPTY map, which is what the feeder
 * returns when its read failed — means the list was not read: every row with days is "Not priced".
 */
export function priceLines(lines: readonly PricedLine[], salaries: ReadonlyMap<string, number> | null): HrOpsLinePrice[] {
  const readable = salaries && salaries.size > 0 ? salaries : null;
  return lines.map((line): HrOpsLinePrice => {
    const days = daysToPrice(line);
    if (days === null || days <= 0) return { amount: null, days, lineId: line.id, note: null, status: "nothing" };
    if (!reachesWeeklyReview(line)) return { amount: null, days, lineId: line.id, note: NOT_CARRIED_PRICE_NOTE, status: "not_carried" };
    if (isDeductionExemptEmployee(line.hr_id)) {
      return { amount: null, days, lineId: line.id, note: "Exempt from deductions.", status: "exempt" };
    }
    if (!readable) return { amount: null, days, lineId: line.id, note: SALARY_LIST_UNREAD_NOTE, status: "not_priced" };
    const salary = salaryFor(readable, line.hr_id);
    if (salary === null) return { amount: null, days, lineId: line.id, note: "Not priced: no base salary is recorded.", status: "not_priced" };
    const [year, month] = line.work_date.split("-").map(Number);
    const amount = calculateDeductionAmountFromBaseSalary({ baseSalary: salary, deductionDays: days, month: month!, year: year! });
    if (amount === null) return { amount: null, days, lineId: line.id, note: "Not priced: the day could not be priced.", status: "not_priced" };
    return { amount, days, lineId: line.id, note: null, status: "priced" };
  });
}

/** Pure: the rows' prices and their total. The total is null — never a zero — when any row could not be priced. */
export function priceReport(lines: readonly PricedLine[], salaries: ReadonlyMap<string, number> | null): HrOpsReportPrices {
  const prices = priceLines(lines, salaries);
  const unpriced = prices.filter((price) => price.status === "not_priced").length;
  if (unpriced > 0) {
    const unread = !salaries || salaries.size === 0;
    return {
      prices,
      total: null,
      totalNote: unread
        ? "No total: the salary list could not be read, so no row is priced."
        : `No total: ${unpriced} ${unpriced === 1 ? "row" : "rows"} with days could not be priced.`,
    };
  }
  const total = Math.round(prices.reduce((sum, price) => sum + (price.status === "priced" ? price.amount ?? 0 : 0), 0) * 100) / 100;
  return { prices, total, totalNote: null };
}

/** Price a report's rows from the live salary list. A failed read is "not priced", never zero. */
export async function priceReportLines(lines: readonly PricedLine[]): Promise<HrOpsReportPrices> {
  let salaries: ReadonlyMap<string, number> | null = null;
  try {
    salaries = await getBaseSalaryMap();
  } catch {
    salaries = null;
  }
  return priceReport(lines, salaries);
}
