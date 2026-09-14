// The CONSOLIDATED premium closing — several months of one line added together, written into the
// owner's premium engine. Super Admin and the CEO only (owner, 2026-09-14: "Premium engine, summed").
//
// 🔒 The engine is FILLED, never rebuilt: this hands fillClosingEngine an ordinary fill, built from the
// months added together and then relabelled for the span by consolidateEngineFill.
//
// The months come from loadMergedMonthlyClosingParts, which reads each month WITH its own store split
// and folds the answers — the same "split each month, then add" the normal consolidated workbook uses —
// and the Performance Review is read over the same selection, so both halves of the file sum the same
// months. Two things a single month carries are deliberately absent:
//   - the prior-month comparison: a span has no single month before it (see CONSOLIDATED_PRIOR_CELLS);
//   - the Export PDF links and the quarter tab: both describe one month and are sealed to one.

import type { AccessContext } from "@/lib/auth/permissions";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import {
  ConsolidatedClosingSelectionError,
  MIN_CONSOLIDATED_MONTHS,
  consolidateEngineFill,
  consolidatedFilePeriod,
  consolidatedFilterParts,
  consolidatedSpanLabel,
  describeConsolidatedClosing,
} from "@/lib/sales/closing-consolidated";
import { buildClosingEngineFill } from "@/lib/sales/closing-engine-data";
import { fillClosingEngine } from "@/lib/sales/closing-engine-fill";
import { closingFileName, regionScopeLabel } from "@/lib/sales/closing-export-filename";
import type { ClosingExportFilter } from "@/lib/sales/closing-export-payload";
import { loadClosingPerformanceReview, PERFORMANCE_REVIEW_MONTHS } from "@/lib/sales/closing-performance-review";
import { buildReviewSheets } from "@/lib/sales/closing-review-sheets";
import { type ClosingDetailRow, loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { loadMergedMonthlyClosingParts } from "@/lib/sales/monthly-closing-period-load";
import { filterMonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

const MONTH_CONCURRENCY = 3;

export type ConsolidatedPremiumClosing = {
  buffer: Buffer;
  fileName: string;
  periods: string[];
  skipped: string[];
};

export async function buildConsolidatedPremiumClosing(input: {
  access: AccessContext;
  filter: ClosingExportFilter;
  line: string;
  /** False builds the button-less .xlsx. */
  macros: boolean;
  periods: readonly string[];
}): Promise<ConsolidatedPremiumClosing> {
  const requested = Array.from(new Set(input.periods)).sort();
  const [parts, review] = await Promise.all([
    loadMergedMonthlyClosingParts({ line: input.line, periods: requested }),
    loadClosingPerformanceReview({
      filter: input.filter,
      line: input.line,
      // The month-by-month series reaches back at least as far as the selection does.
      months: Math.max(PERFORMANCE_REVIEW_MONTHS, requested.length),
      periods: requested,
    }),
  ]);

  // The merged loader guards each month's PERIOD, but a line it does not recognise falls back to
  // another line for every month alike — so the line is checked here, on what came back.
  const lineMatches = String(parts.combined.line ?? "").trim().toLowerCase() === input.line.trim().toLowerCase();
  if (!lineMatches || parts.periods.length < MIN_CONSOLIDATED_MONTHS) {
    throw new ConsolidatedClosingSelectionError(
      `Only ${lineMatches ? parts.periods.length : 0} of the ${requested.length} months picked have a closing for ${input.line}.`
      + " A consolidated closing needs at least two.",
    );
  }

  const matrix = filterMonthlyClosingMatrix(parts.combined, input.filter);

  // Every month's invoice lines, for the Details and Top Customers pages. Masked by default — this
  // read never reveals. All or nothing: a month that failed to load would make those pages undercount
  // the span beside a matrix that does not, so the pages are left empty rather than partly filled.
  const perMonth = await mapWithConcurrency(parts.periods, MONTH_CONCURRENCY, async (period) => {
    const loaded = await loadMonthlyClosingDetails({
      access: input.access,
      availableLines: matrix.availableLines,
      availablePeriods: matrix.availablePeriods,
      filters: {
        areaCodes: input.filter.areaCodes,
        productCodes: input.filter.productCodes,
        regionCodes: input.filter.regionCodes,
      },
      line: matrix.line,
      period,
      unpaged: true,
    }).catch(() => null);
    return loaded && loaded.period === period ? loaded.rows : null;
  });
  const details: ClosingDetailRow[] | null = perMonth.every((rows) => rows !== null)
    ? perMonth.flatMap((rows) => rows ?? [])
    : null;

  const filterNote = describeConsolidatedClosing({
    filterParts: consolidatedFilterParts(input.filter, review.filterOptions),
    line: null,
    noPriorComparison: true,
    periods: parts.periods,
    skipped: parts.skipped,
  });

  const fill = consolidateEngineFill(
    buildClosingEngineFill({ coverage: null, details, filterNote, matrix, priorMatrix: null, review }),
    { latestPeriod: matrix.period, periods: parts.periods },
  );
  const reviewSheets = buildReviewSheets(review, { line: matrix.line, period: consolidatedSpanLabel(parts.periods) });
  const buffer = await fillClosingEngine(fill, { macroFree: !input.macros, reviewSheets });

  return {
    buffer,
    fileName: closingFileName({
      extension: input.macros ? "xlsm" : "xlsx",
      kind: "premium-consolidated",
      line: matrix.line ?? input.line,
      period: consolidatedFilePeriod(parts.periods),
      region: regionScopeLabel(matrix.regions.map((region) => region.regionName)),
    }),
    periods: parts.periods,
    skipped: parts.skipped,
  };
}
