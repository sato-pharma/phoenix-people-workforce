import assert from "node:assert/strict";

import {
  BULK_ALLOCATION_PRODUCT_CODES,
  BULK_ALLOCATION_START_PERIOD,
  BULK_DISTRIBUTOR_CODE,
  isBulkAllocatedProduct,
  isBulkAllocatedRow,
  isBulkAllocationActive,
  isEpdaContributionActive,
} from "../src/lib/sales/bulk-allocation-channel.ts";
import {
  buildBulkAllocation,
  bulkAllocationRows,
  epdaUnitsLanded,
  mergeBulkAllocationIntoSplit,
  type BulkAllocationRow,
} from "../src/lib/sales/closing-bulk-allocation.ts";
import { buildClosingEpdaSheet, CLOSING_EPDA_SHEET_NAME, closingEpdaSheetSpec } from "../src/lib/sales/closing-epda-sheet.ts";
import { applyCreditedAreaView, EPDA_SHARE_LABEL, isEpdaShareRow } from "../src/lib/sales/closing-main-stores.ts";
import { classifyRowKind } from "../src/lib/sales/sos-pharmacy-actions.ts";
import { buildOfficeAreaWeights } from "../src/lib/sales/office-allocation.ts";
import {
  areaProductKey,
  isSplitEligible,
  splitStoreSalesAcrossCityAreas,
  type SplitRegions,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * THE EPDA-BULK CONTRIBUTION ALLOCATION — the owner's rule of 2026-10-09, from the September 2026
 * closing on: the bulk sector's (`EP-BK`) Pedia units are spread across the line's areas by each
 * area's share of the OTHER distributors' sales value, "exactly as office", instead of staying on
 * the area its invoice names — and, by his narrowing the same evening, ONLY for Ivyronc: "IN EPDA
 * BULK ONLY IVYRONC WILL BE CONTRIBUTION ANY OTHER PRODUCT NORMAL MAPPING."
 *
 * What this pins, and why each one is here:
 *
 *   1. Σ allocated === the book's own total, per measure. A redistribution that changes the total is
 *      the whole bug in one sentence (store-split-matrix.ts's own header), and largest-remainder
 *      rounding is where it gets lost.
 *   2. The area shares equal the LOCKED Office rule's. closing-bulk-allocation.ts cannot import
 *      buildOfficeAreaWeights — office-allocation.ts → monthly-distributor-import.ts →
 *      attribution-store-split-refresh.ts → attribution-store-split-net.ts imports it back — so the
 *      equivalence is pinned HERE instead of by an import. If the locked formula is ever unlocked and
 *      changed, this goes red and names the rule that follows it.
 *   3. Nothing before 2026-09 moves. A late ruling is a rule for upcoming months.
 *   4. Pedia only, and the untracked Head Office line — 99.2% of every bulk row ever uploaded — is
 *      left exactly as invoiced.
 *   5. The city split does NOT also move these rows. The bulk sector's customers are wholesalers by
 *      definition, so the six keywords call nearly all of them stores; without the carve-out the same
 *      units are moved by two rules and the money is invented.
 *   6. No contribution base → no movement. The rule copies a contribution; with nothing to copy the
 *      rows keep their invoiced area, which is where the closing had them before this rule existed.
 *   9. IVYRONC ONLY, and the two halves of that stay the same width: a non-Ivyronc bulk row is not
 *      allocated, is not a WEIGHT, and is not carved out of the city rule either — it takes the
 *      ordinary rules, which is what "normal mapping" means. The weight half is the one a future
 *      change could get wrong silently: letting the book weight itself would move Ivyronc toward
 *      wherever the bulk sector's own Lacto happened to be invoiced.
 */

// Prices chosen so salesValue === units × price exactly, which is what lets case 2 hand the same
// population to both implementations and compare the shares rather than the arithmetic around them.
const PRICE: Record<string, number> = { IV001: 300, LA001: 200, LA002: 500 };

function baseRow(overrides: Partial<BulkAllocationRow> = {}): BulkAllocationRow {
  const row: BulkAllocationRow = {
    areaCode: "D21",
    clientCode: "C-1",
    clientName: "صيدلية النور",
    distributorCode: "PS",
    effectiveUnits: 100,
    includedInClosing: true,
    isDirect: false,
    officialLine: "Pedia",
    productCode: "LA001",
    qty: 100,
    salesValue: 100 * PRICE.LA001,
    ...overrides,
  };
  return row;
}

/**
 * A bulk-sector row. `productCode` defaults to IVYRONC, because that is the only product the rule
 * moves (owner, 2026-10-09) — a fixture carrying anything else is testing the other half of his
 * instruction, and case 9 does that deliberately.
 */
function bulkRow(overrides: Partial<BulkAllocationRow> = {}): BulkAllocationRow {
  return baseRow({
    areaCode: "AB1",
    clientCode: "W-1",
    clientName: "مخزن الحجاز فارما",
    distributorCode: BULK_DISTRIBUTOR_CODE,
    effectiveUnits: 24,
    productCode: "IV001",
    qty: 24,
    salesValue: 24 * PRICE.IV001,
    ...overrides,
  });
}

/** The month's base: three areas, two products, 35,000 EGP of other distributors' sales. */
const BASE: BulkAllocationRow[] = [
  baseRow({ areaCode: "D21", productCode: "LA001", qty: 100, effectiveUnits: 100, salesValue: 20_000 }),
  baseRow({ areaCode: "D15", productCode: "LA001", qty: 50, effectiveUnits: 50, salesValue: 10_000 }),
  baseRow({
    areaCode: "D14",
    clientCode: "C-2",
    distributorCode: "IS-S",
    effectiveUnits: 10,
    productCode: "LA002",
    qty: 10,
    salesValue: 5_000,
  }),
];

/** 30 packs of Ivyronc, invoiced to two Alexandria areas — the shape the rule is written for. */
const BULK: BulkAllocationRow[] = [
  bulkRow({ areaCode: "AB1", qty: 24, effectiveUnits: 24, salesValue: 24 * PRICE.IV001 }),
  bulkRow({ areaCode: "AB2", clientCode: "W-2", qty: 6, effectiveUnits: 6, salesValue: 6 * PRICE.IV001 }),
];

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);

export function runClosingBulkAllocationTests() {
  const key = (area: string, product: string) => areaProductKey(area, product);

  // 1. THE RULE, AND THE TOTAL IT MAY NOT CHANGE.
  {
    const allocation = buildBulkAllocation([...BASE, ...BULK], "2026-09", "Pedia");
    assert.equal(allocation.movedQty, 30, "the whole bulk book on this line moved");

    // Shares: D21 20,000/35,000, D15 10,000/35,000, D14 5,000/35,000.
    near(allocation.areaShare.get("D21") ?? 0, 20_000 / 35_000, "D21 share");
    near(allocation.areaShare.get("D15") ?? 0, 10_000 / 35_000, "D15 share");
    near(allocation.areaShare.get("D14") ?? 0, 5_000 / 35_000, "D14 share");
    assert.equal(allocation.areaShare.size, 3, "only areas with other distributors' sales take a share");
    assert.equal(allocation.areaShare.has("AB1"), false, "the bulk book never weights itself");

    // The spread: 30 packs by those shares, and the invoiced areas give them up in full. The cells
    // are keyed by the MOVED row's product — Ivyronc — never by the products that weighted it.
    near(allocation.net.get(key("D21", "IV001"))?.qty ?? 0, 30 * (20_000 / 35_000), "D21 receives");
    near(allocation.net.get(key("D15", "IV001"))?.qty ?? 0, 30 * (10_000 / 35_000), "D15 receives");
    near(allocation.net.get(key("D14", "IV001"))?.qty ?? 0, 30 * (5_000 / 35_000), "D14 receives");
    assert.equal(allocation.net.get(key("AB1", "IV001"))?.qty, -24, "AB1 gives up its whole invoice");
    assert.equal(allocation.net.get(key("AB2", "IV001"))?.qty, -6, "AB2 gives up its whole invoice");
    assert.equal(allocation.net.has(key("D21", "LA001")), false, "the weighting products are not moved");

    // 🔴 THE GRAND TOTAL CANNOT MOVE — on units and on money, per product.
    const totals = [...allocation.net.values()].reduce(
      (acc, cell) => ({ qty: acc.qty + cell.qty, value: acc.value + cell.value }),
      { qty: 0, value: 0 },
    );
    near(totals.qty, 0, "the net sums to zero on units");
    near(totals.value, 0, "the net sums to zero on value");

    // The second measure attribution needs, carried by the same computation.
    const effectiveIn = allocation.effectiveMovements.reduce((sum, move) => sum + move.inQty, 0);
    const effectiveOut = allocation.effectiveMovements.reduce((sum, move) => sum + move.outQty, 0);
    near(effectiveIn, 30, "effective units in === the book's effective units");
    near(effectiveOut, 30, "effective units out === the book's effective units");
  }

  // 2. THE SHARES ARE THE LOCKED OFFICE RULE'S. Same population, both implementations.
  {
    const allocation = buildBulkAllocation([...BASE, ...BULK], "2026-09", "Pedia");
    const officeWeights = buildOfficeAreaWeights(
      BASE.map((row, index) => ({
        areaCode: row.areaCode,
        brickId: `B${index}`,
        productCode: row.productCode,
        regionCode: "R1",
        units: row.effectiveUnits ?? row.qty,
      })),
      (productCode) => PRICE[productCode] ?? 0,
    );
    assert.equal(
      officeWeights.areaShare.size,
      allocation.areaShare.size,
      "the two rules weight the same areas",
    );
    for (const [areaCode, share] of officeWeights.areaShare) {
      assert.ok(
        Math.abs((allocation.areaShare.get(areaCode) ?? -1) - share) < 1e-9,
        `${areaCode}: the bulk share must equal the LOCKED Office share (${share})`,
      );
    }
  }

  // 3. THE DATE IS THE MECHANISM. August and everything before it keep their published numbers.
  {
    assert.equal(BULK_ALLOCATION_START_PERIOD, "2026-09", "the owner's start month");
    assert.equal(isBulkAllocationActive("2026-08"), false);
    assert.equal(isBulkAllocationActive("2026-09"), true);
    assert.equal(isBulkAllocationActive("2027-01"), true, "a later year is still after the start");
    assert.equal(isBulkAllocationActive(""), false, "an unreadable period never moves a number");
    assert.equal(isBulkAllocationActive("2026-9"), false, "only YYYY-MM is read");
    for (const period of ["2026-02", "2026-06", "2026-07", "2026-08"]) {
      const allocation = buildBulkAllocation([...BASE, ...BULK], period, "Pedia");
      assert.equal(allocation.movements.length, 0, `${period} is untouched`);
      assert.equal(allocation.net.size, 0, `${period} has no net`);
    }
  }

  // 4. PEDIA ONLY — Head Office, which is 99.2% of the book, stays exactly as invoiced.
  {
    for (const line of ["Head Office", "CNS", "Anti Infective"]) {
      const rows = [...BASE, ...BULK].map((row) => ({ ...row, officialLine: line }));
      assert.equal(
        buildBulkAllocation(rows, "2026-09", line).movements.length,
        0,
        `${line} takes no bulk allocation`,
      );
    }
    // A caller that does not name the line is answered per row: Pedia's bulk moves, the Head Office
    // rows in the same list do not.
    const mixed = [
      ...BASE,
      ...BULK,
      bulkRow({ areaCode: "AB3", clientCode: "W-3", officialLine: "Head Office", productCode: "LA003", qty: 9_000, effectiveUnits: 9_000, salesValue: 0 }),
    ];
    const allocation = buildBulkAllocation(mixed, "2026-09");
    assert.equal(allocation.movedQty, 30, "only the Pedia bulk rows moved");
    assert.equal(allocation.net.has(key("AB3", "LA003")), false, "the Head Office row is left alone");
  }

  // 5. THE CITY SPLIT MUST NOT MOVE THESE ROWS TOO.
  {
    const splitRow = {
      areaCode: "D12",
      clientCode: "W-9",
      clientName: "مخزن الحجاز فارما",
      includedInClosing: true,
      isDirect: false,
      officialLine: "Pedia",
      productCode: "IV001",
      qty: 120,
      salesValue: 37_800,
    };
    // The same store, in the same multi-area city, with and without the bulk distributor on it.
    assert.equal(isSplitEligible({ ...splitRow, distributorCode: "PS" }, "2026-09"), true, "fixture check: this store does split");
    assert.equal(
      isSplitEligible({ ...splitRow, distributorCode: BULK_DISTRIBUTOR_CODE }, "2026-09"),
      false,
      "a bulk Ivyronc row is refused by the city rule from September — otherwise it moves twice",
    );
    assert.equal(
      isSplitEligible({ ...splitRow, distributorCode: BULK_DISTRIBUTOR_CODE }, "2026-08"),
      true,
      "August is unchanged: the carve-out is dated, like every other rule here",
    );
    assert.equal(
      isBulkAllocatedRow({ distributorCode: BULK_DISTRIBUTOR_CODE, officialLine: "Pedia", productCode: "IV001" }, "2026-09"),
      true,
    );
    assert.equal(
      isBulkAllocatedRow({ distributorCode: "EP-PHS", officialLine: "Pedia", productCode: "IV001" }, "2026-09"),
      false,
      "EPDA-Pharmacies is a different book and keeps the city rule",
    );

    // And through the splitter itself: the bulk row comes out where it went in.
    const result = splitStoreSalesAcrossCityAreas(
      [{ ...splitRow, distributorCode: BULK_DISTRIBUTOR_CODE }],
      "2026-09",
    );
    assert.equal(result.splitRowCount, 0, "the city split moved nothing");
    assert.equal(result.rows.length, 1, "the row survives");
    assert.equal(result.rows[0]?.areaCode, "D12", "on its own area");
    assert.equal(result.exemptStoreValueByBrick.size, 0, "and it is not reported as exempt store money either");
  }

  // 6. NO CONTRIBUTION TO COPY → NOTHING MOVES.
  {
    assert.equal(buildBulkAllocation(BULK, "2026-09", "Pedia").movements.length, 0, "no other distributor at all");
    const directOnly = [
      baseRow({ areaCode: "ZZ1", isDirect: true, salesValue: 9_999_999 }),
      ...BULK,
    ];
    const allocation = buildBulkAllocation(directOnly, "2026-09", "Pedia");
    assert.equal(allocation.movements.length, 0, "direct orders carry no area and cannot weight the spread");
    assert.equal(allocation.areaShare.has("ZZ1"), false);
    // An excluded row and a confidential row are not part of the number being shared either.
    const ineligible = [
      baseRow({ areaCode: "ZZ2", includedInClosing: false, salesValue: 9_999_999 }),
      baseRow({ areaCode: "ZZ3", isConfidential: true, salesValue: 9_999_999 }),
      ...BASE,
      ...BULK,
    ];
    const shares = buildBulkAllocation(ineligible, "2026-09", "Pedia").areaShare;
    assert.equal(shares.has("ZZ2"), false, "an excluded row never weights the spread");
    assert.equal(shares.has("ZZ3"), false, "a confidential row never weights the spread");
    assert.equal(shares.size, 3, "still the three areas with real, included sales");
  }

  // 7. LARGEST-REMAINDER: a total that does not divide still sums back EXACTLY.
  {
    const thirds: BulkAllocationRow[] = [
      baseRow({ areaCode: "A1", salesValue: 10_000 }),
      baseRow({ areaCode: "A2", clientCode: "C-A2", salesValue: 10_000 }),
      baseRow({ areaCode: "A3", clientCode: "C-A3", salesValue: 10_000 }),
      bulkRow({ areaCode: "A9", qty: 10, effectiveUnits: 10, salesValue: 2_000 }),
    ];
    const allocation = buildBulkAllocation(thirds, "2026-09", "Pedia");
    const inQty = allocation.movements.reduce((sum, move) => sum + move.inQty, 0);
    const outQty = allocation.movements.reduce((sum, move) => sum + move.outQty, 0);
    assert.equal(inQty, 10, "10 packs into three equal shares still sum back to exactly 10");
    assert.equal(outQty, 10, "and exactly 10 left");
    const inValue = allocation.movements.reduce((sum, move) => sum + move.inValue, 0);
    assert.equal(inValue, 2_000, "the value reconciles on its own, to the cent");
    // A RETURN. Shares are positive, so every slice is negative and the residual must land on the
    // slice of largest MAGNITUDE — the same reconciliation the locked Office rule uses.
    const credit = buildBulkAllocation(
      [...thirds.slice(0, 3), bulkRow({ areaCode: "A9", qty: -10, effectiveUnits: -10, salesValue: -2_000 })],
      "2026-09",
      "Pedia",
    );
    assert.equal(
      credit.movements.reduce((sum, move) => sum + move.inQty, 0),
      -10,
      "a bulk return is spread too, and still sums back exactly",
    );
  }

  // 8. THE FOLD: two nets are ADDED, never replaced.
  {
    const allocation = buildBulkAllocation([...BASE, ...BULK], "2026-09", "Pedia");
    const city = {
      exemptStoreValueByBrick: new Map<string, number>([["B1|D21", 10]]),
      movements: [
        { areaCode: "D21", city: "Cairo", line: "Pedia", productCode: "LA001", inQty: 5, inValue: 1_000, outQty: 0, outValue: 0 },
      ],
      net: new Map([[key("D21", "LA001"), { qty: 5, value: 1_000 }]]),
    };
    const merged = mergeBulkAllocationIntoSplit(city, allocation);
    assert.equal(merged.net.get(key("D21", "LA001"))?.qty, 5, "D21 keeps its city share on the city product");
    near(
      merged.net.get(key("D21", "IV001"))?.qty ?? 0,
      30 * (20_000 / 35_000),
      "and carries its bulk share on Ivyronc — the two are added, per product",
    );
    assert.equal(merged.movements.length, 1 + allocation.movements.length, "both movement lists survive");
    assert.equal(merged.exemptStoreValueByBrick.size, 1, "the city split's exempt map is carried through");
    assert.equal(city.net.size, 1, "the caller's own net is never mutated");

    // A month with nothing to allocate leaves the city split byte-identical.
    const untouched = mergeBulkAllocationIntoSplit(city, buildBulkAllocation([...BASE, ...BULK], "2026-08", "Pedia"));
    assert.equal(untouched, city, "no allocation → the same object back");
  }

  // 9. 🔴 IVYRONC ONLY — "ANY OTHER PRODUCT NORMAL MAPPING" (owner, 2026-10-09).
  {
    assert.deepEqual([...BULK_ALLOCATION_PRODUCT_CODES], ["IV001"], "Ivyronc is the whole list");
    assert.equal(isBulkAllocatedProduct("IV001"), true);
    assert.equal(isBulkAllocatedProduct(" iv001 "), true, "a sheet's code arrives as typed");
    assert.equal(isBulkAllocatedProduct("LA001"), false, "Lacto Advanced is not allocated any more");
    assert.equal(isBulkAllocatedProduct("IV"), false, "the family is not a product code, and this is not a prefix match");
    assert.equal(isBulkAllocatedProduct(""), false);
    assert.equal(isBulkAllocatedProduct(null), false);

    // The row test, which the city rule's carve-out and the allocation both ask.
    const lactoBulk = { distributorCode: BULK_DISTRIBUTOR_CODE, officialLine: "Pedia", productCode: "LA001" };
    assert.equal(isBulkAllocatedRow(lactoBulk, "2026-09"), false, "a bulk Lacto row is not allocated");
    assert.equal(
      isBulkAllocatedRow({ distributorCode: BULK_DISTRIBUTOR_CODE, officialLine: "Pedia" }, "2026-09"),
      false,
      "a row with no product code at all never moves — the safe direction",
    );

    // Not allocated, and therefore not carved out of the city rule either: it takes NORMAL mapping.
    assert.equal(
      isSplitEligible(
        {
          areaCode: "D12",
          clientCode: "W-9",
          clientName: "مخزن الحجاز فارما",
          distributorCode: BULK_DISTRIBUTOR_CODE,
          includedInClosing: true,
          isDirect: false,
          officialLine: "Pedia",
          productCode: "LA001",
          qty: 120,
          salesValue: 37_800,
        },
        "2026-09",
      ),
      true,
      "a bulk row that is not Ivyronc keeps the city rule — his 'normal mapping'",
    );

    // And through the allocation: the Lacto bulk row moves nothing, AND does not weight the spread.
    const lactoOnly = [
      ...BASE,
      bulkRow({ areaCode: "AB1", productCode: "LA001", qty: 300, effectiveUnits: 300, salesValue: 300 * PRICE.LA001 }),
    ];
    const none = buildBulkAllocation(lactoOnly, "2026-09", "Pedia");
    assert.equal(none.movements.length, 0, "a bulk book with no Ivyronc in it moves nothing");
    assert.equal(none.net.size, 0, "and writes no net cell");

    // 🔴 THE WEIGHT HALF. 60,000 EGP of bulk Lacto on an area of its own must not change a single
    // share: the shares are the OTHER distributors' contribution, and the bulk sector is not one of
    // them whichever product its row carries.
    const mixedBook = [...BASE, ...BULK, lactoOnly[lactoOnly.length - 1]!];
    const mixed = buildBulkAllocation(mixedBook, "2026-09", "Pedia");
    const clean = buildBulkAllocation([...BASE, ...BULK], "2026-09", "Pedia");
    assert.equal(mixed.movedQty, 30, "still only the 30 Ivyronc packs moved");
    assert.equal(mixed.areaShare.size, clean.areaShare.size, "the same three areas weight it");
    for (const [areaCode, share] of clean.areaShare) {
      near(mixed.areaShare.get(areaCode) ?? -1, share, `${areaCode}: the bulk book's own Lacto is not a weight`);
    }
    assert.equal(mixed.areaShare.has("AB1"), false, "least of all the area its own invoice names");
    assert.equal(mixed.net.has(key("AB1", "LA001")), false, "and the Lacto row keeps its invoiced area");
  }

  // 10. 🔴 RULE 2, FROM OCTOBER 2026 (owner, 2026-11-04): BOTH EPDA BOOKS, THREE PRODUCTS, EACH SPREAD BY
  //     ITS OWN RETAIL UNITS. "you will get the total retail sales of every rep without epda bulk or
  //     epda-pharmacies then you will distribute the epda sales based on the contribution per area in
  //     retail sales ... then add the direct sales". Retail is every other distributor (the main EPDA
  //     book included) and never a direct order.
  {
    const retail = (areaCode: string, productCode: string, qty: number, over: Partial<BulkAllocationRow> = {}) =>
      baseRow({ areaCode, effectiveUnits: qty, productCode, qty, salesValue: qty * 10, ...over });
    const epda = (distributorCode: string, areaCode: string, productCode: string, qty: number, line = "Pedia") =>
      bulkRow({ areaCode, distributorCode, effectiveUnits: qty, officialLine: line, productCode, qty, salesValue: qty * 30 });
    const inUnits = (allocation: ReturnType<typeof buildBulkAllocation>, product: string) =>
      new Map(allocation.movements.filter((leg) => leg.productCode === product && leg.inQty !== 0).map((leg) => [leg.areaCode, leg.inQty]));

    const pedia = [
      retail("D21", "IV001", 60),
      retail("D15", "IV001", 20, { distributorCode: "EP" }),
      retail("D15", "IV001", 10),
      // Priced far above the rest (a short-dated lot, a price change): by VALUE D14 would take most of
      // the spread. The weights are the units, so its ten units weigh exactly what ten units weigh.
      retail("D14", "IV001", 10, { salesValue: 5000 }),
      // A lot of another product's money in D14 does not weight Ivyronc: the same product's units only.
      retail("D14", "LA001", 5000),
      // Nor does a direct order, however large: direct is added after the spread, never a weight.
      retail("D14", "IV001", 900, { isDirect: true }),
      epda("EP-BK", "AB1", "IV001", 300),
      epda("EP-PHS", "D21", "IV001", 100),
      epda("EP-BK", "AB1", "LA001", 50),
    ];
    assert.equal(isEpdaContributionActive("2026-10"), true);
    assert.equal(isEpdaContributionActive("2026-09"), false, "September keeps the rule it was published with");
    const october = buildBulkAllocation(pedia, "2026-10", "Pedia");
    assert.deepEqual(
      [...inUnits(october, "IV001")].sort(),
      [["D14", 40], ["D15", 120], ["D21", 240]],
      "400 Ivyronc from both books land 60:30:10, the retail Ivyronc units",
    );
    assert.equal(october.movedQty, 400, "both books moved, and nothing else");
    assert.equal(october.net.has(key("AB1", "LA001")), false, "the books' other products keep their invoiced area");
    assert.equal(october.net.get(key("AB1", "IV001"))?.qty, -300, "the bulk book leaves its invoiced area");
    assert.equal(october.net.get(key("D21", "IV001"))?.qty, 140, "D21 gives up its pharmacy invoice and takes its share");
    const pediaSeptember = buildBulkAllocation(pedia, "2026-09", "Pedia");
    assert.equal(pediaSeptember.movedQty, 300, "in September only the bulk book moves, by value");

    const anti = [
      retail("D21", "RO001", 30, { officialLine: "Anti Infective" }),
      retail("D15", "RO001", 70, { officialLine: "Anti Infective" }),
      retail("D21", "SA001", 90, { officialLine: "Anti Infective" }),
      retail("D15", "SA001", 10, { officialLine: "Anti Infective" }),
      epda("EP-BK", "AB1", "RO001", 2952, "Anti Infective"),
      epda("EP-BK", "AB1", "SA001", 3002, "Anti Infective"),
    ];
    const antiOctober = buildBulkAllocation(anti, "2026-10", "Anti Infective");
    assert.deepEqual([...inUnits(antiOctober, "RO001")].sort(), [["D15", 2066], ["D21", 886]], "Royafloxacin by its own units, 30:70");
    assert.deepEqual([...inUnits(antiOctober, "SA001")].sort(), [["D15", 300], ["D21", 2702]], "Saginko by its own units, 90:10");
    for (const leg of antiOctober.movements) assert.ok(Number.isInteger(leg.inQty), "every area takes whole units");
    assert.equal(buildBulkAllocation(anti, "2026-09", "Anti Infective").movedQty, 0, "Anti Infective never moved before October");

    // A product no retail distributor sold has nothing to copy, and keeps its invoiced areas.
    const unsold = buildBulkAllocation([...pedia, epda("EP-BK", "AB1", "RO001", 10, "Anti Infective")], "2026-10", "Anti Infective");
    assert.equal(unsold.movedQty, 0, "no retail Royafloxacin, so nothing moves, and Pedia's Ivyronc is not this line's to move");

    // The city split leaves every one of these rows alone, or the same units would move twice.
    const pharmacyRo = { distributorCode: "EP-PHS", officialLine: "Anti Infective", productCode: "RO001" };
    assert.equal(isBulkAllocatedRow(pharmacyRo, "2026-10"), true);
    assert.equal(isBulkAllocatedRow(pharmacyRo, "2026-09"), false);
    assert.equal(isBulkAllocatedRow({ ...pharmacyRo, distributorCode: "EP" }, "2026-10"), false, "the main EPDA book is retail");
    assert.equal(isBulkAllocatedRow({ ...pharmacyRo, productCode: "LA001", officialLine: "Pedia" }, "2026-10"), false);
    assert.equal(
      isSplitEligible(baseRow({ clientName: "مخزن الحجاز", distributorCode: "EP-PHS", officialLine: "Anti Infective", productCode: "SA001" }), "2026-10"),
      false,
      "carved out of the city rule",
    );
  }

  // 11. THE EPDA TAB OF THE THREE DOWNLOADS (owner, 2026-11-04): "a column per product share for epda
  //     after the spread", and "never show that there are reduced units in the xlsx closing sheet".
  {
    const area = (areaCode: string, areaName: string, extra: Record<string, unknown> = {}) => ({ areaCode, areaName, ...extra });
    const matrix = {
      columns: [
        { productCode: "IV001", productName: "Ivyronc" },
        { productCode: "LA001", productName: "Lacto Advanced" },
      ],
      line: "Pedia",
      period: "2026-10",
      regions: [
        { regionName: "Delta (1)", areas: [area("D21", "Tanta"), area("D15", "Mansoura")] },
        { regionName: "Cairo", areas: [area("CA1", "Nasr City")] },
        { regionName: "Delta (2)", areas: [area("D14", "Zagazig"), area("DIRECT", "Direct", { isDirect: true })] },
      ],
    } as unknown as Parameters<typeof closingEpdaSheetSpec>[0]["matrix"];
    const epdaUnits = new Map([
      [key("D21", "IV001"), 240],
      [key("D15", "IV001"), 120],
      [key("D14", "IV001"), 40],
      [key("DIRECT", "IV001"), 999],
    ]);
    const spec = closingEpdaSheetSpec({ epdaUnits, matrix, periodLabel: "October 2026" });
    assert.ok(spec, "October with EPDA units has a tab");
    assert.deepEqual(spec.headers, ["Region", "Area", "Ivyronc EPDA units"], "one column per product that has EPDA units, Lacto none");
    assert.deepEqual(spec.records, [
      ["Delta (1)", "", 360],
      ["Delta (1)", "Tanta", 240],
      ["Delta (1)", "Mansoura", 120],
      ["Delta (2)", "", 40],
      ["Delta (2)", "Zagazig", 40],
      ["Total", "", 400],
    ], "an area with none is left out, the synthetic Direct area never shows, and the total is the whole spread");
    assert.deepEqual(spec.rowKinds, ["group", "detail", "detail", "group", "detail", "total"]);
    const words = [...spec.headers, spec.caption].join(" ").toLowerCase();
    for (const banned of ["reduc", "deduct", "bonus", "%", "percent", "30", "15"]) {
      assert.equal(words.includes(banned), false, `no word on the tab says "${banned}"`);
    }
    assert.equal(closingEpdaSheetSpec({ epdaUnits, matrix: { ...matrix, period: "2026-09" }, periodLabel: null }), null, "September has no tab");
    assert.equal(closingEpdaSheetSpec({ epdaUnits, matrix: { ...matrix, periods: ["2026-10", "2026-11"] }, periodLabel: null }), null, "a multi-month file has no tab");
    assert.equal(closingEpdaSheetSpec({ epdaUnits: new Map(), matrix, periodLabel: null }), null, "no units, no tab");
    const sheet = buildClosingEpdaSheet({ epdaUnits, line: "Pedia", matrix, periodLabel: "October 2026" });
    assert.equal(sheet?.name, CLOSING_EPDA_SHEET_NAME);
    assert.equal(sheet?.rows.length, spec.records.length, "the premium tab carries the same grid");

    // And the spread is what the tab reads: the IN legs of a rule-2 allocation, per area and product.
    const landed = epdaUnitsLanded(buildBulkAllocation([
      baseRow({ areaCode: "D21", effectiveUnits: 30, productCode: "IV001", qty: 30, salesValue: 300 }),
      baseRow({ areaCode: "D15", effectiveUnits: 10, productCode: "IV001", qty: 10, salesValue: 100 }),
      bulkRow({ areaCode: "AB1", distributorCode: "EP-PHS", effectiveUnits: 100, productCode: "IV001", qty: 100, salesValue: 3000 }),
    ], "2026-10", "Pedia"), "2026-10");
    assert.deepEqual([...landed].sort(), [[key("D15", "IV001"), 25], [key("D21", "IV001"), 75]]);
    assert.equal(epdaUnitsLanded({ movements: [{ areaCode: "D21", inQty: 5, productCode: "IV001" } as never] }, "2026-09").size, 0, "nothing before October");

    // A product no retail distributor sold is not spread, and the tab still shows it where it stays.
    const unsoldRows = [
      bulkRow({ areaCode: "AB1", distributorCode: "EP-BK", effectiveUnits: 10, officialLine: "Anti Infective", productCode: "RO001", qty: 10, salesValue: 300 }),
      bulkRow({ areaCode: "AB1", distributorCode: "EP-BK", effectiveUnits: 7, officialLine: "Anti Infective", productCode: "LA001", qty: 7, salesValue: 70 }),
    ];
    const kept = epdaUnitsLanded(buildBulkAllocation(unsoldRows, "2026-10", "Anti Infective"), "2026-10", unsoldRows);
    assert.deepEqual([...kept], [[key("AB1", "RO001"), 10]], "Royafloxacin stays on its invoiced area and is on the tab; Lacto is not a rule-2 product");
  }

  // 12. A VIEWER'S ROWS CARRY THE SAME SPREAD (applyCreditedAreaView). A District Manager's file is
  //     rebuilt from them, so they must put each area's EPDA share where the matrix put it.
  {
    const rows = [
      baseRow({ areaCode: "D21", effectiveUnits: 60, productCode: "IV001", qty: 60, salesValue: 600 }),
      baseRow({ areaCode: "D15", effectiveUnits: 30, productCode: "IV001", qty: 30, salesValue: 300 }),
      baseRow({ areaCode: "D14", effectiveUnits: 10, productCode: "IV001", qty: 10, salesValue: 100 }),
      bulkRow({ areaCode: "AB1", distributorCode: "EP-BK", effectiveUnits: 300, productCode: "IV001", qty: 300, salesValue: 9000 }),
      // A pharmacy, so the city rule has nothing to say about it in either month.
      bulkRow({ areaCode: "D21", clientName: "صيدلية الشفاء", distributorCode: "EP-PHS", effectiveUnits: 100, productCode: "IV001", qty: 100, salesValue: 3000 }),
      bulkRow({ areaCode: "AB1", distributorCode: "EP-BK", effectiveUnits: 50, productCode: "LA001", qty: 50, salesValue: 500 }),
    ];
    const label = (code: string) => ({ areaName: `Area ${code}`, regionCode: "R1", regionName: "Region 1" });
    const epdaBy = (out: readonly BulkAllocationRow[], field: "qty" | "salesValue") => {
      const totals = new Map<string, number>();
      for (const row of out) {
        if (!String(row.distributorCode).startsWith("EP-") || row.productCode !== "IV001") continue;
        totals.set(row.areaCode, Math.round(((totals.get(row.areaCode) ?? 0) + Number(row[field])) * 1e6) / 1e6);
      }
      return [...totals].sort();
    };
    const october = applyCreditedAreaView(rows as never[], { areaLabelOf: label, line: "Pedia", period: "2026-10" }) as BulkAllocationRow[];
    assert.deepEqual(epdaBy(october, "qty"), [["D14", 40], ["D15", 120], ["D21", 240]], "each area's EPDA rows add to the matrix's share");
    assert.deepEqual(epdaBy(october, "salesValue"), [["D14", 1200], ["D15", 3600], ["D21", 7200]], "and the value follows the units");
    assert.ok(october.some((row) => row.areaCode === "AB1" && row.productCode === "LA001"), "Lacto keeps its invoiced area");
    // 🔴 One unnamed row per area and book, in whole units — never a copy of a pharmacy's invoice in
    // every receiving area, which named every EPDA pharmacy to every rep and, at fractional units,
    // marked a real pharmacy as a wholesaler share in its own rep's action list.
    const shares = october.filter((row) => String(row.distributorCode).startsWith("EP-") && row.productCode === "IV001");
    assert.ok(shares.every((row) => isEpdaShareRow(row) && row.clientName === EPDA_SHARE_LABEL), "every EPDA row is an unnamed share");
    assert.ok(shares.every((row) => Number.isInteger(row.qty) && row.effectiveUnits === row.qty), "in whole units");
    assert.ok(!october.some((row) => row.clientName === "صيدلية الشفاء"), "no pharmacy's name reaches another area's rows");
    assert.deepEqual(
      shares.map((row) => `${row.areaCode}|${row.distributorCode}|${row.qty}`).sort(),
      ["D14|EP-BK|30", "D14|EP-PHS|10", "D15|EP-BK|90", "D15|EP-PHS|30", "D21|EP-BK|180", "D21|EP-PHS|60"],
      "one row per area and book, each book's units in its share",
    );
    assert.ok(shares.every((row) => classifyRowKind(row as never, new Set()) === "wholesalerShare"), "the action list reads a share, never a pharmacy");
    assert.equal(
      (october.find((row) => row.areaCode === "D15" && row.distributorCode === "EP-BK") as { areaName?: string } | undefined)?.areaName,
      "Area D15",
      "a share wears its new area's name",
    );
    const september = applyCreditedAreaView(rows as never[], { areaLabelOf: label, line: "Pedia", period: "2026-09" }) as BulkAllocationRow[];
    assert.ok(
      september.some((row) => row.areaCode === "D21" && row.distributorCode === "EP-PHS" && row.qty === 100),
      "September never spread the pharmacy book, and its rows stay as invoiced",
    );
  }

  // 13. 🔴 PHARMACIES ONLY (owner, 2026-11-04: "of the retail exclude stores and put the contribution
  //     on pharmacies only", both books, hospitals left out). A store and a hospital never weigh, however
  //     large, wherever the city rule credits them; only the pharmacies' units of the product do.
  {
    const rows = [
      baseRow({ areaCode: "D12", clientCode: "P-1", clientName: "صيدلية الشفاء", effectiveUnits: 30, productCode: "IV001", qty: 30, salesValue: 9_450 }),
      baseRow({ areaCode: "D13", clientCode: "P-2", clientName: "صيدلية الأمل", effectiveUnits: 10, productCode: "IV001", qty: 10, salesValue: 3_150 }),
      // A wholesaler far larger than both pharmacies, in a multi-area city: no weight at all.
      baseRow({ areaCode: "D12", clientCode: "W-9", clientName: "مخزن الحجاز فارما", effectiveUnits: 900, productCode: "IV001", qty: 900, salesValue: 283_500 }),
      // A hospital buying in a third area: no weight either, so that area takes nothing.
      baseRow({ areaCode: "D14", clientCode: "H-1", clientName: "مستشفى الجامعة", effectiveUnits: 500, productCode: "IV001", qty: 500, salesValue: 157_500 }),
      bulkRow({ areaCode: "AB1", distributorCode: "EP-BK", effectiveUnits: 100, productCode: "IV001", qty: 100, salesValue: 3_000 }),
    ];
    const city = splitStoreSalesAcrossCityAreas(rows, "2026-10");
    assert.ok(new Set(city.rows.filter((row) => row.clientCode === "W-9").map((row) => row.areaCode)).size > 1, "fixture check: the wholesaler is shared across its city");
    const october = buildBulkAllocation(bulkAllocationRows(rows, city.rows, "2026-10"), "2026-10", "Pedia");
    const landed = october.movements.filter((leg) => leg.inQty > 0).map((leg) => [leg.areaCode, leg.inQty]).sort();
    assert.deepEqual(landed, [["D12", 75], ["D13", 25]], "100 EPDA units land 30:10, the pharmacies' units, and never on the store or hospital areas");
    assert.equal(
      buildBulkAllocation(bulkAllocationRows(rows, null, "2026-10"), "2026-10", "Pedia").movements.filter((leg) => leg.inQty > 0).length,
      2,
      "the invoiced rows give the same two areas: the city rule moves only stores, which no longer weigh",
    );
    const storesOnly = rows.filter((row) => !String(row.clientCode).startsWith("P-"));
    assert.equal(buildBulkAllocation(storesOnly, "2026-10", "Pedia").movedQty, 0, "no pharmacy bought it, so nothing moves");
    assert.deepEqual(bulkAllocationRows(rows, city.rows, "2026-09"), rows, "September keeps the invoiced rows it was published with");
  }

  // 14. 🔴 UPPER EGYPT 2 WEIGHS BY PHARMACIES AND STORES (owner, 2026-11-04 ~18:00: "only upper egypt 2
  //     gets its contribution on retail stores and pharmacies"). In an area the organogram files under
  //     UE-2 a store's units weigh too; a hospital there still does not, and a store anywhere else does not.
  {
    const regions: SplitRegions = {
      areasByRegion: new Map([["D1", new Set(["D12"])], ["UE-2", new Set(["UE5", "UE6"])]]),
      others: new Set(),
    };
    const rows = [
      baseRow({ areaCode: "D12", clientCode: "P-1", clientName: "صيدلية الشفاء", effectiveUnits: 30, productCode: "IV001", qty: 30, salesValue: 9_450 }),
      // A wholesaler outside Upper Egypt 2: no weight, however large.
      baseRow({ areaCode: "D12", clientCode: "W-9", clientName: "مخزن الحجاز فارما", effectiveUnits: 900, productCode: "IV001", qty: 900, salesValue: 283_500 }),
      baseRow({ areaCode: "UE5", clientCode: "P-2", clientName: "صيدلية الأمل", effectiveUnits: 10, productCode: "IV001", qty: 10, salesValue: 3_150 }),
      // A wholesaler inside Upper Egypt 2: it weighs.
      baseRow({ areaCode: "UE5", clientCode: "W-5", clientName: "مخزن احمد رفعت", effectiveUnits: 30, productCode: "IV001", qty: 30, salesValue: 9_450 }),
      // A hospital inside Upper Egypt 2: still no weight.
      baseRow({ areaCode: "UE6", clientCode: "H-1", clientName: "مستشفى سوهاج الجامعي", effectiveUnits: 500, productCode: "IV001", qty: 500, salesValue: 157_500 }),
      bulkRow({ areaCode: "AB1", distributorCode: "EP-BK", effectiveUnits: 100, productCode: "IV001", qty: 100, salesValue: 3_000 }),
    ];
    const landedOf = (allocation: ReturnType<typeof buildBulkAllocation>) =>
      allocation.movements.filter((leg) => leg.inQty > 0).map((leg) => [leg.areaCode, leg.inQty]).sort();
    assert.deepEqual(
      landedOf(buildBulkAllocation(rows, "2026-10", "Pedia", regions)),
      [["D12", 43], ["UE5", 57]],
      "100 EPDA units land 30:40: D12's pharmacy against Upper Egypt 2's pharmacy AND store, never the hospital or the D12 store",
    );
    assert.deepEqual(
      landedOf(buildBulkAllocation(rows, "2026-10", "Pedia")),
      [["D12", 75], ["UE5", 25]],
      "without the organogram no area is known to be Upper Egypt 2, so every area weighs by pharmacies alone",
    );
  }
}
