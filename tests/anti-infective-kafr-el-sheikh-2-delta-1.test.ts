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
 * and, the same day, after reading the October shape:
 *
 *   "i want this change to be starting from july 2026 counted to her"
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
 * SEAT-AIF-DM-D1 with no rep seat and no target, so her district reads both halves while no rep is
 * credited with the second one. See
 * 20261015153000_anti_infective_kafr_el_sheikh_2_to_delta_1_from_july.sql, which re-dated the
 * boundary written by 20261015145000_…_from_october.sql.
 *
 * 🔴 SO THE MONEY ASSERTION IS AN EQUALITY, AND IT IS THE POINT OF THE FILE: the Kafr El-Sheikh
 * split must stay 50/50 before and after the move. A future session that "tidies" the ruling back
 * into a split exclusion — any named-area set, any Others carve-out on this line — takes D17's half
 * and hands it to Ragaa, and that is what the shares below catch.
 *
 * 🔴 THE BOUNDARY IS 2026-07-01 AND THE OTHERS ROW IS DATED BACK TO 2026-01-01 ON PURPOSE. Region is
 * resolved as of the END of the month being closed, and `au.f_line_area_map_asof` prefers the row
 * whose interval contains that date but otherwise FALLS BACK to the row with the smallest
 * `effective_from`. Leave the Others row on the map's own 2026-07-13 floor and the Delta (1) row
 * becomes the earliest row for this area — so January to June 2026, which match no interval, fall
 * back to IT and count to her as well. Those six months carry real sales (EGP 788.30 to 1,788.65 a
 * month) and carry NO publication row, so the nightly sweep would restate every one of them. The
 * January assertion below is that trap, not decoration.
 */

/** The area that moves, the bucket it leaves, the district it joins, and the day it happens. */
const MOVER = "D17";
const LEAVES = "OT";
const JOINS = "D1";
const MOVE_DATE = "2026-07-01";

/** The two months either side of the boundary, each resolved at its own last day. */
const BEFORE = "2026-06-30";
const AFTER = "2026-07-31";

/** Ragaa's own area — the one that must not gain a pound of this. */
const RAGAAS_AREA = "D16";

/**
 * How far back the mover's Others row reaches. Production holds 2026-01-01, early enough to stay the
 * EARLIEST row for this area and so to keep every pre-July month in Others.
 */
const PRE_MOVE_FROM = "2026-01-01";

/**
 * Anti Infective's organogram as production holds it at 2026-10-31, read from
 * au.f_line_area_map_asof and not invented. Nothing else on the line moves across this boundary, so
 * one column says it: the fixture dates every row from `PRE_MOVE_FROM` so both sides of the
 * boundary resolve, and only Kafr El-Sheikh 2 carries a dated pair.
 */
const ORGANOGRAM: ReadonlyArray<readonly [area: string, region: string]> = [
  ["AB1", "AB"], ["AB2", "AB"], ["AB3", "AB"], ["AB4", "AB"], ["AB5", "AB"],
  ["CA1", "CA"], ["CA2", "CA"], ["CA3", "CA"], ["CA4", "CA"], ["CA6", "CA"],
  // Delta (1) is Dina Fadel's: Menoufia 1-2, Gharbia 1-2 and Kafr El-Sheikh 1 — five, six from July.
  ["D12", "D1"], ["D13", "D1"], ["D14", "D1"], ["D15", "D1"],
  [RAGAAS_AREA, "D1"],
  ["D21", "D2"], ["D22", "D2"], ["D23", "D2"], ["D26", "D2"],
  // Delta (3), Anti Infective only, live since 2026-09-01.
  ["D11", "D3"], ["D24", "D3"], ["D25", "D3"], ["OT2", "D3"], ["OT9", "D3"],
  ["GZ1", "GZ"], ["GZ2", "GZ"], ["GZ3", "GZ"], ["GZ4", "GZ"], ["GZ5", "GZ"],
  ["GZ6", "GZ"],
  ["UE1", "UE-1"], ["UE2", "UE-1"], ["UE9", "UE-1"],
  ["UE3", "UE-2"], ["UE4", "UE-2"], ["UE5", "UE-2"], ["UE6", "UE-2"],
  ["UE7", "UE-2"], ["UE8", "UE-2"],
  // Others keeps everything else, Kafr El-Sheikh 2 aside.
  ["CA5", "OT"], ["GZ7", "OT"], ["OT1", "OT"], ["OT4", "OT"], ["OT5", "OT"],
  ["OT6", "OT"], ["OT7", "OT"], ["OT8", "OT"], ["OT10", "OT"],
];

/**
 * OT3 "Aswan (Legacy)", retired 2026-07-27. Carried for the same reason the Pedia move's fixture
 * carries it: `au.f_line_area_map_asof` reports a retired area in its last region for ever while
 * `buildOperationalRegionMap` drops it, and a fixture without it would hide that disagreement.
 */
const RETIRED_AREA = {
  area_code: "OT3",
  operational_region_code: "OT",
  effective_from: PRE_MOVE_FROM,
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

/** The organogram with this move NOT yet written — Kafr El-Sheikh 2 still open on Others. */
const withoutTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.map(([area, region]) => ({
    area_code: area,
    operational_region_code: area === MOVER ? LEAVES : region,
    effective_from: PRE_MOVE_FROM,
    effective_to: null as string | null,
  })),
  { area_code: MOVER, operational_region_code: LEAVES, effective_from: PRE_MOVE_FROM, effective_to: null },
];

/** The same organogram after the migration: Kafr El-Sheikh 2 written as a dated pair at 1 July. */
const withTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.map(([area, region]) => ({
    area_code: area,
    operational_region_code: region,
    effective_from: PRE_MOVE_FROM,
    effective_to: null as string | null,
  })),
  { area_code: MOVER, operational_region_code: LEAVES, effective_from: PRE_MOVE_FROM, effective_to: MOVE_DATE },
  { area_code: MOVER, operational_region_code: JOINS, effective_from: MOVE_DATE, effective_to: null },
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
  // effective_to is EXCLUSIVE, so a row closed on 2026-07-01 still covers 2026-06-30 and does not
  // cover 2026-07-01. Getting this one day wrong moves a month the owner did not name.
  assert.equal(closingRegionsAsOfDate("2026-06"), BEFORE, "June resolves at its own last day");
  assert.equal(closingRegionsAsOfDate("2026-07"), AFTER, "July resolves at its own last day");

  const june = buildOperationalRegionMap(withTheMove(), BEFORE, regionNames());
  const july = buildOperationalRegionMap(withTheMove(), AFTER, regionNames());

  // ── The move itself ───────────────────────────────────────────────────────────────────────────
  assert.equal(
    june?.regionByArea.get(MOVER)?.regionCode,
    LEAVES,
    "June 2026 must still file Kafr El-Sheikh 2 in Others — the ruling starts in July",
  );
  assert.equal(
    july?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "July 2026 files Kafr El-Sheikh 2 under Delta (1) — Dina Fadel's district",
  );
  assert.equal(
    july?.regionByArea.get(MOVER)?.regionName,
    "Delta (1)",
    "the district reaches the screen by NAME, never as a raw code",
  );

  // Every month from the boundary on is hers, including the three the owner must unpublish himself.
  ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30"].forEach((asOf) => {
    assert.equal(
      buildOperationalRegionMap(withTheMove(), asOf, regionNames())?.regionByArea.get(MOVER)?.regionCode,
      JOINS,
      `${asOf}: Kafr El-Sheikh 2 counts to Delta (1) — the boundary opens once and never closes`,
    );
  });

  // ── 🔴 THE FALLBACK TRAP: January to June must NOT reach her ──────────────────────────────────
  // `au.f_line_area_map_asof` falls back to the row with the smallest effective_from, so the Others
  // row has to stay earlier than the Delta (1) one. These two assertions fail the moment it does
  // not — and they cover six UNPUBLISHED months the nightly sweep would restate on its own.
  ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", BEFORE].forEach((asOf) => {
    assert.equal(
      buildOperationalRegionMap(withTheMove(), asOf, regionNames())?.regionByArea.get(MOVER)?.regionCode,
      LEAVES,
      `${asOf}: Kafr El-Sheikh 2 is still in Others — the July ruling must not leak backwards`,
    );
  });

  // ── Her district's membership, stated in full ─────────────────────────────────────────────────
  assert.deepEqual(
    membership(june, "D1"),
    ["D12", "D13", "D14", "D15", "D16"],
    "June's Delta (1) is Menoufia 1 and 2, Gharbia 1 and 2, and Kafr El-Sheikh 1",
  );
  assert.deepEqual(
    membership(july, "D1"),
    ["D12", "D13", "D14", "D15", "D16", "D17"],
    "July's Delta (1) is those five plus Kafr El-Sheikh 2",
  );
  assert.equal(
    othersAreasFrom(june).has(MOVER),
    true,
    "June: Kafr El-Sheikh 2 is still in the Others bucket",
  );
  assert.equal(
    othersAreasFrom(july).has(MOVER),
    false,
    "July: it has left Others, which is what lets her district total read it",
  );

  // ── 🔒 THE MONEY: the split stays 50/50, before and after ─────────────────────────────────────
  // This is the assertion that fails if anyone answers the ruling with a split exclusion again, as
  // #5926 did. An exclusion would leave ONE area in the plan and hand all 290 packs to Ragaa.
  assert.deepEqual(
    CITY_AREAS.get("Kafr El-Sheikh"),
    [RAGAAS_AREA, MOVER],
    "Kafr El-Sheikh is one city holding both areas — the split map is untouched by the move",
  );

  ([["June", june], ["July", july]] as const).forEach(([label, map]) => {
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
  ([["June", BEFORE], ["July", AFTER]] as const).forEach(([label, asOf]) => {
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
    buildOperationalRegionMap(withTheMove(), BEFORE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    LEAVES,
    "30 June: Kafr El-Sheikh 2 is still in Others",
  );
  assert.equal(
    buildOperationalRegionMap(withTheMove(), MOVE_DATE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "1 July: Kafr El-Sheikh 2 is Delta (1)",
  );

  // ── June's answer cannot depend on July's rows existing ───────────────────────────────────────
  // The assertion that would have caught the Delta (3) defect of 2026-08-29, where a dated pair
  // written correctly was still invisible to the closing and silently re-filed the month.
  assert.equal(
    buildOperationalRegionMap(withTheMove(), BEFORE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    buildOperationalRegionMap(withoutTheMove(), BEFORE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    "Kafr El-Sheikh 2 answers the same for June with the move written as without it",
  );

  // ── Row order cannot decide any of it ─────────────────────────────────────────────────────────
  // PostgREST returns these unordered, and the moved area now has two rows.
  [BEFORE, AFTER].forEach((asOf) => {
    const forward = buildOperationalRegionMap(withTheMove(), asOf, regionNames());
    const reversed = buildOperationalRegionMap([...withTheMove()].reverse(), asOf, regionNames());
    assert.equal(
      reversed?.regionByArea.get(MOVER)?.regionCode,
      forward?.regionByArea.get(MOVER)?.regionCode,
      `row order must not change Kafr El-Sheikh 2's ${asOf} answer`,
    );
  });

  // ── Ragaa's own area never moves ──────────────────────────────────────────────────────────────
  ([["June", june], ["July", july]] as const).forEach(([label, map]) => {
    assert.equal(
      map?.regionByArea.get(RAGAAS_AREA)?.regionCode,
      "D1",
      `${label}: Kafr El-Sheikh 1 stays in Delta (1) — only the district reading D17 changes`,
    );
  });
}
