// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the pure half of the target planner.
//
// No IO, no React, no server imports: the client component re-computes every forecast figure
// from this file as the user types, and the server builds the same figures from it, so the
// screen and the saved plan can never disagree about what a unit is worth.
//
// Owner rules this file encodes (2026-09-13 / 2026-09-14):
//
//   1. The user types UNITS. Value = units × the product's factory price, and achievement % is
//      derived — never typed.
//   2. Units are only ever totalled inside ONE concentration (product_code). Everything above a
//      concentration — a family, a line, the whole plan — is totalled in VALUE.
//   3. History starts July 2026 and only PUBLISHED Monthly Closing months count.
//   4. Each concentration is read from its OWN closed months, and gives two figures:
//        · EXPECTED (Scenario 1, steady pace) — the middle of what its months say happens next:
//            growing / flat → its recent level; declining → held at its recent level, never an
//            invented recovery; fewer than three closed months → the AVERAGE of them (owner's
//            pick over "best month" and "latest month", 2026-09-14).
//        · REALISTIC (Scenario 2) — the upper quartile of the same forecast (rule 8 below).
//      A one-off spike (a bulk order) is ignored before anything is read.
//   5. When the target cannot be reached realistically, the plan says so — it never pads the
//      numbers to a 100% it does not believe.
//
// Achievement divides the GRADED actual (every sale inside a month the group carries a target
// in) by the target — the Sales vs Target rule, so this screen agrees with that one.
//
//   6. A FORECAST ONLY FILLS A MONTH THAT CARRIES A TARGET (2026-10-01). Targets are loaded a
//      quarter at a time, so an open month with no target yet is normal — but forecasting it
//      divided three months of pace by one month of target: Pedia's Q4 read 171% with only
//      October targeted. An open month with no target is named and left out, unless no month of
//      the period carries one, when there is no achievement to inflate and the pace fills them all.
//   7. PEDIA IS PLANNED ON TWO HALVES (2026-10-01). From Semester 2 2026 its incentive is one month
//      of basic on Guamusin + Ivyronc alone and one on the whole line (src/lib/incentives/pedia-
//      split.ts). Lacto can lift the total; it can never lift the Sato half. So the plan has
//      several goals, met in order — the Sato products on their own target first, then the Pedia
//      total, then the whole plan — and it reaches "your goal" only when every one of them does.
//   8. SCENARIO 2 IS A REAL SECOND FORECAST, NOT A COPY OF SCENARIO 1 (owner, 2026-10-01: "two
//      different scenarios, realistic, that can really help them" — the maths was left to Phoenix).
//      Until then "realistic" was capped at the expected pace for every flat, declining and early
//      product, and with only July and August closed EVERY product was early — so Scenario 2 was
//      Scenario 1 on every screen. Now, over the m open months:
//
//          total ~ Normal( m·L ,  s²·(m + m²/k) )
//
//      L is the expected monthly level above, s the product's own month-to-month spread (around its
//      robust trend line once three months are closed, around the mean before that), and k the
//      months L was averaged from — the m²/k term is the doubt in L itself, which is what makes a
//      two-month history honestly wide. REALISTIC is the 75th percentile of that total: better
//      than the pace, inside the range its own months already show, never above m × its best
//      normal month (a declining product: its best RECENT month, so no old peak comes back). A
//      product with one closed month, or none that move, has no spread and stays at its pace — and
//      says so rather than inventing one.
//   9. THE FORECAST IS PER PRODUCT PER BRICK (owner, 2026-11-06: "I want the bricks listed, per
//      product, and the forecast is done based on this"). Each brick a product sold on in the
//      viewer's scope is read from its OWN closed months, the same readTrend, and gives its own
//      pace. The product's forecast is spread over its bricks in proportion to those paces
//      (splitAcrossBricks), so the bricks always add up to the product — and the product stays the
//      Monthly Closing figure the target is graded on. Why not simply add the brick paces: inside
//      one area the closing moves sales the bricks never show (the city rule, the Office spread,
//      direct orders, El Qema), and a sum of brick paces would grade a rep on a number he is not
//      paid on. A rep may type any brick; the product is then the sum of its bricks. Brick history
//      is never shown — only the bricks and their forecast.
// ─────────────────────────────────────────────────────────────────────────────

/** The first month Make It Happen reads (owner decision 2026-09-14). */
export const MAKE_IT_HAPPEN_FLOOR = "2026-07";
/** Below this many closed months the trend is not read at all — the average is the pace. */
export const EARLY_HISTORY_MONTHS = 3;
/**
 * The standard-normal 75th percentile (rule 8). Scenario 2 is the upper QUARTILE of the forecast:
 * a result the pace alone reaches about one time in four, and focus makes likelier.
 */
export const REALISTIC_Z = 0.6745;
/** How many closed months the trend reads, newest first. */
export const TREND_WINDOW_MONTHS = 6;
/** A month above this multiple of the median is a one-off (a bulk order), not a pace. */
export const SPIKE_MULTIPLE = 2.5;
/** A monthly slope within ±5% of the average month is flat. */
export const FLAT_BAND = 0.05;
/** A forecast larger than this is a typing slip, not a plan. */
export const MAX_FORECAST_UNITS = 10_000_000;
/**
 * The owner's own sentence for an out-of-reach target (2026-09-13). It is never paraphrased.
 * Declared here, not in coach.ts, because the scenarios the planner builds in the browser say it too
 * and coach.ts reaches a server-only client.
 */
export const HONESTY_SENTENCE = "Phoenix is here to support you, not to show you dream numbers";

export type PeriodKind = "month" | "quarter" | "semester";

export const PERIOD_KINDS: ReadonlyArray<{ value: PeriodKind; label: string }> = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "semester", label: "Semester" },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/;
const SEMESTER_RE = /^(\d{4})-H([12])$/;

export function isPeriodKind(value: unknown): value is PeriodKind {
  return value === "month" || value === "quarter" || value === "semester";
}

function monthKey(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Shift a YYYY-MM month by whole months. null for a malformed input. */
export function shiftMonth(period: string, months: number): string | null {
  const match = MONTH_RE.exec(period);
  if (!match) return null;
  return monthKey(Number(match[1]), Number(match[2]) + months);
}

/** The calendar months a period covers, oldest first. null for a malformed key. */
export function periodMonths(kind: PeriodKind, key: string): string[] | null {
  if (kind === "month") return MONTH_RE.test(key) ? [key] : null;
  const match = (kind === "quarter" ? QUARTER_RE : SEMESTER_RE).exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const size = kind === "quarter" ? 3 : 6;
  const start = (Number(match[2]) - 1) * size + 1;
  return Array.from({ length: size }, (_, index) => monthKey(year, start + index));
}

/** The period of `kind` that contains `month`. */
export function periodKeyOf(kind: PeriodKind, month: string): string | null {
  const match = MONTH_RE.exec(month);
  if (!match) return null;
  const monthNumber = Number(match[2]);
  if (kind === "month") return month;
  if (kind === "quarter") return `${match[1]}-Q${Math.ceil(monthNumber / 3)}`;
  return `${match[1]}-H${monthNumber <= 6 ? 1 : 2}`;
}

/** "September 2026", or "Sep" when short. */
export function monthLabel(month: string, short = false): string {
  const match = MONTH_RE.exec(month);
  if (!match) return month;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return short ? name.slice(0, 3) : `${name} ${match[1]}`;
}

/** What the user reads for a period. Never the raw key. */
export function periodLabel(kind: PeriodKind, key: string): string {
  const months = periodMonths(kind, key);
  if (!months) return key;
  if (kind === "month") return monthLabel(months[0]);
  const year = key.slice(0, 4);
  const span = `${monthLabel(months[0]).split(" ")[0]} to ${monthLabel(months[months.length - 1]).split(" ")[0]}`;
  if (kind === "quarter") return `Q${key.slice(6)} ${year} · ${span}`;
  // Semester 1 / Semester 2, never "half" or H1/H2 (owner, 2026-09-23). The KEY keeps its H shape —
  // saved plans are stored under it — only the words a person reads changed.
  return `Semester ${key.endsWith("1") ? 1 : 2} ${year} · ${span}`;
}

/**
 * The open months a line's forecast fills (rule 6 in the header): the open months that carry a
 * target, or every open month when none of the period's months carries one. The rest are named,
 * never silently dropped.
 */
export function forecastMonthsOf(
  months: readonly string[],
  isClosed: (month: string) => boolean,
  isTargeted: (month: string) => boolean,
): { forecast: string[]; untargeted: string[] } {
  const open = months.filter((month) => !isClosed(month));
  if (!months.some(isTargeted)) return { forecast: open, untargeted: [] };
  return { forecast: open.filter(isTargeted), untargeted: open.filter((month) => !isTargeted(month)) };
}

/**
 * The periods of one kind the picker offers: every period touching the floor month up to the
 * period holding `currentMonth + lookaheadMonths`. A period that ends before the floor is never
 * offered — it would open on a history the module refuses to read.
 */
export function offeredPeriods(
  kind: PeriodKind,
  currentMonth: string,
  lookaheadMonths = 3,
): Array<{ value: string; label: string }> {
  const end = shiftMonth(currentMonth, lookaheadMonths) ?? currentMonth;
  const keys: string[] = [];
  let cursor: string | null = MAKE_IT_HAPPEN_FLOOR;
  let guard = 0;
  while (cursor && cursor <= end && guard < 240) {
    const key = periodKeyOf(kind, cursor);
    if (key && !keys.includes(key)) keys.push(key);
    cursor = shiftMonth(cursor, 1);
    guard += 1;
  }
  return keys.map((value) => ({ value, label: periodLabel(kind, value) }));
}

// ── Grading ──────────────────────────────────────────────────────────────────

export type GradableRow = {
  period: string;
  /** True when this row's (line, month) Monthly Closing is published. Unclosed actuals never count. */
  closed: boolean;
  actualUnits: number;
  actualValue: number;
  targetUnits: number | null;
  targetValue: number | null;
};

export type GradedTotals = {
  targetUnits: number;
  targetValue: number;
  /** Sales in closed months, all of them. */
  actualUnits: number;
  actualValue: number;
  /** Sales in closed months this set carries a target in — the numerator achievement divides. */
  gradedUnits: number;
  gradedValue: number;
};

/**
 * Total one set of rows the way Sales vs Target does.
 *
 * The month decides, not the row: inside a month the SET holds any target in, every sale counts,
 * including a row with no target of its own. Targets count in every month of the period, closed
 * or not — the forecast is what fills the open months.
 */
export function gradeRows(rows: readonly GradableRow[]): GradedTotals {
  const targetedPeriods = new Set<string>();
  for (const row of rows) if ((row.targetValue ?? 0) > 0) targetedPeriods.add(row.period);
  const totals: GradedTotals = {
    targetUnits: 0,
    targetValue: 0,
    actualUnits: 0,
    actualValue: 0,
    gradedUnits: 0,
    gradedValue: 0,
  };
  for (const row of rows) {
    totals.targetUnits += row.targetUnits ?? 0;
    totals.targetValue += row.targetValue ?? 0;
    if (!row.closed) continue;
    totals.actualUnits += row.actualUnits;
    totals.actualValue += row.actualValue;
    if (targetedPeriods.has(row.period)) {
      totals.gradedUnits += row.actualUnits;
      totals.gradedValue += row.actualValue;
    }
  }
  return totals;
}

/** (graded + forecast) / target. null — never 0 — when there is no target to divide by. */
export function achievementOf(graded: number, forecast: number, target: number | null): number | null {
  if (target == null || target === 0) return null;
  return (graded + forecast) / target;
}

/**
 * Parse one typed forecast. Empty reads as 0; anything that is not a whole number of zero or more
 * (or is absurdly large) is null, so the caller can refuse it rather than silently round it.
 */
export function parseForecastUnits(raw: unknown): number | null {
  if (raw == null) return 0;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
  if (text == null) return null;
  if (text === "") return 0;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= MAX_FORECAST_UNITS ? value : null;
}

// ── Reading a concentration's pace ───────────────────────────────────────────

export type TrendKind = "none" | "early" | "growing" | "flat" | "declining";

export type TrendReading = {
  kind: TrendKind;
  /** Closed months the reading used. */
  historyMonths: number;
  /** One-off months replaced by the median before the trend was read. */
  spikesIgnored: number;
  /** Units over the remaining months if the current pace simply continues. */
  expectedUnits: number;
  /** The most Phoenix will plan for this concentration over the remaining months. Never below expected. */
  realisticMaxUnits: number;
};

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Theil–Sen slope: the median of every pairwise slope. One odd month cannot tilt it. */
function robustSlope(values: readonly number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) slopes.push((values[j] - values[i]) / (j - i));
  }
  return median(slopes);
}

/** Sample standard deviation (n − 1). 0 below two values: one month carries no spread. */
function sampleSpread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

/**
 * Spread around the robust trend line (Theil–Sen slope, median intercept), n − 2 degrees of
 * freedom — so a steady climb or a steady fall is not mistaken for volatility. 0 below three values.
 */
function residualSpread(values: readonly number[], slope: number): number {
  if (values.length < 3) return 0;
  const intercept = median(values.map((value, index) => value - slope * index));
  const squares = values.reduce((sum, value, index) => sum + (value - (intercept + slope * index)) ** 2, 0);
  return Math.sqrt(squares / (values.length - 2));
}

/**
 * Rule 8: the 75th percentile of the m-month total, never above m × `bestMonth`, never below the
 * expected units. `levelMonths` is k, the months the level was averaged from — its m²/k term is
 * the doubt in the level itself.
 */
export function realisticUnits(input: {
  level: number;
  spread: number;
  levelMonths: number;
  months: number;
  bestMonth: number;
  expectedUnits: number;
}): number {
  const { level, spread, months, bestMonth, expectedUnits } = input;
  if (months <= 0) return 0;
  const k = Math.max(1, input.levelMonths);
  const deviation = spread * Math.sqrt(months + (months * months) / k);
  const quartile = Math.max(0, level) * months + REALISTIC_Z * deviation;
  const ceiling = Math.max(0, bestMonth) * months;
  return Math.max(expectedUnits, Math.floor(Math.min(quartile, ceiling)));
}

/**
 * Read one concentration's monthly units (closed months, oldest first, a month with no sales
 * passed as 0) and turn it into its two forecasts over the remaining months: the expected units
 * (Scenario 1) and the realistic units (Scenario 2, rule 8).
 */
export function readTrend(history: readonly number[], remainingMonths: number): TrendReading {
  const months = Math.max(0, Math.floor(remainingMonths));
  const series = history.filter((value) => Number.isFinite(value)).slice(-TREND_WINDOW_MONTHS);
  const empty = { historyMonths: series.length, spikesIgnored: 0 };

  if (series.length === 0 || series.every((value) => value <= 0)) {
    return { kind: "none", ...empty, expectedUnits: 0, realisticMaxUnits: 0 };
  }

  if (series.length < EARLY_HISTORY_MONTHS) {
    // Too few months to read a trend or tell a spike from a pace: the average is the pace, and
    // the spread between the closed months is the only honest measure of the room above it.
    const level = Math.max(0, mean(series));
    const units = Math.floor(level * months);
    return {
      kind: "early",
      ...empty,
      expectedUnits: units,
      realisticMaxUnits: realisticUnits({
        level,
        spread: sampleSpread(series),
        levelMonths: series.length,
        months,
        bestMonth: Math.max(...series),
        expectedUnits: units,
      }),
    };
  }

  const typical = median(series);
  let spikesIgnored = 0;
  const cleaned = series.map((value) => {
    if (typical > 0 && value > SPIKE_MULTIPLE * typical) {
      spikesIgnored += 1;
      return typical;
    }
    return value;
  });

  const average = mean(cleaned);
  const recentMonths = cleaned.slice(-EARLY_HISTORY_MONTHS);
  const recent = Math.max(0, mean(recentMonths));
  const slope = robustSlope(cleaned);
  const relative = average > 0 ? slope / average : 0;
  const reading = { historyMonths: cleaned.length, spikesIgnored };
  const spread = residualSpread(cleaned, slope);
  const best = Math.max(...cleaned);

  if (relative >= FLAT_BAND) {
    const anchor = cleaned[cleaned.length - 1];
    let path = 0;
    for (let step = 1; step <= months; step += 1) path += Math.max(0, Math.min(anchor + slope * step, best));
    const expectedUnits = Math.floor(recent * months);
    // The growth carried on (capped at the best month), or the upper quartile around the recent
    // level — whichever is higher. Both stop at the best normal month.
    const quartile = realisticUnits({ level: recent, spread, levelMonths: recentMonths.length, months, bestMonth: best, expectedUnits });
    return { kind: "growing", ...reading, expectedUnits, realisticMaxUnits: Math.max(quartile, Math.floor(path)) };
  }

  if (relative <= -FLAT_BAND) {
    const level = Math.max(0, Math.min(cleaned[cleaned.length - 1], recent));
    const units = Math.floor(level * months);
    // Never an invented recovery: the ceiling is the best RECENT month, not the peak it fell from,
    // and the spread is measured around the falling line, so the fall itself adds no room.
    return {
      kind: "declining",
      ...reading,
      expectedUnits: units,
      realisticMaxUnits: realisticUnits({
        level,
        spread,
        levelMonths: recentMonths.length,
        months,
        bestMonth: Math.max(...recentMonths),
        expectedUnits: units,
      }),
    };
  }

  const units = Math.floor(recent * months);
  return {
    kind: "flat",
    ...reading,
    expectedUnits: units,
    realisticMaxUnits: realisticUnits({ level: recent, spread, levelMonths: recentMonths.length, months, bestMonth: best, expectedUnits: units }),
  };
}

// ── Building the realistic mix ───────────────────────────────────────────────

export type MixItem = {
  /** product_code — an identity, never rendered. */
  key: string;
  price: number;
  expectedUnits: number;
  realisticMaxUnits: number;
  /** Units this concentration still needs for its OWN target (null when it has none). */
  unitsStillToTarget: number | null;
};

export type MixResult = {
  units: Record<string, number>;
  /** null when there is no target to reach. */
  reachable: boolean | null;
  /** Value the mix still leaves uncovered — 0 when reachable. */
  shortValue: number;
  plannedValue: number;
};

/**
 * One goal the mix must reach: a value gap, and the products whose value counts toward it.
 * `codes: null` is every product — the whole plan. A Pedia plan adds the Sato products and the
 * Pedia line ahead of it (rule 7).
 */
export type MixGoal = {
  key: string;
  /** Value still needed after sales so far. null when there is no target to reach. */
  gapValue: number | null;
  codes: ReadonlySet<string> | null;
};

export type MixGoalOutcome = {
  key: string;
  /** null when the goal has no target. */
  reachable: boolean | null;
  shortValue: number;
  /** Value the mix plans on this goal's products. */
  plannedValue: number;
};

export type GoalMixResult = {
  units: Record<string, number>;
  plannedValue: number;
  /** Every goal, in the order given. */
  goals: MixGoalOutcome[];
  /** True only when every goal with a target is reached; null when none has one. */
  reachable: boolean | null;
};

function countsToward(goal: MixGoal, key: string): boolean {
  return goal.codes == null || goal.codes.has(key);
}

function plannedFor(items: readonly MixItem[], units: Record<string, number>, goal: MixGoal): number {
  return items.reduce((sum, item) => (countsToward(goal, item.key) ? sum + (units[item.key] ?? 0) * item.price : sum), 0);
}

function goalOutcomes(items: readonly MixItem[], units: Record<string, number>, goals: readonly MixGoal[]) {
  const outcomes = goals.map((goal): MixGoalOutcome => {
    const planned = plannedFor(items, units, goal);
    if (goal.gapValue == null) return { key: goal.key, reachable: null, shortValue: 0, plannedValue: planned };
    const short = goal.gapValue - planned;
    return { key: goal.key, reachable: short <= 0, shortValue: Math.max(0, short), plannedValue: planned };
  });
  const judged = outcomes.filter((outcome) => outcome.reachable != null);
  return {
    goals: outcomes,
    plannedValue: items.reduce((sum, item) => sum + (units[item.key] ?? 0) * item.price, 0),
    reachable: judged.length === 0 ? null : judged.every((outcome) => outcome.reachable === true),
  };
}

/**
 * Start every concentration at its expected pace, then meet the goals IN ORDER: for each, only if
 * a gap is left, raise the products that count toward it and have realistic headroom — those
 * still short of their own target first, biggest headroom value next. A goal stops the moment its
 * gap closes; nothing is ever planned above a concentration's realistic max. Value a goal raised
 * keeps counting toward every later goal that includes those products.
 */
export function buildGoalMix(items: readonly MixItem[], goals: readonly MixGoal[]): GoalMixResult {
  const units: Record<string, number> = {};
  for (const item of items) units[item.key] = Math.max(0, Math.floor(item.expectedUnits));

  for (const goal of goals) {
    if (goal.gapValue == null) continue;
    let remaining = goal.gapValue - plannedFor(items, units, goal);
    if (remaining <= 0) continue;
    const candidates = items
      .filter((item) => countsToward(goal, item.key) && item.price > 0 && item.realisticMaxUnits > units[item.key])
      .map((item) => ({
        item,
        belowOwnTarget: item.unitsStillToTarget != null && item.unitsStillToTarget - units[item.key] > 0,
        headroomValue: (item.realisticMaxUnits - units[item.key]) * item.price,
      }))
      .sort(
        (a, b) =>
          Number(b.belowOwnTarget) - Number(a.belowOwnTarget) ||
          b.headroomValue - a.headroomValue ||
          a.item.key.localeCompare(b.item.key),
      );
    for (const { item } of candidates) {
      if (remaining <= 0) break;
      const headroom = item.realisticMaxUnits - units[item.key];
      const add = Math.min(headroom, Math.ceil(remaining / item.price));
      units[item.key] += add;
      remaining -= add * item.price;
    }
  }

  return { units, ...goalOutcomes(items, units, goals) };
}

export type GoalStretchResult = GoalMixResult & {
  /** Units per product planned ABOVE that product's realistic max. Only products that were stretched. */
  aboveRealistic: Record<string, number>;
  aboveRealisticValue: number;
};

/**
 * The realistic mix first; then, goal by goal and only where one still falls short, the missing
 * value is spread over that goal's priced products in proportion to what each realistically sells —
 * so a Sato shortfall lands on the Sato products, never on Lacto, and the whole-plan stretch lands
 * where the business already is.
 */
export function buildGoalStretchMix(items: readonly MixItem[], goals: readonly MixGoal[]): GoalStretchResult {
  const base = buildGoalMix(items, goals);
  const units = { ...base.units };
  const aboveRealistic: Record<string, number> = {};
  let aboveRealisticValue = 0;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  for (const goal of goals) {
    if (goal.gapValue == null) continue;
    const short = goal.gapValue - plannedFor(items, units, goal);
    if (short <= 0) continue;
    const priced = items.filter((item) => countsToward(goal, item.key) && item.price > 0);
    let weights = priced.map((item) => Math.max(0, item.realisticMaxUnits) * item.price);
    if (sum(weights) <= 0) weights = priced.map((item) => Math.max(0, item.unitsStillToTarget ?? 0) * item.price);
    if (sum(weights) <= 0) weights = priced.map(() => 1);
    const totalWeight = sum(weights);
    if (priced.length === 0 || totalWeight <= 0) continue;
    priced.forEach((item, index) => {
      if (weights[index] <= 0) return;
      const extra = Math.ceil((short * weights[index]) / totalWeight / item.price);
      if (extra <= 0) return;
      units[item.key] = (units[item.key] ?? 0) + extra;
      aboveRealistic[item.key] = (aboveRealistic[item.key] ?? 0) + extra;
      aboveRealisticValue += extra * item.price;
    });
  }

  return { units, aboveRealistic, aboveRealisticValue, ...goalOutcomes(items, units, goals) };
}

/** The single-goal mix over every product — the whole plan and nothing else. */
export function buildRealisticMix(items: readonly MixItem[], gapValue: number | null): MixResult {
  const mix = buildGoalMix(items, [{ key: "plan", gapValue, codes: null }]);
  const plan = mix.goals[0];
  return { units: mix.units, reachable: plan.reachable, shortValue: plan.shortValue, plannedValue: mix.plannedValue };
}

// ── Per brick (rule 9) ───────────────────────────────────────────────────────

/** One brick a product sold on in the viewer's scope. History is read, never shipped. */
export type BrickPlanRow = {
  /** brick_id — the key a brick forecast is stored under. Never rendered. */
  brickId: string;
  name: string;
  /** The brick's own pace over the open months: what weights its share of the product. */
  expectedUnits: number;
  realisticMaxUnits: number;
  /**
   * Who covers the brick: the rep and District Manager it was attributed to in the LATEST closed
   * month it sold anything on this line (a brick has one rep and one DM per line and month). null =
   * a vacant seat / no District Manager; undefined = not read (a fixture). The export groups its
   * brick tabs by these (owner, 2026-11-14: "per DSM firstly then per MR").
   */
  repName?: string | null;
  districtManagerName?: string | null;
};

/** Order bricks the way the planner lists them: the biggest pace first, then by name. */
export function sortBricks<T extends BrickPlanRow>(bricks: readonly T[]): T[] {
  return [...bricks].sort(
    (a, b) =>
      b.expectedUnits - a.expectedUnits ||
      b.realisticMaxUnits - a.realisticMaxUnits ||
      a.name.localeCompare(b.name) ||
      a.brickId.localeCompare(b.brickId),
  );
}

/**
 * Spread a product's whole units over its bricks, in proportion to each brick's own pace (rule 9).
 * Whole units, and they always add up to `total` exactly: each brick takes the floor of its share,
 * and the units left over go one by one to the largest remainders, ties to the brick listed first.
 * Weights fall back from the expected pace to the realistic pace to an even split, so a product
 * with bricks never loses units to a zero weight. No bricks → {} (the product is typed on its own).
 */
export function splitAcrossBricks(total: number, bricks: readonly BrickPlanRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  const units = Math.max(0, Math.floor(total));
  if (bricks.length === 0) return out;
  const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
  let weights = bricks.map((brick) => Math.max(0, brick.expectedUnits));
  if (sum(weights) <= 0) weights = bricks.map((brick) => Math.max(0, brick.realisticMaxUnits));
  if (sum(weights) <= 0) weights = bricks.map(() => 1);
  const totalWeight = sum(weights);
  const shares = bricks.map((brick, index) => {
    const exact = (units * weights[index]) / totalWeight;
    return { brickId: brick.brickId, index, whole: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = units - sum(shares.map((share) => share.whole));
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const share of byRemainder) {
    if (left <= 0) break;
    share.whole += 1;
    left -= 1;
  }
  for (const share of shares) out[share.brickId] = share.whole;
  return out;
}

/**
 * A product's units per brick: the brick units given, when they are whole, name only this product's
 * bricks and add up to the product's units — else the product split by its bricks' pace. A brick the
 * given split leaves out reads 0. {} for a product with no bricks.
 */
export function brickUnitsFor(
  bricks: readonly BrickPlanRow[],
  productUnits: number,
  given: Record<string, number> | null | undefined,
): Record<string, number> {
  if (bricks.length === 0) return {};
  if (given) {
    const known = new Set(bricks.map((brick) => brick.brickId));
    const entries = Object.entries(given);
    const whole = entries.every(([brickId, units]) => known.has(brickId) && Number.isSafeInteger(units) && units >= 0);
    const sum = entries.reduce((total, [, units]) => total + units, 0);
    if (whole && sum === productUnits) {
      const out: Record<string, number> = {};
      for (const brick of bricks) out[brick.brickId] = given[brick.brickId] ?? 0;
      return out;
    }
  }
  return splitAcrossBricks(productUnits, bricks);
}

// ── The payload the screen renders ───────────────────────────────────────────

export type ConcentrationPlanRow = {
  /** product_code — the key the forecast is stored under. Never rendered. */
  productCode: string;
  name: string;
  family: string;
  price: number;
  targetUnits: number | null;
  targetValue: number | null;
  actualUnits: number;
  actualValue: number;
  gradedUnits: number;
  gradedValue: number;
  /** Closed months, oldest first, with the month's units in this viewer's scope. */
  history: Array<{ period: string; label: string; units: number }>;
  trend: TrendReading;
  /** Rule 9 — the bricks this product sold on in scope, biggest pace first. [] when none did. */
  bricks: BrickPlanRow[];
};

/**
 * The Sato half of the Pedia incentive, measured on this plan's period: Guamusin + Ivyronc on
 * their OWN target (rule 7). Set only on the Pedia line, from Semester 2 2026, when the viewer's
 * scope carries a Sato product at all.
 */
export type SatoHalfGroup = {
  /** product_codes — identities, never rendered. */
  productCodes: string[];
  /** The products by name, e.g. "Guamusin and Ivyronc". */
  productNames: string;
  targetValue: number | null;
  gradedValue: number;
};

export type LinePlanGroup = {
  lineCode: string;
  lineName: string;
  /** Open months of the period that carry a target (rule 6) — what the forecast fills. */
  remainingMonths: number;
  closedMonthLabels: string[];
  forecastMonthLabels: string[];
  /** Open months with no target loaded yet. Named on screen, never forecast. */
  untargetedMonthLabels: string[];
  targetValue: number | null;
  gradedValue: number;
  actualValue: number;
  /** Pedia only — the Sato half. null on every other line. */
  satoHalf: SatoHalfGroup | null;
  rows: ConcentrationPlanRow[];
};

export type SavedPlanSummary = {
  id: string;
  name: string;
  units: Record<string, number>;
  /** Rule 9 — product_code → brick_id → units, as saved. A product missing here is split by pace. */
  bricks: Record<string, Record<string, number>>;
  forecastValue: number;
  forecastAchievement: number | null;
  /** Cairo local, formatted server-side. */
  updatedAtLabel: string;
};

/**
 * A Pedia rep's Sato half at their own expected pace (rule 7) — Guamusin + Ivyronc over their own
 * target. On the team list the rep's `expectedAchievement` is the TOTAL half, so this is its
 * companion. null on every other line and before Semester 2 2026.
 */
export type RepSatoHalf = {
  productNames: string;
  /** At the rep's pace; null when the Sato half carries no target yet. */
  achievement: number | null;
  hasTarget: boolean;
};

export type RepPlanSummary = {
  /** HR id — identity for the drill-down link, never rendered. */
  key: string;
  name: string;
  targetValue: number | null;
  gradedValue: number;
  expectedValue: number;
  expectedAchievement: number | null;
  /** The Sato half at pace for a Pedia rep — the companion to `expectedAchievement`'s total half. */
  pediaSato: RepSatoHalf | null;
  savedPlans: SavedPlanSummary[];
};

export type MakeItHappenWorkspace = {
  periodKind: PeriodKind;
  periodKey: string;
  periodLabel: string;
  offered: Record<PeriodKind, Array<{ value: string; label: string }>>;
  scopeLabel: string;
  isEmptyScope: boolean;
  /** Set when a manager is looking at one of their reps. */
  viewingRep: { key: string; name: string } | null;
  canSave: boolean;
  /** False until the saved-plans table exists — the planner says so instead of listing nothing. */
  plansAvailable: boolean;
  /** False when the brick read failed — the products still plan, and the screen says so (rule 9). */
  bricksAvailable: boolean;
  lines: LinePlanGroup[];
  totals: { targetValue: number | null; gradedValue: number; actualValue: number };
  reps: RepPlanSummary[];
  /** The viewer's own plans — or, when viewing a rep, that rep's. */
  plans: SavedPlanSummary[];
};
