import assert from "node:assert/strict";

import {
  countsInClosingHeadline,
  type ClosingHeadlineRow,
} from "../src/lib/sales/closing-headline.ts";
import {
  narrowClosingDetailsToAreas,
  resolveClosingDetailSalesValue,
  summarize,
  type ClosingDetailRow,
  type ClosingDetailsResult,
} from "../src/lib/sales/monthly-closing-details.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "IN CLOSING 0.00" — the Finance Manager's own Monthly Closing tab, on the money he had just
// booked. Reported 2026-08-25: "the finance manager choose the sales month and sales not sync in
// monthly closing … in direct orders".
//
// WHAT HE WAS LOOKING AT. Booking a Direct Order into a sales month is the Finance Manager's job:
// approval leaves `sales_month` null, he sets it from the Direct Orders desk, and the closing is
// rebuilt for that month. He had booked twenty orders into 2026-08. Every layer under the surface
// was right — the batch validated, the rollup tied to the cent, the Closing Matrix showed the money
// — and the one page he is allowed to open said this:
//
//                            In closing        Direct (excluded)
//   Anti Infective                 0.00                29,947.50
//   Pedia                          0.00               274,488.75
//
// Two separate defects in one card, which is why fixing either alone still reads wrong:
//
//   A. THE LABEL. Direct is INSIDE the closing — the screen and the workbook both render
//      `injectDirectIntoMatrix(matrix, direct)`, so booked orders sit in the grand total. Details
//      derived its headline from `includedInClosing`, which means "feeds phx_monthly_closing_matrix"
//      — the DISTRIBUTOR half. 2026-08 carries no distributor sell-out yet (checked: 22 validated
//      import rows for the month, all of them direct), so the headline was a true 0.00 for a
//      question nobody asked, beside 290,387.57 EGP of real sales flagged "excluded".
//
//   B. THE MONEY. Both figures in the right-hand column are also wrong — see
//      july-2026-direct-value-is-stored.test.ts, which pins the value rule itself.
//
// `includedInClosing` was NOT widened to fix this. The export's Data/Total SUMIFS bridge, the
// portal's rebuildMatrixFromRows fold and store-sales-city-split all read it as the distributor
// half, and widening it in place double-counts direct in every one of them. The headline question
// got its own name instead, in a leaf module a "use client" component can import without dragging
// the service-role Supabase client into the browser bundle.
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD = "2026-08";

/**
 * The twenty approved Direct Orders Finance booked into 2026-08, exactly as production carries
 * them. Read from `source_of_sales_import_rows` on 2026-08-25 and folded to one row per product:
 * 22 import rows over 6 products, same units, same money to the piastre.
 *
 * `recomputed` is what effectiveUnits x factoryPrice produces for the same row — kept beside the
 * deal value because the error runs in OPPOSITE directions (Saginko under by 1,758.60, Lacto
 * Advanced 1 over by 14,983.20), which is what rules out any correction factor.
 */
const AUGUST_DIRECT = [
  { code: "RO001", factoryPrice: 60.75, line: "Anti Infective", name: "Royafloxacin", qty: 310, recomputed: 18_832.50, stored: 18_655.30 },
  { code: "SA001", factoryPrice: 111.15, line: "Anti Infective", name: "Saginko", qty: 100, recomputed: 11_115.00, stored: 12_873.60 },
  { code: "GU001", factoryPrice: 60.75, line: "Pedia", name: "Guamusin", qty: 40, recomputed: 2_430.00, stored: 2_619.00 },
  { code: "IV001", factoryPrice: 30.375, line: "Pedia", name: "Ivyronc", qty: 850, recomputed: 25_818.75, stored: 27_826.87 },
  { code: "LA001", factoryPrice: 270, line: "Pedia", name: "Lacto Advanced 1", qty: 768, recomputed: 207_360.00, stored: 192_376.80 },
  { code: "LA002", factoryPrice: 270, line: "Pedia", name: "Lacto Advanced 2", qty: 144, recomputed: 38_880.00, stored: 36_036.00 },
] as const;

/** The sum of the twenty orders' own deal values. The number the Closing Matrix already showed. */
const AUGUST_DIRECT_VALUE = 290_387.57;
/** What the Details surface published instead. Never to come back. */
const AUGUST_DIRECT_AT_FACTORY_PRICE = 304_436.25;
const AUGUST_DIRECT_UNITS = 2_212;

function detailRow(overrides: Partial<ClosingDetailRow> = {}): ClosingDetailRow {
  const base: ClosingDetailRow = {
    id: 1,
    rowNumber: 1,
    distributorCode: "Direct",
    invoicePeriod: PERIOD,
    invoiceDate: "2026-08-20",
    officialLine: "Pedia",
    sheetAreaCode: "",
    sheetAreaName: "",
    sheetRegionCode: "GZ",
    sheetRegionName: "Giza",
    blockCode: "",
    brickId: "",
    brickName: "",
    areaCode: "GZ1",
    areaName: "Giza One",
    regionCode: "GZ",
    regionName: "Giza",
    operationalRegionCode: "GZ",
    operationalRegionName: "Giza",
    areaMismatch: false,
    brickUnmapped: false,
    clientCode: "",
    clientName: "",
    clientAddress: "",
    productCode: "LA001",
    productName: "Lacto Advanced 1",
    family: "Lacto",
    factoryPrice: 270,
    qty: 100,
    bonusQty: 0,
    discount: 0,
    effectiveUnits: 100,
    salesValue: 0,
    sheetValue: 1,
    isDirect: true,
    isConfidential: false,
    missingClientCode: true,
    validationState: "valid",
    includedInClosing: false,
    exclusions: ["direct"],
    ...overrides,
  };
  // Derive the value the way loadMonthlyClosingDetails does, so the fixture cannot drift from it.
  return {
    ...base,
    effectiveUnits: base.qty * (1 - base.discount),
    salesValue: Number(resolveClosingDetailSalesValue({
      effectiveUnits: base.qty * (1 - base.discount),
      factoryPrice: base.factoryPrice,
      invoicePeriod: base.invoicePeriod,
      isDirect: base.isDirect,
      sheetValue: base.sheetValue,
    }).toFixed(6)),
  };
}

const augustRows = (): ClosingDetailRow[] =>
  AUGUST_DIRECT.map((product, index) => detailRow({
    factoryPrice: product.factoryPrice,
    id: index + 1,
    officialLine: product.line,
    productCode: product.code,
    productName: product.name,
    qty: product.qty,
    sheetValue: product.stored,
  }));

// ── 1. the predicate itself ───────────────────────────────────────────────────
function runPredicateTests() {
  const ask = (over: Partial<ClosingHeadlineRow>) => countsInClosingHeadline({
    includedInClosing: false,
    isConfidential: false,
    isDirect: false,
    ...over,
  });

  assert.equal(
    ask({ includedInClosing: true }),
    true,
    "a distributor row that feeds phx_monthly_closing_matrix is in the headline — unchanged",
  );
  assert.equal(
    ask({ isDirect: true }),
    true,
    "THE FIX: a booked direct order is in the headline too. injectDirectIntoMatrix places it in "
    + "the grid the reader is looking at, so its money is inside that grand total",
  );
  assert.equal(
    ask({}),
    false,
    "a row that is neither is genuinely outside the headline",
  );
  assert.equal(
    ask({ includedInClosing: true, isConfidential: true }),
    false,
    "confidential products (LA003 / LA004 / SS001) are the ONE true exclusion — every closing RPC "
    + "drops them in SQL, so no confidential row may be counted into a headline",
  );
  assert.equal(
    ask({ isConfidential: true, isDirect: true }),
    false,
    "phx_monthly_closing_direct excludes them too, which is exactly why this predicate is not "
    + "written as `includedInClosing || isDirect` — a confidential DIRECT row would slip through",
  );
}

// ── 2. the card the Finance Manager actually reads ────────────────────────────
function runHeadlineTotalsTests() {
  const rows = augustRows();

  // The old headline, reproduced. This is not a regression — it is the correct answer to the
  // distributor question, and the reason reading it as the headline was so convincing.
  const distributorHalf = summarize(rows, (row) => row.includedInClosing);
  assert.equal(
    distributorHalf.rows,
    0,
    "2026-08 carries no distributor sell-out yet, so the DISTRIBUTOR half is legitimately empty. "
    + "Printing this as \"In closing\" is what put 0.00 on the Finance Manager's screen",
  );
  assert.equal(Number(distributorHalf.salesValue.toFixed(2)), 0);

  const headline = summarize(rows, countsInClosingHeadline);
  assert.equal(
    Number(headline.salesValue.toFixed(2)),
    AUGUST_DIRECT_VALUE,
    "the \"In closing\" card must read 290,387.57 — the same money the Closing Matrix beside it "
    + "already showed, and the sum of the twenty orders Finance booked into the month",
  );
  assert.equal(
    headline.rows,
    rows.length,
    "and it must count every one of those rows, not none of them",
  );
  assert.equal(
    Number(headline.units.toFixed(2)),
    AUGUST_DIRECT_UNITS,
    "units too — 2,212, taken as booked",
  );
  assert.notEqual(
    Number(headline.salesValue.toFixed(2)),
    AUGUST_DIRECT_AT_FACTORY_PRICE,
    "304,436.25 is the factory-price recompute the page used to publish. Factory price is BANNED "
    + "from the Direct Orders module; if this figure returns, so has the recompute",
  );

  // Per line, because the two disagreed in opposite directions and a national total can hide that.
  for (const line of ["Anti Infective", "Pedia"] as const) {
    const ofLine = rows.filter((row) => row.officialLine === line);
    const expected = Number(
      AUGUST_DIRECT.filter((p) => p.line === line).reduce((sum, p) => sum + p.stored, 0).toFixed(2),
    );
    const wrong = Number(
      AUGUST_DIRECT.filter((p) => p.line === line).reduce((sum, p) => sum + p.recomputed, 0).toFixed(2),
    );
    assert.equal(
      Number(summarize(ofLine, countsInClosingHeadline).salesValue.toFixed(2)),
      expected,
      `${line} 2026-08 direct is ${expected.toFixed(2)} in the headline, not the ${wrong.toFixed(2)} `
      + "a factory-price recompute gives",
    );
  }

  // `excludedDirect` still answers its own question. The panel prints it as "of which Direct", and
  // the export's Data/Total bridge subtracts it — both need it to stay the direct total.
  assert.equal(
    Number(summarize(rows, (row) => row.isDirect).salesValue.toFixed(2)),
    AUGUST_DIRECT_VALUE,
    "in a direct-only month the two totals coincide, and both must be the deal value",
  );
}

// ── 3. the distributor half must not move ─────────────────────────────────────
//
// The whole point of adding a predicate rather than widening `includedInClosing`: three consumers
// read that flag as "the distributor half" and double-count if it grows.
function runDistributorHalfUnchangedTests() {
  const distributor = detailRow({
    distributorCode: "IS",
    exclusions: [],
    factoryPrice: 270,
    id: 99,
    includedInClosing: true,
    isDirect: false,
    missingClientCode: false,
    qty: 100,
    sheetValue: 27_000,
  });
  const rows = [...augustRows(), distributor];

  assert.equal(
    Number(distributor.salesValue.toFixed(2)),
    27_000,
    "a distributor invoice line is still effectiveUnits x factoryPrice (100 x 270) — the formula "
    + "phx_monthly_closing_matrix values sell-out at",
  );

  const distributorHalf = summarize(rows, (row) => row.includedInClosing);
  assert.equal(distributorHalf.rows, 1, "exactly one row feeds the distributor matrix");
  assert.equal(
    Number(distributorHalf.salesValue.toFixed(2)),
    27_000,
    "`includedInClosing` must still mean the DISTRIBUTOR half and nothing else. Widening it here "
    + "would double-count direct in the export's Data/Total bridge, in the portal's "
    + "rebuildMatrixFromRows fold and in store-sales-city-split",
  );

  const headline = summarize(rows, countsInClosingHeadline);
  assert.equal(
    Number(headline.salesValue.toFixed(2)),
    Number((AUGUST_DIRECT_VALUE + 27_000).toFixed(2)),
    "the headline is the two channels ADDED — 290,387.57 direct + 27,000.00 sell-out",
  );
  assert.equal(headline.rows, rows.length);
}

// ── 4. confidential is dropped from the headline, on a DIRECT row too ─────────
function runConfidentialTests() {
  const confidentialDirect = detailRow({
    exclusions: ["direct", "confidential"],
    factoryPrice: 270,
    id: 500,
    isConfidential: true,
    productCode: "LA003",
    productName: "Lacto Advanced 3",
    qty: 100,
    sheetValue: 25_000,
  });
  const rows = [...augustRows(), confidentialDirect];

  assert.equal(
    Number(summarize(rows, countsInClosingHeadline).salesValue.toFixed(2)),
    AUGUST_DIRECT_VALUE,
    "a confidential DIRECT row adds nothing to the headline: the closing RPCs never returned it, "
    + "so counting it here would make the card disagree with the grid beside it — and would show a "
    + "restricted product's money to a reader who may not see the product",
  );
  assert.equal(
    Number(summarize(rows, (row) => row.isConfidential).salesValue.toFixed(2)),
    25_000,
    "it is still reported in its own `excludedConfidential` total, where it belongs",
  );
}

// ── 5. the portal narrows to the reader's areas and RECOMPUTES the headline ───
//
// A manager opening the same tab sees only his own areas. The narrow re-summarises every total; if
// the headline were carried over unchanged it would show him company-wide money on his own page.
function runNarrowedScopeTests() {
  const rows = augustRows().map((row, index) => ({
    ...row,
    areaCode: index % 2 === 0 ? "GZ1" : "UE1",
    areaName: index % 2 === 0 ? "Giza One" : "Upper Egypt One",
  }));
  const details = {
    availableLines: ["Pedia"],
    availablePeriods: [PERIOD],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: "Pedia",
    options: { areas: [], distributors: [], products: [], regions: [] },
    outOfScope: false,
    page: 1,
    pageSize: rows.length,
    period: PERIOD,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      closingHeadline: summarize(rows, countsInClosingHeadline),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  } as unknown as ClosingDetailsResult;

  assert.equal(
    Number(details.reconciliation.closingHeadline.salesValue.toFixed(2)),
    AUGUST_DIRECT_VALUE,
    "company-wide, the headline is the whole month",
  );

  const narrowed = narrowClosingDetailsToAreas(details, ["GZ1"]);
  const expected = Number(
    rows.filter((row) => row.areaCode === "GZ1")
      .reduce((sum, row) => sum + row.salesValue, 0)
      .toFixed(2),
  );
  assert.ok(expected > 0 && expected < AUGUST_DIRECT_VALUE, "the fixture must actually narrow");
  assert.equal(
    Number(narrowed.reconciliation.closingHeadline.salesValue.toFixed(2)),
    expected,
    "narrowed to one area the headline must be recomputed from the rows that survived, never "
    + "carried over — a manager's page showing the national total is a data-exposure bug, not a "
    + "cosmetic one",
  );
  assert.equal(
    narrowed.reconciliation.closingHeadline.rows,
    narrowed.rows.length,
    "and it must count exactly the rows he can see",
  );
}

export async function runClosingHeadlineCountsDirectTests() {
  runPredicateTests();
  runHeadlineTotalsTests();
  runDistributorHalfUnchangedTests();
  runConfidentialTests();
  runNarrowedScopeTests();
}
