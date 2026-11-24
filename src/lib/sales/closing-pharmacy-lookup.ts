// Reads a ClosingPharmacyCounts payload against the grid that is ACTUALLY on show — the screen's
// Closing Matrix and the workbook's alike, so the two cannot disagree.
//
// A region row, the national row and every row's all-products total count DISTINCT pharmacies over
// the areas and products of that grid — never a sum of the cells beside them, which would count a
// pharmacy that bought three products three times. So a filtered matrix (one region, two products)
// gets the right numbers from the same payload with no second read.
//
// Client-safe: types and pure helpers only.

import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import type { ClosingPharmacyCounts } from "@/lib/sales/closing-pharmacy-counts";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

/**
 * Row keys match the Office lookup's: `A:<area>`, `R:<region>`, `NAT`.
 *
 * Three states, kept apart on purpose (the Office column's contract):
 *   undefined — this surface does not carry the count; no column at all.
 *   null      — it does, but the count is not known (still loading, not readable): "—", never 0.
 *   number    — the count. 0 here is a real, asserted zero.
 */
export type PharmacyLookup = {
  shown: boolean;
  cellFor: (rowKey: string, productCode: string) => number | null | undefined;
  totalFor: (rowKey: string) => number | null | undefined;
};

const upper = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

export function buildPharmacyLookup(
  counts: ClosingPharmacyCounts | null | undefined,
  matrix: Pick<MonthlyClosingMatrix, "columns" | "regions">,
): PharmacyLookup {
  if (counts === undefined) return { shown: false, cellFor: () => undefined, totalFor: () => undefined };
  if (counts === null) return { shown: true, cellFor: () => null, totalFor: () => null };

  const products = matrix.columns.map((column) => upper(column.productCode));
  const areaIds = (areaCode: string, product: string): readonly number[] =>
    counts.areas[upper(areaCode)]?.[product] ?? [];

  const cells = new Map<string, number>();
  const totals = new Map<string, number>();
  const put = (rowKey: string, areaCodes: readonly string[]) => {
    const all = new Set<number>();
    for (const product of products) {
      const ids = new Set<number>();
      for (const area of areaCodes) for (const id of areaIds(area, product)) ids.add(id);
      cells.set(`${rowKey}|${product}`, ids.size);
      for (const id of ids) all.add(id);
    }
    totals.set(rowKey, all.size);
  };

  // The synthetic "◆ Direct" pseudo-area holds only direct orders, which are not counted: it has no
  // pharmacies to show, so it reads "—" rather than a zero that would look like a finding.
  const realAreas = (areas: MonthlyClosingMatrix["regions"][number]["areas"]) =>
    areas.filter((area) => !isSyntheticDirectArea(area)).map((area) => area.areaCode);
  const synthetic = new Set<string>();
  const national: string[] = [];
  for (const region of matrix.regions) {
    for (const area of region.areas) {
      if (isSyntheticDirectArea(area)) synthetic.add(`A:${area.areaCode}`);
      else put(`A:${area.areaCode}`, [area.areaCode]);
    }
    const codes = realAreas(region.areas);
    put(`R:${region.regionCode}`, codes);
    national.push(...codes);
  }
  put("NAT", national);

  return {
    shown: true,
    cellFor: (rowKey, productCode) => (synthetic.has(rowKey) ? null : cells.get(`${rowKey}|${upper(productCode)}`) ?? 0),
    totalFor: (rowKey) => (synthetic.has(rowKey) ? null : totals.get(rowKey) ?? 0),
  };
}

/** One row of the workbook's "Pharmacies by Brick" sheet. */
export type PharmacyBrickRow = {
  regionName: string;
  areaCode: string;
  areaName: string;
  brickName: string;
  /** One count per column of the grid, in the grid's order. */
  counts: number[];
  /** Distinct pharmacies across those products. */
  total: number;
};

/**
 * Every brick of every area on the grid that had at least one buying pharmacy, in the grid's own
 * region and area order. Bricks are named, never coded; an unmapped brick reads "Brick not mapped".
 */
export function pharmacyBrickRows(
  counts: ClosingPharmacyCounts,
  matrix: Pick<MonthlyClosingMatrix, "columns" | "regions">,
): PharmacyBrickRow[] {
  const products = matrix.columns.map((column) => upper(column.productCode));
  const bricksByArea = new Map<string, ClosingPharmacyCounts["bricks"]>();
  for (const brick of counts.bricks) {
    const list = bricksByArea.get(upper(brick.areaCode)) ?? [];
    list.push(brick);
    bricksByArea.set(upper(brick.areaCode), list);
  }
  const rows: PharmacyBrickRow[] = [];
  for (const region of matrix.regions) {
    for (const area of region.areas) {
      if (isSyntheticDirectArea(area)) continue;
      for (const brick of bricksByArea.get(upper(area.areaCode)) ?? []) {
        const all = new Set<number>();
        const perProduct = products.map((product) => {
          const ids = brick.products[product] ?? [];
          for (const id of ids) all.add(id);
          return ids.length;
        });
        if (all.size === 0) continue;
        rows.push({
          regionName: region.regionName,
          areaCode: area.areaCode,
          areaName: area.areaName,
          brickName: brick.brickName || "Brick not mapped",
          counts: perProduct,
          total: all.size,
        });
      }
    }
  }
  return rows;
}
