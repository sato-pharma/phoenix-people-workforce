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
  CITY_AREAS,
  detailStoreSplitByCustomer,
  isSplitEligible,
  LOCAL_BLOCK_OVERRIDES,
  NO_SPLIT_REGIONS,
  planShares,
  QEMA_LEAD_AREAS,
  QEMA_LEAD_STEP,
  QEMA_LEAD_TIERS,
  splitStoreSalesAcrossCityAreas,
  splitTargetsFor,
  UPPER_EGYPT_AREAS,
  UPPER_EGYPT_HOME_FRACTION,
  upperEgyptAreasFor,
  WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY,
  WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION,
  WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY,
  WAREHOUSE_THRESHOLD_DISTRIBUTORS,
  type SplitRegions,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * 🔒 EL QEMA — THE THREE BANDS AND THE UPPER EGYPT REDISTRIBUTION. Owner, 2026-09-09 evening,
 * restating the whole rule in Arabic from scratch and confirming when asked:
 * "remove any current rule and implement those".
 *
 *   نظام توزيع القمه الموحد — 3 خطوات بالترتيب
 *   1. اي مخزن اقل من 200 علبه حتي 200 علبه يقسم علي مندوبي المحافظة
 *   2. اي مخزن من 201 حتي 999 — 50% يقسم علي مندوبي المحافظة والكلام ده ينطبق علي القليوبية
 *      (القليوبية + القاهرة)، و 50% الاخري تقسم علي باقي الجمهورية بالتساوي
 *   3. اي مخزن من 1000 علبه فما فوق يقسم علي مندوبي الجمهوريه بالتساوي وليس Others
 *
 *   تقسيم القمه للصعيد — هناخد كل البيع اللي محسوب للصعيد و نعيد توزيعوا 50% منه لكل محافظات
 *   الصعيد بالتساوى، وال 50% الباقيه يوزع علي الجمهورية
 *
 * 🔴 THE PRIORITY LADDER IS GONE, AND IT WAS HIS TOO. Between 2026-09-09 afternoon and evening El
 * Qema's book was divided by four named rungs one 2% step apart, with the origin deciding nothing.
 * He replaced it with the text above. Finding `QEMA_PRIORITY_RUNGS`, `QEMA_PRIORITY_STEP` or
 * `qemaLadderPlan` missing is a DECISION, not a regression, and restoring any of it reverses him.
 * The 75/25 Qalubeya weighting went with it — see LOCAL_BLOCK_OVERRIDES.
 *
 * 🔴 THE ARITHMETIC BELOW IS DERIVED TWICE, ON PURPOSE. `referenceQemaShares` is a second reading of
 * his words that shares no code with `splitTargetsFor`. Asserting the engine against itself is what
 * let three earlier versions of this rule ship with confident tests, so every share assertion here
 * compares the engine to that independent derivation rather than to a number copied out of a run.
 */

/**
 * The owner's rule, written out again from his words. NOT the implementation — that is the point.
 *
 * `bandQty` is the warehouse-and-product month total the band is judged on; `total` is the amount
 * being divided (packs on one pass, value on the other).
 */
export function referenceQemaShares(
  originArea: string,
  bandQty: number,
  total: number,
  others: ReadonlySet<string>,
): Map<string, number> {
  // An area barred from RECEIVING someone else's money still keeps what it sold itself.
  const keep = (area: string) => !others.has(area) || area === originArea;
  const inPlay = ALL_SPLIT_AREAS.filter(keep);

  // "مندوبي المحافظة" — the governorate, widened to Qalubeya + Cairo where he said so.
  const block = LOCAL_BLOCK_OVERRIDES.get(`QM|${originArea}`)?.areas
    ?? CITY_AREAS.get(AREA_CITY.get(originArea) ?? "")
    ?? [];
  const blockSet = new Set(block);
  const home = block.filter(keep);
  const away = ALL_SPLIT_AREAS.filter((area) => !blockSet.has(area) && keep(area));

  const share = new Map<string, number>();
  const give = (area: string, amount: number) => share.set(area, (share.get(area) ?? 0) + amount);

  if (bandQty <= 200 || away.length === 0) {
    home.forEach((area) => give(area, total / home.length));           // step 1
  } else if (bandQty >= 1_000) {
    inPlay.forEach((area) => give(area, total / inPlay.length));       // step 3
  } else {
    home.forEach((area) => give(area, (total * 0.5) / home.length));   // step 2
    away.forEach((area) => give(area, (total * 0.5) / away.length));
  }

  // تقسيم القمه للصعيد, on whatever the three steps produced.
  const upperEgypt = new Set(
    UPPER_EGYPT_AREAS.filter((area) => AREA_CITY.has(area) && !others.has(area)),
  );
  const ue = inPlay.filter((area) => upperEgypt.has(area));
  const pooled = [...share].reduce(
    (sum, [area, amount]) => sum + (upperEgypt.has(area) ? amount : 0),
    0,
  );
  if (ue.length > 0 && pooled > 0) {
    upperEgypt.forEach((area) => {
      if (share.has(area)) share.set(area, 0);
    });
    const half = pooled * UPPER_EGYPT_HOME_FRACTION;
    ue.forEach((area) => give(area, half / ue.length));
    inPlay.forEach((area) => give(area, (pooled - half) / inPlay.length));
  }
  return share;
}

/**
 * The lead guarantee, solved as ALGEBRA rather than iterated — a genuinely different derivation
 * from the one that ships, which converges on it numerically.
 *
 * The three named areas end on one figure F, and everyone else is scaled by the same factor to pay
 * for it. F is a fixed point, because the area they must beat SHRINKS once they have been paid:
 *
 *     F = (1+k)·T·keep,  keep = (P − need)/P,  need = n·F − ΣL
 *   ⇒ F = (1+k)·T·(P + ΣL) / (P + (1+k)·n·T)
 *
 * T is the highest other area before the move, P the sum of the others, L the three areas' own
 * totals, n how many of them there are, k the step. Valid while all three start below F, which is
 * asserted rather than assumed.
 */
export function referenceQemaLead(
  landing: ReadonlyMap<string, number>,
  tiers: readonly (readonly string[])[] = QEMA_LEAD_TIERS,
): Map<string, number> {
  const leadSet = new Set(tiers.flat());
  let pool = 0;
  let top = 0;
  for (const [area, amount] of landing) {
    if (leadSet.has(area)) continue;
    pool += amount;
    if (amount > top) top = amount;
  }
  const own = [...leadSet].reduce((sum, area) => sum + (landing.get(area) ?? 0), 0);
  const k = 1 + QEMA_LEAD_STEP;

  // Each tier clears the one below it by a step, and the bottom tier clears the field, so tier t
  // (counting from the top) sits at k^(n−t) times the field. The field itself shrinks by the same
  // factor everyone pays, which is what makes this one equation rather than a loop:
  //
  //     need = T·keep·S − ΣL,  keep = (P − need)/P,  S = Σ k^(n−t)·m_t
  //   ⇒ need = P·(T·S − ΣL) / (P + T·S)
  const weight = (index: number) => k ** (tiers.length - index);
  const S = tiers.reduce((sum, tier, index) => sum + weight(index) * tier.length, 0);
  const need = (pool * (top * S - own)) / (pool + top * S);
  const keep = (pool - need) / pool;

  const out = new Map<string, number>();
  for (const [area, amount] of landing) {
    if (!leadSet.has(area)) out.set(area, amount * keep);
  }
  tiers.forEach((tier, index) => {
    const floor = top * keep * weight(index);
    for (const area of tier) {
      assert.ok(
        (landing.get(area) ?? 0) < floor,
        `${area} must start below its floor for the closed form to hold`,
      );
      out.set(area, floor);
    }
  });
  return out;
}

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

/** Pedia's Others, exactly as production holds it for August 2026. */
const PEDIA_OTHERS: ReadonlySet<string> = new Set([
  "CA5", "D17", "UE8", "OT1", "OT2", "OT4", "OT5", "OT6", "OT7", "OT8", "OT9", "OT10",
]);

/**
 * The organogram as August holds it — and 🔴 note where Fayoum and Beni Suef sit. Both are in the
 * GIZA region until the Upper Egypt split dates in on 2026-09-01, which is exactly why the Upper
 * Egypt set cannot be read from region codes alone.
 */
const PEDIA_REGIONS: SplitRegions = {
  areasByRegion: new Map<string, ReadonlySet<string>>([
    ["AB", new Set(["AB1", "AB2", "AB3", "AB4", "AB5", "D16"])],
    ["CA", new Set(["CA1", "CA2", "CA3", "CA4", "CA6"])],
    ["D1", new Set(["D11", "D12", "D13", "D14", "D15"])],
    ["D2", new Set(["D21", "D22", "D23", "D24", "D25", "D26"])],
    ["GZ", new Set(["GZ1", "GZ2", "GZ3", "GZ4", "GZ5", "GZ6", "GZ7", "UE9"])],
    ["OT", PEDIA_OTHERS],
    ["UE", new Set(["UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7"])],
  ]),
  others: PEDIA_OTHERS,
};

const round = (value: number) => Number(value.toFixed(9));

export function runQemaWarehouseSplitTests() {
  // ── The bands, pinned to their literals ──────────────────────────────────────────────────────
  //
  // Pinned ONCE here; every arithmetic assertion below reads the constants, so moving a boundary is
  // caught by these lines rather than silently followed by the rest of the file.
  assert.equal(WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY, 200, "step 1 runs up to and including 200");
  assert.equal(WAREHOUSE_NATIONAL_SPLIT_HOME_FRACTION, 0.5, "step 2 keeps half at home");
  assert.equal(WAREHOUSE_NATIONAL_SPLIT_FLAT_QTY, 1_000, "step 3 starts at 1,000");
  assert.equal(UPPER_EGYPT_HOME_FRACTION, 0.5, "half of Upper Egypt's take returns to Upper Egypt");
  assert.deepEqual([...WAREHOUSE_THRESHOLD_DISTRIBUTORS], ["QM"], "El Qema only");

  // 🔴 NO WEIGHTING INSIDE THE QALUBEYA BLOCK. He named the block in step 2 and named no split
  // inside it. The 60/40 and then 75/25 of that same afternoon went with the ladder.
  const qalubeyaBlock = LOCAL_BLOCK_OVERRIDES.get("QM|D11");
  assert.ok(qalubeyaBlock, "Qalubeya's local block is still Qalubeya + Cairo");
  assert.deepEqual(
    [...qalubeyaBlock.areas],
    ["CA1", "CA2", "CA3", "CA4", "CA5", "CA6", "D11"],
    "the six Cairo areas and Qalubeya — Down town included, and removed by Others, never by a list",
  );
  assert.equal(qalubeyaBlock.primaryFraction, undefined, "and no area of it takes a bigger share");
  assert.equal(qalubeyaBlock.primaryArea, undefined);
  assert.equal(LOCAL_BLOCK_OVERRIDES.size, 1, "one block override, and it is one-way — no QM|CA*");

  // The universe is AREA_CITY, so the two areas that are not territories stay out of it. Without
  // this, a share would drain into Main Store, which has no rep, no DM and no target.
  assert.equal(ALL_SPLIT_AREAS.length, AREA_CITY.size, "every area of the city list, and only those");
  assert.equal(ALL_SPLIT_AREAS.length, 49, "49 areas");
  for (const excluded of AREAS_DELIBERATELY_NOT_SPLIT.keys()) {
    assert.equal(
      ALL_SPLIT_AREAS.includes(excluded),
      false,
      `${excluded} is not a territory, so no band ever reaches it`,
    );
  }

  const IN_PLAY = ALL_SPLIT_AREAS.length - PEDIA_OTHERS.size;
  assert.equal(IN_PLAY, 37, "49 areas less the 12 of Pedia's Others that are on the city list");

  // ── 🔴 THE UPPER EGYPT SET CANNOT BE READ FROM AUGUST'S REGION CODES ──────────────────────────
  //
  // This is the assertion that pays for this whole block. On Pedia the `UE` operational region
  // holds only Minia 1-2, Assuit 1-2, Sohag 1-2 and Qena 1. Fayoum (GZ6) and Beni Suef (UE9) sit
  // in the GIZA region until 2026-09-01 — and he named both, by name, as Upper Egypt on the same
  // day he gave this rule. A region-code read drops exactly the two areas he was thinking of.
  const augustUpperEgypt = upperEgyptAreasFor(PEDIA_REGIONS);
  assert.deepEqual(
    [...augustUpperEgypt].sort(),
    ["GZ6", "UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7", "UE9"],
    "nine Upper Egypt areas in play for August — Fayoum and Beni Suef among them",
  );
  assert.ok(
    (PEDIA_REGIONS.areasByRegion.get("GZ") ?? new Set<string>()).has("GZ6"),
    "Fayoum's own region code in August is GZ, which is why the named list exists",
  );
  assert.equal(augustUpperEgypt.has("UE8"), false, "Qena 2 is parked in Others for August");
  assert.equal(augustUpperEgypt.has("OT6"), false, "and so is Luxor");
  assert.equal(augustUpperEgypt.has("OT7"), false, "Aswan is not Upper Egypt for this rule at all");

  // September, where Qena 2 and Luxor leave Others: the same code answers 11 with no edit.
  const septemberOthers = new Set([...PEDIA_OTHERS].filter((a) => a !== "UE8" && a !== "OT6"));
  const septemberUpperEgypt = upperEgyptAreasFor({
    areasByRegion: new Map<string, ReadonlySet<string>>([
      ["UE-1", new Set(["GZ6", "UE9", "UE1", "UE2", "UE3", "UE4"])],
      ["UE-2", new Set(["UE5", "UE6", "UE7", "UE8", "OT6"])],
    ]),
    others: septemberOthers,
  });
  assert.equal(septemberUpperEgypt.size, 11, "eleven from September — Qena 2 and Luxor have joined");
  assert.ok(septemberUpperEgypt.has("OT6") && septemberUpperEgypt.has("UE8"));

  // ── STEP 1 — up to 200 packs stays in the governorate ─────────────────────────────────────────
  //
  // "وليس له علاقه بتوزيع الجمهورية" — nothing to do with the national spread. Benha is chosen
  // because it is NOT in Upper Egypt, so step 1 is visible on its own here.
  const small = splitTargetsFor(row({ qty: 200 }), 200, PEDIA_REGIONS);
  assert.ok(small);
  assert.deepEqual(
    [...small.areas].sort(),
    ["CA1", "CA2", "CA3", "CA4", "CA6", "D11"],
    "200 packs reaches Qalubeya and the five live Cairo areas, and stops there",
  );
  assert.equal(small.awayAreas.length, 0, "no national half at all");
  assert.equal(small.weights, undefined, "and nothing redistributed it afterwards");
  const smallShares = planShares(small, 200);
  assert.equal(
    new Set(smallShares.map(round)).size,
    1,
    "the block divides EVENLY — this is where a 75/25 would show up",
  );

  // 201 is the first pack that crosses the country. Asserted against the constant, not the literal.
  const atThreshold = splitTargetsFor(
    row({ qty: 201 }), WAREHOUSE_NATIONAL_SPLIT_THRESHOLD_QTY + 1, PEDIA_REGIONS,
  );
  assert.ok(atThreshold);
  assert.equal(atThreshold.areas.length, IN_PLAY, "one pack over 200 and the whole country is in");

  // ── STEP 2 — 201 to 999, half home and half over the rest of the country ─────────────────────
  const plan = splitTargetsFor(row(), 700, PEDIA_REGIONS);
  assert.ok(plan, "an El Qema Pedia row always has a plan");
  assert.equal(plan.areas.length, IN_PLAY, "it reaches every area in play, and only those");
  assert.equal(new Set(plan.areas).size, plan.areas.length, "and no area appears twice");
  for (const area of PEDIA_OTHERS) {
    assert.equal(plan.areas.includes(area), false, `${area} is in Others and takes nothing`);
  }

  const shares = planShares(plan, 700);
  assert.equal(
    shares.reduce((sum, share) => sum + share, 0),
    700,
    "the shares sum back to the row EXACTLY",
  );

  // 🔴 Against the independent derivation, area by area — the whole rule in one assertion.
  const expected = referenceQemaShares("D11", 700, 700, PEDIA_OTHERS);
  assert.equal(plan.areas.length, expected.size, "the engine reaches the areas his words reach");
  plan.areas.forEach((area, index) => {
    assert.equal(
      round(shares[index]),
      round(expected.get(area) ?? Number.NaN),
      `${area} takes what his three steps plus the Upper Egypt pass give it`,
    );
  });

  // ── The shape of that answer, stated in words so a reader can check it by eye ─────────────────
  const at = (code: string) => shares[plan.areas.indexOf(code)];
  assert.equal(round(at("CA1")), round(at("D11")), "Benha keeps no more of its own sale than Cairo");
  assert.equal(round(at("AB1")), round(at("D21")), "and the national half is flat outside Upper Egypt");
  assert.ok(at("D11") > at("AB1"), "the governorate half is real — home beats away");

  // 🔴 THE UPPER EGYPT PASS TAKES MONEY OUT OF UPPER EGYPT, and that is the point of it. Half of
  // what the bands credited there is handed back to Upper Egypt and half to the whole country, so
  // an Upper Egypt area ends BELOW an ordinary away area. Reading the rule as a top-up for Upper
  // Egypt is the misreading to expect, and this assertion is what fails when someone acts on it.
  assert.ok(
    at("UE1") < at("AB1"),
    `Minia ends below Alexandria (${round(at("UE1"))} vs ${round(at("AB1"))})`,
  );
  assert.equal(round(at("UE1")), round(at("GZ6")), "and every Upper Egypt area lands on the same number");
  assert.equal(round(at("UE9")), round(at("UE7")), "Beni Suef included, though August files it under Giza");

  // ── STEP 3 — 1,000 and above spreads flat, and NOT over Others ────────────────────────────────
  const flat = splitTargetsFor(row({ qty: 6_000 }), 6_000, PEDIA_REGIONS);
  assert.ok(flat);
  const flatShares = planShares(flat, 6_000);
  const flatAt = (code: string) => flatShares[flat.areas.indexOf(code)];
  assert.equal(flat.areas.length, IN_PLAY, "still 37 — 'وليس Others'");
  assert.equal(
    round(flatAt("D11")),
    round(flatAt("AB1")),
    "Qalubeya and Alexandria take the same share: the origin's governorate stops mattering at 1,000",
  );
  assert.equal(
    new Set(flat.areas.filter((a) => !augustUpperEgypt.has(a)).map((a) => round(flatAt(a)))).size,
    1,
    "every area outside Upper Egypt takes exactly the same share",
  );
  assert.ok(flatAt("UE1") < flatAt("AB1"), "and Upper Egypt is levelled down by the second rule");
  assert.equal(
    flatShares.reduce((sum, share) => sum + share, 0),
    6_000,
    "flat still sums back exactly",
  );

  // ── 🔴 THE UPPER EGYPT PASS RUNS IN EVERY BAND, INCLUDING THE FIRST ───────────────────────────
  //
  // "كل البيع اللي محسوب للصعيد" — ALL of it. A 100-pack Minia warehouse is a step-1 sale that
  // step 1 alone would keep inside Minia; his second rule then takes it national. That looks like a
  // contradiction with step 1 and is not: it is the second rule acting on the first rule's output.
  const minia = splitTargetsFor(
    row({ areaCode: "UE1", clientCode: "QM-9004", qty: 100 }), 100, PEDIA_REGIONS,
  );
  assert.ok(minia);
  assert.equal(minia.areas.length, IN_PLAY, "a 100-pack Upper Egypt sale still reaches the country");
  const miniaShares = planShares(minia, 100);
  const miniaExpected = referenceQemaShares("UE1", 100, 100, PEDIA_OTHERS);
  minia.areas.forEach((area, index) => {
    assert.equal(
      round(miniaShares[index]),
      round(miniaExpected.get(area) ?? Number.NaN),
      `${area} matches the independent derivation for a step-1 Upper Egypt sale`,
    );
  });
  assert.equal(
    miniaShares.reduce((sum, share) => sum + share, 0),
    100,
    "and it still sums back exactly",
  );
  const miniaAt = (code: string) => miniaShares[minia.areas.indexOf(code)];
  assert.ok(miniaAt("UE1") > miniaAt("AB1"), "Minia still keeps the most of its own small sale");
  assert.equal(round(miniaAt("UE1")), round(miniaAt("UE2")), "shared evenly with the rest of Upper Egypt");

  // A non-Upper-Egypt step-1 sale is NOT touched by the pass — the guard that makes it cheap.
  assert.equal(small.weights, undefined, "a Benha step-1 sale never enters the redistribution");

  // ── An origin sitting in Others keeps its own sale, and receives nothing else ─────────────────
  const fromOthers = splitTargetsFor(
    row({ areaCode: "OT9", clientCode: "QM-9003", qty: 100 }), 100, PEDIA_REGIONS,
  );
  assert.ok(fromOthers, "a warehouse in an Others area still has a plan");
  assert.deepEqual(
    [...fromOthers.areas],
    ["OT9"],
    "Ismailia keeps what it sold itself and no Others area receives anyone else's money",
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

  // ── 🔒 THE LEAD GUARANTEE — Qalubeya, Tanta and Mahalla must top the contribution table ───
  //
  // Owner, twice: inside the ruling itself and again when the first build reported them 22nd, 20th
  // and 21st instead of making it so. "لابد" is a requirement. It is the only part of this rule
  // stated as an outcome, so it is enforced as one, once, over the whole month.
  assert.deepEqual(
    QEMA_LEAD_TIERS.map((tier) => [...tier]),
    [["D11"], ["D14", "D15"]],
    "Qalubeya alone on top, Tanta and Mahalla level behind it — \"Qalubeya number 1\"",
  );
  assert.deepEqual([...QEMA_LEAD_AREAS], ["D11", "D14", "D15"], "flattened, in rank order");
  assert.equal(QEMA_LEAD_STEP, 0.02, "one step between tiers, and above the field");

  // A book shaped like August's: one huge band-3 warehouse in Qalubeya, and a band-1 city sale in
  // Alexandria, which is what actually led the table before this existed.
  const book = [
    row({ clientCode: "QM-BENHA", qty: 6_000, salesValue: 1_620_000 }),
    row({ areaCode: "AB3", clientCode: "QM-ALEX", qty: 252, salesValue: 68_040 }),
    row({ areaCode: "UE5", clientCode: "QM-SOHAG", qty: 480, salesValue: 129_600 }),
  ];
  const bookQty = book.reduce((sum, r) => sum + r.qty, 0);
  const bookValue = book.reduce((sum, r) => sum + r.salesValue, 0);
  const led = splitStoreSalesAcrossCityAreas(book, "2026-09", PEDIA_REGIONS);

  const landedQty = new Map<string, number>();
  const landedValue = new Map<string, number>();
  for (const r of led.rows) {
    landedQty.set(r.areaCode, (landedQty.get(r.areaCode) ?? 0) + r.qty);
    landedValue.set(r.areaCode, (landedValue.get(r.areaCode) ?? 0) + r.salesValue);
  }

  // 🔴 THE MONEY IS UNCHANGED. A guarantee that quietly created or destroyed packs would be caught
  // by phx_write_monthly_store_split_net refusing the payload; this catches it first.
  assert.equal(
    Number([...landedQty.values()].reduce((sum, q) => sum + q, 0).toFixed(6)),
    bookQty,
    "the guarantee moves money between areas and changes no total",
  );
  assert.equal(
    Number([...landedValue.values()].reduce((sum, v) => sum + v, 0).toFixed(6)),
    bookValue,
    "value likewise",
  );

  const others = [...landedQty].filter(([area]) => !QEMA_LEAD_AREAS.includes(area));
  const topOther = Math.max(...others.map(([, qty]) => qty));
  for (const area of QEMA_LEAD_AREAS) {
    assert.ok(
      (landedQty.get(area) ?? 0) > topOther,
      `${area} finishes above every other area (${landedQty.get(area)} vs ${topOther})`,
    );
  }
  // 🔒 QALUBEYA NUMBER 1, and the pair level behind it. Three assertions rather than one,
  // because "all three on top" and "Qalubeya on top" are different requirements and the first
  // build delivered only the first.
  assert.ok(
    (landedQty.get("D11") ?? 0) > (landedQty.get("D14") ?? 0),
    "Qalubeya finishes above Tanta",
  );
  assert.equal(
    round(landedQty.get("D14") ?? 0),
    round(landedQty.get("D15") ?? 0),
    "Tanta and Mahalla finish level with each other, never one behind the other",
  );
  assert.equal(
    round((landedQty.get("D11") ?? 0) / (landedQty.get("D14") ?? 1)),
    round(1 + QEMA_LEAD_STEP),
    "and Qalubeya clears them by exactly one step",
  );

  // 🔴 THE STEP IS MEASURED AFTER THE MONEY MOVES. Taking it against the field BEFORE the take
  // overshoots, because paying the three shrinks the area they had to beat — measured on August it
  // put them 5.4% clear when he asked for a very small scale. This is the assertion that fails if
  // the fixed point is ever "simplified" back to one pass.
  assert.equal(
    round((landedQty.get("D14") ?? 0) / topOther),
    round(1 + QEMA_LEAD_STEP),
    "the bottom tier clears the field by exactly one step, measured on the final numbers",
  );
  assert.equal(
    round((landedQty.get("D11") ?? 0) / topOther),
    round((1 + QEMA_LEAD_STEP) ** 2),
    "and Qalubeya by two — the ladder is measured after the money moves, not before",
  );

  // Against the closed-form solution, area by area — algebra against the shipped iteration.
  const beforeLead = new Map<string, number>();
  for (const r of book) {
    const plan = splitTargetsFor(r, r.qty, PEDIA_REGIONS);
    assert.ok(plan);
    planShares(plan, r.qty).forEach((share, index) => {
      const area = plan.areas[index];
      beforeLead.set(area, (beforeLead.get(area) ?? 0) + share);
    });
  }
  const expectedLed = referenceQemaLead(beforeLead);
  for (const [area, qty] of expectedLed) {
    assert.equal(
      round(landedQty.get(area) ?? 0),
      round(qty),
      `${area} lands where the closed form puts it`,
    );
  }

  // The areas that pay for it keep their order and their proportions — one factor for everyone.
  const ratios = others.map(([area, qty]) => round(qty / (beforeLead.get(area) ?? 1)));
  assert.equal(new Set(ratios).size, 1, "every other area is scaled by the SAME factor, never picked off");

  // ── 🔴 THE DETAIL SHEET AND THE MATRIX DESCRIBE ONE OPERATION ─────────────────────────────────
  //
  // The Store Split Detail sheet used to re-derive the band from a quantity of its own. With the
  // Upper Egypt redistribution no quantity implies the answer, so it now reads the same plan. This
  // asserts the reconciliation directly: the home block's shares plus the away block's shares are
  // the whole sale, measured off the sheet's own published columns.
  const detail = detailStoreSplitByCustomer(
    [{ ...row(), areaName: "Qalubeya", productName: "Lacto Advanced 1" }],
    "2026-09",
    PEDIA_REGIONS,
  );
  assert.equal(detail.length, 1, "one detail row for one customer and product");
  const [entry] = detail;
  const parts = entry.homeAreaCodes.length + entry.awayAreaCodes.length;
  const rebuilt = entry.shareValue * entry.homeAreaCodes.length
    + entry.awayShareValue * entry.awayAreaCodes.length;
  assert.ok(
    Math.abs(rebuilt - entry.value) <= parts * 0.005,
    `the sheet's own blocks add back to the sale the Matrix divided (${rebuilt} vs ${entry.value})`,
  );
  assert.equal(
    entry.originKeepsValue,
    Number(((189_000 * (expected.get("D11") ?? 0)) / 700).toFixed(2)),
    "and what it says Qalubeya keeps is what Qalubeya actually keeps",
  );

  // ── 🔒 EL QEMA IS PEDIA ONLY — owner golden rule, 2026-09-08, in those words ─────────────────
  //
  // Their whole book is Lacto Advanced 1 and 2, both Pedia. An El Qema row arriving on another line
  // falls back to the plain city split, which also keeps every one of these rules off the published
  // August Anti Infective — bands, block and the Upper Egypt pass alike.
  for (const line of ["CNS", "Anti Infective"]) {
    const otherLine = splitTargetsFor(row({ officialLine: line }), 5_000, PEDIA_REGIONS);
    assert.ok(otherLine, `El Qema on ${line} still resolves a plan`);
    assert.deepEqual(
      [...otherLine.areas],
      ["D11"],
      `${line} falls back to Qalubeya's ordinary one-area city split, never the bands`,
    );
    const upperEgyptElsewhere = splitTargetsFor(
      row({ areaCode: "UE1", officialLine: line, qty: 5_000 }), 5_000, PEDIA_REGIONS,
    );
    assert.ok(upperEgyptElsewhere);
    assert.deepEqual(
      [...upperEgyptElsewhere.areas].sort(),
      ["UE1", "UE2"],
      `and an Upper Egypt warehouse on ${line} takes the plain Minia city split, never the redistribution`,
    );
  }

  // Another distributor on Pedia never reaches any of this either.
  const otherDistributor = splitTargetsFor(
    row({ areaCode: "UE1", clientCode: "IS-1", distributorCode: "IS-S", qty: 5_000 }),
    5_000,
    PEDIA_REGIONS,
  );
  assert.ok(otherDistributor);
  assert.deepEqual([...otherDistributor.areas].sort(), ["UE1", "UE2"], "the rules are El Qema's alone");

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
