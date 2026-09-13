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
//   4. "Realistic" follows each concentration's own month-by-month pace:
//        · growing  → the growth may continue, never above its best normal month;
//        · flat     → stays flat;
//        · declining→ holds its recent level, never an invented recovery;
//        · fewer than three closed months → capped at the AVERAGE of the closed months
//          (owner's pick over "best month" and "latest month").
//      A one-off spike (a bulk order) is ignored before the trend is read.
//   5. When the target cannot be reached realistically, the plan says so — it never pads the
//      numbers to a 100% it does not believe.
//
// Achievement divides the GRADED actual (every sale inside a month the group carries a target
// in) by the target — the Sales vs Target rule, so this screen agrees with that one.
// ─────────────────────────────────────────────────────────────────────────────

/** The first month Make It Happen reads (owner decision 2026-09-14). */
export const MAKE_IT_HAPPEN_FLOOR = "2026-07";
/** Below this many closed months the trend is not read at all — the average caps the plan. */
export const EARLY_HISTORY_MONTHS = 3;
/** How many closed months the trend reads, newest first. */
export const TREND_WINDOW_MONTHS = 6;
/** A month above this multiple of the median is a one-off (a bulk order), not a pace. */
export const SPIKE_MULTIPLE = 2.5;
/** A monthly slope within ±5% of the average month is flat. */
export const FLAT_BAND = 0.05;
/** A forecast larger than this is a typing slip, not a plan. */
export const MAX_FORECAST_UNITS = 10_000_000;

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
  return `${key.endsWith("1") ? "First" : "Second"} half ${year} · ${span}`;
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

/**
 * Read one concentration's monthly units (closed months, oldest first, a month with no sales
 * passed as 0) and turn it into what the remaining months can realistically hold.
 */
export function readTrend(history: readonly number[], remainingMonths: number): TrendReading {
  const months = Math.max(0, Math.floor(remainingMonths));
  const series = history.filter((value) => Number.isFinite(value)).slice(-TREND_WINDOW_MONTHS);
  const empty = { historyMonths: series.length, spikesIgnored: 0 };

  if (series.length === 0 || series.every((value) => value <= 0)) {
    return { kind: "none", ...empty, expectedUnits: 0, realisticMaxUnits: 0 };
  }

  if (series.length < EARLY_HISTORY_MONTHS) {
    const units = Math.floor(Math.max(0, mean(series)) * months);
    return { kind: "early", ...empty, expectedUnits: units, realisticMaxUnits: units };
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
  const recent = Math.max(0, mean(cleaned.slice(-EARLY_HISTORY_MONTHS)));
  const slope = robustSlope(cleaned);
  const relative = average > 0 ? slope / average : 0;
  const reading = { historyMonths: cleaned.length, spikesIgnored };

  if (relative >= FLAT_BAND) {
    const anchor = cleaned[cleaned.length - 1];
    const best = Math.max(...cleaned);
    let path = 0;
    for (let step = 1; step <= months; step += 1) path += Math.max(0, Math.min(anchor + slope * step, best));
    const expectedUnits = Math.floor(recent * months);
    return { kind: "growing", ...reading, expectedUnits, realisticMaxUnits: Math.max(expectedUnits, Math.floor(path)) };
  }

  if (relative <= -FLAT_BAND) {
    const level = Math.max(0, Math.min(cleaned[cleaned.length - 1], recent));
    const units = Math.floor(level * months);
    return { kind: "declining", ...reading, expectedUnits: units, realisticMaxUnits: units };
  }

  const units = Math.floor(recent * months);
  return { kind: "flat", ...reading, expectedUnits: units, realisticMaxUnits: units };
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
 * Start every concentration at its expected pace, then — only if that leaves a gap — raise the
 * ones with realistic headroom, those still short of their own target first, biggest headroom
 * value next. Stops the moment the gap closes; never plans above a concentration's realistic max.
 */
export function buildRealisticMix(items: readonly MixItem[], gapValue: number | null): MixResult {
  const units: Record<string, number> = {};
  let plannedValue = 0;
  for (const item of items) {
    const start = Math.max(0, Math.floor(item.expectedUnits));
    units[item.key] = start;
    plannedValue += start * item.price;
  }
  if (gapValue == null) return { units, reachable: null, shortValue: 0, plannedValue };

  let remaining = gapValue - plannedValue;
  const candidates = items
    .filter((item) => item.price > 0 && item.realisticMaxUnits > units[item.key])
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
    plannedValue += add * item.price;
    remaining -= add * item.price;
  }

  return { units, reachable: remaining <= 0, shortValue: Math.max(0, remaining), plannedValue };
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
};

export type LinePlanGroup = {
  lineCode: string;
  lineName: string;
  /** Months of the period still open for this line — what the forecast fills. */
  remainingMonths: number;
  closedMonthLabels: string[];
  forecastMonthLabels: string[];
  targetValue: number | null;
  gradedValue: number;
  actualValue: number;
  rows: ConcentrationPlanRow[];
};

export type SavedPlanSummary = {
  id: string;
  name: string;
  units: Record<string, number>;
  forecastValue: number;
  forecastAchievement: number | null;
  /** Cairo local, formatted server-side. */
  updatedAtLabel: string;
};

export type RepPlanSummary = {
  /** HR id — identity for the drill-down link, never rendered. */
  key: string;
  name: string;
  targetValue: number | null;
  gradedValue: number;
  expectedValue: number;
  expectedAchievement: number | null;
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
  lines: LinePlanGroup[];
  totals: { targetValue: number | null; gradedValue: number; actualValue: number };
  reps: RepPlanSummary[];
  /** The viewer's own plans — or, when viewing a rep, that rep's. */
  plans: SavedPlanSummary[];
};
