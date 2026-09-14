import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import type { AchievementRow } from "@/lib/sales/monthly-targets";
import { HONESTY_SENTENCE, isFaithfulRewrite, templateCoachMessage } from "@/lib/sales/make-it-happen/coach";
import {
  achievementOf,
  buildRealisticMix,
  gradeRows,
  offeredPeriods,
  parseForecastUnits,
  periodKeyOf,
  periodLabel,
  periodMonths,
  readTrend,
  type ConcentrationPlanRow,
  type LinePlanGroup,
  type MakeItHappenWorkspace,
} from "@/lib/sales/make-it-happen/engine";
import {
  buildForecastExportModel,
  buildForecastPdfHtml,
  buildForecastWorkbook,
  forecastExportFilename,
} from "@/lib/sales/make-it-happen/export-document";
import {
  NO_PLANNER_FILTERS,
  buildPlanScenarios,
  buildStretchMix,
  describePlannerFilters,
  filterPlanLines,
  goalGapValue,
  parseGoalPct,
  parsePlannerFilters,
  rowFigures,
  scenarioSummary,
  type PlannerFilters,
} from "@/lib/sales/make-it-happen/scenarios";
import {
  applyMakeItHappenBound,
  canUseMakeItHappen,
  isTeamBound,
  makeItHappenBoundLabel,
} from "@/lib/sales/make-it-happen/scope";

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

  const early = readTrend([90, 110], 2);
  assert.equal(early.kind, "early");
  assert.equal(early.expectedUnits, 200, "fewer than three closed months: the average of the closed months");
  assert.equal(early.realisticMaxUnits, 200, "and never above that average (owner choice)");

  const flat = readTrend([100, 102, 98, 101], 2);
  assert.equal(flat.kind, "flat");
  assert.equal(flat.expectedUnits, 200);
  assert.equal(flat.realisticMaxUnits, 200, "a plateau stays a plateau");

  const growing = readTrend([100, 120, 140, 160], 3);
  assert.equal(growing.kind, "growing");
  assert.equal(growing.expectedUnits, 420);
  assert.equal(growing.realisticMaxUnits, 480, "growth may continue, but never above the best normal month");

  const declining = readTrend([200, 180, 160, 140], 2);
  assert.equal(declining.kind, "declining");
  assert.equal(declining.realisticMaxUnits, 280, "a decline is held at its recent level, never inflated");
  assert.equal(declining.expectedUnits, declining.realisticMaxUnits);

  const spike = readTrend([100, 100, 1000, 100], 1);
  assert.equal(spike.spikesIgnored, 1, "a one-off bulk month is not a pace");
  assert.equal(spike.realisticMaxUnits, 100);

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
    targetValue: 2000, gradedValue: 500, actualValue: 500, rows: [alpha, beta],
  };
  const pediaLine: LinePlanGroup = {
    lineCode: "PD", lineName: "Pedia", remainingMonths: 0, closedMonthLabels: ["Jul", "Aug", "Sep"], forecastMonthLabels: [],
    targetValue: null, gradedValue: 0, actualValue: 0, rows: [gamma],
  };
  const workspace: MakeItHappenWorkspace = {
    periodKind: "quarter", periodKey: "2026-Q3", periodLabel: "Q3 2026 · July to September",
    offered: { month: [], quarter: [], semester: [] }, scopeLabel: "Your line", isEmptyScope: false, viewingRep: null,
    canSave: true, plansAvailable: true, lines: [cnsLine, pediaLine],
    totals: { targetValue: 2000, gradedValue: 500, actualValue: 500 }, reps: [], plans: [],
  };

  const [pace, realistic, stretched] = buildPlanScenarios(workspace, 100);
  assert.deepEqual([pace.number, realistic.number, stretched.number], [1, 2, 3]);
  assert.deepEqual(pace.units, { A: 10, B: 1 }, "Scenario 1 keeps every product at its own pace");
  assert.equal(pace.value, 200);
  assert.equal(pace.shortOfGoal, 1300);
  assert.deepEqual(realistic.units, { A: 20, B: 5 }, "Scenario 2 never plans above a product's realistic max");
  assert.equal(realistic.reachesGoal, false);
  assert.equal(realistic.shortOfGoal, 800);
  assert.equal("C" in realistic.units, false, "a closed line is never planned");
  assert.deepEqual(stretched.units, { A: 43, B: 11 });
  assert.equal(stretched.value, 1530);
  assert.equal(stretched.reachesGoal, true, "Scenario 3 reaches the goal");
  assert.deepEqual(stretched.aboveRealistic, { A: 23, B: 6 }, "and says exactly how much of it sits above the pace");
  const money = (value: number) => `EGP ${value}`;
  assert.ok(scenarioSummary(realistic, 100, money).includes(HONESTY_SENTENCE), "an out-of-reach realistic plan says the owner's sentence");
  assert.match(scenarioSummary(stretched, 100, money), /above what the products' own pace supports/, "a stretch is never presented as realistic");
  const easyGoal = buildPlanScenarios(workspace, 30);
  assert.equal(easyGoal[1].reachesGoal, true, "a lower goal the pace already covers is reachable");
  assert.deepEqual(easyGoal[1].units, { A: 10, B: 1 }, "and nothing is raised to reach it");
  assert.match(scenarioSummary(easyGoal[2], 30, money), /No stretch needed/);
  for (const scenario of [...buildPlanScenarios(workspace, 100), ...easyGoal]) {
    assert.doesNotMatch(scenarioSummary(scenario, 100, money), /\bAI\b|artificial|model/i);
  }

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
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Cover", "Forecast", "Scenarios"]);
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

  // ── Scope ──
  for (const role of ["Medical Rep", "District Manager", "National Sales Manager", "SFE Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Super Admin"]) {
    assert.equal(canUseMakeItHappen(role), true, `${role} is one of the eight owner-named roles`);
  }
  for (const role of ["CEO", "Regional Manager", "Employee", "HR Operations", null]) {
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
  assert.equal(isTeamBound({ rows: { kind: "company" }, productCodes: null, label: "" }), true);
  assert.equal(makeItHappenBoundLabel({ kind: "line", lineCodes: new Set(["PD"]) }), "Your line");
  assert.equal(
    makeItHappenBoundLabel({ kind: "line", lineCodes: new Set(["AI", "CNS", "PD"]) }),
    "Your lines",
    "a viewer on three lines is never told it is one line",
  );
}
