// Which months, and which distributors within a month, actually made it into Source of Sales.
//
// Nothing in the pipeline notices a month that was never uploaded. On 2026-07-31 production held
// batches for 2026-01, 02, 03, 04 and 06 — **2026-05 is simply absent**, and 2026-07 is empty — yet
// every trend line drew straight through the gap and every month-over-month comparison treated the
// jump as a real movement.
//
// Per-distributor coverage varies too, which is the subtler problem: January is missing EP-BK and
// EP-PHS entirely (~3.5M EGP using February as the proxy), February is missing SF, February and
// March are missing RM-T, March is missing EG-HOS, June is missing CP, and January-March are missing
// SF-T. So "January 39.7M vs February 32.2M" is not a like-for-like comparison at all — it partly
// measures which files were uploaded.
//
// This module answers that with data the batch table already carries: no new RPC, no new table.
// Pure functions over a batch list so they are unit-testable; the caller does the one select.

/** One validated batch, as read from source_of_sales_import_batches. */
export type SosCoverageBatch = {
  period: string;
  distributorCode: string;
  totalValue: number | null;
};

export type SosDistributorCoverage = {
  distributorCode: string;
  /** Periods (of those loaded) where this distributor has no batch at all. */
  missingPeriods: string[];
  /**
   * Missing periods that sit BETWEEN two months this distributor did land in. These are
   * unambiguous holes — the distributor demonstrably existed on both sides.
   */
  interiorMissingPeriods: string[];
  /** First loaded period this distributor appears in. Lets the UI say "first seen 2026-02". */
  firstSeen: string;
  /** Mean value across the periods it DID land in — the scale of what a gap is hiding. */
  averageValue: number;
  /** averageValue x missingPeriods.length. An estimate, explicitly not a measurement. */
  estimatedMissingValue: number;
};

export type SosPeriodCoverage = {
  period: string;
  distributorCount: number;
  totalValue: number;
  /** Distributors seen in ANY examined period but absent from this one. */
  missingDistributors: string[];
  /**
   * True when this period is missing at least one distributor that other periods have. A trend
   * chart must mark these rather than plotting them as a real decline.
   */
  incomplete: boolean;
};

export type SosCoverageReport = {
  /** Every period that has at least one batch, oldest first. */
  loadedPeriods: string[];
  /**
   * Calendar months between the first and last loaded period with NO batches at all — the 2026-05
   * case. Empty when the loaded periods are contiguous.
   */
  missingPeriods: string[];
  periods: SosPeriodCoverage[];
  distributors: SosDistributorCoverage[];
  /** True when anything at all is missing — the single flag a dashboard needs to show a warning. */
  hasGaps: boolean;
};

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Every calendar month from `from` to `to` inclusive, both "YYYY-MM". */
export function enumeratePeriods(from: string, to: string): string[] {
  if (!PERIOD_RE.test(from) || !PERIOD_RE.test(to) || from > to) return [];
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  // Bounded by construction, but keep a hard stop so a malformed input can never spin.
  for (let i = 0; i < 600; i += 1) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    if (year === endYear && month === endMonth) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the coverage report. Pure — unit-tested directly.
 *
 * A distributor is only expected in a period once it has appeared at least once anywhere in the
 * examined window; a distributor that was onboarded in March is not reported "missing" from January.
 * That keeps the report actionable rather than noisy.
 */
export function buildSosCoverageReport(batches: SosCoverageBatch[]): SosCoverageReport {
  const valid = batches.filter((b) => PERIOD_RE.test(b.period ?? "") && (b.distributorCode ?? "").trim() !== "");

  const loadedPeriods = [...new Set(valid.map((b) => b.period))].sort();
  if (loadedPeriods.length === 0) {
    return { loadedPeriods: [], missingPeriods: [], periods: [], distributors: [], hasGaps: false };
  }

  // Months with no batches at all, inside the loaded range.
  const loadedSet = new Set(loadedPeriods);
  const missingPeriods = enumeratePeriods(loadedPeriods[0], loadedPeriods[loadedPeriods.length - 1]).filter(
    (p) => !loadedSet.has(p),
  );

  // period -> distributor -> summed value (a distributor can have more than one batch in a month).
  const byPeriod = new Map<string, Map<string, number>>();
  for (const batch of valid) {
    const code = batch.distributorCode.trim();
    const perPeriod = byPeriod.get(batch.period) ?? new Map<string, number>();
    perPeriod.set(code, (perPeriod.get(code) ?? 0) + Number(batch.totalValue ?? 0));
    byPeriod.set(batch.period, perPeriod);
  }

  const firstSeen = new Map<string, string>();
  for (const batch of valid) {
    const code = batch.distributorCode.trim();
    const seen = firstSeen.get(code);
    if (!seen || batch.period < seen) firstSeen.set(code, batch.period);
  }

  const periods: SosPeriodCoverage[] = loadedPeriods.map((period) => {
    const perPeriod = byPeriod.get(period) ?? new Map<string, number>();
    // Expected in EVERY loaded period, not only from its first appearance onward.
    //
    // The narrower "only after first seen" rule reads well in the abstract and is wrong for this
    // dataset: the whole SoS history was backfilled over three days, so a distributor whose January
    // file was simply never uploaded looks identical to one onboarded in February — and the rule
    // would have hidden exactly the January EP-BK / EP-PHS hole (~3.5M EGP) that this module exists
    // to surface. `firstSeen` is reported alongside so a genuine onboarding is still explainable
    // rather than silently dropped.
    const missingDistributors = [...firstSeen.keys()]
      .filter((code) => !perPeriod.has(code))
      .sort();
    return {
      period,
      distributorCount: perPeriod.size,
      totalValue: round2([...perPeriod.values()].reduce((sum, v) => sum + v, 0)),
      missingDistributors,
      incomplete: missingDistributors.length > 0,
    };
  });

  const distributors: SosDistributorCoverage[] = [...firstSeen.keys()]
    .map((code) => {
      const present = loadedPeriods.filter((p) => byPeriod.get(p)?.has(code));
      const missing = loadedPeriods.filter((p) => !byPeriod.get(p)?.has(code));
      const earliest = present[0] ?? "";
      const latest = present[present.length - 1] ?? "";
      // Between two months it demonstrably landed in — no onboarding story can explain these.
      const interiorMissingPeriods = missing.filter((p) => p > earliest && p < latest);
      const values = present.map((p) => byPeriod.get(p)?.get(code) ?? 0);
      const averageValue = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
      return {
        distributorCode: code,
        missingPeriods: missing,
        interiorMissingPeriods,
        firstSeen: earliest,
        averageValue: round2(averageValue),
        estimatedMissingValue: round2(averageValue * missing.length),
      };
    })
    .filter((d) => d.missingPeriods.length > 0)
    .sort((a, b) => b.estimatedMissingValue - a.estimatedMissingValue);

  return {
    loadedPeriods,
    missingPeriods,
    periods,
    distributors,
    hasGaps: missingPeriods.length > 0 || distributors.length > 0,
  };
}

/**
 * One line a non-engineer can act on, or null when nothing is missing.
 * Deliberately states the estimate as an estimate.
 */
export function describeSosCoverageGaps(report: SosCoverageReport): string | null {
  if (!report.hasGaps) return null;
  const parts: string[] = [];
  if (report.missingPeriods.length > 0) {
    parts.push(
      `${report.missingPeriods.join(", ")} ${report.missingPeriods.length === 1 ? "was" : "were"} never uploaded`,
    );
  }
  if (report.distributors.length > 0) {
    const worst = report.distributors[0];
    const others = report.distributors.length - 1;
    parts.push(
      `${worst.distributorCode} is missing from ${worst.missingPeriods.join(", ")}` +
        (worst.estimatedMissingValue > 0
          ? ` (roughly ${Math.round(worst.estimatedMissingValue).toLocaleString("en-US")} EGP, estimated from its other months)`
          : "") +
        (others > 0 ? `, and ${others} other distributor${others === 1 ? " has" : "s have"} gaps too` : ""),
    );
  }
  return `${parts.join(". ")}. Month-to-month comparisons that span these gaps are not like-for-like.`;
}
