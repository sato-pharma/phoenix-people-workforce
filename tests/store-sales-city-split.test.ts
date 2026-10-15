import assert from "node:assert/strict";

import {
  AREA_CITY,
  CITY_AREAS,
  cityOfArea,
  evenShares,
  excludedSplitAreasFor,
  isSplitEligible,
  isSplitEligibleLine,
  splitStoreSalesAcrossCityAreas,
  summariseStoreSplitByArea,
  type SplitRegions,
} from "../src/lib/sales/store-sales-city-split.ts";

type Row = {
  areaCode: string;
  areaName?: string;
  clientCode: string;
  clientName: string;
  includedInClosing: boolean;
  isDirect: boolean;
  officialLine: string;
  productCode: string;
  qty: number;
  salesValue: number;
};

/**
 * One code per customer NAME, so the fixture's six differently-named shops are six customers.
 *
 * They used to share a single literal "TEST-CODE". That is not a neutral placeholder: a customer
 * whose rows sit in more than one area counts as already apportioned by hand and is exempt from the
 * city split (customersExemptFromCitySplit). One code across Menoufia, Alexandria and Cairo
 * therefore exempted the ENTIRE fixture, and every split assertion below read zero — splitRowCount
 * came back 0 instead of 3. A test can still pass its own explicit code to model one chain trading
 * in two places.
 */
function row(overrides: Partial<Row> = {}): Row {
  const base = {
    areaCode: "D12",
    areaName: "Menoufia 1",
    clientName: "مخزن الحجاز فارما",
    includedInClosing: true,
    isDirect: false,
    officialLine: "Pedia",
    productCode: "LA001",
    qty: 120,
    salesValue: 37_800,
    ...overrides,
  };
  return { ...base, clientCode: overrides.clientCode ?? `TEST-${base.clientName}` };
}

const sum = (rows: readonly Row[], key: "qty" | "salesValue") =>
  rows.reduce((total, entry) => total + entry[key], 0);

export function runStoreSalesCitySplitTests() {
  // The grouping the owner settled: 49 areas over 25 cities.
  assert.equal(AREA_CITY.size, 49, "49 areas — Aswan (Legacy) OT3 is retired and deliberately absent");
  assert.equal(CITY_AREAS.size, 25, "25 cities");
  assert.equal(cityOfArea("OT3"), null, "OT3 is not in the current line organogram, so it never splits");
  // The one genuine judgment call, resolved from au.line_area_map: GZ5 maps to GZ on all 3 lines.
  assert.equal(cityOfArea("GZ5"), "Giza", "Helwan-Maadi belongs to Giza per the line organogram, not Cairo");
  assert.deepEqual([...(CITY_AREAS.get("Alexandria") ?? [])], ["AB1", "AB2", "AB3"], "Alexandria is 3 areas, Behira excluded");
  assert.deepEqual([...(CITY_AREAS.get("Menoufia") ?? [])], ["D12", "D13"]);
  assert.equal(CITY_AREAS.get("Cairo")?.length, 6);
  assert.equal(CITY_AREAS.get("Giza")?.length, 6, "Giza gained Helwan-Maadi");
  assert.equal(cityOfArea("ab1"), "Alexandria", "area codes are matched case-insensitively");

  // Lines: the three rep lines split, Head Office never does.
  for (const line of ["Pedia", "CNS", "Anti Infective", "anti infective", "Anti-Infective", "  cns  "]) {
    assert.equal(isSplitEligibleLine(line), true, `"${line}" is a rep line and splits`);
  }
  assert.equal(isSplitEligibleLine("Head Office"), false, "Head Office is excluded — 93% of store value, handled later");
  assert.equal(isSplitEligibleLine(""), false);
  assert.equal(isSplitEligibleLine(null), false);

  // evenShares must sum back EXACTLY. These specific pairs are the ones where the obvious
  // implementation — push value/parts `parts` times — provably does NOT: e.g. 0.03 into 6 naively
  // sums to 0.030000000000000002. `parts` of 5 and 6 are real (Cairo and Giza are 6 areas), so
  // this is the case a future "simplification" would silently reintroduce.
  const REMAINDER_CASES = [[0.03, 6], [0.05, 6], [0.1, 6], [0.11, 5], [0.17, 6], [0.12, 6]] as const;
  for (const [total, parts] of REMAINDER_CASES) {
    const naive = Array.from({ length: parts }, () => total / parts).reduce((a, b) => a + b, 0);
    assert.notEqual(naive, total, `fixture check: ${total} into ${parts} must be a case the naive split gets wrong`);
    const shares = evenShares(total, parts);
    assert.equal(shares.length, parts);
    assert.equal(shares.reduce((a, b) => a + b, 0), total, `${total} into ${parts} shares must sum back exactly`);
  }
  for (const [total, parts] of [[100, 3], [37_800, 6], [1_612_618.33, 3]] as const) {
    assert.equal(evenShares(total, parts).reduce((a, b) => a + b, 0), total, `${total} into ${parts} sums back exactly`);
  }

  // Eligibility gates.
  assert.equal(isSplitEligible(row()), true, "a store, on a rep line, in a multi-area city, splits");
  assert.equal(isSplitEligible(row({ clientName: "صيدلية النور" })), false, "a pharmacy never splits");
  assert.equal(isSplitEligible(row({ officialLine: "Head Office" })), false, "Head Office never splits");
  assert.equal(isSplitEligible(row({ isDirect: true })), false, "direct rows carry no area and never split");
  assert.equal(isSplitEligible(row({ includedInClosing: false })), false, "an excluded row never splits");
  assert.equal(isSplitEligible(row({ areaCode: "ZZZ" })), false, "an unmapped area stays exactly where it is");
  assert.equal(isSplitEligible(row({ areaCode: "D11" })), false, "Qalubeya is a one-area city — nothing to move");

  // THE headline invariant: the split moves money, it never creates or destroys any.
  const mixed: Row[] = [
    row({ areaCode: "D12", productCode: "LA001", qty: 120, salesValue: 37_800 }),
    row({ areaCode: "D13", clientName: "الرساله فارم", productCode: "LA002", qty: 90, salesValue: 32_400 }),
    row({ areaCode: "AB2", clientName: "مخزن فاروس", officialLine: "CNS", productCode: "SA001", qty: 10, salesValue: 1_234.56 }),
    row({ areaCode: "AB1", clientName: "صيدلية النور", officialLine: "CNS", productCode: "SA001", qty: 5, salesValue: 999.99 }),
    row({ areaCode: "CA1", clientName: "مخزن النهضة", officialLine: "Head Office", productCode: "LB001", qty: 500, salesValue: 104_550 }),
    row({ areaCode: "", clientName: "مخزن مباشر", isDirect: true, productCode: "LA001", qty: 7, salesValue: 5_000 }),
  ];
  const split = splitStoreSalesAcrossCityAreas(mixed);
  // Each row's own shares sum back bit-exactly (asserted on evenShares above). Across rows the
  // comparison is to an epsilon, because summing the same money in a different ORDER is not
  // bit-identical in IEEE floating point — 1e-9 EGP is a billionth of a piastre, far below
  // anything that could reach a closing sheet.
  assert.ok(
    Math.abs(sum(split.rows, "salesValue") - sum(mixed, "salesValue")) < 1e-9,
    `total value must be preserved: ${sum(split.rows, "salesValue")} vs ${sum(mixed, "salesValue")}`,
  );
  assert.ok(
    Math.abs(sum(split.rows, "qty") - sum(mixed, "qty")) < 1e-9,
    "total units must be preserved",
  );
  assert.equal(split.splitRowCount, 3, "only the three eligible store rows moved");

  // The pharmacy, Head Office and direct rows pass through byte-for-byte.
  for (const original of [mixed[3], mixed[4], mixed[5]]) {
    assert.ok(
      split.rows.some((candidate) => candidate === original),
      `"${original?.clientName}" must pass through untouched, same object`,
    );
  }

  // A Menoufia store's Pedia sale lands half in Menoufia 1 and half in Menoufia 2.
  const menoufiaLA001 = split.rows.filter((r) => r.productCode === "LA001" && !r.isDirect);
  assert.equal(menoufiaLA001.length, 2, "Menoufia has 2 areas, so the row became 2 shares");
  assert.deepEqual(menoufiaLA001.map((r) => r.areaCode).sort(), ["D12", "D13"]);
  assert.equal(menoufiaLA001[0]?.salesValue, 18_900, "37,800 halved");
  assert.equal(menoufiaLA001[0]?.qty, 60);

  // Alexandria splits three ways, and the awkward decimal still reconciles.
  const alex = split.rows.filter((r) => r.productCode === "SA001" && r.clientName === "مخزن فاروس");
  assert.equal(alex.length, 3, "Alexandria is 3 areas");
  assert.deepEqual(alex.map((r) => r.areaCode).sort(), ["AB1", "AB2", "AB3"]);
  assert.equal(alex.reduce((a, b) => a + b.salesValue, 0), 1_234.56, "1,234.56 into 3 shares sums back exactly");

  // Net movement sums to zero inside every city — that is what "nothing is lost" means.
  const netByCity = new Map<string, number>();
  for (const movement of split.movements) {
    netByCity.set(movement.city, (netByCity.get(movement.city) ?? 0) + movement.inValue - movement.outValue);
  }
  for (const [city, net] of netByCity) {
    assert.ok(Math.abs(net) < 1e-9, `net movement inside ${city} must be zero, got ${net}`);
  }

  // A city with NO rep on a line still receives — the unit is the AREA, not the rep seat. This is
  // the whole reason for the design: Cairo has no Pedia rep anywhere, and a headcount divisor
  // would be zero and strand the money.
  const cairoPedia = splitStoreSalesAcrossCityAreas([
    row({ areaCode: "CA2", areaName: "Nasr City", clientName: "مخزن القاهرة", officialLine: "Pedia", qty: 60, salesValue: 6_000 }),
  ]);
  assert.equal(cairoPedia.rows.length, 6, "Cairo's 6 areas each take a share even with no Pedia rep");
  assert.equal(sum(cairoPedia.rows, "salesValue"), 6_000, "nothing is stranded");
  assert.ok(cairoPedia.rows.every((r) => r.salesValue === 1_000), "6,000 across 6 areas is 1,000 each");

  // The summary the Store Split sheet renders: before + net = after, per area and line.
  const summary = summariseStoreSplitByArea(mixed);
  const d12 = summary.find((entry) => entry.areaCode === "D12" && entry.line === "Pedia");
  assert.ok(d12, "Menoufia 1 appears in the summary");
  assert.equal(d12?.city, "Menoufia");
  assert.equal(d12?.movedOutValue, 37_800, "Menoufia 1's own store sale went out to the city");
  assert.equal(d12?.receivedValue, 35_100, "it received half of 37,800 plus half of 32,400");
  assert.equal(d12?.netValue, -2_700);
  assert.equal(Number((d12!.beforeValue + d12!.netValue).toFixed(2)), d12?.afterValue, "before + net = after");
  const alexSummary = summary.filter((entry) => entry.city === "Alexandria");
  assert.equal(
    Number(alexSummary.reduce((total, entry) => total + entry.netValue, 0).toFixed(2)),
    0,
    "Alexandria's areas net to zero between them",
  );
  // An area that never saw a store is not listed — there is nothing to say about it.
  assert.equal(summary.some((entry) => entry.areaCode === "UE5"), false);

  runKafrElSheikh2Tests();
}

/**
 * 🔒 THE KAFR EL-SHEIKH 2 RULE — owner, 2026-10-15: "only stores split in kafr el sheikh 2 count
 * her to dina fadel".
 *
 * Kafr El-Sheikh is one city with two areas, so its wholesalers divided 50/50 between Kafr
 * El-Sheikh 1 (Dina Fadel's, on Anti Infective) and Kafr El-Sheikh 2, which the line parks in
 * Others with no DM, no rep and no target — EGP 24,431.38 of her own city's wholesaler money
 * leaving her district in September 2026 alone. The fix reuses the Pedia Others-exclusion shape,
 * narrowed to this one area because he chose the narrow form over the whole-line one.
 *
 * Each assertion below is the rule, not the mechanism, so a later "tidy-up" of
 * excludedSplitAreasFor has to break a named owner ruling to go green.
 */
function runKafrElSheikh2Tests() {
  const aifOthers: SplitRegions = {
    areasByRegion: new Map(),
    // What the live Anti Infective organogram parks in Others, read 2026-10-15.
    others: new Set(["CA5", "D17", "GZ7", "OT1", "OT10", "OT4", "OT5", "OT6", "OT7", "OT8"]),
  };

  // 1. The set itself. Kafr El-Sheikh 2 is barred on Anti Infective — and ONLY Kafr El-Sheikh 2.
  //
  // 🔴 BOTH SPELLINGS, because they are the two the live data actually carries and they are not
  // the same string: `au.line_area_map` says `anti_infective` and `official_line` says
  // "Anti Infective". Asserting only the underscore passed while the split still divided 290 packs
  // 145/145 — the rule keyed on one spelling and the split loop asked with the other.
  for (const spelling of ["anti_infective", "Anti Infective", "anti infective", "ANTI-INFECTIVE"]) {
    assert.deepEqual(
      [...excludedSplitAreasFor(spelling, aifOthers)],
      ["D17"],
      `"${spelling}" must reach the Kafr El-Sheikh 2 rule — line spellings differ across the data`,
    );
  }
  const aifExcluded = excludedSplitAreasFor("anti_infective", aifOthers);
  for (const area of ["CA5", "GZ7", "OT5", "OT8"]) {
    assert.equal(
      aifExcluded.has(area),
      false,
      `${area} keeps its Anti Infective share — he chose Kafr El-Sheikh 2 alone over the whole line`,
    );
  }

  // 2. Pedia is untouched: the whole Others set, exactly as the 2026-09-08 ruling left it.
  assert.equal(
    excludedSplitAreasFor("pedia", aifOthers).size,
    aifOthers.others.size,
    "Pedia still excludes every Others area, whoever sold it",
  );

  // 3. CNS was offered and NOT chosen, so its Kafr El-Sheikh 2 share must survive.
  assert.equal(
    excludedSplitAreasFor("cns", { areasByRegion: new Map(), others: new Set(["D17"]) }).size,
    0,
    "CNS keeps splitting into Kafr El-Sheikh 2 — he declined that option",
  );

  // 4. 🔴 THE SELF-HEALING HALF. Give Kafr El-Sheikh 2 an Anti Infective seat and it leaves Others,
  // so it must start receiving its own half again with no code change. This is the assertion that
  // fails if anyone "simplifies" the organogram intersection into a hard-coded exclusion.
  //
  // 🔴 THE OTHERS SET HERE MUST STAY NON-EMPTY AND MUST NOT CONTAIN D17 — that is the whole point,
  // and it is the ONLY shape that reaches the intersection. Written first with an EMPTY set, this
  // assertion passed through the `others.size === 0` shortcut and stayed green with the
  // intersection deleted outright: it proved nothing. An empty set is also unrealistic — giving
  // Kafr El-Sheikh 2 a seat does not give one to Down town, October-Zayed or the six OT areas.
  const seatedOthers: SplitRegions = {
    areasByRegion: new Map(),
    others: new Set(["CA5", "GZ7", "OT1", "OT10", "OT4", "OT5", "OT6", "OT7", "OT8"]),
  };
  assert.equal(
    excludedSplitAreasFor("anti_infective", seatedOthers).size,
    0,
    "a Kafr El-Sheikh 2 that is no longer in Others receives its share again, with no code change",
  );
  // And it must divide again end to end, not merely drop out of the set.
  const reseated = splitStoreSalesAcrossCityAreas([{
    areaCode: "D16",
    areaName: "Kafr El-Sheikh 1",
    clientCode: "428612",
    clientName: "ايةام جروب للاستثمار وتجارةالادوية",
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 290,
    salesValue: 32_233.5,
  }], "2026-10", seatedOthers);
  assert.deepEqual(
    reseated.rows.map((entry) => entry.qty),
    [145, 145],
    "a seated Kafr El-Sheikh 2 takes its half of a Kafr El-Sheikh 1 wholesaler again",
  );
  assert.equal(
    excludedSplitAreasFor("anti_infective", { areasByRegion: new Map(), others: new Set() }).size,
    0,
    "an empty Others set excludes nothing either",
  );
  assert.equal(
    excludedSplitAreasFor("anti_infective", undefined).size,
    0,
    "no organogram loaded means split as before — never silently strip an area out",
  );

  // 5. End to end, on the real September 2026 shape: ايةام جروب's 290 packs of Saginko, invoiced in
  // Kafr El-Sheikh 1. Before the rule this was 145/145; now the whole sale stays with Dina Fadel.
  const ayam = {
    areaCode: "D16",
    areaName: "Kafr El-Sheikh 1",
    clientCode: "428612",
    clientName: "ايةام جروب للاستثمار وتجارةالادوية",
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 290,
    salesValue: 32_233.5,
  };
  const held = splitStoreSalesAcrossCityAreas([ayam], "2026-10", aifOthers);
  assert.equal(held.rows.length, 1, "the sale no longer divides — Kafr El-Sheikh 2 may not receive");
  assert.equal(held.rows[0]?.areaCode, "D16");
  assert.equal(held.rows[0]?.qty, 290, "all 290 packs stay with Kafr El-Sheikh 1");
  assert.equal(held.rows[0]?.salesValue, 32_233.5, "and all of the money with them");

  // 6. The same row with Kafr El-Sheikh 2 OUT of Others still divides 50/50 — proof that this
  // change is the exclusion and nothing else, and that the city grouping itself is untouched.
  const divided = splitStoreSalesAcrossCityAreas([ayam], "2026-10", {
    areasByRegion: new Map(),
    others: new Set(),
  });
  assert.equal(divided.rows.length, 2, "with a seat in Kafr El-Sheikh 2 the city splits as always");
  assert.deepEqual(divided.rows.map((entry) => entry.qty), [145, 145]);

  // 7. 🔴 THE ORIGIN IS NEVER BARRED FROM ITS OWN SALE — مخزن كابيتال sits IN Kafr El-Sheikh 2 and
  // sold 5 packs there, so it keeps half and sends half to Kafr El-Sheikh 1. An excluded area is
  // barred from receiving somebody else's money, never from keeping what it sold itself, exactly as
  // on Pedia. Without this a Kafr El-Sheikh 2 wholesaler's sale would have nowhere to go at all.
  const capital = splitStoreSalesAcrossCityAreas([{
    areaCode: "D17",
    areaName: "Kafr El-Sheikh 2",
    clientCode: "406161",
    clientName: "مخزن كابيتال",
    includedInClosing: true,
    isDirect: false,
    officialLine: "Anti Infective",
    productCode: "SA001",
    qty: 5,
    salesValue: 555.75,
  }], "2026-10", aifOthers);
  assert.equal(capital.rows.length, 2, "its own sale still reaches both halves of its city");
  assert.deepEqual(
    [...capital.rows].sort((a, b) => a.areaCode.localeCompare(b.areaCode)).map((e) => [e.areaCode, e.qty]),
    [["D16", 2.5], ["D17", 2.5]],
  );
}
