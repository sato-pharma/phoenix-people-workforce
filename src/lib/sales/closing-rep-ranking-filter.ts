import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// THE SCREEN'S FILTER, CARRIED INTO THE REP RANKING WORKBOOK.
//
// 🔴 THE OWNER'S DECISION, 2026-10-13: "I filtered from my admin account and exported — it's
// supposed to follow my filter. No, it did not follow my filter. All the shit is exported." He was
// shown the objection below and chose "every filter narrows everything" anyway, so this module is
// how that is done WITHOUT the workbook disagreeing with the Monthly Closing.
//
// THE OBJECTION, AND WHY THIS ANSWER SURVIVES IT. The route used to drop the filter on purpose: the
// ranking is built from the published MATRICES, while the channel split is carved from the DETAIL
// ROWS, so narrowing only the rows shrinks Stores and Office underneath a ranking that did not
// move — a file that disagrees with itself, with nothing on it saying which half was filtered. The
// answer is to narrow BOTH, and to narrow the matrix the only way that keeps every figure a
// published one: by DROPPING whole cells, never by re-deriving a number.
//
//   · a region or area filter DROPS AREA ROWS — each surviving seat keeps its own published figure
//   · a product filter DROPS COLUMNS, and a row total becomes the SUM OF ITS SURVIVING CELLS, which
//     is what the closing itself publishes for those products
//   · the free-text search has no matrix grain at all, so it narrows which SEATS appear (the areas
//     its rows touched) and leaves each of those seats' figures whole
//
// So a filtered workbook is the closing, cell for cell, over a smaller rectangle. Nothing is
// averaged, re-priced or apportioned — the Monthly Closing stays the one source of truth
// (AGENTS.md §4), and the Trust sheet prints the rectangle in words so no reader can mistake a
// filtered total for the line.
// ─────────────────────────────────────────────────────────────────────────────

/** The filter the closing screen sends with every export — see `runExport` in the workspace. */
export type RepRankingFilters = {
  areaCodes?: readonly string[] | null;
  productCodes?: readonly string[] | null;
  regionCodes?: readonly string[] | null;
  search?: string | null;
};

const list = (values: readonly string[] | null | undefined): Set<string> =>
  new Set((values ?? []).map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean));

const text = (value: string | null | undefined): string => String(value ?? "").trim();

/** True when nothing is selected — the portal path, and an admin who filtered nothing. */
export function rankingFiltersAreEmpty(filters: RepRankingFilters | null | undefined): boolean {
  if (!filters) return true;
  return list(filters.areaCodes).size === 0
    && list(filters.regionCodes).size === 0
    && list(filters.productCodes).size === 0
    && text(filters.search).length === 0;
}

const EMPTY_CELL: MonthlyClosingCell = {
  achievement: null,
  salesUnits: 0,
  salesValue: 0,
  targetUnits: null,
  targetValue: null,
};

/**
 * Add cells the way the closing adds them: a null target stays null until SOME cell has one, and
 * achievement is re-derived from the two sums rather than averaged out of the parts.
 *
 * 🔴 `null` IS NOT `0` HERE EITHER. A product nobody targeted must leave the seat's target null, so
 * the seat is listed UNRANKED rather than scored 0% — the same absence-is-not-zero rule the whole
 * workbook is built on. Summing with `?? 0` would hand every filtered seat a 0 target and an
 * infinite achievement.
 */
function addCells(cells: readonly MonthlyClosingCell[]): MonthlyClosingCell {
  if (cells.length === 0) return { ...EMPTY_CELL };
  let salesValue = 0;
  let salesUnits = 0;
  let targetValue: number | null = null;
  let targetUnits: number | null = null;
  for (const cell of cells) {
    salesValue += Number(cell.salesValue ?? 0);
    salesUnits += Number(cell.salesUnits ?? 0);
    if (cell.targetValue != null) targetValue = (targetValue ?? 0) + Number(cell.targetValue);
    if (cell.targetUnits != null) targetUnits = (targetUnits ?? 0) + Number(cell.targetUnits);
  }
  return {
    achievement: targetValue != null && targetValue !== 0 ? salesValue / targetValue : null,
    salesUnits,
    salesValue,
    targetUnits,
    targetValue,
  };
}

function narrowAreaRow(area: MonthlyClosingAreaRow, keep: readonly number[]): MonthlyClosingAreaRow {
  const cells = keep.map((index) => area.cells[index] ?? { ...EMPTY_CELL });
  return { ...area, cells, rowTotal: addCells(cells) };
}

/**
 * The same matrix over a smaller rectangle — fewer area rows, fewer product columns, every figure
 * still a published cell.
 *
 * `keepAreas`, when given, is the extra narrowing the free-text search produces: the areas whose
 * DETAIL ROWS matched it, resolved by the caller because only the rows carry a customer, a brick or
 * a client code. An EMPTY set means the search matched nothing, and the matrix comes back with no
 * regions — which the builder already treats as "no file", never as a month of zeroes.
 */
export function narrowClosingMatrixForRanking(
  matrix: MonthlyClosingMatrix,
  filters: RepRankingFilters | null | undefined,
  keepAreas?: ReadonlySet<string> | null,
): MonthlyClosingMatrix {
  if (rankingFiltersAreEmpty(filters) && !keepAreas) return matrix;

  const areaCodes = list(filters?.areaCodes);
  const regionCodes = list(filters?.regionCodes);
  const productCodes = list(filters?.productCodes);

  const keepColumns = matrix.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => productCodes.size === 0
      || productCodes.has(String(column.productCode ?? "").trim().toUpperCase()));
  const keepIndexes = keepColumns.map(({ index }) => index);

  const regions = matrix.regions
    .map((group) => {
      const areas = group.areas
        .filter((area) => {
          const code = String(area.areaCode ?? "").trim().toUpperCase();
          const region = String(group.regionCode ?? "").trim().toUpperCase();
          // 🔴 THE REGION THE MATRIX SHOWS THE AREA UNDER, AND NO OTHER. An area the organogram
          // moved keeps its geographical region in `sourceRegionCode`, and an earlier version of
          // this filter answered to that too - so on Anti Infective, choosing Delta (1) also
          // returned Qalubeya, which the closing shows under Delta (3), and the owner got two
          // regions in one file (2026-10-13: "I filtered on Delta 1 and the export came out with
          // Delta 1 and Delta 3 together"). The screen's own filter, `filterMonthlyClosingMatrix`,
          // matches the displayed group only, and so do the detail rows (`rowMatchesRegionFilter`
          // reads the organogram region). A file that follows the filter must follow THAT filter.
          if (areaCodes.size > 0 && !areaCodes.has(code)) return false;
          if (regionCodes.size > 0 && !regionCodes.has(region)) return false;
          if (keepAreas && !keepAreas.has(code)) return false;
          return true;
        })
        .map((area) => narrowAreaRow(area, keepIndexes));
      if (areas.length === 0) return null;
      const subtotalCells = keepIndexes.map((_, position) => addCells(areas.map((area) => area.cells[position]!)));
      return {
        ...group,
        areas,
        subtotal: {
          ...group.subtotal,
          cells: subtotalCells,
          rowTotal: addCells(areas.map((area) => area.rowTotal)),
        },
      };
    })
    .filter((group): group is NonNullable<typeof group> => group !== null);

  const allAreas = regions.flatMap((group) => group.areas);
  const grandCells = keepIndexes.map((_, position) => addCells(allAreas.map((area) => area.cells[position]!)));

  return {
    ...matrix,
    columns: keepColumns.map(({ column }) => column),
    // The national direct buckets are whole-line rows with no area of their own, so a filtered
    // rectangle cannot honestly carry them: a reader would see the line's direct money sitting
    // beside one region's sales. Dropped rather than narrowed.
    companyTotal: null,
    directNational: null,
    grandTotal: {
      ...matrix.grandTotal,
      cells: grandCells,
      rowTotal: addCells(allAreas.map((area) => area.rowTotal)),
    },
    regions,
  };
}

/** The areas the free-text search reached, by the rows it matched. Null when no search is active. */
export function searchedAreaCodes(
  filters: RepRankingFilters | null | undefined,
  rows: ReadonlyArray<{ areaCode?: string | null }>,
): Set<string> | null {
  if (text(filters?.search).length === 0) return null;
  const codes = new Set<string>();
  for (const row of rows) {
    const code = String(row.areaCode ?? "").trim().toUpperCase();
    if (code) codes.add(code);
  }
  return codes;
}

/**
 * What the file covers, in the reader's words, for the cover and the Trust sheet.
 *
 * 🔴 A FILTERED WORKBOOK THAT DOES NOT SAY SO IS THE REAL DANGER. Its line total is smaller than
 * the line, and it is forwarded as "the ranking" — so every sheet of a narrowed file carries this
 * sentence, and an unfiltered one carries nothing extra at all.
 */
export function describeRankingFilters(
  filters: RepRankingFilters | null | undefined,
  names: {
    areaNames?: ReadonlyMap<string, string>;
    productNames?: ReadonlyMap<string, string>;
    regionNames?: ReadonlyMap<string, string>;
  } = {},
): string[] {
  if (rankingFiltersAreEmpty(filters)) return [];
  const out: string[] = [];
  const label = (code: string, lookup?: ReadonlyMap<string, string>): string =>
    lookup?.get(code.trim().toUpperCase()) ?? code;
  const regions = [...list(filters?.regionCodes)];
  const areas = [...list(filters?.areaCodes)];
  const products = [...list(filters?.productCodes)];
  if (regions.length > 0) out.push(`Regions: ${regions.map((code) => label(code, names.regionNames)).join(", ")}`);
  if (areas.length > 0) out.push(`Areas: ${areas.map((code) => label(code, names.areaNames)).join(", ")}`);
  if (products.length > 0) out.push(`Products: ${products.map((code) => label(code, names.productNames)).join(", ")}`);
  const search = text(filters?.search);
  if (search.length > 0) out.push(`Search: "${search}"`);
  return out;
}
