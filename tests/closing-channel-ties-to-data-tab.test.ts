import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  assembleChannelBreakdown,
  assembleChannelComparison,
  sumBreakdownRows,
  UNIDENTIFIED_CHANNEL,
  type ChannelTotalsRow,
} from "../src/lib/sales/monthly-closing-channel-comparison.ts";
import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import { closingRowSalesValue, type ClosingDetailRow, type ClosingDetailsResult } from "../src/lib/sales/monthly-closing-details.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Channel sheets must equal the DATA SHEET, not merely each other.
//
// Both halves of this file are regressions against money that was really wrong in production on
// 2026-08-06, and both were invisible to the tests that existed — because those tests compared the
// channel sheets to figures the same code path produced. Two numbers derived from one formula agree
// however wrong the formula is. The Data sheet is the independent side, and it is the sheet the
// owner actually reconciles against, so it is what these assertions compare to.
//
// DEFECT 1 — a direct order was re-priced at factory price on the Data sheet.
//   The Data sheet's "Sales Value" column was computed as effectiveUnits x factoryPrice for EVERY
//   row. Direct orders are not priced that way: the owner's direct-order pricing rule is locked
//   (discount qty x PUBLIC x (1 - disc%), bonus qty x PHARMACY) and BANS factory price. So for
//   Anti Infective 2026-07 the Data sheet printed 87,502.50 over the 14 direct rows that
//   phx_monthly_closing_direct, the fact rollup's direct_value, the Direct Orders sheet and both
//   channel RPCs all publish as 93,554.00 — a 6,051.50 EGP gap on one line in one month, and the
//   discrepancy the owner reported. The correct total 556,459.55 was already in the workbook, one
//   column to the right, in "Sheet Value".
//
// DEFECT 2 — the channel RPCs dropped every row with no client code.
//   Their retail CTE filtered `client_code is not null`, inherited from phx_closing_customers where
//   it belongs. Here it silently removed real money the Closing Matrix counts: CNS 2026-05 was
//   short 4,363,635.38 EGP of 8,354,429.79, and five other CNS months were short too. Anti
//   Infective, Pedia and Head Office are clean in every 2026 month, which is exactly why a workbook
//   built from Anti Infective could not show it. The rows are kept now, in their own `unidentified`
//   bucket — NOT folded into Pharmacies, which is where a customer with no name would otherwise
//   land, and which would have reported 4.36M EGP of unattributable money as pharmacy sales.
//
// WHAT BREAKS THIS FILE: revert closingRowSalesValue to `effectiveUnits * factoryPrice` for every
// row and assertion 1 fires by name, then the workbook tie in assertion 3 fires too, because the
// Data sheet's Sales Value column moves and the channel total no longer equals it.
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD = "2026-07";

// The real Anti Infective 2026-07 direct rows, collapsed to their two products. Both were verified
// against production: the stored value is what the closing publishes, and neither product's stored
// value equals qty x factory price — which is the whole point.
const DIRECT_FIXTURE = [
  // Saginko: 350 units, published at 48,888.00 (= 350 x 139.68, the PHARMACY price).
  // Factory price would give 350 x 111.15 = 38,902.50.
  { factoryPrice: 111.15, productCode: "SA001", qty: 350, storedValue: 48_888 },
  // Royafloxacin: 800 units, published at 44,666.00 (negotiated per-row unit prices).
  // Factory price would give 800 x 60.75 = 48,600.00.
  { factoryPrice: 60.75, productCode: "RO001", qty: 800, storedValue: 44_666 },
];
const DIRECT_VALUE = 93_554;
const DIRECT_UNITS = 1_150;
const DIRECT_AT_FACTORY_PRICE = 87_502.5;

// The distributor half, kept deliberately simple: one row whose stored value already equals
// units x factory price, exactly as every real distributor row does.
const RETAIL_UNITS = 4_897;
const RETAIL_VALUE = 462_905.55;
const RETAIL_FACTORY_PRICE = RETAIL_VALUE / RETAIL_UNITS;

const MONTH_TOTAL = RETAIL_VALUE + DIRECT_VALUE; // 556,459.55 — the published Closing Matrix total.

function detailRow(overrides: Partial<ClosingDetailRow>): ClosingDetailRow {
  const qty = overrides.qty ?? 0;
  const discount = overrides.discount ?? 0;
  const factoryPrice = overrides.factoryPrice ?? 0;
  const effectiveUnits = qty * (1 - discount);
  const isDirect = overrides.isDirect ?? false;
  const sheetValue = overrides.sheetValue ?? effectiveUnits * factoryPrice;
  // THE POINT OF THIS FIXTURE: the Data sheet's money comes from the SAME rule the loader uses, so
  // breaking that rule moves this sheet and the tie-back below catches it.
  const salesValue = closingRowSalesValue({ effectiveUnits, factoryPrice, isDirect, sheetValue });
  const base: ClosingDetailRow = {
    areaCode: "CA4",
    areaMismatch: false,
    areaName: "Cairo East 2",
    blockCode: "BL01",
    bonusQty: 0,
    brickId: "BR-1",
    brickName: "Nasr City",
    brickUnmapped: false,
    clientAddress: "",
    clientCode: isDirect ? "" : "C1",
    clientName: isDirect ? "Direct customer" : "El Nile Pharmacy",
    discount,
    distributorCode: isDirect ? "DIRECT" : "UCP",
    effectiveUnits,
    exclusions: isDirect ? ["direct"] : [],
    factoryPrice,
    family: "Anti",
    id: 1,
    includedInClosing: !isDirect,
    invoiceDate: "2026-07-15",
    invoicePeriod: PERIOD,
    isConfidential: false,
    isDirect,
    missingClientCode: isDirect,
    officialLine: "Anti Infective",
    productCode: "RO001",
    productName: "Royafloxacin 500mg",
    qty,
    regionCode: "CA",
    regionName: "Cairo",
    rowNumber: 1,
    salesValue,
    sheetAreaCode: "CA4",
    sheetAreaName: "Cairo East 2",
    sheetRegionCode: "CA",
    sheetRegionName: "Cairo",
    sheetValue,
    validationState: "valid",
  };
  // salesValue is re-applied after the spread so an override of qty or price can never leave a
  // stale money figure behind — the fixture must always obey the rule it is testing.
  return { ...base, ...overrides, salesValue };
}

function detailRows(): ClosingDetailRow[] {
  return [
    detailRow({ factoryPrice: RETAIL_FACTORY_PRICE, id: 1, qty: RETAIL_UNITS }),
    ...DIRECT_FIXTURE.map((entry, index) =>
      detailRow({
        factoryPrice: entry.factoryPrice,
        id: 100 + index,
        isDirect: true,
        productCode: entry.productCode,
        qty: entry.qty,
        sheetValue: entry.storedValue,
      })),
  ];
}

function buildDetails(): ClosingDetailsResult {
  const rows = detailRows();
  const totals = {
    effectiveUnits: rows.reduce((sum, row) => sum + row.effectiveUnits, 0),
    rows: rows.length,
    salesValue: Number(rows.reduce((sum, row) => sum + row.salesValue, 0).toFixed(6)),
    units: rows.reduce((sum, row) => sum + row.qty, 0),
  };
  const only = (predicate: (row: ClosingDetailRow) => boolean) => {
    const matching = rows.filter(predicate);
    return {
      effectiveUnits: matching.reduce((sum, row) => sum + row.effectiveUnits, 0),
      rows: matching.length,
      salesValue: Number(matching.reduce((sum, row) => sum + row.salesValue, 0).toFixed(6)),
      units: matching.reduce((sum, row) => sum + row.qty, 0),
    };
  };
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: [PERIOD],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: "Anti Infective",
    options: { areas: [], distributors: [], products: [], regions: [] },
    outOfScope: false,
    page: 1,
    pageSize: 1000,
    period: PERIOD,
    reconciliation: {
      areaMismatches: only((row) => row.areaMismatch),
      excludedConfidential: only((row) => row.isConfidential),
      excludedDirect: only((row) => row.isDirect),
      includedInClosing: only((row) => row.includedInClosing),
      missingClientCode: only((row) => row.missingClientCode),
      unmappedBricks: only((row) => row.brickUnmapped),
    },
    rows,
    totals,
  };
}

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

function buildMatrix(): MonthlyClosingMatrix {
  const total = cell(RETAIL_UNITS + DIRECT_UNITS, MONTH_TOTAL);
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: [PERIOD],
    columns: [{ family: "Anti", productCode: "RO001", productName: "Royafloxacin 500mg" }],
    grandTotal: { cells: [total], kind: "grandTotal", rowTotal: total },
    line: "Anti Infective",
    period: PERIOD,
    regions: [{
      areas: [{
        areaCode: "CA4", areaName: "Cairo East 2", cells: [total], kind: "area" as const,
        regionCode: "CA", regionName: "Cairo", rowTotal: total,
      }],
      regionCode: "CA",
      regionName: "Cairo",
      subtotal: { cells: [total], kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: total },
    }],
  };
}

const DIST_PRODUCT: ClosingExportData["distProduct"] = [{
  areaCode: "CA4", areaName: "Cairo East 2", distributorCode: "UCP", distributorName: "UCP",
  productCode: "RO001", productName: "Royafloxacin 500mg", regionCode: "CA", regionName: "Cairo",
  units: RETAIL_UNITS, value: RETAIL_VALUE,
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
    national: { areaCount: 1, customerCount: 0, productCount: 1, units: RETAIL_UNITS, value: RETAIL_VALUE },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: PERIOD, productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [], totalAreas: 1, totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

/** The channel split as the RPC returns it: the same month total, cut by who bought it. */
function channelRpcRows(): ChannelTotalsRow[] {
  return [
    { channel: "hospital", customers: 7, period: PERIOD, units: 61, value: 6_729.75 },
    { channel: "store", customers: 19, period: PERIOD, units: 1_057, value: 99_694.35 },
    { channel: "pharmacy", customers: 1_397, period: PERIOD, units: RETAIL_UNITS + DIRECT_UNITS - 61 - 1_057, value: MONTH_TOTAL - 6_729.75 - 99_694.35 },
  ];
}

function sheetGrid(sheet: ExcelJS.Worksheet): (string | number | null)[][] {
  const grid: (string | number | null)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: (string | number | null)[] = [];
    row.eachCell({ includeEmpty: true }, (excelCell) => {
      const raw = excelCell.value;
      if (raw && typeof raw === "object" && "result" in raw) values.push((raw as { result: number }).result);
      else if (typeof raw === "number" || typeof raw === "string") values.push(raw);
      else values.push(null);
    });
    grid.push(values);
  });
  return grid;
}

const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;

export async function runClosingChannelTiesToDataTabTests() {
  // ── 1. The money rule itself — the assertion that fires when the fix is reverted ──────────
  //
  // Deliberately the FIRST assertion in the file and phrased as the rule, not as a number, so a
  // failure names the business rule that broke rather than "expected 48888 got 38902.5".
  const saginko = DIRECT_FIXTURE[0];
  assert.equal(
    closingRowSalesValue({
      effectiveUnits: saginko.qty,
      factoryPrice: saginko.factoryPrice,
      isDirect: true,
      sheetValue: saginko.storedValue,
    }),
    saginko.storedValue,
    "a DIRECT order is worth the money the order itself states — factory price is BANNED for direct "
      + "orders by the owner's locked pricing rule, and re-deriving it here understated Anti Infective "
      + "2026-07 by 6,051.50 EGP",
  );
  assert.notEqual(
    saginko.storedValue,
    saginko.qty * saginko.factoryPrice,
    "the fixture is only meaningful while the two formulas genuinely disagree on this row",
  );
  assert.equal(
    closingRowSalesValue({ effectiveUnits: 100, factoryPrice: 12.5, isDirect: false, sheetValue: 999 }),
    1_250,
    "a DISTRIBUTOR row is still effective units x factory price — the Closing Matrix's own formula, "
      + "and it must NOT start trusting the sheet's stated value instead",
  );

  // ── 2. The Data sheet's own totals ────────────────────────────────────────────────────────
  const details = buildDetails();
  assert.equal(
    money(details.reconciliation.excludedDirect.salesValue),
    DIRECT_VALUE,
    `the direct rows total ${DIRECT_VALUE} on the Data sheet, the same figure phx_monthly_closing_direct `
      + `publishes — not ${DIRECT_AT_FACTORY_PRICE}, which is what factory price would give`,
  );
  assert.equal(
    money(details.reconciliation.includedInClosing.salesValue),
    RETAIL_VALUE,
    "the retail half is untouched by all of this — direct rows are In Closing = \"No\" and never "
      + "reach the Closing Matrix headline",
  );

  // ── 3. THE HEADLINE TIE: Channel Comparison == the Data sheet, in the rendered workbook ────
  const comparison = assembleChannelComparison({
    line: "Anti Infective",
    restrictedProductsIncluded: false,
    rows: channelRpcRows(),
  });
  const buffer = await buildMonthlyClosingWorkbook(buildMatrix(), buildComparison(), details, {
    channelComparison: comparison,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const dataSheet = workbook.getWorksheet("Data");
  assert.ok(dataSheet, "the workbook carries the Data sheet the owner reconciles against");
  const dataGrid = sheetGrid(dataSheet);
  // Find the "Sales Value" column by NAME, never by index: RAW_COLUMNS is edited often and a
  // hard-coded column number would silently start summing "Sheet Value" instead — the very column
  // whose disagreement with this one was the bug.
  const headerRow = dataGrid.find((row) => row.includes("Sales Value"));
  assert.ok(headerRow, "the Data sheet has a Sales Value column");
  const salesValueCol = headerRow.indexOf("Sales Value");
  const inClosingCol = headerRow.indexOf("In Closing");
  const dataRows = dataGrid.slice(dataGrid.indexOf(headerRow) + 1)
    .filter((row) => row[inClosingCol] === "Yes" || row[inClosingCol] === "No");
  const dataSheetTotal = money(dataRows.reduce((sum, row) => sum + Number(row[salesValueCol] ?? 0), 0));

  assert.equal(
    dataSheetTotal,
    MONTH_TOTAL,
    `the Data sheet's Sales Value column, summed over EVERY row, is ${MONTH_TOTAL} — the published `
      + "Closing Matrix grand total. It read 550,408.05 while direct orders were priced at factory price",
  );

  const channelSheet = workbook.getWorksheet("Channel Comparison");
  assert.ok(channelSheet, "the workbook carries the Channel Comparison sheet");
  const channelGrid = sheetGrid(channelSheet);
  // Block 1's TOTAL row: the first TOTAL under the "1 · Value by Month" title.
  const valueTitleIndex = channelGrid.findIndex((row) => String(row[0] ?? "").startsWith("1 ·"));
  assert.ok(valueTitleIndex >= 0, "the Channel Comparison sheet opens with its Value by Month block");
  const valueTotalRow = channelGrid.slice(valueTitleIndex).find((row) => row[0] === "TOTAL");
  assert.ok(valueTotalRow, "block 1 carries a TOTAL row");
  const channelMonthTotal = money(valueTotalRow[1]);

  // ── The assertion this whole file exists for ──
  assert.equal(
    channelMonthTotal,
    dataSheetTotal,
    `the Channel Comparison's total for the exported month (${channelMonthTotal}) must equal the Data `
      + `sheet's own Sales Value column summed over every row (${dataSheetTotal}). These are the two `
      + "sheets the owner reads against each other, and they disagreed by 6,051.50 EGP because the "
      + "Data sheet re-priced direct orders at factory price",
  );

  // ── 4. The workbook says the tie on itself, so a reader need not sum a column by hand ─────
  const tieTitleIndex = channelGrid.findIndex((row) => String(row[0] ?? "").startsWith("6 ·"));
  assert.ok(tieTitleIndex >= 0, "the Channel Comparison sheet carries a tie-back block naming the Data sheet");
  const differenceRow = channelGrid.slice(tieTitleIndex).find((row) => row[0] === "Difference");
  assert.ok(differenceRow, "the tie-back block ends on a Difference row");
  assert.equal(
    money(differenceRow[2]),
    0,
    "the tie-back block's Difference must print 0 — it is the reader's proof that this sheet and the "
      + "Data sheet are the same money, and it is a live formula so it stays true if a cell is edited",
  );
  const tieText = channelGrid.slice(tieTitleIndex, tieTitleIndex + 8).flat()
    .filter((value): value is string => typeof value === "string").join(" ");
  assert.ok(
    tieText.includes("factory price") && tieText.includes("direct"),
    "the sheet STATES which definition it uses for each half rather than leaving the reader to infer "
      + `it — retail at factory price, direct at the order's own money (got: ${tieText.slice(0, 200)})`,
  );

  // ── 5. Rows with no client code are counted, and are NOT called pharmacies ────────────────
  //
  // Defect 2. The figures are CNS 2026-05 as production returned it on 2026-08-06.
  const CNS_CLASSIFIED = 3_990_794.42;
  const CNS_UNIDENTIFIED = 4_363_635.38;
  const cnsComparison = assembleChannelComparison({
    line: "CNS",
    restrictedProductsIncluded: false,
    rows: [
      { channel: "hospital", customers: 40, period: "2026-05", units: 1_000, value: 500_000 },
      { channel: "store", customers: 90, period: "2026-05", units: 2_000, value: 1_000_000 },
      { channel: "pharmacy", customers: 9_903, period: "2026-05", units: 5_000, value: CNS_CLASSIFIED - 1_500_000 },
      { channel: UNIDENTIFIED_CHANNEL, customers: 0, period: "2026-05", units: 8_000, value: CNS_UNIDENTIFIED },
    ],
  });
  assert.equal(
    money(cnsComparison.totalsByPeriod["2026-05"]?.value),
    money(CNS_CLASSIFIED + CNS_UNIDENTIFIED),
    "a month's channel total includes the rows that carry no client code — dropping them made CNS "
      + "2026-05 report 3,990,794.42 against a Data sheet showing 8,354,429.79",
  );
  const unidentifiedRow = cnsComparison.rows.find((row) => row.channel === UNIDENTIFIED_CHANNEL);
  assert.ok(unidentifiedRow, "the unidentified money gets its OWN row");
  assert.equal(
    money(unidentifiedRow.total.value),
    CNS_UNIDENTIFIED,
    "and carries its full value rather than a share of it",
  );
  assert.equal(
    unidentifiedRow.total.customers,
    0,
    "with 0 customers — there is no identity on those rows to count, and inventing one would be a "
      + "second lie on top of the first",
  );
  const cnsPharmacy = cnsComparison.rows.find((row) => row.channel === "pharmacy");
  assert.equal(
    money(cnsPharmacy?.total.value),
    money(CNS_CLASSIFIED - 1_500_000),
    "and NOT added to Pharmacies, which is where an unnamed customer lands by default — that would "
      + "have reported 4.36M EGP of unattributable money as pharmacy sales",
  );

  // A clean line must not grow a row of zeroes for a bucket it has nothing in.
  const cleanComparison = assembleChannelComparison({
    line: "Anti Infective",
    restrictedProductsIncluded: false,
    rows: channelRpcRows(),
  });
  assert.equal(
    cleanComparison.rows.some((row) => row.channel === UNIDENTIFIED_CHANNEL),
    false,
    "a line with no identity-less money shows no unidentified row at all — a zero row in an "
      + "exception report reads as a defect rather than as reassurance",
  );

  // ── 6. Every breakdown grid still sums to its month, with the bucket in its own column ────
  const breakdown = assembleChannelBreakdown({
    line: "CNS",
    period: "2026-05",
    restrictedProductsIncluded: false,
    rows: [
      { dimension: "product", hospital: 500_000, key: "CN001", label: "", pharmacy: 2_490_794.42, store: 1_000_000, total: 8_354_429.80, unidentified: CNS_UNIDENTIFIED },
    ],
  });
  const productTotals = sumBreakdownRows(breakdown.byDimension.product);
  assert.equal(
    money(productTotals.hospital + productTotals.store + productTotals.pharmacy + productTotals.unidentified),
    money(productTotals.total),
    "hospital + store + pharmacy + unidentified = total. Without the fourth column `total` quietly "
      + "exceeds the columns beside it and the grid stops adding up on screen",
  );

  // Tolerance: a database where the RPC has not been migrated yet returns no `unidentified` field.
  // The app must read 0 and behave exactly as before rather than producing NaN across every grid.
  const legacy = assembleChannelBreakdown({
    line: "CNS",
    period: "2026-05",
    restrictedProductsIncluded: false,
    rows: [{ dimension: "area", hospital: 10, key: "D12", label: "", pharmacy: 30, store: 20, total: 60 } as never],
  });
  assert.equal(
    legacy.byDimension.area[0]?.unidentified,
    0,
    "against an un-migrated database the missing column reads 0, never NaN — the migration and the "
      + "deploy are separate steps here, so either order has to be safe",
  );
}
