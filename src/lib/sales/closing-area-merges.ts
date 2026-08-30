import type {
  MonthlyClosingAggregateCell,
  MonthlyClosingMatrix,
  MonthlyClosingTargetCell,
  SalesAreaReference,
} from "@/lib/sales/monthly-distributor-import";

// WHY THIS EXISTS: Fayoum (GZ6) and Beni Suef (UE9, split out of GZ6 on 2026-08-03) are staffed
// differently per line — see the memory note fayoum-beni-suef-golden-rule-per-line for the full
// ruling (owner, 2026-08-07, refined 2026-08-30):
//
//   Anti Infective  kept SEPARATE — Beni Suef sits in UE-1 with Minia 1/2, Fayoum stays in GZ.
//   Pedia           ONE area — one rep/territory covers both, so every surface shows ONE row.
//   CNS             kept SEPARATE — owner split the CNS "Others" bucket back into two on 2026-08-30
//                   (it carried ~174K of real July value across the two codes; he chose to see them
//                   as Fayoum and Beni Suef separately, same as Anti Infective).
//
// `au.line_area_map` reflects the staffing (on Pedia both area_code rows share one seat), but the
// Closing Matrix groups by `source_of_sales_areas`, a geography table with no concept of "one
// line's organogram merges these" — GZ6 and UE9 are, and must stay, two genuinely separate SALES
// areas (different bricks, different invoice lines) on EVERY line. This module is the ONLY place
// that folds them into one row, and only for the one line the owner named (Pedia).
//
// Following the owner's rule, the Pedia merge is applied EVERYWHERE the areas surface — the Closing
// Matrix, the export's Data sheet, the Closing Details panel, the canonical dashboards, the
// organogram, and the territory / coverage / planning pickers — so the viewer never sees the two
// Pedia halves as separate areas. Beni Suef (UE9) carries its OWN sales, so any surface that
// FILTERS by the merged area must expand the selection back to {GZ6, UE9} via expandAreaCodeForLine
// — filtering on GZ6 alone silently drops Beni Suef's numbers.

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
 * The ONLY lines whose area rows are folded into one. Pedia folds Fayoum (GZ6) + Beni Suef (UE9).
 * ADDING A LINE HERE MERGES THAT LINE'S AREA ROWS — ask the owner first, every time. CNS was
 * removed on 2026-08-30 at the owner's instruction (it now shows the two areas separately).
 */
const CLOSING_AREA_MERGES: Record<string, ClosingAreaMergeRule[]> = {
  pedia: [{ keepAreaCode: "GZ6", mergeAreaCode: "UE9", mergedAreaName: "Fayoum - Beni Suef" }],
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
 * Expand a (possibly merged) area code to every real area code it stands for, so a query that
 * filters on the surviving keep-code still pulls the folded areas' rows. For Pedia, `GZ6` expands
 * to `["GZ6", "UE9"]`; every other code — and every other line — returns just `[code]`.
 *
 * This is the anti-data-loss primitive every PICKER-FOLD surface MUST call before it filters or
 * queries: Beni Suef (UE9) carries its own sales, so a query scoped to `GZ6` alone silently drops
 * it. Returns UPPER-cased codes, matching how the area tables store them.
 */
export function expandAreaCodeForLine(
  lineCode: string | null | undefined,
  areaCode: string,
): string[] {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  const code = up(areaCode);
  const extras = rules
    .filter((rule) => up(rule.keepAreaCode) === code)
    .map((rule) => up(rule.mergeAreaCode));
  return extras.length > 0 ? [code, ...extras] : [code];
}

/** `expandAreaCodeForLine` mapped over a set of codes, de-duplicated and UPPER-cased. */
export function expandAreaCodesForLine(
  lineCode: string | null | undefined,
  areaCodes: Iterable<string>,
): string[] {
  const out = new Set<string>();
  for (const code of areaCodes) {
    for (const expanded of expandAreaCodeForLine(lineCode, code)) out.add(expanded);
  }
  return [...out];
}

/**
 * Map a real area code to the code its row is folded UNDER for this line — `UE9` → `GZ6` on Pedia —
 * or to itself when nothing folds it. The counterpart of `expandAreaCodeForLine`: use it to
 * re-key a folded area's child rows (blocks, bricks) so they nest under the surviving area instead
 * of vanishing when the merged code is dropped from the option list. Returns an UPPER-cased code.
 */
export function foldAreaCodeForLine(
  lineCode: string | null | undefined,
  areaCode: string,
): string {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  const code = up(areaCode);
  const rule = rules.find((r) => up(r.mergeAreaCode) === code);
  return rule ? up(rule.keepAreaCode) : code;
}

/**
 * Fold a line's area-option list for a picker/filter into ONE entry per merged pair: the combined
 * option survives under the keep-code (`GZ6`) with the combined name, and every other member of the
 * pair (`UE9`) is folded into it. A line with no rule returns the list unchanged. Mirrors the area
 * handling in `applyClosingAreaMerges`, but for the surfaces that present a plain list of areas
 * (territory drilldown, CRM coverage, weekly planning) rather than a closing matrix.
 *
 * The merged option appears whenever EITHER code is in scope — including a list that holds only the
 * folded-away `UE9` and not `GZ6` — and is always re-keyed to the survivor `GZ6`. Never dropping an
 * in-scope area to nothing is the point: the old form filtered `UE9` out and only renamed `GZ6` if
 * it happened to be present, so a viewer scoped to `UE9` alone (no live case today — both share one
 * seat — but reachable by a future Pedia hire assigned Beni Suef alone) got an EMPTY area list and a
 * blank drilldown / coverage picker instead of the combined option.
 *
 * Folding the OPTION list is only half the job — the caller must ALSO expand the picked code back
 * to its real codes with `expandAreaCodeForLine` wherever that selection scopes a query, or the
 * folded area shows one label with only half its data. And any AREA-CHILD rows (blocks, bricks) must
 * be scoped and re-keyed with `scopeAndFoldAreaChildren`, which filters on the viewer's REAL codes so
 * the survivor's own children never leak to a viewer scoped only to the folded-away partner.
 */
export function foldAreaOptionsForLine<T extends { areaCode: string; areaName?: string | null }>(
  lineCode: string | null | undefined,
  areas: readonly T[],
): T[] {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  if (rules.length === 0) return [...areas];

  // Both the survivor and each folded-away code map to the SAME surviving keep-code, so the merged
  // option is emitted no matter which member(s) of the pair the list actually contains.
  const keepCodeByCode = new Map<string, string>();
  const mergedNameByKeepCode = new Map<string, string>();
  for (const rule of rules) {
    const keep = up(rule.keepAreaCode);
    keepCodeByCode.set(keep, keep);
    keepCodeByCode.set(up(rule.mergeAreaCode), keep);
    mergedNameByKeepCode.set(keep, rule.mergedAreaName);
  }

  const emittedKeepCodes = new Set<string>();
  const result: T[] = [];
  for (const area of areas) {
    const keepCode = keepCodeByCode.get(up(area.areaCode));
    if (!keepCode) {
      result.push(area); // not part of any merge — passes through untouched
      continue;
    }
    // Emit the combined option exactly once, keyed to the survivor and relabelled. Whichever member
    // of the pair appears first carries it; later members are folded away (their data is recovered
    // downstream via expandAreaCodeForLine / scopeAndFoldAreaChildren).
    if (emittedKeepCodes.has(keepCode)) continue;
    emittedKeepCodes.add(keepCode);
    result.push({ ...area, areaCode: keepCode, areaName: mergedNameByKeepCode.get(keepCode) ?? area.areaName });
  }
  return result;
}

/**
 * Scope a line's AREA-CHILD rows (blocks, bricks) to a viewer, then re-key each surviving row onto
 * the code its area folds under for DISPLAY. Pass the viewer's REAL area codes — the ones they are
 * actually scoped to, BEFORE `foldAreaOptionsForLine` collapses the pair — never the post-fold
 * option codes.
 *
 * Filtering on the real code is the whole point. The folded-away partner (`UE9`) re-keys to the
 * survivor (`GZ6`), and the survivor's OWN children are already `GZ6`, so filtering on the post-fold
 * code `GZ6` would admit BOTH — leaking Fayoum's (GZ6) bricks to a viewer scoped only to Beni Suef
 * (UE9). The territory skeleton has no keepExec check to catch that, so the guard lives here. A row
 * whose real area is out of scope is dropped; a surviving row keeps its original casing unless it
 * folds onto a different survivor. A line with no rule scopes the rows and passes them unchanged.
 */
export function scopeAndFoldAreaChildren<T extends { areaCode: string }>(
  lineCode: string | null | undefined,
  realAreaCodesInScope: Iterable<string>,
  rows: readonly T[],
): T[] {
  const inScope = new Set([...realAreaCodesInScope].map(up));
  return rows
    .filter((row) => inScope.has(up(row.areaCode)))
    .map((row) => {
      const folded = foldAreaCodeForLine(lineCode, row.areaCode);
      const areaCode = folded === up(row.areaCode) ? row.areaCode : folded;
      return { ...row, areaCode };
    });
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
