import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  WEEKLY_STOCK_UNMAPPED_AREA,
  WEEKLY_STOCK_UNMAPPED_AREA_LABEL,
  buildWeeklyStockView,
  classifyWeeklyStock,
  weeklyStockSalesWindow,
  type WeeklyStockSourceRow,
} from "../src/lib/sales/weekly/stock-dashboard.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

// Mirrors PORTAL_WEEKLY_STOCK_ROLES / isPortalWeeklyStockRole in stock-dashboard-service.ts, which is
// not imported here because it pulls in the database client. The source match below pins the two together.
const PORTAL_WEEKLY_STOCK_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
] as const;
const resolvePortalNav = (role: string) => resolveEmployeePortalNavVisibility(role, role);

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function row(partial: Partial<WeeklyStockSourceRow>): WeeklyStockSourceRow {
  return {
    distributorCode: "PS",
    distributorName: "Overseas",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: "CA1",
    branchCode: "B1",
    branchName: "Nasr City",
    productCode: "CO001",
    productName: "Conviban 50 mg",
    line: "CNS",
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-06",
    netUnits: 0,
    stockUnits: 0,
    factoryPrice: 30,
    ...partial,
  };
}

const areaNames = new Map([["CA1", "Nasr City 1"]]);

export function runWeeklyStockDashboardTests() {
  // ── Cover bands: Low < 2 weeks · Healthy 2–8 · Overstock > 8 · stock with no sales = No sales (owner).
  assert.deepEqual(classifyWeeklyStock(19, 10), { coverWeeks: 1.9, status: "low" }, "under 2 weeks is Low");
  assert.equal(classifyWeeklyStock(20, 10).status, "healthy", "exactly 2 weeks is Healthy");
  assert.equal(classifyWeeklyStock(80, 10).status, "healthy", "exactly 8 weeks is Healthy");
  assert.equal(classifyWeeklyStock(81, 10).status, "over", "over 8 weeks is Overstock");
  assert.deepEqual(classifyWeeklyStock(5, 0), { coverWeeks: null, status: "no_sales" }, "stock with no sales");
  assert.deepEqual(classifyWeeklyStock(0, 10), { coverWeeks: 0, status: "low" }, "sold out while selling is Low");

  // ── The average divides by the WEEKS an upload covers, not the number of uploads: after a gap the
  //    de-cumulated upload carries the missing week too, and a cycle's first upload carries weeks 1..n.
  const gap = weeklyStockSalesWindow(
    [
      { weekStart: "2026-09-06", cycleMonth: "2026-09-01", weekNumber: 1 },
      { weekStart: "2026-09-20", cycleMonth: "2026-09-01", weekNumber: 3 },
    ],
    "2026-09-20",
  );
  assert.equal(gap.coveredWeeks, 3, "W1 + a W3 that spans the missing W2 = 3 weeks");
  const crossMonth = weeklyStockSalesWindow(
    [
      { weekStart: "2026-08-20", cycleMonth: "2026-08-01", weekNumber: 3 },
      { weekStart: "2026-08-27", cycleMonth: "2026-08-01", weekNumber: 4 },
      { weekStart: "2026-09-06", cycleMonth: "2026-09-01", weekNumber: 1 },
    ],
    "2026-09-06",
  );
  assert.deepEqual([...crossMonth.weekStarts].sort(), ["2026-08-20", "2026-08-27", "2026-09-06"]);
  assert.equal(crossMonth.coveredWeeks, 5, "August's first upload is W3, so it covers weeks 1-3");

  // ── Fixture: two weeks at one depot, a second product, an unmapped depot, a stale distributor,
  //    a distributor that never reports stock, and a product with no master price.
  const rows: WeeklyStockSourceRow[] = [
    row({ weekStart: "2026-09-06", weekNumber: 1, stockUnits: 100, netUnits: 10 }),
    row({ weekStart: "2026-09-13", weekNumber: 2, stockUnits: 60, netUnits: 20 }),
    row({ weekStart: "2026-09-13", weekNumber: 2, productCode: "CO002", productName: "Conviban 25mg/ml Syp", factoryPrice: 40, stockUnits: 10, netUnits: 0 }),
    row({ weekStart: "2026-09-13", weekNumber: 2, branchCode: "B9", branchName: "Key Accounts", areaCode: null, stockUnits: 5, netUnits: 0 }),
    // sold in the window but absent from the snapshot upload: not a reading of zero stock
    row({ weekStart: "2026-09-06", weekNumber: 1, branchCode: "B7", branchName: "Heliopolis", productCode: "TE003", stockUnits: 3, netUnits: 4 }),
    row({ distributorCode: "RM", distributorName: "Ramco", weekStart: "2026-06-21", cycleMonth: "2026-06-01", weekNumber: 3, stockUnits: 40, netUnits: 12 }),
    row({ distributorCode: "POS", distributorName: "POS Purchasing Sales", weekStart: "2026-09-13", stockUnits: 0, netUnits: 50 }),
    row({ weekStart: "2026-09-13", weekNumber: 2, branchCode: "B2", branchName: "Maadi", productCode: "ZZ001", productName: "No Price", factoryPrice: null, stockUnits: 7, netUnits: 1 }),
  ];

  const view = buildWeeklyStockView(rows, areaNames);

  // Stock is each distributor's LATEST snapshot, never a sum across weeks.
  const conviban = view.cells.find((cell) => cell.productCode === "CO001" && cell.branchName === "Nasr City" && cell.distributorCode === "PS");
  assert.ok(conviban, "the depot/product cell exists");
  assert.equal(conviban.stockUnits, 60, "stock is the 13 Sep snapshot (60), not 100 + 60");
  assert.equal(conviban.avgWeeklyUnits, 15, "30 units over 2 weeks");
  assert.equal(conviban.coverWeeks, 4);
  assert.equal(conviban.status, "healthy");
  assert.equal(conviban.stockValue, 1800, "value = units x live factory price");
  assert.equal(conviban.areaName, "Nasr City 1");
  assert.equal(conviban.asOfWeekStart, "2026-09-13");

  assert.equal(
    view.cells.some((cell) => cell.branchName === "Heliopolis"),
    false,
    "a cell missing from the snapshot upload is not shown as stock",
  );

  // Units are NEVER added across product codes: every multi-product grouping carries value only.
  // Keyed by distributor + branch: Ramco has a "Nasr City" depot too, and must never be merged in.
  const nasrCity = view.depots.find((depot) => depot.code === "PS|B1");
  assert.ok(nasrCity);
  assert.equal(nasrCity.stockValue, 2200, "1800 (Conviban 50) + 400 (Conviban syrup)");
  for (const group of [...view.depots, ...view.areas, ...view.regions, ...view.distributors]) {
    assert.equal("stockUnits" in group, false, `${group.name}: a grouping across products must not carry a unit total`);
  }
  assert.equal("stockUnits" in view.kpis, false, "the headline figures carry no cross-product unit total");

  // Depots with no area are reported under "Area not mapped", never dropped.
  const keyAccounts = view.cells.find((cell) => cell.branchName === "Key Accounts");
  assert.equal(keyAccounts?.areaName, WEEKLY_STOCK_UNMAPPED_AREA_LABEL);
  assert.equal(keyAccounts?.status, "no_sales");
  const onlyUnmapped = buildWeeklyStockView(rows, areaNames, { areaCodes: [WEEKLY_STOCK_UNMAPPED_AREA] });
  assert.deepEqual([...new Set(onlyUnmapped.cells.map((cell) => cell.branchName))], ["Key Accounts"]);

  // A distributor that never reports stock has no snapshot and stays off the dashboard.
  assert.equal(view.distributors.some((d) => d.code === "POS"), false, "POS reports no stock");

  // An old snapshot is kept but flagged stale.
  assert.equal(view.distributors.find((d) => d.code === "RM")?.stale, true, "Ramco's June stock is stale");
  assert.equal(view.distributors.find((d) => d.code === "PS")?.stale, false);

  // A product with no master price is counted, valued at nothing, and flagged.
  assert.equal(view.kpis.priceMissingCount, 1);
  assert.equal(view.cells.find((cell) => cell.productCode === "ZZ001")?.stockValue, 0);

  // A single product code across depots is the one place a unit total is valid.
  const co001 = view.products.find((product) => product.productCode === "CO001");
  assert.equal(co001?.stockUnits, 60 + 5 + 40, "Nasr City + Key Accounts + Ramco");

  // As-of week: each distributor falls back to its latest snapshot on or before that date.
  const earlier = buildWeeklyStockView(rows, areaNames, { asOfWeekStart: "2026-09-06" });
  const earlierConviban = earlier.cells.find((cell) => cell.productCode === "CO001" && cell.branchName === "Nasr City" && cell.distributorCode === "PS");
  assert.equal(earlierConviban?.stockUnits, 100);
  assert.equal(earlierConviban?.coverWeeks, 10);
  assert.equal(earlierConviban?.status, "over");

  // Status filter narrows the rows and every total built from them.
  const overOnly = buildWeeklyStockView(rows, areaNames, { asOfWeekStart: "2026-09-06", statuses: ["over"] });
  assert.ok(overOnly.cells.length > 0 && overOnly.cells.every((cell) => cell.status === "over"));
  assert.equal(overOnly.kpis.stockValue, overOnly.cells.reduce((sum, cell) => sum + cell.stockValue, 0));

  // A sold-out depot keeps its product's price. Under a Low filter the only rows left can all be sold
  // out — no stock value to derive a price from — and their weekly sales must still be valued, or the
  // depot, area and region read Healthy (seen live on Retail Banha 1, 2026-09-14).
  const soldOut = buildWeeklyStockView(
    [
      row({ weekStart: "2026-09-13", stockUnits: 300, netUnits: 10 }),
      row({ weekStart: "2026-09-13", branchCode: "B3", branchName: "Banha", stockUnits: 0, netUnits: 4 }),
    ],
    areaNames,
    { statuses: ["low"] },
  );
  assert.deepEqual(soldOut.cells.map((cell) => cell.branchName), ["Banha"], "only the sold-out depot is Low");
  const banha = soldOut.depots.find((depot) => depot.code === "PS|B3");
  assert.equal(banha?.avgWeeklyValue, 120, "4 units a week at the product's price of 30");
  assert.equal(banha?.status, "low", "a sold-out depot that still sells reads Low, never Healthy");
  assert.equal(soldOut.areas[0]?.status, "low");
  assert.equal(soldOut.kpis.avgWeeklyValue, 120);

  // ── Wiring: scope and Head Office are enforced on the server, never by the screen.
  const service = readSource("../src/lib/sales/weekly/stock-dashboard-service.ts");
  assert.match(service, /resolveWeeklyAccessScope\(ctx\)/, "stock resolves the same per-viewer scope as Weekly Sales");
  // The load may lift a territory viewer's region bound for its row grain (own-area-scope.ts), so the flag
  // travels beside the scope, and weekly-own-area-lift.test.ts pins the narrowing back to his own depots.
  assert.match(
    service,
    /accessScope,\n\s+liftRowGrainGeography: liftGrain,\n\s+\}\),/,
    "the scope is handed to the weekly engine, which enforces it",
  );
  assert.match(service, /excludeUnmapped: true/, "unmapped products never reach a stock total");
  const engine = readSource("../src/lib/sales/weekly/service.ts");
  assert.match(
    engine,
    /stockRows: filters\?\.includeStockRows\s+\? grainScopedRows\.map/,
    "stock rows come from the scoped rows — after the access scope and the Head Office rule, never before",
  );
  assert.match(
    engine,
    /const grainScopedRows = grainLifted\s+\? applyWeeklyTrackedLineScope\(applyWeeklyAccessScope\(realRows, grainScope\), \{\s+includeUntracked: lineNamedExplicitly,\s+\}\)\.filter\(passesRowFilters\)\s+: scopedRows;/,
    "a lifted grain passes the same access scope, Head Office rule, tracked-line rule and filters — never raw rows",
  );
  for (const route of ["../app/api/sales/weekly/stock/route.ts", "../app/api/sales/weekly/stock/export/route.ts"]) {
    const source = readSource(route);
    assert.match(source, /assertPermission\(access, "weekly_sales", "read"\)/, `${route} checks weekly_sales on the server`);
    assert.match(source, /loadWeeklyStockDashboard\(/, `${route} reads through the scoped loader`);
  }
  for (const route of ["../app/api/employee-portals/weekly-stock/route.ts", "../app/api/employee-portals/weekly-stock/export/route.ts"]) {
    const source = readSource(route);
    assert.match(source, /assertPermission\(access, "sales", "read"\)/, `${route} checks sales on the server`);
    assert.match(source, /isPortalWeeklyStockRole\(access\.role\)/, `${route} applies the portal role gate`);
    assert.match(source, /loadWeeklyStockDashboard\(/, `${route} reads through the scoped loader`);
  }
  for (const route of ["../app/api/sales/weekly/stock/export/route.ts", "../app/api/employee-portals/weekly-stock/export/route.ts"]) {
    assert.match(readSource(route), /assertExportRateLimit\(/, `${route} is rate limited like every other export`);
  }

  // Medical Reps are IN (owner, 2026-09-14) — and the server gate, the nav flag and the catalog agree.
  for (const role of PORTAL_WEEKLY_STOCK_ROLES) {
    assert.ok(service.includes(`"${role}"`), `${role} is in the server's portal role list`);
  }
  assert.match(service, /PORTAL_WEEKLY_STOCK_ROLES = \[[^\]]*"Medical Rep"/, "a Medical Rep may open Weekly Stock");
  const catalog = readSource("../src/config/system-navigation.ts");
  assert.match(
    catalog,
    /href: "\/employee-portals\/weekly-stock"[^\n]*roles: \["Medical Rep"/,
    "the portal catalog lists Medical Rep for Weekly Stock",
  );
  assert.equal(resolvePortalNav("Employee").showWeeklyStockTab, false, "a plain employee does not see it");
  const flags = resolvePortalNav("Medical Rep");
  assert.equal(flags.showWeeklyStockTab, true, "the Medical Rep sidebar shows Weekly Stock");
  assert.equal(flags.showWeeklyTab, true, "and Weekly Sales too — his own area's screen (owner, 2026-09-16)");
  for (const role of PORTAL_WEEKLY_STOCK_ROLES) {
    assert.equal(resolvePortalNav(role).showWeeklyStockTab, true, `${role}: nav flag matches the server role list`);
  }

  // ── Layout: the desktop tables open at 1024 px, where the portal leaves them about 620 px. They fit by
  // MERGING columns, never by shrinking type or scrolling (owner golden rules): the status badge sits under
  // the name and the weeks of cover under the average — moved, never dropped, since the export has both.
  const dashboard = readSource("../src/components/sales/weekly/weekly-stock-dashboard.tsx");
  assert.doesNotMatch(dashboard, /overflow-x-auto|min-w-\[/, "never a horizontal scroll (owner golden rule)");
  assert.doesNotMatch(dashboard, /\btruncate\b/, "long names wrap, never an ellipsis");
  assert.equal((dashboard.match(/<table className="w-full table-fixed/g) ?? []).length, 3, "every table is fixed-layout");
  assert.equal((dashboard.match(/<colgroup>/g) ?? []).length, 3, "and sized by its colgroup");
  const desktopTables = dashboard
    .split('<table className="w-full table-fixed')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</table>")));
  for (const table of desktopTables) {
    const widths = [...table.matchAll(/<col className="w-\[(\d+)%\]" \/>/g)].map((match) => Number(match[1]));
    const headers = [...table.matchAll(/<th className=\{(TH|TH_NUM)\}>/g)].map((match) => match[1]);
    assert.equal(widths.length, headers.length, "every column header has its own col");
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "every colgroup adds up to the table's width");
    headers.forEach((kind, index) => {
      if (kind === "TH_NUM") assert.ok(widths[index] >= 16, `a figure column is at least 16% wide, never a sliver its figure spills out of`);
    });
    assert.doesNotMatch(table, />(?:Cover|Status)<\/th>/, "the status badge sits under the name and the cover under the average");
    assert.match(table, /<StatusBadge status=\{(?:cell|row)\.status\} \/>/, "every desktop row still shows its status");
    assert.match(table, /formatCoverLine\((?:cell|row)\.coverWeeks\)/, "every desktop row still shows its weeks of cover, labelled");
  }
  // A figure on a headline tile or a phone card wraps inside its box rather than running out of it: three across
  // at 375 px, the depot cards could not hold "EGP 512.5K" on one line (Depot Detail's figures wrap the same way).
  const figures = [...dashboard.matchAll(/<p className="([^"]*)">\{value\}<\/p>/g)].map((match) => match[1]);
  assert.equal(figures.length, 2, "the headline tile and the phone card each print one figure");
  for (const figure of figures) assert.doesNotMatch(figure, /\bwhitespace-nowrap\b/, "a figure wraps inside its box, never runs out of it");
  assert.match(dashboard, /<div className="hidden md:block">/, "desktop and tablet (from md) read full tables");
  assert.match(dashboard, /<div className="space-y-2 p-3 md:hidden">/, "a phone reads cards");
}
