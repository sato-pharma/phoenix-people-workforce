// Weekly Sales per-product units — the SHAPE only: the window constants and the row/column types.
//
// WHY THIS IS ITS OWN FILE, AND MUST STAY ONE. The grid is rendered by a `"use client"` component,
// and the builder next door (`portal-weekly-product-units.ts`) reaches the weekly service, which
// reaches the employee directory, which reaches `node:crypto`. Webpack refuses a Node builtin in a
// client bundle (UnhandledSchemeError) and the dev server then 500s EVERY request — so the view may
// not import the builder at all, not even for a constant. The two month constants are the whole
// reason this split exists: TYPES are erased at compile time, a `const` is not.
//
// Nothing here may import anything that is not itself client-safe. `tests/client-bundle-server-leak.test.ts`
// is what catches a regression, in the required `validate` job.

/**
 * How many cycle months the grid reaches back by default.
 *
 * THREE, because three is what the owner asked the monthly tab for in the first place ("under it
 * july august september") and because the whole weekly history is six months of ~10,000 rows each:
 * this tab reads the row grain and runs the field-force build once per month, so each extra month is
 * a real cost paid by a reader who did not ask for it. A caller may ask for more, up to the cap.
 */
export const WEEKLY_PRODUCT_UNITS_MONTHS = 3;

/** The furthest back the grid will ever go, whatever a caller asks for. */
export const WEEKLY_PRODUCT_UNITS_MAX_MONTHS = 6;

/**
 * One block of the grid: ONE product code, carrying its own run of months plus its growth.
 *
 * `unitsAreAddable` is always true here and is carried anyway, for the same reason the monthly
 * matrix carries it — the decision that these units MAY be summed has to travel on the data, not be
 * assumed by whatever renders it next.
 */
export type WeeklyProductUnitsColumn = {
  key: string;
  label: string;
  subLabel: string;
  unitsAreAddable: boolean;
  /** EGP over the whole window. What the axis is ordered by, and never added to a unit figure. */
  value: number;
};

/**
 * One row of the grid — who sold it on the left, then every product's months.
 *
 * `units[productIndex][monthIndex]` is UNITS of one product code. A `null` means the month was never
 * uploaded; a 0 means it was and this person sold none. There is deliberately no row total.
 */
export type WeeklyProductUnitsRow = {
  areaCode: string | null;
  areaName: string | null;
  /** This row's own growth per product: newest month over the one before it. */
  growth: Array<number | null>;
  /** `rep` and `vacant` are area rows; `unattributed` is the line's residue bucket. */
  kind: "rep" | "vacant" | "unattributed" | "regionSubtotal" | "lineSubtotal" | "grandTotal";
  /** Stable key for React and for a test to name a row by. */
  key: string;
  /** The person, "Vacant", the bucket's label, or the subtotal's own heading. Never an HR id. */
  label: string;
  lineCode: string;
  lineName: string;
  managerName: string | null;
  regionCode: string | null;
  regionName: string | null;
  repName: string | null;
  units: Array<Array<number | null>>;
};

export type WeeklyProductUnitsMatrix = {
  columns: WeeklyProductUnitsColumn[];
  /** Cycle months (YYYY-MM-01), oldest first — the columns inside every block. */
  months: string[];
  /** Months asked for that hold no uploaded row at all, so the screen can name them. */
  emptyMonths: string[];
  rows: WeeklyProductUnitsRow[];
  totals: {
    /** EGP over the window. The only legitimate total that spans products. */
    value: number;
    /** Value credited from a branch the owner mapped BY HAND. Exact, not allocated. */
    exactValue: number;
    /** Value placed by reading the branch name and spreading it. An allocation — label it. */
    allocatedValue: number;
    /** Value that reached no area, and so no rep. Shown on its line's bucket row, never dropped. */
    unattributedValue: number;
    repsWithSales: number;
  };
  /** True when the seat index could not be read — the screen must say so, not show "no reps". */
  seatIndexUnavailable: boolean;
  generatedAt: string;
};
