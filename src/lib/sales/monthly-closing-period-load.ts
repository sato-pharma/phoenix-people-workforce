import type {
  MonthlyClosingDirectCell,
  MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import {
  MAX_PERIOD_SELECTION,
  mergeMonthlyClosingMatrices,
} from "@/lib/sales/monthly-closing-period-merge";

// ─────────────────────────────────────────────────────────────────────────────
// Reading one or several closing months.
//
// SERVER-ONLY — it reaches the database. The arithmetic that folds those months together is pure
// and lives in monthly-closing-period-merge.ts, so a client component can import the period parser
// and the month labels without dragging any of this with it.
// ─────────────────────────────────────────────────────────────────────────────

export type MergedMonthlyClosingParts = {
  /**
   * The UNMERGED `combined` matrix of every month actually read, keyed by that matrix's OWN
   * `period` — so a caller that needs one month on its own (the Performance Review's by-month
   * series) can reuse the read instead of loading the month a second time (PERF-021, 2026-10-04).
   * Never the folded matrix: under a multi-month selection `combined` is several months summed, and
   * one bar carrying all of them is exactly the defect the series guards against. One entry for a
   * single month (and for the default-month fallback), none when the read resolved no month.
   * Treat every entry as read-only — it is the same object `combined` holds for a single month.
   */
  byPeriod: ReadonlyMap<string, MonthlyClosingMatrix>;
  combined: MonthlyClosingMatrix;
  directCells: MonthlyClosingDirectCell[];
  office: MonthlyClosingMatrix | null;
  /** The months actually READ — a requested month the closing has no data for is not in here. */
  periods: string[];
  retail: MonthlyClosingMatrix;
  /** Requested but unreadable, so a screen can say which month is missing instead of undercounting silently. */
  skipped: string[];
};

/** Key single-month matrices by their OWN period; a matrix that resolved no month is left out. */
function byOwnPeriod(matrices: MonthlyClosingMatrix[]): ReadonlyMap<string, MonthlyClosingMatrix> {
  const map = new Map<string, MonthlyClosingMatrix>();
  for (const matrix of matrices) {
    if (matrix.period) map.set(matrix.period, matrix);
  }
  return map;
}

/**
 * Load one or several months of the closing and hand back one set of parts.
 *
 * A single month is the plain loader, untouched — same object the closing has always rendered.
 * Several months are read in parallel and folded by mergeMonthlyClosingMatrices.
 *
 * Two guards matter here, and both were learned on the Performance Review's own series:
 *
 * - The loader FALLS BACK to a default month when the one asked for has no data. Accepting that
 *   silently would fold the same month in twice under two headings and inflate every total, so a
 *   result whose own `period` is not the requested one is dropped and reported in `skipped`.
 * - `directCells` is concatenated rather than merged, because every consumer aggregates it by
 *   area and product (monthly-closing-export.ts, closing-organogram-regions.ts) — so the sum over
 *   a concatenation of months is the sum across those months, with no double counting.
 */
export async function loadMergedMonthlyClosingParts(input: {
  line?: string | null;
  periods: string[];
  /** Lets a read-only screen take a read that settled this many ms ago (closing-load-gate.ts). */
  reuseMs?: number;
}): Promise<MergedMonthlyClosingParts> {
  const reuse = { reuseMs: input.reuseMs };
  const requested = Array.from(new Set(input.periods.filter(Boolean))).sort();
  // Most recent wins when a selection is over the cap — a reader who over-selects wants the recent
  // months, and silently keeping the OLDEST would answer a question nobody asked.
  const wanted = requested.slice(Math.max(0, requested.length - MAX_PERIOD_SELECTION));

  if (wanted.length <= 1) {
    const parts = await loadMonthlyClosingPartsWithStoreSplit(
      { line: input.line ?? null, period: wanted[0] ?? null },
      reuse,
    );
    const resolved = parts.combined.period;
    return {
      byPeriod: byOwnPeriod([parts.combined]),
      combined: parts.combined,
      directCells: parts.directCells,
      office: parts.office ?? null,
      periods: resolved ? [resolved] : [],
      retail: parts.retail,
      skipped: [],
    };
  }

  const loaded = await Promise.all(
    wanted.map(async (period) => {
      try {
        const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: input.line ?? null, period }, reuse);
        if (parts.combined.period !== period) return { parts: null, period };
        return { parts, period };
      } catch {
        // One unreadable month must not take the whole selection down — it is reported as skipped.
        return { parts: null, period };
      }
    }),
  );

  const usable = loaded.filter((entry) => entry.parts !== null);
  const skipped = loaded.filter((entry) => entry.parts === null).map((entry) => entry.period);

  if (usable.length === 0) {
    // Nothing readable: fall back to the plain loader's own default month rather than inventing an
    // empty closing, which would render as a real month that happens to be all zeros.
    const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: input.line ?? null, period: null }, reuse);
    return {
      byPeriod: byOwnPeriod([parts.combined]),
      combined: parts.combined,
      directCells: parts.directCells,
      office: parts.office ?? null,
      periods: parts.combined.period ? [parts.combined.period] : [],
      retail: parts.retail,
      skipped,
    };
  }

  const offices = usable
    .map((entry) => entry.parts!.office)
    .filter((office): office is MonthlyClosingMatrix => Boolean(office));

  return {
    // `usable` already guarantees each entry's own `combined.period` is the month it was read for.
    byPeriod: byOwnPeriod(usable.map((entry) => entry.parts!.combined)),
    combined: mergeMonthlyClosingMatrices(usable.map((entry) => entry.parts!.combined)),
    directCells: usable.flatMap((entry) => entry.parts!.directCells),
    office: offices.length > 0 ? mergeMonthlyClosingMatrices(offices) : null,
    periods: usable.map((entry) => entry.period),
    retail: mergeMonthlyClosingMatrices(usable.map((entry) => entry.parts!.retail)),
    skipped,
  };
}
