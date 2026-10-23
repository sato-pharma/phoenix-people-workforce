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
  SALES_ACHIEVEMENT_WINDOW_LABEL,
} from "../src/lib/sales/metrics.ts";
import { SALES_HISTORY_FLOOR } from "../src/lib/sales/vs-target.ts";

export function runSalesSourceOfTruthTests() {
  assert.equal(salesAchievementRate(120, 100), 1.2);
  assert.equal(salesAchievementRate(120, 0), 0);

  // The CEO and SFE overviews label the company achievement rate with this string, and the rate
  // itself is built over SALES_HISTORY_FLOOR → the current Cairo month. The label is kept as a
  // literal so metrics.ts stays free of the heavy vs-target module; this assertion is what stops
  // the two drifting. Move the floor into another year and the label becomes a lie — this goes
  // red before it ships.
  assert.equal(
    SALES_ACHIEVEMENT_WINDOW_LABEL,
    `${SALES_HISTORY_FLOOR.slice(0, 4)} to date`,
    "the achievement window label must name the year the canonical engine's data floor opens in",
  );

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

  // Covered sales — the part of a month sitting on a key that HAS a target, and the only part an
  // achievement may divide (the portal incentive tab pays on it). The Stores row above carries no
  // target of its own but shares product A's key, so both rows are covered: 120 of 120.
  const portalJanuary = portalDashboard.trend.find((point) => point.period === "2026-01");
  assert.equal(portalJanuary?.sales, 120);
  assert.equal(portalJanuary?.coveredSales, 120, "a target-0 echo row on a targeted key is still covered sales");

  // The case that must NOT inflate an achievement: a product with no target anywhere. Its 90 EGP is
  // real revenue and belongs in `sales`, but crediting it against product A's 100 target would read
  // as 210% where /sales-vs-target and Monthly Closing both say 120%.
  const portalUntargeted = buildPortalSalesDashboardMetrics([
    { family: "Pain", hrId: "MR-1", line: "CNS", month: 1, period: "2026-01", product: "A", salesType: "Retail", salesUnits: 10, salesValue: 100, targetValue: 100, territory: "Nasr City", year: 2026 },
    { family: "Pain", hrId: "MR-1", line: "CNS", month: 1, period: "2026-01", product: "A", salesType: "Stores", salesUnits: 2, salesValue: 20, targetValue: 0, territory: "Nasr City", year: 2026 },
    { family: "Pain", hrId: "MR-1", line: "CNS", month: 1, period: "2026-01", product: "B", salesType: "Retail", salesUnits: 9, salesValue: 90, targetValue: 0, territory: "Nasr City", year: 2026 },
  ]);
  const untargetedJanuary = portalUntargeted.trend.find((point) => point.period === "2026-01");
  assert.equal(untargetedJanuary?.sales, 210, "every sale is reported, targeted or not");
  assert.equal(
    untargetedJanuary?.coveredSales,
    120,
    "a product with no target anywhere stays OUT of the achievement numerator — 210/100 is an over-achievement nobody earned",
  );
  assert.equal(untargetedJanuary?.target, 100, "and it contributes no target either");

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
  assert.match(salesServiceSource, /getSalesPlatformMetrics/);

  // Rule #1: the admin dashboard reads SoS Monthly Closing, like every other sales surface.
  // It used to page `sales_records` and pick the current batch with selectCurrentSalesRecords —
  // both gone, because the canonical engine returns the current truth and has no batches. The
  // negative assertion is the one that matters: re-adding a sales_records read here is exactly
  // how the admin KPIs start disagreeing with the portal again.
  assert.match(
    salesServiceSource,
    /loadCanonicalDashboardRecords/,
    "getSalesDashboard sources its rows from the canonical SoS loader",
  );
  assert.doesNotMatch(
    salesServiceSource,
    /from\("sales_records"\)\s*\n?\s*\.select\(SALES_DASHBOARD_RECORD_SELECT\)/,
    "the dashboard no longer reads the legacy sales_records table",
  );
  // Achievement divides EVERY pound over the target — the Monthly Closing's own rule, which this
  // dashboard must match because it feeds the portal hero card. It pinned the covered slice until
  // the owner ruled otherwise on 2026-09-05 ("FOLLOW THE OLD MONTHLY CLOSING ... 100% IDENTICAL");
  // measured then, 7 of 85 reps were being shown two different figures for their own month, the
  // worst 63.21% against the closing's 93.76%.
  assert.match(
    salesServiceSource,
    /achievementRate: performanceMetric\(totalSales, totalTarget\)/,
    "the headline achievement % divides every sale over the target, as the closing does — and so the "
      + "summary's own totalApprovedSales / totalApprovedTarget divide into the rate printed beside them",
  );

  // Rule #1 reaches the reconciliation dashboard too, and that leg is SQL — no TypeScript sits
  // between analytics.closing_fact and the screen, so these are the only assertions that can guard
  // it. The view feeds closing_by_line/_employee/_product and both reconciliation mounts.
  const closingFactMigration = readFileSync(
    "supabase/migrations/20260814090000_closing_fact_reads_source_of_sales.sql",
    "utf8",
  );
  assert.match(
    closingFactMigration,
    /create or replace view analytics\.closing_fact as[\s\S]*au\.f_monthly_achievement/,
    "the closing leg is built from the canonical engine",
  );
  assert.doesNotMatch(
    closingFactMigration,
    /create or replace view analytics\.closing_fact as[\s\S]*from\s+public\.sales_records/,
    "and never again from the legacy closing-sheet table",
  );
  // The August trap, in SQL. au.monthly_targets holds 17,508,935 for 2026-08 against ONE 1,309.50
  // direct order. Without this gate the dashboard publishes a 0.01% month for a month nobody
  // uploaded — and a direct order must not count as evidence the month landed.
  assert.match(
    closingFactMigration,
    /uploaded_periods as \([\s\S]*not in \('direct', 'directreq'\)/,
    "targets are gated on the distributor upload ledger, excluding direct orders",
  );
  assert.match(
    closingFactMigration,
    /case when up\.period is not null then a\.target_value end\s+as target_value/,
    "a month with no distributor upload carries no target, so it cannot publish an achievement",
  );
  // The gap column stays gone. Closing IS SoS at line grain — attribution moves value down a line,
  // never between lines — so it read a flat 0.00% and asserted a check that never happened.
  assert.doesNotMatch(
    closingFactMigration,
    /closing_vs_sos_gap_pct/,
    "the tautological gap column is not reintroduced by this migration",
  );
  // (A third check kept the gap off the Sales Analytics row type; that module was retired 2026-09-17.)

  // The legacy closing-sheet import is closed to new writes. createSalesImport is the ONLY writer
  // of sales_records, and nothing reads that table any more — an accepted upload would validate a
  // real workbook, report success, and move no number on any screen. A disabled button in
  // sales-queue.tsx is UX; the endpoint is still reachable, so the guard has to live server-side.
  assert.match(
    salesServiceSource,
    /const LEGACY_SALES_IMPORT_FROZEN = true/,
    "the legacy closing-sheet import stays frozen",
  );
  assert.match(
    salesServiceSource,
    /export async function createSalesImport\([\s\S]{0,400}?assertLegacySalesImportOpen\(\)/,
    "the function that inserts sales_records refuses on its own account, not only via the workflow",
  );
  const importWorkflowSource = readFileSync("src/lib/sales/import-workflow.ts", "utf8");
  assert.match(
    importWorkflowSource,
    /assertLegacySalesImportOpen\(\)/,
    "and the workflow refuses before it spends minutes parsing a workbook it will not keep",
  );

  // The Data Health page that classified sales ownership was retired on 23 Oct 2026 and its sales
  // audit went with it. What must never come back is the old shape: grading sales_records, a table
  // no employee or manager can see the numbers from.
  const adminServiceSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.doesNotMatch(
    adminServiceSource,
    /\.from\("sales_records"\)/,
    "and no longer reads the legacy table it used to grade",
  );

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
