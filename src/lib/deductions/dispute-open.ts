/**
 * WHO MAY DISPUTE A DEDUCTION, AND WHAT A NOT-YET-PUSHED ONE LOOKS LIKE IN THE HR INBOX.
 *
 * Owner, 2026-11-13: "make the employee able to dispute in the deduction module, and if approved the
 * dispute fix his deduction and calendar, and if rejected then deduct". Until then a dispute was only
 * possible on a line already pushed to the payslip (his ruling of 2026-10-09, "a dispute is for money
 * actually taken"). Two holes followed from it:
 *   - the push gate is retired (2026-10-07), so an "Approved for Payroll" deduction is taken from the
 *     salary whether or not it was pushed — and an unpushed one could not be argued with at all;
 *   - his new words put the dispute BEFORE the money: a rejected dispute is what deducts.
 * So every deduction the employee can see may be disputed, except one already cleared ("Do Not Take
 * Action" — nothing is taken, so there is nothing to dispute; a decided dispute is reopened through the
 * Dispute Center, never by a new comment).
 *
 * Pure, no database — the comment gate, the portal row and the HR inbox all ask these same questions.
 */

import type { DeductionsCategory, DeductionsPortalLine, DeductionsSalaryRecordsColumn, DeductionsUnit } from "./types.ts";

/** The decision statuses that charge nothing YET — nobody has decided the deduction. */
const UNDECIDED_STATUSES = new Set(["", "Pending", "Needs Follow-up", "Disputed"]);

/** Has nobody decided this deduction yet? (No decision row reads as Pending.) */
export function isUndecidedDeductionStatus(status: string | null | undefined): boolean {
  return UNDECIDED_STATUSES.has(String(status ?? "").trim());
}

/** May the employee open (or continue) a dispute on it? Everything but a cleared deduction. */
export function deductionOpenForDispute(input: {
  decisionStatus: string | null | undefined;
  hasPublishedLine: boolean;
}): boolean {
  if (input.hasPublishedLine) return true;
  return String(input.decisionStatus ?? "").trim() !== "Do Not Take Action";
}

export type UnpublishedDisputeCandidate = {
  category: string;
  created_at?: string | null;
  dates: unknown;
  employee_hr_id: string;
  employee_hr_id_compact: string;
  employee_name: string | null;
  estimated_amount: number | string | null;
  id: string;
  month_key: string;
  raw_value: number | string | null;
  reason: string | null;
  unit: string | null;
};

export type UnpublishedDisputeDecision = {
  applied_amount?: number | string | null;
  applied_value?: number | string | null;
  decision_status: string | null;
  hr_note?: string | null;
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The line a disputed deduction with NO pushed line shows in the HR Disputes inbox, built from the
 * candidate itself. Approved-not-pushed carries what payroll charges (the decision's figure, the whole
 * detection when it was never narrowed); an undecided one charges 0.00 and says so (`pending`). A
 * cleared one returns null — it charges nothing and stays out of the inbox, as before.
 */
export function unpublishedDisputeLine(input: {
  candidate: UnpublishedDisputeCandidate;
  decision: UnpublishedDisputeDecision | null;
  payrollColumn: DeductionsSalaryRecordsColumn;
}): { line: DeductionsPortalLine; pending: boolean } | null {
  const { candidate, decision } = input;
  const status = String(decision?.decision_status ?? "").trim();
  if (status === "Do Not Take Action") return null;
  const approved = status === "Approved for Payroll";
  const detected = num(candidate.raw_value);
  const appliedValue = approved ? (decision?.applied_value == null ? detected : num(decision.applied_value)) : 0;
  const appliedAmount = approved
    ? decision?.applied_amount == null
      ? num(candidate.estimated_amount)
      : num(decision.applied_amount)
    : 0;
  return {
    line: {
      appliedAmount,
      appliedDeductionValue: appliedValue,
      candidateId: candidate.id,
      createdAt: String(candidate.created_at ?? ""),
      dates: Array.isArray(candidate.dates) ? (candidate.dates as unknown[]).map(String) : [],
      decisionId: "",
      deductionType: candidate.category as DeductionsCategory,
      deductionUnit: (candidate.unit === "amount" ? "amount" : "days") as DeductionsUnit,
      employeeCode: candidate.employee_hr_id,
      employeeHrIdCompact: candidate.employee_hr_id_compact,
      employeeName: candidate.employee_name,
      hrNote: decision?.hr_note ?? null,
      id: "",
      monthKey: candidate.month_key,
      originalDeductionValue: detected,
      payrollColumn: input.payrollColumn,
      reason: candidate.reason,
      sourceModule: "DEDUCTIONS_MODULE",
      summaryId: "",
    },
    pending: !approved,
  };
}
