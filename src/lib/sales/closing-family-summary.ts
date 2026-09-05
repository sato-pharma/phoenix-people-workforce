import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// Closing summary — the family-grain view that FITS a screen.
//
// WHY THIS EXISTS. The full closing matrix cannot fit and never will: it is areas × products ×
// six metrics, and CNS carries 14 products plus the CNS-only Office column. Measured 2026-09-05,
// with the width model validated against the live page (predicted 1,558px for Anti Infective,
// measured 1,559):
//
//     line             products   table width   container   over by
//     Anti Infective       2        1,558px      1,144px      1.4x
//     Pedia                4       ~2,490px      1,144px      2.2x
//     CNS                 14       ~9,600px      1,144px      8.4x
//
// Fitting CNS would leave 29px per product — less than one figure. So the fits-the-screen rule's
// prescribed remedy (merge columns, never shrink type) does not reach that board, and trimming
// widths would only make the SMALL lines fit while CNS still scrolled: a rule that holds where it
// does not matter and fails where it does.
//
// So the full matrix is left exactly as it is — it is the auditor's detail view, and the owner's
// standing instruction is that anything new ships BESIDE the old closing rather than changing it.
// This is that "beside": one number per area per FAMILY, which fits by construction.
//
// IT IS DERIVED FROM THE MATRIX, NEVER RE-QUERIED. Same rows, same cells, same arithmetic — so it
// cannot become a second source of truth that disagrees with the closing beside it. That failure
// has a name here: one area, one number. The summary's own row total is the matrix's `rowTotal`
// verbatim, not a re-addition, so the two can never drift even by a rounding step.
// ─────────────────────────────────────────────────────────────────────────────

export type ClosingFamilyCell = {
  achievement: number | null;
  family: string;
  targetValue: number | null;
  value: number;
};

export type ClosingSummaryAreaRow = {
  areaCode: string;
  areaName: string;
  byFamily: ClosingFamilyCell[];
  isDirect: boolean;
  /** The matrix's own row total, carried through untouched. */
  total: MonthlyClosingCell;
};

export type ClosingSummaryRegion = {
  areas: ClosingSummaryAreaRow[];
  regionCode: string;
  regionName: string;
  subtotal: { byFamily: ClosingFamilyCell[]; total: MonthlyClosingCell };
};

export type ClosingFamilySummary = {
  /** Distinct families, in the order the matrix's own columns present them. */
  families: string[];
  grandTotal: { byFamily: ClosingFamilyCell[]; total: MonthlyClosingCell };
  regions: ClosingSummaryRegion[];
};

/**
 * Achievement on the SUMMED slice, recomputed — never an average of the products' percentages.
 *
 * Averaging percentages is wrong whenever the products differ in size, which they always do: a
 * product at 200% of a tiny target would drag a family above 100% while its money says otherwise.
 * Null target (or zero) yields null, never 0% and never Infinity — an area with no target for a
 * family must read as a dash, exactly as it does on the matrix.
 */
function achievementOf(value: number, target: number | null): number | null {
  if (target === null || !Number.isFinite(target) || target === 0) return null;
  return (value / target) * 100;
}

function foldCells(
  cells: readonly MonthlyClosingCell[],
  familyOf: readonly string[],
  families: readonly string[],
): ClosingFamilyCell[] {
  const valueByFamily = new Map<string, number>();
  const targetByFamily = new Map<string, number | null>();

  cells.forEach((cell, index) => {
    const family = familyOf[index];
    if (family === undefined) return;
    valueByFamily.set(family, (valueByFamily.get(family) ?? 0) + (cell.salesValue ?? 0));

    // A family's target is the sum of the targets that EXIST. If no product in the family carries
    // one, the family has none — summing nulls as zeros would invent a 0 target and turn "no
    // target set" into an infinite achievement.
    if (cell.targetValue !== null && Number.isFinite(cell.targetValue)) {
      targetByFamily.set(family, (targetByFamily.get(family) ?? 0) + cell.targetValue);
    } else if (!targetByFamily.has(family)) {
      targetByFamily.set(family, null);
    }
  });

  return families.map((family) => {
    const value = valueByFamily.get(family) ?? 0;
    const targetValue = targetByFamily.get(family) ?? null;
    return { achievement: achievementOf(value, targetValue), family, targetValue, value };
  });
}

function summariseRow(
  row: Pick<MonthlyClosingAreaRow, "cells" | "rowTotal">,
  familyOf: readonly string[],
  families: readonly string[],
) {
  return { byFamily: foldCells(row.cells, familyOf, families), total: row.rowTotal };
}

/**
 * Fold a closing matrix to one cell per area × family.
 *
 * Families come from the matrix's own `columns`, in their existing order, so the summary reads
 * left-to-right the same way the full matrix does. A column with no family label falls back to its
 * product code rather than being dropped — losing a column here would understate an area's total
 * against the matrix beside it, which is precisely the disagreement this view must never create.
 */
export function buildClosingFamilySummary(matrix: MonthlyClosingMatrix): ClosingFamilySummary {
  const familyOf = matrix.columns.map(
    (column) => String(column.family ?? "").trim() || String(column.productCode ?? "").trim() || "—",
  );
  const families: string[] = [];
  for (const family of familyOf) if (!families.includes(family)) families.push(family);

  const regions: ClosingSummaryRegion[] = matrix.regions.map((region) => ({
    areas: region.areas.map((area) => ({
      areaCode: area.areaCode,
      areaName: area.areaName,
      byFamily: foldCells(area.cells, familyOf, families),
      isDirect: area.isDirect === true,
      total: area.rowTotal,
    })),
    regionCode: region.regionCode,
    regionName: region.regionName,
    subtotal: summariseRow(region.subtotal, familyOf, families),
  }));

  return {
    families,
    grandTotal: summariseRow(matrix.grandTotal, familyOf, families),
    regions,
  };
}
