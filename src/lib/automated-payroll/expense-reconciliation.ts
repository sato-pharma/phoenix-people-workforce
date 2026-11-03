import type { ExpenseApprovalState } from "@/lib/outstation/approval-state";
import { roundCurrency } from "@/lib/payroll/money";

/**
 * DID THE PAYSLIP PAY THE EXPENSES THAT WERE APPROVED? (owner, 2026-11-03)
 *
 * The twin of `deduction-reconciliation.ts`, for the money going the other way. Nothing answered this:
 * an approved trip that missed the Expenses step, or a figure typed over it, sat there unless somebody
 * added it up by hand.
 *
 * 🔴 IT REPORTS. It writes nothing, recommends nothing and offers no action, and a difference is NOT a
 * defect: HR types a different amount in the step deliberately, which is why the words are "different
 * amount" and "no approved trip this month", never "wrong".
 *
 * WHAT THE PURE PART DELIBERATELY DOES NOT KNOW.
 *   - The import stamp. An empty `imported_payroll_batch_id` never means unpaid: July and August
 *     published with no stamp at all, on purpose (expense-stamp.ts). Only the payslip says paid.
 *   - Whether a month is published. The loader never hands in an unpublished month's salaries; it says
 *     "not published yet", because an unpublished month read as unpaid would be every trip at once.
 *
 * 🔴 "MAY HAVE BEEN CARRIED" IS AN INFERENCE AND IS NEVER NETTED OFF. Expenses have no carry-forward
 * ledger. When the next or previous month is off by the opposite amount that is a likely explanation,
 * so the row says so and both figures still show.
 */

/** Under half a pound is rounding, not a finding. */
export const EXPENSE_GAP_TOLERANCE = 0.5;

export type ExpenseTripFact = {
  compact: string;
  state: ExpenseApprovalState;
  /** payableExpenseAmount: HR's edited figure when there is one, the claim otherwise. */
  payable: number;
};

export type ExpensePaidFact = {
  compact: string;
  fullName: string;
  expenses: number;
};

export type ExpenseFinding =
  | "approved not paid"
  | "no approved trip this month"
  | "different amount"
  | "may have been carried"
  | "held at publish";

export type ExpenseReconciliationRow = {
  compact: string;
  fullName: string;
  finding: ExpenseFinding;
  approved: number;
  paid: number;
  /** Paid minus approved. */
  gap: number;
  pending: number;
  note: string | null;
};

export type ExpenseReconciliationReport = {
  rows: ExpenseReconciliationRow[];
  matches: number;
  approvedTotal: number;
  paidTotal: number;
  /** Trips neither side has decided, shown so a "no approved trip" row can be read. */
  pendingTotal: number;
};

export type ExpenseMonthFacts = {
  trips: readonly ExpenseTripFact[];
  paid: readonly ExpensePaidFact[];
};

function totals(facts: ExpenseMonthFacts) {
  const byPerson = new Map<string, { approved: number; pending: number; paid: number; fullName: string }>();
  const entry = (compact: string) => {
    let row = byPerson.get(compact);
    if (!row) {
      row = { approved: 0, fullName: "", paid: 0, pending: 0 };
      byPerson.set(compact, row);
    }
    return row;
  };
  for (const trip of facts.trips) {
    if (!trip.compact) continue;
    const row = entry(trip.compact);
    // A rejected trip is never paid and is not part of any figure here.
    if (trip.state === "approved") row.approved = roundCurrency(row.approved + trip.payable);
    if (trip.state === "pending") row.pending = roundCurrency(row.pending + trip.payable);
  }
  for (const salary of facts.paid) {
    if (!salary.compact) continue;
    const row = entry(salary.compact);
    row.paid = roundCurrency(row.paid + salary.expenses);
    if (salary.fullName) row.fullName = salary.fullName;
  }
  return byPerson;
}

/** Each person's paid-minus-approved for one month. Only what differs is kept. */
export function expenseMonthGaps(facts: ExpenseMonthFacts): Map<string, number> {
  const gaps = new Map<string, number>();
  for (const [compact, row] of totals(facts)) {
    const gap = roundCurrency(row.paid - row.approved);
    if (Math.abs(gap) > EXPENSE_GAP_TOLERANCE) gaps.set(compact, gap);
  }
  return gaps;
}

function offsetsAdjacent(gap: number, adjacent: number | undefined): boolean {
  return adjacent !== undefined && Math.abs(gap + adjacent) <= EXPENSE_GAP_TOLERANCE;
}

export function reconcileExpenses(input: {
  month: ExpenseMonthFacts;
  /** The gaps of the months either side, when they are published. Only used to word a row. */
  previousGaps?: ReadonlyMap<string, number>;
  nextGaps?: ReadonlyMap<string, number>;
  /** Held at publish: left out of the published rows, so absent is not unpaid. */
  heldCompacts: ReadonlySet<string>;
  /** Terminal employment status: may be settled in a final settlement, which is not in salary_records. */
  leftCompacts: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}): ExpenseReconciliationReport {
  const rows: ExpenseReconciliationRow[] = [];
  let matches = 0;
  let approvedTotal = 0;
  let paidTotal = 0;
  let pendingTotal = 0;

  for (const [compact, person] of totals(input.month)) {
    approvedTotal = roundCurrency(approvedTotal + person.approved);
    paidTotal = roundCurrency(paidTotal + person.paid);
    pendingTotal = roundCurrency(pendingTotal + person.pending);
    const gap = roundCurrency(person.paid - person.approved);
    const fullName = person.fullName || input.names.get(compact) || "Name not on file";
    const base = { approved: person.approved, compact, fullName, gap, paid: person.paid, pending: person.pending };

    if (input.heldCompacts.has(compact)) {
      if (person.approved === 0 && person.paid === 0) continue;
      rows.push({ ...base, finding: "held at publish", note: "Held when the month published, so the payslip is not the answer yet." });
      continue;
    }
    if (Math.abs(gap) <= EXPENSE_GAP_TOLERANCE) {
      if (person.approved !== 0 || person.paid !== 0) matches += 1;
      continue;
    }

    const carriedTo = offsetsAdjacent(gap, input.nextGaps?.get(compact));
    const carriedFrom = offsetsAdjacent(gap, input.previousGaps?.get(compact));
    if (carriedTo || carriedFrom) {
      rows.push({
        ...base,
        finding: "may have been carried",
        note: carriedTo
          ? "The next month's payslip is off by the opposite amount. An inference: expenses have no carry-forward record."
          : "The previous month's payslip is off by the opposite amount. An inference: expenses have no carry-forward record.",
      });
      continue;
    }
    if (person.paid === 0) {
      rows.push({
        ...base,
        finding: "approved not paid",
        note: input.leftCompacts.has(compact) ? "Has left. A final settlement may have paid this, and this check cannot read one." : null,
      });
      continue;
    }
    if (person.approved === 0) {
      rows.push({
        ...base,
        finding: "no approved trip this month",
        note: person.pending > 0 ? "A trip is still undecided." : null,
      });
      continue;
    }
    rows.push({ ...base, finding: "different amount", note: null });
  }

  rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.fullName.localeCompare(b.fullName));
  return { approvedTotal, matches, paidTotal, pendingTotal, rows };
}

/** The month the screen's address asks for, only when it is one the screen offers. */
export function pickExpenseMonth<T extends { month: number; year: number }>(asked: string | null, months: readonly T[]): T | null {
  const match = /^(\d{4})-(\d{2})$/.exec(asked ?? "");
  if (!match) return null;
  return months.find((period) => period.year === Number(match[1]) && period.month === Number(match[2])) ?? null;
}

/** July and August 2026 published with figures HR typed into the sheet, so a difference there is expected. */
export function expenseMonthWasTypedByHand(month: number, year: number): boolean {
  return year === 2026 && (month === 7 || month === 8);
}
