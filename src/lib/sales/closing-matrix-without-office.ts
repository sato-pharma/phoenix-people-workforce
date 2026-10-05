// The Closing Matrix with the Office channel taken out of it — CNS only.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY IT EXISTS. Owner, 2026-10-05: "Only in CNS ... you will add another tab, which will follow the
// closing matrix. Will be exactly as the closing matrix, but without the office, which is
// Marcyrl." MARCYRL *IS* THE OFFICE CHANNEL and not a distributor beside it: the company's own
// stock reaches the closing through `OFFICE_DISTRIBUTOR_CODE`, which `office-upload.ts` names
// "Marcyrl" (he confirmed it himself, 2026-10-05). So taking the Office channel out IS taking
// Marcyrl out, and a future session must not go hunting for a second distributor by that name.
// The sheets keep saying "Office", which is the word on the Closing Matrix beside them. Office is the
// company's own stock, imported last and spread over the areas by the value-share golden rule
// (`office-allocation.ts`) — on CNS July 2026 that was 42,838 of 105,152 units, 41% of the closing.
// Every area therefore carries money it did not sell to anybody, and there was no surface anywhere
// that showed the line as its distributors actually sold it. This is that surface.
//
// THE CLOSING MATRIX IS NOT TOUCHED. It stays exactly as it is, Office included, and this is a
// SECOND grid beside it — the same rule as the premium export sitting beside the old one
// (AGENTS.md, "every new closing feature ships BESIDE it"). Nothing here feeds a headline, a
// subtotal, a publication or an achievement: it is a lens, like the "of wh. Office" column it is
// the complement of.
//
// ⚠ TARGETS ARE NOT REDUCED, AND THAT IS THE POINT. The target is what the area was given for the
// month, Office or no Office, so the achievement on this grid is the real money over the real
// target — which is lower than the closing's, by exactly the Office share. A grid that scaled the
// target down with the sales would print the same percentage as the closing and answer nothing.
//
// ⚠ ONLY SUBTRACT AN OFFICE GRID NARROWED THE SAME WAY AS THE MATRIX. `loadMonthlyClosingParts`
// builds the Office slice from an aggregate that carries no customer and no distributor, so a
// ROW-LEVEL filter (distributor, Included/Excluded, free-text search) cannot narrow it — the normal
// export deliberately passes the WHOLE month's Office grid under such a filter and says so on the
// sheet. Subtracting that from a row-level-filtered matrix would take out money the matrix never
// had and print negative sales. Both callers gate on it; see `officeNarrowedWithMatrix`.

import {
  addClosingSales,
  emptyClosingCell,
  roundedClosingCell,
  sumClosingRowTotal,
} from "./monthly-closing-matrix-cells";
import type {
  MonthlyClosingCell,
  MonthlyClosingGrandTotalRow,
  MonthlyClosingMatrix,
  MonthlyClosingRegionGroup,
} from "./monthly-distributor-import";

/** The tab's name, in both workbooks, and the key its colour and band width are looked up by. */
export const CLOSING_MATRIX_NO_OFFICE_SHEET = "Closing Matrix (No Office)";

/** The contents-page heading the premium tab is listed under — the matrices' own section. */
export const CLOSING_MATRIX_NO_OFFICE_BAND = "By area";

/**
 * What the tab says about itself, on both the normal and the premium workbook.
 *
 * One sentence, stated on the sheet rather than left to the tab name, because a forwarded grid of
 * numbers that is 41% smaller than the one beside it reads as a mistake until it says why.
 */
export const CLOSING_MATRIX_NO_OFFICE_NOTE =
  "Distributor sell-out only — the Office channel's allocated units and value are taken out of every"
  + " cell, subtotal and total. Targets are NOT reduced with them, so the achievement here is the"
  + " real money over the whole target and is lower than the Closing Matrix beside it by exactly the"
  + " Office share. The Closing Matrix is the published closing; this grid is a lens on it.";

function codeKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** `${area} ${product}`, the same tuple key the matrix fold and the Office fold both use. */
function cellKey(areaCode: string, productCode: string): string {
  return `${codeKey(areaCode)} ${codeKey(productCode)}`;
}

/**
 * The Office units and value of every (area, product), read off the Office grid's AREA rows only.
 *
 * Keyed by PRODUCT CODE rather than by column position: the Office grid is built by running the
 * matrix builder over the Office-only cells, so a month whose Office file carries fewer products
 * than the line has columns comes back with a shorter column list. Reading it positionally would
 * then subtract one product's Office units from another product's sales.
 *
 * Subtotals and grand totals are ignored on purpose — they are re-derived below from the area rows
 * that survive, exactly as `filterMonthlyClosingMatrix` does, so a subtotal can never disagree with
 * the rows above it.
 */
function officeByCell(office: MonthlyClosingMatrix): Map<string, { salesUnits: number; salesValue: number }> {
  const codes = office.columns.map((column) => column.productCode);
  const byCell = new Map<string, { salesUnits: number; salesValue: number }>();
  for (const region of office.regions) {
    for (const area of region.areas) {
      area.cells.forEach((cell, index) => {
        const productCode = codes[index];
        if (!productCode) return;
        const key = cellKey(area.areaCode, productCode);
        const entry = byCell.get(key) ?? { salesUnits: 0, salesValue: 0 };
        entry.salesUnits += cell.salesUnits;
        entry.salesValue += cell.salesValue;
        byCell.set(key, entry);
      });
    }
  }
  return byCell;
}

/**
 * The same matrix with the Office slice removed from every cell.
 *
 * Returns the matrix UNCHANGED when there is no Office grid to take out, so a caller on a line
 * without an Office channel still gets a valid matrix rather than a special case.
 *
 * Shape and row set are the input's: every region, every area and the synthetic Direct pseudo-area
 * keep their row even at zero, so this grid can be read line by line against the Closing Matrix
 * beside it. Direct is untouched — direct orders never arrive through the Office channel, so there
 * is nothing in them to remove.
 */
export function matrixWithoutOffice(
  matrix: MonthlyClosingMatrix,
  office: MonthlyClosingMatrix | null | undefined,
): MonthlyClosingMatrix {
  if (!office) return matrix;
  const byCell = officeByCell(office);

  const without = (areaCode: string, productCode: string, cell: MonthlyClosingCell): MonthlyClosingCell => {
    const taken = byCell.get(cellKey(areaCode, productCode));
    // Targets carry through untouched; `roundedClosingCell` re-derives the achievement from the
    // reduced sales over that kept target, and leaves it null where there is no target at all.
    return roundedClosingCell({
      achievement: null,
      salesUnits: cell.salesUnits - (taken?.salesUnits ?? 0),
      salesValue: cell.salesValue - (taken?.salesValue ?? 0),
      targetUnits: cell.targetUnits,
      targetValue: cell.targetValue,
    });
  };

  const regions: MonthlyClosingRegionGroup[] = matrix.regions.map((region) => {
    const areas = region.areas.map((area) => {
      const cells = area.cells.map((cell, index) =>
        without(area.areaCode, matrix.columns[index]?.productCode ?? "", cell));
      return { ...area, cells, rowTotal: sumClosingRowTotal(cells) };
    });
    const subtotalCells = matrix.columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]!));
      return roundedClosingCell(cell);
    });
    return {
      areas,
      regionCode: region.regionCode,
      regionName: region.regionName,
      subtotal: {
        ...region.subtotal,
        cells: subtotalCells,
        rowTotal: sumClosingRowTotal(subtotalCells),
      },
    };
  });

  const grandCells = matrix.columns.map((_column, columnIndex) => {
    const cell = emptyClosingCell();
    regions.forEach((region) => region.areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]!)));
    return roundedClosingCell(cell);
  });
  const grandTotal: MonthlyClosingGrandTotalRow = {
    ...matrix.grandTotal,
    cells: grandCells,
    rowTotal: sumClosingRowTotal(grandCells),
  };

  // Direct – National is Office-free by construction, so it carries through as it is; the company
  // total is then re-derived as grand total + Direct National, which is how both the builder and
  // the client-side filter derive it. Deriving it any other way is how the bottom line of a grid
  // stops agreeing with the rows above it.
  const directNational = matrix.directNational ?? null;
  const companyTotal: MonthlyClosingGrandTotalRow | null = matrix.companyTotal
    ? (() => {
      const companyCells = matrix.columns.map((_column, columnIndex) => {
        const cell = emptyClosingCell();
        addClosingSales(cell, grandCells[columnIndex]!);
        // A company total with no Direct row beside it is the grand total — never the one the
        // closing computed, which still holds the Office money this grid has just removed.
        if (directNational) addClosingSales(cell, directNational.cells[columnIndex]!);
        return roundedClosingCell(cell);
      });
      return { ...matrix.companyTotal, cells: companyCells, rowTotal: sumClosingRowTotal(companyCells) };
    })()
    : null;

  return { ...matrix, companyTotal, directNational, grandTotal, regions };
}
