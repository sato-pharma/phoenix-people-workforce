// The EPDA bonus deduction — the owner's rule of 2026-11-04, from the October 2026 closing on.
//
// His words: "we will deduct the bonus quantity from each sato items example ivyronc deduct 30% roya
// and saginkgo deduct 15% if ivyronc sales is 6000 so we consider only 4200 bottle . sure this
// calculation not for announcment. only we announce the figures after deduction no need to say
// anything other.only in epda starting oct closing ... never to put a decimal in units units are
// always a true number". His answers the same day: the two Sato books only, and the whole number is
// made on each AREA's total.
//
// 🔴 THIS IS A FLAT PERCENTAGE OF THE BOOK'S UNITS, NOT THE SHEET'S BONUS COLUMN. No distributor's
// bonus cell is counted or read from September on, and that rule is untouched.
//
// 🔴 IT HAPPENS WHEN THE ROWS ARE STORED, AND ONLY THERE. Some thirty-five database reports read
// `source_of_sales_import_rows` on their own: the rollups, the closing, attribution, the customer
// directory, Marketing ROI. A read-time net like the bulk allocation's would have to reach every one
// of them, and a report it missed would announce the undeducted figure. Stored this way there is one
// figure and nothing to reconcile. The sheet's own units stay in `raw_row`, which no report sums, and
// a re-upload starts again from the sheet.

import {
  isBulkAllocatedProduct,
  isBulkAllocationActive,
  isBulkDistributorCode,
} from "@/lib/sales/bulk-allocation-channel";

/** The first closing the deduction applies to. Every earlier month keeps what it stored. */
export const EPDA_BONUS_DEDUCTION_START_PERIOD = "2026-10";

/** EPDA-BULK and EPDA-Pharmacies. The main EPDA book (`EP`) is not a Sato book and counts in full. */
export const EPDA_BONUS_DEDUCTION_DISTRIBUTORS = ["EP-BK", "EP-PHS"] as const;

/** Percent taken off, per product code. Royanoxicam (`RY001`) is a different product from Royafloxacin. */
export const EPDA_BONUS_DEDUCTION_PERCENT: Readonly<Record<string, number>> = {
  IV001: 30, // Ivyronc
  RO001: 15, // Royafloxacin
  SA001: 15, // Saginko
};

const normalizedCode = (value: unknown) => String(value ?? "").trim().toUpperCase();

/** The percent this row's units lose, 0 when the rule does not reach it. */
export function epdaBonusDeductionPercent(
  distributorCode: unknown,
  productCode: unknown,
  period: string | null | undefined,
): number {
  if (!period || !/^\d{4}-\d{2}/.test(period) || period.slice(0, 7) < EPDA_BONUS_DEDUCTION_START_PERIOD) return 0;
  if (!(EPDA_BONUS_DEDUCTION_DISTRIBUTORS as readonly string[]).includes(normalizedCode(distributorCode))) return 0;
  return EPDA_BONUS_DEDUCTION_PERCENT[normalizedCode(productCode)] ?? 0;
}

type DeductibleRow = {
  areaCode: string | null;
  distributorCode: string;
  isDirect?: boolean | null;
  productCode: string;
  qty: number;
  value: number;
};

/**
 * Take the deduction off a batch's rows, leaving every row a whole number of units.
 *
 * Each group's total is rounded once, and its rows take whole shares of that total by largest
 * remainder, so an area of 100 Ivyronc reads 70 however many one-unit pharmacies make it up. A group
 * is one area of one product, except EPDA-BULK's Ivyronc: the closing ignores the invoiced area of
 * those rows and spreads the whole book by contribution, so the whole book is its one group and 6000
 * reads 4200.
 *
 * Returns the SAME array when nothing is deducted. A deducted row is a new object with `qty` and
 * `value` changed and nothing else, so `rawRow` still says what the sheet said. The value follows
 * the units at the row's own price. A direct order is a deal, not a line of these books, and is left
 * alone. PURE: no database, no clock.
 */
export function applyEpdaBonusDeduction<R extends DeductibleRow>(
  rows: R[],
  periodOf: (row: R) => string | null | undefined,
): R[] {
  const groups = new Map<string, { indexes: number[]; percent: number }>();
  rows.forEach((row, index) => {
    if (row.isDirect || !Number.isFinite(row.qty)) return;
    const period = periodOf(row);
    const percent = epdaBonusDeductionPercent(row.distributorCode, row.productCode, period);
    if (percent === 0) return;
    const wholeBook =
      isBulkDistributorCode(row.distributorCode) && isBulkAllocatedProduct(row.productCode) && isBulkAllocationActive(period);
    const key = [
      normalizedCode(row.distributorCode),
      normalizedCode(row.productCode),
      String(period).slice(0, 7),
      wholeBook ? "" : normalizedCode(row.areaCode),
    ].join("|");
    const group = groups.get(key) ?? { indexes: [], percent };
    group.indexes.push(index);
    groups.set(key, group);
  });
  if (groups.size === 0) return rows;

  const deducted = [...rows];
  for (const { indexes, percent } of groups.values()) {
    const keep = (qty: number) => (qty * (100 - percent)) / 100;
    const shares = indexes.map((index) => {
      const ideal = keep(rows[index].qty);
      const units = Math.floor(ideal);
      return { index, remainder: ideal - units, units };
    });
    const net = indexes.reduce((sum, index) => sum + rows[index].qty, 0);
    const total = Math.sign(net) * Math.round(Math.abs(keep(net)));
    let left = total - shares.reduce((sum, share) => sum + share.units, 0);
    // The biggest remainder first; the file's own order settles a tie, so a re-upload lands the same.
    const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const share of byRemainder) {
      if (left <= 0) break;
      share.units += 1;
      left -= 1;
    }
    for (const { index, units } of shares) {
      const row = rows[index];
      const value = row.qty === 0 ? row.value : Number(((row.value * units) / row.qty).toFixed(6));
      deducted[index] = { ...row, qty: units, value };
    }
  }
  return deducted;
}
