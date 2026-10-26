// The employee portal's deduction ledger: its filters and its totals, as pure functions.
//
// Owner, 2026-10-09: "employee can filter by another month or period or type or status". The rows a
// person owns are a handful, not a page of a company-wide table, so the whole September-onwards set
// is sent once and the three filters run in the browser — every change is instant and costs no
// round trip. Keeping them pure also means the totals are tested without a database or a render.
//
// NOTHING HERE READS THE DATABASE, so the client component may import it. The read itself lives in
// portal.ts, which pulls in the Supabase admin client and must never reach a client bundle.

import type { DeductionsPortalLedgerRow } from "./types.ts";

/** Every filter accepts this when the employee has not narrowed that dimension. */
export const PORTAL_LEDGER_ANY = "all";

export type PortalLedgerFilters = {
  /** A payroll month key ("2026-09"), or {@link PORTAL_LEDGER_ANY}. */
  monthKey?: string;
  /** A deduction category, or {@link PORTAL_LEDGER_ANY}. */
  category?: string;
  /** A {@link DeductionsPortalLedgerRow.outcome}, or {@link PORTAL_LEDGER_ANY}. */
  status?: string;
};

/** What each outcome is called on the employee's own screen — his words, not the module's. */
export const PORTAL_LEDGER_OUTCOME_LABEL: Record<DeductionsPortalLedgerRow["outcome"], string> = {
  on_payslip: "Deducted from salary",
  cleared: "Cleared — nothing deducted",
  under_review: "Under review",
  needs_follow_up: "HR needs more information",
  disputed: "Disputed",
};

/** One line saying what the status means for the person, so a badge never has to be interpreted. */
export const PORTAL_LEDGER_OUTCOME_EXPLANATION: Record<DeductionsPortalLedgerRow["outcome"], string> = {
  on_payslip: "HR approved this, so it is taken from your salary for this month.",
  cleared: "HR looked at this and decided not to deduct anything.",
  under_review: "The system flagged this. HR has not decided yet, and nothing is deducted until they do.",
  needs_follow_up: "HR is still checking this one. Nothing is deducted while it is open.",
  disputed: "This one is being contested. Nothing is settled yet.",
};

/**
 * What an employee's own row says where the reply box would be, when it offers none. The box is
 * only on a released line (portal.ts, `canComment`), and the old single sentence promised every
 * other row a reply "once it is released" — a cleared row never is: nothing was deducted, so
 * there is nothing to dispute (Pedia NSM page audit, 2026-10-26).
 */
export const PORTAL_LEDGER_NO_REPLY_NOTE: Record<DeductionsPortalLedgerRow["outcome"], string> = {
  on_payslip: "You can reply to HR on this one once it is released with the month's deductions.",
  cleared: "Nothing was deducted, so there is nothing to dispute.",
  under_review: "Nothing is deducted while HR decides. If it is approved, you can reply here once it is released.",
  needs_follow_up: "Nothing is deducted while HR decides. If it is approved, you can reply here once it is released.",
  disputed: "Nothing is settled yet. HR's answer will show here.",
};

/**
 * A note HR left as a placeholder ("-", "--", ".") says nothing, and printed as "HR note: -" it
 * reads like a missing value. Treated as no note at all.
 */
export function meaningfulHrText(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^[\s\-–—._/]*$/.test(text) ? null : text;
}

/** The payroll months present in the rows, newest first. */
export function portalLedgerMonthKeys(rows: readonly DeductionsPortalLedgerRow[]): string[] {
  return Array.from(new Set(rows.map((row) => row.monthKey))).sort((left, right) => right.localeCompare(left));
}

/** The deduction types present in the rows, alphabetical by code (the UI labels them). */
export function portalLedgerCategories(rows: readonly DeductionsPortalLedgerRow[]): string[] {
  return Array.from(new Set(rows.map((row) => String(row.category)))).sort();
}

/** The statuses present in the rows, in the fixed order the labels are declared in. */
export function portalLedgerStatuses(rows: readonly DeductionsPortalLedgerRow[]): Array<DeductionsPortalLedgerRow["outcome"]> {
  const present = new Set(rows.map((row) => row.outcome));
  return (Object.keys(PORTAL_LEDGER_OUTCOME_LABEL) as Array<DeductionsPortalLedgerRow["outcome"]>).filter((outcome) =>
    present.has(outcome),
  );
}

/**
 * Narrow the rows by month, type and status. An absent or {@link PORTAL_LEDGER_ANY} value does not
 * narrow that dimension; an unknown value matches nothing, so a hand-typed filter cannot silently
 * widen the list back to everything.
 */
export function filterPortalLedgerRows(
  rows: readonly DeductionsPortalLedgerRow[],
  filters: PortalLedgerFilters,
): DeductionsPortalLedgerRow[] {
  const wanted = (value: string | undefined) => {
    const text = String(value ?? "").trim();
    return !text || text === PORTAL_LEDGER_ANY ? null : text;
  };
  const monthKey = wanted(filters.monthKey);
  const category = wanted(filters.category);
  const status = wanted(filters.status);
  return rows.filter(
    (row) =>
      (monthKey === null || row.monthKey === monthKey) &&
      (category === null || String(row.category) === category) &&
      (status === null || row.outcome === status),
  );
}

/**
 * The figures above the list. `chargedAmount` is money actually taken, so only an approved row adds
 * to it — a cleared or still-undecided row contributes zero by construction (see mapPortalLedgerRow),
 * and the counts beside it are what tell the person the rest of the list exists.
 */
export function summarizePortalLedger(rows: readonly DeductionsPortalLedgerRow[]): {
  total: number;
  deductedAmount: number;
  deductedDays: number;
  deductedCount: number;
  clearedCount: number;
  openCount: number;
} {
  let deductedAmount = 0;
  let deductedDays = 0;
  let deductedCount = 0;
  let clearedCount = 0;
  let openCount = 0;
  for (const row of rows) {
    if (row.outcome === "on_payslip") {
      deductedCount += 1;
      deductedAmount += row.chargedAmount;
      if (row.unit === "days") deductedDays += row.chargedValue;
    } else if (row.outcome === "cleared") {
      clearedCount += 1;
    } else {
      openCount += 1;
    }
  }
  return {
    total: rows.length,
    deductedAmount,
    deductedDays,
    deductedCount,
    clearedCount,
    openCount,
  };
}
