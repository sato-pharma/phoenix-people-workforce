/**
 * Per-employee roll-up of the outstation expense approvals queue.
 *
 * The queue answers "which trip do I decide next". This answers the other question the same data
 * holds — "where does each person stand": how many of their trips are approved, how many were
 * rejected, how much is still undecided, and what that is worth.
 *
 * It is built from the caller's CURRENT decisions, not from what is stored, so a trip approved a
 * moment ago and not yet saved counts as approved here exactly as it does in the tab counts. The
 * alternative — summarising the saved rows — would show a reviewer a total that contradicts the
 * screen they are looking at.
 */

import { expenseEmployeeKey } from "@/lib/outstation/expense-approval-filters";
import type { ExpenseApprovalState } from "@/lib/outstation/approval-state";

export type ExpenseApprovalSummaryRow = {
  /** Declared AM workload from the expense sheet — NOT the CRM evidence figure. */
  amWorkload: number;
  approvedAmount: number;
  claimedTotal: number;
  date: string;
  destination: string;
  km: number;
  /** Declared pharmacy visits — the third figure, never inside AM/PM. NULL/absent = not counted
   * separately (a pre-split, hand-typed or imported trip). */
  pharmacyWorkload?: number | null;
  /** Declared PM workload from the expense sheet — NOT the CRM evidence figure. */
  pmWorkload: number;
  specialist: string;
  state: ExpenseApprovalState;
  /** The trip's last day — the per-employee rows name a multi-day trip's length (2026-11-06). */
  toDate?: string;
  tripId: string;
};

export type ExpenseApprovalEmployeeSummary = {
  approvedCount: number;
  /** What the approved trips actually pay — HR's figure, never the raw claim. */
  approvedValue: number;
  claimedTotal: number;
  employeeKey: string;
  employeeLabel: string;
  pendingCount: number;
  pendingValue: number;
  rejectedCount: number;
  /** What was claimed on the rejected trips — the money NOT being paid out. */
  rejectedValue: number;
  totalCount: number;
  trips: ExpenseApprovalSummaryRow[];
};

function preferredLabel(existing: string | undefined, candidate: string): string {
  if (existing === undefined) return candidate;
  // Same rule the filter dropdown uses: a human-written name beats a login-style handle.
  if (/[._]/.test(existing) && !/[._]/.test(candidate)) return candidate;
  return existing;
}

/**
 * Groups rows by the SAME employee key the filter dropdown uses, so a person who appears once in
 * the Employee filter also appears once here — the two views can never disagree about who exists.
 *
 * Ordering puts whoever still owes the most decisions first (then the largest claim, then name),
 * because the reason to open this tab is to find where the outstanding work sits. Each employee's
 * own trips stay newest-first, matching the queue.
 */
export function buildExpenseApprovalEmployeeSummary(
  rows: ReadonlyArray<ExpenseApprovalSummaryRow>,
): ExpenseApprovalEmployeeSummary[] {
  const byEmployee = new Map<string, ExpenseApprovalEmployeeSummary>();

  for (const row of rows) {
    const employeeKey = expenseEmployeeKey(row);
    const existing = byEmployee.get(employeeKey);
    const summary: ExpenseApprovalEmployeeSummary = existing ?? {
      approvedCount: 0,
      approvedValue: 0,
      claimedTotal: 0,
      employeeKey,
      employeeLabel: "",
      pendingCount: 0,
      pendingValue: 0,
      rejectedCount: 0,
      rejectedValue: 0,
      totalCount: 0,
      trips: [],
    };

    summary.employeeLabel = preferredLabel(
      existing?.employeeLabel || undefined,
      String(row.specialist ?? "").replace(/\s+/g, " ").trim() || "Unassigned",
    );
    summary.totalCount += 1;
    summary.claimedTotal += row.claimedTotal;
    summary.trips.push(row);

    if (row.state === "approved") {
      summary.approvedCount += 1;
      summary.approvedValue += row.approvedAmount;
    } else if (row.state === "rejected") {
      summary.rejectedCount += 1;
      summary.rejectedValue += row.claimedTotal;
    } else {
      summary.pendingCount += 1;
      summary.pendingValue += row.approvedAmount;
    }

    byEmployee.set(employeeKey, summary);
  }

  const summaries = [...byEmployee.values()];
  for (const summary of summaries) {
    summary.trips.sort((left, right) => tripTime(right.date) - tripTime(left.date));
  }

  return summaries.sort(
    (left, right) =>
      right.pendingCount - left.pendingCount ||
      right.claimedTotal - left.claimedTotal ||
      left.employeeLabel.localeCompare(right.employeeLabel),
  );
}

function tripTime(date: string): number {
  const parsed = new Date(String(date ?? ""));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/**
 * Company-wide line for the summary header, so the per-person rows have something to add up to.
 *
 * Carries BOTH money figures on purpose. `claimedTotal` is what staff asked for across every trip;
 * `approvedValue` is what the approved trips actually pay. A header quoting only one of them is
 * ambiguous exactly where it matters, and the two are not interchangeable — they cover different
 * sets of trips, so their difference is NOT the approval trim (the queue's own "below the claim"
 * card is the figure for that). Showing both side by side is what stops one being read as the other.
 */
export function totalExpenseApprovalSummary(
  summaries: ReadonlyArray<ExpenseApprovalEmployeeSummary>,
): {
  approvedCount: number;
  approvedValue: number;
  claimedTotal: number;
  employeeCount: number;
  pendingCount: number;
  rejectedCount: number;
} {
  return summaries.reduce(
    (running, summary) => ({
      approvedCount: running.approvedCount + summary.approvedCount,
      approvedValue: running.approvedValue + summary.approvedValue,
      claimedTotal: running.claimedTotal + summary.claimedTotal,
      employeeCount: running.employeeCount + 1,
      pendingCount: running.pendingCount + summary.pendingCount,
      rejectedCount: running.rejectedCount + summary.rejectedCount,
    }),
    {
      approvedCount: 0,
      approvedValue: 0,
      claimedTotal: 0,
      employeeCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
    },
  );
}
