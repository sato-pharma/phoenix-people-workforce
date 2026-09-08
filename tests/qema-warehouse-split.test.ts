import assert from "node:assert/strict";

import {
  isStoreCustomerForPeriod,
  isWholesaleOnlyDistributor,
  WHOLESALE_ONLY_DISTRIBUTORS,
} from "../src/lib/sales/customer-channel.ts";
import {
  ALL_SPLIT_AREAS,
  AREA_CITY,
  AREAS_DELIBERATELY_NOT_SPLIT,
  isSplitEligible,
  planShares,
  splitStoreSalesAcrossCityAreas,
  splitTargetsFor,
  WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION,
  WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY,
  WAREHOUSE_THRESHOLD_DISTRIBUTORS,
  warehouseSplitQtyByKey,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * THE WAREHOUSE SPLIT (تقسيمة المخازن) — owner, 2026-09-08.
 *
 *   "اي مخزن لحد 200 علبة per product يوزع علي مندوبين المحافظة وليس له علاقه بتوزيع الجمهورية"
 *   "اي مخزن فوق 200 باي كميه يوزع 50 % علي مندوبين المحافظة وباقي ال 50% يوزع علي باقي الجمهورية
 *    بالتساوي ماعدا مندوبين نفس المحافظة اللي اتطبع فيها الاوردر"
 *
 * This REPLACES the Qalubeya→Cairo rule of 2026-09-07, which he retired the following day. The old
 * rule sent El Qema's Qalubeya money to Cairo and nowhere else, one way; this one sends half of any
 * over-200 warehouse order to the whole country and keeps half at home. Three things in the old
 * test are deliberately reversed here, and each is asserted so the reversal cannot be undone by
 * accident:
 *
 *   * Cairo is no longer a special destination — it is 6 of 49 areas like anywhere else.
 *   * The rule is no longer one-way. A CAIRO warehouse over 200 now reaches Qalubeya too.
 *   * Qalubeya no longer gives away six sevenths. It keeps half, and half of half of nothing is
 *     still the point: Qalubeya holds ONE area, so the whole home half lands on D11.
 *
 * WHAT HAS NOT CHANGED, and is re-pinned below because a rewrite is exactly when it gets lost:
 * every El Qema customer is a warehouse, the divisor is AREAS and not reps, and a pharmacy or a
 * hospital never becomes a store just because El Qema invoiced it.
 */

const BASE: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-9001",
  clientName: "مخزن القليوبية للأدوية",
  distributorCode: "QM",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 700,
  salesValue: 189_000,
};

const row = (over: Partial<StoreSplitRow> = {}): StoreSplitRow => ({ ...BASE, ...over });

const CAIRO = ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6"] as const;

export function runQemaWarehouseSplitTests() {
  // ── The constants the rule is stated in ──────────────────────────────────────────────────────
  assert.equal(WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY, 200, "the threshold is 200 packs per product");
  assert.equal(WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION, 0.5, "half stays in the governorate");
  assert.deepEqual([...WAREHOUSE_THRESHOLD_DISTRIBUTORS], ["QM"], "El Qema only — owner 2026-09-08");

  // The universe is AREA_CITY, so the two areas that are not territories stay out of it. Without
  // this, half of every large order would drain into Main Store, which has no rep, no DM, no target
  // and no way of ever paying it out to anybody.
  assert.equal(ALL_SPLIT_AREAS.length, AREA_CITY.size, "every area of the city list, and only those");
  for (const excluded of AREAS_DELIBERATELY_NOT_SPLIT.keys()) {
    assert.equal(
      ALL_SPLIT_AREAS.includes(excluded),
      false,
      `${excluded} is not a territory to spread across, so the national half never reaches it`,
    );
  }

  // ── Above 200: half home, half across the rest of the country ────────────────────────────────
  const plan = splitTargetsFor(row());
  assert.ok(plan, "an El Qema Qalubeya warehouse over 200 has a plan");
  assert.deepEqual([...plan.homeAreas], ["D11"], "Qalubeya holds exactly one area, so it IS the home block");
  assert.equal(plan.homeFraction, 0.5, "and half the order stays on it");
  assert.equal(plan.awayAreas.length, ALL_SPLIT_AREAS.length - 1, "the away block is every other area");
  assert.equal(
    plan.awayAreas.includes("D11"),
    false,
    "THE EXCLUSION: the origin governorate is never in its own away block — "
      + "«ماعدا مندوبين نفس المحافظة اللي اتطبع فيها الاوردر»",
  );
  // With NO exclusion set the universe is every area, Down town included. That is the baseline this
  // module has always had, and the safe direction: a caller that cannot read the organogram splits
  // exactly as before rather than silently dropping areas. The Others exclusion is asserted further
  // down, where Down town comes OUT — see the 2026-09-08 block.
  assert.ok(plan.awayAreas.includes("CA5"), "no exclusion set — every area is a target, Down town included");

  const qema = splitStoreSalesAcrossCityAreas([row()], "2026-09");
  const shares = qema.rows.filter((r) => r.clientCode === "QM-9001");
  assert.equal(shares.length, ALL_SPLIT_AREAS.length, "one row becomes one per area in the country");

  const home = shares.find((r) => r.areaCode === "D11");
  assert.ok(home, "Qalubeya keeps a row of its own");
  assert.equal(Number(home.qty.toFixed(6)), 350, "half of 700 stays in Qalubeya, all on its single area");
  assert.equal(Number(home.salesValue.toFixed(2)), 94_500, "and half the value with it");

  const away = shares.filter((r) => r.areaCode !== "D11");
  assert.equal(away.length, 48, "48 areas outside Qalubeya");
  const awayQty = 350 / 48;
  for (const share of away) {
    assert.equal(Number(share.qty.toFixed(6)), Number(awayQty.toFixed(6)), "the other half divides evenly");
  }

  // The invariant the whole change rests on: the split relocates units, it never makes or loses one.
  assert.equal(
    Number(shares.reduce((sum, r) => sum + r.qty, 0).toFixed(9)),
    700,
    "units are preserved exactly",
  );
  assert.equal(
    Number(shares.reduce((sum, r) => sum + r.salesValue, 0).toFixed(9)),
    189_000,
    "and so is value",
  );

  // ── Up to 200: the governorate only, and nothing to do with the country ──────────────────────
  //
  // He drew the line at "لحد 200" — up TO 200 — so 200 exactly is a local sale and 201 is not.
  // Alexandria is the origin here because Qalubeya has one area and would show nothing either way.
  const atThreshold = splitTargetsFor(row({ areaCode: "AB2", clientCode: "QM-9010", qty: 200 }), 200);
  assert.ok(atThreshold);
  assert.deepEqual([...atThreshold.areas], ["AB1", "AB2", "AB3"], "200 exactly stays inside Alexandria");
  assert.equal(atThreshold.awayAreas.length, 0, "no national half at the threshold itself");
  assert.equal(atThreshold.group, "Alexandria", "and it is labelled the ordinary city");

  const overThreshold = splitTargetsFor(row({ areaCode: "AB2", clientCode: "QM-9010", qty: 201 }), 201);
  assert.ok(overThreshold);
  assert.equal(overThreshold.awayAreas.length, ALL_SPLIT_AREAS.length - 3, "201 crosses it — Alexandria's 3 areas stay home");

  // A Qalubeya order at or below 200 has a single target, so nothing moves at all.
  assert.equal(
    isSplitEligible(row({ qty: 120 }), "2026-09", 120),
    false,
    "up to 200 in a one-area governorate is simply left where it is",
  );

  // ── THE ONE-WAY PROPERTY IS GONE, DELIBERATELY ───────────────────────────────────────────────
  //
  // Under the old rule a Cairo warehouse could never reach Qalubeya. The new rule is symmetric
  // across governorates: any El Qema warehouse over 200 reaches everywhere. If this assertion is
  // ever "fixed" back, the 2026-09-08 ruling has been reverted to the 2026-09-07 one.
  const cairo = splitTargetsFor(row({ areaCode: "CA3", clientCode: "QM-9002" }));
  assert.ok(cairo);
  assert.deepEqual([...cairo.homeAreas].sort(), [...CAIRO].sort(), "Cairo's six areas are its home block");
  assert.ok(cairo.awayAreas.includes("D11"), "and a Cairo warehouse over 200 NOW reaches Qalubeya");
  assert.equal(cairo.awayAreas.length, ALL_SPLIT_AREAS.length - 6, "every area outside Cairo");

  // ── EL QEMA ONLY: the same warehouse through another distributor is untouched ─────────────────
  for (const distributor of ["PS", "IS", "IS-S", "EP-PHS", undefined]) {
    const other = row({ clientCode: "PS-9003", distributorCode: distributor, qty: 5_000 });
    const targets = splitTargetsFor(other, 5_000);
    assert.deepEqual(
      targets?.areas ? [...targets.areas] : null,
      ["D11"],
      `5,000 packs in Qalubeya through ${distributor ?? "no distributor"} still targets ITSELF ALONE`,
    );
    assert.equal(
      isSplitEligible(other, "2026-09", 5_000),
      false,
      `so nothing moves through ${distributor ?? "no distributor"} — the threshold is El Qema's alone`,
    );
  }

  // ── 🔴 THE THRESHOLD IS THE MONTH'S TOTAL, NOT ONE ROW ───────────────────────────────────────
  //
  // The same warehouse and product arriving as three 100-pack rows is a 300-pack month. Judged per
  // row it is three sub-threshold orders and NOTHING leaves Qalubeya; judged on the aggregate it
  // crosses 200 and half the money goes national. There is no error either way — the split preserves
  // the line total, so the publication drift check cannot see the difference. This assertion is the
  // only thing standing between those two answers.
  const threeRows = [
    row({ qty: 100, salesValue: 27_000 }),
    row({ qty: 100, salesValue: 27_000 }),
    row({ qty: 100, salesValue: 27_000 }),
  ];
  const aggregate = warehouseSplitQtyByKey(threeRows);
  assert.equal([...aggregate.values()][0], 300, "the three rows are one 300-pack warehouse month");

  const split3 = splitStoreSalesAcrossCityAreas(threeRows, "2026-09");
  const areas3 = new Set(split3.rows.map((r) => r.areaCode));
  assert.equal(areas3.size, ALL_SPLIT_AREAS.length, "so all three rows go national together");
  assert.equal(
    Number(split3.rows.reduce((sum, r) => sum + r.qty, 0).toFixed(9)),
    300,
    "and the month's units are still exactly 300",
  );

  // A product that genuinely stays under on its own is untouched by a sibling that does not: the key
  // carries the product, so a big LA001 cannot drag a small LA002 across the country with it.
  const twoProducts = warehouseSplitQtyByKey([
    row({ productCode: "LA001", qty: 4_000 }),
    row({ productCode: "LA002", qty: 40 }),
  ]);
  assert.equal(twoProducts.size, 2, "one entry per product");
  assert.equal([...twoProducts.values()].filter((v) => v === 40).length, 1, "the small product keeps its own total");

  // ── planShares divides exactly, which is what keeps the matrix from drifting ──────────────────
  for (const total of [700, 189_000, 0.07, 1_000_000 / 3]) {
    const parts = planShares(plan, total);
    assert.equal(parts.length, ALL_SPLIT_AREAS.length);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} divides and sums back bit-exactly`);
  }

  // ── The movement label says WHICH rule moved the money ───────────────────────────────────────
  const movement = qema.movements.find((m) => m.outQty > 0);
  assert.ok(movement, "the split reports a movement out of the origin");
  assert.equal(
    movement.city,
    "Qalubeya + nationwide",
    "the Store Split sheet names the national rule, so a reader is never left guessing why Aswan gained",
  );

  // ── EVERY El Qema customer is a warehouse — owner, 2026-09-07, restated 2026-09-08 ───────────
  //
  // "consider el qema distbutor not warehouse and the customers in it vare the warehouses golden
  // rule". El Qema sells ON to other wholesalers rather than to pharmacies, so the name test has
  // nothing to add: of their customers the six keywords catch only a third.
  assert.ok(isWholesaleOnlyDistributor("QM"), "El Qema is a wholesale-only distributor");
  assert.ok(isWholesaleOnlyDistributor("qm"), "and the check is case-insensitive");
  assert.equal(WHOLESALE_ONLY_DISTRIBUTORS.size, 1, "El Qema is the ONLY one — adding another is his call");

  for (const name of ["كيان قنا", "دلة الفيوم", "رويال الاسماعيليه", "هانى براعى المنيا", "الدكتور محمد شعير"]) {
    assert.equal(
      isStoreCustomerForPeriod(name, null, "QM", "2026-09", "Pedia"),
      true,
      `${name} is a warehouse because El Qema sold it, not because of its name`,
    );
    assert.equal(
      isStoreCustomerForPeriod(name, null, "PS", "2026-09", "Pedia"),
      false,
      `${name} through Overseas is unchanged — the rule is about the DISTRIBUTOR, not the customer`,
    );
  }

  // A hospital or a government depot still does not split, whoever sold it.
  for (const name of ["مستشفى المنزله العام", "ت.ص.مخازن السيوف", "صيدلية النور"]) {
    assert.equal(
      isStoreCustomerForPeriod(name, null, "QM", "2026-09", "Pedia"),
      false,
      `${name} does not become a warehouse just because El Qema invoiced it`,
    );
  }

  // ── 🔴 OTHERS TAKE NO SHARE — owner, 2026-09-08 ─────────────────────────────────────────────
  //
  // "you will follow the EU organogram of pedia line and exclude in distribution the areas in others"
  //
  // The Pedia organogram parks 13 areas in the Others territory (`OT`): Down town, Kafr El-Sheikh 2,
  // Qena 2 and the ten OT areas. Retired OT3 is not in AREA_CITY at all, so twelve of them come out
  // of a 49-area universe and 37 remain. The set is per LINE and is NOT a geography — on Anti
  // Infective it holds Qalubeya itself — which is why it is passed in rather than derived here.
  const PEDIA_OTHERS: ReadonlySet<string> = new Set([
    "CA5", "D17", "UE8", "OT1", "OT2", "OT4", "OT5", "OT6", "OT7", "OT8", "OT9", "OT10",
  ]);
  const REMAINING = ALL_SPLIT_AREAS.length - PEDIA_OTHERS.size;
  assert.equal(REMAINING, 37, "49 areas less the 12 of Pedia's Others that are on the city list");

  const excluded = splitTargetsFor(row(), 700, PEDIA_OTHERS);
  assert.ok(excluded, "an El Qema Qalubeya warehouse still has a plan");
  assert.deepEqual(
    [...excluded.homeAreas],
    ["D11"],
    "Qalubeya is a district of its own on Pedia, so it keeps the whole home half",
  );
  assert.equal(excluded.awayAreas.length, REMAINING - 1, "the national half now reaches 36 areas, not 48");
  for (const area of PEDIA_OTHERS) {
    assert.equal(excluded.awayAreas.includes(area), false, `${area} is in Others and receives nothing`);
  }

  // 🔴 DOWN TOWN IS OUT, and that reverses the 2026-09-07 ruling ON PURPOSE. He was shown the
  // reversal in those words on 2026-09-08 — that the Pedia organogram files Down town under Others,
  // so excluding Others takes it out — and confirmed. The divisor is still AREAS, not reps; there
  // are simply fewer areas. Re-adding CA5 here would restore a rule he has replaced.
  assert.equal(
    excluded.awayAreas.includes("CA5"),
    false,
    "Down town sits in Others on the Pedia organogram, so it takes no share",
  );

  // The money still all lands somewhere — fewer areas, bigger shares, identical total.
  const exSplit = splitStoreSalesAcrossCityAreas([row()], "2026-09", PEDIA_OTHERS);
  const exShares = exSplit.rows.filter((r) => r.clientCode === "QM-9001");
  assert.equal(exShares.length, REMAINING, "one row per area that remains");
  assert.equal(
    Number(exShares.reduce((sum, r) => sum + r.qty, 0).toFixed(9)),
    700,
    "and the total is preserved exactly — excluding an area moves money, it never deletes any",
  );

  // 🔴 AN EMPTY SET IS THE SAFE DIRECTION. A caller whose organogram read failed must split as it
  // always did, never strip areas out of a distribution on an outage.
  assert.equal(
    splitTargetsFor(row(), 700, new Set())?.areas.length,
    ALL_SPLIT_AREAS.length,
    "no exclusions means the whole country, exactly as before this rule existed",
  );

  // An area is excluded from receiving OTHER people's money, never from keeping its own.
  const fromDownTown = splitTargetsFor(row({ areaCode: "CA5", clientCode: "QM-9020" }), 700, PEDIA_OTHERS);
  assert.ok(fromDownTown, "a warehouse sitting IN an Others area still has a plan");
  assert.ok(
    fromDownTown.homeAreas.includes("CA5"),
    "the origin keeps its own share — otherwise its home half would have nowhere at all to go",
  );

  // ── 🔒 EL QEMA IS PEDIA ONLY — owner golden rule, 2026-09-08, in those words ─────────────────
  //
  // Their whole book is Lacto Advanced 1 and 2, both Pedia. An El Qema row arriving on another line
  // falls back to the plain city split rather than taking a rule he scoped to Pedia — which also
  // means this change can never reach August Anti Infective, a published and announced month.
  for (const line of ["CNS", "Anti Infective"]) {
    const otherLine = splitTargetsFor(row({ officialLine: line }), 5_000, PEDIA_OTHERS);
    assert.ok(otherLine, `El Qema on ${line} still resolves a plan`);
    assert.equal(
      otherLine.awayAreas.length,
      0,
      `El Qema on ${line} takes NO national split — the 200-pack rule is Pedia only`,
    );
    assert.deepEqual(
      [...otherLine.areas],
      ["D11"],
      `and ${line} falls back to Qalubeya's ordinary one-area city split`,
    );
  }

  // And the threshold decides WHERE a store's money goes — it never makes a pharmacy into a store.
  assert.equal(
    isSplitEligible(row({ clientCode: "QM-9005", clientName: "صيدلية النور" }), "2026-09", 5_000),
    false,
    "5,000 packs to a pharmacy is still a pharmacy",
  );
}
