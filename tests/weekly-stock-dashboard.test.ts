import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  WEEKLY_STOCK_UNMAPPED_AREA,
  WEEKLY_STOCK_UNMAPPED_AREA_LABEL,
  buildWeeklyStockView,
  WEEKLY_STOCK_STATUS_LABELS,
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
  // ── Out of stock: no units is its own status, with or without sales — it is never "low" (cover below 2
  //    weeks) and never "healthy" (the old reading of 0 units that sold nothing).
  assert.deepEqual(classifyWeeklyStock(0, 10), { coverWeeks: 0, status: "out_of_stock" }, "no units while selling is Out of stock");
  assert.deepEqual(classifyWeeklyStock(0, 0), { coverWeeks: null, status: "out_of_stock" }, "no units and no sales is Out of stock, not Healthy");
  assert.equal(classifyWeeklyStock(-3, 10).status, "out_of_stock", "a negative reading is no stock either");
  assert.equal(classifyWeeklyStock(1, 10).status, "low", "one unit left is still Low, not Out of stock");

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

  // The statuses PARTITION the rows: every cell is in exactly one, so the tiles add up to the row count.
  const everyStatus = ["out_of_stock", "low", "healthy", "over", "no_sales"] as const;
  assert.deepEqual(Object.keys(WEEKLY_STOCK_STATUS_LABELS), [...everyStatus], "Out of stock is a status with its own label and filter option");
  const partitioned = buildWeeklyStockView(
    [
      row({ weekStart: "2026-09-13", stockUnits: 300, netUnits: 10 }), // 30 weeks: over
      row({ weekStart: "2026-09-13", branchCode: "B3", branchName: "Banha", stockUnits: 0, netUnits: 4 }), // sold out, selling
      row({ weekStart: "2026-09-13", branchCode: "B4", branchName: "Tanta", stockUnits: 0, netUnits: 3, productCode: "CO002", productName: "Conviban 25mg/ml Syp" }), // sold out, selling
      row({ weekStart: "2026-09-13", branchCode: "B4", branchName: "Tanta", stockUnits: 0, netUnits: 0, productCode: "CO003", productName: "Never Stocked" }), // listed at 0, never sold: not a row
      row({ weekStart: "2026-09-13", branchCode: "B5", branchName: "Zagazig", stockUnits: 5, netUnits: 0 }), // stock, nothing sold
      row({ weekStart: "2026-09-13", branchCode: "B6", branchName: "Mansoura", stockUnits: 5, netUnits: 10 }), // under 2 weeks: low
      row({ weekStart: "2026-09-13", branchCode: "B8", branchName: "Damietta", stockUnits: 40, netUnits: 10 }), // 4 weeks: healthy
    ],
    areaNames,
  );
  const tally = (status: string) => partitioned.cells.filter((cell) => cell.status === status).length;
  assert.deepEqual(
    everyStatus.map(tally),
    [2, 1, 1, 1, 1],
    "two sold-out cells, then one in every other status",
  );
  assert.equal(partitioned.cells.some((cell) => cell.productCode === "CO003"), false, "a catalogue line at 0 units that never sold stays off the screen");
  assert.equal(
    partitioned.kpis.outOfStockCount + partitioned.kpis.lowCount + partitioned.kpis.healthyCount + partitioned.kpis.overCount + partitioned.kpis.noSalesCount,
    partitioned.cells.length,
    "the five tiles add up to the rows",
  );
  assert.equal(partitioned.kpis.outOfStockCount, 2);
  assert.equal(partitioned.kpis.healthyCount, 1);
  assert.equal(partitioned.products.find((p) => p.productCode === "CO002")?.status, "out_of_stock", "a product out at every branch is Out of stock");
  assert.equal(partitioned.products.find((p) => p.productCode === "CO001")?.outDepots, 1, "a product counts its own out-of-stock branches");
  assert.equal(partitioned.depots.find((d) => d.code === "PS|B4")?.status, "out_of_stock", "a branch whose every product is out reads Out of stock");
  assert.equal(partitioned.depots.find((d) => d.code === "PS|B4")?.outOfStockCount, 1);

  // A value of 0 caused by a missing price is not an empty shelf: the grouping is never called Out of stock for it.
  const unpriced = buildWeeklyStockView(
    [row({ weekStart: "2026-09-13", stockUnits: 50, netUnits: 10, factoryPrice: null, productCode: "ZZ001", productName: "No Price" })],
    areaNames,
  );
  assert.equal(unpriced.cells[0]?.status, "healthy");
  assert.notEqual(unpriced.depots[0]?.status, "out_of_stock", "stock value 0 from a missing price is not an empty shelf");

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
    { statuses: ["out_of_stock"] },
  );
  assert.deepEqual(soldOut.cells.map((cell) => cell.branchName), ["Banha"], "only the sold-out depot is Out of stock");
  const banha = soldOut.depots.find((depot) => depot.code === "PS|B3");
  assert.equal(banha?.avgWeeklyValue, 120, "4 units a week at the product's price of 30");
  assert.equal(banha?.status, "out_of_stock", "a sold-out depot that still sells reads Out of stock, never Healthy or Low");
  assert.equal(soldOut.areas[0]?.status, "out_of_stock");
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
  // Out of stock has its own tile, badge and rail, and an empty region never leaves a bare "· ·" separator.
  assert.match(dashboard, /label="Out of stock"[\s\S]{0,160}drill\("statuses", "out_of_stock"\)/, "the Out of stock tile drills into its rows");
  assert.match(dashboard, /out_of_stock: "bg-slate-900"/, "and wears its own rail");
  assert.match(dashboard, /value=\{formatUnits\(kpis\.healthyCount\)\}/, "Healthy counts healthy rows, so the tiles add up");
  assert.doesNotMatch(dashboard, /\{cell\.areaName\} · \{cell\.regionName\}/, "an empty region is skipped, not printed as a bare separator");
  assert.match(
    dashboard,
    /function cellPlace\(cell: WeeklyStockCell\): string \{\s*return joinParts\(\[\s*cell\.areaName \? weeklyAreaLabel\(cell\.areaName\) : "",\s*cell\.regionName \? weeklyRegionLabel\(cell\.regionName\) : "",\s*weeklyDistributorLabel\(cell\.distributorName, cell\.distributorCode\),/,
    "the branch cards join only the parts that exist, in the screen's labels",
  );
  assert.equal((dashboard.match(/\{cellPlace\(cell\)\}/g) ?? []).length, 2, "the desktop table and the phone cards both print the joined place");
}
