import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  HOSPITAL_NAME_KEYWORDS,
  normalizeCustomerName,
  STORE_NAME_KEYWORDS,
} from "../src/lib/sales/customer-channel.ts";
import {
  assembleChannelBreakdown,
  assembleChannelComparison,
  breakdownLeader,
  resolveBreakdownLabel,
  sumBreakdownRows,
  sumLineTargets,
  type ChannelTotalsRow,
} from "../src/lib/sales/monthly-closing-channel-comparison.ts";
import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";

// The Channel Comparison sheet of the Monthly Closing workbook: Hospitals / Stores / Pharmacies,
// month by month. The fixture below is NOT invented — it is the real Anti Infective line as
// production returned it on 2026-08-05, and the value rows are the figures the owner reviewed.
// Pinning them here is what makes this a regression test rather than a shape test: three earlier
// attempts produced a plausible-looking sheet whose channel split was wrong.
//
// What each assertion protects:
//   1. Customers do NOT sum across months. Nearly every pharmacy buys every month, so summing the
//      columns reports ~11,700 pharmacies for a line that has about 1,700. The row total is the
//      BUSIEST month instead.
//   2. Block 1 reproduces the owner's reviewed table exactly, and the TOTAL row is the sum of the
//      three channels — the property that broke when direct orders were folded blindly into
//      Pharmacies (they are classified by their own customer name, and some of them are stores).
//   3. Targets appear ONCE per month and are never split per channel — targets are keyed
//      (month, line, area, product) and carry no channel, so a per-channel target is invented.
//   4. The Mix % block is live formulas over block 1, so the mix can never drift from the money.
//   5. The channel vocabulary that travels to SQL is derived from customer-channel.ts and folded,
//      never re-typed — a hand-transcribed copy once mis-stated the store channel by 8.7M EGP.

const PERIODS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];

// period -> [hospital, store, pharmacy] as { value, units, customers }.
const LIVE: Record<string, { customers: [number, number, number]; units: [number, number, number]; value: [number, number, number] }> = {
  "2026-01": { customers: [11, 26, 1716], units: [225, 1635, 7656], value: [18306, 138437, 614454] },
  "2026-02": { customers: [8, 20, 1620], units: [69, 1856, 7947], value: [6359, 151573, 653132] },
  "2026-03": { customers: [5, 22, 1548], units: [58, 1959, 8077], value: [6144, 175534, 663501] },
  "2026-04": { customers: [6, 22, 1567], units: [15, 910, 8470], value: [1566, 84638, 671438] },
  "2026-05": { customers: [9, 24, 1462], units: [122, 1686, 6949], value: [12956, 157171, 585930] },
  "2026-06": { customers: [7, 33, 1534], units: [34, 2625, 9671], value: [3376, 238447, 779333] },
  "2026-07": { customers: [7, 19, 1397], units: [61, 1057, 4929], value: [6730, 99694, 450035] },
};

// The owner's reviewed TOTAL row, kept separate so the test compares against HIS number rather
// than against a sum this file computed for itself.
const OWNER_TOTALS: Record<string, number> = {
  "2026-01": 771196, "2026-02": 811064, "2026-03": 845179, "2026-04": 757643,
  "2026-05": 756057, "2026-06": 1021156, "2026-07": 556460,
};

function rpcRows(): ChannelTotalsRow[] {
  const channels = ["hospital", "store", "pharmacy"] as const;
  return PERIODS.flatMap((period) =>
    channels.map((channel, index) => ({
      channel,
      customers: LIVE[period].customers[index],
      period,
      units: LIVE[period].units[index],
      value: LIVE[period].value[index],
    })),
  );
}

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

function buildMatrix(): MonthlyClosingMatrix {
  const total = cell(4929, 450035);
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: PERIODS,
    columns: [{ family: "Anti", productCode: "RO001", productName: "Royafloxacin 500mg" }],
    grandTotal: { cells: [total], kind: "grandTotal", rowTotal: total },
    line: "Anti Infective",
    period: "2026-07",
    regions: [
      {
        areas: [{
          areaCode: "CA4", areaName: "Cairo East 2", cells: [total], kind: "area" as const,
          regionCode: "CA", regionName: "Cairo", rowTotal: total,
        }],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: { cells: [total], kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: total },
      },
    ],
  };
}

const DIST_PRODUCT: ClosingExportData["distProduct"] = [{
  areaCode: "CA4", areaName: "Cairo East 2", distributorCode: "UCP", distributorName: "UCP",
  productCode: "RO001", productName: "Royafloxacin 500mg", regionCode: "CA", regionName: "Cairo",
  units: 4929, value: 450035,
}];

function buildComparison(): MonthlyClosingComparison {
  return {
    areaByDistributor: [], avgPrice: [], byDistributor: [], coverage: [],
    data: {
      areaByDist: [], bricks: [], customers: [], distProduct: DIST_PRODUCT,
      masterAreas: [{ areaCode: "CA4", areaName: "Cairo East 2", regionName: "Cairo" }],
      masterBricks: [], productByDist: [],
    },
    distributors: [{ code: "UCP", name: "UCP" }],
    insights: [], line: "Anti Infective",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 1, customerCount: 0, productCount: 1, units: 4929, value: 450035 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-07", productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [], totalAreas: 1, totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

function sheetValues(sheet: ExcelJS.Worksheet): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: (string | number | null)[] = [];
    row.eachCell({ includeEmpty: true }, (excelCell) => {
      const raw = excelCell.value;
      if (raw && typeof raw === "object" && "result" in raw) values.push((raw as { result: number }).result);
      else if (typeof raw === "number" || typeof raw === "string") values.push(raw);
      else values.push(null);
    });
    rows.push(values);
  });
  return rows;
}

const round = (value: unknown) => Math.round(Number(value ?? 0));

export async function runMonthlyClosingChannelsTests() {
  const comparison = assembleChannelComparison({
    line: "Anti Infective",
    restrictedProductsIncluded: false,
    rows: rpcRows(),
    // Only July carries targets in production — the earlier months were never uploaded, which is
    // exactly the blank-not-zero case the sheet has to render honestly.
    targetsByPeriod: { "2026-07": { targetUnits: 17005, targetValue: 1446382 } },
  });

  // ── 1. Customers are NOT summed across months ──────────────────────────────
  const pharmacies = comparison.rows.find((row) => row.channel === "pharmacy");
  assert.ok(pharmacies, "the pharmacy channel row exists");
  const summedPharmacyCustomers = PERIODS.reduce((sum, period) => sum + pharmacies.byPeriod[period].customers, 0);
  assert.equal(
    pharmacies.total.customers,
    1716,
    "a channel's customer total is its BUSIEST month (Jan, 1,716), never the sum of the months — "
    + `summing them would claim ${summedPharmacyCustomers} pharmacies for a line that has about 1,700`,
  );
  assert.equal(
    pharmacies.total.value,
    PERIODS.reduce((sum, period) => sum + pharmacies.byPeriod[period].value, 0),
    "value, by contrast, DOES sum across months — those are genuinely different sales",
  );

  // ── 2. Block 1 reproduces the owner's reviewed table ───────────────────────
  assert.deepEqual(comparison.periods, PERIODS, "months run oldest to newest, so the trend reads left to right");
  for (const period of PERIODS) {
    // The fixture holds the owner's per-channel figures already rounded to whole EGP, and his
    // TOTAL row was rounded from the unrounded sum — so the two can legitimately differ by 1 EGP.
    // Against live production the unrounded figures tie exactly; 1 EGP here is the rounding, not
    // a discrepancy, and anything larger is a real one.
    const drift = Math.abs(round(comparison.totalsByPeriod[period].value) - OWNER_TOTALS[period]);
    assert.ok(
      drift <= 1,
      `${period}: the three channels add up to the month total the owner reviewed `
      + `(${OWNER_TOTALS[period]} EGP, got ${round(comparison.totalsByPeriod[period].value)}, drift ${drift})`,
    );
  }

  // ── 3. The month total target is never split per channel ───────────────────
  assert.equal(
    sumLineTargets(
      [
        { lineCode: "anti_infective", targetUnits: 10, targetValue: 1000 },
        { lineCode: "anti_infective", targetUnits: 5, targetValue: 500 },
        { lineCode: "pedia", targetUnits: 99, targetValue: 9900 },
      ],
      "anti_infective",
    ).targetValue,
    1500,
    "a line's month target sums only its OWN areas and products, never another line's",
  );
  assert.equal(
    sumLineTargets([{ lineCode: "anti_infective", targetUnits: null, targetValue: null }], "anti_infective").targetValue,
    null,
    "a month nobody set a target for reports null, never 0 — a 0 target reads as 'asked to sell nothing'",
  );

  // ── 4 & 5. The rendered sheet ──────────────────────────────────────────────
  const buffer = await buildMonthlyClosingWorkbook(buildMatrix(), buildComparison(), undefined, {
    channelComparison: comparison,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.getWorksheet("Channel Comparison");
  assert.ok(sheet, "the workbook carries a Channel Comparison sheet");
  const rows = sheetValues(sheet);
  const flat = rows.map((row) => row.filter((value) => value !== null).join(" | "));

  for (const title of [
    "1 · Value by Month (EGP)",
    "2 · Units by Month",
    "3 · Customers by Month (distinct)",
    "4 · Mix % by Month (share of the month's value)",
    "5 · Month Total vs Target",
  ]) {
    assert.ok(flat.some((line) => line.includes(title)), `the sheet carries the block "${title}"`);
  }

  // Block 1's Pharmacies row, cell by cell, against the owner's figures.
  const pharmacyRows = rows.filter((row) => row[0] === "Pharmacies");
  assert.ok(pharmacyRows.length >= 4, "Pharmacies appears in the value, units, customers and mix blocks");
  const valueRow = pharmacyRows[0];
  PERIODS.forEach((period, index) => {
    assert.equal(
      round(valueRow[index + 1]),
      LIVE[period].value[2],
      `${period}: the Pharmacies value cell is the reviewed ${LIVE[period].value[2]} EGP`,
    );
  });

  // The TOTAL row of block 1 must be a live SUM of the three channel cells, not a typed number.
  const valueTotalRowIndex = rows.findIndex((row, index) => row[0] === "TOTAL" && index > rows.findIndex((r) => r[0] === "Hospitals"));
  assert.ok(valueTotalRowIndex > 0, "block 1 has a TOTAL row");
  PERIODS.forEach((period, index) => {
    const drift = Math.abs(round(rows[valueTotalRowIndex][index + 1]) - OWNER_TOTALS[period]);
    assert.ok(
      drift <= 1,
      `${period}: block 1's TOTAL row shows the owner's reviewed month total `
      + `(${OWNER_TOTALS[period]} EGP, got ${round(rows[valueTotalRowIndex][index + 1])})`,
    );
  });

  // Read every formula cell once, keyed by "<row label>|<column>", so the assertions below can ask
  // for a specific cell without re-walking the sheet (and without TypeScript losing the type
  // through a callback closure).
  const formulaCells = new Map<string, { formula: string; result?: number }>();
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const label = row.getCell(1).value;
    if (typeof label !== "string") return;
    for (let col = 2; col <= 12; col += 1) {
      const candidate = row.getCell(col).value;
      if (candidate && typeof candidate === "object" && "formula" in candidate) {
        const key = `${label}|${col}`;
        if (!formulaCells.has(key)) formulaCells.set(key, candidate as { formula: string; result?: number });
      }
    }
  });

  // The Mix % cells are live formulas pointing back at block 1, so they cannot drift from it.
  // Block 1's own Pharmacies row holds a plain value in column B, so the FIRST formula found in
  // that column under the "Pharmacies" label is the mix cell.
  const mixCell = formulaCells.get("Pharmacies|2");
  assert.ok(
    mixCell && /IFERROR\(B\d+\/B\$\d+,0\)/.test(mixCell.formula),
    `the Mix % cells divide block 1's own cells live (got ${mixCell?.formula ?? "no formula"})`,
  );

  // Block 5 is one row per month and never names a channel.
  const targetBlockStart = flat.findIndex((line) => line.includes("5 · Month Total vs Target"));
  const targetBlock = flat.slice(targetBlockStart, targetBlockStart + 3 + PERIODS.length);
  for (const label of ["Hospitals", "Stores (wholesalers)", "Pharmacies"]) {
    assert.ok(
      !targetBlock.some((line) => line.startsWith(label)),
      `the target block never carries a ${label} row — targets have no channel dimension`,
    );
  }
  assert.ok(
    targetBlock.some((line) => line.includes("Jul 2026") && line.includes("1446382")),
    "July's real month-total target is shown beside the month's sales",
  );
  assert.ok(
    flat.some((line) => line.includes("NOT A PER-CHANNEL TARGET")),
    "the sheet says on itself why the target is the month total, so it does not read as an omission",
  );

  // The ALL MONTHS achievement must not divide SEVEN months of sales by the ONE month that was
  // targeted — that reads as 381% against a target nobody set for the other six.
  const allMonthsAch = formulaCells.get("ALL MONTHS|4");
  assert.ok(allMonthsAch, "block 5 has an ALL MONTHS achievement cell");
  assert.ok(
    allMonthsAch.formula.includes("SUMIF("),
    `the ALL MONTHS achievement sums only the months carrying a target (got ${allMonthsAch.formula})`,
  );
  assert.ok(
    Math.abs((allMonthsAch.result ?? 0) - OWNER_TOTALS["2026-07"] / 1446382) < 0.01,
    "with July the only targeted month, the ALL MONTHS achievement is July's own — never seven months "
    + `of sales over one month's target (expected ~0.385, got ${allMonthsAch.result})`,
  );

  // The sheet declares which product scope produced it — the default view and the revealed view
  // are a different picture, not a rounding difference.
  assert.ok(
    flat.some((line) => line.includes("EXCLUDE the restricted products")),
    "the sheet states that the restricted products are excluded from these figures",
  );

  // The Dashboard lists the new tab, so a reader can reach it the same way as every other sheet.
  // The tab cell is a hyperlink object, not a plain string, so it has to be read as one.
  const dashboard = workbook.getWorksheet("Dashboard")!;
  const dashboardLinks: string[] = [];
  const dashboardText: string[] = [];
  dashboard.eachRow({ includeEmpty: false }, (row) => {
    const link = row.getCell(2).value;
    if (link && typeof link === "object" && "text" in link) dashboardLinks.push(String((link as { text: string }).text));
    const english = row.getCell(3).value;
    if (typeof english === "string") dashboardText.push(english);
  });
  assert.ok(
    dashboardLinks.includes("Channel Comparison"),
    `the Dashboard links to Channel Comparison among the tabs in this workbook (got ${dashboardLinks.join(", ")})`,
  );
  assert.ok(
    dashboardText.some((line) => line.includes("Hospitals, wholesalers and pharmacies month by month")),
    "the Dashboard explains what the Channel Comparison tab holds, in English and Arabic like every other tab",
  );

  // ── 5. The vocabulary that travels to SQL comes from customer-channel.ts ───
  // phx_closing_channel_totals receives these stems as parameters and phx_fold_customer_name must
  // fold names to the same form. If the TS fold changes, this fires and points at the SQL twin.
  assert.deepEqual(
    STORE_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)),
    ["مخزن", "فارم", "تريد", "الشركه", "الجمعيه", "للتجاره"],
    "the store stems sent to SQL are the folded customer-channel.ts words — never a second copy",
  );
  assert.deepEqual(
    HOSPITAL_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)),
    ["مستشف", "hosp"],
    "the hospital stems sent to SQL are the folded customer-channel.ts words",
  );

  await runChannelBreakdownTests();
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel Breakdown — the exported month cut by product, rep, area and brick.
//
// THE property: every grid sums to the SAME month total, because money that reaches no product,
// rep, area or brick is given a visible bucket row instead of being dropped. Direct orders carry no
// area and no brick at all; an area can be missing from the seat model; a seat can have no current
// occupant. Drop any of those and the grid quietly reports less than the month — which is exactly
// the thing that gets questioned.
//
// The fixture mirrors the real Anti Infective 2026-07 shape (direct = 93,554 with no area/brick/rep,
// 10 distributor rows with no brick, an area off the seat model, and a vacant seat) with round
// numbers so the arithmetic is readable.
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_TOTAL = 100_000;

function breakdownFixture() {
  // Each dimension partitions the same 100,000: 6,000 hospital + 24,000 store + 70,000 pharmacy.
  const row = (dimension: string, key: string, label: string, hospital: number, store: number, pharmacy: number) => ({
    dimension, hospital, key, label, pharmacy, store, total: hospital + store + pharmacy,
  });
  return [
    row("product", "RO001", "Royafloxacin", 6_000, 4_000, 30_000),
    row("product", "SA001", "Saginko", 0, 20_000, 40_000),

    row("rep", "B-55", "Warda Farhat", 6_000, 14_000, 20_000),
    row("rep", "__DIRECT__", "", 0, 0, 30_000),
    row("rep", "__NO_SEAT__", "", 0, 5_000, 10_000),
    row("rep", "__VACANT__:SEAT-AIF-REP-AB4", "Behira 1", 0, 5_000, 10_000),

    row("area", "D12", "", 6_000, 24_000, 40_000),
    row("area", "__DIRECT__", "", 0, 0, 30_000),

    row("brick", "BR-1", "", 6_000, 24_000, 30_000),
    row("brick", "__NO_BRICK__", "", 0, 0, 10_000),
    row("brick", "__DIRECT__", "", 0, 0, 30_000),
  ];
}

async function runChannelBreakdownTests() {
  const breakdown = assembleChannelBreakdown({
    line: "Anti Infective",
    period: "2026-07",
    restrictedProductsIncluded: false,
    rows: breakdownFixture(),
  });

  // ── 1. Every grid sums to the month, buckets included ──────────────────────
  for (const dimension of ["product", "rep", "area", "brick"] as const) {
    const rows = breakdown.byDimension[dimension];
    const totals = sumBreakdownRows(rows);
    assert.equal(
      totals.total,
      MONTH_TOTAL,
      `the ${dimension} grid adds up to the month total (${MONTH_TOTAL}) — money that reaches no `
      + `${dimension} must get a visible bucket row, never be dropped, or the grid silently reports less `
      + `than the Closing Matrix (got ${totals.total} from ${rows.length} rows)`,
    );
    assert.equal(
      totals.hospital + totals.store + totals.pharmacy,
      totals.total,
      `the ${dimension} grid's three channel columns add up to its own Total column`,
    );
  }

  // ── 2. Rows are ordered biggest first ──────────────────────────────────────
  const repTotals = breakdown.byDimension.rep.map((entry) => entry.total);
  assert.deepEqual(
    [...repTotals].sort((left, right) => right - left),
    repTotals,
    "each grid reads biggest first, so the row worth asking about is at the top",
  );

  // ── 3. Unattributable money is NAMED, never blank ──────────────────────────
  const maps = {
    areaName: new Map([["D12", "Menoufia 1"]]),
    brickName: new Map([["BR-1", "شبين الكوم"]]),
    productName: new Map([["RO001", "Royafloxacin 500mg"]]),
  };
  const labelOf = (dimension: "product" | "rep" | "area" | "brick", key: string) => {
    const entry = breakdown.byDimension[dimension].find((candidate) => candidate.key === key);
    assert.ok(entry, `${dimension} grid carries a ${key} row`);
    return resolveBreakdownLabel(dimension, entry, maps);
  };
  assert.equal(
    labelOf("rep", "__DIRECT__"),
    "Direct orders (company) — no rep seat owns them",
    "direct orders are named in the rep grid, not dropped and not folded into a real rep",
  );
  assert.equal(
    labelOf("area", "__DIRECT__"),
    "Direct orders (company) — no area on the row",
    "direct orders carry no area, so the area grid names them rather than inventing one",
  );
  assert.equal(
    labelOf("brick", "__DIRECT__"),
    "Direct orders (company) — no brick on the row",
    "same for the brick grid",
  );
  assert.equal(
    labelOf("brick", "__NO_BRICK__"),
    "Distributor sales whose brick did not map",
    "a distributor line whose brick did not map says so",
  );
  assert.equal(
    labelOf("rep", "__NO_SEAT__"),
    "Not on the seat model — no rep owns this area",
    "an area off the seat model says so",
  );
  assert.equal(
    labelOf("rep", "__VACANT__:SEAT-AIF-REP-AB4"),
    "Vacant seat — Behira 1",
    "a seat with no current occupant names the area it covers",
  );

  // Real rows take the workbook's own master names, so a grid never invents one.
  assert.equal(labelOf("area", "D12"), "Menoufia 1", "an area row shows the master's area name, not the code");
  assert.equal(labelOf("brick", "BR-1"), "شبين الكوم", "a brick row shows the master's brick name");
  assert.equal(labelOf("product", "RO001"), "Royafloxacin 500mg", "a product row shows the master's product name");

  // ── 4. Leader names the dominant channel and its share ─────────────────────
  const saginko = breakdown.byDimension.product.find((entry) => entry.key === "SA001")!;
  const leader = breakdownLeader(saginko);
  assert.equal(leader?.label, "Pharmacies", "Saginko's leading channel is pharmacies");
  assert.ok(
    Math.abs((leader?.share ?? 0) - 40_000 / 60_000) < 1e-9,
    `the leader's share is its own value over the row total (expected 0.667, got ${leader?.share})`,
  );
  assert.equal(
    breakdownLeader({ hospital: 0, key: "x", label: "x", pharmacy: 0, store: 0, total: 0 }),
    null,
    "a row that sold nothing claims no leader rather than a fake 100%",
  );

  // ── 5. The rendered sheet ties, cell by cell ───────────────────────────────
  const buffer = await buildMonthlyClosingWorkbook(buildMatrix(), buildComparison(), undefined, {
    channelBreakdown: breakdown,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("Channel Breakdown");
  assert.ok(sheet, "the workbook carries a Channel Breakdown sheet (name within Excel's 31-char cap)");

  const totalRows: number[] = [];
  sheet.eachRow({ includeEmpty: false }, (excelRow) => {
    if (excelRow.getCell(1).value !== "TOTAL") return;
    const cell = excelRow.getCell(5).value;
    if (cell && typeof cell === "object" && "result" in cell) totalRows.push(Number((cell as { result: number }).result));
  });
  assert.equal(totalRows.length, 4, "the sheet carries four grids, each with its own TOTAL row");
  for (const total of totalRows) {
    assert.equal(total, MONTH_TOTAL, `every grid's TOTAL row on the sheet reads the month total (got ${total})`);
  }

  const flat: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (excelRow) => {
    const values: string[] = [];
    excelRow.eachCell({ includeEmpty: true }, (cell) => values.push(String((cell.value as { result?: unknown })?.result ?? cell.value ?? "")));
    flat.push(values.join(" | "));
  });
  for (const title of ["1 · Product × Channel", "2 · Medical Rep × Channel", "3 · Area × Channel", "4 · Brick × Channel"]) {
    assert.ok(flat.some((line) => line.includes(title)), `the sheet carries the grid "${title}"`);
  }
  assert.ok(
    flat.some((line) => line.includes("adds up to the SAME month total")),
    "the sheet states on itself that every grid ties to the month, so a reader can check it",
  );
  assert.ok(
    flat.some((line) => line.includes("EXCLUDE the restricted products")),
    "the sheet states which product scope produced these figures",
  );
}
