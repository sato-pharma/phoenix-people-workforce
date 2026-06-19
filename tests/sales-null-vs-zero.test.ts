import assert from "node:assert/strict";

import { buildSalesDashboardView } from "../src/lib/sales/metrics.ts";

export function runSalesNullVsZeroTests() {
  // Empty rows — no data uploaded for the selected filter — must emit null for
  // money totals so the UI can render "—" rather than a misleading "EGP 0".
  const emptyView = buildSalesDashboardView([], {});
  assert.strictEqual(
    emptyView.summary.totalApprovedSales,
    null,
    "totalApprovedSales must be null (not 0) when there are no rows",
  );
  assert.strictEqual(
    emptyView.summary.totalApprovedTarget,
    null,
    "totalApprovedTarget must be null (not 0) when there are no rows",
  );

  // Genuine zero sales — rows exist but values are 0 — must stay 0 (not null).
  const zeroRows = [
    { salesValue: 0, targetValue: 100, salesUnits: 0, factoryPrice: 10, product: "P1", family: "F1", line: "L1", territory: "T1", salesType: "Retail", period: "2026-01", managerHrId: "M1" },
  ];
  const zeroView = buildSalesDashboardView(zeroRows, {});
  assert.strictEqual(
    zeroView.summary.totalApprovedSales,
    0,
    "totalApprovedSales must be 0 (not null) when rows exist with zero sales",
  );
  assert.strictEqual(
    zeroView.summary.totalApprovedTarget,
    100,
    "totalApprovedTarget must reflect the real target value",
  );

  // Normal data path — standard rows must still produce correct numeric totals.
  const dataRows = [
    { salesValue: 1000, targetValue: 1200, salesUnits: 5, factoryPrice: 200, product: "P1", family: "F1", line: "L1", territory: "T1", salesType: "Retail", period: "2026-01", managerHrId: "M1" },
    { salesValue: 500, targetValue: 600, salesUnits: 2, factoryPrice: 250, product: "P2", family: "F1", line: "L1", territory: "T2", salesType: "Stores", period: "2026-01", managerHrId: "M1" },
  ];
  const dataView = buildSalesDashboardView(dataRows, {});
  assert.strictEqual(
    dataView.summary.totalApprovedSales,
    1500,
    "totalApprovedSales must sum correctly for real data",
  );
  assert.strictEqual(
    dataView.summary.totalApprovedTarget,
    1800,
    "totalApprovedTarget must sum correctly for real data",
  );
}
