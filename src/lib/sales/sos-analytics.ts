// Pure month-over-month + Pareto analytics for the Source-of-Sales dashboard.
//
// Everything here is presentation-layer math over rows the SoS engine has ALREADY scoped,
// confidential-stripped and valued — no Supabase access, no formula of its own beyond
// subtraction/percentages, so it can be unit-tested in isolation (tests/sos-analytics.test.ts)
// and can never change calculation semantics.

/** One compared measure: current vs the prior period. deltaPct is null when previous <= 0. */
export type SosDelta = {
  current: number;
  previous: number;
  delta: number;
  deltaPct: number | null;
};

/** A dimension row that moved between periods (present in both, prior value > 0). */
export type SosMoverRow = {
  code: string;
  label: string;
  value: number;
  prevValue: number;
  delta: number;
  deltaPct: number;
};

export type SosMovers = { gainers: SosMoverRow[]; decliners: SosMoverRow[] };

/** A dimension row that exists in only one of the two periods. */
export type SosNewLostRow = { code: string; label: string; value: number };

export type SosParetoRow = {
  code: string;
  label: string;
  line: string | null;
  value: number;
  units: number;
  share: number;
  cumulativeShare: number;
  abcClass: "A" | "B" | "C";
};

/** Minimal shape shared by every grouped dimension row this module compares. */
export type SosComparableRow = { code: string; label: string; value: number };

/**
 * The next-older period after `selectedPeriod` among the validated periods.
 * Sorts a copy descending internally — never trusts the input ordering — and
 * returns null when the selected period is the oldest (or absent).
 */
export function resolvePriorPeriod(availablePeriods: string[], selectedPeriod: string | null): string | null {
  if (!selectedPeriod) return null;
  const sorted = [...new Set(availablePeriods)].sort((left, right) => right.localeCompare(left));
  const index = sorted.indexOf(selectedPeriod);
  if (index === -1) return null;
  return sorted[index + 1] ?? null;
}

/** Compare one measure across the two periods. deltaPct is null when previous <= 0 (no meaningful base). */
export function computeDelta(current: number, previous: number): SosDelta {
  return {
    current,
    previous,
    delta: current - previous,
    deltaPct: previous > 0 ? (current - previous) / previous : null,
  };
}

const byCode = (rows: SosComparableRow[]): Map<string, SosComparableRow> => {
  const map = new Map<string, SosComparableRow>();
  for (const row of rows) {
    const key = row.code.trim().toUpperCase();
    if (!key) continue;
    const existing = map.get(key);
    if (existing) existing.value += row.value;
    else map.set(key, { ...row });
  }
  return map;
};

/**
 * Top gainers/decliners between the two periods. Only rows present in BOTH periods with a
 * positive prior value qualify (new/lost rows are reported separately by computeNewAndLost,
 * and a zero/negative base makes deltaPct meaningless). Ranked by |deltaPct|, capped per side.
 */
export function computeMovers(
  current: SosComparableRow[],
  prior: SosComparableRow[],
  limit = 5,
): SosMovers {
  const priorMap = byCode(prior);
  const movers: SosMoverRow[] = [];
  for (const row of byCode(current).values()) {
    const before = priorMap.get(row.code.trim().toUpperCase());
    if (!before || before.value <= 0) continue;
    const delta = row.value - before.value;
    if (delta === 0) continue;
    movers.push({
      code: row.code,
      label: row.label,
      value: row.value,
      prevValue: before.value,
      delta,
      deltaPct: delta / before.value,
    });
  }
  const ranked = [...movers].sort((left, right) => Math.abs(right.deltaPct) - Math.abs(left.deltaPct));
  return {
    gainers: ranked.filter((row) => row.delta > 0).slice(0, limit),
    decliners: ranked.filter((row) => row.delta < 0).slice(0, limit),
  };
}

/**
 * EVERY dimension member's period-over-period deltaPct, keyed by normalized (upper/trim) code.
 * `computeMovers` caps its result to the top gainers/decliners for the "movers" widget — but the
 * full dashboard tables also drove their MoM Δ / YoY Δ columns off that capped set, so any row
 * outside the top-5 showed "—" even with perfectly valid prior data. This returns the delta for
 * ALL qualifying rows (present in both periods with a positive prior base), so the tables can show
 * each row's real % change; the movers widget keeps using the capped `computeMovers`. A member
 * present in both periods with an unchanged value is included with deltaPct 0 (a real "0.0%", not
 * the "—" reserved for members with no comparable prior value). Serializable Record so it crosses
 * the server → client boundary cleanly (no Map).
 */
export function computeDeltaPctByCode(
  current: SosComparableRow[],
  prior: SosComparableRow[],
): Record<string, number> {
  const priorMap = byCode(prior);
  const out: Record<string, number> = {};
  for (const row of byCode(current).values()) {
    const key = row.code.trim().toUpperCase();
    const before = priorMap.get(key);
    if (!before || before.value <= 0) continue; // no meaningful base → the table shows "—"
    out[key] = (row.value - before.value) / before.value;
  }
  return out;
}

/**
 * Dimension rows that appeared (current only) or disappeared (prior only) between the two
 * periods, each sorted by value descending and capped.
 */
export function computeNewAndLost(
  current: SosComparableRow[],
  prior: SosComparableRow[],
  limit = 12,
): { added: SosNewLostRow[]; removed: SosNewLostRow[] } {
  const currentMap = byCode(current);
  const priorMap = byCode(prior);
  const added: SosNewLostRow[] = [];
  const removed: SosNewLostRow[] = [];
  for (const [key, row] of currentMap) {
    if (!priorMap.has(key)) added.push({ code: row.code, label: row.label, value: row.value });
  }
  for (const [key, row] of priorMap) {
    if (!currentMap.has(key)) removed.push({ code: row.code, label: row.label, value: row.value });
  }
  const byValueDesc = (left: SosNewLostRow, right: SosNewLostRow) => right.value - left.value;
  return { added: added.sort(byValueDesc).slice(0, limit), removed: removed.sort(byValueDesc).slice(0, limit) };
}

/**
 * Pareto / ABC classification over value-descending rows: cumulative share of total value,
 * class A while cumulative <= 80%, B while <= 95%, C for the tail. Zero/negative totals
 * yield an empty result (no meaningful distribution).
 */
export function computePareto(
  rows: { code: string; label: string; line?: string | null; value: number; units: number; share?: number }[],
): SosParetoRow[] {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  if (total <= 0) return [];
  const sorted = [...rows].filter((row) => row.value > 0).sort((left, right) => right.value - left.value);
  let cumulative = 0;
  return sorted.map((row) => {
    cumulative += row.value;
    const cumulativeShare = cumulative / total;
    return {
      code: row.code,
      label: row.label,
      line: row.line ?? null,
      value: row.value,
      units: row.units,
      share: row.value / total,
      cumulativeShare,
      abcClass: cumulativeShare <= 0.8 ? "A" : cumulativeShare <= 0.95 ? "B" : "C",
    };
  });
}

/** One dimension member's contribution to the TOTAL month-over-month change in value. */
export type SosContributionRow = {
  code: string;
  label: string;
  value: number;
  prevValue: number;
  delta: number;
  /** This member's delta as a share of the total absolute movement (sum of |delta| over members). */
  contribution: number;
};

/**
 * Growth-contribution decomposition: how much each member drove the period's total change. The
 * denominator is the sum of ABSOLUTE deltas so gainers and decliners each get a positive-magnitude
 * share that sums to 1 — the standard "who moved the number" waterfall input. Members present in
 * either period participate (a new member's prevValue is 0, a lost member's value is 0).
 */
export function computeContribution(
  current: SosComparableRow[],
  prior: SosComparableRow[],
  limit = 15,
): SosContributionRow[] {
  const currentMap = byCode(current);
  const priorMap = byCode(prior);
  const codes = new Set([...currentMap.keys(), ...priorMap.keys()]);
  const rows = [...codes].map((code) => {
    const now = currentMap.get(code);
    const before = priorMap.get(code);
    const value = now?.value ?? 0;
    const prevValue = before?.value ?? 0;
    return { code, label: (now ?? before)!.label, value, prevValue, delta: value - prevValue };
  });
  const totalAbs = rows.reduce((sum, row) => sum + Math.abs(row.delta), 0);
  return rows
    .filter((row) => row.delta !== 0)
    .map((row) => ({ ...row, contribution: totalAbs > 0 ? Math.abs(row.delta) / totalAbs : 0 }))
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, limit);
}

/** One dimension member flagged as a statistical outlier by its value's z-score. */
export type SosOutlierRow = {
  code: string;
  label: string;
  value: number;
  /** Standard deviations from the mean of the population's values. */
  z: number;
  direction: "high" | "low";
};

/**
 * Z-score outlier detection over a set of dimension values (e.g. per-region or per-product totals).
 * Returns members whose value is at least `threshold` population standard deviations from the mean,
 * strongest first. A degenerate population (< 3 members or zero variance) yields no outliers.
 */
export function computeOutliers(
  rows: SosComparableRow[],
  threshold = 2,
): SosOutlierRow[] {
  const values = rows.map((row) => row.value);
  if (values.length < 3) return [];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return [];
  return rows
    .map((row) => ({ code: row.code, label: row.label, value: row.value, z: (row.value - mean) / sd }))
    .filter((row) => Math.abs(row.z) >= threshold)
    .map((row) => ({ ...row, direction: row.z >= 0 ? ("high" as const) : ("low" as const) }))
    .sort((left, right) => Math.abs(right.z) - Math.abs(left.z));
}
