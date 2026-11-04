import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildOfficeRespread,
  mergeOfficeRespreadIntoSplit,
  type OfficeRespreadRow,
} from "../src/lib/sales/closing-office-respread.ts";
import { buildOfficeAreaWeights } from "../src/lib/sales/office-allocation.ts";
import {
  OFFICE_DISTRIBUTOR_CODE,
  OFFICE_RESPREAD_START_PERIOD,
  isOfficeRespreadActive,
  isOfficeRespreadPair,
  isOfficeRespreadRow,
} from "../src/lib/sales/office-distributor.ts";
import { areaProductKey, isSplitEligible } from "../src/lib/sales/store-sales-city-split.ts";

/**
 * THE OFFICE CHANNEL'S READ-TIME RESPREAD — owner, 2026-10-09: "fix the Office allocation to
 * read-time shares." CNS only, from the October 2026 closing.
 *
 * The owner's LOCKED golden rule (an area's share of the line's non-Office sales VALUE) is not in
 * question and is not touched. What was wrong is WHEN it was evaluated: once, at upload, and stamped
 * onto the stored rows — so every batch that landed or was re-mapped afterwards left the Office units
 * on a geography the data no longer supported. Measured on the live CNS August 2026 rows: 6,834 of
 * 109,719 Office packs (6.23%, 548,777 EGP, and Office is 61.5% of that month) are credited to the
 * wrong area today, with nothing anywhere reporting it.
 *
 * What this pins, and why each one is here:
 *
 *   1. The area shares equal the LOCKED Office rule's, to 1e-9. closing-office-respread.ts cannot
 *      import buildOfficeAreaWeights — office-allocation.ts → monthly-distributor-import.ts →
 *      attribution-store-split-refresh.ts → attribution-store-split-net.ts imports it back — so the
 *      equivalence is pinned HERE instead of by an import. Unlock and change the locked formula and
 *      this goes red and names the rule that follows it. FIRST deliberately: cases 2 and 3 compare
 *      money against exactly zero, so they are sharper than any tolerance and would speak first
 *      about a share error, leaving a reader to work out which rule had moved.
 *   2. ALIGNED MONTH → EXACTLY ZERO. The net is (today's spread − the stored spread), so a month
 *      whose batches have not moved since the Office upload must net to zero in every cell. This is
 *      the assertion that says the rule is a CORRECTION and not a second allocation.
 *   3. DRIFTED MONTH → EXACTLY THE DRIFT, and the grand total still cannot move: zero-sum per
 *      product on units, effective units and value. A redistribution that changes the total is the
 *      whole bug in one sentence (store-split-matrix.ts's header), and largest-remainder rounding is
 *      where it gets lost.
 *   4. Nothing before 2026-09 moves, and September DOES. July and August keep the numbers they were
 *      published with; the 6.23% measured on August is the EVIDENCE for the rule, never a backlog.
 *      September is in by his own second ruling of 2026-10-09 — see the case for the account.
 *   5. CNS only — the Office channel's own line list, the same one the upload enforces.
 *   6. Office never weights its own respread, and an excluded, confidential or direct row never
 *      weights it either.
 *   7. No contribution base → nothing moves: the Office rows keep the areas the upload gave them.
 *   8. The city split does NOT also move an Office row, so no unit is moved twice.
 *   9. The fold: the nets are ADDED, and `officeNet` comes out on its own because the Office GRID
 *      takes that slice and nothing else — the Closing Matrix (No Office) tab is `matrix − office`
 *      cell by cell, so a grid left on the upload's geography prints negative sales.
 *  10. The WIRING, read from source: all three split paths fold the respread, attribution carries it
 *      on both measures, and each Office grid applies `officeNet` rather than the combined net.
 */

// Prices chosen so salesValue === units × price exactly, which is what lets case 1 hand the same
// population to both implementations and compare the shares rather than the arithmetic around them.
const PRICE: Record<string, number> = { CN001: 100, CN002: 400 };

const LINE = "CNS";
const PERIOD = "2026-10";

function distributorRow(overrides: Partial<OfficeRespreadRow> = {}): OfficeRespreadRow {
  return {
    areaCode: "D21",
    clientCode: "C-1",
    clientName: "صيدلية النور",
    distributorCode: "PS",
    effectiveUnits: 100,
    includedInClosing: true,
    isDirect: false,
    officialLine: LINE,
    productCode: "CN001",
    qty: 100,
    salesValue: 100 * PRICE.CN001,
    ...overrides,
  };
}

/**
 * An Office row as the closing loader builds one: the Office distributor code, and NO customer at
 * all — `clientCode` and `clientName` are null by construction on this channel, which is exactly
 * why the city rule cannot touch it (case 8).
 */
function officeRow(overrides: Partial<OfficeRespreadRow> = {}): OfficeRespreadRow {
  return distributorRow({
    clientCode: "",
    clientName: "",
    distributorCode: OFFICE_DISTRIBUTOR_CODE,
    ...overrides,
  });
}

/** Two areas, 50/50 on value — the shares the Office file below was uploaded against. */
const BASE_ALIGNED: OfficeRespreadRow[] = [
  distributorRow({ areaCode: "D21", salesValue: 10_000 }),
  distributorRow({ areaCode: "D15", clientCode: "C-2", salesValue: 10_000 }),
];

/** The SAME month after a batch was re-mapped: 80/20 now, and the Office rows have not moved. */
const BASE_DRIFTED: OfficeRespreadRow[] = [
  distributorRow({ areaCode: "D21", salesValue: 16_000 }),
  distributorRow({ areaCode: "D15", clientCode: "C-2", salesValue: 4_000 }),
];

/** 100 packs of Office stock, stamped 50/50 by the upload — the aligned spread. */
const OFFICE_ALIGNED: OfficeRespreadRow[] = [
  officeRow({ areaCode: "D21", effectiveUnits: 50, qty: 50, salesValue: 50 * PRICE.CN001 }),
  officeRow({ areaCode: "D15", effectiveUnits: 50, qty: 50, salesValue: 50 * PRICE.CN001 }),
];

/** The same, plus 20 packs the upload put on an Alexandria area with no distributor sales at all. */
const OFFICE_WITH_ORPHAN: OfficeRespreadRow[] = [
  ...OFFICE_ALIGNED,
  officeRow({ areaCode: "AB1", effectiveUnits: 20, qty: 20, salesValue: 20 * PRICE.CN001 }),
];

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);

const key = (area: string, product: string) => areaProductKey(area, product);

const repoFile = (relative: string) =>
  readFileSync(path.join(process.cwd(), relative), "utf8");

export function runClosingOfficeRespreadTests() {
  // 1. THE SHARES ARE THE LOCKED OFFICE RULE'S. Same population, both implementations.
  //
  // On a population of its OWN — five areas, two products at different prices, awkward unit counts.
  // 🔴 AND IT RUNS FIRST DELIBERATELY: cases 2 and 3 compare money against exactly zero, so they are
  // sharper than any tolerance and a share error large enough to reach them fires there first, saying
  // only that money moved and never WHICH rule moved it. Here the shares are the only thing asserted,
  // so this is the clause that goes red, by name, when the locked formula changes under it.
  {
    const weighted: OfficeRespreadRow[] = [
      distributorRow({ areaCode: "D21", productCode: "CN001", qty: 1_234, effectiveUnits: 1_234, salesValue: 1_234 * PRICE.CN001 }),
      distributorRow({ areaCode: "D15", clientCode: "C-2", productCode: "CN002", qty: 567, effectiveUnits: 567, salesValue: 567 * PRICE.CN002 }),
      distributorRow({ areaCode: "D14", clientCode: "C-3", productCode: "CN001", qty: 89, effectiveUnits: 89, salesValue: 89 * PRICE.CN001 }),
      distributorRow({ areaCode: "D13", clientCode: "C-4", productCode: "CN002", qty: 3, effectiveUnits: 3, salesValue: 3 * PRICE.CN002 }),
      distributorRow({ areaCode: "D12", clientCode: "C-5", productCode: "CN001", qty: 7_777, effectiveUnits: 7_777, salesValue: 7_777 * PRICE.CN001 }),
    ];
    const respread = buildOfficeRespread(
      [...weighted, officeRow({ areaCode: "D12", effectiveUnits: 10, qty: 10, salesValue: 10 * PRICE.CN001 })],
      PERIOD,
      LINE,
    );
    const locked = buildOfficeAreaWeights(
      weighted.map((row, index) => ({
        areaCode: row.areaCode,
        brickId: `B${index}`,
        productCode: row.productCode,
        regionCode: "R1",
        units: row.effectiveUnits ?? row.qty,
      })),
      (productCode) => PRICE[productCode] ?? 0,
    );
    assert.equal(locked.areaShare.size, 5, "fixture check: the locked rule weights all five areas");
    assert.equal(locked.areaShare.size, respread.areaShare.size, "the two rules weight the same areas");
    for (const [areaCode, share] of locked.areaShare) {
      assert.ok(
        Math.abs((respread.areaShare.get(areaCode) ?? -1) - share) < 1e-9,
        `${areaCode}: the respread share must equal the LOCKED Office share (${share})`,
      );
    }
    // Not vacuous in the other direction either: a UNIT-weighted share would be a different number
    // on this population, which is the mistake the locked rule's "value" wording exists to prevent.
    const unitShare = 7_777 / (1_234 + 567 + 89 + 3 + 7_777);
    assert.ok(
      Math.abs((respread.areaShare.get("D12") ?? 0) - unitShare) > 1e-3,
      "fixture check: value shares and unit shares genuinely differ here",
    );
  }

  // 2. AN ALIGNED MONTH NETS TO EXACTLY ZERO.
  //
  // 🔴 THIS IS THE ASSERTION THAT SAYS WHAT THE RULE IS. The OUT legs are the stored Office rows
  // themselves and the IN legs are today's spread, so when the two agree nothing moves — the rule
  // corrects a stale spread and never re-allocates a correct one. Lose it (spread without cancelling
  // the stored areas, say) and every CNS area is credited with the Office channel TWICE.
  {
    const respread = buildOfficeRespread([...BASE_ALIGNED, ...OFFICE_ALIGNED], PERIOD, LINE);
    assert.equal(respread.movedQty, 100, "the whole Office channel on this line is respread");
    near(respread.areaShare.get("D21") ?? 0, 0.5, "D21 share");
    near(respread.areaShare.get("D15") ?? 0, 0.5, "D15 share");
    for (const [cell, net] of respread.net) {
      near(net.qty, 0, `${cell} must not move when the upload's spread is still the right one`);
      near(net.value, 0, `${cell} value must not move either`);
    }
  }

  // 3. A DRIFTED MONTH MOVES EXACTLY THE DRIFT, AND THE TOTAL CANNOT CHANGE.
  //
  // The base is now 80/20 and the Office file is still 50/50 across D21/D15 with 20 packs orphaned
  // on AB1. 120 packs spread 80/20 is 96 / 24, so D21 gains 46, D15 loses 26 and AB1 gives up all 20.
  {
    const respread = buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], PERIOD, LINE);
    assert.equal(respread.movedQty, 120, "every Office pack is respread, orphaned areas included");
    near(respread.areaShare.get("D21") ?? 0, 0.8, "D21 share after the re-map");
    near(respread.areaShare.get("D15") ?? 0, 0.2, "D15 share after the re-map");

    near(respread.net.get(key("D21", "CN001"))?.qty ?? 0, 46, "D21 gains the drift");
    near(respread.net.get(key("D15", "CN001"))?.qty ?? 0, -26, "D15 gives up the drift");
    near(respread.net.get(key("AB1", "CN001"))?.qty ?? 0, -20, "AB1 gives up its whole orphaned slice");
    near(respread.net.get(key("D21", "CN001"))?.value ?? 0, 4_600, "and the money moves with the units");
    near(respread.net.get(key("D15", "CN001"))?.value ?? 0, -2_600, "D15's money moves too");
    near(respread.net.get(key("AB1", "CN001"))?.value ?? 0, -2_000, "AB1's whole slice of money leaves");

    // 🔴 THE GRAND TOTAL CANNOT MOVE — on units and on money.
    const totals = [...respread.net.values()].reduce(
      (acc, cell) => ({ qty: acc.qty + cell.qty, value: acc.value + cell.value }),
      { qty: 0, value: 0 },
    );
    near(totals.qty, 0, "the net sums to zero on units");
    near(totals.value, 0, "the net sums to zero on value");

    // The second measure attribution needs, carried by the SAME computation (it prices
    // effective_units, not qty — see attribution-store-split-net.ts).
    const effectiveIn = respread.effectiveMovements.reduce((sum, move) => sum + move.inQty, 0);
    const effectiveOut = respread.effectiveMovements.reduce((sum, move) => sum + move.outQty, 0);
    near(effectiveIn, 120, "effective units in === the channel's effective units");
    near(effectiveOut, 120, "effective units out === the channel's effective units");
  }

  // 4. THE DATE IS THE MECHANISM. August and everything before it keep their published numbers.
  //
  // 🔴 SEPTEMBER MOVED ONCE, BY HIS OWN WORD IN BOTH DIRECTIONS, AND THAT IS WHAT THIS PINS.
  // 2026-10-09, first: "leave the Office respread at October" — September held no Office rows and
  // was frozen for every line by September Anti Infective's publication, against a net stamped
  // before this rule existed. The same evening Marcyrl's September Office book landed (80,565 units,
  // 13.64% of them on a geography the data no longer supported) and that publication was withdrawn
  // at 19:12:21.58 Cairo, so he ruled again: "make September's Office split recalculate like
  // October". Only his own new word moves this constant again, in either direction.
  {
    // 🔴 HIS FOURTH RULING, 2026-10-13: "Recompute from January 2026" — it reverses the third one
    // below, with nothing published or locked. The start is now the first month of 2026, and a month
    // before it (2025) still reads its stored rows.
    assert.equal(OFFICE_RESPREAD_START_PERIOD, "2026-01", "the owner's start month, 2026-10-13");
    assert.equal(isOfficeRespreadActive("2025-12"), false, "2025 is outside the window");
    assert.equal(isOfficeRespreadActive("2026-01"), true, "his fourth ruling, 2026-10-13");
    assert.equal(isOfficeRespreadActive("2026-08"), true, "August recomputes too since 2026-10-13");
    assert.equal(isOfficeRespreadActive("2026-09"), true, "his second ruling, 2026-10-09");
    assert.equal(isOfficeRespreadActive("2026-10"), true);
    assert.equal(isOfficeRespreadActive("2027-03"), true, "a later year is still after the start");
    assert.equal(isOfficeRespreadActive(""), false, "an unreadable period never moves a number");
    assert.equal(isOfficeRespreadActive("2026-9"), false, "only YYYY-MM is read");
    // 🔴 HIS THIRD RULING, 2026-10-09: **"leave January-June outside the respread window"** — asked
    // directly, because that night's 61 Sohag customer moves re-pointed rows in those six months. So
    // the window does not widen BACKWARDS either, and each month is pinned by name here rather than
    // by the boundary alone.
    // Superseded by the fourth ruling (2026-10-13): those months now recompute, and 2025 is what
    // stays outside, pinned by name the same way.
    for (const period of ["2025-01", "2025-06", "2025-11", "2025-12"]) {
      assert.equal(isOfficeRespreadActive(period), false, `${period} is outside the window by his word`);
      const respread = buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], period, LINE);
      assert.equal(respread.movements.length, 0, `${period} is untouched`);
      assert.equal(respread.net.size, 0, `${period} has no net`);
    }
    // September takes the rule now, on the same drifted population every other case uses — so this
    // fails if the constant is moved back without his word, which a boundary-only check would not.
    {
      const september = buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], "2026-09", LINE);
      assert.ok(september.movements.length > 0, "September is respread, exactly as October is");
      assert.ok(september.net.size > 0, "September carries a net");
      const october = buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], PERIOD, LINE);
      assert.equal(
        september.movements.length,
        october.movements.length,
        "the same population respreads identically in both months — the period is a gate, not an input",
      );
    }
  }

  // 5. CNS ONLY — the Office channel's own line list, the same one the upload enforces.
  {
    for (const line of ["Pedia", "Anti Infective", "Head Office"]) {
      const rows = [...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN].map((row) => ({ ...row, officialLine: line }));
      assert.equal(
        buildOfficeRespread(rows, PERIOD, line).movements.length,
        0,
        `${line} carries no Office channel, so nothing is respread`,
      );
    }
    assert.equal(isOfficeRespreadPair(LINE, PERIOD), true);
    assert.equal(isOfficeRespreadPair("Pedia", PERIOD), false, "Pedia has no Office channel");
    assert.equal(isOfficeRespreadPair(LINE, "2026-09"), true, "September is covered since his second ruling");
    assert.equal(isOfficeRespreadPair(LINE, "2025-12"), false, "and the month still has to be covered");

    // A caller that does not name the line is answered per row: the CNS Office rows move, the Pedia
    // rows in the same list do not.
    const mixed = [
      ...BASE_DRIFTED,
      ...OFFICE_WITH_ORPHAN,
      officeRow({ areaCode: "P9", effectiveUnits: 500, officialLine: "Pedia", productCode: "LA001", qty: 500, salesValue: 50_000 }),
    ];
    const respread = buildOfficeRespread(mixed, PERIOD);
    assert.equal(respread.movedQty, 120, "only the CNS Office rows moved");
    assert.equal(respread.net.has(key("P9", "LA001")), false, "the Pedia Office row is left alone");
  }

  // 6. OFFICE NEVER WEIGHTS ITS OWN RESPREAD, and nor does a row outside the closing's number.
  {
    const respread = buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], PERIOD, LINE);
    assert.equal(respread.areaShare.has("AB1"), false, "an area with Office stock and no sell-out takes no share");
    assert.equal(respread.areaShare.size, 2, "only the two areas with non-Office sales weight the spread");

    const ineligible = [
      distributorRow({ areaCode: "ZZ1", isDirect: true, salesValue: 9_999_999 }),
      distributorRow({ areaCode: "ZZ2", includedInClosing: false, salesValue: 9_999_999 }),
      distributorRow({ areaCode: "ZZ3", isConfidential: true, salesValue: 9_999_999 }),
      ...BASE_DRIFTED,
      ...OFFICE_WITH_ORPHAN,
    ];
    const shares = buildOfficeRespread(ineligible, PERIOD, LINE).areaShare;
    assert.equal(shares.has("ZZ1"), false, "a direct order carries no area and cannot weight the spread");
    assert.equal(shares.has("ZZ2"), false, "an excluded row never weights the spread");
    assert.equal(shares.has("ZZ3"), false, "a confidential row never weights the spread");
    assert.equal(shares.size, 2, "still the two areas with real, included, non-Office sales");
  }

  // 7. NO CONTRIBUTION TO COPY → NOTHING MOVES. The Office rows keep the upload's areas, which is
  // where the closing had them before this rule and the only honest answer with nothing to copy.
  {
    const respread = buildOfficeRespread(OFFICE_WITH_ORPHAN, PERIOD, LINE);
    assert.equal(respread.movements.length, 0, "no non-Office sell-out at all → no respread");
    assert.equal(respread.net.size, 0, "and no net to apply");
  }

  // 8. THE CITY SPLIT MUST NOT MOVE AN OFFICE ROW TOO — money moved by two rules is money invented.
  //
  // It is refused for a reason that needs no period gate: an Office row carries NO customer, so it
  // is not a store row, so isSplitEligible stops before any geography is read.
  {
    const base = {
      areaCode: "D12",
      includedInClosing: true,
      isDirect: false,
      officialLine: LINE,
      productCode: "CN001",
      qty: 120,
      salesValue: 37_800,
    };
    assert.equal(
      isSplitEligible({ ...base, clientCode: "W-9", clientName: "مخزن الحجاز فارما", distributorCode: "PS" }, PERIOD),
      true,
      "fixture check: a real wholesaler on this geography DOES split, or the next assertion proves nothing",
    );
    assert.equal(
      isSplitEligible({ ...base, clientCode: "", clientName: "", distributorCode: OFFICE_DISTRIBUTOR_CODE }, PERIOD),
      false,
      "an Office row is refused by the city rule — otherwise its units are moved twice",
    );
    assert.equal(isOfficeRespreadRow({ distributorCode: OFFICE_DISTRIBUTOR_CODE, officialLine: LINE }, PERIOD), true);
    assert.equal(
      isOfficeRespreadRow({ distributorCode: "PS", officialLine: LINE }, PERIOD),
      false,
      "a real distributor's row is never respread",
    );
    assert.equal(
      isOfficeRespreadRow({ distributorCode: OFFICE_DISTRIBUTOR_CODE, officialLine: LINE }, "2026-09"),
      true,
      "September's Office rows are respread too, since his second ruling of 2026-10-09",
    );
    assert.equal(
      isOfficeRespreadRow({ distributorCode: OFFICE_DISTRIBUTOR_CODE, officialLine: LINE }, "2025-12"),
      false,
      "and a month before the window (2025) keeps its Office rows exactly where they were stamped",
    );
  }

  // 9. LARGEST-REMAINDER: a total that does not divide still sums back EXACTLY, returns included.
  {
    const thirds: OfficeRespreadRow[] = [
      distributorRow({ areaCode: "A1", salesValue: 10_000 }),
      distributorRow({ areaCode: "A2", clientCode: "C-A2", salesValue: 10_000 }),
      distributorRow({ areaCode: "A3", clientCode: "C-A3", salesValue: 10_000 }),
      officeRow({ areaCode: "A9", effectiveUnits: 10, qty: 10, salesValue: 1_000 }),
    ];
    const respread = buildOfficeRespread(thirds, PERIOD, LINE);
    assert.equal(
      respread.movements.reduce((sum, move) => sum + move.inQty, 0),
      10,
      "10 packs into three equal shares still sum back to exactly 10",
    );
    assert.equal(respread.movements.reduce((sum, move) => sum + move.outQty, 0), 10, "and exactly 10 left");
    assert.equal(
      respread.movements.reduce((sum, move) => sum + move.inValue, 0),
      1_000,
      "the value reconciles on its own, to the cent",
    );
    // A RETURN. Shares are positive, so every slice is negative and the residual must land on the
    // slice of largest MAGNITUDE — the same reconciliation the locked Office rule uses.
    const credit = buildOfficeRespread(
      [...thirds.slice(0, 3), officeRow({ areaCode: "A9", effectiveUnits: -10, qty: -10, salesValue: -1_000 })],
      PERIOD,
      LINE,
    );
    assert.equal(
      credit.movements.reduce((sum, move) => sum + move.inQty, 0),
      -10,
      "an Office return is respread too, and still sums back exactly",
    );
  }

  // 10. THE FOLD: the nets are ADDED, and the Office slice comes out on its own.
  {
    const respread = buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], PERIOD, LINE);
    const city = {
      exemptStoreValueByBrick: new Map<string, number>([["B1|D21", 10]]),
      movements: [
        { areaCode: "D21", city: "Cairo", line: LINE, productCode: "CN001", inQty: 5, inValue: 1_000, outQty: 0, outValue: 0 },
      ],
      net: new Map([[key("D21", "CN001"), { qty: 5, value: 1_000 }]]),
    };
    const merged = mergeOfficeRespreadIntoSplit(city, respread);
    near(
      merged.net.get(key("D21", "CN001"))?.qty ?? 0,
      5 + 46,
      "D21 carries its city share AND the Office drift",
    );
    assert.equal(merged.movements.length, 1 + respread.movements.length, "both movement lists survive");
    assert.equal(merged.exemptStoreValueByBrick.size, 1, "the city split's exempt map is carried through");
    assert.equal(city.net.size, 1, "the caller's own net is never mutated");

    // 🔴 `officeNet` IS THE OFFICE SLICE ALONE. The Office GRID applies it, and the Closing Matrix
    // (No Office) tab is `matrix − office` cell by cell — so if the city split's 5 packs leaked into
    // it, that subtraction would take out money the Office channel never held.
    near(merged.officeNet.get(key("D21", "CN001"))?.qty ?? 0, 46, "the Office slice holds the drift");
    assert.equal(
      merged.officeNet.has(key("D21", "CN002")),
      false,
      "and holds nothing the Office channel did not move",
    );
    for (const [cell, net] of merged.officeNet) {
      near(
        net.qty,
        respread.net.get(cell)?.qty ?? Number.NaN,
        `${cell}: officeNet must be the respread's own net, never the combined one`,
      );
    }

    // A month with nothing to respread leaves the city split's numbers untouched. December 2025:
    // every 2026 month is inside the rule since his fourth ruling of 2026-10-13.
    const untouched = mergeOfficeRespreadIntoSplit(city, buildOfficeRespread([...BASE_DRIFTED, ...OFFICE_WITH_ORPHAN], "2025-12", LINE));
    assert.equal(untouched.net, city.net, "no respread → the same net object back");
    assert.equal(untouched.officeNet.size, 0, "and an empty Office slice, so no grid is touched");
  }

  runWiringChecks();
}

/**
 * THE WIRING, READ FROM SOURCE.
 *
 * Every assertion above is pure arithmetic, and a correct net that nothing applies is worth nothing
 * — which is exactly how a rule ships half-wired. The city split has THREE derivation points by
 * design (the screen's cached loader, the export's live fallback, the attribution payload) and two
 * of them exist because a second derivation once drifted from the first, so each has to fold this
 * rule as well. The Office GRIDS are a fourth class of call site: they must apply `officeNet` and
 * never the combined net.
 */
function runWiringChecks(): void {
  const splitNet = repoFile("src/lib/sales/closing-store-split-net.ts");
  assert.match(
    splitNet,
    /mergeOfficeRespreadIntoSplit\(withBulk,\s*buildOfficeRespread\(details\.rows,\s*period,\s*line\)\)/,
    "the screen's cached split loader must fold the Office respread, or the Closing tab shows the "
      + "upload's stale geography while the workbook shows today's",
  );
  assert.match(
    splitNet,
    /officeNet:\s*Array\.from\(merged\.officeNet\.entries\(\)\)/,
    "and must cache the Office slice, or the Office grid has nothing to apply",
  );
  assert.match(
    splitNet,
    /\["closing-store-split-with-bulk-office-respread-and-epda-rule-2"\]/,
    "the cache key must change with the payload shape: an entry from the previous deploy read back "
      + "as this shape hands the Office grid an undefined net",
  );

  const splitExport = repoFile("src/lib/sales/closing-store-split-export.ts");
  assert.match(
    splitExport,
    /mergeOfficeRespreadIntoSplit\(\s*mergeBulkAllocationIntoSplit\(/,
    "the export's own fallback derivation must fold the respread too — it is the one path that "
      + "exists because the workbook and the screen once disagreed",
  );
  assert.match(
    splitExport,
    /officeNet:\s*split\.officeNet/,
    "and must carry the Office slice out to the workbook's Office grid",
  );

  const attribution = repoFile("src/lib/sales/attribution-store-split-net.ts");
  assert.match(
    attribution,
    /const office = buildOfficeRespread\(rows,\s*period,\s*officialLine\)/,
    "attribution must carry the respread: Office is 61.5% of a CNS month, so a respread the matrix "
      + "applies and attribution does not puts every CNS rep's achievement out by most of their line",
  );
  for (const measure of ["net_qty", "net_effective_units"]) {
    assert.ok(
      new RegExp(`accumulate\\(byCell, officialLine, office\\.(?:effectiveM|m)ovements, "${measure}"\\)`).test(attribution),
      `attribution must carry the respread on ${measure} as well — one measure alone puts units on `
        + "one geography and the money on another",
    );
  }
  assert.match(
    attribution,
    /isOfficeRespreadActive\(period\)/,
    "and the period gate must name the respread, or a CNS-only month writes no net at all",
  );

  // The Office GRIDS. Each one is paired with a matrix that took the COMBINED net, so each must
  // apply the Office slice — and only that slice.
  for (const [file, pattern] of [
    [
      "src/lib/sales/monthly-closing-with-store-split.ts",
      /applyStoreSplitToMatrix\(parts\.office,\s*officeNet\)/,
    ],
    [
      "app/api/sales/monthly-closing/export/route.ts",
      /applyStoreSplitToMatrix\(officeFiltered,\s*storeSplitOfficeNet\)/,
    ],
    [
      "src/lib/sales/monthly-closing-consolidated-export.ts",
      /applyStoreSplitToMatrix\(office,\s*officeNet\)/,
    ],
  ] as const) {
    assert.match(
      repoFile(file),
      pattern,
      `${file} must apply the OFFICE net to the Office grid: the Closing Matrix (No Office) tab is `
        + "`matrix − office` cell by cell, so a grid left on the upload's geography can print "
        + "negative sales",
    );
  }
}
