import assert from "node:assert/strict";

import {
  JULY_2026_DIRECT_PERIOD,
  JULY_2026_DIRECT_ROWS,
} from "../src/lib/sales/july-2026-direct-orders.ts";
import { applyJulyDirectAreasToBreakdown } from "../src/lib/sales/july-direct-channel-breakdown.ts";
import { assembleChannelBreakdown } from "../src/lib/sales/monthly-closing-channel-comparison.ts";
import {
  resolveClosingDetailSalesValue,
  summarize,
  type ClosingDetailRow,
} from "../src/lib/sales/monthly-closing-details.ts";

// ─────────────────────────────────────────────────────────────────────────────
// JULY 2026 DIRECT ORDERS ARE TAKEN AS STORED — the owner's ruling of 2026-08-06:
//
//   "july exception take direct units and values as they are — 149,288.50 is accurate 100%"
//
// WHAT WENT WRONG. Every layer of the closing already read the stored value; ONE did not.
// `monthly-closing-details.ts` valued every row at effectiveUnits x factoryPrice — the DISTRIBUTOR
// formula — and applied it to direct rows too. Measured live on 2026-08-06 for Anti Infective
// 2026-07 direct (16 rows, 2,120 units):
//
//   source_of_sales_import_rows.value          149,288.50   <- the owner's own file, to the piastre
//   source_of_sales_fact_rollup.direct_value   149,288.50
//   phx_monthly_closing_direct                 149,288.50
//   phx_closing_channel_totals  direct_unnamed 149,288.50
//   phx_closing_channel_breakdown  __DIRECT__  149,288.50
//   effectiveUnits x factoryPrice              157,518.00   <- the Data sheet, alone, +8,229.50
//
// That figure reached the Data sheet's "Sales Value" column, the Data/Total reconciliation
// (`excludedDirect`) and the on-screen Closing Details panel — three places telling the owner a
// different number from the five above.
//
// WHY IT CANNOT BE PATCHED WITH A RATE. The recompute is not a uniform scaling and is not even
// consistently high: RO001 recomputes to 94,162.50 against a stored 82,328.50 (over by 11,834.00)
// while SA001 recomputes to 63,355.50 against a stored 66,960.00 (UNDER by 3,604.50). A direct
// order is a negotiated deal, priced per deal. Only the stored value is the deal.
//
// WHY THIS TEST EXISTS SEPARATELY from july-2026-direct-orders-tab.test.ts: that file pins the
// owner's MAPPING (the hand-written area distribution). This one pins that the closing READS the
// stored value rather than deriving one, which is a different failure with the same symptom.
// ─────────────────────────────────────────────────────────────────────────────

/** The owner's figure. Measured at five independent layers in production on 2026-08-06. */
const AI_JULY_DIRECT_VALUE = 149_288.50;
const AI_JULY_DIRECT_UNITS = 2_120;
/** What effectiveUnits x factoryPrice produces for the same 16 rows. Never to be published. */
const AI_JULY_DIRECT_AT_FACTORY_PRICE = 157_518.00;
/** The pre-restatement figure (#1857, 1,150 units). Must never come back as a current number. */
const AI_JULY_DIRECT_BEFORE_RESTATEMENT = 93_554.00;

/**
 * The two products, exactly as production carries them — including the fact that the recompute
 * errs in OPPOSITE directions on them, which is what rules out any "correction factor" fix.
 */
const AI_JULY_DIRECT_PRODUCTS = [
  { code: "RO001", factoryPrice: 60.75, qty: 1_550, recomputed: 94_162.50, storedValue: 82_328.50 },
  { code: "SA001", factoryPrice: 111.15, qty: 570, recomputed: 63_355.50, storedValue: 66_960.00 },
] as const;

function detailRow(overrides: Partial<ClosingDetailRow> = {}): ClosingDetailRow {
  const base: ClosingDetailRow = {
    id: 1,
    rowNumber: 1,
    distributorCode: "Direct",
    invoicePeriod: JULY_2026_DIRECT_PERIOD,
    invoiceDate: "2026-07-31",
    officialLine: "Anti Infective",
    sheetAreaCode: "",
    sheetAreaName: "",
    sheetRegionCode: "D1",
    sheetRegionName: "Delta (1)",
    blockCode: "",
    brickId: "",
    brickName: "",
    areaCode: "",
    areaName: "",
    regionCode: "D1",
    regionName: "Delta (1)",
    areaMismatch: false,
    brickUnmapped: false,
    clientCode: "",
    clientName: "",
    clientAddress: "",
    productCode: "RO001",
    productName: "Royafloxacin",
    family: "Royafloxacin",
    factoryPrice: 60.75,
    qty: 100,
    bonusQty: 0,
    discount: 0,
    effectiveUnits: 100,
    salesValue: 0,
    sheetValue: 5_428,
    isDirect: true,
    isConfidential: false,
    missingClientCode: true,
    validationState: "valid",
    includedInClosing: false,
    exclusions: ["direct"],
    ...overrides,
  };
  // Derive exactly the way loadMonthlyClosingDetails does, so this fixture cannot drift from it.
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

// ── 1. The rule itself ────────────────────────────────────────────────────────
function runValueRuleTests() {
  for (const product of AI_JULY_DIRECT_PRODUCTS) {
    assert.equal(
      Number(resolveClosingDetailSalesValue({
        effectiveUnits: product.qty,
        factoryPrice: product.factoryPrice,
        invoicePeriod: "2026-07",
        isDirect: true,
        sheetValue: product.storedValue,
      }).toFixed(2)),
      product.storedValue,
      `OWNER'S RULING 2026-08-06: July 2026 direct ${product.code} must be taken AS STORED `
      + `(${product.storedValue.toFixed(2)}). Valuing it at factory price gives `
      + `${product.recomputed.toFixed(2)}, which is a price nobody negotiated`,
    );
  }

  // Same month, distributor row — the ordinary formula must be completely untouched.
  assert.equal(
    Number(resolveClosingDetailSalesValue({
      effectiveUnits: 100,
      factoryPrice: 60.75,
      invoicePeriod: "2026-07",
      isDirect: false,
      sheetValue: 1,
    }).toFixed(2)),
    6_075,
    "the exception is for DIRECT rows only: a July distributor invoice line is still valued at "
    + "effectiveUnits x factoryPrice, which is what phx_monthly_closing_matrix values sell-out at",
  );

  // Every other month — the owner ruled ONE month, so nothing else may move.
  for (const period of ["2026-06", "2026-08", "2026-12"]) {
    assert.equal(
      Number(resolveClosingDetailSalesValue({
        effectiveUnits: 100,
        factoryPrice: 60.75,
        invoicePeriod: period,
        isDirect: true,
        sheetValue: 5_428,
      }).toFixed(2)),
      6_075,
      `the owner ruled JULY 2026 only, so ${period} keeps exactly the behaviour it has today. `
      + "Widening this to every month is a separate ruling and must be asked for, not assumed",
    );
  }
}

// ── 2. What the Data sheet, the Total sheet's bridge and the on-screen panel report ──
function runReconciliationTests() {
  const rows = AI_JULY_DIRECT_PRODUCTS.map((product, index) => detailRow({
    factoryPrice: product.factoryPrice,
    id: index + 1,
    productCode: product.code,
    qty: product.qty,
    sheetValue: product.storedValue,
  }));
  const direct = summarize(rows, (row) => row.isDirect);

  assert.equal(
    Number(direct.salesValue.toFixed(2)),
    AI_JULY_DIRECT_VALUE,
    "OWNER'S RULING 2026-08-06: July Anti Infective direct is 149,288.50 EGP on the Data sheet's "
    + "\"Sales Value\" column, in the Data/Total reconciliation (`excludedDirect`) and on the "
    + "Closing Details panel — the same figure phx_monthly_closing_direct, phx_closing_channel_totals "
    + "and phx_closing_channel_breakdown all return. If this reads 157,518.00 the recompute is back "
    + "and the workbook disagrees with itself again",
  );
  assert.notEqual(
    Number(direct.salesValue.toFixed(2)),
    AI_JULY_DIRECT_AT_FACTORY_PRICE,
    "factory price is BANNED as a direct-order price — 157,518.00 is what it produces here",
  );
  assert.equal(
    Number(direct.units.toFixed(2)),
    AI_JULY_DIRECT_UNITS,
    "units are taken as they are too: 2,120, which every layer already agreed on",
  );
}

// ── 3. The mapping and the sales must stay one number ─────────────────────────
//
// The closing merges the owner's per-area mapping ONLY when it reconciles with the month's direct
// sales to the piastre; otherwise it silently keeps the un-mapped layout. So "both sides say
// 149,288.50" is not a nicety, it is the condition under which the owner's areas appear at all.
function runMappingTiesToSalesTests() {
  const mapped = JULY_2026_DIRECT_ROWS.filter(
    (row) => row.line.trim().toLowerCase() === "anti infective",
  );
  assert.equal(
    Number(mapped.reduce((sum, row) => sum + row.value, 0).toFixed(2)),
    AI_JULY_DIRECT_VALUE,
    "the owner's area mapping must total 149,288.50 — the same money his direct sales are",
  );
  assert.equal(
    mapped.reduce((sum, row) => sum + row.qty, 0),
    AI_JULY_DIRECT_UNITS,
    "and the same 2,120 units",
  );

  const breakdownWith = (directValue: number) => assembleChannelBreakdown({
    line: "Anti Infective",
    period: JULY_2026_DIRECT_PERIOD,
    restrictedProductsIncluded: false,
    rows: [
      { dimension: "product", direct_unnamed: 0, hospital: 0, key: "RO001", label: "Royafloxacin", pharmacy: 0, store: 0, total: 0 },
      { dimension: "product", direct_unnamed: 0, hospital: 0, key: "SA001", label: "Saginko", pharmacy: 0, store: 0, total: 0 },
      { dimension: "area", direct_unnamed: directValue, hospital: 0, key: "__DIRECT__", label: "", pharmacy: 0, store: 0, total: directValue },
      { dimension: "rep", direct_unnamed: directValue, hospital: 0, key: "__DIRECT__", label: "", pharmacy: 0, store: 0, total: directValue },
      { dimension: "brick", direct_unnamed: directValue, hospital: 0, key: "__DIRECT__", label: "", pharmacy: 0, store: 0, total: directValue },
    ],
  });

  const applied = applyJulyDirectAreasToBreakdown(breakdownWith(AI_JULY_DIRECT_VALUE));
  assert.equal(
    applied.applied,
    true,
    "with direct sales at the owner's 149,288.50 the mapping reconciles and his areas reach the "
    + `Channel Breakdown grids (${applied.reason ?? "no reason given"})`,
  );
  assert.equal(
    Number(applied.value.toFixed(2)),
    AI_JULY_DIRECT_VALUE,
    "and all of it lands on a real area — Anti Infective's July mapping has no area-less row",
  );

  // The two numbers that must NOT be accepted, each for its own reason.
  for (const [wrong, why] of [
    [AI_JULY_DIRECT_AT_FACTORY_PRICE, "the factory-price recompute"],
    [AI_JULY_DIRECT_BEFORE_RESTATEMENT, "the pre-restatement figure"],
  ] as const) {
    assert.equal(
      applyJulyDirectAreasToBreakdown(breakdownWith(wrong)).applied,
      false,
      `${wrong.toFixed(2)} is ${why}, not the month's direct sales. The merge must REFUSE and say so `
      + "rather than spreading the owner's areas over money that is not theirs — a visible bucket row "
      + "is recoverable, a moved total is not",
    );
  }
}

export async function runJuly2026DirectValueIsStoredTests() {
  runValueRuleTests();
  runReconciliationTests();
  runMappingTiesToSalesTests();
}
