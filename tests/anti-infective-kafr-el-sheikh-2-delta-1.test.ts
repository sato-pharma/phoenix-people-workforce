import assert from "node:assert/strict";

import {
  buildOperationalRegionMap,
  closingRegionsAsOfDate,
  othersAreasFrom,
  splitRegionsFrom,
} from "../src/lib/sales/closing-organogram-regions.ts";
import {
  CITY_AREAS,
  OTHERS_EXCLUDED_LINES,
  planShares,
  splitTargetsFor,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * 🔒 KAFR EL-SHEIKH 2 COUNTS TO DINA FADEL THE MANAGER, NEVER TO RAGAA THE REP — owner, 2026-10-15:
 *
 *   "doinot count kafr el sheikh 2 store splitting to ragaa the rep count it to din a fadel the
 *    manager only"
 *
 * Kafr El-Sheikh is ONE city with two areas in the split map, so every wholesaler there divides
 * 50/50 between Kafr El-Sheikh 1 (D16) and Kafr El-Sheikh 2 (D17). D16 is Dina Fadel's
 * (SEAT-AIF-DM-D1) and her rep there is Ragaa Mosaad (B-107, SEAT-AIF-REP-D16). D17 sat in the
 * line's Others bucket under the SEAT-AIF-OTHERS pseudo-DM, so half her own city's wholesaler money
 * reached no manager at all.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE FIRST ANSWER WAS THE WRONG SHAPE. #5926 refused D17 a share of the
 * split, which put the WHOLE city on D16 — and therefore all of it on Ragaa's rep number, the exact
 * opposite of the ruling. The fix is the ORGANOGRAM, not the split: D17 joins Delta (1) under
 * SEAT-AIF-DM-D1 from 2026-10-01 with no rep seat and no target, so her district reads both halves
 * while no rep is credited with the second one. See
 * 20261015145000_anti_infective_kafr_el_sheikh_2_to_delta_1_from_october.sql.
 *
 * 🔴 SO THE MONEY ASSERTION IS AN EQUALITY, AND IT IS THE POINT OF THE FILE: the Kafr El-Sheikh
 * split must stay 50/50 before and after the move. A future session that "tidies" the ruling back
 * into a split exclusion — any named-area set, any Others carve-out on this line — takes D17's half
 * and hands it to Ragaa, and that is what the shares below catch.
 *
 * Dates are the second half. July, August and September 2026 are PUBLISHED on all three lines and a
 * published month is never changed (owner, 2026-10-09), so the move is written as a dated pair and
 * September must still answer Others however late it is recomputed.
 */

/** The area that moves, the bucket it leaves, the district it joins, and the day it happens. */
const MOVER = "D17";
const LEAVES = "OT";
const JOINS = "D1";
const MOVE_DATE = "2026-10-01";

/** Ragaa's own area — the one that must not gain a pound of this. */
const RAGAAS_AREA = "D16";

/**
 * Anti Infective's organogram across the boundary, as production holds it at 2026-10-31:
 * `[area, September, October]`. Read from au.f_line_area_map_asof, not invented.
 */
const ORGANOGRAM: ReadonlyArray<readonly [area: string, september: string, october: string]> = [
  ["AB1", "AB", "AB"], ["AB2", "AB", "AB"], ["AB3", "AB", "AB"], ["AB4", "AB", "AB"], ["AB5", "AB", "AB"],
  ["CA1", "CA", "CA"], ["CA2", "CA", "CA"], ["CA3", "CA", "CA"], ["CA4", "CA", "CA"], ["CA6", "CA", "CA"],
  // Delta (1) is Dina Fadel's: Menoufia 1-2, Gharbia 1-2 and Kafr El-Sheikh 1 — five today, six from October.
  ["D12", "D1", "D1"], ["D13", "D1", "D1"], ["D14", "D1", "D1"], ["D15", "D1", "D1"],
  [RAGAAS_AREA, "D1", "D1"],
  [MOVER, LEAVES, JOINS], // ← Kafr El-Sheikh 2, the move under test
  ["D21", "D2", "D2"], ["D22", "D2", "D2"], ["D23", "D2", "D2"], ["D26", "D2", "D2"],
  // Delta (3), Anti Infective only, live since 2026-09-01.
  ["D11", "D3", "D3"], ["D24", "D3", "D3"], ["D25", "D3", "D3"], ["OT2", "D3", "D3"], ["OT9", "D3", "D3"],
  ["GZ1", "GZ", "GZ"], ["GZ2", "GZ", "GZ"], ["GZ3", "GZ", "GZ"], ["GZ4", "GZ", "GZ"], ["GZ5", "GZ", "GZ"],
  ["GZ6", "GZ", "GZ"],
  ["UE1", "UE-1", "UE-1"], ["UE2", "UE-1", "UE-1"], ["UE9", "UE-1", "UE-1"],
  ["UE3", "UE-2", "UE-2"], ["UE4", "UE-2", "UE-2"], ["UE5", "UE-2", "UE-2"], ["UE6", "UE-2", "UE-2"],
  ["UE7", "UE-2", "UE-2"], ["UE8", "UE-2", "UE-2"],
  // Others keeps everything else, Kafr El-Sheikh 2 aside.
  ["CA5", "OT", "OT"], ["GZ7", "OT", "OT"], ["OT1", "OT", "OT"], ["OT4", "OT", "OT"], ["OT5", "OT", "OT"],
  ["OT6", "OT", "OT"], ["OT7", "OT", "OT"], ["OT8", "OT", "OT"], ["OT10", "OT", "OT"],
];

/**
 * OT3 "Aswan (Legacy)", retired 2026-07-27. Carried for the same reason the Pedia move's fixture
 * carries it: `au.f_line_area_map_asof` reports a retired area in its last region for ever while
 * `buildOperationalRegionMap` drops it, and a fixture without it would hide that disagreement.
 */
const RETIRED_AREA = {
  area_code: "OT3",
  operational_region_code: "OT",
  effective_from: "2026-07-13",
  effective_to: "2026-07-27",
};

const regionNames = () =>
  new Map([
    ["AB", "Alex-BHR"],
    ["CA", "Cairo"],
    ["D1", "Delta (1)"],
    ["D2", "Delta (2)"],
    ["D3", "Delta (3)"],
    ["GZ", "Giza"],
    ["OT", "Others"],
    ["UE-1", "Upper Egypt 1"],
    ["UE-2", "Upper Egypt 2"],
  ]);

/** Every row except Kafr El-Sheikh 2's pair — the organogram with this move NOT yet written. */
const withoutTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.map(([area, september, october]) => ({
    area_code: area,
    operational_region_code: area === MOVER ? LEAVES : september,
    effective_from: "2026-07-13",
    effective_to: null as string | null,
  })).filter(() => true),
  ...ORGANOGRAM.flatMap(([area, september, october]) =>
    area !== MOVER && september !== october
      ? [{ area_code: area, operational_region_code: october, effective_from: MOVE_DATE, effective_to: null }]
      : []),
];

/** The same organogram after the migration: Kafr El-Sheikh 2 written as a dated pair. */
const withTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.flatMap(([area, september, october]) =>
    september === october
      ? [{ area_code: area, operational_region_code: september, effective_from: "2026-07-13", effective_to: null }]
      : [
        { area_code: area, operational_region_code: september, effective_from: "2026-07-13", effective_to: MOVE_DATE },
        { area_code: area, operational_region_code: october, effective_from: MOVE_DATE, effective_to: null },
      ]),
];

/**
 * ايةام جروب's real September order, as production holds it: 290 packs of Saginko sold by a
 * wholesaler sitting in Kafr El-Sheikh 1. It is the row that moved EGP 24,709.25 in the measurement
 * the owner was shown, so it is the row the shares are asserted on.
 */
const WHOLESALER_ROW: StoreSplitRow = {
  areaCode: RAGAAS_AREA,
  clientCode: "AIF-KFS-9001",
  clientName: "ايةام جروب للاستثمار وتجارة الادوية",
  distributorCode: "EPDA",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Anti Infective",
  productCode: "SA001",
  qty: 290,
  salesValue: 32_233.5,
};

const membership = (
  map: ReturnType<typeof buildOperationalRegionMap>,
  code: string,
) =>
  [...(map?.regionByArea ?? new Map())]
    .filter(([, region]) => region.regionCode === code)
    .map(([area]) => area)
    .sort();

const planFor = (map: Parameters<typeof splitRegionsFrom>[0]) =>
  splitTargetsFor(WHOLESALER_ROW, 290, splitRegionsFrom(map));

export function runAntiInfectiveKafrElSheikh2Delta1Tests() {
  // ── The dates the two months resolve at ───────────────────────────────────────────────────────
  // effective_to is EXCLUSIVE, so a row closed on 2026-10-01 still covers 2026-09-30 and does not
  // cover 2026-10-01. Getting this one day wrong reaches a PUBLISHED month.
  assert.equal(closingRegionsAsOfDate("2026-09"), "2026-09-30", "September resolves at its own last day");
  assert.equal(closingRegionsAsOfDate("2026-10"), "2026-10-31", "October resolves at its own last day");

  const september = buildOperationalRegionMap(withTheMove(), "2026-09-30", regionNames());
  const october = buildOperationalRegionMap(withTheMove(), "2026-10-31", regionNames());

  // ── The move itself ───────────────────────────────────────────────────────────────────────────
  assert.equal(
    september?.regionByArea.get(MOVER)?.regionCode,
    LEAVES,
    "September 2026 must still file Kafr El-Sheikh 2 in Others — it is PUBLISHED and the move is dated to spare it",
  );
  assert.equal(
    october?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "October 2026 files Kafr El-Sheikh 2 under Delta (1) — Dina Fadel's district",
  );
  assert.equal(
    october?.regionByArea.get(MOVER)?.regionName,
    "Delta (1)",
    "the district reaches the screen by NAME, never as a raw code",
  );

  // ── Her district's membership, stated in full ─────────────────────────────────────────────────
  assert.deepEqual(
    membership(september, "D1"),
    ["D12", "D13", "D14", "D15", "D16"],
    "September's Delta (1) is Menoufia 1 and 2, Gharbia 1 and 2, and Kafr El-Sheikh 1",
  );
  assert.deepEqual(
    membership(october, "D1"),
    ["D12", "D13", "D14", "D15", "D16", "D17"],
    "October's Delta (1) is those five plus Kafr El-Sheikh 2",
  );
  assert.equal(
    othersAreasFrom(september).has(MOVER),
    true,
    "September: Kafr El-Sheikh 2 is still in the Others bucket",
  );
  assert.equal(
    othersAreasFrom(october).has(MOVER),
    false,
    "October: it has left Others, which is what lets her district total read it",
  );

  // ── 🔒 THE MONEY: the split stays 50/50, before and after ─────────────────────────────────────
  // This is the assertion that fails if anyone answers the ruling with a split exclusion again, as
  // #5926 did. An exclusion would leave ONE area in the plan and hand all 290 packs to Ragaa.
  assert.deepEqual(
    CITY_AREAS.get("Kafr El-Sheikh"),
    [RAGAAS_AREA, MOVER],
    "Kafr El-Sheikh is one city holding both areas — the split map is untouched by the move",
  );

  ([["September", september], ["October", october]] as const).forEach(([label, map]) => {
    const plan = planFor(map);
    assert.ok(plan, `${label}: the Kafr El-Sheikh wholesaler resolves a split plan`);
    assert.deepEqual(
      [...plan!.areas].sort(),
      [RAGAAS_AREA, MOVER],
      `${label}: both Kafr El-Sheikh areas take a share — Kafr El-Sheikh 2 must reach the plan`,
    );
    assert.deepEqual(
      planShares(plan!, 290),
      [145, 145],
      `${label}: 290 packs divide 145/145 — Ragaa's area keeps HALF, never the whole city`,
    );
  });

  // The equality, said as an equality: writing the pair changes no share in either month.
  ([["September", "2026-09-30"], ["October", "2026-10-31"]] as const).forEach(([label, asOf]) => {
    const before = buildOperationalRegionMap(withoutTheMove(), asOf, regionNames());
    const after = buildOperationalRegionMap(withTheMove(), asOf, regionNames());
    assert.deepEqual(
      planShares(planFor(after)!, 290),
      planShares(planFor(before)!, 290),
      `${label}: the Kafr El-Sheikh split is byte-identical with the move written and without it`,
    );
    assert.equal(
      planShares(planFor(after)!, 290).reduce((sum, share) => sum + share, 0),
      290,
      `${label} hands back every pack exactly`,
    );
  });

  // ── Why the organogram is the mechanism and the split is not ──────────────────────────────────
  // Anti Infective never divided by the Others set in the first place: the line-level exclusion
  // holds Pedia alone, which is why D17 was receiving a half with no manager, and why moving the
  // AREA is the only thing that can change which manager reads it.
  assert.deepEqual(
    [...OTHERS_EXCLUDED_LINES].sort(),
    ["pedia"],
    "the Others exclusion is Pedia's alone — adding this line would move El Qema's divisor and strip D17's share",
  );
  assert.equal(
    OTHERS_EXCLUDED_LINES.has("anti infective"),
    false,
    "Anti Infective must never join it: that is the #5926 shape, and it pays Ragaa the whole city",
  );

  // ── The boundary day, from both sides ─────────────────────────────────────────────────────────
  assert.equal(
    buildOperationalRegionMap(withTheMove(), "2026-09-30", regionNames())?.regionByArea.get(MOVER)?.regionCode,
    LEAVES,
    "30 September: Kafr El-Sheikh 2 is still in Others",
  );
  assert.equal(
    buildOperationalRegionMap(withTheMove(), MOVE_DATE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "1 October: Kafr El-Sheikh 2 is Delta (1)",
  );

  // ── September's answer cannot depend on October's rows existing ───────────────────────────────
  // The assertion that would have caught the Delta (3) defect of 2026-08-29, where a dated pair
  // written correctly was still invisible to the closing and silently re-filed the month.
  assert.equal(
    buildOperationalRegionMap(withTheMove(), "2026-09-30", regionNames())?.regionByArea.get(MOVER)?.regionCode,
    buildOperationalRegionMap(withoutTheMove(), "2026-09-30", regionNames())?.regionByArea.get(MOVER)?.regionCode,
    "Kafr El-Sheikh 2 answers the same for September with the move written as without it",
  );

  // ── Row order cannot decide any of it ─────────────────────────────────────────────────────────
  // PostgREST returns these unordered, and the moved area now has two rows.
  ["2026-09-30", "2026-10-31"].forEach((asOf) => {
    const forward = buildOperationalRegionMap(withTheMove(), asOf, regionNames());
    const reversed = buildOperationalRegionMap([...withTheMove()].reverse(), asOf, regionNames());
    assert.equal(
      reversed?.regionByArea.get(MOVER)?.regionCode,
      forward?.regionByArea.get(MOVER)?.regionCode,
      `row order must not change Kafr El-Sheikh 2's ${asOf} answer`,
    );
  });

  // ── Ragaa's own area never moves ──────────────────────────────────────────────────────────────
  ([["September", september], ["October", october]] as const).forEach(([label, map]) => {
    assert.equal(
      map?.regionByArea.get(RAGAAS_AREA)?.regionCode,
      "D1",
      `${label}: Kafr El-Sheikh 1 stays in Delta (1) — only the district reading D17 changes`,
    );
  });
}
