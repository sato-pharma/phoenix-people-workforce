import assert from "node:assert/strict";

import {
  buildOperationalRegionMap,
  closingRegionsAsOfDate,
  othersAreasFrom,
  splitRegionsFrom,
} from "../src/lib/sales/closing-organogram-regions.ts";
import {
  ALL_SPLIT_AREAS,
  planShares,
  splitTargetsFor,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";

/**
 * The areas El Qema's book can reach on this line — the divisor this file exists to pin. It is
 * ALL_SPLIT_AREAS less whatever the organogram parks in Others, and nothing else: the exclusion
 * keys on operational_region_code alone, never on area_state and never on whether an area carries
 * a target.
 */
const inPlayFor = (others: ReadonlySet<string>) =>
  ALL_SPLIT_AREAS.filter((area) => !others.has(area));

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

/** El Qema's real plan for that order, read through the same organogram the closing reads. */
const qemaPlanFor = (map: Parameters<typeof splitRegionsFrom>[0]) =>
  splitTargetsFor(QEMA_ROW, 6_000, splitRegionsFrom(map));

/**
 * 🔒 THE AUGUST / UPPER EGYPT GOLDEN RULE — owner, 2026-09-09, said three times in one message:
 *
 *   "August closing will be normally. The changes in sales will be starting from September."
 *   "starting from September everything will be based on this distribution ... every fucking thing"
 *   "you will pause August, August as it is."
 *
 * Pedia's single Upper Egypt district splits in two on 2026-09-01:
 *
 *   Upper Egypt 1  Fayoum, Beni Suef, Minia 1, Minia 2, Assuit 1, Assuit 2
 *   Upper Egypt 2  Sohag 1, Sohag 2, Qena 1, Qena 2, and Luxor
 *   Others         Aswan, untouched
 *
 * He asked for "a snapshot of the current organogram that El Qema will work on for August". This
 * file is the proof that the snapshot exists and is a DATE, not a copy: the move is written as a
 * pair in au.line_area_map, and the closing resolves the org chart at the END of the month being
 * closed. So August reaches only the pre-split rows no matter when August is finally run, and
 * nobody has to remember anything on the 1st.
 *
 * 🔴 THE MONEY IS IN THE DIVISOR. El Qema's rule spreads that distributor's Pedia
 * book across the areas the line has EXCEPT those parked in Others, and the exclusion keys on
 * operational_region_code = 'OT' alone — never on area_state, never on whether an area carries a
 * target. Qena 2 and Luxor leave Others in this move, so the divisor goes 37 → 39 in September
 * while August stays on 37. An off-by-one-day pair would move a month he has forbidden anyone to
 * move, silently and in his favour-blind direction, which is why the last assertion here compares
 * August's plan built WITH the September rows present against August's plan built without them.
 *
 * 🔴 LUXOR IS NOT A SEPARATE AREA — "Luxor is with Qena 2 ... not a separate area." It joins Upper
 * Egypt 2 as other_permanent with no rep seat, so it carries no target of its own. It still takes a
 * share, because the rule counts AREAS and not reps, and no area_state changes that. That
 * is not a defect: it is the same shape as OT9 Ismailia riding into Delta (3).
 */

/** The ten areas Pedia parks in Others and that this move does not touch. Aswan is one of them. */
const OTHERS_STAYERS = ["CA5", "D17", "OT1", "OT2", "OT4", "OT5", "OT7", "OT8", "OT9", "OT10"];

/**
 * 🔴 A RETIRED AREA NEVER LEAVES `au.f_line_area_map_asof`, AND THE TWO HALVES DISAGREE ABOUT IT.
 *
 * OT3 "Aswan (Legacy)" was retired on 2026-07-27 when OT7 Aswan replaced it, and its only row is
 * closed. The database function has NO where clause — it returns one row per (line, area) whichever
 * date you ask for — so it still reports OT3 in Others for every date after its own retirement.
 * `buildOperationalRegionMap` DROPS it instead, because a row whose effective_to has passed is not
 * in force. So the closing sheet counts 12 areas in Pedia's Others and achievement counts 13.
 *
 * The first draft of the migration asserted "August still has 12 in Others" against the database
 * function and refused to apply. That refusal was CORRECT and is why this fixture exists: an
 * assertion on a region TOTAL pins this quirk, an assertion on the areas that actually move does not.
 *
 * Neither number reaches money. ALL_SPLIT_AREAS does not carry OT3, so the El Qema divisor is 37
 * either way — which the last assertion in this block proves rather than assumes.
 */
const RETIRED_AREA = { area_code: "OT3", operational_region_code: "OT", effective_from: "2026-07-13", effective_to: "2026-07-27" };

/** The eleven areas that move, with the district each one leaves. */
const MOVERS: ReadonlyArray<readonly [area: string, leaves: string, joins: string]> = [
  ["GZ6", "GZ", "UE-1"], // Fayoum
  ["UE9", "GZ", "UE-1"], // Beni Suef
  ["UE1", "UE", "UE-1"], // Minia 1
  ["UE2", "UE", "UE-1"], // Minia 2
  ["UE3", "UE", "UE-1"], // Assuit 1
  ["UE4", "UE", "UE-1"], // Assuit 2
  ["UE5", "UE", "UE-2"], // Sohag 1
  ["UE6", "UE", "UE-2"], // Sohag 2
  ["UE7", "UE", "UE-2"], // Qena 1
  ["UE8", "OT", "UE-2"], // Qena 2, leaving Others
  ["OT6", "OT", "UE-2"], // Luxor, leaving Others, with Qena 2
];

const MOVE_DATE = "2026-09-01";

const regionNames = () =>
  new Map([
    ["GZ", "Giza"],
    ["OT", "Others"],
    ["UE", "Upper Egypt"],
    ["UE-1", "Upper Egypt 1"],
    ["UE-2", "Upper Egypt 2"],
  ]);

/** The pre-split rows only — the organogram exactly as it stands before the migration runs. */
const preSplitRows = () => [
  RETIRED_AREA,
  ...OTHERS_STAYERS.map((area) => ({
    area_code: area,
    operational_region_code: "OT",
    effective_from: "2026-07-13",
    effective_to: null,
  })),
  ...MOVERS.map(([area, leaves]) => ({
    area_code: area,
    operational_region_code: leaves,
    effective_from: "2026-07-13",
    effective_to: null,
  })),
];

/** The same organogram after the migration: every mover written as a dated PAIR. */
const withSplitRows = () => [
  RETIRED_AREA,
  ...OTHERS_STAYERS.map((area) => ({
    area_code: area,
    operational_region_code: "OT",
    effective_from: "2026-07-13",
    effective_to: null,
  })),
  ...MOVERS.flatMap(([area, leaves, joins]) => [
    {
      area_code: area,
      operational_region_code: leaves,
      effective_from: "2026-07-13",
      effective_to: MOVE_DATE,
    },
    {
      area_code: area,
      operational_region_code: joins,
      effective_from: MOVE_DATE,
      effective_to: null,
    },
  ]),
];

export function runPediaUpperEgyptSplitTests() {
  // ── The dates the two months resolve at ───────────────────────────────────────────────────────
  // effective_to is EXCLUSIVE, so a row closed on 2026-09-01 still covers 2026-08-31 and does not
  // cover 2026-09-01. Getting this one day wrong is the whole failure mode.
  assert.equal(closingRegionsAsOfDate("2026-08"), "2026-08-31", "August resolves at its own last day");
  assert.equal(closingRegionsAsOfDate("2026-09"), "2026-09-30", "September resolves at its own last day");

  const august = buildOperationalRegionMap(withSplitRows(), "2026-08-31", regionNames());
  const september = buildOperationalRegionMap(withSplitRows(), "2026-09-30", regionNames());

  // ── August still sees the district each area is leaving ───────────────────────────────────────
  MOVERS.forEach(([area, leaves]) => {
    assert.equal(
      august?.regionByArea.get(area)?.regionCode,
      leaves,
      `August 2026 must still file ${area} under ${leaves} — the move is dated to spare it`,
    );
  });

  // ── September sees the new districts, and the membership is exactly what he listed ────────────
  const membership = (map: typeof september, code: string) =>
    [...(map?.regionByArea ?? new Map())]
      .filter(([, region]) => region.regionCode === code)
      .map(([area]) => area)
      .sort();

  assert.deepEqual(
    membership(september, "UE-1"),
    ["GZ6", "UE1", "UE2", "UE3", "UE4", "UE9"],
    "Upper Egypt 1 is Fayoum, Beni Suef, Minia 1 and 2, Assuit 1 and 2",
  );
  assert.deepEqual(
    membership(september, "UE-2"),
    ["OT6", "UE5", "UE6", "UE7", "UE8"],
    "Upper Egypt 2 is Sohag 1 and 2, Qena 1, Qena 2, and Luxor with it",
  );
  assert.equal(
    september?.regionByArea.get("UE-1" as string)?.regionCode,
    undefined,
    "a region code is never itself an area",
  );
  assert.equal(
    september?.regionByArea.get("OT7")?.regionCode,
    "OT",
    "Aswan stays in Others — he named it explicitly and this move must not touch it",
  );
  assert.equal(
    september?.regionByArea.get("GZ6")?.regionName,
    "Upper Egypt 1",
    "the district reaches the screen by NAME, never as a raw code",
  );

  // The old single Upper Egypt district must be gone from September's picker, and the two new ones
  // must be absent from August's. A picker offering a district that owns nothing reads as lost sales.
  assert.equal([...(september?.regionCodes ?? [])].includes("UE"), false, "no plain Upper Egypt in September");
  assert.equal([...(august?.regionCodes ?? [])].includes("UE-1"), false, "no Upper Egypt 1 in August");
  assert.equal([...(august?.regionCodes ?? [])].includes("UE-2"), false, "no Upper Egypt 2 in August");

  // ── The Others set, which is what the El Qema rule actually spends ──────────────────────────
  const augustOthers = othersAreasFrom(august);
  const septemberOthers = othersAreasFrom(september);

  assert.equal(augustOthers.size, 12, "August parks 12 Pedia areas in Others");
  assert.equal(septemberOthers.size, 10, "September parks 10 — Qena 2 and Luxor have left");
  assert.equal(augustOthers.has("UE8") && augustOthers.has("OT6"), true, "Qena 2 and Luxor are in Others for August");
  assert.equal(septemberOthers.has("UE8"), false, "Qena 2 takes a share from September");
  assert.equal(septemberOthers.has("OT6"), false, "so does Luxor, even though it carries no target");
  assert.equal(septemberOthers.has("OT7"), true, "Aswan keeps taking none");

  // ── The divisor, stated as the numbers he was given ───────────────────────────────────────────
  assert.equal(ALL_SPLIT_AREAS.length, 49, "the split geography holds 49 areas");
  assert.equal(inPlayFor(augustOthers).length, 37, "August divides El Qema's book over 37 areas");
  assert.equal(inPlayFor(septemberOthers).length, 39, "September divides it over 39");

  // ── The retired area, and why neither half's count of Others is the number that matters ────────
  assert.equal(augustOthers.has("OT3"), false, "a row whose effective_to has passed is not in force here");
  assert.equal(ALL_SPLIT_AREAS.includes("OT3"), false, "and Aswan (Legacy) is not in the split geography at all");
  assert.equal(
    inPlayFor(new Set([...augustOthers, "OT3"])).length,
    inPlayFor(augustOthers).length,
    "so the divisor is 37 whether or not the retired area is counted in Others — which is why the migration names the two areas that move instead of counting the region",
  );
  // Through the real rule rather than through a divisor: a 6,000-pack order in each month reaches
  // exactly that many areas and still hands back every pack. Fractions of 37 and of 39 do not sum
  // to 1 in binary floating point and are not meant to — planShares is what turns them into packs.
  ([["August", august, 37], ["September", september, 39]] as const).forEach(([label, map, divisor]) => {
    const plan = qemaPlanFor(map);
    assert.ok(plan, `${label} resolves an El Qema plan`);
    assert.equal(plan.areas.length, divisor, `${label} reaches ${divisor} areas`);
    assert.equal(
      planShares(plan, 6_000).reduce((sum, share) => sum + share, 0),
      6_000,
      `${label} hands back every pack exactly`,
    );
  });

  // ── 🔒 THE GOLDEN RULE ITSELF ─────────────────────────────────────────────────────────────────
  // August's answer must be IDENTICAL whether or not September's rows exist yet. This is the
  // assertion that would have caught the Delta (3) defect of 2026-08-29, where a dated pair written
  // correctly was still invisible to the closing and silently re-filed the month underneath it.
  const augustBeforeTheMigration = buildOperationalRegionMap(preSplitRows(), "2026-08-31", regionNames());
  const augustAfterTheMigration = buildOperationalRegionMap(withSplitRows(), "2026-08-31", regionNames());

  assert.deepEqual(
    [...othersAreasFrom(augustAfterTheMigration)].sort(),
    [...othersAreasFrom(augustBeforeTheMigration)].sort(),
    "writing the September rows must not move a single area out of August's Others",
  );
  assert.deepEqual(
    qemaPlanFor(augustAfterTheMigration),
    qemaPlanFor(augustBeforeTheMigration),
    "August's El Qema distribution is byte-identical before and after the split is written — this is the snapshot he asked for",
  );
  MOVERS.forEach(([area, leaves]) => {
    assert.equal(
      augustAfterTheMigration?.regionByArea.get(area)?.regionCode,
      augustBeforeTheMigration?.regionByArea.get(area)?.regionCode,
      `${area} answers the same for August with the split written as without it`,
    );
    assert.equal(augustAfterTheMigration?.regionByArea.get(area)?.regionCode, leaves, `${area} on ${leaves}`);
  });

  // ── Row order cannot decide any of it ─────────────────────────────────────────────────────────
  // PostgREST returns these unordered, and once history is exposed each area has two rows.
  ["2026-08-31", "2026-09-30"].forEach((asOf) => {
    const forward = buildOperationalRegionMap(withSplitRows(), asOf, regionNames());
    const reversed = buildOperationalRegionMap([...withSplitRows()].reverse(), asOf, regionNames());
    MOVERS.forEach(([area]) => {
      assert.equal(
        reversed?.regionByArea.get(area)?.regionCode,
        forward?.regionByArea.get(area)?.regionCode,
        `row order must not change ${area}'s ${asOf} answer`,
      );
    });
  });

  // ── The boundary day, from both sides ─────────────────────────────────────────────────────────
  // 2026-08-31 is the last day on the old structure; 2026-09-01 is the first on the new one. There
  // is no day that belongs to both and none that belongs to neither.
  const lastAugustDay = buildOperationalRegionMap(withSplitRows(), "2026-08-31", regionNames());
  const firstSeptemberDay = buildOperationalRegionMap(withSplitRows(), MOVE_DATE, regionNames());
  assert.equal(lastAugustDay?.regionByArea.get("UE8")?.regionCode, "OT", "31 August: Qena 2 is still in Others");
  assert.equal(firstSeptemberDay?.regionByArea.get("UE8")?.regionCode, "UE-2", "1 September: Qena 2 is in Upper Egypt 2");
  assert.equal(lastAugustDay?.regionByArea.get("UE5")?.regionCode, "UE", "31 August: Sohag 1 is still in Upper Egypt");
  assert.equal(firstSeptemberDay?.regionByArea.get("UE5")?.regionCode, "UE-2", "1 September: Sohag 1 is in Upper Egypt 2");
}
