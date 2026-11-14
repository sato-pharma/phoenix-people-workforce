import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { HONESTY_SENTENCE, isFaithfulRewrite, templateCoachMessage } from "@/lib/sales/make-it-happen/coach";
import {
  achievementOf,
  buildRealisticMix,
  forecastMonthsOf,
  gradeRows,
  offeredPeriods,
  parseForecastUnits,
  periodKeyOf,
  periodLabel,
  periodMonths,
  readTrend,
  realisticUnits,
  buildGoalMix,
  brickUnitsFor,
  sortBricks,
  splitAcrossBricks,
  type BrickPlanRow,
  type ConcentrationPlanRow,
  type LinePlanGroup,
  type MakeItHappenWorkspace,
} from "@/lib/sales/make-it-happen/engine";
import {
  BRICKS_TAB,
  DISTRICT_MANAGERS_TAB,
  MEDICAL_REPS_TAB,
  NO_AREA,
  NO_DISTRICT_MANAGER,
  NO_REGION,
  VACANT_SEAT,
  buildForecastExportModel,
  buildForecastPdfHtml,
  buildForecastWorkbook,
  forecastExportFilename,
  groupBricksByDistrict,
  groupBricksByRegion,
} from "@/lib/sales/make-it-happen/export-document";
import {
  NO_PLANNER_FILTERS,
  buildPlanScenarios,
  buildStretchMix,
  describePlannerFilters,
  filterPlanLines,
  goalGapValue,
  parseGoalPct,
  pediaHalves,
  parsePlannerFilters,
  repPaceSatoHalf,
  rowFigures,
  scenarioSummary,
  suggestedScenario,
  type PlannerFilters,
} from "@/lib/sales/make-it-happen/scenarios";
import { PlanBricksError, checkPlanBricks } from "@/lib/sales/make-it-happen/plan-bricks";
import {
  applyMakeItHappenBound,
  canUseMakeItHappen,
  isTeamBound,
  makeItHappenBoundLabel,
} from "@/lib/sales/make-it-happen/scope";
import { holdsTargetOrSalesInPeriod, isListedOnTeam, teamRowSatoHalf } from "@/lib/sales/make-it-happen/team-roster";

function row(overrides: Partial<AchievementRow>): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "cns",
    regionCode: "R1",
    areaCode: "A1",
    areaState: "occupied",
    isOther: false,
    repSeatId: null,
    repHrId: "M-1",
    dmSeatId: null,
    dmHrId: "D-1",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...overrides,
  } as AchievementRow;
}

export async function runMakeItHappenTests() {
  // ── Periods ──
  assert.deepEqual(periodMonths("quarter", "2026-Q3"), ["2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(periodMonths("semester", "2026-H2"), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
  assert.equal(periodMonths("quarter", "2026-Q5"), null, "a malformed quarter is refused");
  assert.equal(periodKeyOf("quarter", "2026-11"), "2026-Q4");
  assert.equal(periodKeyOf("semester", "2026-03"), "2026-H1");
  assert.equal(periodLabel("quarter", "2026-Q3"), "Q3 2026 · July to September");
  assert.equal(
    periodLabel("semester", "2026-H2"),
    "Semester 2 2026 · July to December",
    "Semester 1 and 2, never 'half' or H1/H2 (owner, 2026-09-23) — only the key keeps its H",
  );

  // ── A forecast fills only months that carry a target (rule 6) ──
  const closedSet = new Set(["2026-07", "2026-08"]);
  const targetedSet = new Set(["2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(
    forecastMonthsOf(
      ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
      (month) => closedSet.has(month),
      (month) => targetedSet.has(month),
    ),
    { forecast: ["2026-09", "2026-10"], untargeted: ["2026-11", "2026-12"] },
    "Pedia Semester 2 on 2026-10-01: Nov and Dec carry no target, so they are named and never forecast against Jul-Oct targets",
  );
  assert.deepEqual(
    forecastMonthsOf(["2026-10", "2026-11", "2026-12"], () => false, (month) => month === "2026-10"),
    { forecast: ["2026-10"], untargeted: ["2026-11", "2026-12"] },
    "Q4 with only October targeted forecasts October — three months of pace over one month of target read Pedia at 171%",
  );
  assert.deepEqual(
    forecastMonthsOf(["2026-10", "2026-11", "2026-12"], () => false, () => false),
    { forecast: ["2026-10", "2026-11", "2026-12"], untargeted: [] },
    "with no target anywhere there is no achievement to inflate, so the pace fills every open month",
  );
  assert.deepEqual(
    offeredPeriods("month", "2026-09").map((option) => option.value),
    ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
    "months start at July 2026 — January to June are never offered",
  );
  assert.deepEqual(offeredPeriods("quarter", "2026-09").map((option) => option.value), ["2026-Q3", "2026-Q4"]);
  assert.deepEqual(offeredPeriods("semester", "2026-09").map((option) => option.value), ["2026-H2"], "the first half is before the floor");

  // ── Typed units ──
  assert.equal(parseForecastUnits(""), 0);
  assert.equal(parseForecastUnits(" 40 "), 40);
  assert.equal(parseForecastUnits("4.5"), null, "half a box is refused, never rounded");
  assert.equal(parseForecastUnits("-3"), null);
  assert.equal(parseForecastUnits("abc"), null);
  assert.equal(parseForecastUnits("99999999999"), null);

  // ── Grading: the Sales vs Target rule ──
  const graded = gradeRows([
    { period: "2026-07", closed: true, actualUnits: 5, actualValue: 50, targetUnits: 10, targetValue: 100 },
    { period: "2026-07", closed: true, actualUnits: 3, actualValue: 30, targetUnits: null, targetValue: null },
    { period: "2026-08", closed: true, actualUnits: 4, actualValue: 40, targetUnits: null, targetValue: null },
    { period: "2026-09", closed: false, actualUnits: 99, actualValue: 999, targetUnits: 20, targetValue: 200 },
  ]);
  assert.equal(graded.targetValue, 300, "targets count in every month, closed or not");
  assert.equal(graded.actualValue, 120, "an unclosed month's actuals never count");
  assert.equal(graded.gradedValue, 80, "a month the set carries no target in is sold but not graded");
  assert.equal(achievementOf(80, 0, null), null, "no target reads null, never 0%");
  assert.equal(achievementOf(80, 20, 200), 0.5);

  // ── The realistic pace ──
  assert.deepEqual(readTrend([], 2), { kind: "none", historyMonths: 0, spikesIgnored: 0, expectedUnits: 0, realisticMaxUnits: 0 });
  assert.equal(readTrend([0, 0, 0], 2).kind, "none");

  // Scenario 1 (expected) is the MIDDLE of a product's forecast; Scenario 2 (realistic) its UPPER
  // QUARTILE, never above m × its best normal month (engine.ts rule 8, owner 2026-10-01).
  const early = readTrend([90, 110], 2);
  assert.equal(early.kind, "early");
  assert.equal(early.expectedUnits, 200, "fewer than three closed months: the pace is the average of the closed months");
  // s = 20/√2 = 14.142; k = 2, m = 2 → s·√(2 + 4/2) = 28.284; 200 + 0.6745 × 28.284 = 219.08, under the 220 ceiling.
  assert.equal(early.realisticMaxUnits, 219, "the realistic plan is the upper quartile of the same two months — no longer a copy of the pace");
  assert.equal(readTrend([90, 110], 1).realisticMaxUnits, 110, "and never above the best closed month");
  assert.equal(
    realisticUnits({ level: 100, spread: Math.SQRT2 * 10, levelMonths: 2, months: 2, bestMonth: 110, expectedUnits: 200 }),
    219,
    "the formula on its own: m·L + 0.6745 · s · √(m + m²/k), floored, capped at m × best",
  );
  assert.equal(readTrend([150], 2).realisticMaxUnits, 300, "one closed month has no spread, so its realistic plan is honestly its pace");
  assert.equal(readTrend([120, 120], 3).realisticMaxUnits, 360, "two identical months: no spread, no invented room");

  const flat = readTrend([100, 102, 98, 101], 2);
  assert.equal(flat.kind, "flat");
  assert.equal(flat.expectedUnits, 200);
  // Residual spread around the Theil–Sen line is 2.115 (k = 3): 200.667 + 0.6745 × 2.115 × √(2 + 4/3) = 203.27.
  assert.equal(flat.realisticMaxUnits, 203, "a plateau stays a plateau: only its own month-to-month wobble lifts it, and only a little");

  const growing = readTrend([100, 120, 140, 160], 3);
  assert.equal(growing.kind, "growing");
  assert.equal(growing.expectedUnits, 420);
  assert.equal(growing.realisticMaxUnits, 480, "growth may continue, but never above the best normal month");

  const declining = readTrend([200, 180, 160, 140], 2);
  assert.equal(declining.kind, "declining");
  assert.equal(declining.realisticMaxUnits, 280, "a straight decline has no wobble around its own line, so nothing is added");
  assert.equal(declining.expectedUnits, declining.realisticMaxUnits);
  const bumpyDecline = readTrend([300, 260, 280, 200, 230, 190], 3);
  assert.equal(bumpyDecline.kind, "declining");
  assert.ok(bumpyDecline.realisticMaxUnits > bumpyDecline.expectedUnits, "a bumpy decline gets room from its own wobble");
  assert.ok(
    bumpyDecline.realisticMaxUnits <= 230 * 3,
    "but never above its best RECENT month — the 300 it fell from never comes back as a plan",
  );

  const spike = readTrend([100, 100, 1000, 100], 1);
  assert.equal(spike.spikesIgnored, 1, "a one-off bulk month is not a pace");
  assert.equal(spike.realisticMaxUnits, 100);

  // Over many shapes, the realistic plan always sits between the pace and m × the best month.
  let seed = 7;
  const nextRandom = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let trial = 0; trial < 400; trial += 1) {
    const length = 1 + Math.floor(nextRandom() * 6);
    const base = Math.floor(nextRandom() * 900);
    const shape = Array.from({ length }, () => Math.max(0, Math.round(base * (0.4 + nextRandom() * 1.2))));
    const months = 1 + Math.floor(nextRandom() * 6);
    const reading = readTrend(shape, months);
    assert.ok(reading.realisticMaxUnits >= reading.expectedUnits, `realistic never below pace: ${shape.join(",")} over ${months}`);
    assert.ok(reading.realisticMaxUnits <= Math.max(0, ...shape) * months, `realistic never above m × best: ${shape.join(",")} over ${months}`);
  }

  // The owner's report, 2026-10-01: Scenario 1 and Scenario 2 were the same on every screen, because
  // with July and August the only closed months EVERY product was early and capped at its average.
  // Ivyronc on the Pedia line, July 3,432 and August 8,757 units:
  const ivyroncPace = readTrend([3432, 8757], 2);
  assert.equal(ivyroncPace.expectedUnits, 12189, "Scenario 1: the average month, twice");
  assert.equal(ivyroncPace.realisticMaxUnits, 17268, "Scenario 2: the good end of the same months, just under August twice");

  // ── The mix ──
  const items = [
    { key: "A", price: 10, expectedUnits: 10, realisticMaxUnits: 20, unitsStillToTarget: null },
    { key: "B", price: 100, expectedUnits: 1, realisticMaxUnits: 5, unitsStillToTarget: 3 },
  ];
  const reachable = buildRealisticMix(items, 250);
  assert.equal(reachable.reachable, true);
  assert.deepEqual(reachable.units, { A: 10, B: 2 }, "a product still short of its own target is raised first, and only as far as needed");

  const short = buildRealisticMix(items, 1000);
  assert.equal(short.reachable, false, "an out-of-reach target is reported as out of reach");
  assert.deepEqual(short.units, { A: 20, B: 5 }, "never above any product's realistic max");
  assert.equal(short.shortValue, 300);

  const noTarget = buildRealisticMix(items, null);
  assert.equal(noTarget.reachable, null);
  assert.deepEqual(noTarget.units, { A: 10, B: 1 });

  // ── The goal you choose ──
  assert.equal(parseGoalPct(undefined), 100, "no goal sent means the whole target");
  assert.equal(parseGoalPct("90"), 90);
  assert.equal(parseGoalPct(120), 120);
  for (const bad of ["", "0", "301", "90.5", "-10", "ninety"]) {
    assert.equal(parseGoalPct(bad), null, `"${bad}" is refused, never guessed at`);
  }
  assert.equal(goalGapValue({ targetValue: 1000, gradedValue: 300 }, 90), 600, "a 90% goal asks for 90% of target, less sales so far");
  assert.equal(goalGapValue({ targetValue: 1000, gradedValue: 950 }, 90), 0, "a goal already passed asks for nothing more");
  assert.equal(goalGapValue({ targetValue: null, gradedValue: 300 }, 90), null, "no target, no goal");

  // ── The stretch: realistic first, then only the missing value, spread where the business already is ──
  const stretch = buildStretchMix(items, 1000);
  assert.deepEqual(stretch.units, { A: 29, B: 8 });
  assert.deepEqual(stretch.aboveRealistic, { A: 9, B: 3 }, "the stretch names exactly the units above each product's pace");
  assert.equal(stretch.aboveRealisticValue, 390);
  assert.equal(stretch.reachable, true);
  const noStretch = buildStretchMix(items, 250);
  assert.deepEqual(noStretch.units, reachable.units, "when the realistic plan already reaches the goal, the stretch adds nothing");
  assert.equal(noStretch.aboveRealisticValue, 0);

  // ── Scenarios 1, 2 and 3 over a real-shaped workspace ──
  const planRow = (overrides: Partial<ConcentrationPlanRow>): ConcentrationPlanRow => ({
    productCode: "X",
    name: "Product",
    family: "",
    price: 10,
    targetUnits: null,
    targetValue: null,
    actualUnits: 0,
    actualValue: 0,
    gradedUnits: 0,
    gradedValue: 0,
    history: [],
    trend: { kind: "none", historyMonths: 0, spikesIgnored: 0, expectedUnits: 0, realisticMaxUnits: 0 },
    bricks: [],
    ...overrides,
  });
  const alpha = planRow({
    productCode: "A", name: "Alpha", family: "Fam1", price: 10, targetUnits: 100, targetValue: 1000,
    actualUnits: 30, actualValue: 300, gradedUnits: 30, gradedValue: 300,
    trend: { kind: "growing", historyMonths: 4, spikesIgnored: 0, expectedUnits: 10, realisticMaxUnits: 20 },
  });
  const beta = planRow({
    productCode: "B", name: "Beta", family: "Fam2", price: 100, targetUnits: 10, targetValue: 1000,
    actualUnits: 2, actualValue: 200, gradedUnits: 2, gradedValue: 200,
    trend: { kind: "flat", historyMonths: 4, spikesIgnored: 0, expectedUnits: 1, realisticMaxUnits: 5 },
  });
  const gamma = planRow({ productCode: "C", name: "Gamma", family: "Fam1", price: 50 });
  const cnsLine: LinePlanGroup = {
    lineCode: "CNS", lineName: "CNS", remainingMonths: 2, closedMonthLabels: ["Jul"], forecastMonthLabels: ["Aug", "Sep"],
    untargetedMonthLabels: [], targetValue: 2000, gradedValue: 500, actualValue: 500, satoHalf: null, rows: [alpha, beta],
  };
  const pediaLine: LinePlanGroup = {
    lineCode: "PD", lineName: "Pedia", remainingMonths: 0, closedMonthLabels: ["Jul", "Aug", "Sep"], forecastMonthLabels: [],
    untargetedMonthLabels: [], targetValue: null, gradedValue: 0, actualValue: 0, satoHalf: null, rows: [gamma],
  };
  const workspace: MakeItHappenWorkspace = {
    periodKind: "quarter", periodKey: "2026-Q3", periodLabel: "Q3 2026 · July to September",
    offered: { month: [], quarter: [], semester: [] }, scopeLabel: "Your line", isEmptyScope: false, viewingRep: null,
    canSave: true, plansAvailable: true, bricksAvailable: true, lines: [cnsLine, pediaLine],
    totals: { targetValue: 2000, gradedValue: 500, actualValue: 500 }, reps: [], plans: [],
  };

  const [pace, realistic, stretched] = buildPlanScenarios(workspace, 100);
  assert.deepEqual([pace.number, realistic.number, stretched.number], [1, 2, 3]);
  assert.deepEqual(pace.units, { A: 10, B: 1 }, "Scenario 1 keeps every product at its own pace");
  assert.equal(pace.value, 200);
  assert.equal(pace.shortOfGoal, 1300);
  assert.deepEqual(realistic.units, { A: 20, B: 5 }, "Scenario 2 is every product at its own realistic level");
  assert.equal(realistic.aboveSteadyValue, 500, "and it is a DIFFERENT forecast from Scenario 1, by exactly this much");
  assert.equal(realistic.reachesGoal, false);
  assert.equal(realistic.shortOfGoal, 800);
  assert.equal("C" in realistic.units, false, "a closed line is never planned");
  assert.deepEqual(stretched.units, { A: 43, B: 11 });
  assert.equal(stretched.value, 1530);
  assert.equal(stretched.title, "Stretch to your goal", "a goal above the realistic level is named a stretch");
  assert.equal(stretched.reachesGoal, true, "Scenario 3 reaches the goal");
  assert.deepEqual(stretched.aboveRealistic, { A: 23, B: 6 }, "and says exactly how much of it sits above the realistic level");
  assert.equal(suggestedScenario([pace, realistic, stretched]).key, "realistic", "Make It Happen never fills in a stretch");
  const money = (value: number) => `EGP ${value}`;
  assert.ok(scenarioSummary(realistic, 100, money).includes(HONESTY_SENTENCE), "an out-of-reach realistic plan says the owner's sentence");
  assert.match(
    scenarioSummary(stretched, 100, money),
    /above what the products' own months realistically support/,
    "a stretch is never presented as realistic",
  );
  const easyGoal = buildPlanScenarios(workspace, 30);
  assert.equal(easyGoal[1].reachesGoal, true, "a lower goal the pace already covers is reachable");
  assert.deepEqual(easyGoal[1].units, { A: 20, B: 5 }, "and Scenario 2 still shows the realistic level, not a copy of the pace");
  assert.deepEqual(easyGoal[2].units, { A: 10, B: 1 }, "Scenario 3, your goal, raises nothing the goal does not need");
  assert.equal(easyGoal[2].title, "Plan for your goal");
  assert.match(scenarioSummary(easyGoal[2], 30, money), /nothing more is needed/);
  assert.equal(suggestedScenario(easyGoal).key, "stretch", "a goal inside the realistic level is what Make It Happen fills in");
  const midGoal = buildPlanScenarios(workspace, 40);
  assert.equal(midGoal[2].aboveRealisticValue, 0);
  assert.ok(
    midGoal[2].value > midGoal[0].value && midGoal[2].value < midGoal[1].value,
    "a goal between the pace and the realistic level gets a plan between them — three different answers",
  );
  for (const scenario of [...buildPlanScenarios(workspace, 100), ...easyGoal]) {
    assert.doesNotMatch(scenarioSummary(scenario, 100, money), /\bAI\b|artificial|model/i);
  }

  // ── Pedia is planned on two halves (engine.ts rule 7, owner 2026-10-01) ──
  // From Semester 2 2026 Pedia pays one month of basic on Guamusin + Ivyronc alone and one on the
  // whole line. The plan-only mix closed the gap with Lacto — biggest headroom value — and read
  // 100% while the Sato half sat at 50%, below the 90% floor, paying nothing.
  const guamusin = planRow({
    productCode: "GU001", name: "Guamusin", price: 10, targetUnits: 100, targetValue: 1000, gradedUnits: 30, gradedValue: 300,
    trend: { kind: "growing", historyMonths: 4, spikesIgnored: 0, expectedUnits: 20, realisticMaxUnits: 30 },
  });
  const ivyronc = planRow({
    productCode: "IV001", name: "Ivyronc", price: 10, targetUnits: 100, targetValue: 1000, gradedUnits: 30, gradedValue: 300,
    trend: { kind: "growing", historyMonths: 4, spikesIgnored: 0, expectedUnits: 20, realisticMaxUnits: 30 },
  });
  const lacto = planRow({
    productCode: "LA001", name: "Lacto Advanced 1", price: 100, targetUnits: 80, targetValue: 8000, gradedUnits: 30, gradedValue: 3000,
    trend: { kind: "growing", historyMonths: 4, spikesIgnored: 0, expectedUnits: 30, realisticMaxUnits: 60 },
  });
  const splitLine: LinePlanGroup = {
    lineCode: "pedia", lineName: "Pedia", remainingMonths: 2, closedMonthLabels: ["Jul", "Aug"], forecastMonthLabels: ["Sep", "Oct"],
    untargetedMonthLabels: ["Nov", "Dec"], targetValue: 10000, gradedValue: 3600, actualValue: 3600,
    satoHalf: { productCodes: ["GU001", "IV001"], productNames: "Guamusin and Ivyronc", targetValue: 2000, gradedValue: 600 },
    rows: [guamusin, ivyronc, lacto],
  };
  const pediaWorkspace: MakeItHappenWorkspace = {
    ...workspace, lines: [splitLine], totals: { targetValue: 10000, gradedValue: 3600, actualValue: 3600 },
  };
  const splitItems = [guamusin, ivyronc, lacto].map((entry) => ({
    key: entry.productCode, price: entry.price, expectedUnits: entry.trend.expectedUnits,
    realisticMaxUnits: entry.trend.realisticMaxUnits, unitsStillToTarget: (entry.targetUnits ?? 0) - entry.gradedUnits,
  }));
  const planOnly = buildRealisticMix(splitItems, 6400);
  assert.deepEqual(planOnly.units, { GU001: 20, IV001: 20, LA001: 60 }, "the old plan-only rule closes the whole gap with Lacto");

  const satoThenPlan = [
    { key: "sato", gapValue: 1400, codes: new Set(["GU001", "IV001"]) },
    { key: "plan", gapValue: 6400, codes: null },
  ];
  assert.deepEqual(
    buildGoalMix(splitItems, satoThenPlan).units,
    { GU001: 30, IV001: 30, LA001: 58 },
    "the Sato products are raised to their realistic max FIRST, and Lacto only covers what is left of the total",
  );

  const [splitPace, splitRealistic, splitStretch] = buildPlanScenarios(pediaWorkspace, 100);
  assert.deepEqual(splitRealistic.units, { GU001: 30, IV001: 30, LA001: 60 }, "Scenario 2: every product at its realistic level");
  assert.deepEqual(
    splitStretch.units,
    { GU001: 70, IV001: 70, LA001: 58 },
    "Scenario 3, the goal: Sato first, Lacto only for what is left of the total, then the Sato stretch",
  );
  assert.equal(suggestedScenario([splitPace, splitRealistic, splitStretch]).key, "realistic", "a Sato stretch is never filled in for the rep");
  assert.equal(splitRealistic.planReachesGoal, true, "the line total reaches 100%");
  assert.deepEqual(splitRealistic.checks.map((check) => check.key), ["sato"], "Pedia alone: the total half IS the whole plan");
  assert.equal(splitRealistic.checks[0].achievement, 0.6);
  assert.equal(splitRealistic.checks[0].shortOfGoal, 800);
  assert.equal(
    splitRealistic.reachesGoal,
    false,
    "a plan whose Sato half falls short does NOT reach the goal, however good the total looks",
  );
  const realisticText = scenarioSummary(splitRealistic, 100, money);
  assert.ok(realisticText.includes(HONESTY_SENTENCE), "a short Sato half says the owner's sentence");
  assert.match(realisticText, /Sato half · Guamusin and Ivyronc reaches only 60\.0% of its own target, EGP 800 short/);
  assert.equal(splitPace.checks[0].achievement, 0.5);
  assert.match(scenarioSummary(splitPace, 100, money), /Sato half/);
  assert.deepEqual(splitStretch.aboveRealistic, { GU001: 40, IV001: 40 }, "the stretch lands the Sato shortfall on the Sato products, never on Lacto");
  assert.equal(splitStretch.checks[0].reachesGoal, true);
  assert.equal(splitStretch.reachesGoal, true);

  const halvesNow = pediaHalves(pediaWorkspace, { GU001: 20, IV001: 20, LA001: 60 }, 100);
  assert.deepEqual(halvesNow.map((half) => half.label), ["Sato half · Guamusin and Ivyronc", "Total half · all Pedia"]);
  assert.deepEqual(halvesNow.map((half) => half.achievement), [0.5, 1], "the typed plan reads 100% total and 50% Sato — both on screen");
  assert.deepEqual(pediaHalves(workspace, {}, 100), [], "no Pedia split, no halves");

  const mixedLines = buildPlanScenarios({ ...pediaWorkspace, lines: [cnsLine, splitLine], totals: { targetValue: 12000, gradedValue: 4100 } }, 100);
  assert.deepEqual(
    mixedLines[1].checks.map((check) => check.key),
    ["sato", "pedia"],
    "beside another line, the Pedia total is its own half",
  );

  const halfCoach = {
    periodLabel: "Semester 2 2026 · July to December", projectedAchievementLabel: "100.0%", shortValueLabel: null, reachable: true,
    onTrack: false, earlyHistory: false, picks: [{ name: "Lacto Advanced 1", unitsLabel: "58" }],
    halves: [{ label: "Sato half · Guamusin and Ivyronc", achievementLabel: "60.0%", shortValueLabel: "EGP 800" }],
  };
  const halfMessage = templateCoachMessage(halfCoach);
  assert.match(halfMessage, /Sato half · Guamusin and Ivyronc realistically reaches only 60\.0% of its own target, EGP 800 short\./);
  assert.ok(halfMessage.includes(HONESTY_SENTENCE), "a short half carries the owner's sentence even when the total is reached");
  assert.equal(isFaithfulRewrite(halfCoach, halfMessage, halfMessage), true);
  assert.equal(
    isFaithfulRewrite(halfCoach, halfMessage, halfMessage.replace("Sato half · Guamusin and Ivyronc", "The Sato products")),
    false,
    "a rewrite that drops the half's name is refused",
  );

  const splitModel = buildForecastExportModel({
    workspace: pediaWorkspace, units: { GU001: 20, IV001: 20, LA001: 60 }, goalPct: 100, filters: NO_PLANNER_FILTERS,
    now: new Date("2026-10-01T10:00:00Z"),
  });
  assert.equal(splitModel.halves.length, 2);
  const splitHtml = buildForecastPdfHtml(splitModel);
  assert.ok(splitHtml.includes("Sato half"), "the PDF states the Sato half");
  assert.ok(splitHtml.includes("Nov, Dec not forecast, no target yet"), "the PDF names the months it does not forecast");

  // ── The team list shows a Pedia rep's Sato half beside the total (rule 7, owner 2026-10-02) ──
  // splitLine: Sato target 2,000 / graded 600, Guamusin + Ivyronc expected 20 units each at EGP 10 =
  // EGP 400 at pace, so Sato pace achievement = (600 + 400) / 2,000 = 50% — below the 90% floor,
  // while the line total paces far higher. One number would hide that.
  const satoAtPace = repPaceSatoHalf([splitLine]);
  assert.ok(satoAtPace, "a Pedia rep has a Sato half");
  assert.equal(satoAtPace?.hasTarget, true);
  assert.equal(satoAtPace?.achievement, 0.5, "the Sato half at the rep's own steady pace");
  assert.equal(satoAtPace?.productNames, "Guamusin and Ivyronc", "named, never coded");
  assert.equal(repPaceSatoHalf([cnsLine]), null, "a non-Pedia rep has no Sato half");
  const noSatoTarget = repPaceSatoHalf([
    { ...splitLine, satoHalf: { ...splitLine.satoHalf!, targetValue: null } },
  ]);
  assert.equal(noSatoTarget?.hasTarget, false, "no Sato target yet is told apart from a real 0%");
  assert.equal(noSatoTarget?.achievement, null, "and reads null, never 0%");

  // ── The team list names no one who has left unless they hold a target or sales in the period ──
  // 26 Oct 2026: the National Sales Manager read "Everyone 32 · No target 18" and nine of the
  // eighteen had resigned or declined their offer — their closed trend-month rows (Jul–Sep, kept for
  // the pace forecast) put them on a Q4 list. Only the per-person list moves; lines and totals do not.
  const q4 = new Set(["2026-10", "2026-11", "2026-12"]);
  const trendOnly = [row({ period: "2026-08", repHrId: "L-1", actualUnits: 40, actualValue: 4000, targetValue: 5000 })];
  for (const status of ["resigned", "terminated", "declined_offer", "not_renewed"]) {
    assert.equal(
      isListedOnTeam({ employmentStatus: status, repRows: trendOnly, months: q4 }),
      false,
      `a ${status} person with only closed trend months is not on the Q4 team`,
    );
  }
  assert.equal(
    isListedOnTeam({ employmentStatus: "Resigned ", repRows: trendOnly, months: q4 }),
    false,
    "the status is read case- and space-insensitively, as the repo's one rule reads it",
  );
  assert.equal(
    isListedOnTeam({
      employmentStatus: "resigned",
      repRows: [row({ period: "2026-10", repHrId: "L-1", targetValue: 3000 })],
      months: q4,
    }),
    true,
    "a leaver who still holds a Q4 target is listed",
  );
  assert.equal(
    isListedOnTeam({
      employmentStatus: "resigned",
      repRows: [row({ period: "2026-10", repHrId: "L-1", actualUnits: 5 })],
      months: q4,
    }),
    true,
    "a leaver who sold in Q4 is listed",
  );
  assert.equal(
    isListedOnTeam({
      employmentStatus: "resigned",
      repRows: [row({ period: "2026-10", repHrId: "L-1", actualUnits: 0, actualValue: 0 })],
      months: q4,
    }),
    false,
    "an all-zero Q4 row is neither a target nor a sale",
  );
  for (const status of ["active", "on_leave", "", null, undefined]) {
    assert.equal(
      isListedOnTeam({ employmentStatus: status, repRows: trendOnly, months: q4 }),
      true,
      `an employed (or unknown) person stays listed: ${String(status)}`,
    );
  }
  assert.equal(
    isListedOnTeam({ employmentStatus: "active", repRows: [], months: q4 }),
    true,
    "a new hire with no rows yet stays listed",
  );
  assert.equal(holdsTargetOrSalesInPeriod(trendOnly, q4), false);

  // A Pedia person with no Sato product in scope reads Total and Sato like every other Pedia row
  // (Essam Elsayed's row rendered a bare meter without them).
  const noSatoPedia: LinePlanGroup = { ...splitLine, satoHalf: null };
  assert.deepEqual(
    teamRowSatoHalf({ repLines: [noSatoPedia], semester: "2026-S2", satoProductNames: "Guamusin and Ivyronc" }),
    { productNames: "Guamusin and Ivyronc", hasTarget: false, achievement: null },
    "a Pedia person with no Sato product in scope reads 'Sato · No target', not a single meter",
  );
  assert.equal(teamRowSatoHalf({ repLines: [cnsLine], semester: "2026-S2", satoProductNames: "x" }), null, "CNS has no Sato half");
  assert.equal(
    teamRowSatoHalf({ repLines: [noSatoPedia], semester: "2026-S1", satoProductNames: "x" }),
    null,
    "before the split semester there is none",
  );
  assert.equal(
    teamRowSatoHalf({ repLines: [splitLine], semester: "2026-S2", satoProductNames: "x" })?.achievement,
    0.5,
    "a measured half is left exactly as measured",
  );

  // The workspace applies the filter to the PER-PERSON loop only: lines, overall and the pace stay on every row.
  const workspaceSource = readFileSync(path.join(process.cwd(), "src/lib/sales/make-it-happen/workspace.ts"), "utf8");
  assert.ok(workspaceSource.includes("isListedOnTeam({"), "the per-person loop asks isListedOnTeam");
  assert.ok(workspaceSource.includes("const lines = buildLines(rows, brickRows);"), "the lines still read every row, trend months included");
  assert.ok(
    workspaceSource.includes("const overall = gradeRows(rows.filter((row) => monthSet.has(row.period))"),
    "the overall total still reads the selected period's rows without any employment filter",
  );
  assert.ok(workspaceSource.includes("teamRowSatoHalf({"), "the team row's Sato half comes from the shared helper");

  // ── Gap to target, per product ──
  const alphaFigures = rowFigures(alpha, true, 20);
  assert.equal(alphaFigures.gapValue, 500, "target − sold so far − forecast, in value");
  assert.equal(alphaFigures.gapUnits, 50, "and in that product's own units");
  assert.equal(alphaFigures.status, "behind");
  const closedFigures = rowFigures(gamma, false, 5);
  assert.equal(closedFigures.typedUnits, 0, "a closed line forecasts nothing");
  assert.equal(closedFigures.gapValue, null, "no target has no gap, never a zero gap");
  assert.equal(rowFigures(beta, true, 8).gapValue, 0);

  // ── Filters: the same function narrows the screen and the file ──
  const filtersWith = (overrides: Partial<PlannerFilters>): PlannerFilters => ({ ...NO_PLANNER_FILTERS, ...overrides });
  const names = (filters: PlannerFilters, units: Record<string, number> = {}) =>
    filterPlanLines(workspace.lines, filters, units).flatMap((line) => line.rows.map((entry) => entry.row.name));
  assert.deepEqual(names(NO_PLANNER_FILTERS), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(names(filtersWith({ families: ["Fam1"] })), ["Alpha", "Gamma"]);
  assert.deepEqual(names(filtersWith({ lines: ["PD"] })), ["Gamma"]);
  assert.deepEqual(names(filtersWith({ trends: ["growing"] })), ["Alpha"]);
  assert.deepEqual(names(filtersWith({ statuses: ["none"] })), ["Gamma"]);
  assert.deepEqual(names(filtersWith({ planned: "planned" }), { B: 3 }), ["Beta"]);
  assert.deepEqual(names(filtersWith({ planned: "unplanned" }), { B: 3 }), ["Alpha", "Gamma"]);
  assert.deepEqual(names(filtersWith({ gap: "met" }), { B: 8 }), ["Beta"]);
  assert.deepEqual(names(filtersWith({ gap: "short" }), { B: 8 }), ["Alpha"], "no target is neither short nor met");
  assert.deepEqual(names(filtersWith({ search: "bet" })), ["Beta"]);
  assert.deepEqual(names(filtersWith({ sort: "gap" })), ["Beta", "Alpha", "Gamma"], "biggest gap to target first");
  assert.deepEqual(names(filtersWith({ trends: ["rising"] })), [], "an unrecognised trend narrows to nothing, never widens");
  assert.deepEqual(names(filtersWith({ planned: "maybe" })), [], "an unrecognised planned choice narrows to nothing");
  assert.deepEqual(parsePlannerFilters("garbage"), NO_PLANNER_FILTERS);
  assert.deepEqual(parsePlannerFilters({ trends: ["rising", 5] }).trends, ["rising"], "an unknown string is kept so it can match nothing");
  assert.equal(describePlannerFilters(NO_PLANNER_FILTERS, new Map()), null);
  assert.equal(describePlannerFilters(filtersWith({ sort: "gap" }), new Map()), null, "sorting alone is not a filter");
  const stamp = describePlannerFilters(filtersWith({ families: ["Fam1"], lines: ["ZZ"] }), new Map([["CNS", "CNS"]])) ?? "";
  assert.match(stamp, /Family: Fam1/);
  assert.match(stamp, /Unrecognised line/, "a forged line code is named as unrecognised, never printed as a code");

  // ── Exports: same filter, same figures, stamped ──
  const model = buildForecastExportModel({
    workspace,
    units: { A: 20, B: 3 },
    goalPct: 100,
    filters: filtersWith({ families: ["Fam2"] }),
    now: new Date("2026-09-14T10:00:00Z"),
  });
  assert.deepEqual(model.lines.map((line) => line.rows.map((entry) => entry.row.name)), [["Beta"]], "the file holds exactly the filtered rows");
  assert.equal(model.lines[0].forecastValue, 500, "a line total still covers the whole line");
  assert.equal(model.totals.forecastValue, 500);
  assert.equal(model.totals.gapValue, 1000);
  assert.match(model.filterNote ?? "", /Family: Fam2/, "a filtered file says so");
  assert.equal(model.generatedAtLabel.includes("13:00"), true, "stamped in Cairo time, not UTC");
  assert.equal(forecastExportFilename(model, "xlsx"), "make-it-happen-q3-2026-july-to-september-your-line.xlsx");

  const html = buildForecastPdfHtml(model);
  const htmlBody = html.slice(html.indexOf("</style>"));
  assert.ok(htmlBody.includes("Family: Fam2"), "the PDF carries the filter stamp");
  assert.ok(htmlBody.includes("Beta") && !htmlBody.includes("Alpha"), "the PDF shows only the filtered products");
  assert.ok(htmlBody.includes("Gap to target"));
  assert.ok(htmlBody.includes(HONESTY_SENTENCE), "an out-of-reach plan carries the owner's sentence on paper too");
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/, "square edges on paper");
  assert.doesNotMatch(html, /text-overflow/, "wrapping, never an ellipsis");
  assert.doesNotMatch(htmlBody, /\bAI\b|artificial/i);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildForecastWorkbook(model)) as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Cover", "Forecast", BRICKS_TAB, "Scenarios"]);
  const forecastSheet = workbook.getWorksheet("Forecast");
  assert.ok(forecastSheet);
  const texts: string[] = [];
  forecastSheet.eachRow((excelRow) => excelRow.eachCell((cell) => texts.push(String(cell.value ?? ""))));
  assert.ok(texts.some((text) => text.includes("Family: Fam2")), "the workbook carries the filter stamp");
  assert.ok(texts.includes("Beta") && !texts.includes("Alpha"), "the workbook shows only the filtered products");
  assert.ok(texts.includes("Gap to target (value)"));
  let totalRowUnits: unknown = "unfound";
  forecastSheet.eachRow((excelRow) => {
    if (String(excelRow.getCell(1).value ?? "").startsWith("CNS total")) totalRowUnits = excelRow.getCell(9).value;
  });
  assert.ok(totalRowUnits === "" || totalRowUnits == null, "a total row never adds units across products");

  // ── Honest wording, and nothing says AI ──
  const base = { periodLabel: "Q3 2026", earlyHistory: false, onTrack: false, picks: [{ name: "Tebofortine", unitsLabel: "20" }] };
  const messages = [
    templateCoachMessage({ ...base, projectedAchievementLabel: "82.0%", shortValueLabel: "EGP 300", reachable: false }),
    templateCoachMessage({ ...base, projectedAchievementLabel: "100.0%", shortValueLabel: null, reachable: true }),
    templateCoachMessage({ ...base, projectedAchievementLabel: "104.0%", shortValueLabel: null, reachable: true, onTrack: true }),
    templateCoachMessage({ ...base, projectedAchievementLabel: null, shortValueLabel: null, reachable: null }),
  ];
  assert.match(messages[0], /Phoenix is here to support you, not to show you dream numbers/);
  assert.match(messages[1], /Phoenix will make it happen/);
  for (const message of messages) assert.doesNotMatch(message, /\bAI\b|artificial|model/i);

  // ── A rewrite is shown only when it says what the template says ──
  const outOfReach = {
    periodLabel: "Q3 2026 · July to September",
    projectedAchievementLabel: "24.0%",
    shortValueLabel: "EGP 96,264",
    reachable: false,
    onTrack: false,
    earlyHistory: true,
    picks: [
      { name: "Saginko", unitsLabel: "81" },
      { name: "Royafloxacin", unitsLabel: "18" },
    ],
  };
  const outOfReachTemplate = templateCoachMessage(outOfReach);
  assert.equal(isFaithfulRewrite(outOfReach, outOfReachTemplate, outOfReachTemplate), true, "the template is faithful to itself");
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      "Realistically, for Q3 2026 (July to September) you are at 24.0% of target, which means you are EGP 96,264 short, so I am not going to talk about dream numbers. Focus on 81 units of Saginko and 18 units of Royafloxacin.",
    ),
    false,
    "a rewrite measured on 2026-09-14 — honesty sentence dropped, 'you are at', first person — is refused",
  );
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      `Your best for Q3 2026 · July to September is 24.0% of target, EGP 96,264 short. ${HONESTY_SENTENCE}. Put your energy into 81 units of Saginko and 18 units of Royafloxacin.`,
    ),
    true,
    "a warmer rewrite that keeps every figure, name and the honesty sentence is kept",
  );
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      `Your best for Q3 2026 · July to September is 24.0% of target, EGP 96,264 short, maybe 30% with effort. ${HONESTY_SENTENCE}. Focus on 81 units of Saginko and 18 units of Royafloxacin.`,
    ),
    false,
    "a rewrite that adds a number is refused",
  );
  assert.equal(
    isFaithfulRewrite(
      outOfReach,
      outOfReachTemplate,
      `Realistically, for Q3 2026, July to September is 24.0% of target, EGP 96,264 short, so focus on 81 units of Saginko and 18 units of Royafloxacin. ${HONESTY_SENTENCE}, and with only a few closed months, Phoenix will keep each product at its average so far.`,
    ),
    false,
    "a rewrite measured on 2026-09-14 that kept every figure but lost 'your best' — so the percentage no longer says what it means — is refused",
  );

  // ── Rule 9: the forecast per product per brick ──
  const brick = (brickId: string, expectedUnits: number, realisticMaxUnits = expectedUnits): BrickPlanRow => ({
    brickId,
    name: `Brick ${brickId}`,
    expectedUnits,
    realisticMaxUnits,
  });
  const tantaBricks = [brick("b1", 30), brick("b2", 10), brick("b3", 0, 5)];
  assert.deepEqual(
    splitAcrossBricks(100, tantaBricks),
    { b1: 75, b2: 25, b3: 0 },
    "each brick takes its share of the product in proportion to its own pace",
  );
  assert.deepEqual(
    splitAcrossBricks(10, [brick("a", 1), brick("b", 1), brick("c", 1)]),
    { a: 4, b: 3, c: 3 },
    "whole units only, and the unit left over goes to the brick listed first",
  );
  for (const total of [0, 1, 7, 99, 1234, 100_003]) {
    const sum = Object.values(splitAcrossBricks(total, tantaBricks)).reduce((acc, value) => acc + value, 0);
    assert.equal(sum, total, `a product's bricks always add up to its ${total} units`);
  }
  assert.deepEqual(
    splitAcrossBricks(10, [brick("x", 0, 1), brick("y", 0, 3)]),
    { x: 3, y: 7 },
    "with no expected pace on any brick, the realistic pace weights the split",
  );
  assert.deepEqual(splitAcrossBricks(5, [brick("p", 0), brick("q", 0)]), { p: 3, q: 2 }, "no pace at all: an even split, never lost units");
  assert.deepEqual(splitAcrossBricks(10, []), {}, "a product with no brick is planned on its own");
  assert.deepEqual(
    sortBricks([brick("z", 1), brick("m", 9), brick("a", 1)]).map((item) => item.brickId),
    ["m", "a", "z"],
    "bricks list biggest pace first, then by name",
  );
  assert.deepEqual(
    brickUnitsFor(tantaBricks, 100, { b1: 50, b2: 50 }),
    { b1: 50, b2: 50, b3: 0 },
    "a typed split that adds up is kept, and a brick it leaves out reads 0",
  );
  assert.deepEqual(brickUnitsFor(tantaBricks, 100, { b1: 50, b2: 40 }), { b1: 75, b2: 25, b3: 0 }, "a split that does not add up falls back to the pace");
  assert.deepEqual(brickUnitsFor(tantaBricks, 100, { zz: 100 }), { b1: 75, b2: 25, b3: 0 }, "a brick the product never sold on falls back to the pace");

  const alphaOnBricks = { ...alpha, bricks: tantaBricks };
  const brickWorkspace: MakeItHappenWorkspace = {
    ...workspace,
    lines: [{ ...cnsLine, rows: [alphaOnBricks, beta] }, { ...pediaLine, rows: [{ ...gamma, bricks: [brick("g1", 4)] }] }],
  };
  assert.deepEqual(checkPlanBricks(brickWorkspace, { A: 100, B: 3 }, undefined), { A: { b1: 75, b2: 25 } }, "no bricks sent: each product is split by pace, and a product with no brick stores none");
  assert.deepEqual(checkPlanBricks(brickWorkspace, { A: 100 }, { A: { b1: 60, b2: "40" } }), { A: { b1: 60, b2: 40 } }, "a typed split that adds up is stored as typed");
  const refusal = (raw: unknown) => {
    try {
      checkPlanBricks(brickWorkspace, { A: 100 }, raw);
      return "accepted";
    } catch (error) {
      assert.ok(error instanceof PlanBricksError, "a brick refusal is a PlanBricksError the route turns into a 400");
      return (error as Error).message;
    }
  };
  assert.equal(refusal({ A: { b1: 60, b2: 30 } }), "The bricks of Alpha add up to 90 units, not 100.", "the bricks must add up to the product");
  assert.equal(refusal({ A: { zz: 100 } }), "One of the bricks is not one Alpha sells on in your plan.", "a forged brick is refused, never stored");
  assert.equal(refusal({ A: { b1: "1.5", b2: 98 } }), "Units must be whole numbers of zero or more.");
  assert.equal(refusal({ C: { g1: 4 } }), "One of the products is not open in your plan for this period.", "a closed line's bricks cannot be planned");

  const brickModel = buildForecastExportModel({
    workspace: brickWorkspace, units: { A: 100 }, bricks: { A: { b1: 60, b2: 40 } }, goalPct: 100, filters: NO_PLANNER_FILTERS, now: new Date("2026-11-06T12:00:00Z"),
  });
  assert.deepEqual(
    brickModel.bricks.A,
    [
      { name: "Brick b1", units: 60, value: 600 },
      { name: "Brick b2", units: 40, value: 400 },
      { name: "Brick b3", units: 0, value: 0 },
    ],
    "the file lists every brick of the product with its forecast",
  );
  assert.equal(brickModel.bricks.B, undefined, "a product with no brick gets no brick list");
  assert.ok(buildForecastPdfHtml(brickModel).includes("By brick: Brick b1 60 · Brick b2 40"), "the PDF names the planned bricks under the product");
  const brickBook = new ExcelJS.Workbook();
  await brickBook.xlsx.load((await buildForecastWorkbook(brickModel)) as unknown as ArrayBuffer);
  const brickTexts: string[] = [];
  assert.deepEqual(
    brickBook.worksheets.map((sheet) => sheet.name),
    ["Cover", "Forecast", BRICKS_TAB, "Scenarios"],
    "one District Manager and one rep: no District Managers or Medical Reps tab, the Bricks tab alone",
  );
  brickBook.getWorksheet(BRICKS_TAB)?.eachRow((excelRow) => excelRow.eachCell((cell) => brickTexts.push(String(cell.value ?? ""))));
  assert.ok(brickTexts.includes("Brick b1") && brickTexts.includes("60"), "a brick with no named cover is still on the Bricks tab, with its units");
  assert.ok(brickTexts.includes(VACANT_SEAT), "under a Vacant seat, never dropped");
  assert.ok(brickTexts.some((text) => text.startsWith(`${NO_REGION} · ${NO_AREA}`)), "and under No region · No area when its place is not known");

  // ── Owner, 2026-11-14: the brick sheet is one tab per District Manager, then one table per rep ──
  const covered = (
    brickId: string,
    pace: number,
    repName: string | null,
    districtManagerName: string | null,
    areaName: string | null = null,
    regionName: string | null = null,
  ): BrickPlanRow => ({
    ...brick(brickId, pace),
    repName,
    districtManagerName,
    areaName,
    regionName,
  });
  const coverWorkspace: MakeItHappenWorkspace = {
    ...workspace,
    lines: [
      {
        ...cnsLine,
        rows: [
          {
            ...alpha,
            bricks: [
              covered("t1", 30, "Rep Zed", "Manager Bee", "Tanta", "Delta"),
              covered("t2", 10, "Rep Amr", "Manager Bee", "Mansoura", "Delta"),
              covered("t3", 10, null, "Manager Ann", "Assiut", "Upper Egypt"),
            ],
          },
          { ...beta, bricks: [covered("t1", 5, "Rep Zed", "Manager Bee", "Tanta", "Delta"), covered("t4", 5, "Rep Kim", null)] },
        ],
      },
      pediaLine,
    ],
  };
  const coverModel = buildForecastExportModel({
    workspace: coverWorkspace, units: { A: 50, B: 10 }, goalPct: 100, filters: NO_PLANNER_FILTERS, now: new Date("2026-11-14T12:00:00Z"),
  });
  const districts = groupBricksByDistrict(coverModel);
  assert.deepEqual(districts.map((district) => district.name), ["Manager Ann", "Manager Bee", NO_DISTRICT_MANAGER], "District Managers by name, the unnamed bucket last");
  const bee = districts[1];
  assert.deepEqual(bee.reps.map((rep) => rep.name), ["Rep Amr", "Rep Zed"], "then each District Manager's reps by name");
  assert.deepEqual(
    bee.reps[1].rows.map((row) => [row.brick, row.product, row.units]),
    [["Brick t1", "Alpha", 30], ["Brick t1", "Beta", 5]],
    "a rep's table lists that rep's bricks, each brick's products together",
  );
  assert.equal(bee.reps[1].bricks, 1, "a brick counts once however many products it carries");
  assert.equal(bee.value, bee.reps.reduce((sum, rep) => sum + rep.value, 0), "a District Manager's total is the value of the reps, never units");
  assert.deepEqual(districts[0].reps.map((rep) => rep.name), [VACANT_SEAT], "a brick with no rep is named a vacant seat under its District Manager");
  const totalBrickValue = districts.reduce((sum, district) => sum + district.value, 0);
  assert.equal(totalBrickValue, coverModel.lines.reduce((sum, line) => sum + line.forecastValue, 0), "the tabs together hold the whole forecast, nothing lost or doubled");
  const coverBook = new ExcelJS.Workbook();
  await coverBook.xlsx.load((await buildForecastWorkbook(coverModel)) as unknown as ArrayBuffer);
  // ── Owner, 2026-11-14 (later): one tab per LEVEL — District Managers, Medical Reps, then Bricks from region down ──
  assert.deepEqual(
    coverBook.worksheets.map((sheet) => sheet.name),
    ["Cover", "Forecast", DISTRICT_MANAGERS_TAB, MEDICAL_REPS_TAB, BRICKS_TAB, "Scenarios"],
    "a team file carries a District Managers tab, a Medical Reps tab and a Bricks tab, in that order",
  );
  const sheetTexts = (name: string) => {
    const texts: string[] = [];
    coverBook.getWorksheet(name)?.eachRow((excelRow) => excelRow.eachCell((cell) => texts.push(String(cell.value ?? ""))));
    return texts;
  };
  const managerTexts = sheetTexts(DISTRICT_MANAGERS_TAB);
  assert.ok(
    ["Manager Ann", "Manager Bee", NO_DISTRICT_MANAGER].every((name) => managerTexts.includes(name)),
    "every District Manager has a row on the District Managers tab",
  );
  assert.ok(managerTexts.includes("Delta") && managerTexts.includes("Upper Egypt"), "each District Manager's region is named");
  const repTexts = sheetTexts(MEDICAL_REPS_TAB);
  assert.ok(repTexts.includes("Manager Bee · medical reps"), "each District Manager has a table of his reps");
  assert.ok(repTexts.includes("Rep Zed") && repTexts.includes("Rep Kim") && repTexts.includes(VACANT_SEAT), "every rep is listed, a vacant seat too");
  assert.ok(repTexts.includes("Tanta"), "with the area his bricks sit in");

  const regions = groupBricksByRegion(coverModel);
  assert.deepEqual(regions.map((line) => line.lineName), ["CNS"], "one block per line that sold on a brick");
  assert.deepEqual(regions[0].regions.map((region) => region.name), ["Delta", "Upper Egypt", NO_REGION], "regions by name, the unplaced bucket last");
  assert.deepEqual(regions[0].regions[0].areas.map((area) => area.name), ["Mansoura", "Tanta"], "then each region's areas by name");
  const tanta = regions[0].regions[0].areas[1];
  assert.deepEqual(tanta.rows.map((row) => [row.brick, row.product]), [["Brick t1", "Alpha"], ["Brick t1", "Beta"]], "then the area's bricks, each brick's products together");
  assert.equal(tanta.bricks, 1, "a brick counts once however many products it carries");
  assert.equal(regions[0].regions[0].value, regions[0].regions[0].areas.reduce((sum, area) => sum + area.value, 0), "a region's total is its areas' value, never units");
  assert.equal(regions[0].value, totalBrickValue, "the Bricks tab holds the whole brick forecast, nothing lost or doubled");
  const brickTabTexts = sheetTexts(BRICKS_TAB);
  const at = (text: string) => brickTabTexts.indexOf(text);
  assert.ok(at("CNS · by region") >= 0, "the Bricks tab opens on the regions");
  assert.ok(
    at("CNS · by region") < at("CNS · Delta · by area") &&
      at("CNS · Delta · by area") < at("Delta · Mansoura · 1 brick") &&
      at("Delta · Mansoura · 1 brick") < at("CNS · Upper Egypt · by area"),
    "region, then its areas, then each area's bricks, before the next region",
  );

  // A District Manager's own file: no District Managers tab, his reps and his bricks.
  const ownDistrictModel = buildForecastExportModel({
    workspace: {
      ...coverWorkspace,
      lines: [
        {
          ...cnsLine,
          rows: [{ ...alpha, bricks: [covered("t1", 30, "Rep Zed", "Manager Bee", "Tanta", "Delta"), covered("t2", 10, "Rep Amr", "Manager Bee", "Mansoura", "Delta")] }],
        },
      ],
    },
    units: { A: 40 }, goalPct: 100, filters: NO_PLANNER_FILTERS, now: new Date("2026-11-14T12:00:00Z"),
  });
  const ownDistrictBook = new ExcelJS.Workbook();
  await ownDistrictBook.xlsx.load((await buildForecastWorkbook(ownDistrictModel)) as unknown as ArrayBuffer);
  assert.deepEqual(
    ownDistrictBook.worksheets.map((sheet) => sheet.name),
    ["Cover", "Forecast", MEDICAL_REPS_TAB, BRICKS_TAB, "Scenarios"],
    "a District Manager's own file has no District Managers tab",
  );

  // ── Scope ──
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "SFE Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Super Admin"]) {
    assert.equal(canUseMakeItHappen(role), true, `${role} is one of the nine owner-named roles (Regional Manager added 2026-11-14, own region only)`);
  }
  for (const role of ["CEO", "Employee", "HR Operations", null]) {
    assert.equal(canUseMakeItHappen(role), false, `${role ?? "no role"} was not named`);
  }

  const rows = [
    row({ productCode: "p1" }),
    row({ productCode: "P2", lineCode: "pedia" }),
    row({ productCode: "P3", repHrId: "M-2" }),
  ];
  const pmScoped = applyMakeItHappenBound(rows, { rows: { kind: "company" }, productCodes: new Set(["P1", "P3"]), label: "Your products" });
  assert.deepEqual(pmScoped.map((item) => item.productCode), ["p1", "P3"], "a Product Manager plans their own products company-wide");
  const selfScoped = applyMakeItHappenBound(rows, { rows: { kind: "self", hrId: "M-1" } as never, productCodes: null, label: "You" });
  assert.ok(selfScoped.every((item) => item.repHrId === "M-1"), "a medical rep never plans another rep's rows");
  assert.equal(isTeamBound({ rows: { kind: "self", hrId: "M-1" } as never, productCodes: null, label: "" }), false);
  // A Regional Manager plans his own region only: his seat's areas (vs-target-scope.ts), never the line.
  const regionRows = [row({ productCode: "P1", areaCode: "A1" }), row({ productCode: "P1", areaCode: "A2" }), row({ productCode: "P1", areaCode: "B9" })];
  const regionBound = { rows: { kind: "areas", areaCodes: new Set(["A1", "A2"]), lineCodes: new Set(["cns"]) } as never, productCodes: null, label: "Your region" };
  assert.deepEqual(applyMakeItHappenBound(regionRows, regionBound).map((item) => item.areaCode), ["A1", "A2"], "a Regional Manager sees his own region's areas and no other region's");
  assert.equal(isTeamBound(regionBound), true, "and gets the per-rep team view, like a District Manager");
  assert.equal(isTeamBound({ rows: { kind: "company" }, productCodes: null, label: "" }), true);
  assert.equal(makeItHappenBoundLabel({ kind: "line", lineCodes: new Set(["PD"]) }), "Your line");
  assert.equal(
    makeItHappenBoundLabel({ kind: "line", lineCodes: new Set(["AI", "CNS", "PD"]) }),
    "Your lines",
    "a viewer on three lines is never told it is one line",
  );
}
