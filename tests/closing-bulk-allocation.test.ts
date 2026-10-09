import assert from "node:assert/strict";

import {
  BULK_ALLOCATION_START_PERIOD,
  BULK_DISTRIBUTOR_CODE,
  isBulkAllocatedRow,
  isBulkAllocationActive,
} from "../src/lib/sales/bulk-allocation-channel.ts";
import {
  buildBulkAllocation,
  mergeBulkAllocationIntoSplit,
  type BulkAllocationRow,
} from "../src/lib/sales/closing-bulk-allocation.ts";
import { buildOfficeAreaWeights } from "../src/lib/sales/office-allocation.ts";
import {
  areaProductKey,
  isSplitEligible,
  splitStoreSalesAcrossCityAreas,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * THE EPDA-BULK CONTRIBUTION ALLOCATION — the owner's rule of 2026-10-09, from the September 2026
 * closing on: the bulk sector's (`EP-BK`) Pedia units are spread across the line's areas by each
 * area's share of the OTHER distributors' sales value, "exactly as office", instead of staying on
 * the area its invoice names.
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
 */

// Prices chosen so salesValue === units × price exactly, which is what lets case 2 hand the same
// population to both implementations and compare the shares rather than the arithmetic around them.
const PRICE: Record<string, number> = { LA001: 200, LA002: 500 };

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

function bulkRow(overrides: Partial<BulkAllocationRow> = {}): BulkAllocationRow {
  return baseRow({
    areaCode: "AB1",
    clientCode: "W-1",
    clientName: "مخزن الحجاز فارما",
    distributorCode: BULK_DISTRIBUTOR_CODE,
    effectiveUnits: 24,
    qty: 24,
    salesValue: 24 * PRICE.LA001,
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

/** 30 packs of Lacto Advanced 1, invoiced to two Alexandria areas. June 2026's real shape. */
const BULK: BulkAllocationRow[] = [
  bulkRow({ areaCode: "AB1", qty: 24, effectiveUnits: 24, salesValue: 24 * PRICE.LA001 }),
  bulkRow({ areaCode: "AB2", clientCode: "W-2", qty: 6, effectiveUnits: 6, salesValue: 6 * PRICE.LA001 }),
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

    // The spread: 30 packs by those shares, and the invoiced areas give them up in full.
    near(allocation.net.get(key("D21", "LA001"))?.qty ?? 0, 30 * (20_000 / 35_000), "D21 receives");
    near(allocation.net.get(key("D15", "LA001"))?.qty ?? 0, 30 * (10_000 / 35_000), "D15 receives");
    near(allocation.net.get(key("D14", "LA001"))?.qty ?? 0, 30 * (5_000 / 35_000), "D14 receives");
    assert.equal(allocation.net.get(key("AB1", "LA001"))?.qty, -24, "AB1 gives up its whole invoice");
    assert.equal(allocation.net.get(key("AB2", "LA001"))?.qty, -6, "AB2 gives up its whole invoice");

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
      productCode: "LA001",
      qty: 120,
      salesValue: 37_800,
    };
    // The same store, in the same multi-area city, with and without the bulk distributor on it.
    assert.equal(isSplitEligible({ ...splitRow, distributorCode: "PS" }, "2026-09"), true, "fixture check: this store does split");
    assert.equal(
      isSplitEligible({ ...splitRow, distributorCode: BULK_DISTRIBUTOR_CODE }, "2026-09"),
      false,
      "a bulk row is refused by the city rule from September — otherwise it moves twice",
    );
    assert.equal(
      isSplitEligible({ ...splitRow, distributorCode: BULK_DISTRIBUTOR_CODE }, "2026-08"),
      true,
      "August is unchanged: the carve-out is dated, like every other rule here",
    );
    assert.equal(
      isBulkAllocatedRow({ distributorCode: BULK_DISTRIBUTOR_CODE, officialLine: "Pedia" }, "2026-09"),
      true,
    );
    assert.equal(
      isBulkAllocatedRow({ distributorCode: "EP-PHS", officialLine: "Pedia" }, "2026-09"),
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
    near(
      merged.net.get(key("D21", "LA001"))?.qty ?? 0,
      5 + 30 * (20_000 / 35_000),
      "D21 carries its city share AND its bulk share",
    );
    assert.equal(merged.movements.length, 1 + allocation.movements.length, "both movement lists survive");
    assert.equal(merged.exemptStoreValueByBrick.size, 1, "the city split's exempt map is carried through");
    assert.equal(city.net.size, 1, "the caller's own net is never mutated");

    // A month with nothing to allocate leaves the city split byte-identical.
    const untouched = mergeBulkAllocationIntoSplit(city, buildBulkAllocation([...BASE, ...BULK], "2026-08", "Pedia"));
    assert.equal(untouched, city, "no allocation → the same object back");
  }
}
