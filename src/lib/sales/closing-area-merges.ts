import type {
  MonthlyClosingAggregateCell,
  MonthlyClosingMatrix,
  MonthlyClosingTargetCell,
  SalesAreaReference,
} from "@/lib/sales/monthly-distributor-import";

// WHY THIS EXISTS: Fayoum (GZ6) and Beni Suef (UE9, split out of GZ6 on 2026-08-03) are staffed
// differently per line — see the memory note fayoum-beni-suef-golden-rule-per-line for the full
// ruling (owner, 2026-08-07):
//
//   Anti Infective  kept SEPARATE — Beni Suef sits in UE-1 with Minia 1/2, Fayoum stays in GZ.
//   Pedia / CNS     ONE area — one rep/territory covers both, so the closing must show ONE row.
//
// `au.line_area_map` already reflects this (both area_code rows share one seat on Pedia/CNS), but
// the Closing Matrix groups by `source_of_sales_areas`, a geography table with no concept of "one
// line's organogram merges these" — GZ6 and UE9 are, and must stay, two genuinely separate SALES
// areas (different bricks, different invoice lines) on every line, including Anti Infective. This
// module is the ONLY place that folds them into one row, and only for the two lines the owner named.
//
// Following the owner's "Golden Rule" (2026-08-07), this merge is applied EVERYWHERE for those lines
// — on the Closing Matrix, the export's Data sheet, and the UI's Closing Details panel — so the
// viewer never sees them as separate areas.

const up = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

export type ClosingAreaMergeRule = {
  /** Area code the merged row survives under. */
  keepAreaCode: string;
  /** Area code folded into `keepAreaCode`; dropped from the matrix, its sales added in. */
  mergeAreaCode: string;
  /** Display name for the surviving row once merged. */
  mergedAreaName: string;
};

/**
 * The ONLY lines whose Closing Matrix merges Fayoum and Beni Suef into one row.
 * ADDING A LINE HERE MERGES THAT LINE'S AREA ROWS — ask the owner first, every time.
 */
const CLOSING_AREA_MERGES: Record<string, ClosingAreaMergeRule[]> = {
  pedia: [{ keepAreaCode: "GZ6", mergeAreaCode: "UE9", mergedAreaName: "Fayoum - Beni Suef" }],
  cns: [{ keepAreaCode: "GZ6", mergeAreaCode: "UE9", mergedAreaName: "Fayoum - Beni Suef" }],
};

/** Does this line's closing merge any areas? Line code as `resolveTargetLineCode` returns. */
export function hasClosingAreaMerges(lineCode: string | null | undefined): boolean {
  return (CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? []).length > 0;
}

function mergeCells<T extends { areaCode: string; productCode: string }>(
  rows: readonly T[],
  remap: (code: string) => string,
  add: (a: T, b: T) => T,
): T[] {
  const byKey = new Map<string, T>();
  rows.forEach((row) => {
    const mappedCode = remap(row.areaCode);
    const key = `${mappedCode}|${up(row.productCode)}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? add(existing, row) : { ...row, areaCode: mappedCode });
  });
  return [...byKey.values()];
}

/**
 * Applies the line's area merges to any array of objects carrying `lineCode` and `areaCode`
 * (e.g. `AchievementRow`s in the dashboard). Merged areas will have their `areaCode` rewritten
 * to the `keepAreaCode`. The aggregation (totals, rollup) will naturally sum them together.
 */
export function applyAchievementAreaMerges<
  T extends { lineCode: string | null; areaCode: string | null }
>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!row.lineCode || !row.areaCode) return row;
    const rules = CLOSING_AREA_MERGES[row.lineCode.trim().toLowerCase()] ?? [];
    if (rules.length === 0) return row;

    const keepCodeByMergeCode = new Map<string, string>();
    for (const rule of rules) {
      keepCodeByMergeCode.set(up(rule.mergeAreaCode), up(rule.keepAreaCode));
    }

    const areaCode = up(row.areaCode);
    const remappedCode = keepCodeByMergeCode.get(areaCode);
    
    if (remappedCode) {
      return { ...row, areaCode: remappedCode };
    }
    
    return row;
  });
}

/** Get the merged area name for a code if the active line defines one. */
export function getMergedAreaName(lineCode: string | null | undefined, areaCode: string): string | null {
  if (!lineCode) return null;
  const rules = CLOSING_AREA_MERGES[lineCode.trim().toLowerCase()] ?? [];
  const match = rules.find((r) => up(r.keepAreaCode) === up(areaCode));
  return match ? match.mergedAreaName : null;
}

/**
 * Folds `mergeAreaCode`'s row into `keepAreaCode` for every rule this line has: one area entry
 * (renamed), sales cells summed, target cells summed. An area untouched by any rule passes through
 * unchanged. Called once, right before `buildMonthlyClosingMatrix` — never before the Direct
 * allocation, which reads the pre-merge `areas`/`cells` because it works at the REGION level and
 * must see the real geography a Direct row was tagged with.
 */
export function applyClosingAreaMerges(
  lineCode: string | null | undefined,
  areas: readonly SalesAreaReference[],
  cells: readonly MonthlyClosingAggregateCell[],
  targets: readonly MonthlyClosingTargetCell[],
): { areas: SalesAreaReference[]; cells: MonthlyClosingAggregateCell[]; targets: MonthlyClosingTargetCell[] } {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  if (rules.length === 0) {
    return { areas: [...areas], cells: [...cells], targets: [...targets] };
  }

  const areaCodes = new Set(areas.map((a) => up(a.areaCode)));
  const effectiveRules = rules.filter((rule) =>
    areaCodes.has(up(rule.keepAreaCode)) && areaCodes.has(up(rule.mergeAreaCode)),
  );
  if (effectiveRules.length === 0) {
    return { areas: [...areas], cells: [...cells], targets: [...targets] };
  }

  const keepCodeByMergeCode = new Map<string, string>();
  const mergedNameByKeepCode = new Map<string, string>();
  effectiveRules.forEach((rule) => {
    keepCodeByMergeCode.set(up(rule.mergeAreaCode), up(rule.keepAreaCode));
    mergedNameByKeepCode.set(up(rule.keepAreaCode), rule.mergedAreaName);
  });

  const remap = (code: string) => keepCodeByMergeCode.get(up(code)) ?? up(code);

  const mergedAreas = areas
    .filter((area) => !keepCodeByMergeCode.has(up(area.areaCode)))
    .map((area) => {
      const mergedName = mergedNameByKeepCode.get(up(area.areaCode));
      return mergedName ? { ...area, areaName: mergedName } : area;
    });

  const mergedCells = mergeCells(cells, remap, (a, b) => ({
    ...a,
    salesUnits: a.salesUnits + b.salesUnits,
    salesValue: a.salesValue + b.salesValue,
  }));

  // "Blank" and "zero" are different claims (see buildMonthlyClosingMatrix's own note) — only
  // collapse to a real 0 once at least one side actually has a target; two blanks stay blank.
  const sumTarget = (a: number | null, b: number | null) =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  const mergedTargets = mergeCells(targets, remap, (a, b) => ({
    ...a,
    targetUnits: sumTarget(a.targetUnits, b.targetUnits),
    targetValue: sumTarget(a.targetValue, b.targetValue),
  }));

  return { areas: mergedAreas, cells: mergedCells, targets: mergedTargets };
}

/**
 * A merged row's cached value cannot be trusted to a live Data-sheet SUMIFS in the export if the
 * raw invoice rows for `mergeAreaCode` still carry THEIR OWN area code on the Data sheet.
 * However, since we now also rewrite the Data sheet rows via `applyClosingAreaMergesToDetails`,
 * the SUMIFS formula would actually work. We keep this static mark as a defensive measure.
 *
 * Reuses `storeSplitAdjusted` — the export's existing "render this row static, not a live
 * formula" contract (see MonthlyClosingAreaRow's own doc comment). Two different producers,
 * identical row-level guarantee the export writer needs.
 *
 * Only the AREA row needs it. `keepAreaCode` and `mergeAreaCode` already sit in the SAME real
 * geographic region (`source_of_sales_areas.region_code`) for both configured lines, so the
 * region subtotal's SUMIFS — filtered by region, not area — genuinely still catches both
 * areas' raw rows and stays safely live.
 *
 * Called once, right after `buildMonthlyClosingMatrix`, before `injectDirectIntoMatrix` (which
 * spreads existing area-row objects when it adds a synthetic Direct row, so this flag survives).
 */
export function markMergedAreaRowsStatic(
  matrix: MonthlyClosingMatrix,
  lineCode: string | null | undefined,
): MonthlyClosingMatrix {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  if (rules.length === 0) return matrix;

  const keepCodes = new Set(rules.map((rule) => up(rule.keepAreaCode)));
  return {
    ...matrix,
    regions: matrix.regions.map((region) => ({
      ...region,
      areas: region.areas.map((area) =>
        keepCodes.has(up(area.areaCode)) ? { ...area, storeSplitAdjusted: true } : area,
      ),
    })),
  };
}

/**
 * Applies the line's area merges to the raw invoice rows for the Data sheet and Closing Details
 * panel. A row mapped to `mergeAreaCode` is rewritten to `keepAreaCode` and `mergedAreaName`.
 */
export function applyClosingAreaMergesToDetails<
  T extends { areaCode: string; areaName: string; sheetAreaCode?: string; sheetAreaName?: string }
>(lineCode: string | null | undefined, rows: T[]): T[] {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  if (rules.length === 0) return rows;

  const keepCodeByMergeCode = new Map<string, string>();
  const mergedNameByKeepCode = new Map<string, string>();
  for (const rule of rules) {
    keepCodeByMergeCode.set(up(rule.mergeAreaCode), up(rule.keepAreaCode));
    mergedNameByKeepCode.set(up(rule.keepAreaCode), rule.mergedAreaName);
  }

  return rows.map((row) => {
    const newRow = { ...row };

    // Rewrite resolved area
    const areaCode = up(newRow.areaCode);
    const remappedCode = keepCodeByMergeCode.get(areaCode);
    if (remappedCode) {
      newRow.areaCode = remappedCode;
      newRow.areaName = mergedNameByKeepCode.get(remappedCode) ?? newRow.areaName;
    } else {
      const mergedName = mergedNameByKeepCode.get(areaCode);
      if (mergedName) newRow.areaName = mergedName;
    }

    // Rewrite sheet area
    if (newRow.sheetAreaCode !== undefined) {
      const sheetCode = up(newRow.sheetAreaCode);
      const remappedSheetCode = keepCodeByMergeCode.get(sheetCode);
      if (remappedSheetCode) {
        newRow.sheetAreaCode = remappedSheetCode;
        newRow.sheetAreaName = mergedNameByKeepCode.get(remappedSheetCode) ?? newRow.sheetAreaName;
      } else {
        const mergedSheetName = mergedNameByKeepCode.get(sheetCode);
        if (mergedSheetName) newRow.sheetAreaName = mergedSheetName;
      }
    }

    return newRow;
  });
}
