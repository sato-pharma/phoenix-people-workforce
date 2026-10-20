// HR Daily & Weekly Reports — what a row's days would cost. THE HR MANAGER'S VIEW ONLY.
//
// Her screens never call this, and the one route that does (`GET /api/hr-ops-reports/[id]/priced`)
// asserts `hr_ops_reports:approve` — which only the Super Admin holds — and refuses a salary-blind
// seat on top, so the amount never reaches her even if the matrix were widened by mistake.
//
// A day is priced the way every day-based deduction is (and the way bridge.ts prices the day it
// hands to the weekly attendance review): base salary ÷ the work month's calendar days × days.
// The figure is a preview for the decision; the payroll run prices the deduction itself.

import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { isDeductionExemptEmployee } from "@/lib/deductions/exempt-employees";
import { compactHrKey, getBaseSalaryMap } from "@/lib/payroll/copilot/feeders";

import { defaultDecisionDays } from "./rules";
import { toDays, type HrOpsReportLineRow } from "./types";

export type HrOpsLinePrice = {
  lineId: string;
  /** The days the figure prices: the decided days, else the days an Approve would start from. */
  days: number | null;
  /** EGP. Null when there is nothing to price, the person is exempt, or no base salary is recorded. */
  amount: number | null;
  /** Why there is no amount, in words; null when there is one (or nothing to price). */
  note: string | null;
};

type PricedLine = Pick<
  HrOpsReportLineRow,
  "id" | "hr_id" | "work_date" | "decision" | "decided_days" | "review_action" | "recommended_days" | "suggested_days" | "carried_from_line_id"
>;

/**
 * The days a row's figure is for. A rejected row prices nothing, and neither does a weekly row
 * CARRIED from its daily report — that day is priced where it was decided, never twice.
 */
export function daysToPrice(line: PricedLine): number | null {
  if (line.carried_from_line_id) return null;
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

/** Pure: price each row against a salary map. */
export function priceLines(lines: readonly PricedLine[], salaries: ReadonlyMap<string, number>): HrOpsLinePrice[] {
  return lines.map((line) => {
    const days = daysToPrice(line);
    if (days === null || days <= 0) return { amount: null, days, lineId: line.id, note: null };
    if (isDeductionExemptEmployee(line.hr_id)) {
      return { amount: null, days, lineId: line.id, note: "Exempt from deductions." };
    }
    const salary = salaryFor(salaries, line.hr_id);
    if (salary === null) return { amount: null, days, lineId: line.id, note: "No base salary is recorded." };
    const [year, month] = line.work_date.split("-").map(Number);
    const amount = calculateDeductionAmountFromBaseSalary({ baseSalary: salary, deductionDays: days, month: month!, year: year! });
    return { amount, days, lineId: line.id, note: amount === null ? "The day could not be priced." : null };
  });
}

/** Price a report's rows from the live salary list. */
export async function priceReportLines(lines: readonly PricedLine[]): Promise<{ prices: HrOpsLinePrice[]; total: number }> {
  const salaries = await getBaseSalaryMap();
  const prices = priceLines(lines, salaries);
  const total = Math.round(prices.reduce((sum, price) => sum + (price.amount ?? 0), 0) * 100) / 100;
  return { prices, total };
}
