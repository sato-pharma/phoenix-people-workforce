// Gap to Quarter Target — the premium closing workbook's quarter tab.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT ANSWERS. The workbook is a MONTH. Targets are set a QUARTER at a time and paid
// semesterly, so the question a reader carries out of a monthly closing is the one the monthly
// closing cannot answer: how much of this quarter's target is already sold, and how much is left.
// This sheet is that arithmetic, per area, per product, in units and in value.
//
// THREE DECISIONS SHAPE EVERY NUMBER ON IT, and each of them is a different figure if got wrong.
//
//  1. SALES ARE QUARTER-TO-DATE, THROUGH THE MONTH THE WORKBOOK IS FOR — never the whole quarter's
//     uploaded data. A reader opening the July closing must not be shown August's sales in the
//     "sold so far" column: the workbook says July on every other tab, and a quarter figure that
//     silently ran ahead of it would make the two disagree with no way to tell which was meant.
//     So months AFTER the selected one are not read at all, and the sheet says which month it
//     counts through.
//
//  2. THE TARGET IS THE WHOLE QUARTER'S — all three months, including the ones not yet closed.
//     This is the half that makes the sheet worth having. Summing only the closed months' targets
//     would produce a "gap to date", which is a number nobody plans against: with one month of the
//     quarter left, the useful figure is what is still owed against the FULL quarter. Targets for
//     an unclosed month exist — they are set a quarter ahead — and they are read straight from
//     `au.monthly_targets`, the same source the closing matrix's own target columns come from.
//
//  3. UNITS ARE NEVER SUMMED ACROSS PRODUCTS. The owner's standing rule. A product row spans one
//     product code across three months, which is the same pack counted three times over and is a
//     real quantity; an AREA row spans seventeen products at several concentrations, which is a
//     category error. So every area row here carries VALUE only and leaves its unit cells blank.
//     Blank, not zero — a zero in a unit column would read as "sold none".
//
// WHY THE TARGETS ARE READ AGAIN RATHER THAN SUMMED OFF THE MATRICES. The merged quarter matrix
// already carries a target per cell, and using it would be one source instead of two — but only
// for the months that HAVE a closing. The unclosed month has no matrix at all, so its target would
// silently be zero and the gap would come out short by a third of the quarter. Reading all three
// months from one place is what keeps the target basis uniform; a target that lands on no cell of
// the grid is dropped, exactly as the closing matrix itself drops it.

import { foldAreaCodeForLine } from "@/lib/sales/closing-area-merges";
import { mergeMonthlyClosingMatrices } from "@/lib/sales/monthly-closing-period-merge";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import {
  expandTargetPeriodScope,
  loadMonthlyTargets,
  resolveTargetLineCode,
} from "@/lib/sales/monthly-targets";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

/** The four narrowings a closing export carries, applied to every month of the quarter alike. */
export type ClosingQuarterGapFilter = {
  areaCodes: string[];
  productCodes: string[];
  regionCodes: string[];
  search: string;
};

/**
 * One line of the sheet.
 *
 * `kind` is what decides whether the unit columns may be read: an `area` row spans products, so its
 * `salesUnits` / `targetUnits` / `gapUnits` are all null by construction and not merely absent.
 */
export type ClosingQuarterGapRow = {
  achievement: number | null;
  areaCode: string;
  areaName: string;
  gapUnits: number | null;
  gapValue: number | null;
  kind: "area" | "product" | "lineTotal";
  productCode: string;
  productName: string;
  regionName: string;
  salesUnits: number | null;
  salesValue: number;
  targetUnits: number | null;
  targetValue: number | null;
};

export type ClosingQuarterGap = {
  /** Every month of the calendar quarter, oldest first — the target's span. */
  months: string[];
  /** The months whose closing was actually folded into the sales columns. */
  monthsCounted: string[];
  /** Wanted for the sales columns and unreadable — the quarter to date is short by these. */
  monthsMissing: string[];
  /** `Q3 2026`. */
  quarterLabel: string;
  rows: ClosingQuarterGapRow[];
  /** The month the workbook is for. Sales are counted through it and no further. */
  through: string;
};

const PERIOD_RE = /^\d{4}-\d{2}$/;

const up = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

/** `2026-08` becomes `Q3 2026`. */
export function closingQuarterLabel(period: string): string {
  if (!PERIOD_RE.test(period)) return period;
  const [year, month] = period.split("-");
  return `Q${Math.floor((Number(month) - 1) / 3) + 1} ${year}`;
}

/**
 * The two month lists behind the sheet, and they are DIFFERENT LISTS on purpose.
 *
 * `months` is the whole calendar quarter and is what the TARGET spans — including a month that has
 * no closing yet, which is the figure the sheet exists to produce. `salesMonths` stops at the month
 * the workbook is for, so the sold columns never run past the month printed on every other tab.
 *
 * They come back together, from one function, because the whole correctness of this sheet is that
 * they differ: reading targets over `salesMonths` under-states the quarter by however many months
 * are left in it, and reading sales over `months` puts a month the reader did not ask for into a
 * workbook that names a different one. Both produce a number; neither produces an error.
 */
export function closingQuarterGapMonths(period: string): { months: string[]; salesMonths: string[] } {
  const months = expandTargetPeriodScope(period, "quarter");
  return { months, salesMonths: months.filter((month) => month <= period) };
}

/**
 * Null-preserving addition, the closing's own rule for a target column.
 *
 * A missing target is not a zero: two blanks stay blank so the cell prints an em dash, and only
 * once one side carries a real number does the sum become one. Duplicated from the matrix's own
 * `addTarget` rather than imported, because that one is module-private and one line long.
 */
function addTarget(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}

/** Never averaged from per-cell percentages, and never emitted against a null or zero target. */
function achievementOf(salesValue: number, targetValue: number | null): number | null {
  if (targetValue === null || targetValue === 0) return null;
  return salesValue / targetValue;
}

/** Positive is still to sell; negative is already past the quarter's target. */
function gapOf(salesValue: number, targetValue: number | null): number | null {
  return targetValue === null ? null : targetValue - salesValue;
}

type QuarterTarget = { targetUnits: number | null; targetValue: number | null };

/** `AREA PRODUCT`, both upper-cased — the key the closing matrix itself places targets by. */
function targetKey(areaCode: string, productCode: string): string {
  return `${up(areaCode)} ${up(productCode)}`;
}

/** One month's target rows, in the shape `loadMonthlyTargets` returns them. */
export type QuarterTargetMonth = {
  period: string;
  rows: ReadonlyArray<{
    areaCode: string;
    lineCode: string;
    productCode: string;
    targetUnits: number | null;
    targetValue: number | null;
  }>;
};

/**
 * Fold the quarter's target rows into one figure per area × product.
 *
 * Each month is folded with ITS OWN merge rules. Fayoum and Beni Suef are one row on Pedia up to
 * August and two from September, so a quarter spanning that date has to fold August's pair and
 * leave September's alone — folding the whole quarter by one month's rules would either invent a
 * merged row September does not have or split an August one that was published merged.
 */
export function foldQuarterTargets(
  months: readonly QuarterTargetMonth[],
  targetLineCode: string,
): Map<string, QuarterTarget> {
  const folded = new Map<string, QuarterTarget>();
  for (const month of months) {
    for (const row of month.rows) {
      if (row.lineCode !== targetLineCode) continue;
      const areaCode = foldAreaCodeForLine(targetLineCode, row.areaCode, month.period);
      const key = targetKey(areaCode, row.productCode);
      const existing = folded.get(key);
      folded.set(key, {
        targetUnits: addTarget(existing?.targetUnits ?? null, row.targetUnits),
        targetValue: addTarget(existing?.targetValue ?? null, row.targetValue),
      });
    }
  }
  return folded;
}

/**
 * The sheet's rows, from a merged quarter-to-date matrix and the quarter's folded targets.
 *
 * Pure, and separated from the loader for the usual reason: the arithmetic that decides what a gap
 * IS can then be tested against a matrix built by hand, with no database anywhere near it.
 *
 * An area with neither a sale nor a target anywhere in the quarter is left out entirely — a row of
 * dashes is not a finding. An area WITH a target and no sales is exactly the row a reader is
 * looking for, and always survives.
 */
export function buildClosingQuarterGapRows(
  matrix: MonthlyClosingMatrix,
  targets: ReadonlyMap<string, QuarterTarget>,
): ClosingQuarterGapRow[] {
  const rows: ClosingQuarterGapRow[] = [];
  let lineSales = 0;
  let lineTarget: number | null = null;

  const areaRows = matrix.regions.flatMap((region) => region.areas);
  for (const area of areaRows) {
    const products: ClosingQuarterGapRow[] = [];
    let areaSales = 0;
    let areaTarget: number | null = null;

    matrix.columns.forEach((column, index) => {
      const cell: MonthlyClosingCell | undefined = area.cells[index];
      const salesUnits = cell?.salesUnits ?? 0;
      const salesValue = cell?.salesValue ?? 0;
      const target = targets.get(targetKey(area.areaCode, column.productCode)) ?? null;
      const targetUnits = target?.targetUnits ?? null;
      const targetValue = target?.targetValue ?? null;

      areaSales += salesValue;
      areaTarget = addTarget(areaTarget, targetValue);

      // Nothing sold and nothing owed — the pair carries no question.
      if (salesValue === 0 && salesUnits === 0 && targetUnits === null && targetValue === null) return;

      products.push({
        achievement: achievementOf(salesValue, targetValue),
        areaCode: area.areaCode,
        areaName: area.areaName,
        gapUnits: targetUnits === null ? null : targetUnits - salesUnits,
        gapValue: gapOf(salesValue, targetValue),
        kind: "product",
        productCode: column.productCode,
        productName: column.productName,
        regionName: area.regionName,
        salesUnits,
        salesValue,
        targetUnits,
        targetValue,
      });
    });

    if (products.length === 0) continue;

    lineSales += areaSales;
    lineTarget = addTarget(lineTarget, areaTarget);

    // The area first, then its products under it. Units stay null on this row — see rule 3 in the
    // header: seventeen products at several concentrations do not add up to a quantity.
    rows.push({
      achievement: achievementOf(areaSales, areaTarget),
      areaCode: area.areaCode,
      areaName: area.areaName,
      gapUnits: null,
      gapValue: gapOf(areaSales, areaTarget),
      kind: "area",
      productCode: "",
      productName: "All products",
      regionName: area.regionName,
      salesUnits: null,
      salesValue: areaSales,
      targetUnits: null,
      targetValue: areaTarget,
    });
    rows.push(...products);
  }

  if (rows.length === 0) return rows;

  rows.push({
    achievement: achievementOf(lineSales, lineTarget),
    areaCode: "",
    areaName: "All areas",
    gapUnits: null,
    gapValue: gapOf(lineSales, lineTarget),
    kind: "lineTotal",
    productCode: "",
    productName: "All products",
    regionName: "",
    salesUnits: null,
    salesValue: lineSales,
    targetUnits: null,
    targetValue: lineTarget,
  });

  return rows;
}

/**
 * Read the quarter behind one closing month.
 *
 * `selectedMonth` is the matrix the rest of the workbook is already built from — filtered, store
 * split applied, direct folded in. Passing it means the selected month is not read a second time,
 * AND that this sheet's figure for it is the identical object every other tab used, so the two
 * cannot disagree.
 *
 * Returns null whenever there is no sheet worth adding: no month, a line that carries no targets at
 * all (Head Office resolves to no target code), a targets read that failed, or a quarter in which
 * nothing is targeted. A missing tab is recoverable; a gap column computed against a target that
 * failed to load is a wrong number wearing the right heading.
 */
export async function loadClosingQuarterGap(input: {
  filter: ClosingQuarterGapFilter;
  line: string | null;
  period: string | null;
  selectedMonth?: MonthlyClosingMatrix | null;
}): Promise<ClosingQuarterGap | null> {
  const period = String(input.period ?? "").trim();
  if (!PERIOD_RE.test(period)) return null;

  const targetLineCode = resolveTargetLineCode(input.line);
  if (!targetLineCode) return null;

  // `months` for the target, `salesMonths` for the sold columns — see the helper: the difference
  // between the two lists is the sheet.
  const { months, salesMonths } = closingQuarterGapMonths(period);

  // ONE wave, not two. The targets and the months answer different questions and neither needs the
  // other's result, so awaiting the targets first would put a whole extra round trip on an export
  // the reader is already waiting on. The cost of firing both is a month read that goes unused when
  // there are no targets at all — a case the line-code check above has already taken.
  const [targetMonths, loaded] = await Promise.all([
    Promise.all(months.map(async (month) => ({ period: month, rows: await loadMonthlyTargets(month) })))
      // Null, never a short target. A gap measured against a target that failed to load is a wrong
      // number wearing the right heading, and nothing downstream could tell.
      .catch(() => null as QuarterTargetMonth[] | null),
    Promise.all(
      salesMonths.map(async (month) => {
        if (input.selectedMonth && input.selectedMonth.period === month) {
          return { matrix: input.selectedMonth, period: month };
        }
        try {
          const parts = await loadMonthlyClosingPartsWithStoreSplit({ line: input.line, period: month });
          // The loader FALLS BACK to its newest month when the one asked for has nothing, so a month
          // that was never uploaded would otherwise be folded in as a copy of another one — the same
          // guard the multi-month loader and the review's own series already carry.
          if (parts.combined.period !== month) return { matrix: null, period: month };
          return { matrix: filterMonthlyClosingMatrix(parts.combined, input.filter), period: month };
        } catch {
          return { matrix: null, period: month };
        }
      }),
    ),
  ]);

  if (!targetMonths) return null;
  const targets = foldQuarterTargets(targetMonths, targetLineCode);
  if (targets.size === 0) return null;

  const usable = loaded.filter(
    (entry): entry is { matrix: MonthlyClosingMatrix; period: string } => entry.matrix !== null,
  );
  if (usable.length === 0) return null;

  const merged = mergeMonthlyClosingMatrices(usable.map((entry) => entry.matrix));
  const rows = buildClosingQuarterGapRows(merged, targets);
  if (rows.length === 0) return null;

  return {
    months,
    monthsCounted: usable.map((entry) => entry.period),
    monthsMissing: loaded.filter((entry) => entry.matrix === null).map((entry) => entry.period),
    quarterLabel: closingQuarterLabel(period),
    rows,
    through: period,
  };
}
