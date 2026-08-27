import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

// What the Regions / Areas / Products pickers are allowed to offer.
//
// One definition, shared by the Monthly Closing screen and its Performance Review, because the two
// must offer the same things: an area that is filterable on one screen and missing from the other
// reads as data loss rather than as a difference between two pickers.
//
// Pure — no database, no React — so a "use client" component can import it without dragging the
// closing's Supabase loaders into the browser bundle.

export type MonthlyClosingFilterOption = {
  code: string;
  label: string;
  regionCode?: string;
};

export type MonthlyClosingFilterOptions = {
  areas: MonthlyClosingFilterOption[];
  products: MonthlyClosingFilterOption[];
  regions: MonthlyClosingFilterOption[];
};

export const emptyMonthlyClosingFilterOptions: MonthlyClosingFilterOptions = {
  areas: [],
  products: [],
  regions: [],
};

/**
 * Build the pickers' options from a closing matrix.
 *
 * Pass the UNFILTERED matrix. Deriving the options from what is currently on screen leaves the
 * reader stranded: filter to Delta and the Regions picker then offers Delta alone, so switching to
 * Upper Egypt means first working out that the list has to be cleared.
 */
export function monthlyClosingFilterOptions(
  matrix: MonthlyClosingMatrix | null | undefined,
): MonthlyClosingFilterOptions {
  if (!matrix) return emptyMonthlyClosingFilterOptions;
  return {
    // Exclude the synthetic per-region "Direct" rows — they share the code "DIRECT" across regions
    // and are not a filterable area. Only those: `area.isDirect` is also true for a real area that
    // absorbed July 2026's direct orders, and filtering on the raw flag hid every such area
    // (Dakahlia 1, Behira 2, …) from this picker.
    areas: matrix.regions.flatMap((region) =>
      region.areas
        .filter((area) => !isSyntheticDirectArea(area))
        .map((area) => ({
          code: area.areaCode,
          label: area.areaName + " (" + area.areaCode + ")",
          regionCode: region.regionCode,
        })),
    ),
    products: matrix.columns.map((column) => ({
      code: column.productCode,
      label: column.productName + " (" + column.productCode + ")",
    })),
    regions: matrix.regions.map((region) => ({
      code: region.regionCode,
      label: region.regionName + " (" + region.regionCode + ")",
    })),
  };
}
