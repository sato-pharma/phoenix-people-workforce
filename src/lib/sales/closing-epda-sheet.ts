// The EPDA tab — each area's share of EPDA's units, per product, in all three closing downloads.
//
// Owner, 2026-11-04, with rule 2 (bulk-allocation-channel.ts, EPDA_CONTRIBUTION_START_PERIOD): "in
// exported xlsx sheet you will add a separate column that shows epda sales units", then "a column per
// product share for epda after the spread", in all three downloads.
//
// 🔴 THE FIGURES ARE WHAT THE SPREAD LANDED ON EACH AREA, AND NOTHING ELSE. They come from the one
// loader every closing surface reads (`loadClosingStoreSplit`'s `epdaUnits`), computed over the WHOLE
// month, so a regional manager's file shows his areas' shares of the national spread and never a
// spread among his own areas. The units already ARE the closing's units for those rows.
//
// 🔴 NO WORD ON THIS TAB NAMES A DEDUCTION, A BONUS OR A PERCENTAGE. He announces the figures as they
// are (2026-11-04: "only we announce the figures after deduction no need to say anything other", and
// again: "never show that there are reduced units in the xlsx closing sheet"). The sheet's own units
// appear nowhere in any download.
//
// One column per product, totalled down the column only: units of different products are never added
// (AGENTS.md §4), so there is no row total across them.

import { isEpdaContributionActive, isEpdaContributionProduct } from "@/lib/sales/bulk-allocation-channel";
import { CLOSING_MATRIX_NO_OFFICE_BAND } from "@/lib/sales/closing-matrix-without-office";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import type { EngineValue } from "@/lib/sales/closing-engine-fill";
import type { ReviewSheet, ReviewSheetRowKind } from "@/lib/sales/closing-review-sheets";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { areaProductKey } from "@/lib/sales/store-sales-city-split";

export const CLOSING_EPDA_SHEET_NAME = "EPDA";

export type ClosingEpdaSheetSpec = {
  headers: string[];
  widths: number[];
  /** Region bars, area rows and the closing total, positional against `headers`. */
  records: EngineValue[][];
  rowKinds: ReviewSheetRowKind[];
  caption: string;
};

/**
 * The tab's grid for one line and month, or null when there is nothing to show: a month before
 * October 2026, a line rule 2 does not reach, a multi-month file, or a month with no EPDA units.
 */
export function closingEpdaSheetSpec(input: {
  matrix: MonthlyClosingMatrix;
  epdaUnits: ReadonlyMap<string, number> | null | undefined;
  periodLabel?: string | null;
}): ClosingEpdaSheetSpec | null {
  const { matrix, epdaUnits } = input;
  if (!epdaUnits || epdaUnits.size === 0) return null;
  if (!isEpdaContributionActive(matrix.period)) return null;
  // A folded multi-month matrix has no one month's spread to show.
  if (matrix.periods && matrix.periods.length > 1) return null;

  const unitsOf = (areaCode: string, productCode: string) => epdaUnits.get(areaProductKey(areaCode, productCode)) ?? 0;
  const regions = matrix.regions.map((region) => ({
    regionName: region.regionName,
    areas: region.areas.filter((area) => !isSyntheticDirectArea(area)),
  }));
  const products = matrix.columns.filter(
    (column) =>
      isEpdaContributionProduct(column.productCode)
      && regions.some((region) => region.areas.some((area) => unitsOf(area.areaCode, column.productCode) !== 0)),
  );
  if (products.length === 0) return null;

  const records: EngineValue[][] = [];
  const rowKinds: ReviewSheetRowKind[] = [];
  const total = products.map(() => 0);
  for (const region of regions) {
    const areas = region.areas.filter((area) => products.some((product) => unitsOf(area.areaCode, product.productCode) !== 0));
    if (areas.length === 0) continue;
    const regionUnits = products.map((product) => areas.reduce((sum, area) => sum + unitsOf(area.areaCode, product.productCode), 0));
    records.push([region.regionName, "", ...regionUnits.map((units) => Math.round(units))]);
    rowKinds.push("group");
    for (const area of areas) {
      records.push([region.regionName, area.areaName, ...products.map((product) => Math.round(unitsOf(area.areaCode, product.productCode)))]);
      rowKinds.push("detail");
    }
    regionUnits.forEach((units, index) => { total[index] += units; });
  }
  records.push(["Total", "", ...total.map((units) => Math.round(units))]);
  rowKinds.push("total");

  return {
    headers: ["Region", "Area", ...products.map((product) => `${product.productName} EPDA units`)],
    widths: [24, 24, ...products.map(() => 18)],
    records,
    rowKinds,
    caption: `EPDA-BULK and EPDA-Pharmacies units of each product, by area${input.periodLabel ? `, ${input.periodLabel}` : ""}. Each product is totalled on its own.`,
  };
}

/** The tab as the premium workbook's filler takes it. */
export function buildClosingEpdaSheet(input: {
  matrix: MonthlyClosingMatrix;
  epdaUnits: ReadonlyMap<string, number> | null | undefined;
  periodLabel: string | null;
  line: string | null;
}): ReviewSheet | null {
  const spec = closingEpdaSheetSpec(input);
  if (spec === null) return null;
  const stamp = [input.periodLabel, input.line].filter(Boolean).join("   ");
  return {
    band: CLOSING_MATRIX_NO_OFFICE_BAND,
    columnFormats: spec.headers.map((_, index) => (index < 2 ? null : "money")),
    headers: spec.headers,
    name: CLOSING_EPDA_SHEET_NAME,
    rowKinds: spec.rowKinds,
    rows: spec.records,
    subtitle: spec.caption,
    title: `EPDA   ${stamp}`.trim(),
    what: "EPDA units of each product, by area",
    widths: spec.widths,
  };
}
