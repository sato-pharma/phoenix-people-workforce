import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildPortalSalesDashboardMetrics, buildSalesDashboardView } from "../src/lib/sales/metrics.ts";

// Three more places a number disagreed with the rows it sat next to.
//
// 1. HEADLINE vs BREAKDOWNS. buildSalesDashboardView summed totalSales/totalTarget/unitsSold over
//    `rows` while every breakdown below used `reportRows` (= rows minus C-O1). The headline could
//    therefore never equal the sum of the parts, and the difference had nowhere visible to live.
// 2. TERRITORY TARGET. Territory was the one dimension summing target RAW while trend, product,
//    family and line all de-duplicate. Source rows echo a target across every (period, product)
//    line for an employee, so a raw sum multiplies the territory target by the echo factor and
//    understates achievement by exactly that factor.
// 3. FOOTER TOTAL. analytics-data-table rendered the caller's full-dataset `totals` under
//    search-filtered rows.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Two rows for the same employee/territory/period/product — the row echo that inflates a raw sum —
// plus one C-O1 row that every breakdown excludes.
const ROWS = [
  {
    employeeHrId: "B-100", hrId: "B-100", managerHrId: "B-12", territory: "AB1", line: "CNS",
    family: "Fam", product: "P1", period: "2026-06", salesValue: 100, targetValue: 400,
    salesUnits: 10, factoryPrice: 10,
  },
  {
    employeeHrId: "B-100", hrId: "B-100", managerHrId: "B-12", territory: "AB1", line: "CNS",
    family: "Fam", product: "P1", period: "2026-06", salesValue: 50, targetValue: 400,
    salesUnits: 5, factoryPrice: 10,
  },
  {
    employeeHrId: "C-O1", hrId: "C-O1", managerHrId: "C-O1", territory: "AB1", line: "CNS",
    family: "Fam", product: "P9", period: "2026-06", salesValue: 999, targetValue: 999,
    salesUnits: 99, factoryPrice: 50,
  },
] as unknown as Parameters<typeof buildSalesDashboardView>[0];

export function runSosUiTruthRemainderTests() {
  // ── 1. The headline excludes C-O1, exactly like the breakdowns ──────────────
  {
    const view = buildSalesDashboardView(ROWS);
    assert.equal(
      view.summary.totalApprovedSales,
      150,
      "headline sales must exclude the C-O1 row (100 + 50), or it can never equal the sum of the parts",
    );
    assert.equal(view.summary.unitsSold, 15, "headline units must exclude C-O1 too");
    assert.notEqual(
      view.summary.totalApprovedSales,
      1149,
      "1149 means C-O1 is back in the headline while every breakdown still drops it",
    );

    // The breakdown it must agree with: territoryRows is already built from reportRows.
    const territorySales = view.territoryRows.reduce((sum, r) => sum + Number(r.sales ?? 0), 0);
    assert.equal(
      territorySales,
      view.summary.totalApprovedSales,
      "headline must equal the sum of the parts — that identity is the whole point",
    );
  }

  // ── 2. Portal territory target is de-duplicated like every sibling dimension ─
  {
    const portal = buildPortalSalesDashboardMetrics(ROWS) as unknown as {
      territories: Array<{ name: string; sales: number; target: number }>;
    };
    const ab1 = portal.territories.find((t) => t.name === "AB1");
    assert.ok(ab1, "AB1 must be reported");
    // AB1 holds three rows: B-100/P1 twice (the SAME target of 400, echoed) and C-O1/P9 once
    // (its own distinct target of 999). Deduped that is 400 + 999 = 1399. Summed raw it would be
    // 400 + 400 + 999 = 1799, inflating the territory's target by the echo and pushing its
    // achievement % down by the same proportion.
    assert.equal(Number(ab1.target), 1399, "the echoed 400 must be counted once, the distinct 999 kept");
    assert.notEqual(Number(ab1.target), 1799, "1799 means the echoed target is being summed raw again");
    assert.equal(Number(ab1.sales), 1149, "sales DO sum across every row — only the target is echoed");
  }

  // ── 3. The footer total follows the filtered rows ───────────────────────────
  {
    const table = code(readFileSync(join(process.cwd(), "src/components/analytics/analytics-data-table.tsx"), "utf8"));
    assert.match(table, /const isFilteredView = query\.trim\(\)\.length > 0;/, "the table must know it is filtered");
    assert.match(table, /const effectiveTotals = useMemo\(/, "totals must be recomputed when filtered");
    assert.match(table, /"Total \(filtered\)"/, "a filtered total must say so, never pose as the whole");
    assert.ok(
      !/\{totals && pageRows\.length > 0 && <MobileRow/.test(table),
      "the mobile total must use effectiveTotals too, or the two views disagree",
    );
    // A column the caller deliberately left out of totals (an average, a ratio) must not acquire a
    // meaningless sum when the view is filtered.
    assert.match(table, /if \(totals\[key\] == null\) continue;/, "only re-sum keys the caller totalled");
  }
}
