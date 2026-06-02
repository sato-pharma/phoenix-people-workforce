import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPortalSalesDashboardMetrics,
  buildSalesDashboardView,
  buildSalesManagerPerformanceGroups,
  buildSalesProductAnalytics,
  isActiveSalesImportBatch,
  selectCurrentSalesRecords,
  salesAchievementRate,
} from "../src/lib/sales/metrics.ts";

export function runSalesSourceOfTruthTests() {
  assert.equal(salesAchievementRate(120, 100), 1.2);
  assert.equal(salesAchievementRate(120, 0), 0);

  assert.equal(isActiveSalesImportBatch({ status: "approved", replacedByBatchId: null }), true);
  assert.equal(isActiveSalesImportBatch({ status: "validated", replacedByBatchId: null }), false);
  assert.equal(isActiveSalesImportBatch({ status: "approved", replacedByBatchId: "batch-new" }), false);
  assert.equal(isActiveSalesImportBatch({ status: "rejected", replacedByBatchId: null }), false);

  const currentRecords = selectCurrentSalesRecords(
    [
      { batchId: "old", line: "CNS", month: 1, product: "A", salesValue: 999, targetValue: 999, validationState: "valid", year: 2026 },
      { batchId: "draft", line: "CNS", month: 1, product: "A", salesValue: 700, targetValue: 700, validationState: "valid", year: 2026 },
      { batchId: "new", line: "CNS", month: 1, product: "A", salesValue: 120, targetValue: 100, validationState: "valid", year: 2026 },
      { batchId: "new", line: "CNS", month: 1, product: "B", salesValue: 300, targetValue: 300, validationState: "failed", year: 2026 },
      { batchId: "rejected", line: "CNS", month: 1, product: "C", salesValue: 500, targetValue: 500, validationState: "valid", year: 2026 },
    ],
    [
      { approvedAt: "2026-02-01", createdAt: "2026-02-01", id: "old", line: "CNS", replacedByBatchId: "new", status: "approved", version: 1 },
      { approvedAt: null, createdAt: "2026-02-03", id: "draft", line: "CNS", replacedByBatchId: null, status: "validated", version: 2 },
      { approvedAt: "2026-02-04", createdAt: "2026-02-04", id: "new", line: "CNS", replacedByBatchId: null, status: "approved", version: 3 },
      { approvedAt: null, createdAt: "2026-02-05", id: "rejected", line: "CNS", replacedByBatchId: null, status: "rejected", version: 4 },
    ],
  );
  assert.deepEqual(currentRecords.map((record) => record.batchId), ["new"]);
  assert.equal(currentRecords[0].salesValue, 120);

  const dashboardView = buildSalesDashboardView([
    { employeeHrId: "MR-1", employeeName: "Rep One", line: "CNS", managerHrId: "DSM-1", managerName: "Manager One", period: "2026-01", product: "A", salesType: "Retail", salesUnits: 12, salesValue: 120, targetValue: 100, territory: "Nasr City" },
  ]);
  assert.equal(dashboardView.summary.totalApprovedSales, 120);
  assert.equal(dashboardView.summary.totalApprovedTarget, 100);
  assert.equal(dashboardView.summary.achievementRate, 1.2);
  assert.equal(dashboardView.productRows[0].product, "A");

  const portalDashboard = buildPortalSalesDashboardMetrics([
    { family: "Pain", hrId: "MR-1", line: "CNS", month: 1, period: "2026-01", product: "A", salesType: "Retail", salesUnits: 10, salesValue: 100, targetValue: 100, territory: "Nasr City", year: 2026 },
    { family: "Pain", hrId: "MR-1", line: "CNS", month: 1, period: "2026-01", product: "A", salesType: "Stores", salesUnits: 2, salesValue: 20, targetValue: 0, territory: "Nasr City", year: 2026 },
  ]);
  assert.equal(portalDashboard.summary.totalApprovedSales, 120);
  assert.equal(portalDashboard.summary.totalApprovedTarget, 100);
  assert.equal(portalDashboard.summary.achievementRate, 1.2);

  const managerGroups = buildSalesManagerPerformanceGroups([
    { managerHrId: "DSM-2", managerName: "Z Manager", totalSales: 75, totalTarget: 100 },
    { managerHrId: "DSM-1", managerName: "A Manager", totalSales: 50, totalTarget: 100 },
    { managerHrId: "DSM-1", managerName: "A Manager", totalSales: 150, totalTarget: 100 },
  ]);
  assert.deepEqual(managerGroups.map((group) => group.managerHrId), ["DSM-1", "DSM-2"]);
  assert.equal(managerGroups[0].totalSales, 200);
  assert.equal(managerGroups[0].totalTarget, 200);
  assert.equal(managerGroups[0].achievementPercent, 100);

  const productAnalytics = buildSalesProductAnalytics(portalDashboard, "A");
  assert.equal(productAnalytics.kpis.totalSales, 120);
  assert.equal(productAnalytics.topProducts[0].product, "A");

  const salesServiceSource = readFileSync("src/lib/sales/service.ts", "utf8");
  assert.match(salesServiceSource, /selectCurrentSalesRecords/);
  assert.match(salesServiceSource, /getSalesPlatformMetrics/);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /getSalesPlatformMetrics/);
  assert.doesNotMatch(platformSource, /getSalesDashboard/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /getSalesPlatformMetrics/);
  assert.doesNotMatch(commandCenterSource, /sales_import_batches[\s\S]*sales_records[\s\S]*latestBatchByRecordPeriod/);

  const salesDashboardSource = readFileSync("src/components/sales/sales-dashboard.tsx", "utf8");
  assert.match(salesDashboardSource, /buildSalesDashboardView/);
  assert.doesNotMatch(salesDashboardSource, /function calculateView/);

  const salesPerformanceSource = readFileSync("src/components/sales/sales-performance-page.tsx", "utf8");
  assert.match(salesPerformanceSource, /buildSalesProductAnalytics/);

  const employeePortalSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(employeePortalSource, /buildPortalSalesDashboardMetrics/);

  const salesPageSource = readFileSync("app/(admin)/sales/page.tsx", "utf8");
  assert.match(salesPageSource, /getSalesDashboard/);
  const portalSalesPageSource = readFileSync("app/employee-portals/sales/page.tsx", "utf8");
  assert.match(portalSalesPageSource, /getSalesDashboard/);

  const medRepsPerformancePageSource = readFileSync("app/employee-portals/med-reps-performance/page.tsx", "utf8");
  assert.match(medRepsPerformancePageSource, /buildSalesManagerPerformanceGroups/);
  assert.doesNotMatch(medRepsPerformancePageSource, /members\.reduce\(\(sum, member\) => sum \+ member\.totalSales/);
}
