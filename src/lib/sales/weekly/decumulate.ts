// Pure de-cumulation of cumulative weekly-sales rows into real "this week only" rows.
//
// Distributor weekly sheets are CUMULATIVE within a month (week 2 already contains week 1, etc.). For
// each (distributor, cycle_month) the real value/units of a week = its cumulative MINUS the previous
// week's matching (product × branch) cumulative. The first week of a cycle is itself. STOCK is a
// point-in-time snapshot — never subtracted. Untagged rows (no cycle_month / week_number) pass through
// unchanged. Telescoping keeps the month total correct: the sum of the real weeks equals the last
// cumulative sheet of the cycle.
//
// Pure + dependency-free so it can be unit-tested in isolation (see tests/weekly-decumulation.test.ts).

export type DecumulableRow = {
  weekStart: string;
  /** first day of the month-cycle (YYYY-MM-DD); "" when untagged */
  cycleMonth: string;
  /** week-of-month 1–4; null when untagged */
  weekNumber: number | null;
  distributorCode: string;
  productCode: string;
  branchCode: string;
  branchName: string;
  salesValue: number;
  salesQty: number;
  netQty: number;
  stockQty: number;
};

const up = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

export function decumulateRows<T extends DecumulableRow>(rows: T[]): T[] {
  // A cell is one product at one branch. Branch falls back to its name when it has no code.
  const cellKey = (r: DecumulableRow) => `${up(r.productCode)}||${up(r.branchCode) || up(r.branchName)}`;

  const groups = new Map<string, T[]>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row.cycleMonth || row.weekNumber == null) {
      out.push(row); // untagged / legacy — leave exactly as-is
      continue;
    }
    const key = `${up(row.distributorCode)}||${row.cycleMonth}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  for (const groupRows of groups.values()) {
    const weeks = [...new Set(groupRows.map((r) => r.weekStart).filter(Boolean))].sort();
    // Per-week cumulative cell maps. Duplicate cells within a week (shouldn't happen post-aggregate) sum.
    const byWeek = new Map<string, Map<string, T>>();
    for (const week of weeks) byWeek.set(week, new Map());
    for (const r of groupRows) {
      const m = byWeek.get(r.weekStart);
      if (!m) continue;
      const k = cellKey(r);
      const ex = m.get(k);
      if (ex) {
        ex.salesValue += r.salesValue;
        ex.salesQty += r.salesQty;
        ex.netQty += r.netQty;
        ex.stockQty += r.stockQty;
      } else {
        m.set(k, { ...r });
      }
    }
    for (let i = 0; i < weeks.length; i++) {
      const curr = byWeek.get(weeks[i]);
      if (!curr) continue;
      const prev = i > 0 ? byWeek.get(weeks[i - 1]) ?? null : null;
      for (const [k, r] of curr) {
        const p = prev?.get(k);
        out.push({
          ...r,
          salesValue: p ? r.salesValue - p.salesValue : r.salesValue,
          salesQty: p ? r.salesQty - p.salesQty : r.salesQty,
          netQty: p ? r.netQty - p.netQty : r.netQty,
          stockQty: r.stockQty, // snapshot — never subtracted
        });
      }
    }
  }
  return out;
}
