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
import { buildClosingNoOfficeSheet } from "@/lib/sales/closing-no-office-sheet";
import { fillClosingEngine } from "@/lib/sales/closing-engine-fill";
import { resolveClosingFileName } from "@/lib/sales/closing-export-file-name";
import type { ClosingExportFilter } from "@/lib/sales/closing-export-payload";
import { loadClosingPerformanceReview, PERFORMANCE_REVIEW_MONTHS } from "@/lib/sales/closing-performance-review";
import { loadDistributorNameIndex } from "@/lib/sales/closing-details-distributor-names";
import { buildReviewSheets } from "@/lib/sales/closing-review-sheets";
import { buildClosingRowsSheet } from "@/lib/sales/closing-rows-sheet";
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
  // The span's Office slice, on the same grid and narrowed by the SAME filter — which is all the
  // Office-free twin needs, and `ClosingExportFilter` has no row-level field for it to miss.
  const office = parts.office ? filterMonthlyClosingMatrix(parts.office, input.filter) : null;

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
  // 🔴 THE CLOSING MATRIX WITHOUT THE OFFICE CHANNEL, as the tab straight after it (owner,
  // 2026-10-05). CNS only — Office is a CNS-only channel, so the builder returns null on every
  // other line and no other workbook gains a copy of the grid before it. Its title carries the
  // span rather than one month, because the matrix it reduces is the merged one.
  const noOfficeSheet = buildClosingNoOfficeSheet(matrix, office, {
    filterNote,
    periodLabel: consolidatedSpanLabel(parts.periods),
  });
  // 🔴 EVERY COUNTED ROW OF THE SPAN, AT INVOICE GRAIN (owner, 2026-10-13). The same tab the
  // single-month premium carries, over the months this file adds together. `details` above is
  // already all-or-nothing across those months, so the tab is absent rather than partial whenever
  // one of them failed to load — a span's detail sheet missing a month would undercount against a
  // matrix that does not. Each row carries its own invoice date, so no extra month column is needed.
  const rowsSheet = buildClosingRowsSheet({
    distributorNames: await loadDistributorNameIndex(),
    filterNote,
    line: matrix.line,
    periodLabel: consolidatedSpanLabel(parts.periods),
    rows: details ?? [],
  });
  const buffer = await fillClosingEngine(fill, {
    macroFree: !input.macros,
    reviewSheets: [
      ...reviewSheets,
      ...(noOfficeSheet ? [noOfficeSheet] : []),
      ...(rowsSheet ? [rowsSheet] : []),
    ],
  });

  return {
    buffer,
    fileName: await resolveClosingFileName({
      extension: input.macros ? "xlsm" : "xlsx",
      kind: "premium-consolidated",
      line: matrix.line ?? input.line,
      period: consolidatedFilePeriod(parts.periods),
      regionNames: (matrix.regions.map((region) => region.regionName)),
    }),
    periods: parts.periods,
    skipped: parts.skipped,
  };
}
