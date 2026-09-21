/**
 * THE HISTORICAL UPLOADS LIST SHOWS EACH REPORT'S LIVE ROW COUNT, NEVER THE STORED HEADER.
 *
 * `outstation_expense_reports` carries `row_count`, `total_expenses` and `approved_rows` header
 * columns, written when the sheet is first imported. A Replace or clear then removes the report's
 * rows but leaves the header untouched, so an emptied report keeps saying "327 rows / EGP 122,256".
 * Measured on production (ozucdzovmcqvepbozvqf) on 2026-09-21: eight reports named `import` all read
 * that same stale header while holding zero rows, beside the one `import` report that actually holds
 * the whole Feb–Jul ledger.
 *
 * On the admin "Historical Outstation Uploads" list that stale header is a data-loss trap: nine
 * lines read identically, and a Super Admin deleting the top one to clear the "duplicates" would
 * take the real ledger with it (no audit row, no payroll resync, no PITR). Showing the LIVE count
 * makes the empty shells read "0 rows · EGP 0 · 0 approved" and the real report read its true size,
 * so the two can never be confused.
 *
 * This is the pure half — it recomputes the three figures from the report's own expense rows so the
 * arithmetic is unit-tested without the database. `withLiveExpenseReportCounts` fetches the rows and
 * calls it; only the admin uploads route is enriched, so every other surface keeps the header.
 */
import type { PayrollExpenseReport } from "@/lib/payroll/types";

/** One `outstation_expenses` row, as far as a live report count is concerned. */
export type ExpenseReportRowForCount = {
  report_id?: unknown;
  total?: unknown;
  hr_approved?: unknown;
};

type LiveReportTotals = { rows: number; total: number; approved: number };

/**
 * Replace each report's `rowCount`/`totalExpenses`/`approvedRows` with the totals of the live rows
 * that carry its id. A report with no live rows becomes 0/0/0 — the point of the change, so an
 * emptied header can never masquerade as a full report. Order and every other field are untouched.
 */
export function applyLiveExpenseReportCounts(
  reports: ReadonlyArray<PayrollExpenseReport>,
  rows: ReadonlyArray<ExpenseReportRowForCount>,
): PayrollExpenseReport[] {
  const live = new Map<string, LiveReportTotals>();

  for (const row of rows) {
    const key = String(row.report_id ?? "");
    if (!key) continue;
    const totals = live.get(key) ?? { rows: 0, total: 0, approved: 0 };
    totals.rows += 1;
    totals.total += Number(row.total ?? 0);
    if (row.hr_approved) totals.approved += 1;
    live.set(key, totals);
  }

  return reports.map((report) => {
    const totals = live.get(report.id);
    return {
      ...report,
      rowCount: totals?.rows ?? 0,
      totalExpenses: totals?.total ?? 0,
      approvedRows: totals?.approved ?? 0,
    };
  });
}
