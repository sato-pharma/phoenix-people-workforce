// The month, loaded once, for every export that renders it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT A THIRD COPY. Two exports already read this month — the auditor's
// workbook and the premium `.xlsm` — and their routes each spell the loading out inline, held in
// agreement only by whoever last edited both. A PDF renderer is the third reader, and three copies
// of a load whose every branch is a trap is where they finally drift:
//
//   - the prior month is checked against what it RETURNED, not what it was asked for, because
//     `loadMonthlyClosingParts` silently falls back to the newest available month — so asking for a
//     month that was never uploaded hands back THIS month and every growth figure becomes zero;
//   - `loadMonthlyClosingDetails` resolves its line by looking the requested one up in
//     `availableLines`, and falls back to `availableLines[0] ?? null`. Omit that list and the line
//     resolves to null and the loader returns an empty result WITHOUT THROWING, so the Details and
//     Top Customers pages ship blank behind a perfectly valid file;
//   - coverage is asked on the UNFILTERED line and period on purpose. Whether a distributor's file
//     arrived is a fact about the month, not about the regions this export happens to be narrowed to.
//
// Every one of those is a wrong NUMBER rather than an error, which is exactly the class of defect a
// second copy reproduces badly. Loading here means the PDF, the premium workbook and the closing
// screen cannot show different figures for the same selection.

import { filterMonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { buildClosingEngineFill, previousPeriod } from "@/lib/sales/closing-engine-data";
import { loadClosingPerformanceReview } from "@/lib/sales/closing-performance-review";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { loadMonthlySourceCoverage } from "@/lib/sales/source-coverage";

import type { ClosingEngineFill } from "./closing-engine-fill";

export type ClosingExportFilter = {
  areaCodes: string[];
  productCodes: string[];
  regionCodes: string[];
  search: string;
};

export type ClosingExportSelection = {
  /** The caller's access context, forwarded to the details loader for its own scoping. */
  access: Parameters<typeof loadMonthlyClosingDetails>[0]["access"];
  filter: ClosingExportFilter;
  line: string | null;
  period: string | null;
};

export type ClosingExportPayload = {
  fill: ClosingEngineFill;
  /** The line and period actually resolved, which may differ from what was asked for. */
  line: string;
  period: string;
  /** The filter stamp in human names, or "" when nothing was narrowed. */
  filterNote: string;
  matrix: Awaited<ReturnType<typeof loadMonthlyClosingPartsWithStoreSplit>>["combined"];
  review: Awaited<ReturnType<typeof loadClosingPerformanceReview>>;
};

/** An empty filter, for a caller that narrows nothing. */
export function emptyClosingExportFilter(): ClosingExportFilter {
  return { areaCodes: [], productCodes: [], regionCodes: [], search: "" };
}

/**
 * Read a filter off a query string.
 *
 * The PDF link inside the workbook is a GET — a hyperlink is the only control a `.xlsx` can carry —
 * so the same selection that reaches the workbook exports as a JSON body arrives here as repeated
 * query parameters. Blank entries are dropped rather than passed through: an empty `area=` would
 * otherwise narrow the export to an area code that is the empty string, which matches nothing and
 * renders as a page with no rows rather than as an error.
 */
export function closingExportFilterFromQuery(params: URLSearchParams): ClosingExportFilter {
  const list = (key: string) =>
    params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  return {
    areaCodes: list("area"),
    productCodes: list("product"),
    regionCodes: list("region"),
    search: (params.get("search") ?? "").trim(),
  };
}

/**
 * The filter stamp, in human names.
 *
 * Standing owner rule: names, never raw codes, in both the UI and anything printed. The options come
 * from the UNFILTERED matrix, so every code that survived the filter still resolves to the name it
 * was picked by — resolving against the filtered matrix would leave a narrowed-out code printing as
 * itself.
 */
function describeFilter(
  filter: ClosingExportFilter,
  options: ClosingExportPayload["review"]["filterOptions"],
): string {
  const nameOf = (list: { code: string; label: string }[], code: string) =>
    list.find((item) => item.code.trim().toUpperCase() === code.trim().toUpperCase())?.label ?? code;

  const parts: string[] = [];
  if (filter.regionCodes.length > 0) {
    parts.push(`Region: ${filter.regionCodes.map((code) => nameOf(options.regions, code)).join(", ")}`);
  }
  if (filter.areaCodes.length > 0) {
    parts.push(`Area: ${filter.areaCodes.map((code) => nameOf(options.areas, code)).join(", ")}`);
  }
  if (filter.productCodes.length > 0) {
    parts.push(`Product: ${filter.productCodes.map((code) => nameOf(options.products, code)).join(", ")}`);
  }
  if (filter.search.trim()) parts.push(`Area search: "${filter.search.trim()}"`);

  return parts.length === 0 ? "" : `Filtered export — this workbook covers only: ${parts.join(" · ")}.`;
}

/** Load the month and build the engine fill every closing export is written from. */
export async function loadClosingExportPayload(
  selection: ClosingExportSelection,
): Promise<ClosingExportPayload> {
  const [parts, review] = await Promise.all([
    loadMonthlyClosingPartsWithStoreSplit({ line: selection.line, period: selection.period }),
    loadClosingPerformanceReview({ filter: selection.filter, line: selection.line, period: selection.period }),
  ]);
  const matrix = filterMonthlyClosingMatrix(parts.combined, selection.filter);

  const priorPeriod = previousPeriod(matrix.period);
  const [priorParts, details, coverage] = await Promise.all([
    priorPeriod
      ? loadMonthlyClosingPartsWithStoreSplit({ line: matrix.line, period: priorPeriod }).catch(() => null)
      : Promise.resolve(null),
    loadMonthlyClosingDetails({
      access: selection.access,
      availableLines: matrix.availableLines,
      availablePeriods: matrix.availablePeriods,
      filters: {
        areaCodes: selection.filter.areaCodes,
        productCodes: selection.filter.productCodes,
        regionCodes: selection.filter.regionCodes,
      },
      line: matrix.line,
      period: matrix.period,
      unpaged: true,
    }).catch(() => null),
    loadMonthlySourceCoverage(matrix.line, matrix.period).catch(() => null),
  ]);

  // Checked against what it RETURNED — see the header note. A prior matrix for the wrong month is
  // worse than none, because the engine prints its comparison column either way.
  const priorMatrix =
    priorParts && priorParts.combined.period === priorPeriod
      ? filterMonthlyClosingMatrix(priorParts.combined, selection.filter)
      : null;

  const filterNote = describeFilter(selection.filter, review.filterOptions);

  return {
    filterNote,
    fill: buildClosingEngineFill({
      coverage,
      details: details?.rows ?? null,
      filterNote,
      matrix,
      priorMatrix,
      review,
    }),
    line: matrix.line,
    matrix,
    period: matrix.period,
    review,
  };
}
