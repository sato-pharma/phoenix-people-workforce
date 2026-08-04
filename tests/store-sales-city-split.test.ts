import assert from "node:assert/strict";

import {
  AREA_CITY,
  CITY_AREAS,
  cityOfArea,
  evenShares,
  isSplitEligible,
  isSplitEligibleLine,
  splitStoreSalesAcrossCityAreas,
  summariseStoreSplitByArea,
} from "../src/lib/sales/store-sales-city-split.ts";

type Row = {
  areaCode: string;
  areaName?: string;
  clientName: string;
  includedInClosing: boolean;
  isDirect: boolean;
  officialLine: string;
  productCode: string;
  qty: number;
  salesValue: number;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
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
}
