// The CONSOLIDATED closing workbook — several months of one line added together, written as the
// closing's own workbook. Super Admin and the CEO only (owner, 2026-09-14).
//
// 🔒 THE MONTHLY CLOSING EXPORT IS FROZEN, so this ships BESIDE it and replaces nothing. It re-runs
// that route's own per-month pipeline — the same loaders, the same place filter, the same shared store
// split, the same matrix write-back — once for every month picked, and only then adds the months
// together and writes the existing workbook ONCE. The one change inside the builder is the
// off-by-default `consolidatedMonths` switch, which makes its two Store Split sheets split each month
// on its own and add the answers (owner: "split each month, then add").
//
// Why not load the months pooled: the store split judges every warehouse band on ONE month's total, so
// pooled rows would re-judge them on the combined total and move money the closing never moved. See
// closing-store-split-months.ts.
//
// What is left out, and why — each describes a single month and would read as the span's:
//   - Source Coverage (which files arrived is a fact about one month);
//   - Channel Comparison (its tie-back row compares the LATEST month with this workbook's headline);
//   - Channel Breakdown (read per month by an RPC, not from these rows);
//   - July 2026 Direct Orders (one month's hand-mapped list).
// The workbook's own note names them, so their absence is stated rather than noticed.

import type { AccessContext } from "@/lib/auth/permissions";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import {
  ConsolidatedClosingSelectionError,
  MIN_CONSOLIDATED_MONTHS,
  consolidatedFilePeriod,
  consolidatedFilterParts,
  describeConsolidatedClosing,
  relabelConsolidatedWorkbook,
} from "@/lib/sales/closing-consolidated";
import { resolveClosingFileName } from "@/lib/sales/closing-export-file-name";
import type { ClosingExportFilter } from "@/lib/sales/closing-export-payload";
import { loadSplitRegions } from "@/lib/sales/closing-organogram-regions";
import { maskedClosingClientCodes, withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { prepareClosingStoreSplit } from "@/lib/sales/closing-store-split-export";
import { loadClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import { loadMonthlyClosingComparisonFromRows } from "@/lib/sales/monthly-closing-comparison";
import { type ClosingDetailsResult, loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import { buildMonthlyClosingWorkbook, fileDirectCellsUnderMatrixRegions } from "@/lib/sales/monthly-closing-export";
import { mergeMonthlyClosingMatrices } from "@/lib/sales/monthly-closing-period-merge";
import {
  filterMonthlyClosingMatrix,
  loadMonthlyClosingParts,
  type MonthlyClosingDirectCell,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { isStoreCitySplitActive, type SplitRegions } from "@/lib/sales/store-sales-city-split";
import { applyStoreSplitToMatrix } from "@/lib/sales/store-split-matrix";

/** A narrowing filter that matched no area must yield no rows; an empty list would mean "no filter". */
const NO_MATCHING_AREA = "__NO_MATCHING_AREA__";

/** Months are read three at a time: each one's unpaged detail read is the heavy part of the export. */
const MONTH_CONCURRENCY = 3;

export const CONSOLIDATED_LEFT_OUT_SHEETS = [
  "Source Coverage",
  "Channel Comparison",
  "Channel Breakdown",
  "July 2026 Direct Orders",
] as const;

type StoreSplitApplied = ReturnType<typeof applyStoreSplitToMatrix>["applied"];
type DetailsTotals = ClosingDetailsResult["totals"];

/** One month, worked out exactly as the single-month export works it out. */
type ConsolidatedMonth = {
  applied: StoreSplitApplied;
  /** The month narrowed to the areas on show — what the Data and Total sheets list. */
  details: ClosingDetailsResult;
  directCells: MonthlyClosingDirectCell[];
  /** Filtered, with this month's own store split written back. */
  matrix: MonthlyClosingMatrix;
  /** The whole month, place filter NOT applied — what the store split has to see. */
  monthRows: ClosingDetailsResult;
  office: MonthlyClosingMatrix | null;
  period: string;
  regions: SplitRegions;
  retail: MonthlyClosingMatrix;
  scopedAreaCodes: string[];
  /** Where this month's split landed, cell by cell — applyStoreSplitToMatrix's `cells`. */
  storeSplitCells: ReadonlyMap<string, { qty: number; value: number }>;
};

function sameLine(left: string | null | undefined, right: string | null | undefined): boolean {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

async function loadConsolidatedMonth(
  access: AccessContext,
  filter: ClosingExportFilter,
  line: string,
  period: string,
): Promise<ConsolidatedMonth | null> {
  const parts = await loadMonthlyClosingParts({ line, period });
  // Both guards. The loader falls back to another month AND to another line when it does not
  // recognise the one asked for, and either would fold a wrong closing into the sum under this
  // heading. A month with no closing is reported as skipped instead.
  if (parts.combined.period !== period || !sameLine(parts.combined.line, line)) return null;

  // The same pure filter the screen and the single-month export use, on all three grids.
  const matrix = filterMonthlyClosingMatrix(parts.combined, filter);
  const retail = filterMonthlyClosingMatrix(parts.retail, filter);
  const office = parts.office ? filterMonthlyClosingMatrix(parts.office, filter) : null;

  const placeNarrowed = filter.regionCodes.length > 0 || filter.areaCodes.length > 0 || filter.search.trim().length > 0;
  const keptAreaCodes = matrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode));
  const scopedAreaCodes = placeNarrowed ? (keptAreaCodes.length > 0 ? keptAreaCodes : [NO_MATCHING_AREA]) : [];

  const [monthRows, sharedSplit, regions] = await Promise.all([
    // Place narrowing happens AFTER this read, as in the single-month export: the split allocates a
    // wholesaler's sell-in over its whole city, whether or not every area of it is on show.
    loadMonthlyClosingDetails({
      access,
      availableLines: matrix.availableLines,
      availablePeriods: matrix.availablePeriods,
      filters: { areaCodes: [], distributorCodes: [], inclusion: "", productCodes: filter.productCodes, regionCodes: [], search: "" },
      includeConfidential: false,
      line: matrix.line,
      period: matrix.period,
      unpaged: true,
      // 🔒 The split and the store-split folds key on the real distributor, so this read reveals and
      // the mask is applied on the way into the workbook below. See closing-source-mask.ts.
      revealSource: true,
    }),
    // The SCREEN'S OWN split for this month, so each month in the sum is the month the screen shows.
    loadClosingStoreSplit(matrix.line, matrix.period).catch(() => null),
    loadSplitRegions(matrix.line, matrix.period),
  ]);

  const { details, net, officeNet } = prepareClosingStoreSplit(monthRows, scopedAreaCodes, sharedSplit);
  const { applied, cells: storeSplitCells, matrix: splitMatrix } = applyStoreSplitToMatrix(matrix, net);
  // 🔴 The Office grid takes the Office respread's own net and NOTHING else of `net` (owner,
  // 2026-10-09 — CNS, from the September closing): this workbook subtracts the Office grid from the
  // matrix on its own no-Office tab, so the two have to agree about which area holds an Office unit,
  // and the city split and the bulk rule must not reach this grid because neither moves an Office
  // row. See closing-office-respread.ts. Empty on every line but CNS and every month before 2026-09,
  // so a consolidated range that predates the rule keeps exactly the grids it had.
  const officeWithRespread = office && officeNet.size > 0
    ? applyStoreSplitToMatrix(office, officeNet).matrix
    : office;
  return {
    applied,
    details,
    // Under the region this month's WHOLE matrix files each order's area in, as the single-month
    // export does, so a direct order on an area the organogram re-owns reaches both channel tabs.
    directCells: fileDirectCellsUnderMatrixRegions(parts.directCells, parts.combined),
    matrix: splitMatrix,
    monthRows,
    office: officeWithRespread,
    period,
    regions,
    // The retail half gets the SAME write-back, which keeps "Retail + Direct = master" true.
    retail: applyStoreSplitToMatrix(retail, net).matrix,
    scopedAreaCodes,
    storeSplitCells,
  };
}

function addTotals(left: DetailsTotals, right: DetailsTotals): DetailsTotals {
  return {
    ...left,
    effectiveUnits: left.effectiveUnits + right.effectiveUnits,
    rows: left.rows + right.rows,
    salesValue: left.salesValue + right.salesValue,
    units: left.units + right.units,
  };
}

function unionByCode<T extends { code: string }>(lists: readonly (readonly T[])[]): T[] {
  const byCode = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) {
      const key = item.code.trim().toUpperCase();
      if (!byCode.has(key)) byCode.set(key, item);
    }
  }
  return [...byCode.values()];
}

/**
 * Several months' detail results as one. The rows are concatenated, and every total and
 * reconciliation line is SUMMED here — nothing downstream re-derives them from the rows, so a merged
 * object carrying only the latest month's totals would put one month's figures beside a span's rows.
 * Options are the union, latest month's names first.
 */
export function mergeClosingDetails(months: readonly ClosingDetailsResult[]): ClosingDetailsResult {
  if (months.length === 0) throw new Error("Cannot merge an empty list of closing details.");
  const latest = months[months.length - 1];
  const newestFirst = [...months].reverse();
  const reconciliation = { ...latest.reconciliation };
  for (const key of Object.keys(reconciliation) as (keyof ClosingDetailsResult["reconciliation"])[]) {
    reconciliation[key] = months.slice(1).reduce((sum, month) => addTotals(sum, month.reconciliation[key]), months[0].reconciliation[key]);
  }
  return {
    ...latest,
    filteredRowCount: months.reduce((sum, month) => sum + month.filteredRowCount, 0),
    options: {
      areas: unionByCode(newestFirst.map((month) => month.options.areas)),
      distributors: Array.from(new Set(newestFirst.flatMap((month) => month.options.distributors))),
      products: unionByCode(newestFirst.map((month) => month.options.products)),
      regions: unionByCode(newestFirst.map((month) => month.options.regions)),
    },
    outOfScope: months.every((month) => month.outOfScope),
    reconciliation,
    rows: months.flatMap((month) => month.rows),
    totals: months.slice(1).reduce((sum, month) => addTotals(sum, month.totals), months[0].totals),
  };
}

/** The areas the workbook covers across the span — the union of what each month's matrix kept. */
function unionScopedAreaCodes(perMonth: readonly (readonly string[])[]): string[] {
  if (perMonth.every((codes) => codes.length === 0)) return [];
  const kept = Array.from(new Set(perMonth.flat().filter((code) => code !== NO_MATCHING_AREA)));
  return kept.length > 0 ? kept : [NO_MATCHING_AREA];
}

export type ConsolidatedClosingWorkbook = {
  buffer: Buffer;
  fileName: string;
  /** The months actually in the sum. */
  periods: string[];
  /** Picked, but the closing has no data for them. */
  skipped: string[];
};

export async function buildConsolidatedClosingWorkbook(input: {
  access: AccessContext;
  filter: ClosingExportFilter;
  line: string;
  periods: readonly string[];
}): Promise<ConsolidatedClosingWorkbook> {
  const requested = Array.from(new Set(input.periods)).sort();
  const loaded = await mapWithConcurrency(requested, MONTH_CONCURRENCY, (period) =>
    loadConsolidatedMonth(input.access, input.filter, input.line, period));
  const months = loaded.filter((month): month is ConsolidatedMonth => month !== null);
  const skipped = requested.filter((_, index) => loaded[index] === null);
  if (months.length < MIN_CONSOLIDATED_MONTHS) {
    throw new ConsolidatedClosingSelectionError(
      `Only ${months.length} of the ${requested.length} months picked have a closing for ${input.line}.`
      + " A consolidated closing needs at least two.",
    );
  }

  const periods = months.map((month) => month.period);
  const latest = months[months.length - 1];
  const matrix = mergeMonthlyClosingMatrices(months.map((month) => month.matrix));
  const retail = mergeMonthlyClosingMatrices(months.map((month) => month.retail));
  // An Office grid missing for any month would undercount the span, so the column is omitted instead —
  // the same "not available" the single-month workbook gives when it cannot read Office.
  const office = months.every((month) => month.office)
    ? mergeMonthlyClosingMatrices(months.map((month) => month.office as MonthlyClosingMatrix))
    : null;
  const details = mergeClosingDetails(months.map((month) => month.details));
  const allMonthRows = months.flatMap((month) => month.monthRows.rows);
  const scopedAreaCodes = unionScopedAreaCodes(months.map((month) => month.scopedAreaCodes));
  const storeSplitApplied = months.reduce(
    (sum, month) => ({ ...sum, qty: sum.qty + month.applied.qty, value: sum.value + month.applied.value }),
    { qty: 0, value: 0 } as StoreSplitApplied,
  );
  // The same sum cell by cell, for the Total sheet: each month split on its own, then added, as the
  // Store Split sheets are. Keys are area and product, so one area's months land on one row.
  const storeSplitCells = new Map<string, { qty: number; value: number }>();
  for (const month of months) {
    for (const [key, landed] of month.storeSplitCells) {
      const soFar = storeSplitCells.get(key) ?? { qty: 0, value: 0 };
      storeSplitCells.set(key, { qty: soFar.qty + landed.qty, value: soFar.value + landed.value });
    }
  }

  // From rows, over the whole span: the aggregate comparison RPC reads one month at a time.
  // `input.access`: the rows carry the real source, and the comparison masks El Qema for this reader.
  // `organogram`: each row counts under the region ITS month's matrix shows, as the merged matrix
  // does (owner, 2026-09-16).
  const comparison = await loadMonthlyClosingComparisonFromRows(matrix.line, matrix.period, details.rows, {
    areaCodes: scopedAreaCodes,
  }, input.access, { regionBasis: "organogram" });

  const filterParts = consolidatedFilterParts(input.filter, details.options);
  const anySplitApplied = months.some((month) => isStoreCitySplitActive(month.period));
  const filterNote = describeConsolidatedClosing({
    filterParts,
    leftOutSheets: CONSOLIDATED_LEFT_OUT_SHEETS,
    line: matrix.line ?? input.line,
    periods,
    skipped,
    storeSplitOmitted: anySplitApplied ? periods.filter((period) => !isStoreCitySplitActive(period)) : [],
  });

  // 🔒 Everything that computes from the real rows is finished by here — every month's split, the
  // comparison, the merges. The workbook only writes them out, so this is where the source mask
  // belongs. See closing-source-mask.ts.
  const shownDetails = { ...details, rows: [...withoutMaskedSourceRows(details.rows, input.access)] };
  const built = await buildMonthlyClosingWorkbook(matrix, comparison, shownDetails, {
    channels: { directCells: months.flatMap((month) => month.directCells), retail },
    consolidatedMonths: {
      filtered: filterParts.length > 0,
      months: months.map((month) => ({ period: month.period, regions: month.regions, rows: month.monthRows.rows })),
    },
    filterNote,
    includeTargetSheet: true,
    office,
    // The Office-free twin, right after the Closing Matrix (owner, 2026-10-05 — "add the no-office
    // tab to the consolidated closing export too"). Unconditionally true here, and that is a
    // property of the type rather than a judgement: `ClosingExportFilter` carries areas, regions,
    // products and an area search and NOTHING row-level, so this path cannot produce the one case
    // the flag exists to refuse — a matrix narrowed by a filter the Office aggregate cannot see.
    // `office` above is merged from the per-month grids each filtered with the same filter, and is
    // null unless EVERY month had one, so a short span omits the tab rather than under-subtracting.
    officeNarrowedWithMatrix: true,
    storeSplitApplied,
    storeSplitCells,
    // Masked by code from EVERY month's whole rows, because a split entry carries no distributor to
    // recognise and an El Qema store can appear in any month of the span.
    storeSplitMaskedClients: maskedClosingClientCodes(allMonthRows, input.access),
    storeSplitRows: allMonthRows,
    storeSplitScopeAreaCodes: scopedAreaCodes,
  });
  const buffer = await relabelConsolidatedWorkbook(built, {
    latestPeriod: matrix.period ?? latest.period,
    periods,
  });

  return {
    buffer,
    fileName: await resolveClosingFileName({
      kind: "consolidated",
      line: matrix.line ?? input.line,
      period: consolidatedFilePeriod(periods),
      regionNames: (matrix.regions.map((region) => region.regionName)),
    }),
    periods,
    skipped,
  };
}
