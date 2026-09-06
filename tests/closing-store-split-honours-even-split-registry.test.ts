import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evenSplitKey } from "../src/lib/sales/even-split-registry.ts";
import {
  CITY_AREAS,
  customersExemptFromCitySplit,
  detailStoreSplitByCustomer,
  isSplitEligible,
  splitStoreSalesAcrossCityAreas,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

// A customer the DATABASE already distributed must never be distributed a second time by the
// store city split.
//
// THE COLLISION. Two rules can both claim client 1011654 (مخزن شركه اى زد, "EZ"):
//
//   The even-split rule — the owner's, live since 2026-08-26 as phx_sos_rows_attributed(period).
//   EZ's whole month is shared equally between the CNS reps active in Cairo and Giza that month,
//   from a roster frozen per period in sos_even_split_roster. July 2026: 2,650 units across 8
//   seats, 331.25 each, every share landing on its own area's brick.
//
//   The store city rule — a wholesaler's sales divide evenly across the areas of its CITY. EZ is
//   a wholesaler (isStoreCustomer says so on its name), it is booked in Cairo East 1, and CNS is
//   a split-eligible line. So on its face it qualifies.
//
// WHY THE EXISTING EXEMPTION CANNOT SEE IT — and this is the whole reason this file exists.
// customersExemptFromCitySplit spots a customer a HUMAN apportioned, by noticing rows that
// point away from the single brick they all still carry. EZ leaves no such trace. The split reads
// source_of_sales_import_rows, the raw invoice, where EZ is ONE Cairo East 1 row for the whole
// month; the sharing happens afterwards, in the rollup the Closing Matrix reads. Probed on live
// production 2026-09-05: customersExemptFromCitySplit over EZ's real rows returns false,
// because not one of them is re-booked.
//
// WHAT IT WOULD HAVE COST. The Matrix holds 331.25 EZ units in Cairo East 1 — one eighth of July.
// The split derives its movements from the raw rows, so it would have taken the WHOLE 2,650 out of
// Cairo East 1 and dealt city shares back: about 441.67 in against 2,650 out. Cairo East 1's EZ
// contribution: 331.25 − 2,650 + 441.67 = −1,877.08 units. A negative number on a real rep's area,
// with Giza's shares left untouched beside it, and nothing anywhere saying a second rule had run.
//
// THE FIX. sos_even_split_customers is read at the one place closing rows are built and stamped
// onto the row as `evenSplitApplied`; the split exempts such a row on that flag alone. Both live
// call sites — the shared cache and the export's fallback — feed on the same builder's rows, so
// both inherit it. Pinned at the bottom of this file, because a fix nobody wired up is not a fix.

const LINE = "CNS";
const EZ_CODE = "1011654";
const EZ_NAME = "مخزن شركه اى زد";
const EZ_AREA = "CA1";
const EZ_BRICK = "B196-2";
const EZ_UNITS = 2_650;
const EZ_VALUE = 278_763.55;
const PRODUCT = "CN001";

// The rule shares a store across its CITY's areas, so the arithmetic below is stated against the
// real map rather than a guessed count — if Cairo ever gains or loses an area this test still
// says the true thing.
const CAIRO_AREAS = CITY_AREAS.get("Cairo") ?? [];

function row(over: Partial<StoreSplitRow> = {}): StoreSplitRow {
  return {
    areaCode: EZ_AREA,
    sheetAreaCode: EZ_AREA,
    brickId: EZ_BRICK,
    clientCode: EZ_CODE,
    clientName: EZ_NAME,
    distributorCode: "IBNSINA",
    includedInClosing: true,
    isDirect: false,
    officialLine: LINE,
    productCode: PRODUCT,
    qty: EZ_UNITS,
    salesValue: EZ_VALUE,
    ...over,
  };
}

/** What the split books to one area for our product, in and out. */
function movementOf(rows: readonly StoreSplitRow[], areaCode: string) {
  const result = splitStoreSalesAcrossCityAreas(rows);
  const found = result.movements.find(
    (movement) => movement.areaCode === areaCode && movement.productCode === PRODUCT,
  );
  return { result, inQty: found?.inQty ?? 0, outQty: found?.outQty ?? 0 };
}

export async function runClosingStoreSplitHonoursEvenSplitRegistryTests() {
  // 0. the fixture is genuinely split-eligible, or every assertion below is vacuous.
  //
  // This is the guard that keeps the test honest. If EZ stopped being classified as a store, or
  // Cairo stopped being a multi-area city, the "does not move" assertions would all pass for the
  // wrong reason and this file would certify nothing.
  assert.ok(
    CAIRO_AREAS.length > 1,
    "Cairo must hold more than one area or the city rule could never reach EZ at all",
  );
  assert.equal(
    isSplitEligible(row({ evenSplitApplied: false })),
    true,
    "the fixture must be a store the city rule WOULD split — otherwise this test proves nothing",
  );

  // 1. the two directions: without the flag it moves, with the flag it does not.
  //
  // Both halves are load-bearing. The first fails if someone removes the exemption; the second
  // fails if someone widens it until every store is exempt and the city rule quietly stops.
  const unregistered = movementOf([row({ evenSplitApplied: false })], EZ_AREA);
  assert.equal(
    unregistered.outQty,
    EZ_UNITS,
    "an ordinary Cairo wholesaler's whole month leaves its area — this is what EZ was suffering",
  );
  assert.equal(unregistered.result.splitRowCount, 1, "and it is counted as a split row");

  const registered = movementOf([row({ evenSplitApplied: true })], EZ_AREA);
  assert.equal(
    registered.outQty,
    0,
    "a registry customer's units never leave the area the Matrix booked them in",
  );
  assert.equal(registered.inQty, 0, "and no area receives a share of them");
  assert.equal(
    registered.result.splitRowCount,
    0,
    "the split reports that it moved nothing, so the workbook's note tells the truth",
  );
  assert.equal(
    registered.result.rows.length,
    1,
    "the row passes through whole — one row in, one row out, not one per city area",
  );
  assert.equal(
    registered.result.rows[0]?.qty,
    EZ_UNITS,
    "carrying its full month, not a city share of it",
  );

  // 2. the brick grid must know the money stayed.
  //
  // The Channel Breakdown pro-rates an area's outflow down to its bricks by each brick's store
  // value. A brick holding store money that never moved has to be reported, or the grid debits it
  // anyway — the same reason the hand-split exemption reports its bricks.
  assert.equal(
    registered.result.exemptStoreValueByBrick.get(`${EZ_BRICK}|${EZ_AREA}`),
    EZ_VALUE,
    "EZ's brick is named as holding store value the split did not move",
  );

  // 3. the detail sheet agrees with the matrix.
  //
  // The two tabs must describe one operation. A customer listed as split on the detail sheet and
  // left alone in the matrix is the disagreement that cost weeks on the 441164 case.
  assert.equal(
    detailStoreSplitByCustomer([row({ evenSplitApplied: true })])
      .some((entry) => entry.clientCode === EZ_CODE),
    false,
    "the store-split detail sheet does not list a customer it never split",
  );
  assert.ok(
    detailStoreSplitByCustomer([row({ evenSplitApplied: false })])
      .some((entry) => entry.clientCode === EZ_CODE),
    "and it DOES list the same customer when the registry does not cover it",
  );

  // 4. the exemption is this customer's, and it does not leak to its neighbours.
  const neighbour = row({
    clientCode: "1099999",
    clientName: "مخزن الشفاء",
    brickId: "B196-9",
    evenSplitApplied: false,
    qty: 600,
    salesValue: 60_000,
  });
  const mixed = splitStoreSalesAcrossCityAreas([row({ evenSplitApplied: true }), neighbour]);
  assert.equal(
    mixed.splitRowCount,
    1,
    "a genuine wholesaler beside a registry customer still splits normally",
  );
  const exempt = customersExemptFromCitySplit([row({ evenSplitApplied: true }), neighbour]);
  assert.equal(exempt.has(EZ_CODE), true, "EZ is exempt");
  assert.equal(exempt.has("1099999"), false, "its neighbour is not");

  // 5. the registry key carries the LINE, because the registry's own key does.
  //
  // sos_even_split_customers is keyed (client_code, official_line). EZ is registered on CNS alone,
  // so the same wholesaler selling on Pedia would still be the city rule's to move — and a key
  // that ignored the line would silently exempt it there too.
  assert.equal(evenSplitKey("1011654", "CNS"), "1011654|cns");
  assert.equal(evenSplitKey(" 1011654 ", " cns "), "1011654|cns", "trimmed and case-folded");
  assert.notEqual(
    evenSplitKey("1011654", "CNS"),
    evenSplitKey("1011654", "Pedia"),
    "one line's registration is not another's",
  );

  // 6. the wiring, pinned at source.
  //
  // Sections 1 to 5 prove the rule. They cannot prove anyone CALLS it: every row above was built by
  // hand with the flag already set. In production the flag has exactly one author — the closing row
  // builder — and if it stops stamping it, every assertion above still passes while EZ splits again
  // in the live workbook. That is the failure this section exists to catch.
  //
  // Matched as substrings, never as byte offsets: a source pin that slices a fixed window
  // false-fails the moment the file shifts by a line.
  const details = readFileSync(
    new URL("../src/lib/sales/monthly-closing-details.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    details.includes("loadEvenSplitCustomerKeys()"),
    "the closing row builder reads the even-split registry",
  );
  assert.ok(
    details.includes("evenSplitApplied: evenSplitCustomers.has(evenSplitKey("),
    "and stamps every row it builds with the answer",
  );

  const splitSource = readFileSync(
    new URL("../src/lib/sales/store-sales-city-split.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    splitSource.includes("if (!row.evenSplitApplied) continue;"),
    "and the split exempts a registered customer on the flag alone — the ONLY exemption left after the owner retired the hand-apportionment route on 2026-09-07",
  );

  // Both live call sites derive their rows from loadMonthlyClosingDetails, which is what makes one
  // stamping point sufficient. If either ever reads rows from somewhere else the flag stops
  // arriving, and this pin is the only thing that would say so.
  const callSites: ReadonlyArray<readonly [string, string]> = [
    ["../src/lib/sales/closing-store-split-net.ts", "loadMonthlyClosingDetails("],
    ["../src/lib/sales/closing-store-split-export.ts", "splitStoreSalesAcrossCityAreas("],
  ];
  for (const [file, reader] of callSites) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(
      source.includes(reader),
      `${file} still takes its rows from the builder that stamps the flag`,
    );
  }

  console.log(
    `  even-split registry honoured: EZ keeps ${EZ_UNITS.toLocaleString("en-US")} units on `
      + `${EZ_AREA}; an unregistered store beside it still divides across Cairo's `
      + `${CAIRO_AREAS.length} areas`,
  );
}
