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
 * 🔒 CNS KAFR EL-SHEIKH 2 COUNTS TO SAAD THE MANAGER, UNDER NO REP — owner, 2026-11-17:
 *
 *   "KAFR EL SHEIKH 2 IN CNS LINE SHOULD BE COUNTED TO SAAD TOTAL UNDER NO REP EXACTLY AS DINA IN
 *    ANTI INFECTIVE"
 *
 * with July 2026 chosen as the start, like Dina's. Kafr El-Sheikh is ONE city with two areas in the
 * split map, so every wholesaler there divides 50/50 between Kafr El-Sheikh 1 (D16) and Kafr
 * El-Sheikh 2 (D17). On CNS D16 is in Saad Mohamed Saad Salama's Alex-BHR district
 * (SEAT-CNS-DM-AB) with its own rep seat (SEAT-CNS-REP-D16); D17 sat in the line's Others bucket, so
 * half his own city's wholesaler money reached no manager.
 *
 * The fix is the ORGANOGRAM, never the split — the same shape as Anti Infective's
 * (tests/anti-infective-kafr-el-sheikh-2-delta-1.test.ts): D17 joins Alex-BHR with no rep seat and
 * no target, from 2026-07-01. See 20261117143000_cns_kafr_el_sheikh_2_to_alex_bhr_from_july.sql.
 *
 * 🔴 THE MONEY ASSERTION IS AN EQUALITY: the Kafr El-Sheikh split stays 145/145 before and after. A
 * split exclusion instead would hand D17's half to D16 — to the rep — which is the opposite of the
 * ruling.
 *
 * 🔴 THE OTHERS ROW IS DATED BACK TO 2026-01-01 ON PURPOSE. `au.f_line_area_map_asof` falls back to
 * the row with the smallest `effective_from` when no interval holds the date; left on the map's
 * 2026-07-13 floor, the Alex-BHR row would become the earliest and January to June would count to
 * him too. The January assertions below are that trap.
 */

const MOVER = "D17";
const LEAVES = "OT";
const JOINS = "AB";
const MOVE_DATE = "2026-07-01";
const BEFORE = "2026-06-30";
const AFTER = "2026-07-31";

/** Kafr El-Sheikh 1 — the rep's area, which keeps its own half and gains none of this. */
const REPS_AREA = "D16";

const PRE_MOVE_FROM = "2026-01-01";

/**
 * CNS's organogram as production holds it at 2026-10-31, read from au.f_line_area_map_asof on
 * 2026-11-17 and not invented. Only Kafr El-Sheikh 2 carries a dated pair.
 */
const ORGANOGRAM: ReadonlyArray<readonly [area: string, region: string]> = [
  // Alex-BHR is Saad's: Alexandria 1-5 and Kafr El-Sheikh 1 — six, seven from July.
  ["AB1", "AB"], ["AB2", "AB"], ["AB3", "AB"], ["AB4", "AB"], ["AB5", "AB"],
  [REPS_AREA, "AB"],
  ["CA1", "CA"], ["CA2", "CA"], ["CA3", "CA"], ["CA4", "CA"], ["CA6", "CA"],
  ["D11", "D1"], ["D12", "D1"], ["D13", "D1"], ["D14", "D1"], ["D15", "D1"],
  ["D21", "D2"], ["D22", "D2"], ["D23", "D2"], ["D24", "D2"], ["D25", "D2"], ["D26", "D2"],
  ["CA5", "GZ"], ["GZ1", "GZ"], ["GZ2", "GZ"], ["GZ4", "GZ"], ["GZ5", "GZ"], ["GZ7", "GZ"],
  ["UE1", "UE"], ["UE2", "UE"], ["UE3", "UE"], ["UE4", "UE"], ["UE5", "UE"], ["UE6", "UE"],
  ["UE7", "UE"], ["UE8", "UE"],
  ["GZ3", "OT"], ["GZ6", "OT"], ["OT1", "OT"], ["OT10", "OT"], ["OT2", "OT"], ["OT4", "OT"],
  ["OT5", "OT"], ["OT6", "OT"], ["OT7", "OT"], ["OT8", "OT"], ["OT9", "OT"], ["UE9", "OT"],
];

/** OT3 "Aswan (Legacy)", retired 2026-07-27 — the asof function reports it, the builder drops it. */
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
    ["GZ", "Giza"],
    ["OT", "Others"],
    ["UE", "Upper Egypt"],
  ]);

const withoutTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.map(([area, region]) => ({
    area_code: area,
    operational_region_code: region,
    effective_from: PRE_MOVE_FROM,
    effective_to: null as string | null,
  })),
  { area_code: MOVER, operational_region_code: LEAVES, effective_from: PRE_MOVE_FROM, effective_to: null },
];

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

/** An illustrative CNS wholesaler order in Kafr El-Sheikh 1: 290 packs, the same count the Anti
 * Infective file asserts on, so the two halves read 145/145. */
const WHOLESALER_ROW: StoreSplitRow = {
  areaCode: REPS_AREA,
  clientCode: "CNS-KFS-9001",
  clientName: "Kafr El-Sheikh wholesaler",
  distributorCode: "EPDA",
  includedInClosing: true,
  isDirect: false,
  officialLine: "CNS",
  productCode: "CN001",
  qty: 290,
  salesValue: 29_000,
};

const membership = (map: ReturnType<typeof buildOperationalRegionMap>, code: string) =>
  [...(map?.regionByArea ?? new Map())]
    .filter(([, region]) => region.regionCode === code)
    .map(([area]) => area)
    .sort();

const planFor = (map: Parameters<typeof splitRegionsFrom>[0]) =>
  splitTargetsFor(WHOLESALER_ROW, 290, splitRegionsFrom(map));

export function runCnsKafrElSheikh2AlexBhrTests() {
  assert.equal(closingRegionsAsOfDate("2026-06"), BEFORE, "June resolves at its own last day");
  assert.equal(closingRegionsAsOfDate("2026-07"), AFTER, "July resolves at its own last day");

  const june = buildOperationalRegionMap(withTheMove(), BEFORE, regionNames());
  const july = buildOperationalRegionMap(withTheMove(), AFTER, regionNames());

  // ── The move itself ───────────────────────────────────────────────────────────────────────────
  assert.equal(june?.regionByArea.get(MOVER)?.regionCode, LEAVES, "June 2026 still files CNS Kafr El-Sheikh 2 in Others");
  assert.equal(july?.regionByArea.get(MOVER)?.regionCode, JOINS, "July 2026 files CNS Kafr El-Sheikh 2 under Alex-BHR — Saad's district");
  assert.equal(july?.regionByArea.get(MOVER)?.regionName, "Alex-BHR", "the district reaches the screen by NAME");

  ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30"].forEach((asOf) => {
    assert.equal(
      buildOperationalRegionMap(withTheMove(), asOf, regionNames())?.regionByArea.get(MOVER)?.regionCode,
      JOINS,
      `${asOf}: CNS Kafr El-Sheikh 2 counts to Alex-BHR — the boundary opens once and never closes`,
    );
  });

  // ── 🔴 THE FALLBACK TRAP: January to June must NOT reach him ──────────────────────────────────
  ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", BEFORE].forEach((asOf) => {
    assert.equal(
      buildOperationalRegionMap(withTheMove(), asOf, regionNames())?.regionByArea.get(MOVER)?.regionCode,
      LEAVES,
      `${asOf}: CNS Kafr El-Sheikh 2 is still in Others — the July ruling must not leak backwards`,
    );
  });

  // ── His district's membership, stated in full ─────────────────────────────────────────────────
  assert.deepEqual(membership(june, "AB"), ["AB1", "AB2", "AB3", "AB4", "AB5", "D16"], "June's Alex-BHR is Alexandria 1-5 and Kafr El-Sheikh 1");
  assert.deepEqual(membership(july, "AB"), ["AB1", "AB2", "AB3", "AB4", "AB5", "D16", "D17"], "July's Alex-BHR adds Kafr El-Sheikh 2");
  assert.equal(othersAreasFrom(june).has(MOVER), true, "June: Kafr El-Sheikh 2 is still in the Others bucket");
  assert.equal(othersAreasFrom(july).has(MOVER), false, "July: it has left Others, so his district total reads it");

  // ── 🔒 THE MONEY: the split stays 50/50, before and after ─────────────────────────────────────
  assert.deepEqual(CITY_AREAS.get("Kafr El-Sheikh"), [REPS_AREA, MOVER], "Kafr El-Sheikh is one city holding both areas");

  ([["June", june], ["July", july]] as const).forEach(([label, map]) => {
    const plan = planFor(map);
    assert.ok(plan, `${label}: the Kafr El-Sheikh wholesaler resolves a split plan`);
    assert.deepEqual([...plan!.areas].sort(), [REPS_AREA, MOVER], `${label}: both Kafr El-Sheikh areas take a share`);
    assert.deepEqual(planShares(plan!, 290), [145, 145], `${label}: 290 packs divide 145/145 — the rep's area keeps HALF, never the whole city`);
  });

  ([["June", BEFORE], ["July", AFTER]] as const).forEach(([label, asOf]) => {
    const before = buildOperationalRegionMap(withoutTheMove(), asOf, regionNames());
    const after = buildOperationalRegionMap(withTheMove(), asOf, regionNames());
    assert.deepEqual(
      planShares(planFor(after)!, 290),
      planShares(planFor(before)!, 290),
      `${label}: the Kafr El-Sheikh split is identical with the move written and without it`,
    );
  });

  // CNS never divided by the Others set: the line-level exclusion is Pedia's alone.
  assert.deepEqual([...OTHERS_EXCLUDED_LINES].sort(), ["pedia"], "the Others exclusion is Pedia's alone");
  assert.equal(OTHERS_EXCLUDED_LINES.has("cns"), false, "CNS must never join it — that pays the rep the whole city");

  // ── The boundary day, and June's independence from July's rows ────────────────────────────────
  assert.equal(
    buildOperationalRegionMap(withTheMove(), MOVE_DATE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "1 July: CNS Kafr El-Sheikh 2 is Alex-BHR",
  );
  assert.equal(
    buildOperationalRegionMap(withTheMove(), BEFORE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    buildOperationalRegionMap(withoutTheMove(), BEFORE, regionNames())?.regionByArea.get(MOVER)?.regionCode,
    "June answers the same with the move written as without it",
  );

  // ── Row order cannot decide any of it ─────────────────────────────────────────────────────────
  [BEFORE, AFTER].forEach((asOf) => {
    const forward = buildOperationalRegionMap(withTheMove(), asOf, regionNames());
    const reversed = buildOperationalRegionMap([...withTheMove()].reverse(), asOf, regionNames());
    assert.equal(
      reversed?.regionByArea.get(MOVER)?.regionCode,
      forward?.regionByArea.get(MOVER)?.regionCode,
      `row order must not change CNS Kafr El-Sheikh 2's ${asOf} answer`,
    );
  });

  // ── Kafr El-Sheikh 1 never moves ──────────────────────────────────────────────────────────────
  ([["June", june], ["July", july]] as const).forEach(([label, map]) => {
    assert.equal(map?.regionByArea.get(REPS_AREA)?.regionCode, "AB", `${label}: Kafr El-Sheikh 1 stays in Alex-BHR`);
  });
}
