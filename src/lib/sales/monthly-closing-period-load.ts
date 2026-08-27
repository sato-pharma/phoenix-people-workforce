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
  combined: MonthlyClosingMatrix;
  directCells: MonthlyClosingDirectCell[];
  office: MonthlyClosingMatrix | null;
  /** The months actually READ — a requested month the closing has no data for is not in here. */
  periods: string[];
  retail: MonthlyClosingMatrix;
  /** Requested but unreadable, so a screen can say which month is missing instead of undercounting silently. */
  skipped: string[];
};

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
}): Promise<MergedMonthlyClosingParts> {
  const requested = Array.from(new Set(input.periods.filter(Boolean))).sort();
  // Most recent wins when a selection is over the cap — a reader who over-selects wants the recent
  // months, and silently keeping the OLDEST would answer a question nobody asked.
  const wanted = requested.slice(Math.max(0, requested.length - MAX_PERIOD_SELECTION));

  if (wanted.length <= 1) {
    const parts = await loadMonthlyClosingPartsWithStoreSplit({
      line: input.line ?? null,
      period: wanted[0] ?? null,
    });
    const resolved = parts.combined.period;
    return {
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
        const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: input.line ?? null, period });
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
    const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: input.line ?? null, period: null });
    return {
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
    combined: mergeMonthlyClosingMatrices(usable.map((entry) => entry.parts!.combined)),
    directCells: usable.flatMap((entry) => entry.parts!.directCells),
    office: offices.length > 0 ? mergeMonthlyClosingMatrices(offices) : null,
    periods: usable.map((entry) => entry.period),
    retail: mergeMonthlyClosingMatrices(usable.map((entry) => entry.parts!.retail)),
    skipped,
  };
}
