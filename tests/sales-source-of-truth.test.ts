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

  // M1: the sales-import duplicate-batch race is closed by a partial unique index on duplicate_hash
  // (the batch INSERT becomes the atomic arbiter). createSalesImport must surface the losing
  // concurrent INSERT's 23505 as a clean 409 SalesWorkflowError instead of a raw 500.
  assert.match(salesServiceSource, /if \(isPostgresUniqueViolation\(batchInsert\.error\)\) \{[\s\S]*?new SalesWorkflowError\(\s*"duplicate_sales_batch"/, "createSalesImport maps a unique-violation on batch insert to a duplicate_sales_batch 409");
  const dedupMigration = readFileSync("supabase/migrations/20260712000000_sales_import_batches_duplicate_hash_unique.sql", "utf8");
  assert.match(dedupMigration, /create unique index if not exists sales_import_batches_active_duplicate_hash_uidx/, "the partial unique index migration exists");
  assert.match(dedupMigration, /where status not in \('replaced', 'rejected'\) and btrim\(duplicate_hash\) <> ''/, "the index is scoped to active, hash-bearing batches only");

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
  // The portal must not grow a second dashboard builder. buildEmployeeSalesDashboard was an
  // unreferenced copy of the same MAX-target dedupe that had already drifted (it summed territory
  // targets raw, missing the maxTargetsByTerritory fix), so portal target-math edits could land in
  // dead code and appear to do nothing.
  assert.doesNotMatch(employeePortalSource, /function buildEmployeeSalesDashboard/, "the portal calls buildPortalSalesDashboardMetrics and must not re-implement it");

  const salesPageSource = readFileSync("app/(admin)/sales/page.tsx", "utf8");
  assert.match(salesPageSource, /getSosDashboard/);
  const salesAnalyticsPageSource = readFileSync("src/components/analytics/dashboards/source-sales-dashboard.tsx", "utf8");
  assert.match(salesAnalyticsPageSource, /loadSosByPeriod/);
  // The portal sales dashboards were consolidated into a single scope-aware Source of Sales page
  // that reuses the admin SoS engine via the getPortalSosDashboard wrapper.
  const portalSosPageSource = readFileSync("app/employee-portals/source-of-sales/page.tsx", "utf8");
  assert.match(portalSosPageSource, /getPortalSosDashboard/);

  const medRepsPerformancePageSource = readFileSync("app/employee-portals/med-reps-performance/page.tsx", "utf8");
  // Page was rebuilt to mirror the flat dsm-performance/dsms-performance layout (snapshot ->
  // achievement bar -> flat charts -> leaderboard -> product depth), so it no longer groups
  // members per district via buildSalesManagerPerformanceGroups. Still guard against the naive
  // double-counting pattern that helper was originally introduced to avoid.
  assert.doesNotMatch(medRepsPerformancePageSource, /members\.reduce\(\(sum, member\) => sum \+ member\.totalSales/);
}
