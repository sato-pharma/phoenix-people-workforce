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
  NO_SPLIT_REGIONS,
  planShares,
  QEMA_PRIORITY_RUNGS,
  QEMA_PRIORITY_STEP,
  qemaPriorityRung,
  splitStoreSalesAcrossCityAreas,
  splitTargetsFor,
  WAREHOUSE_THRESHOLD_DISTRIBUTORS,
  type SplitRegions,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * 🔒 EL QEMA'S PRIORITY LADDER — owner, 2026-09-09, and it REPLACED everything before it.
 *
 *   "what I want is that the qalubeya be qalubeya, then the Monofiua and the gharbia one and two,
 *    okay, then cairo, then any rearrangement after this. But I don't want the areas I mentioned to
 *    be far away from the others — I want them to be exceeding them, but with a very small scale."
 *
 * El Qema's whole Pedia book is divided across every area the line has. The named areas take one
 * small step more per rung, in his order. Nothing else decides anything.
 *
 * 🔴 THIS FILE USED TO PIN FIVE OTHER RULES, ALL OF THEM HIS, ALL OF THEM NOW GONE: the 200-pack
 * governorate rule, the 201–999 half-and-half, the 1,000-plus flat band, the Upper Egypt pool, and
 * the Qalubeya + Cairo local block with its 75/25 weighting. They are in this file's git history and
 * in docs/agents-owner-rules.md. A session finding one of them missing is looking at a DECISION, not
 * a regression, and restoring any of it reverses him.
 *
 * 🔴 WHERE A WAREHOUSE SITS NO LONGER MATTERS AT ALL. That is the single biggest change and the one
 * a reader will disbelieve: a Benha sale and an Aswan sale of the same product now distribute
 * identically, and Benha keeps no more of its own book than anyone else. Asserted below, twice, so
 * an "obvious" reintroduction of an origin preference fails immediately.
 *
 * 🔴 OTHERS NOW KEEP NOTHING, INCLUDING THEIR OWN SALES — "neglect others, don't add others". Every
 * earlier rule let an origin in Others keep what it sold itself, because a home half had to land
 * somewhere. There is no home half now.
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

export function runQemaWarehouseSplitTests() {
  // ── The ladder, pinned to its literals ───────────────────────────────────────────────────────
  //
  // Pinned ONCE here; every arithmetic assertion below reads the constants, so changing the step or
  // the order is caught by these four lines rather than silently followed by the rest of the file.
  assert.equal(QEMA_PRIORITY_STEP, 0.02, "one rung is 2% — 'a very small scale'");
  assert.deepEqual(
    QEMA_PRIORITY_RUNGS.map((rung) => [...rung]),
    [
      ["D11"],
      ["D12", "D13"],
      ["D14", "D15"],
      ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6"],
    ],
    "Qalubeya, then Menoufia, then Gharbia, then Cairo — his order, most-favoured first",
  );
  assert.deepEqual([...WAREHOUSE_THRESHOLD_DISTRIBUTORS], ["QM"], "El Qema only");

  // Down town is listed on the Cairo rung and removed by the Others exclusion, never by a shorter
  // hand-kept list — so moving it out of Others in the organogram rejoins it with no code change.
  assert.ok(QEMA_PRIORITY_RUNGS[3].includes("CA5"), "Down town is on the Cairo rung as written");
  assert.equal(qemaPriorityRung("D11"), 4, "Qalubeya sits four steps up");
  assert.equal(qemaPriorityRung("D13"), 3, "Menoufia three");
  assert.equal(qemaPriorityRung("D15"), 2, "Gharbia two");
  assert.equal(qemaPriorityRung("CA2"), 1, "Cairo one");
  assert.equal(qemaPriorityRung("AB1"), 0, "and every unnamed area sits on the bottom rung");

  // The universe is AREA_CITY, so the two areas that are not territories stay out of it. Without
  // this, a share would drain into Main Store, which has no rep, no DM and no target.
  assert.equal(ALL_SPLIT_AREAS.length, AREA_CITY.size, "every area of the city list, and only those");
  for (const excluded of AREAS_DELIBERATELY_NOT_SPLIT.keys()) {
    assert.equal(
      ALL_SPLIT_AREAS.includes(excluded),
      false,
      `${excluded} is not a territory, so the ladder never reaches it`,
    );
  }

  // ── Pedia's organogram, as production holds it ───────────────────────────────────────────────
  const PEDIA_OTHERS: ReadonlySet<string> = new Set([
    "CA5", "D17", "UE8", "OT1", "OT2", "OT4", "OT5", "OT6", "OT7", "OT8", "OT9", "OT10",
  ]);
  const PEDIA_REGIONS: SplitRegions = { areasByRegion: new Map(), others: PEDIA_OTHERS };
  const IN_PLAY = ALL_SPLIT_AREAS.length - PEDIA_OTHERS.size;
  assert.equal(IN_PLAY, 37, "49 areas less the 12 of Pedia's Others that are on the city list");

  const plan = splitTargetsFor(row(), 700, PEDIA_REGIONS);
  assert.ok(plan, "an El Qema Pedia row always has a plan");
  assert.equal(plan.areas.length, IN_PLAY, "it reaches every area in play, and only those");
  assert.equal(plan.awayAreas.length, 0, "there is no away block any more — one ladder, no halves");
  assert.equal(new Set(plan.areas).size, plan.areas.length, "and no area appears twice");

  for (const area of PEDIA_OTHERS) {
    assert.equal(plan.areas.includes(area), false, `${area} is in Others and takes nothing`);
  }

  // ── The order, and the size of the gaps ──────────────────────────────────────────────────────
  const shares = planShares(plan, 700);
  const at = (code: string) => shares[plan.areas.indexOf(code)];
  assert.equal(
    shares.reduce((sum, share) => sum + share, 0),
    700,
    "the shares still sum back to the row EXACTLY",
  );

  const bottom = at("AB1");
  const step = bottom * QEMA_PRIORITY_STEP;
  const expected: ReadonlyArray<readonly [string, number]> = [
    ["D11", 4], ["D12", 3], ["D13", 3], ["D14", 2], ["D15", 2],
    ["CA1", 1], ["CA2", 1], ["CA3", 1], ["CA4", 1], ["CA6", 1],
  ];
  for (const [code, rungs] of expected) {
    assert.equal(
      Number(at(code).toFixed(9)),
      Number((bottom + rungs * step).toFixed(9)),
      `${code} sits exactly ${rungs} rung(s) above an unnamed area`,
    );
  }
  assert.ok(at("D11") > at("D12"), "Qalubeya above Menoufia");
  assert.ok(at("D12") > at("D14"), "Menoufia above Gharbia");
  assert.ok(at("D14") > at("CA1"), "Gharbia above Cairo");
  assert.ok(at("CA1") > bottom, "and Cairo above everyone else");

  // 🔴 "EXCEEDING THEM, BUT WITH A VERY SMALL SCALE." The whole country must stay inside a few
  // percent. Asserted as a RATIO rather than a pack count so it holds at any row size.
  assert.ok(
    at("D11") / bottom < 1.10,
    `the top area is ${(at("D11") / bottom).toFixed(4)}x the bottom — the ladder is a tilt, not a cliff`,
  );

  // ── 🔴 THE ORIGIN NO LONGER MATTERS. Two assertions, because this is the change a later session
  // is most likely to "fix" back by reintroducing a home block.
  const fromAswanCity = splitTargetsFor(
    row({ areaCode: "AB1", clientCode: "QM-9002" }), 700, PEDIA_REGIONS,
  );
  assert.ok(fromAswanCity);
  assert.deepEqual(
    [...fromAswanCity.areas],
    [...plan.areas],
    "a warehouse in Alexandria reaches exactly the same areas as one in Benha",
  );
  assert.deepEqual(
    planShares(fromAswanCity, 700).map((share) => Number(share.toFixed(9))),
    shares.map((share) => Number(share.toFixed(9))),
    "and divides them identically — Benha keeps no more of its own book than Alexandria does",
  );

  // An origin sitting IN Others keeps nothing at all now.
  const fromOthers = splitTargetsFor(row({ areaCode: "OT9", clientCode: "QM-9003" }), 700, PEDIA_REGIONS);
  assert.ok(fromOthers, "a warehouse in an Others area still has a plan");
  assert.equal(
    fromOthers.areas.includes("OT9"),
    false,
    "but it keeps none of its own sale — 'neglect others, don't add others'",
  );

  // ── 🔴 QUANTITY NO LONGER MATTERS EITHER. The 200 and 1,000 thresholds are gone; a tiny row and a
  // huge one distribute in the same proportions.
  const small = splitTargetsFor(row({ qty: 24 }), 24, PEDIA_REGIONS);
  const huge = splitTargetsFor(row({ qty: 6_000 }), 6_000, PEDIA_REGIONS);
  assert.ok(small && huge);
  const proportions = (p: NonNullable<typeof small>, total: number) =>
    planShares(p, total).map((share) => Number((share / total).toFixed(9)));
  assert.deepEqual(
    proportions(small, 24),
    proportions(huge, 6_000),
    "24 packs and 6,000 packs spread the same way — there are no bands left",
  );

  // ── An organogram that failed to load must not strip areas out of a distribution ─────────────
  const noOrg = splitTargetsFor(row(), 700, NO_SPLIT_REGIONS);
  assert.ok(noOrg);
  assert.equal(
    noOrg.areas.length,
    ALL_SPLIT_AREAS.length,
    "an empty exclusion set spreads over the whole country rather than dropping anyone",
  );

  // ── The whole book, through the real entry point, still balances ─────────────────────────────
  const split = splitStoreSalesAcrossCityAreas([row()], "2026-09", PEDIA_REGIONS);
  assert.equal(split.splitRowCount, 1, "the row was split");
  const landed = split.rows.filter((r) => r.clientCode === "QM-9001");
  assert.equal(landed.length, IN_PLAY, "one synthetic row per area in play");
  assert.equal(
    Number(landed.reduce((sum, r) => sum + r.qty, 0).toFixed(6)),
    700,
    "and the split moves money without creating or destroying any",
  );
  assert.equal(
    Number(landed.reduce((sum, r) => sum + r.salesValue, 0).toFixed(6)),
    189_000,
    "value likewise",
  );

  // ── 🔒 EL QEMA IS PEDIA ONLY — owner golden rule, 2026-09-08, in those words ─────────────────
  //
  // Their whole book is Lacto Advanced 1 and 2, both Pedia. An El Qema row arriving on another line
  // falls back to the plain city split, which also keeps every one of these rules off the published
  // August Anti Infective.
  for (const line of ["CNS", "Anti Infective"]) {
    const otherLine = splitTargetsFor(row({ officialLine: line }), 5_000, PEDIA_REGIONS);
    assert.ok(otherLine, `El Qema on ${line} still resolves a plan`);
    assert.deepEqual(
      [...otherLine.areas],
      ["D11"],
      `${line} falls back to Qalubeya's ordinary one-area city split, never the ladder`,
    );
  }

  // ── And none of this makes a pharmacy into a store ───────────────────────────────────────────
  assert.equal(
    isSplitEligible(row({ clientCode: "QM-9005", clientName: "صيدلية النور" }), "2026-09", 5_000),
    false,
    "5,000 packs to a pharmacy is still a pharmacy",
  );
  assert.ok(isWholesaleOnlyDistributor("QM"), "every El Qema customer is a warehouse");
  assert.ok(WHOLESALE_ONLY_DISTRIBUTORS.has("QM"), "and the registry says so");
  assert.ok(
    isStoreCustomerForPeriod(BASE.clientName, BASE.clientCode, "QM", "2026-09", "Pedia"),
    "so an El Qema customer is a store for the split, whatever its name reads like",
  );
}
