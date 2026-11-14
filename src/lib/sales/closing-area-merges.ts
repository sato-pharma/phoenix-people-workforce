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
//   CNS             ONE area FROM 2026-08. Owner, 2026-09-07: "in pedia and cns fayoum and bani
//                   suef are one area", then "yes merge cns from august, keep july as published".
//                   This REVERSES his 2026-08-30 ruling, which had split the CNS "Others" bucket
//                   back into two — asked and answered, so do not restore it without asking again.
//                   July 2026 CNS is published and locked (105,152 units, 2026-08-31), so the merge
//                   starts at August and July still renders as the two rows he sent out.
//
// `au.line_area_map` reflects the staffing (on Pedia both area_code rows share one seat), but the
// Closing Matrix groups by `source_of_sales_areas`, a geography table with no concept of "one
// line's organogram merges these" — GZ6 and UE9 are, and must stay, two genuinely separate SALES
// areas (different bricks, different invoice lines) on EVERY line. This module is the ONLY place
// that folds them into one row, and only on the lines and in the months the owner named.
//
// Qena 1 (UE7) + Qena 2 (UE8) are the same shape on CNS and nowhere else — owner, 2026-10-13: "in
// cns consider qena 1 and qena 2 as 1 area called qena". One CNS rep holds both (his 2026-10-12
// ruling points `cns / UE8` at `SEAT-CNS-REP-UE7`) and only Qena 1 ever carries a target, so the two
// rows graded Snagik Ayman's own September at 24% and "no target" where the one row reads
// 257,633 / 337,470 = 76%. Anti Infective and Pedia keep two Qenas: two real seats, two targets.
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
  /**
   * First period the merge applies to, inclusive, as `YYYY-MM`. Absent means every period.
   *
   * A merge is presentational, but a published month is not: folding two rows into one changes a
   * closing somebody has already been sent. So a rule added after a line has been published carries
   * the date it starts, and everything before it renders exactly as it was published.
   */
  fromPeriod?: string;
  /**
   * LAST period the merge applies to, inclusive, as `YYYY-MM`. Absent means it never ends.
   *
   * The mirror of `fromPeriod` and it exists for the same reason: a merge that STOPS rewrites a
   * published month just as surely as one that starts. Ending a rule on the month it last applied
   * leaves every closing already sent rendering exactly as it was sent.
   */
  untilPeriod?: string;
};

/**
 * The ONLY lines whose area rows are folded into one. Pedia folds Fayoum (GZ6) + Beni Suef (UE9)
 * UP TO AND INCLUDING 2026-08; CNS folds the same pair from 2026-08 onwards and Qena 1 (UE7) +
 * Qena 2 (UE8) from 2026-01 onwards; Anti Infective folds Suez (OT2) + Ismailia (OT9) into
 * "Ismailia and Suez" from 2026-09 onwards.
 *
 * 🔒 CNS HAS A SINGLE QENA — owner, 2026-10-13: "in cns consider qena 1 and qena 2 as 1 area called
 * qena", answering a choice put to him with the alternative (merging only the rep's two rows)
 * recommended. It is the LINE that merges, not the rep: 🔴 ANTI INFECTIVE AND PEDIA MUST NEVER FOLD
 * THIS PAIR — Anti Infective has two real Qena seats in every month and Pedia from 2026-09-01, each
 * carrying its own target, so folding them there would hide one rep's target behind another's row.
 *
 * 🔴 IT RUNS FROM 2026-01, AND THAT DATE IS TIED TO `MERGED_AREA_SPLIT_FOLD_START_PERIOD` — NEVER
 * WIDEN ONE WITHOUT THE OTHER. A merge outside the split-fold window DROPS the folded-away area's
 * store-split leg, because the net is re-keyed onto the rows the matrix renders only from that
 * constant. It shipped at 2026-07 for exactly that reason and the owner widened both the same day
 * (2026-10-13: "widen the CNS Qena merge to January too", overruling the recommendation to leave it
 * at July). Measured on production before the widening: CNS carries a net on BOTH Qena codes in all
 * nine months of 2026 — UE8 at January +155.30 packs, February -74.58, March -36.09, April -0.54,
 * May -102.33, June +6.46 — written by the Office read-time respread, which his "Recompute from
 * January 2026" ruling the same day already covers.
 *
 * 🔴 AND IT REACHES CNS ALONE, which is why the pair of dates could move together safely. Before
 * 2026-07 `au.monthly_store_split_net` holds CNS rows ONLY (49 areas a month, summing to exactly
 * 0.00): the Office respread is CNS-only and the city split begins in August. So Pedia's GZ6/UE9
 * fold — in force Jan-Jun — has no leg to re-key there, and Anti Infective's rule starts in
 * September. Jan-Jun carries no `monthly_closing_publications` row either, so nothing the owner has
 * ever sent out is restated; the admin closing is the only surface that reaches those months.
 *
 * 🔒 ANTI INFECTIVE'S ISMAILIA + SUEZ — owner, 2026-09-19: "Ismailia and Suez, one area ... not
 * separate areas ... in line Anti Infective, Delta (3) region", answered "one area from 1 Sept" when
 * asked. One rep covers both governorates; Ismailia is the bigger of the two by sales. It is the
 * ONLY Anti Infective rule — the GZ6 / UE9 pair stays separate on that line — and it starts at
 * 2026-09 so July and August still render Suez and Ismailia as the two Others areas they were sent as.
 *
 * 🔒 PEDIA SEPARATES FROM SEPTEMBER — owner, 2026-09-09: "fayoum separate area and banisuef
 * separate area but august closing not affected starting from september". It arrived in the same
 * breath as the Upper Egypt split, which gives Beni Suef its own rep seat in Upper Egypt 1 from the
 * same date, so the organogram and the closing now say the same thing about them.
 *
 * 🔴 CNS'S GZ6 / UE9 MERGE IS DELIBERATELY NOT ENDED. It was removed on 2026-08-30 at his
 * instruction and put back from August on 2026-09-07, and he has said "only Pedia" three times
 * about the September separation. Ending CNS's merge too would reverse a decision he has not
 * revisited — the Qena rule added below is a different pair and does not touch it.
 *
 * ADDING A LINE HERE MERGES THAT LINE'S AREA ROWS — ask the owner first, every time. Give a rule
 * added after a line has been published a `fromPeriod`, and one withdrawn after publication an
 * `untilPeriod`, or it silently rewrites months that have already been sent out.
 */
const CLOSING_AREA_MERGES: Record<string, ClosingAreaMergeRule[]> = {
  anti_infective: [
    { keepAreaCode: "OT2", mergeAreaCode: "OT9", mergedAreaName: "Ismailia and Suez", fromPeriod: "2026-09" },
  ],
  pedia: [
    { keepAreaCode: "GZ6", mergeAreaCode: "UE9", mergedAreaName: "Fayoum - Beni Suef", untilPeriod: "2026-08" },
  ],
  cns: [
    { keepAreaCode: "GZ6", mergeAreaCode: "UE9", mergedAreaName: "Fayoum - Beni Suef", fromPeriod: "2026-08" },
    // 2026-01, not absent: his ruling is about 2026's nine months, and `au.line_area_map` carries
    // `cns / UE8` on the Qena 1 rep seat from 2026-01-01. An absent `fromPeriod` would also fold
    // 2025 and earlier, which he has never been asked about.
    { keepAreaCode: "UE7", mergeAreaCode: "UE8", mergedAreaName: "Qena", fromPeriod: "2026-01" },
  ],
};

/**
 * The month a surface with no period of its own is showing: today's, in Cairo.
 *
 * A picker, an organogram or a territory tree is not "as of" anything — it is the state now — so
 * `null` means now rather than "unknown". Read live rather than captured at import time, or a
 * long-lived server process would keep answering with the month it booted in.
 *
 * The FORMATTER is built once; only the date is read live. Building an Intl.DateTimeFormat costs
 * about 0.1 ms, and the canonical sales dashboard asks this once per row through
 * getMergedAreaName (no period), so a new one per call held the server for 1.3 s in one SFE
 * Manager overview build, with every other request waiting behind it (13 Nov 2026, 12:33 Cairo).
 */
const CAIRO_MONTH_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
});

function currentClosingPeriod(): string {
  return CAIRO_MONTH_FORMAT.format(new Date()).slice(0, 7);
}

/**
 * The rules in force for this line in this period. `null`/absent period means now.
 *
 * A malformed period falls to NOT merging a dated rule — the safe direction, because failing to
 * merge shows two rows that were always real, while merging early rewrites a published month.
 */
function rulesFor(
  lineCode: string | null | undefined,
  period: string | null | undefined,
): ClosingAreaMergeRule[] {
  const rules = CLOSING_AREA_MERGES[String(lineCode ?? "").trim().toLowerCase()] ?? [];
  if (rules.length === 0) return rules;
  const asOf = String(period ?? "").trim() === "" ? currentClosingPeriod() : String(period).trim();
  return rules.filter((rule) => {
    if (!rule.fromPeriod && !rule.untilPeriod) return true;
    // A malformed period falls to NOT merging a dated rule, in EITHER direction: showing two rows
    // that were always real is recoverable, rewriting a published month is not.
    if (!/^\d{4}-\d{2}$/.test(asOf)) return false;
    if (rule.fromPeriod && asOf < rule.fromPeriod) return false;
    if (rule.untilPeriod && asOf > rule.untilPeriod) return false;
    return true;
  });
}

/** Does this line's closing merge any areas? Line code as `resolveTargetLineCode` returns. */
export function hasClosingAreaMerges(
  lineCode: string | null | undefined,
  period?: string | null,
): boolean {
  return rulesFor(lineCode, period).length > 0;
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
 * (e.g. `AchievementRow`s in the dashboard). Merged areas have their `areaCode` rewritten to the
 * `keepAreaCode`.
 *
 * ⚠ THIS DOES NOT AGGREGATE — it is a one-for-one `map`, so the result can hold TWO rows sharing
 * one `(areaCode, productCode)`. That is fine for a consumer that sums afterwards (a roll-up, a
 * total) and WRONG for one that KEYS on that identity. This docstring used to promise that "the
 * aggregation will naturally sum them together", and the Targets grid believed it: it keys its
 * React rows, its edit state and its Save payload on `${areaCode}|${productCode}`, so the Pedia
 * GZ6/UE9 fold handed it two rows with one key, one shared edit box, and a Save that overwrote
 * Fayoum's target while never writing Beni Suef's.
 *
 * A keyed surface must fold first — `foldMergedAchievementCells` in `monthly-targets.ts` restores
 * one row per (line, area, product) and recomputes achievement from the covered slice. Read its
 * warning before using it: the folded result must not then be fed back into a roll-up.
 */
export function applyAchievementAreaMerges<
  T extends { lineCode: string | null; areaCode: string | null; period?: string | null }
>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!row.lineCode || !row.areaCode) return row;
    // PER ROW, not per call: these lists routinely span several months, and CNS folds from August
    // while July stays as published. A single period for the whole list would restate one of them.
    const rules = rulesFor(row.lineCode, row.period);
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
export function getMergedAreaName(
  lineCode: string | null | undefined,
  areaCode: string,
  period?: string | null,
): string | null {
  if (!lineCode) return null;
  const rules = rulesFor(lineCode, period);
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
  period?: string | null,
): string[] {
  const rules = rulesFor(lineCode, period);
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
  period?: string | null,
): string[] {
  const out = new Set<string>();
  for (const code of areaCodes) {
    for (const expanded of expandAreaCodeForLine(lineCode, code, period)) out.add(expanded);
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
  period?: string | null,
): string {
  const rules = rulesFor(lineCode, period);
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
  period?: string | null,
): T[] {
  const rules = rulesFor(lineCode, period);
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
  period?: string | null,
): T[] {
  const inScope = new Set([...realAreaCodesInScope].map(up));
  return rows
    .filter((row) => inScope.has(up(row.areaCode)))
    .map((row) => {
      const folded = foldAreaCodeForLine(lineCode, row.areaCode, period);
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
  period: string | null,
): { areas: SalesAreaReference[]; cells: MonthlyClosingAggregateCell[]; targets: MonthlyClosingTargetCell[] } {
  const rules = rulesFor(lineCode, period);
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
  period: string | null,
): MonthlyClosingMatrix {
  const rules = rulesFor(lineCode, period);
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
>(lineCode: string | null | undefined, rows: T[], period: string | null): T[] {
  const rules = rulesFor(lineCode, period);
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
