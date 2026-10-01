// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the goal you choose, the three scenarios, and the filters.
//
// Pure, like engine.ts. The planner runs these on every click, and the export route runs the SAME
// functions over figures it rebuilt from the database — so a downloaded file can never show a
// different slice, a different gap or a different scenario from the screen it was exported from.
//
// Owner requests 2026-09-14: "add a column gap to target", "make me choose the achievement % I want
// and makes Phoenix do the plan", "give scenario 1 and 2 and 3", "filter by almost anything",
// "export xlsx forecast or polish pdf".
//
// Three DIFFERENT answers (owner, 2026-10-01: Scenarios 1 and 2 had been identical on every screen):
//   1. Steady pace    — every product keeps its own month-by-month pace: the MIDDLE of its forecast.
//   2. Realistic plan — every product at the good end of its own months: the UPPER QUARTILE of the
//                       same forecast, never above its best normal month (engine.ts rule 8). It does
//                       not bend toward the goal — it says whether it reaches it, in the owner's words
//                       when it does not.
//   3. Your goal      — what reaching YOUR goal takes: only the products it needs, raised within
//                       their realistic level (the Sato products first on Pedia). When that is not
//                       enough it becomes a Stretch, says exactly how much sits ABOVE the realistic
//                       level, and is never presented as realistic.
// "Make It Happen" fills in Scenario 3 when it is realistic, Scenario 2 otherwise — never a stretch.
// Units are never added across products here either: every total is VALUE.
// ─────────────────────────────────────────────────────────────────────────────

import {
  HONESTY_SENTENCE,
  achievementOf,
  buildGoalStretchMix,
  type ConcentrationPlanRow,
  type LinePlanGroup,
  type MixGoal,
  type MixItem,
  type MixResult,
  type RepSatoHalf,
  type TrendKind,
  type TrendReading,
} from "@/lib/sales/make-it-happen/engine";

// ── The goal ─────────────────────────────────────────────────────────────────

export const DEFAULT_GOAL_PCT = 100;
export const MIN_GOAL_PCT = 1;
export const MAX_GOAL_PCT = 300;
export const GOAL_PRESETS: readonly number[] = [80, 90, 100, 110, 120];

/**
 * A chosen achievement goal, as a whole percentage of target.
 * Absent means the default 100%; an empty box or anything outside 1–300 is null, so the caller
 * refuses it rather than silently planning for a goal nobody picked.
 */
export function parseGoalPct(raw: unknown): number | null {
  if (raw === undefined || raw === null) return DEFAULT_GOAL_PCT;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
  if (text == null || !/^\d{1,3}$/.test(text)) return null;
  const value = Number(text);
  return value >= MIN_GOAL_PCT && value <= MAX_GOAL_PCT ? value : null;
}

/** Value still needed to reach `goalPct` of target after sales so far. null when there is no target. */
export function goalGapValue(
  totals: { targetValue: number | null; gradedValue: number },
  goalPct: number,
): number | null {
  if (totals.targetValue == null) return null;
  return Math.max(0, (totals.targetValue * goalPct) / 100 - totals.gradedValue);
}

// ── Mix inputs ───────────────────────────────────────────────────────────────

/** Rows of every line that still has an open month — the only rows a forecast can fill. */
export function openRows(lines: readonly LinePlanGroup[]): ConcentrationPlanRow[] {
  return lines.filter((line) => line.remainingMonths > 0).flatMap((line) => line.rows);
}

export function mixItemsFor(rows: readonly ConcentrationPlanRow[]): MixItem[] {
  return rows.map((row) => ({
    key: row.productCode,
    price: row.price,
    expectedUnits: row.trend.expectedUnits,
    realisticMaxUnits: row.trend.realisticMaxUnits,
    unitsStillToTarget: row.targetUnits != null ? row.targetUnits - row.gradedUnits : null,
  }));
}

export type StretchResult = MixResult & {
  /** Units per product planned ABOVE that product's realistic max. Only products that were stretched. */
  aboveRealistic: Record<string, number>;
  aboveRealisticValue: number;
};

/**
 * The realistic mix first; then, only if it still falls short, the missing value is spread over the
 * priced products in proportion to what each one realistically sells, so the stretch lands where the
 * business already is rather than on a product that barely moves. The whole plan as ONE goal; the
 * scenarios use the goal-by-goal version so a Pedia plan stretches its Sato products first.
 */
export function buildStretchMix(items: readonly MixItem[], gapValue: number | null): StretchResult {
  const stretch = buildGoalStretchMix(items, [{ key: "plan", gapValue, codes: null }]);
  const plan = stretch.goals[0];
  return {
    units: stretch.units,
    aboveRealistic: stretch.aboveRealistic,
    aboveRealisticValue: stretch.aboveRealisticValue,
    plannedValue: stretch.plannedValue,
    reachable: plan.reachable,
    shortValue: plan.shortValue,
  };
}

// ── The goals a plan must meet ───────────────────────────────────────────────

/**
 * "sato" and "pedia" are the two halves of the Pedia incentive; "plan" is everything in scope.
 * Only the halves are listed as checks under a scenario — the plan's own figures are already there.
 */
export type PlanGoalKey = "sato" | "pedia" | "plan";

export type PlanGoal = {
  key: PlanGoalKey;
  /** What a person reads: "Sato half · Guamusin and Ivyronc". Names, never codes. */
  label: string;
  targetValue: number | null;
  gradedValue: number;
  /** The products whose value counts toward it. null is every product. */
  codes: ReadonlySet<string> | null;
};

/**
 * The goals, in the order the mix meets them (engine.ts rule 7): the Sato products on their own
 * target, then the Pedia line, then the whole plan. The Pedia line is its own goal only when the
 * plan holds another line too — alone, it IS the whole plan, and listing it twice says nothing.
 */
export function planGoals(input: {
  lines: readonly LinePlanGroup[];
  totals: { targetValue: number | null; gradedValue: number };
}): PlanGoal[] {
  const goals: PlanGoal[] = [];
  for (const line of input.lines) {
    if (!line.satoHalf) continue;
    goals.push({
      key: "sato",
      label: `Sato half · ${line.satoHalf.productNames}`,
      targetValue: line.satoHalf.targetValue,
      gradedValue: line.satoHalf.gradedValue,
      codes: new Set(line.satoHalf.productCodes),
    });
    if (input.lines.length > 1) {
      goals.push({
        key: "pedia",
        label: `Total half · all ${line.lineName}`,
        targetValue: line.targetValue,
        gradedValue: line.gradedValue,
        codes: new Set(line.rows.map((row) => row.productCode)),
      });
    }
  }
  goals.push({
    key: "plan",
    label: "Whole plan",
    targetValue: input.totals.targetValue,
    gradedValue: input.totals.gradedValue,
    codes: null,
  });
  return goals;
}

/** The incentive's floor: below 90% a half pays nothing (src/lib/incentives/scheme-2026.ts). */
export const INCENTIVE_FLOOR = 0.9;

/**
 * The two Pedia halves read against `units`, Sato first — or nothing when no Pedia split is in
 * the plan. When Pedia is the only line, its total half IS the whole plan, read under that name.
 */
export function pediaHalves(
  input: { lines: readonly LinePlanGroup[]; totals: { targetValue: number | null; gradedValue: number } },
  units: Record<string, number>,
  goalPct: number,
): GoalCheck[] {
  const pedia = input.lines.find((line) => line.satoHalf);
  if (!pedia) return [];
  const checks = checkGoals(input, units, goalPct);
  const sato = checks.find((check) => check.key === "sato");
  const total =
    checks.find((check) => check.key === "pedia") ??
    (input.lines.length === 1 ? checks.find((check) => check.key === "plan") : undefined);
  return [
    ...(sato ? [sato] : []),
    ...(total ? [{ ...total, key: "pedia" as const, label: `Total half · all ${pedia.lineName}` }] : []),
  ];
}

/**
 * A Pedia rep's Sato half at their expected pace, for the team list (engine.ts rule 7). The team
 * row already shows the rep's TOTAL half as `expectedAchievement`; this is the other one, scored
 * on Guamusin + Ivyronc over their own target with each product at its steady pace. null for a rep
 * with no Pedia Sato half in scope.
 */
export function repPaceSatoHalf(lines: readonly LinePlanGroup[]): RepSatoHalf | null {
  const pedia = lines.find((line) => line.satoHalf);
  if (!pedia?.satoHalf) return null;
  const satoCodes = new Set(pedia.satoHalf.productCodes);
  const paceValue = pedia.rows
    .filter((row) => satoCodes.has(row.productCode))
    .reduce((sum, row) => sum + row.trend.expectedUnits * row.price, 0);
  return {
    productNames: pedia.satoHalf.productNames,
    hasTarget: pedia.satoHalf.targetValue != null,
    achievement: achievementOf(pedia.satoHalf.gradedValue, paceValue, pedia.satoHalf.targetValue),
  };
}

/** One goal read against a forecast: what it reaches, and what is still missing. */
export type GoalCheck = {
  key: PlanGoalKey;
  label: string;
  targetValue: number | null;
  gradedValue: number;
  /** Forecast value on this goal's products. */
  forecastValue: number;
  /** null — never 0 — when the goal has no target. */
  achievement: number | null;
  /** Value still missing to the goal %. null with no target. */
  shortOfGoal: number | null;
  reachesGoal: boolean | null;
};

/**
 * Read every goal against a set of units — the screen's typed forecast and each scenario alike.
 * Units of a line with no open month never count, exactly as `rowFigures` treats them.
 */
export function checkGoals(
  input: { lines: readonly LinePlanGroup[]; totals: { targetValue: number | null; gradedValue: number } },
  units: Record<string, number>,
  goalPct: number,
): GoalCheck[] {
  const prices = new Map<string, number>();
  for (const line of input.lines) {
    if (line.remainingMonths <= 0) continue;
    for (const row of line.rows) prices.set(row.productCode, row.price);
  }
  return planGoals(input).map((goal) => {
    let forecastValue = 0;
    for (const [code, count] of Object.entries(units)) {
      const price = prices.get(code);
      if (price == null || (goal.codes != null && !goal.codes.has(code))) continue;
      forecastValue += Math.max(0, count) * price;
    }
    const gap = goalGapValue(goal, goalPct);
    return {
      key: goal.key,
      label: goal.label,
      targetValue: goal.targetValue,
      gradedValue: goal.gradedValue,
      forecastValue,
      achievement: achievementOf(goal.gradedValue, forecastValue, goal.targetValue),
      shortOfGoal: gap == null ? null : Math.max(0, gap - forecastValue),
      reachesGoal: gap == null ? null : forecastValue >= gap,
    };
  });
}

// ── The three scenarios ──────────────────────────────────────────────────────

export type ScenarioKey = "pace" | "realistic" | "stretch";

export type PlanScenario = {
  key: ScenarioKey;
  number: 1 | 2 | 3;
  title: string;
  units: Record<string, number>;
  value: number;
  /** Value this scenario plans above Scenario 1, the steady pace. */
  aboveSteadyValue: number;
  achievement: number | null;
  /** Value still missing to the goal after sales so far and this scenario — the WHOLE plan. null with no target. */
  shortOfGoal: number | null;
  /** True only when the whole plan AND every half in `checks` reach the goal. null with no target. */
  reachesGoal: boolean | null;
  /** The whole plan alone. Differs from `reachesGoal` exactly when a Pedia half falls short. */
  planReachesGoal: boolean | null;
  /** The Pedia halves read against this scenario — empty for every plan without Pedia. */
  checks: GoalCheck[];
  aboveRealistic: Record<string, number>;
  aboveRealisticValue: number;
};

function mixGoalsFor(goals: readonly PlanGoal[], goalPct: number): MixGoal[] {
  return goals.map((goal) => ({ key: goal.key, gapValue: goalGapValue(goal, goalPct), codes: goal.codes }));
}

/** Every half in `checks` that falls short. A half with no target is never "short". */
export function missedHalves(checks: readonly GoalCheck[]): GoalCheck[] {
  return checks.filter((check) => check.reachesGoal === false);
}

export function buildPlanScenarios(
  input: { lines: readonly LinePlanGroup[]; totals: { targetValue: number | null; gradedValue: number } },
  goalPct: number,
): PlanScenario[] {
  const rows = openRows(input.lines);
  const items = mixItemsFor(rows);
  const priceOf = new Map(items.map((item) => [item.key, item.price]));
  const gap = goalGapValue(input.totals, goalPct);
  const goals = mixGoalsFor(planGoals(input), goalPct);
  const valueOf = (units: Record<string, number>) =>
    Object.entries(units).reduce((sum, [code, count]) => sum + count * (priceOf.get(code) ?? 0), 0);

  const pace: Record<string, number> = {};
  for (const item of items) pace[item.key] = Math.max(0, Math.floor(item.expectedUnits));
  const paceValue = valueOf(pace);

  const finish = (
    key: ScenarioKey,
    number: PlanScenario["number"],
    title: string,
    units: Record<string, number>,
    aboveRealistic: Record<string, number> = {},
    aboveRealisticValue = 0,
  ): PlanScenario => {
    const value = valueOf(units);
    const checks = checkGoals(input, units, goalPct).filter((check) => check.key !== "plan");
    const planReachesGoal = gap == null ? null : value >= gap;
    const judged = [planReachesGoal, ...checks.map((check) => check.reachesGoal)].filter(
      (reached): reached is boolean => reached != null,
    );
    return {
      key,
      number,
      title,
      units,
      value,
      aboveSteadyValue: Math.max(0, value - paceValue),
      achievement: achievementOf(input.totals.gradedValue, value, input.totals.targetValue),
      shortOfGoal: gap == null ? null : Math.max(0, gap - value),
      reachesGoal: planReachesGoal == null ? null : judged.every(Boolean),
      planReachesGoal,
      checks,
      aboveRealistic,
      aboveRealisticValue,
    };
  };

  // Scenario 2 is every product at its OWN realistic level (engine.ts rule 8) — a second forecast,
  // not a plan bent toward the goal, so it differs from Scenario 1 wherever a product's months move.
  const realistic: Record<string, number> = {};
  for (const item of items) realistic[item.key] = Math.max(pace[item.key], Math.floor(item.realisticMaxUnits));
  // Scenario 3 is the goal: the products it needs raised within their realistic level, the Sato
  // products first on a Pedia plan (rule 7), and stretched above that level only when it is not enough.
  const goalPlan = buildGoalStretchMix(items, goals);

  return [
    finish("pace", 1, "Steady pace", pace),
    finish("realistic", 2, "Realistic plan", realistic),
    finish(
      "stretch",
      3,
      goalPlan.aboveRealisticValue > 0 ? "Stretch to your goal" : "Plan for your goal",
      goalPlan.units,
      goalPlan.aboveRealistic,
      goalPlan.aboveRealisticValue,
    ),
  ];
}

/**
 * The scenario "Press here and Phoenix will Make It Happen" fills in: the plan for your goal when it
 * sits inside what the products realistically support, otherwise the realistic plan — never a
 * stretch, which would pad the forecast to a number it does not believe (engine.ts rule 5).
 */
export function suggestedScenario(scenarios: readonly PlanScenario[]): PlanScenario {
  const goalPlan = scenarios.find((scenario) => scenario.key === "stretch");
  const realistic = scenarios.find((scenario) => scenario.key === "realistic");
  if (goalPlan && goalPlan.aboveRealisticValue <= 0) return goalPlan;
  return realistic ?? scenarios[0];
}

function pctText(value: number | null): string {
  return value == null ? "no target" : `${(value * 100).toFixed(1)}%`;
}

/** "Sato half · Guamusin and Ivyronc reaches only 54.8% of its own target, EGP 1,234 short". */
export function halfShortText(check: GoalCheck, money: (value: number) => string): string {
  return `${check.label} reaches only ${pctText(check.achievement)} of its own target, ${money(check.shortOfGoal ?? 0)} short`;
}

/** The one honest line under each scenario. Never mentions AI; never calls a stretch realistic. */
export function scenarioSummary(scenario: PlanScenario, goalPct: number, money: (value: number) => string): string {
  const goal = `${goalPct}%`;
  const missed = missedHalves(scenario.checks);
  // Said whenever a Pedia half falls short: the whole plan can look fine while half the incentive pays nothing.
  const halvesText = missed.length > 0 ? ` ${missed.map((check) => halfShortText(check, money)).join("; ")}.` : "";
  if (scenario.key === "pace") {
    if (scenario.reachesGoal == null) return "Every product simply keeps its own month-by-month pace.";
    if (scenario.reachesGoal) return `Your current pace already reaches your ${goal} goal.`;
    if (scenario.planReachesGoal) return `Your current pace reaches your ${goal} goal overall, but not on both Pedia halves.${halvesText}`;
    return `Every product keeps its current pace, ${money(scenario.shortOfGoal ?? 0)} short of your ${goal} goal.${halvesText}`;
  }
  if (scenario.key === "realistic") {
    const lift =
      scenario.aboveSteadyValue > 0
        ? `Every product at the good end of its own months: ${money(scenario.aboveSteadyValue)} above your steady pace, never above its best normal month.`
        : "Your products' months barely move, so their realistic level is their steady pace.";
    if (scenario.reachesGoal == null) return lift;
    if (scenario.reachesGoal) return `${lift} Enough for your ${goal} goal.`;
    if (scenario.planReachesGoal) {
      return `${lift} Enough for your ${goal} goal overall, but not on both Pedia halves.${halvesText} ${HONESTY_SENTENCE}.`;
    }
    return `${lift} Still ${money(scenario.shortOfGoal ?? 0)} short of your ${goal} goal.${halvesText} ${HONESTY_SENTENCE}.`;
  }
  if (scenario.reachesGoal == null) return "There is no target for this period, so there is no goal to plan for.";
  if (scenario.aboveRealisticValue <= 0) {
    if (scenario.aboveSteadyValue <= 0) return `Your steady pace already reaches your ${goal} goal, so nothing more is needed.`;
    return (
      `Reaches your ${goal} goal by raising only the products it needs, ${money(scenario.aboveSteadyValue)} above your ` +
      `steady pace and never above what any product realistically supports.`
    );
  }
  const stretched = Object.keys(scenario.aboveRealistic).length;
  return (
    `Reaches your ${goal} goal only by selling ${money(scenario.aboveRealisticValue)} above what the products' own ` +
    `months realistically support, across ${stretched} product${stretched === 1 ? "" : "s"}.` +
    (scenario.checks.length > 0 ? " The Sato products are stretched to their own goal first; no other product stands in for them." : "") +
    halvesText
  );
}

// ── One product row's figures ────────────────────────────────────────────────

export type RowStatus = "ahead" | "close" | "behind" | "none";

export const ROW_STATUS_OPTIONS: ReadonlyArray<{ value: RowStatus; label: string }> = [
  { value: "ahead", label: "On track" },
  { value: "close", label: "Close" },
  { value: "behind", label: "Behind" },
  { value: "none", label: "No target" },
];

/** On track is 100% or more, close is 80 to 99% — the same ladder the team list uses. */
export function statusOf(achievement: number | null): RowStatus {
  if (achievement == null) return "none";
  if (achievement >= 1) return "ahead";
  if (achievement >= 0.8) return "close";
  return "behind";
}

export type RowFigures = {
  typedUnits: number;
  value: number;
  achievement: number | null;
  unitsAchievement: number | null;
  /** Target − sold so far − forecast, in value. Positive is still to go; zero or less is met. null: no target. */
  gapValue: number | null;
  /** The same gap in THIS product's units — never added to another product's. */
  gapUnits: number | null;
  status: RowStatus;
};

export function rowFigures(row: ConcentrationPlanRow, open: boolean, typedUnits: number): RowFigures {
  const units = open ? Math.max(0, typedUnits) : 0;
  const value = units * row.price;
  const achievement = achievementOf(row.gradedValue, value, row.targetValue);
  return {
    typedUnits: units,
    value,
    achievement,
    unitsAchievement: achievementOf(row.gradedUnits, units, row.targetUnits),
    gapValue: row.targetValue == null ? null : row.targetValue - row.gradedValue - value,
    gapUnits: row.targetUnits == null ? null : row.targetUnits - row.gradedUnits - units,
    status: statusOf(achievement),
  };
}

export function trendLabel(trend: TrendReading): string {
  switch (trend.kind) {
    case "none":
      return "No closed sales yet";
    case "early":
      return `Average of ${trend.historyMonths} closed month${trend.historyMonths === 1 ? "" : "s"}`;
    case "growing":
      return "Growing";
    case "flat":
      return "Steady";
    case "declining":
      return "Declining, held at its recent level";
  }
}

// ── Filters ──────────────────────────────────────────────────────────────────

export const TREND_OPTIONS: ReadonlyArray<{ value: TrendKind; label: string }> = [
  { value: "growing", label: "Growing" },
  { value: "flat", label: "Steady" },
  { value: "declining", label: "Declining" },
  { value: "early", label: "Early history" },
  { value: "none", label: "No closed sales" },
];

export const PLANNED_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "Planned or not" },
  { value: "planned", label: "Planned only" },
  { value: "unplanned", label: "Not planned yet" },
];

export const GAP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "Any gap" },
  { value: "short", label: "Still short of target" },
  { value: "met", label: "Target met" },
];

export const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "catalogue", label: "Family, then name" },
  { value: "gap", label: "Biggest gap to target" },
  { value: "target", label: "Biggest target" },
  { value: "forecast", label: "Biggest forecast" },
  { value: "lowest", label: "Lowest achievement" },
  { value: "highest", label: "Highest achievement" },
  { value: "name", label: "Product name" },
];

/**
 * Every list is a list of strings on purpose: an unrecognised value is KEPT and matches nothing,
 * because discarding it would widen a tampered export past what the reader filtered on screen.
 */
export type PlannerFilters = {
  search: string;
  lines: string[];
  families: string[];
  trends: string[];
  statuses: string[];
  planned: string;
  gap: string;
  sort: string;
};

export const NO_PLANNER_FILTERS: PlannerFilters = {
  search: "",
  lines: [],
  families: [],
  trends: [],
  statuses: [],
  planned: "all",
  gap: "all",
  sort: "catalogue",
};

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
}

/** A malformed body degrades to no filter, so an export never fails on a bad request shape. */
export function parsePlannerFilters(raw: unknown): PlannerFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...NO_PLANNER_FILTERS };
  const body = raw as Record<string, unknown>;
  const choice = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  return {
    search: typeof body.search === "string" ? body.search.slice(0, 80) : "",
    lines: stringList(body.lines),
    families: stringList(body.families),
    trends: stringList(body.trends),
    statuses: stringList(body.statuses),
    planned: choice(body.planned, "all"),
    gap: choice(body.gap, "all"),
    sort: choice(body.sort, "catalogue"),
  };
}

/** Whether the filters narrow anything. Sorting alone is not a filter. */
export function plannerFiltersActive(filters: PlannerFilters): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.lines.length > 0 ||
    filters.families.length > 0 ||
    filters.trends.length > 0 ||
    filters.statuses.length > 0 ||
    filters.planned !== "all" ||
    filters.gap !== "all"
  );
}

export type FilteredRow = { row: ConcentrationPlanRow; figures: RowFigures };
export type FilteredLine = { line: LinePlanGroup; rows: FilteredRow[]; totalRows: number };

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return b - a;
}

export function filterPlanLines(
  lines: readonly LinePlanGroup[],
  filters: PlannerFilters,
  units: Record<string, number>,
): FilteredLine[] {
  const needle = filters.search.trim().toLowerCase();
  return lines
    .filter((line) => filters.lines.length === 0 || filters.lines.includes(line.lineCode))
    .map((line) => {
      const open = line.remainingMonths > 0;
      const rows = line.rows
        .map((row) => ({ row, figures: rowFigures(row, open, units[row.productCode] ?? 0) }))
        .filter(({ row, figures }) => {
          if (needle && !`${row.name} ${row.family}`.toLowerCase().includes(needle)) return false;
          if (filters.families.length > 0 && !filters.families.includes(row.family)) return false;
          if (filters.trends.length > 0 && !filters.trends.includes(row.trend.kind)) return false;
          if (filters.statuses.length > 0 && !filters.statuses.includes(figures.status)) return false;
          if (filters.planned === "planned") {
            if (figures.typedUnits <= 0) return false;
          } else if (filters.planned === "unplanned") {
            if (figures.typedUnits > 0) return false;
          } else if (filters.planned !== "all") {
            return false;
          }
          if (filters.gap === "short") {
            if (!(figures.gapValue != null && figures.gapValue > 0)) return false;
          } else if (filters.gap === "met") {
            if (!(figures.gapValue != null && figures.gapValue <= 0)) return false;
          } else if (filters.gap !== "all") {
            return false;
          }
          return true;
        });

      const sorted = [...rows];
      switch (filters.sort) {
        case "gap":
          sorted.sort((a, b) => compareNullableDesc(a.figures.gapValue, b.figures.gapValue));
          break;
        case "target":
          sorted.sort((a, b) => compareNullableDesc(a.row.targetValue, b.row.targetValue));
          break;
        case "forecast":
          sorted.sort((a, b) => b.figures.value - a.figures.value);
          break;
        case "lowest":
          sorted.sort((a, b) =>
            a.figures.achievement == null
              ? b.figures.achievement == null ? 0 : 1
              : b.figures.achievement == null ? -1 : a.figures.achievement - b.figures.achievement,
          );
          break;
        case "highest":
          sorted.sort((a, b) => compareNullableDesc(a.figures.achievement, b.figures.achievement));
          break;
        case "name":
          sorted.sort((a, b) => a.row.name.localeCompare(b.row.name));
          break;
        default:
          break;
      }
      return { line, rows: sorted, totalRows: line.rows.length };
    });
}

/** The stamp a filtered file carries, in the words the chips use. null when nothing is narrowed. */
export function describePlannerFilters(filters: PlannerFilters, lineNames: ReadonlyMap<string, string>): string | null {
  if (!plannerFiltersActive(filters)) return null;
  const labelOf = (options: ReadonlyArray<{ value: string; label: string }>, value: string) =>
    options.find((option) => option.value === value)?.label ?? "Unrecognised choice";
  const parts: string[] = [];
  if (filters.lines.length > 0) {
    parts.push(`Line: ${filters.lines.map((code) => lineNames.get(code) ?? "Unrecognised line").join(", ")}`);
  }
  if (filters.families.length > 0) parts.push(`Family: ${filters.families.join(", ")}`);
  if (filters.trends.length > 0) parts.push(`Trend: ${filters.trends.map((value) => labelOf(TREND_OPTIONS, value)).join(", ")}`);
  if (filters.statuses.length > 0) {
    parts.push(`Status: ${filters.statuses.map((value) => labelOf(ROW_STATUS_OPTIONS, value)).join(", ")}`);
  }
  if (filters.planned !== "all") parts.push(labelOf(PLANNED_OPTIONS, filters.planned));
  if (filters.gap !== "all") parts.push(labelOf(GAP_OPTIONS, filters.gap));
  if (filters.search.trim()) parts.push(`Search: "${filters.search.trim()}"`);
  return `Filtered — this file covers only: ${parts.join(" · ")}. Totals still cover the whole plan.`;
}
