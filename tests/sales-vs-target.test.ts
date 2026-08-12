import assert from "node:assert/strict";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import {
  buildTrend,
  coverageRatio,
  growthOf,
  isValidVsTargetPeriod,
  pickLandingPeriod,
  priorPeriodOf,
  rollupBricks,
  rollupByArea,
  rollupByRep,
  shiftPeriod,
  totalRows,
  uploadedPeriodsOf,
  type BrickSalesRow,
  type VsTargetNames,
} from "../src/lib/sales/vs-target.ts";
import {
  filterBricksForBound,
  filterRowsForBound,
  visibleLevelsForBound,
  type VsTargetBound,
} from "../src/lib/sales/vs-target-scope.ts";

const names: VsTargetNames = {
  lineName: (code) => ({ cns: "CNS", pedia: "Pedia", anti_infective: "Anti-infective" })[code] ?? code,
  regionName: (code) => `Region ${code}`,
  areaName: (code) => ({ AB1: "Alexandria 1", CA2: "Nasr City" })[code] ?? code,
  employeeName: (hrId) => ({ "1001": "Mona Farid", "1002": "Youssef Adel" })[hrId] ?? hrId,
};

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-08",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "AB1",
    areaState: null,
    isOther: false,
    repSeatId: null,
    repHrId: "1001",
    dmSeatId: null,
    dmHrId: "1002",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...overrides,
  };
}

function brick(overrides: Partial<BrickSalesRow>): BrickSalesRow {
  return {
    period: "2026-08",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "AB1",
    areaState: null,
    repSeatId: null,
    repHrId: "1001",
    dmSeatId: null,
    dmHrId: "1002",
    brickId: "B1",
    brickName: "Smouha",
    blockCode: null,
    salesUnits: 0,
    salesValue: 0,
    directValue: 0,
    indirectValue: 0,
    ...overrides,
  };
}

export function runSalesVsTargetTests() {
  // ── The July 2026 floor ────────────────────────────────────────────────────
  // June 2026 SoS data really does exist in production, so "the loader would return
  // nothing" is NOT what keeps it out — only this rule does.
  assert.equal(
    priorPeriodOf("2026-07"),
    null,
    "July 2026 is the dashboard's first month and must report no prior period, never fall back to June",
  );
  assert.equal(priorPeriodOf("2026-08"), "2026-07", "August compares against July, the first in-window month");
  assert.equal(isValidVsTargetPeriod("2026-06"), false, "a pre-floor period is refused even though its data exists");
  assert.equal(isValidVsTargetPeriod("2026-07"), true, "the floor month itself is valid");
  assert.equal(isValidVsTargetPeriod("not-a-period"), false, "a malformed period is refused rather than parsed");
  assert.equal(shiftPeriod("2026-12", 1), "2027-01", "shifting across a year boundary rolls the year");
  assert.equal(shiftPeriod("2026-01", -1), "2025-12", "shifting back across a year boundary rolls the year");

  // ── Missing target is null, never zero ─────────────────────────────────────
  // The defect this pins: in 2026-07, 106 of 142 line-area pairs had sales and no
  // target. Rendering those as 0% achievement libels the whole Pedia line.
  const untargeted = totalRows([row({ actualValue: 5000, hasTarget: false })]);
  assert.equal(
    untargeted.achievementValue,
    null,
    "sales with no target yield a null achievement, never 0% — 'no target set' and 'achieved nothing' are different facts",
  );
  assert.equal(untargeted.uncoveredActualValue, 5000, "untargeted sales are counted, not discarded");
  assert.equal(untargeted.coveredActualValue, 0, "untargeted sales never enter the covered bucket");

  // ── Achievement is computed over the COVERED portion only ──────────────────
  const mixed = totalRows([
    row({ actualValue: 800, targetValue: 1000, hasTarget: true }),
    row({ actualValue: 5000, hasTarget: false }),
  ]);
  assert.equal(
    mixed.achievementValue,
    0.8,
    "achievement divides covered actual by target — folding the untargeted 5000 in would read 580% and be meaningless",
  );
  assert.equal(mixed.actualValue, 5800, "total actual still includes the untargeted sales");
  assert.equal(coverageRatio(mixed), 800 / 5800, "coverage reports what share of sales is actually measured");

  // ── Achievement is recomputed from sums, never averaged per row ────────────
  const twoProducts = totalRows([
    row({ actualValue: 100, targetValue: 1000, hasTarget: true }),
    row({ actualValue: 4000, targetValue: 1000, hasTarget: true }),
  ]);
  assert.equal(
    twoProducts.achievementValue,
    4100 / 2000,
    "roll-ups divide summed actual by summed target; averaging the two row percentages (10% and 400%) would give 205%",
  );

  // ── Negative actuals survive ───────────────────────────────────────────────
  // Returns and credit notes are real: Anti-Infective / Haram-Faisal was -32,166 EGP
  // in 2026-07.
  const negative = totalRows([row({ actualValue: -32166, targetValue: 10000, hasTarget: true })]);
  assert.ok(
    negative.achievementValue !== null && negative.achievementValue < 0,
    "a credit-note month yields a negative achievement rather than being clamped to zero",
  );

  // ── Growth ─────────────────────────────────────────────────────────────────
  const current = totalRows([row({ actualValue: 1200 })]);
  const prior = totalRows([row({ actualValue: 1000 })]);
  assert.equal(growthOf(current, prior), 0.2, "growth is the fractional change in actual value");
  assert.equal(growthOf(current, null), null, "no prior period yields null growth, not +100%");
  assert.equal(
    growthOf(current, totalRows([row({ actualValue: 0 })])),
    null,
    "growth from a zero base is null, never Infinity — an infinite percentage is not renderable",
  );

  // ── Roll-ups ───────────────────────────────────────────────────────────────
  const areaNodes = rollupByArea(
    [row({ areaCode: "AB1", actualValue: 300 }), row({ areaCode: "CA2", actualValue: 900 })],
    null,
    names,
  );
  assert.equal(areaNodes.length, 2, "each area becomes one node");
  assert.equal(areaNodes[0].name, "Nasr City", "nodes sort by actual value descending");
  assert.equal(areaNodes[0].key, "CA2", "the key stays the code for drill-down, while the label is the name");
  assert.ok(
    areaNodes.every((node) => node.name !== node.key),
    "a node never renders a raw code as its name — the owner's standing rule",
  );
  assert.equal(areaNodes[0].prior, null, "with no prior rows every node reports a null prior, not an empty total");

  const repNodes = rollupByRep(
    [row({ repHrId: "1001", actualValue: 500 }), row({ repHrId: null, actualValue: 700 })],
    null,
    names,
  );
  assert.equal(repNodes.length, 1, "a row with no resolved occupant is dropped rather than shown under an invented rep");
  assert.equal(repNodes[0].name, "Mona Farid", "reps are shown by name");

  // ── "Not uploaded yet" is not "sold nothing" ───────────────────────────────
  // August 2026 carries targets copied forward from July but no Source-of-Sales upload.
  // Every figure computes to a confident 0, which on the field force's daily dashboard
  // reads as company-wide collapse. This is the guard against that.
  //
  // The guard used to ask "does any row have an actual?", and production answered yes for
  // the wrong reason: on 2026-08-10 Finance booked ONE direct order into August (20 units
  // of Guamusin, 1,309.50 EGP, area GZ1). That single row made August rank as the newest
  // loaded month, and every company-scope viewer opened on 1,309.50 EGP against a
  // 17,508,935 EGP target — 0.0% for every line, region, area and rep. The landing month
  // is now gated on the DISTRIBUTOR upload, which is the only thing that means "month in".
  const uploaded = uploadedPeriodsOf([
    { period: "2026-07", distributor_code: "EG" },
    { period: "2026-07", distributor_code: "Office" },
    // Both direct pseudo-distributors, in the two casings the ledger actually holds.
    { period: "2026-08", distributor_code: "DirectReq" },
    { period: "2026-08", distributor_code: "DIRECT" },
  ]);
  assert.deepEqual([...uploaded], ["2026-07"], "a month carrying only direct-order batches has not been uploaded");

  const targetOnlyMonth = [
    row({ period: "2026-08", actualValue: 0, targetValue: 549702.94, hasTarget: true, hasActual: false }),
  ];
  const directOrderOnly = row({ period: "2026-08", actualValue: 1309.5, targetValue: 4738.5, hasTarget: true, hasActual: true });
  const loadedMonth = [row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true })];

  assert.equal(
    pickLandingPeriod([...loadedMonth, ...targetOnlyMonth, directOrderOnly], uploaded, "2026-08"),
    "2026-07",
    "one direct order booked into an un-uploaded month must not pull the whole dashboard onto that month",
  );
  assert.equal(
    pickLandingPeriod([...loadedMonth, ...targetOnlyMonth], uploaded, "2026-08"),
    "2026-07",
    "the landing month is the newest UPLOADED month with sales, not the newest month that merely has target rows",
  );
  assert.equal(
    pickLandingPeriod(targetOnlyMonth, uploaded, "2026-08"),
    "2026-07",
    "a viewer with no sales anywhere still lands on the newest uploaded month, so the page can say 'nothing in your scope' instead of inventing a 0% month",
  );
  assert.equal(
    pickLandingPeriod([...loadedMonth, directOrderOnly], new Set<string>(), "2026-08"),
    "2026-08",
    "with no month uploaded at all the caller's fallback wins, and the UI renders the not-uploaded panel",
  );

  // ── Trend keeps empty months visible ───────────────────────────────────────
  const trend = buildTrend([row({ period: "2026-08", actualValue: 400 })], ["2026-07", "2026-08"]);
  assert.equal(trend.length, 2, "every requested period gets a point");
  assert.equal(trend[0].actualValue, 0, "a month with no rows renders as a visible zero-height point, not a missing axis tick");
  assert.equal(trend[0].achievementValue, null, "an empty month has no achievement to report");

  // ── Bricks ─────────────────────────────────────────────────────────────────
  const bricks = rollupBricks(
    [
      brick({ brickId: "B1", brickName: "Smouha", salesValue: 300, indirectValue: 300 }),
      brick({ brickId: null, brickName: null, salesValue: 45, indirectValue: 45 }),
    ],
    null,
  );
  assert.equal(bricks.length, 2, "sales with no brick id are kept, so the brick list still sums to the area total");
  const unassigned = bricks.find((entry) => entry.isUnassigned);
  assert.ok(unassigned, "the no-brick bucket exists");
  assert.equal(unassigned.name, "No brick recorded", "the no-brick bucket is labelled, never shown as a raw id");
  assert.equal(
    bricks.reduce((sum, entry) => sum + entry.salesValue, 0),
    345,
    "brick values sum to the area total including the unassigned bucket",
  );

  // ── Scope bounds ───────────────────────────────────────────────────────────
  const mine = row({ repHrId: "1001", areaCode: "AB1", lineCode: "cns", actualValue: 100 });
  const colleague = row({ repHrId: "9999", areaCode: "CA2", lineCode: "cns", actualValue: 900 });
  const otherLine = row({ repHrId: "8888", areaCode: "CA2", lineCode: "pedia", actualValue: 700 });
  const all = [mine, colleague, otherLine];

  // THE regression this dashboard exists to avoid. A Medical Rep's sales scope is SELF,
  // which the shared sales resolvers widen to their whole LINE — that would have shown
  // one rep all 35 reps' numbers.
  const selfBound: VsTargetBound = { kind: "self", hrId: "1001" };
  const selfRows = filterRowsForBound(all, selfBound);
  assert.equal(selfRows.length, 1, "a medical rep sees only rows attributed to them");
  assert.equal(selfRows[0].repHrId, "1001", "and specifically their own rows");
  assert.ok(
    !selfRows.some((entry) => entry.repHrId === "9999"),
    "a rep must never see a colleague's rows even though they share a line and a scope tier",
  );

  const areasBound: VsTargetBound = { kind: "areas", areaCodes: new Set(["AB1"]), lineCodes: new Set(["cns"]) };
  assert.equal(filterRowsForBound(all, areasBound).length, 1, "an area-bounded manager sees only their areas");
  assert.equal(
    filterRowsForBound([row({ areaCode: null, lineCode: "cns", actualValue: 50 })], areasBound).length,
    0,
    "a row with no area cannot be attributed to an area-bounded viewer, so it is withheld",
  );

  const lineBound: VsTargetBound = { kind: "line", lineCodes: new Set(["cns"]) };
  assert.equal(filterRowsForBound(all, lineBound).length, 2, "a line manager sees their whole line and no other");

  assert.equal(filterRowsForBound(all, { kind: "company" }).length, 3, "company scope sees everything");
  assert.equal(
    filterRowsForBound(all, { kind: "none" }).length,
    0,
    "an unresolved viewer sees nothing — an unknown bound must never mean 'everything'",
  );

  // The same bound governs the brick drill-down, so the API cannot out-reach the page.
  const brickRows = [brick({ repHrId: "1001" }), brick({ repHrId: "9999", areaCode: "CA2" })];
  assert.equal(
    filterBricksForBound(brickRows, selfBound).length,
    1,
    "the brick endpoint applies the same self-bound, so a crafted area query cannot reach a colleague's bricks",
  );
  assert.equal(filterBricksForBound(brickRows, { kind: "none" }).length, 0, "an unresolved viewer gets no bricks");

  // ── Level visibility ───────────────────────────────────────────────────────
  assert.equal(visibleLevelsForBound(selfBound).team, false, "a rep has one team, so the team breakdown is noise");
  assert.equal(visibleLevelsForBound(selfBound).brick, true, "a rep does get their bricks");
  assert.equal(visibleLevelsForBound({ kind: "company" }).team, true, "company scope gets every level");
  assert.equal(
    visibleLevelsForBound({ kind: "none" }).area,
    false,
    "a viewer with no territory is offered no levels at all",
  );
}
