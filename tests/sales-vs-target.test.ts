import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import {
  buildTrend,
  coverageRatio,
  dropRowsWithNoSalesLine,
  growthOf,
  isValidVsTargetPeriod,
  pickLandingPeriod,
  priorPeriodOf,
  publishedPeriodKeysOf,
  regroupPriorRowsByCurrentMap,
  rollupBricks,
  rollupByArea,
  rollupByDm,
  rollupByRegion,
  rollupByRegionalManager,
  rollupByRep,
  shiftPeriod,
  splitPeriodAtPublication,
  totalRows,
  unitsAreAddable,
  type BrickSalesRow,
  type VsTargetNames,
  type VsTargetNode,
} from "../src/lib/sales/vs-target.ts";
import {
  filterBricksForBound,
  filterRowsForBound,
  visibleLevelsForBound,
  type VsTargetBound,
} from "../src/lib/sales/vs-target-scope.ts";
import { stripComments } from "./support/comment-strip.ts";

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
  assert.equal(untargeted.gradedActualValue, 0, "and a month carrying no target grades nothing");

  // ── INSIDE a month, every pound is graded ──────────────────────────────────
  // Owner ruling 2026-09-05, "FOLLOW THE OLD MONTHLY CLOSING ... MUST BE 100% IDENTICAL": within
  // one month the closing divides ALL sales by the target that was set, untargeted products
  // included. Both rows below sit in the same period and that period carries a target, so the
  // whole 5,800 is graded and the answer is 580%.
  //
  // This assertion read 0.8 until that ruling, on the reasoning that 580% "would be meaningless".
  // It is the Monthly Closing's own number for this shape, and the owner chose it after being
  // shown both readings. Do not restore the 0.8 without his word.
  const mixed = totalRows([
    row({ actualValue: 800, targetValue: 1000, hasTarget: true }),
    row({ actualValue: 5000, hasTarget: false }),
  ]);
  assert.equal(
    mixed.achievementValue,
    5.8,
    "inside a targeted month achievement divides ALL sales by target — 5,800/1,000, the closing's own arithmetic",
  );
  assert.equal(mixed.actualValue, 5800, "total actual still includes the untargeted sales");
  assert.equal(coverageRatio(mixed), 800 / 5800, "coverage still reports what share of sales carries a target of its own");

  // ── ACROSS months, an untargeted month is left out entirely ────────────────
  // The other half of the closing's rule, and the half this screen needs because it spans a
  // WINDOW: the old export's "ALL MONTHS" row divides `SUMIF(target,">0",sales)/SUM(target)`.
  // Without it, Mar–Jun 2026 (sales, no target anywhere) get credited against the targeted months'
  // targets — measured 77.55% against the closing's own 35.26% over Jan–Sep 2026.
  //
  // Same two amounts as `mixed`, but the untargeted 5,000 now sits in its OWN month, which carries
  // no target and is therefore not graded at all.
  const acrossMonths = totalRows([
    row({ period: "2026-07", actualValue: 800, targetValue: 1000, hasTarget: true }),
    row({ period: "2026-08", actualValue: 5000, hasTarget: false }),
  ]);
  assert.equal(
    acrossMonths.achievementValue,
    0.8,
    "a month with no target of its own is excluded from the numerator — 800/1,000, never 5,800/1,000",
  );
  assert.equal(acrossMonths.actualValue, 5800, "its sales are still real money and still reported");
  assert.notEqual(
    acrossMonths.achievementValue,
    mixed.achievementValue,
    "the same two amounts must grade DIFFERENTLY depending on whether they share a month — that is the "
      + "entire across-months rule, and a fixture keeping both in one period cannot see it",
  );

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

  // ── "Not published yet" is not "sold nothing" ──────────────────────────────
  // August 2026 carries targets copied forward from July but no published Monthly Closing.
  // Every figure computes to a confident 0, which on the field force's daily dashboard
  // reads as company-wide collapse. This is the guard against that.
  //
  // The guard used to ask "does any row have an actual?", and production answered yes for
  // the wrong reason: on 2026-08-10 Finance booked ONE direct order into August (20 units
  // of Guamusin, 1,309.50 EGP, area GZ1). That single row made August rank as the newest
  // loaded month, and every company-scope viewer opened on 1,309.50 EGP against a
  // 17,508,935 EGP target — 0.0% for every line, region, area and rep. A later guard gated
  // on the distributor upload landing, but that still showed a month's raw, unclosed figures
  // for up to 12 days before the owner actually published that line's Monthly Closing (July
  // 2026: Anti Infective 2026-08-08, Pedia 2026-08-10, CNS 2026-08-12). The landing month is
  // now gated on PUBLICATION, per line — the only thing that means "this month is done"
  // [owner ruling, 2026-08-13].
  const published = publishedPeriodKeysOf([
    { line: "CNS", period: "2026-07" },
    { line: "Anti Infective", period: "2026-07" },
    // A line whose spelling does not resolve is silently dropped — fail SAFE, never
    // crashes and never silently "publishes everything".
    { line: "Not A Real Line", period: "2026-07" },
  ]);
  assert.deepEqual(
    [...published].sort(),
    ["anti_infective|2026-07", "cns|2026-07"],
    "a publication row keys by lineCode (not the raw official-line spelling), and an unresolvable line is dropped",
  );

  const targetOnlyMonth = [
    row({ period: "2026-08", actualValue: 0, targetValue: 549702.94, hasTarget: true, hasActual: false }),
  ];
  const directOrderOnly = row({ period: "2026-08", actualValue: 1309.5, targetValue: 4738.5, hasTarget: true, hasActual: true });
  const loadedMonth = [row({ period: "2026-07", actualValue: 91784.8, targetValue: 549702.94, hasTarget: true, hasActual: true })];

  assert.equal(
    pickLandingPeriod([...loadedMonth, ...targetOnlyMonth, directOrderOnly], published, "2026-08"),
    "2026-07",
    "one direct order booked into an unpublished month must not pull the whole dashboard onto that month",
  );
  assert.equal(
    pickLandingPeriod([...loadedMonth, ...targetOnlyMonth], published, "2026-08"),
    "2026-07",
    "the landing month is the newest PUBLISHED month with sales, not the newest month that merely has target rows",
  );
  assert.equal(
    pickLandingPeriod(targetOnlyMonth, published, "2026-08"),
    "2026-07",
    "a viewer with no sales anywhere still lands on the newest published month, so the page can say 'nothing in your scope' instead of inventing a 0% month",
  );
  assert.equal(
    pickLandingPeriod([...loadedMonth, directOrderOnly], new Set<string>(), "2026-08"),
    "2026-08",
    "with nothing published at all the caller's fallback wins, and the UI renders the not-published panel",
  );

  // ── An unpublished month quotes its TARGET, never its sales ────────────────
  // Confirmed on production 2026-09-16: a CNS medical rep's September 2026 carried a 300,085.04 EGP
  // target, yet the not-published panel's "A target of … is already loaded" sentence could never
  // render. It read `totals.targetValue`, and `totals` is built from PUBLISHED rows only — so for an
  // unpublished month it is 0 by construction. The target now comes from the raw rows of the month,
  // while the publication gate itself stays exactly as it was.
  const septemberTargets = [
    row({ period: "2026-09", productCode: "P1", targetValue: 180_050.02, hasTarget: true, hasActual: false }),
    row({ period: "2026-09", productCode: "P2", targetValue: 120_035.02, hasTarget: true, hasActual: false }),
  ];
  // Real money already sitting in the unpublished month, so "no sales quoted" is tested against a
  // month that HAS sales to leak rather than one with nothing to leak.
  const septemberSale = row({ period: "2026-09", productCode: "P3", actualValue: 9_876.5, hasActual: true });
  const unpublishedSeptember = splitPeriodAtPublication([...septemberTargets, septemberSale], published);
  assert.equal(unpublishedSeptember.salesLoaded, false, "September has no published closing, so its sales are not loaded");
  assert.equal(
    unpublishedSeptember.pendingTargetValue,
    300_085.04,
    "THE HEADLINE: an unpublished month with targeted rows must quote the target already loaded for it — " +
      "0 here is the not-published panel's target sentence never rendering",
  );
  assert.deepEqual(
    unpublishedSeptember.rows,
    [],
    "no row of an unpublished month crosses the publication gate — the gate is unchanged by the fix",
  );
  assert.equal(
    totalRows(unpublishedSeptember.rows).actualValue,
    0,
    "so the sales the dashboard quotes for an unpublished month stay empty: the target is quoted, the sales are not",
  );
  assert.equal(
    totalRows(unpublishedSeptember.rows).targetValue,
    0,
    "and the published totals' own target is 0 here too, which is exactly why the panel cannot quote it",
  );
  assert.ok(
    !JSON.stringify(unpublishedSeptember).includes("9876.5"),
    "the 9,876.50 sitting in the unpublished month leaves the split under no name at all (owner, 2026-11-04)",
  );

  const publishedJuly = splitPeriodAtPublication(loadedMonth, published);
  assert.equal(publishedJuly.salesLoaded, true, "a published month loads its sales");
  assert.deepEqual(publishedJuly.rows, loadedMonth, "every row of a published month crosses the gate");
  assert.equal(
    publishedJuly.pendingTargetValue,
    0,
    "a published month quotes its target in the totals, never a second time as a pending figure",
  );

  // The figure is worthless if the panel stops reading it, and no unit test can render the dashboard (a
  // .tsx client component this runner cannot load). Pinned by reading the source whole-file, comments
  // stripped, and slicing on the panel's own branch markers rather than a byte window.
  const dashboardSource = stripComments(readFileSync(
    new URL("../src/components/sales/vs-target/vs-target-dashboard.tsx", import.meta.url),
    "utf8",
  ));
  const panelStart = dashboardSource.indexOf("{!data.salesLoaded ? (");
  const panelEnd = dashboardSource.indexOf(") : data.isEmptyScope ? (", panelStart);
  assert.ok(
    panelStart !== -1 && panelEnd > panelStart,
    "the not-published panel is the `!data.salesLoaded` branch ahead of the empty-scope branch — re-point this " +
      "check at wherever the panel moved, never drop it",
  );
  const notPublishedPanel = dashboardSource.slice(panelStart, panelEnd);
  assert.ok(
    notPublishedPanel.includes("formatEgpFull(data.pendingTargetValue)"),
    "the not-published panel must quote pendingTargetValue — the only target an unpublished month carries",
  );
  assert.ok(
    !notPublishedPanel.includes("data.totals."),
    "the not-published panel must read nothing from `totals`: its target is always 0 there, and its sales are " +
      "exactly what the publication gate withholds",
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
  // ── Head Office never reaches an achievement number ────────────────────────
  // Measured on production 2026-09-01: `au.f_monthly_attribution`'s unmapped branch returned 104
  // rows carrying NO line at all across 2026-01 … 2026-07 — every one of them RY001
  // ROYANOXICAM 8MG 20 TAB, whose line is Head Office — worth 10,458.00 EGP. Monthly Closing never
  // books Head Office, so every company total taken from this loader read HIGH by that amount while
  // the closing read correct. The golden rule is that Head Office is FILTERED, never mapped.
  const withHeadOffice = [
    { lineCode: "anti_infective", areaCode: "D23", actualValue: 55_407.6 },
    { lineCode: null, areaCode: "AB4", actualValue: 714 },
    { lineCode: "   ", areaCode: "D14", actualValue: 462 },
    { lineCode: "", areaCode: "CA4", actualValue: 252 },
    { lineCode: "pedia", areaCode: "GZ3", actualValue: 12_705.75 },
  ];
  const lined = dropRowsWithNoSalesLine(withHeadOffice);
  assert.deepEqual(
    lined.map((row) => row.areaCode),
    ["D23", "GZ3"],
    "THE HEADLINE: a row carrying no sales line is Head Office money that Monthly Closing never " +
      "books. It must be dropped — null, empty AND whitespace-only alike — or the dashboard, the " +
      "portal, Business Review and Employee 360 all quote a company total the closing disagrees with.",
  );
  assert.equal(
    lined.reduce((sum, row) => sum + row.actualValue, 0),
    68_113.35,
    "the money that survives is exactly the lined money — dropping must never touch a real line",
  );
  assert.deepEqual(dropRowsWithNoSalesLine([]), [], "an empty range drops to an empty range, never throws");

  // The filter is worthless if the loader stops calling it, and no unit test can see that wiring —
  // the loader needs a database. Pinned by reading the source, whole-file, never a byte window.
  const vsTargetSource = readFileSync(new URL("../src/lib/sales/vs-target.ts", import.meta.url), "utf8");
  assert.ok(
    vsTargetSource.includes("return dropRowsWithNoSalesLine(rows.map((row) => ({"),
    "loadAchievementRangeUncached must wrap its mapper in dropRowsWithNoSalesLine — filtering BEFORE " +
      "the cache, so a cached range can never replay the Head Office leak",
  );

  runRegionalManagerRollupTests();
  runPriorMonthRehomeAndUnitsTests();
}

/**
 * Owner, 2026-10-20: Sales vs Target had District Managers and no Regional Manager level. The
 * Regional Manager node may only ever be the SUM of the District Manager nodes beneath him — sales
 * value, target value and graded actual — with his % recomputed from those sums.
 */
function runRegionalManagerRollupTests() {
  // DM 2001 and DM 2002 sit under Regional Manager 3001; DM 2003 reports straight to the NSM; the
  // vacant district (no dmHrId) sits under 3001's seat too but has no District Manager row.
  const rsmOfSeat: Record<string, string> = { "DM-A": "3001", "DM-B": "3001", "DM-V": "3001" };
  const regionalManagerOf = (entry: AchievementRow) => (entry.dmSeatId ? rsmOfSeat[entry.dmSeatId] ?? null : null);
  const rmNames: VsTargetNames = {
    ...names,
    employeeName: (hrId) => ({ "3001": "Rania Regional", "2001": "Dina A", "2002": "Dalia B" })[hrId] ?? hrId,
  };

  const current: AchievementRow[] = [
    // DM-A: two products, one month with a target.
    row({ dmSeatId: "DM-A", dmHrId: "2001", productCode: "P1", actualValue: 1000, targetValue: 1200, hasTarget: true }),
    row({ dmSeatId: "DM-A", dmHrId: "2001", productCode: "P2", actualValue: 300, targetValue: null, hasTarget: false }),
    // DM-B: a month it carries a target in, and an earlier month it carries none in — graded per
    // district, exactly as the District Managers level grades him.
    row({ dmSeatId: "DM-B", dmHrId: "2002", actualValue: 500, targetValue: 1000, hasTarget: true }),
    row({ period: "2026-07", dmSeatId: "DM-B", dmHrId: "2002", actualValue: 700, targetValue: null, hasTarget: false }),
    // DM-A in July with a target: if the RM were graded on his own pooled months, DM-B's untargeted
    // July would leak into his numerator. Summing the district totals keeps it out.
    row({ period: "2026-07", dmSeatId: "DM-A", dmHrId: "2001", actualValue: 50, targetValue: 100, hasTarget: true }),
    // Vacant district under him, and a district outside his region — neither is his.
    row({ dmSeatId: "DM-V", dmHrId: null, actualValue: 9999, targetValue: 9999, hasTarget: true }),
    row({ dmSeatId: "DM-C", dmHrId: "2003", actualValue: 4000, targetValue: 5000, hasTarget: true }),
  ];
  const prior: AchievementRow[] = [
    row({ period: "2026-07", dmSeatId: "DM-A", dmHrId: "2001", actualValue: 800, targetValue: 900, hasTarget: true }),
    row({ period: "2026-07", dmSeatId: "DM-B", dmHrId: "2002", actualValue: 200, targetValue: 400, hasTarget: true }),
  ];

  const regional = rollupByRegionalManager(current, prior, rmNames, regionalManagerOf);
  assert.equal(regional.length, 1, "one Regional Manager, one node");
  const [node] = regional;
  assert.equal(node.key, "3001");
  assert.equal(node.name, "Rania Regional", "a Regional Manager is shown by name, never by HR id");

  const dmNodes = rollupByDm(current, prior, rmNames).filter((dm) => dm.key === "2001" || dm.key === "2002");
  const sum = (pick: (totals: VsTargetNode["current"]) => number) =>
    dmNodes.reduce((total, dm) => total + pick(dm.current), 0);
  assert.equal(node.current.actualValue, sum((totals) => totals.actualValue), "his sales are his districts' sales added up");
  assert.equal(node.current.targetValue, sum((totals) => totals.targetValue), "his target is his districts' targets added up");
  assert.equal(node.current.gradedActualValue, sum((totals) => totals.gradedActualValue));
  assert.equal(
    node.current.achievementValue,
    sum((totals) => totals.gradedActualValue) / sum((totals) => totals.targetValue),
    "his % is recomputed from the summed figures, never an average of his districts' percentages",
  );
  assert.equal(node.current.actualValue, 1000 + 300 + 500 + 700 + 50, "the vacant district and the NSM's own district are not his");
  assert.equal(node.prior?.actualValue, 800 + 200, "the prior month is summed the same way");
  assert.equal(node.growth, (2550 - 1000) / 1000);

  // No Regional Manager anywhere → no level at all, never an empty row.
  assert.deepEqual(rollupByRegionalManager(current, null, rmNames, () => null), []);

  // Wiring the unit tests cannot see: the page builder reads the seat tree for company and line
  // viewers only, and the dashboard offers the level only when it has rows.
  const pageSource = stripComments(readFileSync(new URL("../src/lib/sales/vs-target-page.ts", import.meta.url), "utf8"));
  assert.ok(
    /resolved\.kind === "company" \|\| resolved\.kind === "line" \? loadSalesSeatTree\(\)/.test(pageSource),
    "the Regional Managers level is built for a company or line viewer only",
  );
  assert.ok(
    /regionalManagers: rollupByRegionalManager\(rows, priorRows, names,/.test(pageSource),
    "the dashboard payload carries the Regional Managers roll-up of the scoped, published rows",
  );
  const dashboardSource = stripComments(
    readFileSync(new URL("../src/components/sales/vs-target/vs-target-dashboard.tsx", import.meta.url), "utf8"),
  );
  assert.ok(
    dashboardSource.includes('if (data.regionalManagers.length > 0) levels.push("regionalManagers");'),
    "the Regional Managers chip appears whenever the payload has Regional Manager rows",
  );
}

/**
 * National Sales Manager, September 2026.
 *
 *  • Anti Infective's areas moved into Upper Egypt 1 and Upper Egypt 2 in September. August's rows
 *    still carried the old region and district manager, so the two regions and their District
 *    Managers (Osama Mohamed El-said, Mohamed Ramadan) found no August node and printed "—" vs Aug.
 *  • The Pedia tile printed "Units sold 20,521 / Target 38,503" — Guamusin 698 + Ivyronc 10,642 +
 *    Lacto Advanced 1 5,561 + Lacto Advanced 2 3,620, units of four different products added.
 */
function runPriorMonthRehomeAndUnitsTests() {
  const september = [
    row({ period: "2026-09", regionCode: "UE-1", areaCode: "MN1", dmSeatId: "DM-UE1", dmHrId: "1002", actualValue: 900 }),
    row({ period: "2026-09", regionCode: "UE-2", areaCode: "LX1", dmSeatId: "DM-UE2", dmHrId: "1001", actualValue: 400 }),
  ];
  const august = [
    // August: both areas under the old single Upper Egypt region and its old District Manager.
    row({ period: "2026-08", regionCode: "UE", areaCode: "mn1 ", dmSeatId: "DM-UE", dmHrId: "9999", actualValue: 600 }),
    row({ period: "2026-08", regionCode: "UE", areaCode: "LX1", dmSeatId: "DM-UE", dmHrId: "9999", actualValue: 500 }),
    // Direct Orders spread by region carry no area — they keep their own keys.
    row({ period: "2026-08", regionCode: "UE", areaCode: null, dmSeatId: null, dmHrId: null, actualValue: 70 }),
    // An area September does not carry keeps its own keys too.
    row({ period: "2026-08", regionCode: "UE", areaCode: "OLD9", dmSeatId: "DM-UE", dmHrId: "9999", actualValue: 30 }),
  ];
  const regrouped = regroupPriorRowsByCurrentMap(september, august);
  assert.ok(regrouped, "a prior month in gives a prior month out");

  const regions = rollupByRegion(september, regrouped, names);
  const ue1 = regions.find((node) => node.key === "UE-1");
  const ue2 = regions.find((node) => node.key === "UE-2");
  assert.equal(ue1?.prior?.actualValue, 600, "Upper Egypt 1 compares with its own areas' August, not \"—\"");
  assert.equal(ue2?.prior?.actualValue, 500, "and so does Upper Egypt 2");
  assert.ok(ue1?.growth != null && Math.abs(ue1.growth - 0.5) < 1e-9, "900 over 600 is +50%, a real figure");

  const managers = rollupByDm(september, regrouped, names);
  assert.equal(
    managers.find((node) => node.key === "1002")?.prior?.actualValue,
    600,
    "the District Manager who holds Minia 1 now is compared with Minia 1's August",
  );
  assert.equal(managers.find((node) => node.key === "1001")?.prior?.actualValue, 500, "and the other with Luxor's");

  assert.deepEqual(regrouped[2], august[2], "a prior row with no area keeps its own region");
  assert.deepEqual(regrouped[3], august[3], "an area the selected month does not carry keeps its own keys");
  assert.equal(
    totalRows(regrouped).actualValue,
    totalRows(august).actualValue,
    "re-homing moves keys only — the prior month's own total is unchanged",
  );
  assert.equal(regroupPriorRowsByCurrentMap(september, null), null, "no prior month stays no prior month");
  assert.equal(
    regroupPriorRowsByCurrentMap(september, august.map((entry) => ({ ...entry, lineCode: "pedia" })))?.[0].regionCode,
    "UE",
    "an area is matched on its own line only",
  );

  // ── Units are shown only for ONE product code ─────────────────────────────────────────────────
  const pedia = [
    row({ productCode: "GUA01", actualUnits: 698 }),
    row({ productCode: "IVY01", actualUnits: 10_642 }),
    row({ productCode: "LAA01", actualUnits: 5_561 }),
    row({ productCode: "LAA02", actualUnits: 3_620 }),
  ];
  assert.equal(unitsAreAddable(pedia), false, "four products' units are never one figure (the 20,521)");
  assert.equal(unitsAreAddable(pedia.slice(1, 2)), true, "one product's units are a real quantity");
  assert.equal(
    unitsAreAddable([row({ productCode: "IVY01" }), row({ productCode: "ivy01 " })]),
    true,
    "the same code twice is still one product",
  );
  assert.equal(unitsAreAddable([]), false, "no rows give no units figure");

  // The page wires both, and the tile is gated on the flag — pinned in the source, comments stripped.
  const pageSource = stripComments(readFileSync(new URL("../src/lib/sales/vs-target-page.ts", import.meta.url), "utf8"));
  assert.ok(
    pageSource.includes("regroupPriorRowsByCurrentMap(") && pageSource.includes("unitsAddable: unitsAreAddable(rows)"),
    "the Sales vs Target loader re-homes the prior month and decides the units flag from the rows in view",
  );
  const dashboardSource = stripComments(
    readFileSync(new URL("../src/components/sales/vs-target/vs-target-dashboard.tsx", import.meta.url), "utf8"),
  );
  assert.equal(
    dashboardSource.split("data.unitsAddable ?").length - 1,
    2,
    "both Units sold tiles (portal and admin) are shown only when the units may be added",
  );
  for (const [file, source] of [
    ["vs-target-dashboard.tsx", dashboardSource],
    [
      "targets-workspace.tsx",
      readFileSync(new URL("../src/components/sales/targets-workspace.tsx", import.meta.url), "utf8"),
    ],
  ] as const) {
    assert.ok(
      !source.includes("counts only sales that have a target"),
      `${file} no longer claims achievement counts only targeted sales — it divides every sale in a targeted month`,
    );
  }
}
