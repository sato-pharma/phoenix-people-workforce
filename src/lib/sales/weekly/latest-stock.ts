// Stock on hand is a SNAPSHOT, never a flow. Sales value and units add up across weeks (de-cumulation
// telescopes), but adding two weeks' stock counts the same boxes twice. So before the weekly engine sums
// stock over a scope — the Stock Units tiles, the compare delta, the rankings' stock columns, the
// zero-sales branches, and the factRows both Excel books total — it keeps stock on ONE week per
// distributor and zeroes it on every other.
//
// That week is the distributor's LATEST in scope: its latest cycle month, then the latest week uploaded
// inside that month. Owner's decision, 2026-09-17 ("Latest week in scope", on screens and exports alike).
// Before it the week was kept per (distributor, cycle month), so any scope spanning months — a
// multi-month or exclude month filter, a week-number filter, the all-weeks default — added one month-end
// snapshot per month: Ibn Sina-Sato's August + September read 23,936 stock units when 11,071 were on
// hand. A one-month scope cannot move: with a single month in scope, the distributor's latest week IS
// that month's latest week.
//
// Month first, then week, is the order summary-workbook.ts's latestCycleMonthStockOnly applies to the
// Summarized Report's year-to-date stock, so that reduction changes nothing over the engine's rows
// instead of being a second rule that could disagree. A row with no cycle month (a legacy, untagged
// upload) ranks below every tagged month: it speaks for its distributor only when that distributor has
// no tagged week in scope, and then only on its latest week. It used to keep stock on every week.
//
// Only stockQty changes. Row count, order and every other field — sales value and units included — pass
// through untouched. The trend, the Week Comparison and the Weekly Stock page read each week's own
// snapshot and never come through here. Pure (see tests/weekly-stock-kpi-months.test.ts).

export type StockSnapshotRow = {
  distributorCode: string;
  /** first day of the month-cycle (YYYY-MM-DD); "" when untagged */
  cycleMonth: string;
  weekStart: string;
  stockQty: number;
};

export function latestStockOnly<T extends StockSnapshotRow>(rows: readonly T[]): T[] {
  const latest = new Map<string, { cycleMonth: string; weekStart: string }>();
  for (const row of rows) {
    const cycleMonth = row.cycleMonth || "";
    const current = latest.get(row.distributorCode);
    if (
      !current ||
      cycleMonth > current.cycleMonth ||
      (cycleMonth === current.cycleMonth && row.weekStart > current.weekStart)
    ) {
      latest.set(row.distributorCode, { cycleMonth, weekStart: row.weekStart });
    }
  }
  return rows.map((row) => {
    const keep = latest.get(row.distributorCode);
    return keep && (row.cycleMonth || "") === keep.cycleMonth && row.weekStart === keep.weekStart
      ? row
      : { ...row, stockQty: 0 };
  });
}
