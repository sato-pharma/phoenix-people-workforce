import assert from "node:assert/strict";

import {
  buildOperationalRegionMap,
  closingRegionsAsOfDate,
  othersAreasFrom,
  splitRegionsFrom,
} from "../src/lib/sales/closing-organogram-regions.ts";
import {
  ALL_SPLIT_AREAS,
  QEMA_LEAD_AREAS,
  planShares,
  splitTargetsFor,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * 🔒 THE AUGUST / KAFR EL-SHEIKH GOLDEN RULE — owner, 2026-09-12:
 *
 *   "in Pedia line Kafr El sheiykh starting from september will move under delta 1 region"
 *   "kafr el sheikh 2 stays in others, pedia only"
 *
 * Pedia's Kafr El-Sheikh 1 leaves Alex-BHR for Delta (1) on 2026-09-01. Kafr El-Sheikh 2 stays
 * parked in Others, and CNS keeps its own Alex-BHR override. Anti Infective already filed Kafr
 * El-Sheikh 1 under Delta (1) and is untouched.
 *
 * The move is written as a dated PAIR in au.line_area_map and the closing resolves the org chart at
 * the END of the month being closed, so August reaches only the Alex-BHR row no matter when August
 * is finally run. Same mechanism as the Delta (3) and Upper Egypt moves before it; this file is the
 * proof for this one. See 20260912103000_pedia_kafr_el_sheikh_to_delta_1_from_september.sql.
 *
 * 🔴 WHAT IS DIFFERENT HERE, AND IS THE WHOLE POINT OF THIS FILE: unlike the Upper Egypt split,
 * this move must not shift a single pound of El Qema's book, in EITHER month. The ladder's divisor
 * is every Pedia area the organogram does NOT park in Others, and Kafr El-Sheikh 1 is on the
 * playing field before and after — it only changes which DM reads it. Kafr El-Sheikh 2 is the area
 * that would have moved money, because it sits IN Others and pulling it out would take the divisor
 * from 39 to 40. He was asked in those words and answered that it stays. So the assertions below
 * are equalities, not transitions: August's El Qema plan and September's El Qema plan must both be
 * byte-identical with the move written and without it.
 *
 * 🔴 AND THE LEAD GUARANTEE MUST SURVIVE IT. Qalubeya, Tanta and Mahalla are named BY AREA CODE in
 * QEMA_LEAD_TIERS, never by district, so Delta (1) gaining a sixth area cannot promote or demote
 * any of them. A future refactor that "tidied" the ladder into a region lookup would break the one
 * rule he stated twice in one message, and it would break it quietly.
 */

/** The area that moves, and the two districts either side of it. */
const MOVER = "D16";
const LEAVES = "AB";
const JOINS = "D1";
const MOVE_DATE = "2026-09-01";

/**
 * Pedia's organogram across the boundary, as production holds it: `[area, August, September]`.
 *
 * Two moves are in force at once and that is deliberate — the Upper Egypt split of 2026-09-09 is
 * dated to the same day, so a fixture carrying only this one would compute an August divisor that
 * production never sees. The Upper Egypt rows are here as the BACKDROP this move has to leave
 * alone, not as a second thing under test; tests/pedia-upper-egypt-split.test.ts owns those.
 */
const ORGANOGRAM: ReadonlyArray<readonly [area: string, august: string, september: string]> = [
  // Alex-BHR keeps its five own areas and loses Kafr El-Sheikh 1.
  ["AB1", "AB", "AB"], ["AB2", "AB", "AB"], ["AB3", "AB", "AB"], ["AB4", "AB", "AB"], ["AB5", "AB", "AB"],
  [MOVER, LEAVES, JOINS], // ← Kafr El-Sheikh 1, the move under test
  // Delta (1) has five today and six from September.
  ["D11", "D1", "D1"], ["D12", "D1", "D1"], ["D13", "D1", "D1"], ["D14", "D1", "D1"], ["D15", "D1", "D1"],
  // Cairo, Delta (2) and Giza are bystanders.
  ["CA1", "CA", "CA"], ["CA2", "CA", "CA"], ["CA3", "CA", "CA"], ["CA4", "CA", "CA"], ["CA6", "CA", "CA"],
  ["D21", "D2", "D2"], ["D22", "D2", "D2"], ["D23", "D2", "D2"], ["D24", "D2", "D2"], ["D25", "D2", "D2"],
  ["D26", "D2", "D2"],
  ["GZ1", "GZ", "GZ"], ["GZ2", "GZ", "GZ"], ["GZ3", "GZ", "GZ"], ["GZ4", "GZ", "GZ"], ["GZ5", "GZ", "GZ"],
  ["GZ7", "GZ", "GZ"],
  // The Upper Egypt split, in force on the same date. Backdrop only.
  ["GZ6", "GZ", "UE-1"], ["UE9", "GZ", "UE-1"],
  ["UE1", "UE", "UE-1"], ["UE2", "UE", "UE-1"], ["UE3", "UE", "UE-1"], ["UE4", "UE", "UE-1"],
  ["UE5", "UE", "UE-2"], ["UE6", "UE", "UE-2"], ["UE7", "UE", "UE-2"],
  ["UE8", "OT", "UE-2"], ["OT6", "OT", "UE-2"],
  // Others, including Kafr El-Sheikh 2, which he said stays.
  ["CA5", "OT", "OT"], ["D17", "OT", "OT"], ["OT1", "OT", "OT"], ["OT2", "OT", "OT"], ["OT4", "OT", "OT"],
  ["OT5", "OT", "OT"], ["OT7", "OT", "OT"], ["OT8", "OT", "OT"], ["OT9", "OT", "OT"], ["OT10", "OT", "OT"],
];

/**
 * OT3 "Aswan (Legacy)", retired 2026-07-27. It is here because `au.f_line_area_map_asof` reports a
 * retired area in its last region forever while `buildOperationalRegionMap` drops it, and a fixture
 * without it would hide that disagreement. It reaches no money: ALL_SPLIT_AREAS does not carry it.
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
    ["GZ", "Giza"],
    ["OT", "Others"],
    ["UE", "Upper Egypt"],
    ["UE-1", "Upper Egypt 1"],
    ["UE-2", "Upper Egypt 2"],
  ]);

/** Every row except Kafr El-Sheikh 1's pair — the organogram with this move NOT yet written. */
const withoutTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.flatMap(([area, august, september]) => {
    if (area === MOVER) {
      return [{ area_code: area, operational_region_code: LEAVES, effective_from: "2026-07-13", effective_to: null }];
    }
    return august === september
      ? [{ area_code: area, operational_region_code: august, effective_from: "2026-07-13", effective_to: null }]
      : [
        { area_code: area, operational_region_code: august, effective_from: "2026-07-13", effective_to: MOVE_DATE },
        { area_code: area, operational_region_code: september, effective_from: MOVE_DATE, effective_to: null },
      ];
  }),
];

/** The same organogram after the migration: Kafr El-Sheikh 1 written as a dated pair. */
const withTheMove = () => [
  RETIRED_AREA,
  ...ORGANOGRAM.flatMap(([area, august, september]) =>
    august === september
      ? [{ area_code: area, operational_region_code: august, effective_from: "2026-07-13", effective_to: null }]
      : [
        { area_code: area, operational_region_code: august, effective_from: "2026-07-13", effective_to: MOVE_DATE },
        { area_code: area, operational_region_code: september, effective_from: MOVE_DATE, effective_to: null },
      ]),
];

/** A 6,000-pack Benha order. Band 3, so it reaches every area in play and nothing else varies. */
const QEMA_ROW: StoreSplitRow = {
  areaCode: "D11",
  clientCode: "QM-9001",
  clientName: "مخزن بنها",
  distributorCode: "QM",
  includedInClosing: true,
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 6_000,
  salesValue: 1_620_000,
};

const qemaPlanFor = (map: Parameters<typeof splitRegionsFrom>[0]) =>
  splitTargetsFor(QEMA_ROW, 6_000, splitRegionsFrom(map));

/** The areas El Qema's book can reach: the split geography less whatever is parked in Others. */
const inPlayFor = (others: ReadonlySet<string>) => ALL_SPLIT_AREAS.filter((area) => !others.has(area));

const membership = (
  map: ReturnType<typeof buildOperationalRegionMap>,
  code: string,
) =>
  [...(map?.regionByArea ?? new Map())]
    .filter(([, region]) => region.regionCode === code)
    .map(([area]) => area)
    .sort();

export function runPediaKafrElSheikhDelta1Tests() {
  // ── The dates the two months resolve at ───────────────────────────────────────────────────────
  // effective_to is EXCLUSIVE, so a row closed on 2026-09-01 still covers 2026-08-31 and does not
  // cover 2026-09-01. Getting this one day wrong is the whole failure mode.
  assert.equal(closingRegionsAsOfDate("2026-08"), "2026-08-31", "August resolves at its own last day");
  assert.equal(closingRegionsAsOfDate("2026-09"), "2026-09-30", "September resolves at its own last day");

  const august = buildOperationalRegionMap(withTheMove(), "2026-08-31", regionNames());
  const september = buildOperationalRegionMap(withTheMove(), "2026-09-30", regionNames());

  // ── The move itself ───────────────────────────────────────────────────────────────────────────
  assert.equal(
    august?.regionByArea.get(MOVER)?.regionCode,
    LEAVES,
    "August 2026 must still file Kafr El-Sheikh 1 under Alex-BHR — the move is dated to spare it",
  );
  assert.equal(
    september?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "September 2026 files Kafr El-Sheikh 1 under Delta (1)",
  );
  assert.equal(
    september?.regionByArea.get(MOVER)?.regionName,
    "Delta (1)",
    "the district reaches the screen by NAME, never as a raw code",
  );

  // ── Both districts' membership, stated in full ────────────────────────────────────────────────
  assert.deepEqual(
    membership(august, "D1"),
    ["D11", "D12", "D13", "D14", "D15"],
    "August's Delta (1) is Qalubeya, Menoufia 1 and 2, Tanta and Mahalla",
  );
  assert.deepEqual(
    membership(september, "D1"),
    ["D11", "D12", "D13", "D14", "D15", "D16"],
    "September's Delta (1) is those five plus Kafr El-Sheikh 1",
  );
  assert.deepEqual(
    membership(august, "AB"),
    ["AB1", "AB2", "AB3", "AB4", "AB5", "D16"],
    "August's Alex-BHR still holds Kafr El-Sheikh 1",
  );
  assert.deepEqual(
    membership(september, "AB"),
    ["AB1", "AB2", "AB3", "AB4", "AB5"],
    "September's Alex-BHR is its own five areas and nothing else",
  );

  // ── Kafr El-Sheikh 2 stays in Others. His words, and the reason the divisor holds ──────────────
  ([["August", august], ["September", september]] as const).forEach(([label, map]) => {
    assert.equal(
      map?.regionByArea.get("D17")?.regionCode,
      "OT",
      `${label}: Kafr El-Sheikh 2 stays in Others — pulling it out would take the El Qema divisor to 40`,
    );
    assert.equal(othersAreasFrom(map).has("D17"), true, `${label}: and so it takes no share of an El Qema split`);
    assert.equal(
      othersAreasFrom(map).has(MOVER),
      false,
      `${label}: Kafr El-Sheikh 1 is on the playing field in BOTH months — only its DM changes`,
    );
  });

  // ── 🔒 THE MONEY: this move must not shift a single pound, in either month ─────────────────────
  // Not a transition assertion like the Upper Egypt split's — an EQUALITY. The divisor is 37 in
  // August and 39 in September because of the Upper Egypt split alone, and writing Kafr El-Sheikh
  // 1's pair on top of it changes neither number and neither plan.
  const augustOthers = othersAreasFrom(august);
  const septemberOthers = othersAreasFrom(september);

  assert.equal(ALL_SPLIT_AREAS.length, 49, "the split geography holds 49 areas");
  assert.equal(inPlayFor(augustOthers).length, 37, "August still divides El Qema's book over 37 areas");
  assert.equal(inPlayFor(septemberOthers).length, 39, "September still divides it over 39 — this move added none");

  ([["August", "2026-08-31"], ["September", "2026-09-30"]] as const).forEach(([label, asOf]) => {
    const before = buildOperationalRegionMap(withoutTheMove(), asOf, regionNames());
    const after = buildOperationalRegionMap(withTheMove(), asOf, regionNames());

    assert.deepEqual(
      [...othersAreasFrom(after)].sort(),
      [...othersAreasFrom(before)].sort(),
      `${label}: writing Kafr El-Sheikh 1's pair must not move a single area in or out of Others`,
    );
    assert.deepEqual(
      qemaPlanFor(after),
      qemaPlanFor(before),
      `${label}: El Qema's distribution is byte-identical with the move written and without it`,
    );

    const plan = qemaPlanFor(after);
    assert.ok(plan, `${label} resolves an El Qema plan`);
    assert.equal(
      planShares(plan, 6_000).reduce((sum, share) => sum + share, 0),
      6_000,
      `${label} hands back every pack exactly`,
    );
  });

  // ── 🔒 The lead guarantee is keyed by AREA, so a sixth Delta (1) area cannot disturb it ────────
  assert.deepEqual(
    [...QEMA_LEAD_AREAS].sort(),
    ["D11", "D14", "D15"],
    "Qalubeya, Tanta and Mahalla lead by AREA CODE — never by district, or this move would have re-ranked them",
  );
  assert.equal(
    QEMA_LEAD_AREAS.includes(MOVER),
    false,
    "Kafr El-Sheikh 1 joins Delta (1) without joining the lead tiers",
  );

  // ── August's answer cannot depend on September's rows existing ────────────────────────────────
  // This is the assertion that would have caught the Delta (3) defect of 2026-08-29, where a dated
  // pair written correctly was still invisible to the closing and silently re-filed the month.
  const augustBefore = buildOperationalRegionMap(withoutTheMove(), "2026-08-31", regionNames());
  const augustAfter = buildOperationalRegionMap(withTheMove(), "2026-08-31", regionNames());
  assert.equal(
    augustAfter?.regionByArea.get(MOVER)?.regionCode,
    augustBefore?.regionByArea.get(MOVER)?.regionCode,
    "Kafr El-Sheikh 1 answers the same for August with the move written as without it",
  );
  assert.equal(augustAfter?.regionByArea.get(MOVER)?.regionCode, LEAVES, "and that answer is Alex-BHR");

  // ── Row order cannot decide any of it ─────────────────────────────────────────────────────────
  // PostgREST returns these unordered, and the moved area now has two rows.
  ["2026-08-31", "2026-09-30"].forEach((asOf) => {
    const forward = buildOperationalRegionMap(withTheMove(), asOf, regionNames());
    const reversed = buildOperationalRegionMap([...withTheMove()].reverse(), asOf, regionNames());
    assert.equal(
      reversed?.regionByArea.get(MOVER)?.regionCode,
      forward?.regionByArea.get(MOVER)?.regionCode,
      `row order must not change Kafr El-Sheikh 1's ${asOf} answer`,
    );
  });

  // ── The boundary day, from both sides ─────────────────────────────────────────────────────────
  // 2026-08-31 is the last day on Alex-BHR; 2026-09-01 is the first on Delta (1). There is no day
  // that belongs to both and none that belongs to neither.
  const lastAugustDay = buildOperationalRegionMap(withTheMove(), "2026-08-31", regionNames());
  const firstSeptemberDay = buildOperationalRegionMap(withTheMove(), MOVE_DATE, regionNames());
  assert.equal(
    lastAugustDay?.regionByArea.get(MOVER)?.regionCode,
    LEAVES,
    "31 August: Kafr El-Sheikh 1 is still Alex-BHR",
  );
  assert.equal(
    firstSeptemberDay?.regionByArea.get(MOVER)?.regionCode,
    JOINS,
    "1 September: Kafr El-Sheikh 1 is Delta (1)",
  );
}
